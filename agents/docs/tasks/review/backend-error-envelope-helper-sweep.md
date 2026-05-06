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

---

## Backend re-review signal (2026-05-06, round-1 — commit `89ec691` on `main`, originally `c162db8` on `worktree-agent-a673241a5ea28b2e6`)

Both open-coded envelope sites migrated to `sendError()` from `backend/src/response.ts`:

- **Acceptance 1 — `backend/src/app.ts`** — JSON 404 handler at the `/api` fallthrough now calls `sendError(res, 404, 'NOT_FOUND', 'Endpoint not found')`. Added `import { sendError } from './response.js';` next to the existing `errorHandler` import. The 3-line inline `res.status(404).json({ status: 'error', error: { code, message } })` block collapses to one line. Surrounding comment block (registration ordering rationale) is preserved verbatim.

- **Acceptance 2 — `backend/src/middleware/errorHandler.ts`** — 4-arg Express error handler now calls `sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')`. Added `import { sendError } from '../response.js';`. Per task, the existing handler hard-coded the `INTERNAL_ERROR` / `Internal server error` constants regardless of the caught `err` (only `err.message` / `err.stack` flow into `logger.error`); I threaded those same constants through `sendError()` to preserve identical behavior. The `logger.error({ err: ... }, 'Unhandled error')` call is unchanged and still fires before the response.

- **Acceptance 3 — Verify.**
  - `cd backend && npx tsc --noEmit` — clean (no output).
  - `cd backend && npm run lint` — 0 errors. Two pre-existing warnings in `src/seed-phrase.ts` (unrelated `no-explicit-any` warnings, untouched by this task).
  - `npx vitest run tests/routes/app-not-found.test.ts` — 5/5 green (POST/GET/PUT/PATCH/DELETE on a non-existent `/api/*` path).
  - `npx vitest run tests/response.test.ts` — 6/6 green (covers `sendError` + `sendOk` directly, including the 500/`INTERNAL_ERROR` envelope shape exercised by the migrated errorHandler).
  - No errorHandler-specific test file exists in `backend/tests/`; the only `errorHandler` references in tests are documentation comments inside `accreditation.test.ts` (lines 374, 396, 899) referring to Express 5's async-error path, none of which assert on the envelope shape directly.

- **Acceptance 4 — No new tests.** Envelope shape is pinned by `app-not-found.test.ts` (NOT_FOUND/404) and `response.test.ts` (canonical `sendError` shape including INTERNAL_ERROR/500). Existing route tests using `sendError()` cover the same wire shape across other error codes.

- **Out-of-scope guards held.** No change to `code` or `message` strings on either site. No `details` arg added. HTTP status codes unchanged (404, 500). `sendError()` itself untouched.

**Wire shape verification.** Pre-fix and post-fix both produce `{ status: 'error', error: { code, message } }` with no `details` key (omitted when undefined per `response.ts:38`), `Content-Type: application/json`, and the same HTTP status. The `sendError` helper adds one runtime safeguard not present in the inline form: a `headersSent` early return that warn-logs and skips the duplicate write. For the 4-arg errorHandler, this is strictly safer (a route that already responded then threw won't corrupt the stream); for the `/api` 404 fallthrough, `headersSent` is false in normal flow so behavior is identical.

