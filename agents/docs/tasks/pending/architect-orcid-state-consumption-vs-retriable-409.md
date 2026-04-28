# ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 — Resolve the unreachable-by-design retriable-409 contract

**Owner:** architect (product decision needed before backend or UI implementation)
**Created:** 2026-04-29 (architect, surfaced by adversarial reviewer adv-1 during round-2 review of `UI-ORCID-CALLBACK-RETRIABLE-BRANCH` commit `fbe8578`)
**Priority:** P1
**Source:** `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 review (architect 2026-04-29) — adversarial conf 85.

## Problem

The `ORCID_ALREADY_LINKED` 409 envelope's `retriable: true` discriminator on the same-tick lock-contention branch is **unreachable by design** — backend consumes the OAuth state token before the contention is detectable, and the frontend's retry path then fails with 400 BAD_REQUEST instead of the retried operation succeeding.

Concrete trace:

1. `POST /api/orcid/callback` with `{code, state}`.
2. `backend/src/routes/orcid.ts:282-302` — backend reads `stateKey`, validates auth (for AUTHENTICATED_MODES), then **deletes `stateKey` at line 299** (`redis.del(stateKey)` / `orcidStates.delete(state)`). Comment at line 297 is explicit: "Auth passed (or mode is public). Consume state now so it can't be replayed."
3. `:335` switch routes to `handleAccredit` / `handleLink`.
4. Inside the handler, `withOrcidBindingLock` runs and may emit the 409 ORCID_ALREADY_LINKED with `retriable: true` + `Retry-After: 10` from its `'held'` branch.
5. Frontend (`frontend/src/pages/orcid-callback.js:288` `_retryVerify`) replays the same `{code, state}` after the countdown.
6. Backend `:282` state-check fires FIRST: `if (!storedMode) { sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter'); return; }`. Returns 400, not the retried-and-succeeding operation.
7. Frontend's catch block hits the generic-fallback branch (no special handling for 400 BAD_REQUEST after a retriable retry) and renders `orcid.verificationFailed`.

The retriable-discriminator infrastructure is structurally correct on each side (backend signals retriable+Retry-After; frontend consumes and counts down then retries) but the composition fails: the user never reaches the lock-contended retry that the contract promises. `MAX_RETRIES=1` (the round-1 hold-fix safety cap on this task) just bounds how many times the wrong outcome repeats.

This is **pre-existing** — the issue dates to whenever backend's lock-contention 409 first signaled `retriable: true`. UI-ORCID-CALLBACK-RETRIABLE-BRANCH (consumer side) shipped over an already-broken contract.

## Why this matters

- **The retriable-discriminator UX is silently lying to users.** A user hits the same-tick contention, sees a "retrying in 10 seconds" countdown, watches it fire, then sees a generic verification-failed message with no actionable signal. They restart OAuth and (most likely) succeed because the contention is transient. The countdown was theatre.
- **Operator alerts on retriable-409 are undercounted.** The frontend's 400 BAD_REQUEST after retry is indistinguishable from a normal state-token-replay attempt; operators reviewing 400 rates can't separate "user retried our retriable promise" from "actual replay attack."
- **Silent contract drift erodes trust in the retriable discriminator going forward.** If we ship A.1's lock-TTL-extension envelope on `BroadcastTimeoutError` (separate task, already shipped via 81795fd) and operators or future contributors look at the existing retriable-409 as a reference, they'll model new retriable contracts on a broken precedent.

## Three product directions (architect to decide)

### Option A — Backend: defer state consumption until after lock acquisition

Move the `redis.del(stateKey)` from `:299` (pre-dispatch) to inside the handler, AFTER `withOrcidBindingLock` returns successfully (or signals a non-retriable failure). The retriable-409 then preserves the state token, the frontend retry succeeds.

**Cost:** opens a state-replay attack window during the lock-acquisition + broadcast window (3-30s). An attacker who steals the state token between OAuth redirect and our consume-now point can race a parallel `/callback` request, both hitting different `handleAccredit` invocations against the same state. Today this is closed by the eager `redis.del`; deferring opens it.

**Mitigation:** the lock itself is keyed on `orcid_id`, so two concurrent `/callback`s with the same state would race for the same lock — one wins, the other gets `'held'` 409 retriable. The retry-with-same-state would then succeed (lock free) for whichever client retries first. The "attack" reduces to "attacker can force the legitimate user into a single retriable-409 round-trip" — UX nuisance, not auth compromise. The state token is still single-use *eventually* (consumed after the successful broadcast).

This is the cleanest architectural fix.

### Option B — Backend: drop `retriable: true` from lock-contention 409

Keep the eager state-consume. Acknowledge that the same-tick contention case is genuinely terminal from the user's perspective (state is gone; restart OAuth). Drop the `retriable: true` and `retry_after_seconds` from this specific 409 emission. Frontend continues to receive a `ORCID_ALREADY_LINKED` 409 but treats it as durable.

**Cost:** the user retry flow on contention is "restart full OAuth" instead of "wait 10s." Acceptable at PEvO's scale (contention is rare); same-tick contention typically clears before the user restarts.

This is the simplest fix. Honest to the actual contract.

### Option C — Frontend: treat `retriable: true` as informational

Keep both sides. Frontend renders the countdown but does NOT auto-retry — instead shows "another request is in progress; try again in N seconds" and lets the user manually click retry once N passes. A manual retry restarts OAuth (new state token) rather than replaying the consumed one.

**Cost:** kills the value-add of UI-ORCID-CALLBACK-RETRIABLE-BRANCH (auto-retry was the point). Defeats the round-1 hold's `_retryCount` + `MAX_RETRIES` machinery (no auto-retry to cap).

Defensible only if Option A's replay-window cost is judged unacceptable AND Option B's "drop the discriminator" feels like a contract regression we don't want to advertise.

## Recommendation (architect, leaning)

**Option B.** Same-tick lock contention is a rare edge case at PEvO's scale (tens of signups/day). The retriable-discriminator's value is on the lock-extended-on-`BroadcastTimeoutError` path (Option A.1, already shipped via `81795fd`) — and that path doesn't have the state-consumption-order problem because the timeout fires *after* the state was consumed by a successful broadcast acceptance. Dropping the same-tick `retriable: true` honestly aligns the contract with reality and removes the broken-by-design surface entirely.

If chosen, the follow-on UI work is to remove the now-unused `_retryCount` / `MAX_RETRIES` / countdown machinery from `orcid-callback.js` (or repurpose it for the BroadcastTimeoutError envelope, which DOES have a working retriable contract on the backend side).

## Acceptance

A separate `backend-orcid-...` task implements the chosen option once architect decides. This task closes when the decision is recorded in this file (or the file moves to archive) and the implementation task is filed.

## Coordination

- Pairs with `tasks-archive.md` BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT entry — that task's `retriable: false` 504 envelope on `BroadcastTimeoutError` (Option A.2 in the chain-write convention doc) is the OTHER retriable-vs-not signal in this surface, and IS correctly shaped (state has been consumed by the time the timer fires; the user is told to verify before retry, not auto-retry). The current task only resolves the same-tick contention path, not the timer-fire path.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — would benefit from a paragraph on "retriable=true is meaningless if state is single-use" once a decision is recorded.

## Source

- `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 architect review (2026-04-29) — adversarial finding adv-1 (P1 conf 85, "composition failure: state token consumed before retriable 409 emits").
- `backend/src/routes/orcid.ts:282-302` — state validate + consume.
- `backend/src/routes/orcid.ts:1027-1036` — lock-contention 409 with `retriable: true`.
- `frontend/src/pages/orcid-callback.js:288` — `_retryVerify`.
- `agents/docs/api-contracts/orcid.md:188` — same-tick lock-contention contract description.
