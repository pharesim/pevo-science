/**
 * /api/* JSON 404 fall-through regression test
 * (BACKEND-API-FALLTHROUGH-JSON-404, surfaced from architect review of the
 * bridge-retire task, finding 1, 2026-05-06).
 *
 * Pins the contract that ANY unmatched `/api/*` path returns the JSON envelope
 * from `agents/docs/api-contracts/common.md` for `NOT_FOUND`, regardless of
 * HTTP method (GET/POST/PUT/PATCH/DELETE). Pre-fix, the SPA catch-all in
 * `backend/src/app.ts` was GET-only, so POST/PUT/PATCH/DELETE on an unknown
 * `/api/*` path fell through to Express's default HTML 404
 * (`Cannot POST /api/...`), which a frontend `fetch().json()` cannot parse.
 *
 * No mocks: the `app.use('/api', ...)` 404 handler runs before any router and
 * needs no real HAF/Redis/Hive. Pure shape assertion against the live app
 * builder.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { ApiError } from '../../src/types/index.js';

const app = createApp();

const NON_EXISTENT_PATH = '/api/this-route-does-not-exist';

function expectJsonNotFound(res: { status: number; body: unknown; type: string }) {
  expect(res.status).toBe(404);
  expect(res.type).toBe('application/json');
  const body = res.body as ApiError;
  expect(body.status).toBe('error');
  expect(body.error.code).toBe('NOT_FOUND');
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('unmatched /api/* requests return JSON 404 envelope (BACKEND-API-FALLTHROUGH-JSON-404)', () => {
  it('POST /api/<unknown> returns JSON envelope with NOT_FOUND', async () => {
    const res = await request(app).post(NON_EXISTENT_PATH).send({ foo: 'bar' });
    expectJsonNotFound(res);
  });

  it('GET /api/<unknown> returns JSON envelope, not SPA HTML', async () => {
    const res = await request(app).get(NON_EXISTENT_PATH);
    expectJsonNotFound(res);
  });

  it('PUT /api/<unknown> returns JSON envelope with NOT_FOUND', async () => {
    const res = await request(app).put(NON_EXISTENT_PATH).send({ foo: 'bar' });
    expectJsonNotFound(res);
  });

  it('PATCH /api/<unknown> returns JSON envelope with NOT_FOUND', async () => {
    const res = await request(app).patch(NON_EXISTENT_PATH).send({ foo: 'bar' });
    expectJsonNotFound(res);
  });

  it('DELETE /api/<unknown> returns JSON envelope with NOT_FOUND', async () => {
    const res = await request(app).delete(NON_EXISTENT_PATH);
    expectJsonNotFound(res);
  });
});
