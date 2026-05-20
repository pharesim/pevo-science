# UI-BRIDGE-REGISTER-LOCK-HELD-UX — SPA affordance for the new 409 LOCK_HELD error code on /api/bridge/register

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive"; gating dependency LOCK_HELD rename landed in round-2 commit `8f81492`)
**Priority:** P2

## Problem

`backend-bridge-write-haf-lag-and-retry-amplification` round-2 split the `/api/bridge/register` 409 conflict response into two distinct error codes (per architect hold item 1):

- `LOCK_HELD` — concurrent `/register` attempt in flight on the same deterministic permlink. The first request holds a Redis SETNX lock; the second gets 409 with `{retriable: true}`. Self-clears in ≤35s when the first lock TTL expires.
- `DUPLICATE` — a paper with that permlink already exists on chain (broadcast landed previously). Non-retriable. Response carries `existing_author` and `existing_permlink`.

The SPA's `/register` flow today branches on `err.code === 'DUPLICATE'` (or message text — verify the current branch shape). It does not distinguish `LOCK_HELD` from `DUPLICATE`. Effect: a user who hits a transient lock conflict sees the "already registered" message (with the `existing_author`/`existing_permlink` fields missing on the lock-held branch — which the SPA may render as "undefined" or fall back to a generic error). The lock conflict is retriable; the user should see a "retry in a moment" affordance, not a permanent failure message.

## Goal

Update the SPA's `/register` (bridge registration) flow to branch on the new error code split:

- `code === 'LOCK_HELD'` → user-facing message "Registration is in progress; please retry in a moment" + automatic or button-driven retry after a short delay (1-3s). Surface the `details.retriable: true` discriminator if available.
- `code === 'DUPLICATE'` → existing behavior, surface `existing_author` and `existing_permlink`. No retry affordance.
- Other 4xx/5xx → existing error envelope handling.

## Acceptance

1. **Locate the SPA bridge-register call site.** Likely in `frontend/src/pages/` (publish/bridge flow) or a sibling component. Inspect which file consumes the `/api/bridge/register` response and where the current error branching happens.
2. **Branch on `err.code`** for the two 409 cases. Match the established pattern used elsewhere in the SPA (e.g., the HAF-outage 503 retry-card affordance from `ui-haf-outage-503-retry-affordance`).
3. **Retry UX for LOCK_HELD.** Match the SPA's existing retry-affordance convention. Architect discretion: auto-retry with a small backoff (1-3s, capped at 2-3 attempts) vs. manual retry button — pick what matches the surrounding UX.
4. **i18n.** New error-message key for the LOCK_HELD case. Stub the other locales per the `frontend/public/messages/STUBS.md` convention.
5. **Test.** A component-tier test pinning the LOCK_HELD branch routes to the retry affordance (not the existing-duplicate template).

## Out of scope

- Changing the backend contract. The contract is shipped and documented in `agents/docs/api-contracts/bridge.md` + `common.md`.
- Adding new error codes. Only the existing LOCK_HELD / DUPLICATE split is being surfaced to UX.

## Cross-references

