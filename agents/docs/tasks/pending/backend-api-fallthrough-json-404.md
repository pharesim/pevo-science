# BACKEND-API-FALLTHROUGH-JSON-404 — return JSON envelope on unmatched `/api/*` requests

**Owner:** Backend Agent
**Created:** 2026-05-06 (filed at architect review of `backend-retire-bridge-update-route.md`, finding 1)
**Priority:** P1

## Problem

The PEvO backend's SPA catch-all in `backend/src/app.ts` (around line 397) is GET-only (`app.get('{*splat}', ...)`). Any unmatched `POST/PUT/PATCH/DELETE` under `/api/*` falls through to Express's default 404 handler, which emits an HTML response (`Cannot POST /api/...`) rather than the JSON envelope `{status: 'error', error: {code, message}}` documented in `agents/docs/api-contracts/common.md` for `NOT_FOUND` errors.

A frontend `fetch().then(r => r.json())` on the response will throw a JSON parse error instead of surfacing a structured `NOT_FOUND` code. The 4-argument `errorHandler` middleware only fires on thrown errors, not on unmatched routes.

The gap is pre-existing. It predates the bridge `/update` retirement (commit e647abb). The retirement made it concrete: `POST /api/bridge/update` is the freshest example of an unmatched `/api/*` POST a still-deployed frontend tab could issue. The contract claim in `common.md` has been untrue for any retired or mistyped `/api/*` path with a non-GET method since the SPA catch-all was introduced.

## Goal

`POST/PUT/PATCH/DELETE /api/<unknown>` must return a JSON envelope matching `common.md`'s `NOT_FOUND` row, so the contract holds for every unmatched `/api/*` path regardless of HTTP method. GET on an unmatched `/api/*` path must also return the JSON envelope, not SPA HTML.

## Acceptance

1. **Add an `/api/*` JSON-404 handler.** Registered AFTER all real `/api/*` route registrations and BEFORE the SPA catch-all and the 4-argument `errorHandler`. Concrete shape (verify against current `app.ts` structure during implementation):

   ```ts
   app.use('/api', (_req, res) => {
     res.status(404).json({
       status: 'error',
       error: { code: 'NOT_FOUND', message: 'Endpoint not found' }
     });
   });
   ```

2. **GET /api/&lt;unknown&gt;** must also return the JSON envelope, not the SPA HTML. Verify the new `app.use('/api', ...)` shadows the GET catch-all for `/api/*` paths.

3. **Regression test.** Add a vitest spec asserting `POST /api/this-route-does-not-exist` returns status 404 with body matching `{status: 'error', error: {code: 'NOT_FOUND', message: <non-empty>}}`. Repeat for at least one of `GET` / `PUT` / `DELETE` to pin all-method coverage. Live in `backend/tests/routes/` (pick the closest existing app-shape test file or add `app-not-found.test.ts`).

4. **Verify.** `npx tsc --noEmit` clean. `npm run lint` no new errors. Existing tests stay green.

5. **Out of scope.** Do not change response shape for routes that already produce a JSON 404 from inside a handler (e.g., resource-lookup `/api/papers/:author/:permlink` returning `NOT_FOUND`). The new handler only catches *unmatched* `/api/*` requests.

## Coordination

- Surfaced from architect review of `backend-retire-bridge-update-route.md` (commit e647abb), finding 1.
- No dependency on the bridge-retire task's archive: these can land independently.
- `agents/docs/api-contracts/common.md` already documents the `NOT_FOUND` envelope as the contract; no architect edit needed.
