# BE-CLAIMS-ERROR-POLISH — Surface bridge misconfiguration with a distinct 503

**Owner:** Backend Agent
**Priority:** P3
**Created:** 2026-04-21

## Status

Landed at commit **1cec6df** ("surface bridge misconfig with 503 (BE-CLAIMS-ERROR-POLISH)"). 16/16 `claims.test.ts` pass (13 pre-existing + 3 new BE-CLAIMS scenarios).

- **claims.ts:194-196** (approve handler): new guard `if (paperAuthor === config.hiveBridgeAccount && !config.pevoBridgePostingKey) return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured')`, placed immediately before the bridge-branch auth check so operators see a dedicated 503 instead of the misleading "Only the post author can approve claims on native papers" fall-through.
- **claims.ts:290-292** (revoke handler): same guard, placed **after** basic authorization (isPostAuthor/isClaimer/isAdmin) so unrelated callers still see 403 FORBIDDEN first; the 503 fires only for authorized callers on bridge papers with no posting key. Spec line numbers (~190/~277) drifted to 194/290 after the SEC-003-BE round-2 `active_accreditations` JOIN + chain-visible-actor comment.
- **`backend/tests/routes/claims.test.ts`** — new `describe('BE-CLAIMS-ERROR-POLISH — bridge misconfig surfaces as 503')` block (3 scenarios: approve 503, revoke 503 from admin, no `broadcastJson` in either case). Per-test save/restore of `config.pevoBridgePostingKey` via `afterEach`.

No contract change required (shape is a generic `SERVICE_UNAVAILABLE` 503, fits the existing envelope).

## Architect re-review (2026-04-21c) — HELD PENDING FIXES

Round-2 `/ce-code-review` (correctness/security/testing/api-contract/maintainability) on commit `1cec6df` confirmed the 503 guards work and tests are sound. One P2 cross-file inconsistency must close before archive.

1. **P2 — `bridge.ts` returns 500 INTERNAL_ERROR for the same misconfig** (`backend/src/routes/bridge.ts:158, :278`). Two bridge endpoints (registration + update) already returned 500 INTERNAL_ERROR with the identical `"Bridge posting key not configured"` message before this task. The new claims guards in commit `1cec6df` return 503 SERVICE_UNAVAILABLE — the more correct code per RFC 9110 ("deployment cannot broadcast on behalf of the bridge account right now" is service-availability, not internal-error). Result: same root cause, two codes. Fix: backport `bridge.ts` (both sites) to 503 SERVICE_UNAVAILABLE with the identical message + extract a small `assertBridgeKeyConfigured(res, paperAuthor)` helper (one return-true-if-configured, one return-false-after-sendError shape) so the four call sites (2 in bridge.ts + 2 in claims.ts) all source from one constant. Folds the round-2 P3 (helper-extraction-on-byte-identical-guards) in for free. Add one `bridge.test.ts` scenario per converted site asserting the 503 + identical error message.

**Dismissed from round-2 findings (architect review):**
- **(P3) `afterEach` save/restore ceremonial:** vitest file-level serial execution + per-test afterEach is safe; no race risk with sibling SEC-003-BE tests in the same file. The `(config as { ... })` cast matches the existing pattern. Discretionary refactor at most.
- **Pre-auth info leak on the approve guard (advisory):** dismissed. `verifyHiveSignature` runs before the guard, so unauthenticated callers never reach it. Authenticated-but-unrelated callers learn only that the paper author equals the bridge account — already public on-chain.

**Path to archive:** (1) Backend agent applies finding #1 (bridge.ts → 503 + helper extraction + 2 bridge.test.ts scenarios). (2) Architect re-reviews round-3 with `/ce-code-review`, archives.

## Backend re-review signal (2026-04-21, commit `67311b3`)

Finding #1 landed. Ready for architect round-3 re-review.

- `backend/src/routes/bridge.ts`: extracted `assertBridgeKeyConfigured(res): boolean` helper (exported). Register (`~:170`) and update (`~:288`) call sites converted from `500 INTERNAL_ERROR` / "Bridge posting key not configured" to the helper call; helper emits `503 SERVICE_UNAVAILABLE` with the identical message.
- `backend/src/routes/claims.ts`: imports `assertBridgeKeyConfigured` from `./bridge.js`; replaces the round-1 inline 503 guards at approve (`~:195`) and revoke (`~:291`). All four call sites now source from one constant message in the helper.
- Helper shape: `(res): boolean` — no `paperAuthor` parameter. In `bridge.ts` the handler is unconditionally bridge-context so the gate isn't relevant; in `claims.ts` that gate stays at the call site (`if (paperAuthor === config.hiveBridgeAccount && !assertBridgeKeyConfigured(res)) return;`). Delivers the "one constant message" goal without leaking a trivial coupling back into the helper.
- `backend/tests/routes/bridge.test.ts`: added auth-mock scaffold (mirroring `claims.test.ts` shape) plus new `BE-CLAIMS-ERROR-POLISH` describe block with 2 scenarios — register 503, update 503 — per-test save/restore of `config.pevoBridgePostingKey`. File-header justification for the `getAccreditedSet` mock added per root CLAUDE.md carve-out.
- Verified: 25/25 pass across `bridge.test.ts` (10) + `claims.test.ts` (15); typecheck clean.

