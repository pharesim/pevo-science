# SEC-002-HARDENING — Post-review hardening of /api/orcid

**Owner:** Backend Agent
**Priority:** P2
**Created:** 2026-04-21

## Status

All 6 items landed at commit **0e4241b** ("harden /api/orcid state consume, envelope, TOCTOU cache, prod warn (SEC-002-HARDENING)"). 14/14 `orcid.test.ts` pass (9 pre-existing SEC-002-BE + 5 new hardening). Full backend vitest 239 pass + 1 skipped; 2 `hafsql.test.ts` ECONNRESETs under concurrency, pass in isolation (infra flap, unrelated to this commit).

- **#1 state-consume inside try/catch** — `backend/src/routes/orcid.ts:185-194`. `redis.del`/`orcidStates.delete` now sits inside the outer try wrapping the token-exchange dispatch; a Redis DEL throw maps to 500 via the existing catch. Did NOT use `redis.getdel` — would break #3's state-not-consumed-on-403 contract.
- **#2 NO_ACCOUNT envelope fix** — `handleLogin` now emits `sendError(res, 404, 'NO_ACCOUNT', '...', { orcid_id })` so the frontend `ApiRequestError` parser receives `orcid_id` under `error.details`. Required adding `details?: Record<string, unknown>` to the `ApiError.error` shape in `backend/src/types/api.ts` and a `details` parameter on `sendError` in `backend/src/response.ts`.
- **#3 state-not-consumed-on-403 contract** — code-side contract enforced by the #1 move (consume fires only when auth passes). See **[TODO Architect post-fix]** below for the orcid.md prose.
- **#4 `orcid-link.spec.js:107-115` test.fixme** — implemented the two-browser-contexts 403 test (`frontend/tests/e2e/orcid-link.spec.js:107-176`); hits the API directly across two `browser.newContext()`s, asserts 403 FORBIDDEN. Falls back to `test.skip` with a concrete citation when ORCID is unconfigured in the test environment.
- **#5 HAF-lag TOCTOU mitigation** — `${config.appTag}:orcid_binding:${orcid_id}` EX 120s/value=username, written after the successful broadcast in both `handleAccredit` and `handleLink`. `findAccreditedAccountWithOrcid` consults Redis first and short-circuits when `value !== candidateUsername`. Redis outage degrades gracefully (falls back to the HAF-only path). NOTE: same-tick concurrent races remain — see SEC-002-TOCTOU-LOCK Pending follow-up.
- **#6 production multi-process startup check** — new `backend/src/startup-checks.ts` `checkOrcidProcessSafety()`, wired from `backend/src/index.ts` post-listen. Fires a loud `logger.warn` 5s after boot under `NODE_ENV=production` when Redis is not ready, calling out single-process-only `orcidStates` fallback as a multi-process/PM2/clustered-deploy breakage risk.

## Architect re-review (2026-04-21c) — HELD PENDING FIXES

Round-2 `/ce-code-review` (correctness/security/reliability/testing/maintainability/project-standards/kieran-typescript) on commit `0e4241b` confirmed the 6 landed items work as designed. One P2 finding extends Item 1's promise; remaining items dismissed or split to follow-ups.

1. **P2 — State-read still outside try/catch** (`backend/src/routes/orcid.ts:151`). Item 1 wrapped the Redis DEL inside the try/catch around the token-exchange dispatch, but the upstream `redis.get(stateKey)` at line 151 and `authenticateRequest` at line 177 remain outside. A transient Redis flap on the GET (or auth dispatch) escapes as an unhandled rejection — the exact failure mode Item 1 promised to close. Fix: widen the outer try to encompass the GET + the auth-check block, mapping any throw to 500 INTERNAL_ERROR with the same message shape the DEL-throw path now produces. Single-file edit in `orcid.ts`. Add one test: `redis.get` mocked to throw → 500 INTERNAL_ERROR with `state` NOT consumed (matches the state-not-consumed-on-403 contract for symmetry on infrastructure errors).

