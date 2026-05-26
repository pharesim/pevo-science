# BACKEND-IPFS-CIDISKNOWN-HAF-SCAN-SCOPE — bound the image-LIKE-over-SRF branch so it can't full-scan HAF comments

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` performance persona on commit `3d60e9ad`; pre-existing, not introduced by that commit)
**Priority:** P1 (per-request hot path) / P2 (cleanup path)

## Context

`cidIsKnown` (`backend/src/routes/ipfs.ts`, the `GET /ipfs/:cid` gateway's CID-known check) and `cidReferencedInHaf` (`backend/src/ipfs-cleanup.ts`, the cleanup job's CID-in-use check) both decide "is this CID referenced on chain" with a query of the shape:

```sql
... WHERE c.json_metadata @> $1::jsonb
       OR c.json_metadata @> $2::jsonb
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(<guarded image>) img
                  WHERE img LIKE '%' || $3 || '%')
    LIMIT 1
```

The two `@>` containment predicates are GIN-index-assisted and resolve genuine PEvO CIDs fast. But the third OR-branch uses a **leading-wildcard `LIKE`** over an unnested SRF and has **no APP_TAG / scope predicate**. When neither `@>` matches (a non-PEvO CID, a malformed CID, or a CID only referenced via an `image` URL), Postgres falls through to evaluating the SRF + substring scan across HAF's entire `comments` corpus (the full Hive post history — hundreds of millions of rows).

- `cidIsKnown`: per `GET /ipfs/:cid` request (rate-limited 60/min/IP). A flood of unknown CIDs can each trigger a full-corpus scan.
- `cidReferencedInHaf`: per row in `pending_ipfs_uploads` on each cleanup sweep. Lower frequency, but each miss can degenerate the same way.

The recent CASE-WHEN array-guard (commit `3d60e9ad`) fixed the *crash* on malformed `image`; it did not change this *scan cost*. This is pre-existing, flagged here so it isn't lost.

## Constraint

HAF indexes are fixed external infrastructure and cannot be modified (HAF is operated by Mahdi). The mitigation must be PEvO-side: narrow the query so the SRF/LIKE branch only runs against the indexable PEvO-tagged subset, or drop/anchor the branch.

## Goal

Bound the image-LIKE-over-SRF branch so a CID miss cannot trigger a full HAF `comments` scan. Candidate approaches (pick one, justify):

1. Add an index-assistable scope predicate (e.g. APP_TAG containment / a PEvO-tag `@>` check) ANDed with the SRF branch so it only scans PEvO-tagged posts.
2. Anchor the CID match so the `@>` GIN path can serve it instead of a leading-wildcard `LIKE` (e.g. match the CID as a structured value rather than a substring of an image URL), if the data shape allows.
3. If the image-URL-substring match is rarely the deciding factor, evaluate dropping the branch and relying on the `@>` checks + `pending_ipfs_uploads` + Redis fast-path that already front these calls.

Whichever is chosen, confirm against a real `EXPLAIN` on HAF that an unknown-CID lookup no longer plans a full `comments` scan.

## Acceptance

- An unknown / non-PEvO CID lookup does not plan or execute a full-table scan of HAF `comments` (verified via `EXPLAIN`).
- `GET /ipfs/:cid` still correctly returns known CIDs and 404s unknown ones; cleanup's CID-in-use decision is unchanged for real references.
- Both call sites (`cidIsKnown`, `cidReferencedInHaf`) are addressed consistently.
- A note/test documents the chosen scoping so it isn't reverted.

## Non-goals

- Modifying HAF indexes (not possible).
- Reworking the IPFS gateway cache or the cleanup sweep cadence.

## [BLOCKED by Architect] (2026-05-26, Backend) — task premise is wrong + a co-located pre-existing correctness bug needs an architect decision

While implementing, an `EXPLAIN` investigation against live HAF (`hafsql.comments`, a view over `hafsql.comments_table`; the json_metadata column is the base `metadata` column) surfaced two facts that invalidate this task's stated approach and require an architect re-scope before any code lands.

### Finding A — the two `@>` branches are NOT GIN-assisted; they already full-scan

This task asserts: *"The two `@>` containment predicates are GIN-index-assisted and resolve genuine PEvO CIDs fast."* That is false for Mahdi's HAF. `hafsql.comments_table` has **no GIN index on `metadata`**. The indexes present are: PK(`id`), unique(`author,permlink`), btree(`pending_payout_value`), **GIN(`tags`)** (a jsonb array column), btree(`parent_author,parent_permlink`), btree(`parent_permlink`), btree(`(metadata->>'content_type')`), btree(`created,author,parent_author`), btree(`author,created`), btree(`root_author,root_permlink`), btree(`root_permlink`), btree(`author,id DESC`), btree(`category,id`), partial btree(`parent_author,deleted,id` WHERE `parent_author=''`).

`EXPLAIN` of the current `cidIsKnown` query for an unknown CID plans a `Seq Scan on comments_table` (cost ~185M, est. rows 67.6M) with the three OR-branches as a row filter. The `LIMIT 1` makes the cost *estimate* look cheap because the planner mis-estimates the filter as non-selective, but for a non-matching CID it scans the whole corpus. **Bounding only the image-LIKE branch (this task's plan) does not stop the full scan — the `@>` branches cause it too.** There is no `json_metadata` index to lean on, so the task's candidate approaches 1 and 2 (an `@>`/APP_TAG containment ANDed with the branch) would themselves seq-scan.

### Finding B — pre-existing namespace bug: the `@>` predicates match no real PEvO post

Both call sites query the literal `pevo` namespace: `metadata @> '{"pevo":{"ipfs_cid":<cid>}}'` and `metadata @> '{"pevo":{"supplementary_files":[{"cid":<cid>}]}}'`. But PEvO chain metadata is namespaced under `config.appTag` (currently `pevotest`, later `pevo` or another value, per `.env`/`APP_TAG`). Verified against live HAF: **zero** posts carry a `pevo` top-level key; a real `paper` (`jesusalejos/tica-y-meta…`) stores its CID at `metadata.pevotest.ipfs_cid` (`QmQ5dov…`); and the reading path uses `meta[config.appTag]` (`helpers.ts` `safePevoMeta`, `papers.ts`). So both `@>` branches match no real PEvO paper today.

Consequence (pre-existing, not introduced by the recent IPFS commits): a published paper's CID is unrecognized by the gateway once the 24h `pending_ipfs_uploads` row + Redis key expire (`cidIsKnown` → false → 404), and the cleanup job's `cidReferencedInHaf` → false → it would **unpin a live, on-chain-referenced paper file**. Low blast radius in the current beta corpus (only one paper carries an `ipfs_cid`), but it is a real data-availability bug.

### Recommended corrected fix (for architect to approve / re-scope)

Both fixes live in the same two SQL statements:

1. **Namespace:** replace the literal `pevo` with the parameterized `config.appTag` in both `@>` branches (the value already flows in as a bind elsewhere in these files).
2. **Indexed scope:** wrap the whole predicate in `c.tags @> $N::jsonb` where `$N = JSON.stringify([config.appTag])` (the GIN-indexed `tags` jsonb-containment path). Verified all 4 real top-level PEvO papers carry the appTag in `tags` (and `category = appTag`), so scoping does not drop real references. `tags @> '["pevotest"]'::jsonb` is the only general index-assisted PEvO scope (alternatively `parent_permlink = appTag` btree for top-level papers, or `category = appTag`). `EXPLAIN` of the corrected+scoped query was not yet confirmed (the run was interrupted); the implementer must confirm it plans a tags-GIN bitmap/index scan, not a Seq Scan, per this task's acceptance.

### Decisions needed from the architect

- Whether the namespace correction (`pevo` → `config.appTag`) should be folded into this task or filed as its own correctness task — it changes gateway + cleanup behavior and is broader than scan-scoping.
- Approve the query-shape change (a `tags @> [...]` scope wrapping the predicate). It is hard-to-reverse and alters cleanup's unpin decision surface, so it wants explicit sign-off.
- Confirm it is acceptable that reviews/comments (which carry the appTag in `tags` but no `ipfs_cid`/`supplementary_files`/`image`) fall inside the indexed candidate set — harmless (they won't match the inner predicates), it only slightly widens the GIN-narrowed set.
- Update this task's "Context"/"Constraint"/"Goal" wording, which is premised on the false "GIN-index-assisted `@>`" claim.

### Coordination

The sibling `backend-ipfs-shared-module-extraction` task is independent of this one and is proceeding (it de-duplicates the unpin helpers + the image-SRF guard expression without changing the scan shape). When this task is unblocked, the rewritten query should compose the extracted `IMAGE_SRF_GUARD_EXPR` for the image branch.
