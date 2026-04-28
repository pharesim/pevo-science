# BACKEND-ORCID-DROPLOCKCONTENTION-RETRIABLE — Drop the broken `retriable: true` from same-tick lock-contention 409

**Owner:** backend
**Created:** 2026-04-29 (architect, follow-on to ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 — Option B chosen)
**Priority:** P1
**Source:** `agents/docs/tasks-archive.md` ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (decision recorded 2026-04-29).

## Problem

The same-tick lock-contention 409 in `withOrcidBindingLock` (`backend/src/routes/orcid.ts:1027-1036`) emits `retriable: true` + `retry_after_seconds: 10` + `Retry-After: 10` header. The discriminator is unreachable by design: state is consumed at `:299` BEFORE the lock acquisition runs, so the frontend's same-`{code, state}` retry lands on the `:282` BAD_REQUEST branch instead of succeeding. The retriable promise is theatre — see the architect decision in `tasks-archive.md` for the full trace and three-option analysis.

Architect decided **Option B**: the same-tick contention case is genuinely terminal from the user's perspective (state is gone; restart OAuth). Drop the `retriable: true` discriminator and the `Retry-After` header from this 409 emission. The 409 status code, `ORCID_ALREADY_LINKED` error code, and human-readable message stay; clients on this 409 restart the ORCID flow.

## Scope

1. **`backend/src/routes/orcid.ts:1027-1036`** — strip the `Retry-After` header and the `retriable: true` + `retry_after_seconds` keys from the `'held'` branch's `sendError` call. The 409 + `ORCID_ALREADY_LINKED` + the existing message stay. The constant `ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS` becomes unused on this branch — confirm no other site references it before removing the constant. (`grep -rn "ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS" backend/src/` should return nothing after removal.)

2. **Lock TTL extension on `BroadcastTimeoutError` (Option A.1) is unaffected.** The 120s extension is server-internal — it prevents a concurrent bind from acquiring a fresh lock while the original broadcast may still be on-chain unindexed. The wire shape of a 409 emitted into that 120s window is the same as outside it (now non-retriable). No code change needed in the timer-fire path.

3. **Tests** — find and update any test that asserts `retriable: true`, `retry_after_seconds`, or the `Retry-After` header on the lock-contention 409:
    - `grep -rn "retriable.*true" backend/test/` and trace into ORCID lock-contention assertions.
    - `grep -rn "Retry-After" backend/test/` similarly.
    - The new shape: 409 status, `error.code === 'ORCID_ALREADY_LINKED'`, `error.details` omits `retriable` (consistent with the durable-binding 409 cases), no `Retry-After` header on the response.
    - Keep tests that assert the lock-extension-to-120s behavior (Option A.1) — those exercise the `BroadcastTimeoutError` path, which was always `retriable: false` and stays so.

4. **Operator log** — the `logger.error` (or `warn`) on lock contention should still fire so operators can correlate contention frequency. If the previous log line referenced the retriable promise (e.g., "client may retry in 10s"), drop the misleading text. Keep the orcid_id, the contender's username/mode, and the lock holder's nonce if logged.

## Out of scope

- The `BROADCAST_FAILED` 502 (`details.retriable: false`) and `BROADCAST_TIMEOUT` 504 (`details.retriable: false, outcome: 'uncertain', verify_before_retry: true`) envelopes are unchanged. Both correctly say non-retriable today; both already document why retry is unsafe (state consumed, may have landed on chain).
- The `POST_BROADCAST_FAILED` 502 envelope is unchanged.
- The lock primitive itself (`acquireBindingLock`, `releaseBindingLock`, the Lua CAS, the SETNX-then-EXPIRE shape) is unchanged.
- Frontend cleanup of the now-unused `_retryCount` / `MAX_RETRIES` / countdown machinery lives in `ui-orcid-callback-retriable-machinery-remove.md`. Coordinate landing order: backend can ship first (the UI's retry path becomes a no-op the moment backend stops emitting `retriable: true`); UI cleanup can land any time after.

## Acceptance

- The `'held'` branch 409 wire shape matches the durable on-chain binding and cache-lag binding 409s (no `retriable`, no `Retry-After`).
- All lock-contention tests pass with the new shape; no test still asserts the dropped fields.
- `grep -rn "ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS" backend/src/` returns no hits (constant removed) OR a comment in `routes/orcid.ts` explains why it stayed (e.g., reused by the timer-fire path — verify before claiming).
- `grep -rn "Retry-After" backend/src/routes/orcid.ts` confirms the same-tick branch no longer sets it.
- Architect (re)reviews the diff before archive. The `agents/docs/api-contracts/orcid.md` update for this case is already in flight by the architect on the decision — backend does NOT need to edit the contract file.

## Source

- `tasks-archive.md` ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (decision Option B, 2026-04-29).
- `backend/src/routes/orcid.ts:282-302` (state consume) and `:1027-1036` (lock-contention 409).
- `agents/docs/api-contracts/orcid.md:185-192` (current 409 spec; updated by architect alongside this task's filing).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (paragraph on "retriable=true is meaningless if state is single-use" appended by architect alongside this task's filing).
