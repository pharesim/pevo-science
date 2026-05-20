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
