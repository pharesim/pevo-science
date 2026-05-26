# BACKEND-IPFS-CLEANUP-BACKEND-DISPATCH — record pin backend so cleanup can unpin Pinata-origin pins

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by combined IPFS-cluster `/ce-code-review` — reliability P1 conf 100, corroborated by adversarial + maintainability)
**Priority:** P1

## Context

The orphan-cleanup job in `backend/src/ipfs-cleanup.ts` (`runCleanup`) unconditionally calls `unpinFromKubo(row.cid)` on the unpin branch, then deletes the `pending_ipfs_uploads` row. But a pin can land on **Pinata** rather than Kubo: `pinToIpfs` falls back to Pinata when the local Kubo node is unavailable, and `result.backend` records which one. The upload-handler compensation path already dispatches correctly via `unpinFromIpfs(result.cid, result.backend)`. The cleanup job cannot, because `pending_ipfs_uploads` stores no backend discriminator.

The failure mode: a Pinata-origin pin reaches cleanup → `unpinFromKubo` fires `pin/rm` at the local Kubo node → Kubo returns a benign "not pinned" (swallowed) → the tracking row is deleted. The pin stays live on Pinata forever, and the only record of it is gone. This is the inverse of the orphan class `backend-ipfs-pin-inside-db-transaction` closed on the upload path: there the row could outlive a missing pin; here the pin outlives a deleted row, undetectably.

This also undercuts the over-unpin guard's in-code reassurance on the upload path ("the cleanup job can still reap a genuinely-unreferenced pin later") — that backstop only holds for Kubo-backed pins.

The shared-module extraction (`backend/src/lib/ipfs-shared.ts`) already exports `unpinFromIpfs(cid, backend)`; the cleanup job currently imports only `unpinFromKubo`. So the dispatch helper exists — it just needs the discriminator to route on.

Pre-existing behavior (the cleanup job always hardcoded Kubo); surfaced now because the per-backend dispatch helper landed in the shared lib while cleanup stayed Kubo-only. Orthogonal to the pin-durability and extraction holds — do not fold it into either.

## Goal

Persist the originating backend per pending upload and route the cleanup unpin through it.

1. **Migration:** add a `pin_backend` column to `pending_ipfs_uploads` (TEXT, `NOT NULL DEFAULT 'kubo'`). The default backfills existing rows safely — they predate Pinata fallback in practice, and Kubo is the primary backend. Migrations are the sole schema authority (no `initAppDb` drift) per `backend-initappdb-schema-drift-fix`.
2. **Record at insert:** the `POST /api/ipfs/upload` handler writes `result.backend` into the new column on the `pending_ipfs_uploads` INSERT.
3. **Dispatch at cleanup:** `runCleanup`'s unpin branch calls `unpinFromIpfs(row.cid, row.pin_backend as PinBackend)` (the already-exported shared helper) instead of `unpinFromKubo(row.cid)`. Select `pin_backend` in the cleanup query.

## Acceptance

- New migration adds `pin_backend` (TEXT NOT NULL DEFAULT 'kubo'); applies cleanly forward; existing rows default to `'kubo'`.
- The upload-handler INSERT records `result.backend`.
- `runCleanup` reads `pin_backend` and dispatches via `unpinFromIpfs`; no remaining hardcoded `unpinFromKubo` on the cleanup unpin branch.
- A test exercises the cleanup unpin path with `pin_backend = 'pinata'` and asserts a Pinata unpin (DELETE to the Pinata unpin URL) with zero Kubo `pin/rm` calls; the `pin_backend = 'kubo'` path still hits Kubo. (Mock the IPFS client per the existing IPFS-test carve-out; document the clause in the test header.)
- Existing IPFS tests (pin-durability, srf-guard, cleanup) stay green.
- `typecheck:src` + lint clean.

## Non-goals

- Reworking the cleanup scan logic, the gateway cache, or the `cidReferencedInHaf` HAF-scan scope (that is the separate blocked `backend-ipfs-cidisknown-haf-scan-scope` task).
- Refcounting pins or two-phase commit.

## References

- `backend/src/ipfs-cleanup.ts` (`runCleanup`, the hardcoded `unpinFromKubo` unpin branch).
- `backend/src/routes/ipfs.ts` (`POST /api/ipfs/upload` handler, the `pending_ipfs_uploads` INSERT and `result.backend`).
- `backend/src/lib/ipfs-shared.ts` (`unpinFromIpfs`, `PinBackend`).
- `backend/migrations/` — `003_pending_ipfs_uploads.sql` defines the current table; add a new numbered migration.
