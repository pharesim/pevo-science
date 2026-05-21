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
