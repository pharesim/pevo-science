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
