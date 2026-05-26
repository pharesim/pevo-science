# BACKEND-IPFS-CIDISKNOWN-HAF-SCAN-SCOPE — fix the `pevo`→`config.appTag` namespace bug and bound the CID-reference query to the tags-GIN PEvO subset

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` performance persona on commit `3d60e9ad`; pre-existing, not introduced by that commit)
**Unblocked:** 2026-05-26 (architect + user — approach decided, see Architect resolution below)
**Priority:** P1 (per-request hot path + live data-availability bug) / P2 (cleanup path)

## Context

`cidIsKnown` (`backend/src/routes/ipfs.ts`, the `GET /ipfs/:cid` gateway's CID-known check) and `cidReferencedInHaf` (`backend/src/ipfs-cleanup.ts`, the cleanup job's CID-in-use check) both decide "is this CID referenced on chain" with a query of the shape:

```sql
... WHERE c.json_metadata @> $1::jsonb
       OR c.json_metadata @> $2::jsonb
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(<guarded image>) img
                  WHERE img LIKE '%' || $3 || '%')
    LIMIT 1
```

(`T.comments` = `hafsql.comments`, a view over `hafsql.comments_table`; the `json_metadata` column is the base `metadata` column.)

Two problems, both living in the same two SQL statements:

### Problem 1 — no index serves this query; it full-scans HAF `comments`

`hafsql.comments_table` has **no GIN index on `metadata`**. The only jsonb-containment GIN index is on the `tags` column. An unknown-CID lookup therefore plans a `Seq Scan on comments_table` (cost ~185M, est. ~67.6M rows) with all three OR-branches as a row filter. The `LIMIT 1` makes the planner's cost *estimate* look cheap (it mis-estimates the filter as non-selective), but for a non-matching CID it scans the whole corpus. Both `@>` branches and the image-LIKE branch ride that scan — bounding only the image branch (this task's original plan) would not have stopped it.

- `cidIsKnown`: per `GET /ipfs/:cid` request (rate-limited 60/min/IP). A flood of unknown CIDs can each trigger a full-corpus scan.
- `cidReferencedInHaf`: per row in `pending_ipfs_uploads` on each cleanup sweep — lower frequency, same degeneration per miss.

### Problem 2 — namespace bug: the `@>` predicates match no real PEvO post

Both call sites bind the literal `pevo` namespace (`{"pevo":{"ipfs_cid":<cid>}}` and `{"pevo":{"supplementary_files":[{"cid":<cid>}]}}`). But PEvO chain metadata is namespaced under `config.appTag` (`pevotest` in beta). Verified against live HAF: **zero** posts carry a `pevo` top-level key; a real paper stores its CID at `metadata.pevotest.ipfs_cid`; and every read/write path uses `meta[config.appTag]` (`helpers.ts`, `papers.ts`, `bridge.ts`, etc.). So both `@>` branches match no real PEvO paper today.

Consequence (pre-existing, not introduced by the recent IPFS commits): a published paper's CID 404s at the gateway once its 24h `pending_ipfs_uploads` row + Redis key expire (`cidIsKnown` → false), and the cleanup job's `cidReferencedInHaf` → false would **unpin a live, on-chain-referenced paper file**. Low blast radius in the current beta corpus (only one paper carries an `ipfs_cid`), but it is a real data-availability bug.

The CASE-WHEN array-guard (commit `3d60e9ad`) fixed the image-field *crash*; it did not touch either problem above.

## Constraint

HAF indexes are fixed external infrastructure and cannot be modified (operated by Mahdi). The only general index-assisted PEvO scope on this HAF is `c.tags @> '["<appTag>"]'::jsonb` (the GIN-indexed `tags` jsonb-containment path). All CID-carrying PEvO content is appTag-tagged: papers broadcast `tags: [APP_TAG, 'science', …]`, reviews `[APP_TAG, 'review']`, and `ipfs_cid`/`supplementary_files` are paper-only. So scoping to `tags @> [appTag]` drops no real reference.

## Goal (approach decided 2026-05-26)

Rewrite both statements to do both fixes together (they are physically co-located; scoping a never-matching `@>` predicate would be pointless without the namespace fix):

1. **Namespace:** replace the literal `pevo` with the parameterized `config.appTag` in both `@>` branches (the value already flows in as a bind in these files).
2. **Indexed scope:** wrap the whole predicate in `c.tags @> $N::jsonb` where `$N = JSON.stringify([config.appTag])`, converting the seq-scan into a tags-GIN bitmap/index scan and bounding the image-LIKE branch to the PEvO subset.

Compose the image branch from the extracted `IMAGE_SRF_GUARD_EXPR` once `backend-ipfs-shared-module-extraction` lands (coordinate; do not block on it).

## Acceptance

- An unknown / non-PEvO CID lookup plans a tags-GIN index/bitmap scan, **not** a full `comments` seq-scan (verified via `EXPLAIN` on live HAF).
- A known, published paper's CID (the live `metadata.<appTag>.ipfs_cid`) returns `true` from `cidIsKnown` — the namespace fix is exercised against the real published shape by a test, not merely asserted.
- `GET /ipfs/:cid` returns known CIDs and 404s unknown ones; cleanup's CID-in-use decision is unchanged for real references (a referenced CID is NOT unpinned).
- Both call sites (`cidIsKnown`, `cidReferencedInHaf`) are fixed consistently.
- A note/test documents the appTag-scope so it isn't reverted.

## Non-goals

- Modifying HAF indexes (not possible).
- Reworking the IPFS gateway cache or the cleanup sweep cadence.
- The beta→prod appTag migration (papers published under `pevotest` stop matching once `APP_TAG` flips to its production value). That is a separate corpus-migration concern; this task tracks `config.appTag` at runtime, which is the correct behavior for any single appTag value.

## Architect resolution (2026-05-26)

Unblocked after architect + user review of the implementer's EXPLAIN investigation. Decisions:

- **Fold** the namespace fix into this task (not a separate task). Both fixes are physically co-located in the same two statements, and scan-scoping is meaningless without the namespace correction. One focused diff, two clearly-labeled changes, pinned by a known-CID-returns-`true` test.
- **Approved** the `tags @> '["<appTag>"]'::jsonb` scoped query shape. Verified safe: all CID-carrying PEvO content carries appTag in `tags`, so the scope drops no real reference, and it is strictly safer than a `parent_permlink = appTag` btree scope (which would miss review/comment images). Reviews/comments fall inside the candidate set — harmless, they won't match the inner CID predicates; for an unpin decision, over-inclusive (keep pinned) beats under-inclusive (delete live).
- Context/Constraint/Goal rewritten above to drop the original false "GIN-index-assisted `@>`" premise.

### Evidence (implementer EXPLAIN investigation, live HAF)

`hafsql.comments_table` indexes present: PK(`id`), unique(`author,permlink`), btree(`pending_payout_value`), **GIN(`tags`)**, btree(`parent_author,parent_permlink`), btree(`parent_permlink`), btree(`(metadata->>'content_type')`), btree(`created,author,parent_author`), btree(`author,created`), btree(`root_author,root_permlink`), btree(`root_permlink`), btree(`author,id DESC`), btree(`category,id`), partial btree(`parent_author,deleted,id` WHERE `parent_author=''`). No GIN on `metadata`. The implementer must re-run `EXPLAIN` on the corrected+scoped query to confirm the tags-GIN plan (the original run was interrupted before the scoped variant was confirmed).

### Coordination

The sibling `backend-ipfs-shared-module-extraction` task is independent and proceeding (it de-duplicates the unpin helpers + the image-SRF guard expression without changing the scan shape). When this task lands, the rewritten query should compose the extracted `IMAGE_SRF_GUARD_EXPR` for the image branch.

## Backend completion signal (2026-05-26)

Both fixes landed in both call sites. The sibling shared-module extraction had already merged when this landed, so the image branch composes the extracted `imageSrfGuardExpr('c')` helper rather than an inline guard.

- **Namespace.** `cidIsKnown` (`routes/ipfs.ts`) and `cidReferencedInHaf` (`ipfs-cleanup.ts`) now bind `{ [config.appTag]: { ipfs_cid } }` and `{ [config.appTag]: { supplementary_files: [{ cid }] } }` in the two `@>` branches, replacing the literal `pevo` key.
- **Indexed scope.** Both predicates are now `c.tags @> $1::jsonb AND ( <ipfs_cid containment> OR <supplementary_files containment> OR <image-LIKE EXISTS> )`, with `$1 = JSON.stringify([config.appTag])`. The OR-group is parenthesized so the tags scope ANDs across all three branches (AND binds tighter than OR; without the parens the scope would attach to only the first containment branch). Bind order is now [tags-scope, ipfs_cid, supplementary_files, cid-for-LIKE].
- **Anti-revert note.** A comment at each site documents that both the tags scope and the appTag namespace are load-bearing and must not be reverted.

**EXPLAIN (live HAF, unknown CID).** The corrected query plans `Bitmap Heap Scan on comments_table` driven by `Bitmap Index Scan on hafsql_comments_table_tags_idx` (`Index Cond: tags @> '["pevotest"]'`), with the `@>` containment + image-LIKE as a Recheck/Filter on the tags-scoped subset (~2905 est. rows) — not the prior full seq-scan over ~67.6M rows.

**Test.** `tests/routes/ipfs.test.ts` adds a real-HAF GET spec (real `getPool()`, no mocked db): it locates a published paper carrying a non-empty `metadata.<appTag>.ipfs_cid` via the same tags-GIN-scoped query, then asserts `GET /api/ipfs/:cid` is not 404. Live run found `QmQ5dov…` and the route reached the gateway (502, not 404), proving `cidIsKnown` resolved the on-chain reference under the namespaced+scoped query (a literal-`pevo` regression would 404).

**Verification.** `npm run typecheck` clean (src + tests); `npm run lint` clean on touched files; targeted `npx vitest run tests/routes/ipfs.test.ts` green against real Postgres/Redis/HAF. No api-contract or ARCHITECTURE change needed (query-internals fix; no API shape, route, or status-code contract change).
