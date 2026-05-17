---
title: "Storage scope: `sessionStorage` (per-tab) for in-progress SPA flow state, not `localStorage` (per-origin)"
date: 2026-05-17
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
applies_when:
  - "Choosing browser storage for SPA state that represents an in-progress flow scoped to one browsing context (OAuth callback dispatch, OAuth return-path stash, multi-step wizard checkpoints, mid-broadcast claim handles, etc.)"
  - "Reviewing existing `localStorage.setItem('pevo_...')` calls for cross-tab corruption risk when two tabs can run the same flow concurrently"
  - "Migrating one of a pair of cohering keys read together in the same callback dispatch — both belong on the same storage scope"
  - "Adding a new write site for an existing flow-state key — the new site must use the same scope as the existing readers"
tags:
  - browser-storage
  - sessionstorage
  - localstorage
  - cross-tab
  - oauth-callback
  - orcid-flow
  - storage-scope
  - spa-state
related_components:
  - authentication
---

## Context

PEvO's SPA stashes flow state in browser storage so that an OAuth redirect can return the user to the right place. Early code used `localStorage` reflexively — it's the more familiar API and survives reload, which feels safer. But `localStorage` is shared across all tabs of the same origin. Two tabs running the same flow concurrently silently corrupt each other's state. The bug is invisible: nothing throws, no assertion fires, the user just lands on the wrong page after the OAuth round-trip.

This pattern surfaced twice on consecutive task cycles:

- Round-2 of `ui-non-consent-broadcast-fresh-auth-wiring` (archived 2026-05-17) migrated `pevo_orcid_mode` from `localStorage` to `sessionStorage` to close the cross-tab-different-modes attack: tab A in `link` mode silently overwritten by tab B in `session_auth` mode → tab A's callback dispatches to the wrong handler.
- `ui-pevo-orcid-return-to-session-storage-migration` (archived 2026-05-17) migrated the sibling key `pevo_orcid_return_to` for the identical class on the return-path stash: tab A writes `/recover-step-2`, tab B overwrites with `/recover-step-3`, tab A's ORCID callback reads the wrong return path.

Both keys are read together in the same `orcid-callback.js` dispatch — they form a **cohering pair**. The round-2 partial migration left a comment that overstated scope (claimed "all `pevo_orcid_mode` writers migrated together"); the very next line wrote `pevo_orcid_return_to` to `localStorage`, misleading future readers.

## Guidance

**Choose `sessionStorage` (per-tab/browsing-context) for keys that represent "this tab's in-progress flow."**

Concretely, a key belongs in `sessionStorage` when ALL of these hold:

1. The state has no meaning outside the current browsing context — duplicating it to another tab makes the second tab interpret stale data as its own.
2. The lifetime is bounded by a single flow that completes within the tab session (OAuth round-trip, multi-step wizard, broadcast attempt). The user doesn't expect it to survive closing the tab.
3. Concurrent runs of the same flow in different tabs are realistic in normal use. (For ORCID flows specifically, the user might open a "recover" tab and a "settings/link" tab side-by-side.)

**Choose `localStorage` (per-origin) for state that must outlive a single browsing context.** Examples: the auth JWT (`pevo_session`), user preferences. The cross-tab sharing IS the feature there — opening a second tab should find the user logged in.

**Atomic migration without a dual-write transition is safe when:**

- The new bundle has zero read paths for the localStorage version (grep audit confirms no `localStorage.getItem('<key>')` remains anywhere in `frontend/src/`).
- Stale localStorage values from pre-deploy bundles have no side effects (they sit unread until quota eviction).

A user mid-flow at deploy time with the old bundle in one tab and the new bundle in another lands on the SPA's default destination (`/signup` instead of `/recover`, for example) on the next callback. Self-heals on retry. No data loss. Documented as acceptable in the migration task's "Out of scope" section.

**Cohering-pair principle:** When two or more keys are read together in the same callback dispatch (e.g., `pevo_orcid_mode` + `pevo_orcid_return_to`), migrate them together in the same task. A partial migration:

- Leaves a comment that overstates the union scope and confuses future readers.
- Risks one key behaving as per-tab and the other as per-origin, so cross-tab interference re-emerges through the unmigrated sibling.
- Creates a second task with overhead that a single combined migration would avoid.

