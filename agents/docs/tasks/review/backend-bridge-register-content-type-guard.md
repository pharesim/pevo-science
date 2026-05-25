# BACKEND-BRIDGE-REGISTER-CONTENT-TYPE-GUARD — close the non-JSON Content-Type CPU/RPC amplification bypass on `/api/bridge/register`

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by /ce-code-review adversarial reviewer at archive review of `backend-register-rate-limit-byip-skipfailed` round-2)
**Priority:** P2 (CPU/RPC amplification — bypass of the validateRegisterBody short-circuit that the prior task's middleware-reorder fix CLOSED for the malformed-JSON-body case; the non-JSON-Content-Type case is a separate attack class with identical impact shape)

## Problem

The `/api/bridge/register` middleware chain is `verifyHiveSignature → validateRegisterBody → registerLimiter → handler`. The prior task's round-2 fix moved `validateRegisterBody` ahead of `registerLimiter` to close a CPU/RPC amplification surface where malformed-body 400s under `skipFailedRequests: true` let an attacker spray probes that cost the server ECDSA recovery + `getAccounts` RPC per request but burned no rate-limit slot.

The reorder closes the malformed-JSON-body case. It does NOT close the non-JSON-Content-Type case:

1. Attacker holds one valid Hive posting key. Signs canonical message with body-hash of `'{}'` (since `JSON.stringify(undefined ?? {})` = `'{}'` per `lib/authMessage.ts`). Re-uses the precomputed signature with fresh timestamps within the 60s window.
2. POSTs `/api/bridge/register` with `Content-Type: text/plain` (or no Content-Type). The only body parser is `express.json({ limit: '1mb' })` at `app.ts`; Express 5 leaves `req.body === undefined` when Content-Type doesn't match application/json.
3. `verifyHiveSignature` runs: body-hash of `JSON.stringify(undefined ?? {})` = hash of `'{}'`, signature matches, ECDSA recovery + uncached `hiveClient.database.getAccounts` RPC fire, `next()` called.
4. `validateRegisterBody` runs: `const body = req.body as { identifier?: unknown; ... };` — `as` is compile-time only, runtime value remains `undefined`. `if (!body.identifier ...)` throws TypeError. Sync throw bubbles to the global `errorHandler` → 500 INTERNAL_ERROR.
5. `registerLimiter` NEVER REACHED. No slot consumed, no refund needed. Per-IP 10/hour budget untouched. Identical CPU/RPC amplification class as the prior round-1 finding, achieved via a different bypass.

The fix-shape attempted in `backend-register-rate-limit-byip-skipfailed` round-2 (validate-before-limit) is correct for malformed-JSON-body but does not generalize to "request body never reached validateRegisterBody at all" because `validateRegisterBody` itself can throw.

This was NOT introduced by the round-2 reorder; the same bypass existed pre-fix (with a slot-burn-and-refund signature instead of a no-slot signature). The reorder didn't make it worse, but it didn't address it either.

## Goal

Close the non-JSON Content-Type bypass so the per-IP CPU/RPC cost on `/api/bridge/register` is bounded regardless of body shape.

## Acceptance

### 1. Pick a fix shape

Three options, in order of preference:

**Shape A (recommended): Content-Type guard in `validateRegisterBody`.** Add an early-return at the top of `validateRegisterBody` that 415 UNSUPPORTED_MEDIA_TYPEs (or 400 BAD_REQUESTs) on any request whose `Content-Type` is not `application/json`. The check runs before `body.identifier` access, so the TypeError path is dead. Crucially, the 415/400 short-circuit happens BEFORE the limiter is reached, so the slot stays untouched. Combined with the existing presence/type/non-empty checks, this gives full pre-limiter validation coverage.

**Shape B: Defensive `req.body` null-check in `validateRegisterBody`.** Add `if (!req.body || typeof req.body !== 'object')` before the field checks. Returns 400 BAD_REQUEST. Functionally similar to Shape A but doesn't communicate the Content-Type semantics to the client.

**Shape C: Mount `express.json({ strict: false, type: '*/*' })` for the `/register` route specifically.** Forces body-parsing on any Content-Type. More invasive (changes parser scope) and may have side effects on other routes if the parser stack is shared.

Shape A is preferred because it (a) preserves the explicit 415 semantics that integrators expect, (b) closes the TypeError path with a defensive check that is easy to reason about, (c) matches the validation-first pattern the prior task established.

### 2. Apply the fix

Update `backend/src/routes/bridge.ts` `validateRegisterBody` middleware. The new shape should fail fast on any non-JSON request and return a sendError response with status 415 (preferred) or 400. The middleware MUST short-circuit before any `body.<field>` property access.

### 3. WHY-comment update

Extend the existing WHY-comment block above `registerLimiter` (or above `validateRegisterBody` itself) to document this third bypass class and how the new guard closes it. Anchor on stable symbols (`Content-Type`, `express.json`, `req.body`, `validateRegisterBody`) — no task slug, no round number, no line number, no SHA.

### 4. Canary tests

Add to `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` (or a sibling test file if shape fits):

- **Non-JSON Content-Type canary.** POST `/api/bridge/register` with `Content-Type: text/plain` and a valid Hive signature. Assert 415 (or 400). Assert `rateLimitCount('bridge-register', clientIp)` is null (slot untouched). Mutation-kill: remove the Content-Type guard → the test should flip RED (either with a 500 from the TypeError path or a different error envelope).

- **Missing Content-Type canary.** Same shape with NO Content-Type header set. Assert same outcome.

- **Bonus: empty-body canary.** POST `/api/bridge/register` with `Content-Type: application/json` but an empty body. `express.json` should leave `req.body` as `{}` (Express 5 default); `validateRegisterBody`'s existing presence-check should 400 cleanly. Pin this behavior so a future Express upgrade or json-parser swap doesn't silently change it.

### 5. Verification

- `npm run typecheck` clean.
- `npm run lint` clean.
- `npx vitest run tests/routes/bridge-register-rate-limit-skip-failed.test.ts` passes including new canaries.
- Mutation-kill verified on the new Content-Type canary.

## Out of scope

- The keywords/language silent-miscoercion in the handler's destructure (KT-1 finding from the prior task's round-2 review). Pre-existing; separate task if pursued.
- Verifying or hardening `verifyHiveSignature` itself against per-IP query volume. The current design treats verifyHiveSignature's per-request cost as bounded by the upstream rate-limiter; this task only addresses bypasses of THAT limiter.
- Equivalent Content-Type checks on other public routes (`/api/orcid/*`, `/api/accreditation/*`, `/api/custody/*`, etc.) — file separately if a cross-route sweep is desired.

