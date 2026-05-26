# BACKEND-IPFS-PIN-INSIDE-DB-TRANSACTION — Record pending pin durably before returning success

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md`)
**Priority:** P0

## Context

`backend/src/routes/ipfs.ts` `/api/ipfs/pin` handler currently runs:

```ts
const result = await pinToIpfs(req.file.buffer, safeName);

const appPool = getAppPool();
if (appPool) {
  await appPool.query(
    `INSERT INTO pending_ipfs_uploads (cid, uploader_account, size_bytes)
     VALUES ($1, $2, $3)
     ON CONFLICT (cid) DO NOTHING`,
    [result.cid, req.hiveUsername, result.size],
  ).catch((err) => {
    logger.error({ err, cid: result.cid }, 'Failed to record pending IPFS upload in DB');
  });
}
```

The pin to Kubo / Pinata succeeds. The DB insert is best-effort and swallows errors. If the DB is unreachable for the duration of one HTTP request — a routine event during Postgres failover, network blip, or `idle_in_transaction_session_timeout` cap — the pin is now live on the self-hosted Kubo node with **no row in `pending_ipfs_uploads`**. The IPFS-cleanup job (`ipfs-cleanup.ts`) only scans the DB, so this CID becomes an undetectable orphan that consumes disk and pin-set entries forever.

The same race exists for the Redis hot-cache write below, but the DB write is the load-bearing one for cleanup.

## Goal

Make the DB insert load-bearing for "pin succeeded":

1. **Reorder** so DB insert happens before the success response is composed. The `pinToIpfs` call still has to run first (we need the CID), but the response must not be sent until the row exists.
2. **Compensate** on insert failure: call the IPFS backend's `unpin(cid)` so we leave neither a DB row nor a live pin, then return 500.
3. Keep the Redis cache write as a best-effort optimization below the DB write (no compensation, fine to swallow).
4. If `appPool` is null (light dev configs), refuse the pin entirely — returning a tracked CID without DB durability is the worst of both worlds.

## Non-goals

- Two-phase commit across Postgres + Kubo. The compensation pattern above is the pragmatic shape; pinning is idempotent enough that a leaked-by-crash pin between `unpin` call and response is acceptable.
- Reworking the cleanup job's scan logic — this fix lets it stay DB-authoritative.

## Acceptance

- `/api/ipfs/pin` does not return 200 unless the row exists in `pending_ipfs_uploads`.
- On DB-insert failure, the handler calls `unpin(cid)` against the same backend that pinned it, logs both the original DB error and any unpin error, and returns 500 `INTERNAL_ERROR`.
- A test (under the existing test carve-out for mock-able infrastructure) injects a DB failure between `pinToIpfs` success and the response, and asserts `unpin` was called and the response was 500.
- Cleanup-job behavior unchanged; no new orphan class.

## References

- Audit chunk: `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md` (P0: IPFS pin recorded outside the HTTP transaction).

## Backend implementer signal (2026-05-21)

Implemented in `backend/src/routes/ipfs.ts`:

- `PinResult` now carries a `backend: 'kubo' | 'pinata'` discriminator so the compensation path can dispatch the unpin to the same backend that produced the pin.
- New module-private `unpinFromKubo` / `unpinFromPinata` / `unpinFromIpfs(cid, backend)` helpers. Kubo unpin tolerates "not pinned" responses (mirrors `ipfs-cleanup.ts`'s tolerance for the same benign race).
- `/api/ipfs/upload` handler:
  - Refuses pin with `503 SERVICE_UNAVAILABLE` when `getAppPool()` returns null — short-circuits BEFORE calling `pinToIpfs`, so no orphan pin is produced when durability is unavailable.
  - DB insert into `pending_ipfs_uploads` no longer swallows errors via `.catch()`. On `INSERT` failure, the handler calls `unpinFromIpfs(result.cid, result.backend)`, logs both the DB error and any unpin error (with `dbErr` nested in the unpin-failure log for forensic correlation), and returns `500 INTERNAL_ERROR`.
  - Redis hot-cache write remains best-effort below the DB write.

Tests in new sibling file `backend/tests/routes/ipfs-pin-durability.test.ts` (clauses a/b/c documented in the file header):

1. `getAppPool() === null` → 503, NO fetch to IPFS, NO query attempted.
2. DB insert rejects after successful pin → unpin called against Kubo with `arg=<cid>`, 500 returned, exactly one query attempted (no retry, no post-compensation write).
3. Happy path → 200, NO unpin called.

Real-path companion in `tests/routes/ipfs.test.ts` (untouched) covers the integrated route with real `verifyHiveSignature` (401 without auth headers test).

Lint clean. `typecheck:src` clean. `typecheck:tests` has one pre-existing error in `tests/support/argon2-error-mocks.ts` unrelated to this change.

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on commit `ff708ab3` (10-persona fan-out). The P0 goal is met — the insert is load-bearing, the 503-before-pin refusal is correctly ordered after auth, and the correctness and security passes came back clean. The items below must land before archive. The test-file touches (carve-out, Pinata-dispatch, double-failure) batch together; the code touches are in `routes/ipfs.ts`.

- **Over-unpin guard: compensation can remove a pin a committed row depends on.** The `catch (dbErr)` unconditionally unpins on any insert rejection, but a rejection does not prove "no row exists." Two reachable states break this: (a) a concurrent upload of the same content/CID whose insert already committed — Kubo pins are not refcounted, so the unpin kills the live pin that request's 200 already referenced; (b) the insert commits server-side but the connection drops before the ack, so node-postgres rejects a query whose row actually landed. The result is the inverse of the orphan this task fixes: file unpinned, row present, paper reference dead, cleanup blind. Before unpinning, confirm no row for this CID exists (a concurrent or committed-but-unacked insert may own it) and only compensate when absence is confirmed; if the existence check itself cannot run, bias toward NOT unpinning (a tolerated orphan beats guaranteed data loss). Document the residual window. The task's stated 2PC non-goal covered leaked pins, not this over-unpin direction.
- **Carve-out clause (b)/(c) is falsely claimed.** The test header states the real `verifyHiveSignature` middleware is exercised by `ipfs.test.ts`'s "401 without auth headers" test, but `ipfs.test.ts` also applies `MOCK_VERIFY_SIGNATURE`, so that 401 fires from the missing-header gate, not real cryptographic verification — no test runs real `verifyHiveSignature` against `/api/ipfs/upload`. Correct the false header sentence AND add a real-path companion exercising the real middleware against a signed (or deliberately bad-signature) request for the upload route or a sibling IPFS route, per the CLAUDE.md mock carve-out clause (b)/(c).
- **`unpinFromPinata` benign-absence tolerance.** `unpinFromKubo` tolerates an already-absent pin ("not pinned") as benign; `unpinFromPinata` throws on any non-2xx, so on the Kubo→Pinata fallback compensation path an already-removed pin fires the "orphan requires manual cleanup" alarm with no actual orphan. Verify Pinata's real status/body for an already-unpinned CID, then mirror the Kubo benign-error tolerance.
- **Test the Pinata compensation dispatch.** No test drives `result.backend === 'pinata'` → `unpinFromPinata`; correct-backend dispatch is the entire reason the `PinResult.backend` discriminator exists. Add a test (the fetch stub already wires both Pinata URLs) asserting a DELETE to `pinata.cloud/pinning/unpin/<cid>` and zero Kubo `pin/rm` calls when the pin originated on Pinata.
- **Test the double-failure path.** No test covers DB-insert-fails AND compensation-unpin-also-fails — the branch that logs the "orphan requires manual cleanup" alarm and still returns 500. Add a test (stub `pin/rm` to fail after the insert fails) asserting 500 `INTERNAL_ERROR`, both `logger.error` calls fire, and no unhandled rejection escapes.
- **Fix the orphan-alarm log serialization.** In the nested unpin-failure `logger.error`, `dbErr` is passed under the key `dbErr`; pino's Error serializer only fires on `err`, so it serializes as `{}`. The DB error is already captured one line up under `err`, so this is degraded correlation, not lost data. Normalize the value (`dbErr instanceof Error ? dbErr.message : String(dbErr)`) or drop the redundant key.
- **(Pre-existing, bundled while in-file) emdash in user-facing string.** The `'IPFS not configured — set IPFS_API_URL or Pinata keys'` response string uses an emdash, violating the no-emdash-in-user-facing-text rule. Replace with a period or comma. Pre-existing, not introduced by this task, but cheap to fix while the file is open.

Dismissed (no action): a `never` exhaustiveness assertion on `unpinFromIpfs` (closed two-variant union, no third backend planned); typing the test's `appPoolHandle` stub as `pg.Pool | null` (low-value test nit).

Separately filed (not held here): the duplicated `unpinFromKubo` between this file and `ipfs-cleanup.ts` is folded into a new shared-ipfs-module extraction task. The pre-existing full-HAF-`comments`-scan on the image-LIKE branch is filed as its own scoped task.