**Split to Pending follow-up: SEC-002-TOCTOU-LOCK (P2).** Round-2 also confirmed Item 5's narrowing of the HAF-lag TOCTOU window does NOT close the same-event-loop-tick race (cache write is post-broadcast, two concurrent same-orcid-id requests both broadcast). Fix is bigger surgery (SETNX lock semantics + outage fallback story) than fits in this task's scope; filed as Pending P2 with concrete shape.

**Dismissed from round-2 findings (architect review):**
- **(P3) No revoke-side cache invalidation, false 409 within 120s window if a different user tries to bind a just-freed ORCID:** revokes happen via on-chain `custom_json` (no PEvO endpoint to hook); the right shape is shorter TTL or accept the bounded window. 120s is acceptable for beta — revoke-then-rebind is a rare flow.
- **(P3) `error.details` widening unread by frontend:** grepped `frontend/src/` for top-level `orcid_id` consumers of NO_ACCOUNT — only hit is `orcid-callback.js:118` which reads `err.code === 'NO_ACCOUNT'` and uses a localized message, no field-level read. Move from top-level to `error.details` is end-to-end inert.
- **(P3) `setTimeout(5000)` startup check robustness:** plausible improvement (subscribe to the Redis client's `ready` event instead of fixed timeout) but no real failure motivating the change. Defer to a real incident.
- **(P3) `@ts-expect-error` in test:** cosmetic.

**[TODO Architect post-fix]** — `agents/docs/api-contracts/orcid.md` doc updates from the original status block, deferred to atomic archive once the state-read widening lands. Items 2/3 are stable and won't change shape further:

1. Under `POST /api/orcid/callback`, document the state-not-consumed-on-403 contract: "On a 403 FORBIDDEN response from authenticated modes (caller username does not match the initiator stored at /start), the OAuth `state` parameter is intentionally NOT consumed. The legitimate initiator can retry `/callback` with a valid bearer without being forced back through the ORCID OAuth redirect. State is consumed only after auth passes, or after any success or error on unauthenticated modes."
2. Update the NO_ACCOUNT response example: `orcid_id` now lives under `error.details`, not at the top level. Shape: `{ "status": "error", "error": { "code": "NO_ACCOUNT", "message": "...", "details": { "orcid_id": "0000-..." } } }`.
3. Optional: add a one-line note in `common.md` documenting that `error.details` is the canonical channel for error-context fields (mirrors the generic `ApiError.error` shape change in `backend/src/types/api.ts`).

**Path to archive:** (1) Backend agent applies finding #1 (try/catch widening + one test). (2) Architect re-reviews round-3 with `/ce-code-review`, lands the deferred orcid.md updates, archives.

## Backend re-review signal (2026-04-21, commit `ab2baaf`)

Finding #1 landed. Ready for architect round-3 re-review.

- `backend/src/routes/orcid.ts` `POST /api/orcid/callback`: outer try/catch widened to encompass the upstream `redis.get(stateKey)` + the `authenticateRequest` dispatch (previously only wrapped the state-consume DEL + token-exchange). Any infrastructure throw on the state-read or auth path now maps to 500 INTERNAL_ERROR via the existing catch with the same message shape the DEL-throw path produces. State is not consumed when the throw fires on the read (symmetric with the 403 state-not-consumed contract). Two stale rationale comments consolidated into one block above the try.
- `backend/tests/routes/orcid.test.ts`: one new spec in the `SEC-002-HARDENING` describe block — "returns 500 when redis.get throws while reading state (state-read is inside try/catch, state not consumed)". Spies `redis.get` to throw once, asserts `redis.del` never called with `stateKey`. Skips when Redis unavailable (Map.get can't throw). Pattern matches the pre-existing Item 1 DEL-throw test.
- Verified: 15/15 pass in `orcid.test.ts`; typecheck clean.
- [TODO Architect] orcid.md doc updates from original status block (state-not-consumed-on-403 contract + NO_ACCOUNT `error.details` shape + optional common.md note) remain deferred to atomic archive.

## Architect re-review (2026-04-21, round-3) — HELD PENDING FIXES

Round-3 `/ce-code-review` on commit `ab2baaf`. The round-2 hold-block widening (try/catch encompasses state-read + auth + DEL + token-exchange) landed correctly: 400 BAD_REQUEST path on `storedMode=null` still fires via normal early-return (not catch); 403 state-not-consumed preserved because `sendError(403) + return` exits before DEL; DEL throw still catches as 500 consistent with round-1. Round-3 surfaced a defense-in-depth gap and 2 test-coverage gaps adjacent to the commit's stated behavior.

1. **P2 — `sendError` has no `res.headersSent` guard** (correctness COR-005, 0.75). `backend/src/response.ts:19` calls `res.status(httpStatus).json(...)` unconditionally. The widened try now wraps `authenticateRequest` (orcid.ts:184), which internally uses `verifyHiveSignature`. If `verifyHiveSignature` ever both writes a response AND throws (currently not reachable per the promise/finish-listener structure, but not structurally enforced), the outer catch fires `sendError(res, 500, ...)` on an already-responded res, Express logs "Cannot set headers after they are sent", the response stream is corrupted. Fix: add `if (res.headersSent) { logger.warn({}, 'sendError called after response sent'); return; }` at the top of `sendError` in `backend/src/response.ts`. Defense-in-depth; closes any future expansion of the pattern (e.g. the SEC-AUTH-BYPASS and SEC-002-TOCTOU-LOCK catch blocks that also widen try/catch around middleware). Architect-owned file, so backend agent must flag the edit via `[TODO Architect]` or the architect lands it during re-review.

2. **P2 — Test uses `mockImplementationOnce` on `redis.get` — call-order-dependent, not key-targeted** (testing T-001, 0.88). The new "redis.get throws" spec at `orcid.test.ts:413-431` assumes the first `redis.get` call on the singleton is the stateKey read. Works today coincidentally (the throw exits the try before other `redis.get` calls happen). If a future change adds a `redis.get` upstream of the stateKey read (e.g. a per-request session lookup), the mock silently intercepts the wrong call and the test either passes for the wrong reason or fails for a confusing reason. Fix: swap to `mockImplementation(async (key) => { if (key === stateKey) throw new Error(...); return origGet(key); })`. Key-targeted, refactor-stable. ~6 lines.

3. **P3 — `authenticateRequest` throws → 500 path untested** (testing T-002, 0.85). The widened try wraps auth. The commit message names "auth dispatch error" as a covered path. No test exercises `verifyHiveSignature` synchronously throwing before `sendError + resolve`. Fix: one spec mocking `verifyHiveSignature` (or the underlying redis replay-cache it depends on) to reject synchronously for an authed-mode callback. Assert 500 INTERNAL_ERROR + `delSpy.mock.calls.map(c => c[0])` does NOT contain `stateKey` (state-not-consumed on infra error, symmetric with the 403 path).

4. **P3 — 403 state-not-consumed contract has no assertion in the existing 403 test** (testing T-003, 0.75). The 403 test at `orcid.test.ts:140` asserts `res.status === 403` + `broadcastJsonMock not called` but never asserts `redis.del` was NOT called with `stateKey`. A refactor that moves DEL before the username-mismatch check would go undetected. Fix: add `expect(delSpy.mock.calls.map(c => c[0])).not.toContain(stateKey)` to the existing 403 spec. One line.

**Dismissed from round-3 findings:**
- **P3 Emdashes in newly-added comments** (project-standards PS-001, 0.72). Rule is user-facing text scope; comments are fine. Pre-existing pattern.

**Path to re-archive:** (1) Backend applies items #1-4 (item #1 requires touching `backend/src/response.ts` — architect-owned — so either flag for architect with a `[TODO Architect]` block, or the architect lands it at re-review time). (2) Backend re-review signal block. (3) Architect re-reviews round-4 with `/ce-code-review` and archives. At archive, land the deferred `orcid.md` contract updates from the original `[TODO Architect]` block (state-not-consumed-on-403 contract + NO_ACCOUNT `error.details` shape + optional common.md note) as a single atomic edit.
