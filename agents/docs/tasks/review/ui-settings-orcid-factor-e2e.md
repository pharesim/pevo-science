# UI-SETTINGS-ORCID-FACTOR-E2E — E2E coverage for the ORCID-factor settings critical actions

**Owner:** UI Agent
**Created:** 2026-06-09 (architect follow-up from the `ui-settings-action-fresh-auth-proof-challenge` re-review)
**Priority:** P3

## Problem

`ui-settings-action-fresh-auth-proof-challenge` wired the fresh-auth proof-challenge for the three
JWT-path critical settings actions across two factors (PASSWORD and ORCID). The E2E spec
(`frontend/tests/e2e/settings.spec.js`) drives only the PASSWORD factor (the change-email reauth-modal
test). The ORCID-factor settings path — `set_password` (passwordless target, ORCID-only) and the
passwordless fallback for `change_email` / `delete_account` — has thorough UNIT coverage
(`lib-fresh-auth-settings-orcid.test.js`, `lib-settings-fresh-auth.test.js`) but NO end-to-end coverage.

This is the clause-(c) real-path companion gap flagged in the parent task's re-review: the ORCID-factor
round-trip (`beginSettingsActionOrcidFreshAuth` → `/orcid/start?mode=fresh_auth` → ORCID →
`/orcid/callback` `_handleFreshAuth` → consent-op cache keyed `(action, username, '')` → settings action
resumes with the cached proof) is exercised only behind unit mocks. A regression in the callback dispatch
on `pevo_orcid_mode === 'fresh_auth'`, or in the cache-key shape, would ship green.

## Goal

Add an E2E spec that drives at least one ORCID-factor settings action end-to-end against the test-mode
stack: a passwordless (State-C) account performs `set_password` (or `delete_account`) via the ORCID
round-trip, and the action succeeds. Reuse the ORCID test-mode stubbing the other ORCID E2E specs use
(`orcid-link.spec.js` / `orcid-no-password.spec.js`).

## Acceptance

- A passwordless light account completes at least one settings critical action through the ORCID factor
  end-to-end in the test-mode stack (the full `/orcid/start` → `/orcid/callback` → cached-proof resume →
  action succeeds round-trip, not behind a unit mock).
- The consent-op cache key `(action, username, '')` round-trip is exercised against the real callback
  dispatch — the seam the unit tests mock out.
- Once landed, the `lib-fresh-auth-settings-orcid.test.js` clause-(c) header can cite a true real-path
  companion (described behaviorally; no task-slug in the comment).

## References

- `frontend/src/lib/settings-fresh-auth.js`, `frontend/src/lib/fresh-auth.js`
  (`beginSettingsActionOrcidFreshAuth`).
- `frontend/src/pages/orcid-callback.js` `_handleFreshAuth` — the `pevo_orcid_mode === 'fresh_auth'`
  dispatch + consent-op cache landing.
- `frontend/tests/e2e/settings.spec.js` (password-factor only today), `orcid-link.spec.js`,
  `orcid-no-password.spec.js` (ORCID test-mode patterns to reuse).
- Origin: `ui-settings-action-fresh-auth-proof-challenge` clause-(c) gap.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI implementation note (2026-06-09)

New spec `frontend/tests/e2e/settings-orcid-factor.spec.js` — 2 real tests + 1
`test.fixme`. **RAN GREEN against the test-mode stack** (full `deploy.sh restart`
→ `test-db-up` → `test-up` → playwright → `up`): `2 passed (2.5s)`, 1 skipped
(the fixme).

**What runs end-to-end (the seam the unit tests mock):**
1. **`/start` leg.** A passwordless (State-C, `password_hash NULL`) light account
   opens `/settings`, the real `GET /api/settings/email` returns
   `hasPassword:false` so the "Set a password" section renders, and submitting it
   fires `POST /api/orcid/start` with exactly `{ mode: 'fresh_auth', action:
   'set_password' }` plus a session Bearer — proving `set_password` routes through
   the ORCID factor.
