# BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — Migrate `bridge.ts` + `custody.ts` `broadcastSendOperationsWithTimeout` catch blocks to the 504/502 pattern

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 review)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 migrated 7 HTTP surfaces using `broadcastJsonWithTimeout` to the 504 `BROADCAST_TIMEOUT` / 502 `BROADCAST_FAILED` / 500 `INTERNAL_ERROR` discrimination pattern. `bridge.ts` (`/register`, `/update`) and `custody.ts` (`/broadcast`) use a different helper — `broadcastSendOperationsWithTimeout` (landed in `BE-BROADCAST-SENDOPERATIONS-WRAP`, currently pending merge) — and their catch blocks still emit a single HTTP 500 `BROADCAST_FAILED` for all error shapes. `BroadcastTimeoutError` is not discriminated.

Maintainability MAINT-002 (0.85) + kieran-typescript KT-R2-2 (0.85) + KT-R2-3 (0.82) in the round-2 review:

- `backend/src/routes/bridge.ts:266,388` and `backend/src/routes/custody.ts:143` catch blocks use `(err as any)` with no `instanceof BroadcastTimeoutError` guard. A timeout returns 500 with no `retriable` flag — inconsistent with the 7 migrated routes.
- `bridge.ts` interpolates `err.message` / `jse_shortmsg` into the response body (`"Hive broadcast failed: ${detail}"`), leaking chain-internal error text to callers. This is a defense-in-depth issue: response messages should be static; chain internals go to server logs only.
- Secondary: 7 `(err as Error).message` casts in `bridge.ts` (non-broadcast error logging) pass a string to pino's `err` key, defeating pino's error serializer. Pre-existing pattern in a touched file.

AC-009 (0.85) from api-contract review: `BROADCAST_FAILED` now returns TWO different HTTP statuses (500 on bridge/custody, 502 on the 7 migrated routes) — an API-surface inconsistency.

## Goal

1. Migrate the 3 call sites to the 504/502 discrimination pattern. If `backend-handle-broadcast-error-helper.md` has landed, use the helper; otherwise inline the pattern.
2. Remove `err.message` / `jse_shortmsg` interpolation from `bridge.ts` response bodies — use a static string per branch and log the full error object for operators.
3. Normalize the 7 pre-existing `(err as Error).message` sites in `bridge.ts` to pass the full error object to pino: `logger.error({err, ...context}, ...)`.
4. Update `agents/docs/api-contracts/bridge.md` and `custody.md` errors sections with the new 502/504 entries (architect-owned fix-in-place at review time).

## Non-goals

- Changing the rate-limit or auth behavior on these endpoints.
- Extending the discrimination to `anonymousReview.ts` — separate assessment; that path uses raw `hiveClient.broadcast.sendOperations` (not the timeout helper) per round-1 residual risk.
- Introducing a new `BROADCAST_CHAIN_ERROR` code separate from `BROADCAST_FAILED` — maintain the single-code contract.

## Acceptance

- `bridge.ts` `/register` + `/update` and `custody.ts` `/broadcast` emit 504 `BROADCAST_TIMEOUT` on `BroadcastTimeoutError` and 502 `BROADCAST_FAILED` on other errors, envelope shape per `agents/docs/api-contracts/common.md`.
- Response messages are static strings; no `err.message` or `jse_shortmsg` interpolation.
- Logger calls use `{err, ...context}` (full object to pino); no `(err as Error).message` casts.
- Per-route timeout specs landed (mirror `orcid.test.ts` / `claims.test.ts` pattern).
- `npx tsc --noEmit` clean; full backend vitest passes.
- `[TODO Architect]` note on the re-review signal for `bridge.md` and `custody.md` contract updates.

## Coordination

- Prefer landing AFTER `backend-handle-broadcast-error-helper.md` so the migration is a 5-line change per site rather than 16. Not a hard dependency.
- The pending merge of `BE-BROADCAST-SENDOPERATIONS-WRAP` must land first (that's the commit that introduced `broadcastSendOperationsWithTimeout`). Backend agent is already handling that merge as of 2026-04-22.

## [TODO Architect]

On re-review, architect applies contract-file updates in `agents/docs/api-contracts/` (implementer did NOT touch the contract files):

- `bridge.md` — on `POST /register` and `POST /update`, replace the prior 500 `BROADCAST_FAILED` with:
  - 504 `BROADCAST_TIMEOUT`, details `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}` (no `verify_location`, not an orcid surface).
  - 502 `BROADCAST_FAILED`, details `{retriable:false}`.
  - Static response messages per branch:
    - register 504: `"Broadcasting bridge paper registration timed out"`
    - register 502: `"Failed to broadcast bridge paper registration to Hive"`
    - update 504: `"Broadcasting bridge paper update timed out"`
    - update 502: `"Failed to broadcast bridge paper update to Hive"`
- `custody.md` — on `POST /broadcast`, add the same 504/502 entries. Note the handler still emits 500 `INTERNAL_ERROR` for non-chain errors (db / decrypt / key parse) via the outer catch; only broadcast-path errors flow through 502/504.
  - 504: `"Broadcasting signed operation timed out"`
  - 502: `"Failed to broadcast signed operation to Hive"`

Implementer note (BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION, 2026-04-22): the 3 call sites were migrated via `handleBroadcastError` (landed in `0c95115`). Contract files are architect-owned and were deliberately not touched.

