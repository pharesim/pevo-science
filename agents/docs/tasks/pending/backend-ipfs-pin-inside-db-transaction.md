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
