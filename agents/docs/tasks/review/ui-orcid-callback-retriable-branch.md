# UI-ORCID-CALLBACK-RETRIABLE-BRANCH — Consume `err.details.retriable` + `err.retryAfterSeconds` in the orcid-callback error path

**Owner:** ui
**Created:** 2026-04-22 (surfaced by UI-ORCID-RETRIABLE-DISCRIMINATOR-PLUMBING first-review)
**Priority:** P2

## Context

`UI-ORCID-RETRIABLE-DISCRIMINATOR-PLUMBING` (commit `dfb224b`) plumbed `err.details` (from `errorBody.error.details`) and `err.retryAfterSeconds` (from `Retry-After` header) through `ApiRequestError` in `frontend/src/api.js`. The infrastructure is in place; no consumer currently uses it.

`frontend/src/pages/orcid-callback.js` `_verify` catch block (lines ~106-127) branches on `err.code === 'NO_ACCOUNT'` and `err.code === 'VALIDATION_ERROR'`, then falls through to a generic "verification failed" for everything else — including `ORCID_ALREADY_LINKED` 409, which is the primary case the retriable discriminator was designed for.

A lock-contention 409 (`retriable: true`, `Retry-After: 10`) currently reaches the generic branch and displays `orcid.verificationFailed` with a "try again" link. A durable-binding 409 reaches the same branch with the same message. User cannot distinguish "wait 10s and retry" from "this ORCID is permanently bound to another account".

Agent-native Finding 1 (0.95); api-contract AC-5 (0.85). See `.context/compound-engineering/ce-code-review/aggregated/15-ui-orcid-retriable-discriminator-plumbing.md` § F15.3.

## Coordination

- Pairs with `backend-orcid-broadcast-timeout-outcome-handling.md`. Once that task lands an Option A.2 `BROADCAST_TIMEOUT` 504 envelope with `retriable: false + outcome: 'uncertain'`, this task's retriable branch also needs to surface that case.
- Also pairs with `BE-ORCID-BROADCAST-ABORT-TIMEOUT` hold block item F4.3 (BroadcastTimeoutError discrimination at call sites) — once backend emits 504 BROADCAST_TIMEOUT with `retriable`, frontend consumes it here.

## Goal

Extend `_verify`'s catch block to branch on the retriable discriminator:

1. **`err.code === 'ORCID_ALREADY_LINKED' && err.details?.retriable === true`** → show "another request is in progress, please wait {retryAfterSeconds}s and try again". If `retryAfterSeconds` is set, auto-retry after that delay (with a user-visible countdown) OR show a "retry" button that reuses the state token if it hasn't been consumed.

2. **`err.code === 'ORCID_ALREADY_LINKED'` (no retriable flag)** → show "this ORCID is linked to another account" with a path to `/recover` or contact support.

3. **`err.code === 'BROADCAST_TIMEOUT'` (once backend emits it)** → show "broadcast is pending; verify your ORCID linkage at /settings before retrying".

## Non-goals

- Adding actual auto-retry with backoff. Scope is rendering + user-initiated retry.
- Generalizing the discriminator across other pages. Other handlers (`_handleAccredit`, `_handleLink`) may warrant similar treatment; file as follow-up.

## Acceptance

- `_verify` catch block branches on `err.details?.retriable` as described.
- i18n keys added for each new message state (`orcid.alreadyLinkedRetriable`, `orcid.alreadyLinkedDurable`, `orcid.broadcastPending`); 14-locale stubs + STUBS.md entries under a fresh sweep header.
- Unit tests in `frontend/tests/unit/pages-orcid-callback.test.js` covering each branch: retriable 409 with Retry-After → retriable message + countdown; durable 409 → durable message; BROADCAST_TIMEOUT → pending message.
- No regression on NO_ACCOUNT / VALIDATION_ERROR branches.

## [TODO Architect]

None — consumes existing backend contract.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `cbf53f1` (merge d184eca) (correctness persona). Retriable-branch consumption + countdown + retry scaffolding all correctly shaped; i18n keys present; durable vs retriable 409 correctly distinguished. Four hold items on retry-loop boundaries + semantics.

