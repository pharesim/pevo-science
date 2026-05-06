# BACKEND-ERROR-ENVELOPE-HELPER-SWEEP — adopt `sendError()` for the two open-coded NOT_FOUND envelopes

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at architect review of `backend-api-fallthrough-json-404.md`, finding 1)
**Priority:** P2

## Problem

The PEvO error-envelope shape `{ status: 'error', error: { code, message, details? } }` is open-coded at two sites:

1. `backend/src/app.ts:402` (newly introduced by commit `8f2b94d` from `BACKEND-API-FALLTHROUGH-JSON-404`) — the `/api/*` JSON-404 handler inlines:

   ```ts
   res.status(404).json({
     status: 'error',
     error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
   });
   ```

2. `backend/src/middleware/errorHandler.ts` (lines ~11-14, pre-existing) — the 4-arg errorHandler also open-codes the envelope.

`backend/src/response.ts` already exports `sendError(res, httpStatus, code, message)` which produces the canonical shape and is imported by every route file. Three independent envelope sites means a future contract change (adding `request_id`, `trace_id`, etc.) must be applied to all three or the API silently diverges by error path. Surfaced from architect review of the JSON-404 task itself, which was created BECAUSE the API was diverging from the documented contract for unmatched `/api/*` requests; re-introducing a divergence vector at a different layer goes against that grain.

## Goal

Both open-coded envelope sites use `sendError()`. The envelope shape lives in exactly one place (`backend/src/response.ts`).

## Acceptance

1. **Migrate `backend/src/app.ts:402`** — replace the inline `res.status(404).json({...})` call with `sendError(res, 404, 'NOT_FOUND', 'Endpoint not found')`. Existing test `backend/tests/routes/app-not-found.test.ts` continues to pass unchanged (envelope shape is identical).

2. **Migrate `backend/src/middleware/errorHandler.ts`** — replace the open-coded envelope construction with `sendError()`. The errorHandler's `code` and `message` are derived from the caught error; thread them through `sendError()` rather than building the response body inline.

3. **Verify.** `npx tsc --noEmit` clean. `npm run lint` no new errors. Existing tests stay green. Add no new tests, since the envelope shape is already pinned by `app-not-found.test.ts`, by the `sendError()` callers in routes, and by any existing errorHandler tests.

4. **Out of scope.** Do not change the `code` or `message` strings. Do not add `details` to either site. Do not change the HTTP status codes. Do not refactor `sendError()` itself.

## Coordination

- Surfaced from architect review of `backend-api-fallthrough-json-404.md` (commit 8f2b94d), finding 1.
- No dependency on the JSON-404 task's archive: these can land independently. (The JSON-404 task is currently in `tasks/pending/` for separate held items about test coverage.)
- `agents/docs/api-contracts/common.md` does not change. The envelope shape on the wire is identical before and after this task.