## Architect re-review (2026-04-21, round-3) — HELD PENDING FIXES

Round-3 `/ce-code-review` on commit `67311b3`. The round-2 hold (backport bridge.ts 500→503, extract `assertBridgeKeyConfigured` helper, 4 call sites source from one constant) landed correctly: all 4 sites use the helper, bridge.test.ts has 2 new 503 specs with proper save/restore, typing is sound. Round-3 surfaced one logic bug in the revoke handler's guard ordering and two contract-documentation gaps the commit introduced but didn't close.

1. **P2 — `claims.ts:291` guard blocks `isClaimer` self-revoke on bridge paper when key is unset** (correctness C-01, 0.72). The revoke handler's authorization gate at lines 274-276 passes for `isClaimer` regardless of paper type. The `assertBridgeKeyConfigured` guard at line 291 then fires unconditionally for any bridge paper when the key is missing — including the self-revoke case. Comment at line 298 says "falls through to the client-signed return-operation path below" (no bridge key needed for client-signed), but the line-291 guard blocks that path before it can fire. A claimer self-revoking on a bridge paper when `pevoBridgePostingKey` is unset gets 503 SERVICE_UNAVAILABLE instead of the expected 200 + client-broadcast operation payload. Fix: reorder. Move the `assertBridgeKeyConfigured` guard BELOW the client-signed branch so it fires only when the server actually needs to broadcast with the bridge key. Alternative: gate the guard on `!isClaimer && paperAuthor === config.hiveBridgeAccount` so it skips when the caller will client-sign. Cleaner shape is reordering — the guard's job is "block when we NEED the key," which is after the client-signed branch has had its chance. Add one test: `isClaimer` authenticated + bridge paper + `pevoBridgePostingKey` unset → 200 with operation payload (not 503).

2. **P2 — `agents/docs/api-contracts/bridge.md` lines 146 and 187 still document `INTERNAL_ERROR`** (api-contract AC-001, 0.92). Both endpoints previously returned 500 INTERNAL_ERROR; round-2 changed to 503 SERVICE_UNAVAILABLE. Contract doc never updated. **Architect-side fix at archive** — I own the contract file. Rewrite both lines during archive as part of item #3 bundle.

3. **P2 — `SERVICE_UNAVAILABLE` absent from `common.md` error codes table** (api-contract AC-002, 0.95). The round-2 work (commit `52419c5`) added `SERVICE_UNAVAILABLE` to the `ErrorCode` TS union to satisfy the compiler but didn't update the standard error codes table in `agents/docs/api-contracts/common.md` lines 48-59. Any consumer that validates error codes against the documented set will treat SERVICE_UNAVAILABLE as unknown. **Architect-side fix at archive** — add a row to the standard error codes table: `| 503 | SERVICE_UNAVAILABLE | Backend dependency not configured or temporarily unavailable |`. Bundle with item #2.

**Dismissed from round-3 findings:**
- **P3 `assertBridgeKeyConfigured` naming — "assert" implies throw-on-failure convention, returns boolean** (maintainability M-001, 0.68). Inline comment above the function already documents the call convention. Rename is cosmetic churn. File mental note if a second boolean-returning `assert*` helper joins the codebase.
- **(P3) `afterEach` save/restore ceremony** — round-2 dismissal stands. Vitest file-level serial execution + per-test afterEach is safe.
- **(advisory) Pre-auth info leak on approve guard** — round-2 dismissal stands. `verifyHiveSignature` runs before the guard.

**Path to re-archive:** (1) Backend applies item #1 (reorder + test). (2) Backend re-review signal block. (3) Architect re-reviews round-4 with `/ce-code-review`. (4) Architect lands items #2 and #3 (contract doc updates) during archive as a single atomic edit. All 4 changes archive together.

## Architect re-review pass (2026-04-28) — STILL OPEN, MOVED BACK TO PENDING

Task was found in `tasks/review/` on 2026-04-28 architect intake but the round-3 hold item #1 has not been applied. No commit since `67311b3` mentions BE-CLAIMS-ERROR-POLISH. Current `claims.ts:299` still fires `assertBridgeKeyConfigured` before the client-signed return path at `claims.ts:361` — the exact ordering bug round-3 flagged. A claimer self-revoking on a bridge paper when `pevoBridgePostingKey` is unset still gets 503 instead of 200 + operation payload. Items #2 and #3 (architect-side contract doc edits at archive time) are still gated on item #1.

`git mv`'d back to `tasks/pending/`. Implementer: apply round-3 item #1, then move back to `tasks/review/`.
