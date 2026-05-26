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

## Backend completion signal (2026-05-26)

Persisted the originating pin backend per pending upload and routed the cleanup unpin through it.

- **Migration 014** (`014_pending_ipfs_uploads_pin_backend.sql`): `ALTER TABLE pending_ipfs_uploads ADD COLUMN IF NOT EXISTS pin_backend TEXT NOT NULL DEFAULT 'kubo'` plus the `schema_migrations` tracking INSERT (per migration 008's `verifyAppDbMigrations` boot contract). The default backfills existing rows to `'kubo'`; applied forward to the dev app DB.
- **Upload INSERT records the backend.** `POST /api/ipfs/upload` writes `result.backend` into the new `pin_backend` column (4th param on the `pending_ipfs_uploads` INSERT).
- **Cleanup dispatches per-backend.** `runCleanup` now selects `pin_backend` and replaces the hardcoded `unpinFromKubo(row.cid)` with `unpinFromIpfs(row.cid, row.pin_backend as PinBackend)` (the shared dispatcher). The import switched from `unpinFromKubo` to `{ type PinBackend, unpinFromIpfs }`; the header docblock and the unpinned-orphan log line now reflect per-backend routing. `runCleanup` is exported for the dispatch test.
- **Test** `tests/ipfs-cleanup-backend-dispatch.test.ts`: drives the real `runCleanup` with a seeded `pin_backend='pinata'` orphan and asserts a DELETE to `pinata.cloud/pinning/unpin/<cid>` with zero Kubo `pin/rm`; the `pin_backend='kubo'` path hits Kubo `pin/rm` (POST, against the configured node URL) with zero Pinata. Carve-out (a/b/c) documented in the test header: the app pool, HAF reference-check (a full-corpus `comments` scan that trips `statement_timeout` for a synthetic CID), and the IPFS client are mocked for determinism + non-destructiveness; the per-backend-dispatch risk class is shared with the real-path Pinata compensation-dispatch test (upload route) and the `unpinFromPinata` benign-absence unit.

No API contract change: the upload response envelope is unchanged and `pin_backend` is internal tracking state, so no `api-contracts/*.md` edit is required.

**Verification.** `npm run typecheck` clean (src + tests); `eslint` clean on `routes/ipfs.ts`, `ipfs-cleanup.ts`, and the new test; scoped `npx vitest run tests/ipfs-cleanup-backend-dispatch.test.ts` → 2/2 green, and the broader IPFS cluster (srf-guard, pin-durability, unpin unit) stays green. Self-audit on changed lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in the source/test files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect review (2026-05-26, combined IPFS-cluster pass) — HELD PENDING FIXES (1 item):

First review via the combined IPFS-cluster `/ce-code-review` over a path-restricted union diff of the three not-yet-reviewed cluster commits (per `agents/docs/solutions/conventions/re-review-cluster-path-restricted-union-diff-not-per-commit-2026-05-26.md`); 11 personas, `ce-agent-native-reviewer` skipped per PEvO. **The task's stated goal is met and the mechanics are clean:** migration 014 is idempotent and safe (`ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT 'kubo'` is a Postgres fast-default metadata-only op, no rewrite; the `schema_migrations` self-record satisfies the `verifyAppDbMigrations` boot contract; `014_` numbering is sequential); the upload INSERT records `result.backend`; `runCleanup` selects `pin_backend` and dispatches via `unpinFromIpfs`; the per-backend dispatch test genuinely proves the routing (a hardcoded-Kubo regression reds the `pin_backend='pinata'` case) and its carve-out clauses (a)/(b)/(c) are documented. One item before archive:

- **The `pin_backend` domain is unenforced end-to-end, so an out-of-contract value silently inverts the very leak this task fixes.** The column is free-text `TEXT` with no `CHECK`; the cleanup site reads it as `row.pin_backend as PinBackend` (an unchecked assertion cast on a `string`); and `unpinFromIpfs` dispatches `if (backend === 'kubo') … ; return unpinFromPinata(cid)` — a non-exhaustive else, so **any** value other than the literal `'kubo'` routes to Pinata. A row whose `pin_backend` is neither `'kubo'` nor `'pinata'` (a future third backend written before the union widens, a manual/operator row, a migration oversight) would fire a Pinata DELETE for a CID Pinata never held, swallow the benign "not pinned", and then DELETE the tracking row — leaving the real Kubo pin live and unrecorded forever. That is the exact inverse of the orphan class this task closes. Not reachable from today's diff (the sole writer is type-constrained to `'kubo'|'pinata'` literals and the default is `'kubo'`), which is why this is a moderate defense-in-depth item rather than a live P0 — but six independent personas converged on it (correctness, adversarial, reliability, maintainability×2, kieran-typescript, data-migrations), it is a documented anti-pattern (`agents/docs/solutions/conventions/req-query-as-string-cast-silent-coerce-2026-05-16.md` — "`as TypeName` casts lie about runtime values"), and PEvO already has the in-repo precedent for the fix: migration `010_bridge_import_queue.sql` `CHECK`-constrains its `state` discriminator. Close the gap at the layer(s) you judge cleanest; any one defends, but the DB constraint plus a loud runtime narrowing is the on-precedent shape:
  - **(DB, strongest single defense)** add `CHECK (pin_backend IN ('kubo','pinata'))` to migration 014 so an out-of-domain value fails loudly at write time. (Edit the existing migration file — it has not shipped to production yet — rather than adding a new one, unless you prefer a follow-on migration.)
  - **(code)** replace the bare cast with a validated narrowing before dispatch (e.g. a `toPinBackend(s: string): PinBackend` that throws on anything outside the union). The throw is caught by `runCleanup`'s existing per-row `try/catch`, which logs and skips the DELETE — leaving the row for the operator instead of silently misrouting and reaping it. Equivalently, make `unpinFromIpfs` exhaustive (explicit `'pinata'` branch + `throw` on the unreachable else).
  - **(test)** add a case driving `runCleanup` (or `unpinFromIpfs`) with an unrecognized `pin_backend` value, asserting it does NOT issue any unpin fetch and does NOT delete the tracking row — so a regression back to the silent-fallthrough shape reds.

Dismissed / not held (recorded for the implementer, no action required): (1) the `unpinFromPinata` content-based (not status-gated) "not pinned" match — already triaged and accepted in `backend-ipfs-pin-inside-db-transaction`'s prior hold (the live already-unpinned Pinata body is undocumented, so current behavior was deliberately pinned with a test rather than over-fit to a verbatim string); (2) the `DEFAULT 'kubo'` backfill resting on operator knowledge — time-bounded and self-healing because pending rows age out at 24h, and the migration comment acknowledges it; (3) a docblock naming sibling-file functions as alias anchors — valid stable-symbol anchors today, below the confidence gate.

When the domain-enforcement item lands, `git mv` this file back to `tasks/review/`.