- `agents/docs/api-contracts/bridge.md` — contract for the two 409 codes.
- `agents/docs/api-contracts/common.md` — standard `details.retriable` convention.
- `backend/src/routes/bridge.ts` — backend emit sites (LOCK_HELD at line ~420, DUPLICATE at line ~426 area).
- `ui-haf-outage-503-retry-affordance` (archived 2026-05-20) — analogous SPA retry-card pattern.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11) — original architect-zone followup prescription.

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` fan-out (8 reviewers, full persona set minus `ce-agent-native-reviewer` per PEvO policy) on the round-1 implementation surfaced 2 items that block archive. The auto-retry behavior and the DUPLICATE existing-paper link are otherwise sound; the rate-limit slot-burn risk surfaced by the review is being filed as a separate backend task rather than held here.

### Item 1 — state-reset hygiene in handleRegister / handleLookup / generic Try-again

After a DUPLICATE failure on identifier A, the user types identifier B and clicks Lookup; once the new lookup resolves and the form re-renders, the stale `duplicateExisting` card points to A's existing paper. The window between lookup-success and the next Register click shows a wrong-paper link to the user. Root cause: `handleLookup` does not clear `duplicateExisting`, `step`, or `errorMessage` at entry. Companion defensive gaps: `handleRegister` does not reset `errorMessage` at entry (visually masked today by the template's step-based gating, but defensively unclean); the generic "Try again" button resets `step` to `'idle'` without clearing `duplicateExisting`.

Fix: clear `duplicateExisting`, `step` (where appropriate), and `errorMessage` at the entry of `handleLookup`, at the top of `handleRegister`, and on the Try-again click handler. Match the existing reset pattern already used at `handleRegister`'s `duplicateExisting = null` line.

### Item 2 — test coverage gaps for two edge cases

Two coverage gaps in `frontend/tests/unit/pages-bridge.test.js`:

(a) **Component destroy during the LOCK_HELD backoff sleep** — the `await new Promise(resolve => setTimeout(resolve, delay))` site has no test pinning the "no further `registerBridgePaper` calls fire after destroy AND no state mutates after destroy" invariant. The post-await `_mounted` check is the load-bearing guard; a regression that moved or removed it would not turn anything red. This gap is also load-bearing for the forthcoming frontend retry/timer-guard sweep (separate pending task) — having the regression pin in place catches a subtle migration bug if the backoff primitive changes.

(b) **DUPLICATE with partial `err.details`** — one of `existing_author` / `existing_permlink` present, the other missing. The code's `if (author && permlink)` gate correctly falls through to the generic message, but that fall-through path is untested.

Fix: add two vitest cases. The destroy-during-backoff case can mock `registerBridgePaper` to return a LOCK_HELD error, advance fake timers partway into the backoff window, call `destroy()`/`_teardownTimers()`, then advance the remaining time and assert no further `registerBridgePaper` invocation and no state mutation. The partial-details case mocks DUPLICATE with one field set, asserts the generic-error template renders (not the duplicate-link block).

---

## UI re-review signal (2026-05-20, commit 3062f827)

Round-2 fixes landed in commit `3062f827`. Both architect hold items addressed:

- **Item 1 (state-reset hygiene).** `handleLookup` now clears `duplicateExisting`, `step`, and `errorMessage` at entry; `handleRegister` clears `errorMessage` defensively; the inline `step = 'idle'` template handler is replaced with a `resetRegisterError()` method that clears `step` + `errorMessage` + `duplicateExisting` together. The new method is used by the generic Try-again button so the three-field reset happens atomically.
- **Item 2 (test coverage gaps).** Two vitest cases added to `frontend/tests/unit/pages-bridge.test.js`: (a) destroy-during-LOCK_HELD-backoff pins the post-await `_mounted` guard; (b) DUPLICATE with partial `err.details` (`existing_author` set, `existing_permlink` missing) asserts the generic-error template renders instead of the duplicate-link block.

Test result: 43/43 pass in `pages-bridge.test.js` (was 41/41 before).

Playwright not run by the parent — the bridge-register flow has no E2E spec gated on this surface; component-tier vitest coverage is the load-bearing regression layer. The full E2E suite requires the test-up/test-down docker dance (see `agents/ui/CLAUDE.md` § "E2E (Playwright)") and is left to architect/operator discretion.

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` fan-out (8 reviewers, full persona set minus `ce-agent-native-reviewer` per PEvO policy) on the round-2 implementation surfaced 1 item that blocks archive. Both round-1 hold items landed correctly — `handleLookup` / `handleRegister` / `resetRegisterError()` state-reset hygiene is sound at the three call sites, and the two new vitest pins (destroy-during-LOCK_HELD-backoff + DUPLICATE with partial err.details) correctly assert the post-await `_mounted` guard and the partial-details fall-through. The item below is a behavior-test gap on the user-visible bug that motivated round-1 hold item 1 itself.

A separate sibling task (`ui-bridge-register-mid-broadcast-lookup-gate`) is being filed under `tasks/pending/` for a pre-existing race that round-2 worsened (handleLookup mid-broadcast unmasks `step === 'registering'` and lets the user land on a different paper than they expected). That's a separate concern from the test-gap below and is not held here.

### Item 1 — handleLookup post-DUPLICATE state-reset has no behavior test

The bug round-1 hold item 1 was filed to fix — stale `duplicateExisting` from a prior DUPLICATE leaking into the next identifier's lookup result — has zero direct regression test. The two round-2 tests cover the prescribed pins for round-1 hold item 2 (destroy-during-backoff + partial-details fall-through); they do not cover the `handleLookup` three-field reset at the user-visible failure path. A regression that re-inlined the Try-again handler back to `step = 'idle'` without including the `duplicateExisting` clear, or that trimmed the `handleLookup` entry reset from three fields to two, would land silently — the existing suite would still pass green. The bug Item 1 fixes is currently regression-protected only by manual diff inspection.

Fix: add one vitest case driving the canonical bug scenario end-to-end. Seed `comp.duplicateExisting = { author: 'A', permlink: 'X' }` and `comp.step = 'error'` (the partial-details DUPLICATE test added in round-2 gives a working setup pattern for landing in this state); change `comp.identifier` to a different value; call `comp.handleLookup()` and await; assert `comp.duplicateExisting === null` AND `comp.step === 'idle'` AND `comp.errorMessage === ''`. The full three-field reset is the load-bearing claim; an assertion missing one field would mask a partial-reset regression. Approximately 15-20 lines.

---

## UI re-review signal (2026-05-20, working tree)

Round-3 hold item 1 landed. New vitest case `clears duplicateExisting, step, and errorMessage when looking up a new identifier after a prior DUPLICATE error` added at the end of the `handleLookup` describe block in `frontend/tests/unit/pages-bridge.test.js`. Seeds the post-DUPLICATE state (`duplicateExisting = {author, permlink}`, `step = 'error'`, `errorMessage = 'Already registered'`), sets a different identifier, mocks the lookup + check resolves, awaits `handleLookup()`, and asserts all three fields cleared. A regression that trimmed the entry reset to two of three fields or re-inlined the Try-again handler without the `duplicateExisting` clear would now turn this red.

Test result: 44/44 pass in `pages-bridge.test.js` (was 43/43 before).