**Cleanup parity:** Keys with destroy-time clearing (e.g., `auth.disconnect()` at `auth.js:155` removes `pevo_orcid_mode` from sessionStorage on logout) should have all sibling keys following the same pattern, or the asymmetry becomes a residual stale-key path. PEvO surfaced this gap as `julik RR-2` during the `pevo_orcid_return_to` review: the key is not cleared in `orcid-callback.js destroy()`, so abandoning mid-callback leaks the return-path into the next ORCID flow in the same tab. Filed as `tasks/pending/ui-orcid-callback-destroy-clear-return-to.md`. The convention: when you migrate a key into sessionStorage AND its sibling has destroy-time cleanup, add the matching cleanup at the same time.

**Audit the writers AND readers via grep** before declaring a migration done:

```bash
# Verify zero localStorage usages remain after migration
grep -rn "'<key-name>'" frontend/src/ | grep -E "localStorage"
# Verify all reads use sessionStorage
grep -rn "'<key-name>'" frontend/src/
```

## Why This Matters

The cross-tab corruption failure mode is silent and per-user-action. There's no exception, no metric blip, no log line. The user clicks "verify with ORCID," does the OAuth round-trip in good faith, and lands on someone else's page in the same browser session. They typically retry by hand, which works, but they have no model of why. Engineers also have no model — there's nothing to grep for in logs. Debugging requires reproducing the two-tab scenario, which is uncomfortable enough that this class of bug ships unnoticed.

The fix is mechanically trivial (`localStorage` → `sessionStorage`). The reason it took two task cycles in PEvO is that the round-2 migration only saw one of the two cohering keys at review time. The cohering-pair principle exists to compress that into one cycle.

## When to Apply

- **Adding a new key for an OAuth/SPA flow:** default to sessionStorage; justify localStorage in a code comment if you need per-origin scope.
- **Reviewing existing `localStorage.setItem('pevo_...')` calls:** ask "does this state have meaning across tabs, or only inside this flow?" If the latter, the key belongs in sessionStorage.
- **Migrating a key:** grep for ALL writers AND readers; check whether a sibling key reads in the same dispatch and migrate them together.
- **Adding destroy-time cleanup:** if the sibling key has it, the new key should too.

## Examples

### Cross-tab corruption (the failure this convention prevents)

Two tabs, both ORCID-linking:

```
Tab A (in 'link' mode for adding ORCID to existing PEvO account):
  localStorage.setItem('pevo_orcid_mode', 'link');
  // redirect to orcid.org/oauth/authorize

Tab B (in 'session_auth' mode minting a non-consent broadcast proof):
  localStorage.setItem('pevo_orcid_mode', 'session_auth');
  // (silently overwrites tab A's value)
  // redirect to orcid.org/oauth/authorize

Tab A returns from ORCID:
  const mode = localStorage.getItem('pevo_orcid_mode'); // 'session_auth' — WRONG
  // callback dispatch routes to the session_auth handler, not the link handler
```

### The migration (atomic, no dual-write)

```js
// Before — recover.js
localStorage.setItem('pevo_orcid_return_to', 'recover');
// orcid-callback.js
const returnTo = localStorage.getItem('pevo_orcid_return_to');
localStorage.removeItem('pevo_orcid_return_to');

// After — recover.js
sessionStorage.setItem('pevo_orcid_return_to', 'recover');
// orcid-callback.js
const returnTo = sessionStorage.getItem('pevo_orcid_return_to');
sessionStorage.removeItem('pevo_orcid_return_to');
```

The localStorage values from pre-deploy bundles are inert — no read path remains in `frontend/src/`. They expire under the browser's eviction policy.

### Cohering-pair migration done right

`pevo_orcid_mode` and `pevo_orcid_return_to` are both read in `orcid-callback.js init()`. Migrate them in the same task; don't leave one on localStorage while the other is on sessionStorage. The fix shape:

1. Grep for ALL writers of both keys (`recover.js`, `signup.js`, `login.js`, `settings.js`, `accreditation.js`, `fresh-auth.js`, etc.).
2. Switch every writer + every reader atomically in one commit.
3. Update the migration comment to cover both keys as a union, not one-and-mention-the-other.
4. Add destroy-time cleanup for the sibling key if the established key has it.

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-PEVO-ORCID-RETURN-TO-SESSION-STORAGE-MIGRATION (archived 2026-05-17)` and `UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING (archived 2026-05-17)` for the two parent migrations.
- `agents/docs/tasks/pending/ui-orcid-callback-destroy-clear-return-to.md` — the cleanup-parity follow-up surfaced during review.
- `frontend/src/auth.js:155` — the established destroy-time cleanup pattern for `pevo_orcid_mode` that sibling keys should mirror.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the audit-by-grep convention this migration shape applies.