1. **P2 — `err.retryAfterSeconds !== null` discriminator misclassifies `undefined` as retriable** (correctness F14.1 0.82). `frontend/src/pages/orcid-callback.js:~139`. Today `completeOrcid` only throws `ApiRequestError`, which normalizes absent values to `null` via api.js — so the misclassification is theoretical. Diverges from stated semantics (retriable iff backend explicitly signals retriability). Fix: `err.retryAfterSeconds != null` (loose equality) or explicit `typeof err.retryAfterSeconds === 'number'`.

2. **P2 — `Retry-After: 0` collapses UX: `retryCountdown = 0` → synchronous immediate retry** (correctness F14.2 0.88). `parseRetryAfterSeconds(0) === 0` is valid (non-null). `const seconds = err.retryAfterSeconds ?? 10` evaluates to `0` (nullish coalesce doesn't fire on `0`). `_tickRetryCountdown()` finds `retryCountdown <= 0`, calls `_retryVerify()` synchronously. User sees no countdown, no error flash, immediate retry. If retry also returns 0, infinite synchronous loop risk. Fix: `const seconds = Math.max(1, err.retryAfterSeconds ?? 10)` or explicit `> 0` clamp.

3. **P2 — No retry counter enforcement; comment claims "single self-triggered retry" but code allows unbounded** (correctness F14.3 0.90). `frontend/src/pages/orcid-callback.js:~221-244`. Persistent retriable 409 (attacker holds lock / cache-HAF lag exceeds 10s / repeated backend contention) arms a new countdown on every retry-fail. Stuck-on-page user creates unbounded retry loop burning backend state tokens. Safe across navigation (destroy cancels timer) but poor UX + backend resource burn. Fix: add `_retryCount` field; `MAX_RETRIES = 1` to match the comment; on `_retryCount >= MAX_RETRIES` show the durable-binding message instead of arming a new countdown. Reset on successful verify or navigation.

4. **P3 — No test for countdown-reaches-zero → `_retryVerify` path** (correctness F14.5 info-tier 0.95). Existing teardown test advances timers to `countdown=7` then destroys. Retry-firing path is the main value-add of the branch; no test asserts `completeOrcid` gets called twice, `status` flips through `'verifying'` during retry. Fix: add a test that advances past `retryAfterSeconds=10`, asserts `completeOrcid` mock was called twice AND `status` cycled through `'verifying'`. Couples naturally with the retry-counter cap from #3 (single test can assert cap behavior + countdown firing).

**Dismissed from round-1 findings (architect triage):**
- **P3 F14.4** `errorAction` whitelist drops unknown future values (0.85): intentional default-deny shape. Future branch additions caught in code review + visible (no button rendered). Dismissed.

**Path to re-archive:** (1) UI applies items #1-4 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.

---

**UI re-review signal (2026-04-22, pending-merge):** items #1-4 landed; see diff.

- F14.1: retriable discriminator now uses loose `!= null` in `_verify` catch.
- F14.2: countdown clamped to `Math.max(1, err.retryAfterSeconds ?? 10)`.
- F14.3: `_retryCount` + module-level `MAX_RETRIES = 1`; durable message on cap; reset on successful verify and destroy.
- F14.5: unit tests cover countdown firing the retry, MAX_RETRIES cap, `Retry-After: 0` clamp, and the `undefined` retryAfterSeconds defensive path. 41 tests pass.

---

## Architect re-review (2026-04-29, round-2) — HELD PENDING FIXES

Round-2 `/ce-code-review` on commit `fbe8578` (9 personas + adversarial; kieran-typescript skipped — JS not TS; api-contract skipped — frontend consumes API not defines). All 4 round-1 hold items (F14.1, F14.2, F14.3, F14.5) verified clean. **No P0. No exploitable security findings.** One latent contract issue routed to a new architect task (does NOT block this archive); five minor cleanup items held for round-3.

### Items held pending fixes (UI-owned)

1. **P2 — No upper bound on `Retry-After` clamp.** 2-reviewer convergence (reliability REL-001 conf 90, adversarial adv-2 conf 70 → promoted conf 100). `frontend/src/pages/orcid-callback.js:179` reads `Math.max(1, err.retryAfterSeconds ?? 10)`. Lower bound is correctly clamped to 1; **no upper bound**. A misconfigured backend or proxy emitting `Retry-After: 99999` pins the user on the page for ~28 hours with the retry button disabled the entire time. The MAX_RETRIES=1 cap fires after one auto-retry, but the FIRST 409's countdown is unbounded — the cap doesn't help here. Defense-in-depth one-liner:
   ```ts
   const seconds = Math.max(1, Math.min(300, err.retryAfterSeconds ?? 10));
   ```
   `300` (5 minutes) is conservative; 60 is fine if you want stricter UX. If the backend ever legitimately emits `Retry-After > 300`, that's a backend bug worth surfacing rather than respecting silently. Add a unit test asserting `retryCountdown <= 300` for `retryAfterSeconds = 99999`.

2. **P3 — Stale comment on `_retryCount` field declaration.** Maintainability MAINT-001 conf 90. `frontend/src/pages/orcid-callback.js:85`. The inline comment says the value is "hard-coded to 1 so reviewers see the bound without chasing a const elsewhere" — but `MAX_RETRIES = 1` IS a named module-level const at the top of the file. Pre-const-draft fragment that contradicts the code. Drop the clause; the rest of the comment (counter semantics + reset sites) is accurate.

3. **P3 — "Single self-triggered retry" prose at two sites is fragile to MAX_RETRIES change.** Maintainability MAINT-002 conf 75. `orcid-callback.js:182` and `:256` both say "a single self-triggered retry". Accurate only because MAX_RETRIES happens to equal 1 today. If the constant is ever raised, both comments silently lie. Reword to "up to MAX_RETRIES self-triggered retries" in both places.

4. **P3 — Redundant `comp._mounted = true` assignment in countdown-fires-retry test.** Testing T-01 conf 90. `frontend/tests/unit/pages-orcid-callback.test.js:624`. The comment says "timer-guard is initialised on createTimerGuard" — accurate; `createTimerGuard()` already sets `_mounted: true`. The explicit assignment is a no-op and creates the false impression that this test requires special bootstrapping the other three new timer-based tests don't. Delete the line.

5. **P3 — `undefined` retryAfterSeconds test doesn't pin `_retryCount` invariant.** Testing T-04 conf 70. `frontend/tests/unit/pages-orcid-callback.test.js:321`. Test asserts the durable branch fires (correct) but doesn't assert `expect(comp._retryCount).toBe(0)`. A mutation that incorrectly increments `_retryCount` in the durable/non-retriable branch wouldn't be caught. One-line addition.

### Findings routed to a new architect task (NOT held against this task)

- **F1 (P1 latent contract issue, adversarial conf 85):** the same-tick lock-contention `retriable: true` 409 contract is **unreachable by design** because backend consumes the OAuth state token at `orcid.ts:299` BEFORE dispatching to `handleAccredit`/`handleLink`, and the lock-contention 409 fires LATER inside `withOrcidBindingLock`. Frontend's `_retryVerify` replays `{code, state}` → backend's state-check at `orcid.ts:282` returns 400 BAD_REQUEST first → frontend falls through to `orcid.verificationFailed` (generic). MAX_RETRIES=1 just bounds how many times the wrong outcome repeats. **Pre-existing** — the broken contract dates to whenever the lock-contention 409 first signaled `retriable: true`; this task ships an elaborate consumer over it. Filed as `agents/docs/tasks/pending/architect-orcid-state-consumption-vs-retriable-409.md` for architect product decision (Option A: defer state consumption; Option B: drop `retriable:true` from this specific 409; Option C: frontend treats `retriable:true` as informational). Architect's leaning recorded in that file: Option B (drop the discriminator, honest to actual contract). Resolution decided there, not here.

### Pre-existing in `frontend/src/auth.js` (NOT in this commit's scope; surfaced for visibility)

None new; auth.js issues from task #5's review still apply (one spurious fetch at T+60s, no SPA-nav teardown, etc.).

### Dismissed from round-2 findings (architect triage)

- **PS-001 (project-standards "task file not in tasks/review/", conf 100).** False positive — the file IS at `tasks/review/` at HEAD (commit `b4614c5` moved it after `fbe8578`). The reviewer looked at a stale path or the wrong commit reference.
- **T-03 (testing P2 conf 75) — Object.defineProperty setter intercept brittleness.** The status-transition test couples to `status` being a plain writable property (not a reactive proxy). Reviewer's argument: the assertion is redundant with the MAX_RETRIES cap test (which asserts call-count + final state, implementation-agnostic). True today; if Alpine ever wraps `status` as a reactive proxy, the test silently breaks. Acceptable risk — the cap test catches the same mutations.
- **JFR-001/002 (julik-frontend-races, conf 35-40).** Below confidence gate. The current Alpine-batch-flush mechanism + `:disabled` binding makes the in-flight overlap mechanically impossible; no real-world failure path.
- **AN/OPS-1 (agent-native — backend lacks log entry for retriable vs durable 409 split).** Backend-owned, low priority, advisory. File a backend follow-up if monitoring shows the split is needed.
- **Backend `Retry-After: 0` root cause (OPS-2).** Outside this task's scope; frontend's clamp is the right defense-in-depth.

### Suppressed at confidence gate

testing T-02 (timer advancement, conf 55), T-05 (counter assertion missing in cap test, conf 65), RR-01 (Retry-After:0 mutation kill incomplete, conf 80 borderline — folds into item #5 if implementer wants), RR-02/RR-03 (`_retryCount` reset assertions missing, conf 65-70), security residual risks (informational), learnings forward-looking notes.

### Path to re-archive

(1) UI applies items #1, #2, #3, #4, #5 in this hold block — small bundle, ~6 lines of code + 1 line of test. Item #1 also gets a unit test for the upper-bound clamp. (2) UI re-review signal block referencing the round-3 hold-fix commit SHA. (3) Architect round-3 `/ce-code-review` on the new commit (testing-focused given the rigor items). (4) Archive on clean. The new `architect-orcid-state-consumption-vs-retriable-409.md` task is independent and does not block this archive.

---

## UI re-review signal (2026-04-29, commit `f996d37`)

All 5 round-2 hold items landed in a single focused commit. 42 unit tests pass under `npx vitest run tests/unit/pages-orcid-callback.test.js` (was 41; the upper-bound clamp test is the +1).

- **Item #1 (P2 upper bound on Retry-After clamp).** `frontend/src/pages/orcid-callback.js:179` now reads `Math.max(1, Math.min(300, err.retryAfterSeconds ?? 10))`. Surrounding comment block updated to document both bounds (lower: zero collapses UX; upper: 99999s would pin the user). New unit test `ORCID_ALREADY_LINKED retriable with Retry-After: 99999: clamps countdown to <= 300s` asserts both `<= 300` and exact `300` for the 99999 input. Mirrors the existing `Retry-After: 0` clamp test.
- **Item #2 (P3 stale `_retryCount` field comment).** Dropped the trailing "The contract is 'one self-retry' per the code comment below; hard-coded to 1 so reviewers see the bound without chasing a const elsewhere" sentence. Counter-semantics + reset-sites portion preserved per architect guidance.
- **Item #3 (P3 prose at two comment sites).** `orcid-callback.js:182` and `:256` reworded from "a single self-triggered retry" / "single self-retry" to "up to MAX_RETRIES self-triggered retries". Matches the named const; no longer silently lies if MAX_RETRIES is raised.
- **Item #4 (P3 redundant `comp._mounted = true` in countdown-fires-retry test).** Deleted; `createTimerGuard()` already sets `_mounted: true`, the line was a no-op masquerading as bootstrap.
- **Item #5 (P3 missing `_retryCount` invariant in undefined-retryAfter test).** Added `expect(comp._retryCount).toBe(0)` after the existing assertions, with a comment pinning the invariant against mutations that wrongly count a non-retriable 409 toward MAX_RETRIES.

**Note for architect:** the parallel Option B decision (filed in `architect-orcid-state-consumption-vs-retriable-409.md`) and the follow-on `ui-orcid-callback-retriable-machinery-remove.md` task are tracked separately — those will eventually strip the very surfaces this bundle just polished. Per the architect's explicit "independent and does not block this archive" wording in the round-2 hold block, the bundle still lands cleanly here. The follow-on machinery-removal task picks up after `backend-orcid-droplockcontention-retriable.md` lands.