## References

- `backend/src/routes/bridge.ts` — `validateRegisterBody` middleware and `registerLimiter` mount.
- `backend/src/app.ts` — `express.json({ limit: '1mb' })` mount.
- `backend/src/middleware/verifyHiveSignature.ts` — the ECDSA + getAccounts RPC cost per request.
- `backend/src/lib/authMessage.ts` — `buildCanonicalAuthMessage`'s `JSON.stringify(body ?? {})` body-hash semantics that allow the precomputed signature reuse.
- `tasks-archive.md` — `BACKEND-REGISTER-RATE-LIMIT-BYIP-SKIPFAILED` entry (when it archives) has the round-2 reorder context.
- `agents/docs/solutions/conventions/validator-limiter-ordering-depends-on-key-class-2026-05-21.md` — the canonical rule the round-2 reorder followed; this task is the same rule applied to a different bypass.

## Backend implementer signal (2026-05-25)

**Acceptance #1/#2 — Shape A applied (415 Content-Type guard).** `backend/src/routes/bridge.ts` `validateRegisterBody`: added an early-return at the TOP of the middleware, before any `body.<field>` access, that calls `sendError(res, 415, 'BAD_REQUEST', 'Content-Type must be application/json')` when `!req.is('application/json')`. `req.is(...)` returns `false` for `text/plain` and `null` for an absent Content-Type, so both bypass cases short-circuit. Because the guard sits inside `validateRegisterBody` (mounted `verifyHiveSignature → validateRegisterBody → registerLimiter → handler`), the 415 fires BEFORE `registerLimiter`, so the slot is never consumed and the TypeError-on-`req.body===undefined` path is dead.

ErrorCode-enum note: `ErrorCode` (in `backend/src/types/api.ts`) has no `UNSUPPORTED_MEDIA_TYPE` member and `sendError`'s `code` parameter is typed to that enum. Adding a new code is an API-shape change outside this task's scope (backend agent does not change API shapes without architect coordination). I therefore used HTTP status **415** with the existing `BAD_REQUEST` code: this preserves the explicit HTTP-415 unsupported-media-type status integrators see while keeping the envelope's `code` field within the established enum. The bridge contract doc already lists `BAD_REQUEST` for `/register`.

**Acceptance #3 — WHY-comment.** Extended the comment block above `validateRegisterBody` to document this third bypass class (non-JSON / absent Content-Type → `req.body === undefined` under Express 5 → `body.identifier` TypeError → 500, with the limiter never reached so no slot is consumed and nothing bounds the per-IP CPU/RPC cost) and how the guard closes it. Anchored on stable symbols (`Content-Type`, `express.json`, `req.body`, `validateRegisterBody`, `getAccounts`); no slug/round/line/SHA.

**Acceptance #4 — Canaries** added to `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` under `describe('validateRegisterBody Content-Type guard (415 before limiter, slot untouched)')`:
- Non-JSON Content-Type canary: 12 signed `text/plain` POSTs → all 415 (code `BAD_REQUEST`); then a full per-IP cap (10) of well-formed successes from the SAME IP all 202 → proves the 12 rejects burned no slot.
- Missing Content-Type canary: same with the header omitted entirely → 415; same slot-untouched probe.
- Empty-body canary: `application/json` with `{}` body → passes the Content-Type guard, 400 `BAD_REQUEST` on the presence check (pins the Express-5 empty-JSON-parse → `req.body === {}` behavior).

Slot-untouched probe rationale (documented inline): this suite's limiter accounting runs through the rateLimit middleware's in-memory `memStore` fallback (FakeRedis has no EVALSHA, so the Lua path throws and the middleware falls through), so the custody-style Redis-key `rateLimitCount` probe does not reflect the counter here. The file-consistent slot-untouched assertion is response-code based: spray > the per-IP cap of pre-limiter rejects, then prove a full cap's worth of well-formed successes still go through from the same IP. Also removed a genuinely-unused `const { config }` import flagged by `@typescript-eslint/no-unused-vars` in the same file.

**Verification.** `npm run typecheck` clean (src + tests). `npx eslint src/routes/bridge.ts tests/routes/bridge-register-rate-limit-skip-failed.test.ts` clean. Scoped `npx vitest run tests/routes/bridge-register-rate-limit-skip-failed.test.ts` → 6/6 pass (3 prior canaries + 3 new). **Mutation-kill:** removed the Content-Type guard and re-ran the guard describe → the non-JSON and missing-Content-Type canaries both flipped RED with `expected 500 to be 415` (the TypeError-500 path); the empty-body canary stayed green (it never depended on the guard). Restored the guard; re-ran green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
