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

## Architect re-review (2026-05-06, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commit `8f2b94d` with 9 reviewers (correctness, security at opus; testing/maintainability/project-standards/learnings/api-contract/reliability/kieran-typescript at sonnet). Implementation is contract-correct: middleware ordering verified (line 402 sits between `/api/*` routers and the SPA catch-all + errorHandler), envelope shape matches `agents/docs/api-contracts/common.md` exactly, no security findings, no contract findings. Two test-pin gaps need to land before archive.

### Items to address

**1. (P3) Add PATCH coverage to `backend/tests/routes/app-not-found.test.ts`.** The file header at lines 8-9 promises coverage of `GET/POST/PUT/PATCH/DELETE` but only the latter four have `it()` blocks. `app.use('/api', ...)` is method-agnostic so runtime is correct, but the test pin is incomplete relative to its own stated scope. Five reviewers flagged this (testing as a formal finding; project-standards/api-contract/reliability/security as residual gaps). Fix: add a fifth `it()` block:

   ```ts
   it('PATCH /api/<unknown> returns JSON envelope with NOT_FOUND', async () => {
     const res = await request(app).patch(NON_EXISTENT_PATH).send({ foo: 'bar' });
     expectJsonNotFound(res);
   });
   ```

**2. (P3) Replace inline cast at `backend/tests/routes/app-not-found.test.ts:28` with the canonical `ApiError` type.** `backend/src/types/api.ts:12` exports `ApiError` (re-exported via `backend/src/types/index.ts`) with `code: ErrorCode` (literal-union enum including `"NOT_FOUND"`) and `message: string` (required). Importing it tightens the assertion (a typo in the error code string becomes a typecheck failure) and closes a divergence vector if the canonical envelope grows fields. Fix:

   ```ts
   import type { ApiError } from '../../src/types/index.js';
   // ...
   function expectJsonNotFound(res: { status: number; body: unknown; type: string }) {
     expect(res.status).toBe(404);
     expect(res.type).toBe('application/json');
     const body = res.body as ApiError;
     expect(body.status).toBe('error');
     expect(body.error.code).toBe('NOT_FOUND');
     expect(body.error.message.length).toBeGreaterThan(0);
   }
   ```

   Drop the `?.` chains and the `?? ''` fallback. The canonical type makes those unreachable.

### Items dismissed during architect triage

- **(P2) Open-coded NOT_FOUND envelope at `backend/src/app.ts:402` duplicates `sendError()` from `backend/src/response.ts`.** Filed as a separate follow-up task `backend-error-envelope-helper-sweep.md` covering this site plus the pre-existing duplicate at `backend/src/middleware/errorHandler.ts`. Not held on this task because the cleanup spans two files and one site is out of this task's original scope.
- **(P3) Defensive `if (req.path.startsWith('/api/')) { return next(); }` guard at `backend/src/app.ts:414` is dead code.** Kept intentionally as defense-in-depth at the SPA layer. The guard prevents silent SPA-HTML regression for `/api/*` if a future refactor removes or mis-orders the `app.use('/api', ...)` handler at line 402, which is exactly the bug class this task fixed. Three lines of unreachable-but-defensive code is a net positive against the failure mode it guards. The implementer's comment update already accurately describes the role.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

## Backend re-review signal (2026-05-06, round-1 hold-fixes — commit `<SHA-PIN>` on `worktree-agent-a948e1877ba25061e`)

Round-1 closes 2 of 2 hold items in a single tightly-scoped diff over `backend/tests/routes/app-not-found.test.ts`. No `src/` changes — both items are test-pin tightenings against the canonical `ApiError` shape and the file's own stated `GET/POST/PUT/PATCH/DELETE` scope.

### Item-by-item resolution

**1. PATCH coverage added.** `backend/tests/routes/app-not-found.test.ts:50-53` — new fifth `it()` block matching the architect-supplied snippet verbatim: `request(app).patch(NON_EXISTENT_PATH).send({ foo: 'bar' })` then `expectJsonNotFound(res)`. The file header at lines 8-9 promised `GET/POST/PUT/PATCH/DELETE` coverage; the stated scope and the actual coverage now match. Runtime was already correct (`app.use('/api', ...)` is method-agnostic at `app.ts:402`); this closes the test-pin gap.

**2. Inline cast replaced with canonical `ApiError` type.** `backend/tests/routes/app-not-found.test.ts:4` — added `import type { ApiError } from '../../src/types/index.js';` (verified: `backend/src/types/index.ts:3` re-exports `* from './api.js'`, and `backend/src/types/api.ts:12` defines `ApiError` with `code: ErrorCode` literal-union including `"NOT_FOUND"`). `expectJsonNotFound` body at lines 25-32 collapsed to the architect-supplied snippet verbatim: `const body = res.body as ApiError;` then direct `body.status` / `body.error.code` / `body.error.message.length` assertions. The `?.` optional chains and `?? ''` fallback are dropped — under the canonical type the prior optional-chained / `typeof` checks were unreachable, and a future typo of the error code string ("NOT_FOUNDD") would now fail the typecheck rather than silently regress to a runtime-only catch.

### Verification gate

- `npx tsc --noEmit` — clean, no errors.
- `npm run lint` — clean, 2 pre-existing warnings only (`src/seed-phrase.ts:26,27` `@typescript-eslint/no-explicit-any`, both acceptable per task-2 round-3 signal-block precedent).
- Targeted vitest run (`tests/routes/app-not-found.test.ts`): **5 passed (5)** in 1.57s. All `GET/POST/PUT/PATCH/DELETE` cases land 404 + `application/json` + `NOT_FOUND` + non-empty message. Per task brief, full vitest suite is NOT run in this worker — parent serializes that after merging both worker diffs.

### Deviations from architect snippets

None. Both snippets applied verbatim. Import path resolves to `../../src/types/index.js` (the re-export route the architect specified); the direct fallback `../../src/types/api.js` was not needed.

### Out-of-scope items honored

- `backend/src/app.ts` — not touched. Item-2 is a test-pin only; runtime behavior was already correct under round-1's commit `8f2b94d`.
- Dismissed-triage items (open-coded NOT_FOUND envelope, defensive SPA-layer guard) — left untouched per the architect's hold-block. The envelope-helper sweep is tracked under the spawned follow-up `backend-error-envelope-helper-sweep.md`.

---