2. **Callback dispatch + cache round-trip.** Driving the REAL `/orcid/callback`
   page with `pevo_orcid_mode='fresh_auth'` set, `orcid-callback.js`
   `_handleFreshAuth` caches the proof under the exact triple `(set_password,
   <username>, '')` in `pevo_fresh_auth_consent_op_proof`, navigates back to
   `/settings`, and the re-submit consumes that cached proof — `POST
   /api/settings/set-password` carries `fresh_auth_proof: <cached>`. A regression
   in the `mode==='fresh_auth'` dispatch or the cache-key shape fails here.

**Honest boundary (documented in the spec header + `test.fixme`).** The backend
`/api/orcid/callback` and `/api/settings/set-password` are network-stubbed, NOT
hit for real. The acceptance's "action succeeds with a real backend-minted proof"
is NOT achievable today: ORCID is unconfigured in the local stack (empty
`ORCID_CLIENT_ID`; no ORCID keys in `frontend/.env.test`), the real callback does
a live OAuth token exchange against `orcidBaseUrl/oauth/token`, and the E2E
harness ships **no stub ORCID OAuth provider**. Every existing ORCID E2E spec
works the same way (`orcid-link.spec.js`, `orcid-no-password.spec.js` stub the
callback and `test.fixme` their real-backend ORCID assertions). The `test.fixme`
here documents that closing the real-proof round-trip needs a stub ORCID provider
added to the harness (a separate, partly-backend/infra task — outside the UI
zone). Flagging for the architect: the clause-(c) real-path companion is now
**partial** (frontend dispatch + cache round-trip real; real backend proof
fixme'd) — decide whether that satisfies the parent task's clause-(c) reference or
whether the stub-provider infra task should be filed/owned.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` ran on commit `c5cda7d6` (6 personas: correctness + security on Opus;
testing/maintainability/project-standards/learnings on Sonnet; ce-agent-native skipped per
PEvO). The spec is well-built and HONEST about what it stubs: it drives the real
`orcid-callback.js` `_handleFreshAuth` dispatch and the real settings page, and the cache-key
assertion pins the exact `(set_password, <username>, '')` triple plus the proof riding into the
set-password body — the seam the unit tests mock. The clause-(a) mock justification is accurate
and complete; `sessionStorage` scoping, the retry-suffix seed, and the `waitForRequest` /
`waitForURL` ordering are correct; secret hygiene (trace/video/screenshot off so minted JWTs stay
out of artifacts) is correct. Three fixes must land before archive. Anchor any new comments on
stable symbols, not line numbers or task slugs.

**1. (P2) `seedStateCAccount` seeds an unenumerated account state, not State C.** The INSERT omits
the `orcid` column, so the seeded row is `(verify_token NULL, username SET, password_hash NULL,
orcid NULL, custody 'light', upgraded_at NULL)` — which matches NO state in ARCHITECTURE.md §6.1.
State C requires `orcid SET`; an account with both `password_hash NULL` and `orcid NULL` has no
registered re-auth factor (§6.5 invariants #2/#5). It is INERT for the two committed tests (the
real `GET /api/settings/email` derives `hasPassword` from `password_hash` only and never reads
`orcid`, and the set-password backend is network-stubbed), but it mislabels the fixture and would
BREAK the `test.fixme` real-backend companion: the real `POST /api/settings/set-password` rejects
an `orcid IS NULL` row with `403 ORCID_REQUIRED` BEFORE the proof gate, so reusing this seed when
un-fixme'ing would 403 on eligibility and never exercise the proof verification the fixme exists
for. Fix: add `orcid` to the INSERT column list + VALUES (a synthetic ORCID iD bind param) and to
the `ON CONFLICT DO UPDATE SET`, making the fixture a genuine State C. (Verified against the live
backend: `accounts.orcid` is nullable with no default; `hasPassword` reads `password_hash` only;
the `ORCID_REQUIRED` gate fires before the proof is consumed.)

**2. (P2) Comment-anchor rot: task slug in the file header.** The header sentence "The
settings-action fresh-auth flow (`ui-settings-action-fresh-auth-proof-challenge`) wired two
factors" embeds a task slug as a load-bearing anchor; it becomes a dead pointer once that task
archives (the "Comment anchors" convention — the same rule the sibling IPFS task was held over).
Drop the slug; anchor on the stable behavior (the `withSettingsFreshAuth` flow in
`settings-fresh-auth.js` wires the PASSWORD and ORCID factors). Sibling spec FILE names elsewhere
in the header are stable symbols and stay.

**3. (P3) Comment-anchor rot: "the parent task pins" redirect.** The `STUB_EXPIRES_AT` comment
"(the parent task pins the ISO-string shape, not an epoch int)" is a task-file redirect that rots
on archive. Anchor on the production symbols instead: `cacheConsentOpProof` stores `expiresAt` as
an ISO-8601 string and `getCachedConsentOpProof` parses it with `new Date()` for the TTL check.

**Clause-(c) disposition — architect-resolved, do NOT change in this spec.** The spec satisfies
clause (c) for the FRONTEND seam (real dispatch + cache round-trip — the regression the parent
feared would ship green). The real-backend ORCID proof round-trip is legitimately blocked on
harness infra (no stub ORCID OAuth provider) and correctly captured in the `test.fixme`. To
convert that in-file deferral into a tracked follow-up (the convention wants a filed task, not
just a comment), I filed `architect-e2e-stub-orcid-oauth-provider` in `tasks/pending/`; it also
unblocks the identical fixmes in `orcid-link.spec.js` and `orcid-no-password.spec.js`. Once fixes
1–3 land, this task archives; the real-backend round-trip lives on the filed infra task.

**Reviewed and dismissed (no action):** §6.5 invariant #1 not exercised at E2E (the set-password
stub returns 200 regardless, so no negative case proves the proof is required) — honest within the
documented frontend-dispatch focus and deferred to the filed infra task; `seedSession` duplicating
`seedUnaccreditedSession` from `fixtures/auth.js` (P3 DRY, single reviewer; sibling
`non-consent-fresh-auth.spec.js` carries the same local copy) — fix opportunistically only.
Informational (not blocking): the stub does not pin the backend's wire shape (verify a backend
integration test pins `/api/orcid/callback`'s ISO `expires_at` shape — separate from this spec);
the test-2 callback-stub `page.goto` is not wrapped in `Promise.all([waitForRequest, goto])` (only
a flake suspect; it ran green).

When fixes 1–3 land, `git mv` this file back to `tasks/review/` for re-review scoped to the new
commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09)

All three held fixes landed in the same commit that moves this file back to `tasks/review/`.

1. **(P2) State-C seed corrected.** `seedStateCAccount` now sets `orcid`: added to the INSERT
   column list + VALUES (bind param) and to `ON CONFLICT (email) DO UPDATE SET orcid =
   EXCLUDED.orcid`. The seeded row is now a genuine State C (`password_hash NULL`, `orcid SET`,
   `custody 'light'`, `verify_token NULL`) per ARCHITECTURE.md §6.1, so the `test.fixme`
   real-backend companion will not 403 `ORCID_REQUIRED` before the proof gate when un-fixme'd. The
   synthetic 16-digit ORCID iD is derived per-run from `(Date.now, retry)` in `beforeAll`, matching
   the existing email/username scheme, so it stays unique against `accounts.orcid`'s partial UNIQUE
   index across runs/retries.

2. **(P2) Header slug anchor dropped.** The file-header sentence now anchors on the
   `withSettingsFreshAuth` wrapper in `settings-fresh-auth.js` instead of the parent task slug.

3. **(P3) `STUB_EXPIRES_AT` comment re-anchored.** It now cites the production symbols
   (`cacheConsentOpProof` stores `expiresAt` as an ISO-8601 string; `getCachedConsentOpProof`
   parses it with `new Date()` for the TTL check) instead of the "parent task pins" redirect.

Verified: full test-mode dance (`deploy.sh restart` → `test-db-up` → `test-up` → playwright →
`up`) — `2 passed, 1 skipped` (the documented stub-provider fixme), same green as the pre-hold
run, confirming the State-C seed change did not regress the two real tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
