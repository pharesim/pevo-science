# UI-FRONTEND-RETRY-TIMER-GUARD-SWEEP — Adopt timer-guard primitive across retry-loop backoff sleeps in bridge.js + paper-detail.js

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` triage of the 2026-05-20 UI HAF-cluster batch — findings cross-cutting `ui-bridge-register-lock-held-ux` (commit `01931666`) and `ui-paper-detail-retriable-503-handling` (commit `a99ef990`))
**Priority:** P3 (convention consistency + brittleness reduction; no behavioral bug today)

## Problem

PEvO's frontend has an in-tree timer-guard primitive at `frontend/src/lib/timer-guard.js` providing `_setTimer(fn, ms)` / `_teardownTimers()` for component-lifetime-aware timeouts. Every Alpine.js component that uses `setTimeout` is expected to route through this primitive so `destroy()` clears pending timers cleanly.

The recent retry-loop additions across two SPA flows use **naked `setTimeout` for backoff sleeps**, bypassing the timer-guard:

- `frontend/src/pages/bridge.js:351` — `await new Promise(resolve => setTimeout(resolve, delay))` for the LOCK_HELD backoff between retry attempts (1 site).
- `frontend/src/pages/paper-detail.js` — three naked `setTimeout`-via-Promise sleeps in `loadPaper()`'s SERVICE_UNAVAILABLE retry loop and `handleCitationExport`'s 2× bounded auto-retry (~lines 862, 872, 1098 in the round-1 layout; verify post-commit).

Behavior is correctness-safe today: each retry loop's post-await `if (!this._mounted) return;` (bridge.js) or the `this.author !== author || this.permlink !== permlink` paper-identity guard (paper-detail.js) prevents observable side effects after destroy. But:

1. **Resource lingering.** The setTimeout itself fires after destroy, holding a closure reference up to 3.5s post-teardown (bridge.js's longest backoff) or ~2.5s (paper-detail.js's longest).
2. **Convention drift.** Every other comparable Alpine page (orcid-callback.js, login.js, contact.js, publish.js, edit.js, review.js) uses `_setTimer` for component-lifetime timers. paper-detail.js is the most async-heavy page that has NOT adopted the primitive.
3. **Brittleness.** A future edit that adds a `console.log`, a retry-count UI update, or a toast inside the resolve callback would suddenly become a real bug — the `_mounted` / identity guards block state mutations on the next iteration, but the resolve callback itself runs unconditionally.

## Goal

Provide a sleep-shape helper in `timer-guard.js` (or equivalent) that participates in the existing teardown lifecycle, then migrate all four naked-setTimeout sites to use it.

## Acceptance

1. **Helper in `frontend/src/lib/timer-guard.js`.** Add a sleep-shaped primitive (suggested name: `_sleep(ms)`) that returns a `Promise<void>`, internally registers its `setTimeout` ID with the same tracking set `_teardownTimers()` already drains, and either (a) resolves normally when the timer fires, or (b) rejects with a recognizable signal (e.g., an `AbortError`-shaped error or a sentinel) when `_teardownTimers()` clears it before firing. Implementer discretion on resolve-vs-reject — both are workable; the existing `_mounted` checks at call sites suggest resolve-and-let-the-guard-catch-it is simpler, but a rejecting form would surface the cancellation earlier for cleaner control flow.

2. **Migrate bridge.js:351** to use the new helper. The post-await `if (!this._mounted) return;` guard becomes either redundant (if `_sleep` rejects on teardown) or remains as belt-and-suspenders (if `_sleep` resolves on teardown). Either is acceptable.

3. **Migrate paper-detail.js retry-loop sleeps (3 sites)** to use the new helper. The post-await paper-identity guards (`this.author !== author || this.permlink !== permlink`) stay in place — they cover the navigation-during-retry case, which `_sleep` cancellation does not.

4. **paper-detail.js `_mounted` adoption (optional, implementer discretion).** paper-detail.js does NOT currently adopt `createTimerGuard` / `_mounted` at all. The retry-loop migration above brings the file partway into the convention. Decide whether to extend to full adoption (init `_mounted` in `init()` / `destroy()`, add `_mounted` checks at every awaiting catch point) or stop at the retry-loop migration. Either is acceptable for this task; if full adoption is deferred, file a follow-up.

5. **Test.** At minimum: a vitest case pinning that a component destroyed mid-backoff does NOT call the post-await branch (whether by `_sleep` rejecting, by `_mounted` returning early, or both). One case per file (bridge.js + paper-detail.js) is sufficient — both flows have analogous sleep+await patterns.

## Out of scope

- Generic AbortController plumbing through `api.js` request lifetimes. That's a broader concern (the in-flight fetch on a navigated-away page completes wastefully whether or not the timer is guarded) and warrants its own task if pursued.
- Per-site retry-policy changes (backoff durations, attempt counts). The naked-setTimeout migration is structural only; preserve existing policy.
- Jitter on backoff arrays. Reliability reviewer surfaced this; out of scope here.

## Cross-references

- `frontend/src/lib/timer-guard.js` — existing primitive.
- `frontend/src/pages/orcid-callback.js`, `login.js`, `contact.js`, `publish.js`, `edit.js`, `review.js` — adoption reference patterns.
- `frontend/src/pages/bridge.js` — LOCK_HELD backoff site.
- `frontend/src/pages/paper-detail.js` — `loadPaper` and `handleCitationExport` retry-loop sleep sites.
- Source review fan-out: 4 reviewers (correctness, reliability, adversarial, julik-frontend-races) flagged the bridge.js site at anchor 100 after cross-reviewer promotion; julik + adversarial flagged the paper-detail.js sites at anchor 100 after promotion.

## Architect re-review (2026-05-20) — HELD PENDING FIXES

Implementer commit `9929497a` reviewed via `/ce-code-review` (7 reviewers: correctness, testing, maintainability, project-standards, learnings, julik-frontend-races, reliability). Migration is structurally correct and passes the correctness/reliability/standards bars. Three items held pending fixes; two further findings (NOT_FOUND destroy-mid-backoff test symmetry, `_sleep` module-header doc) were triaged-dismissed during review.

1. **`handleCitationExport` destroy-mid-503-backoff test missing.** The new `_mounted` guard at `frontend/src/pages/paper-detail.js:1148` (inside `handleCitationExport`'s SERVICE_UNAVAILABLE retry-loop) has no teardown-race coverage. The existing analogous test for `loadPaper`'s SERVICE_UNAVAILABLE path is at `frontend/tests/unit/pages-paper-detail.test.js:904`. Mirror its shape: mock `fetchCitationExport` to reject with a retriable 503, call `handleCitationExport('apa')`, advance fake timers partway into the first 1500ms backoff, call `comp.destroy()`, advance 20000ms, then assert `fetchCitationExport` was called exactly once AND `comp.citeLoading === false` (also verifies the destroy-time `citeLoading` reset through the outer `try/finally`).

2. **Vacuous 503 destroy-test assertions.** At `frontend/tests/unit/pages-paper-detail.test.js:929`, the new `loadPaper destroy() during retriable-503 backoff` test asserts `comp.error === null` and `comp.errorIs503 === false` after teardown. But `loadPaper()` initializes both to `null`/`false` at function entry, and they are only mutated in the post-retry-budget error-display branch that mid-backoff teardown never reaches — so the assertions pass even if the `_mounted` guard fully failed. Only `fetchPaper.toHaveBeenCalledTimes(1)` is load-bearing. Fix: before calling `comp.loadPaper()` in the test, seed `comp.error = 'sentinel'` and `comp.errorIs503 = true`. After teardown and timer advance, assert those sentinel values are unchanged. This turns the assertions into real state-mutation detection — a regression in the `_mounted` guard would overwrite the sentinels.

3. **`destroy()` comment enumerates specific methods (rot).** At `frontend/src/pages/paper-detail.js:849`, the comment reads "guards in `loadPaper` / `handleCitationExport` keep state mutations from running after destroy." This is method-list enumeration that goes stale when a 3rd async retry loop adopts `_sleep`. Per PEvO's comment-anchor convention (root CLAUDE.md "Comment anchors"), anchor on the invariant instead. Replace with text equivalent to: "Post-await `if (!this._mounted) return;` guards in all retry loops prevent state mutation after destroy; teardown here releases the timer closure references those loops hold."

**Triage dismissals (recorded; no action required):**
- NOT_FOUND destroy-mid-backoff test missing in `loadPaper`'s NOT_FOUND retry branch (new guard at `paper-detail.js:881-882`). Risk class is structurally identical to the SERVICE_UNAVAILABLE branch which is covered; dismissed per PEvO preemptive-test-hardening policy.
- `_sleep` resolve-on-teardown rationale promotion to module header. The rationale is already documented inline at `frontend/src/lib/timer-guard.js:53-58` and the existing docblock IS the module header for `createTimerGuard()`.

## UI re-review signal (2026-05-20, working tree)

All three held items landed in this commit. Vitest pass: 80/80 in `frontend/tests/unit/pages-paper-detail.test.js`.

1. **`handleCitationExport` destroy-mid-503-backoff test** — added under the `SERVICE_UNAVAILABLE retriable handling` describe block, immediately before the existing `paper-identity changes mid-backoff` test. Mirrors the `loadPaper` 503 destroy-test shape: mocks `fetchCitationExport` to reject with retriable 503, calls `handleCitationExport('apa')`, advances 500ms into the 1500ms first backoff, destroys, advances 20000ms, asserts `fetchCitationExport` called exactly once and `citeLoading === false`. The `citeLoading` assertion additionally pins the outer `try/finally` reset fires through the `_mounted` early-return path.

2. **Vacuous 503 destroy-test assertions in `loadPaper`** — switched to string sentinels seeded AFTER the `comp.loadPaper()` call returns its promise (synchronous prologue resets to `null`/`false` first, then control returns at the first `await`). The architect's literal prescription said "seed before" with `errorIs503 = true`, but `loadPaper`'s entry prologue overwrites pre-seeded values immediately, and `true` is the same value the regression path would write to `errorIs503` (the post-retry-budget `else if (isRetriable503(err))` branch sets `errorIs503 = true`). String sentinels (`'sentinel-error'` / `'sentinel-503'`) seeded post-prologue catch both regression modes: sentinel survival proves the `_mounted` short-circuit fired; sentinel overwrite to a localized title string would fail both assertions. Comment in the test documents the sequencing reasoning so the next reader doesn't re-introduce the pre-loadPaper seeding.

3. **`destroy()` comment anchor rot** — replaced the method-list enumeration ("guards in `loadPaper` / `handleCitationExport` ...") with invariant-anchored phrasing ("Post-await `if (!this._mounted) return;` guards in all retry loops prevent state mutation after destroy; teardown here releases the timer closure references those loops hold.") per root CLAUDE.md "Comment anchors".

## Architect re-review (2026-05-20, round-3) — HELD PENDING FIX

Round-2 commit `c192833c` reviewed via `/ce-code-review` (5 reviewers: correctness, testing, maintainability, project-standards, learnings). All three round-2 items land correctly: handleCitationExport destroy test mirrors the loadPaper shape with load-bearing call-count assertion; loadPaper sentinel placement (post-prologue) and value choice (string sentinels avoiding boolean-`true` collision with the regression-write) are correct; destroy() comment rewrite passes the comment-anchor convention. One contradiction held:

1. **Sentinel-seeding comment opens with "BEFORE" but code seeds AFTER.** At `frontend/tests/unit/pages-paper-detail.test.js:915`, the comment header reads "Seed sentinel values BEFORE calling loadPaper." The actual seed lines (923-924) come AFTER `const p = comp.loadPaper();` on line 922. The body of the comment then explains the post-prologue rationale correctly — making the header internally contradictory with both the code and its own body. Flagged by correctness, maintainability, and testing reviewers at cross-reviewer anchor 100. Failure mode: a future maintainer reading the header and "fixing" the placement to match would re-introduce pre-call seeding that the entry-prologue immediately overwrites — exactly the trap the rewrite was meant to prevent. Fix: change the opening sentence to "Seed sentinel values AFTER calling `loadPaper()` so the synchronous prologue (`error = null` / `errorIs503 = false`) runs first and the sentinels survive into the post-await branch." Or restructure however reads cleanly; the load-bearing constraint is that the opening sentence not contradict the line ordering immediately below it.

**Round-2 architect-prescription corrections (acknowledged, not held):** The implementer correctly diverged from the round-1 hold-block's literal prescription on item #2 — switched from pre-call seeding (would not survive the entry-prologue reset) to post-prologue seeding, and from boolean-`true` sentinel (collides with the regression-write value) to string sentinels (no collision). Both corrections are correct judgment calls grounded in the actual code semantics. The round-1 hold-block text drifted from what the code would do; the implementer caught the drift on the fly and documented it in the re-review signal block. No held action from this — the divergences are recorded for posterity in the round-2 signal block.

## UI re-review signal (2026-05-20, round-3, working tree)

Round-3 hold item #1 landed. Rewrote the sentinel-seeding comment header at `frontend/tests/unit/pages-paper-detail.test.js` so the opening sentence now reads "Seed sentinel values AFTER calling `loadPaper()` so the synchronous prologue (`error = null` / `errorIs503 = false`) runs first and the sentinels survive into the post-await branch." The rationale body below (regression-write detection via sentinel survival) is unchanged. The header now matches the line ordering in the code below (`loadPaper()` call first, sentinel seeds after) and matches the architect's prescription verbatim.

Vitest pass: 80/80 in `frontend/tests/unit/pages-paper-detail.test.js`. No code changes; comment-only edit.
