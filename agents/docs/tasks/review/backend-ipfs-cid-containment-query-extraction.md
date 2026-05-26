# BACKEND-IPFS-CID-CONTAINMENT-QUERY-EXTRACTION — de-duplicate the tags-scoped CID containment query across cidIsKnown and cidReferencedInHaf

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by the IPFS-cluster `/ce-code-review` — maintainability P2 + kieran-typescript)
**Priority:** P2

## Context

The tags-scoped CID-reference containment query is now duplicated byte-for-byte across two modules:

- `cidIsKnown` in `backend/src/routes/ipfs.ts` (the `GET /ipfs/:cid` gateway's CID-known check)
- `cidReferencedInHaf` in `backend/src/ipfs-cleanup.ts` (the cleanup job's CID-in-use check)

Both run the same shape:

```sql
SELECT 1 FROM <comments> c
 WHERE c.tags @> $1::jsonb
   AND ( c.json_metadata @> $2::jsonb
      OR c.json_metadata @> $3::jsonb
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(imageSrfGuardExpr('c')) img
                 WHERE img LIKE '%' || $4 || '%') )
 LIMIT 1
```

with identical bind order `[JSON.stringify([config.appTag]), {[appTag]:{ipfs_cid}}, {[appTag]:{supplementary_files:[{cid}]}}, cid]` and a ~9-line anti-revert comment block repeated at both sites. The image-SRF guard sub-expression was already extracted to `backend/src/lib/ipfs-shared.ts` (`imageSrfGuardExpr`) for exactly this drift reason; the surrounding containment query was not.

The cost of drift is asymmetric and severe: a wrong predicate in `cidReferencedInHaf` unpins a live on-chain-referenced file (irreversible — Kubo `pin/rm` is not refcounted); in `cidIsKnown` it serves or withholds gateway content. A namespace/shape change (new supplementary-file field, key rename) must currently be applied in two places with two comments kept in sync.

## Goal

Extract the shared containment check into `backend/src/lib/ipfs-shared.ts` so both call sites consume one definition, and collapse the two anti-revert comments into a single docblock on the extracted symbol.

1. Add a helper to `lib/ipfs-shared.ts` — either `cidReferencedByAppTag(pool, cid): Promise<boolean>` (runs the query and returns the boolean) or a `buildCidContainmentQuery(cid): { text, values }` builder if the two call sites need different surrounding logic. `cidIsKnown` keeps its pending-row short-circuit ahead of the HAF check; `cidReferencedInHaf` keeps its own role. Pick whichever boundary keeps both sites honest with the least ceremony — prefer the function that runs the query if the two sites are truly identical past the short-circuit.
2. Both `cidIsKnown` and `cidReferencedInHaf` call the shared symbol; the tags-scope + appTag-namespace + image-SRF-guard invariant is documented once on it.

## Folded-in cleanups (same file, same pass)

These two cosmetic items from the same review live in `lib/ipfs-shared.ts`; clean them up in this pass rather than as standalone tasks:

- **Type predicate for `toPinBackend`.** Replace `(PIN_BACKENDS as readonly string[]).includes(value)` + `return value as PinBackend` with a `function isPinBackend(v: string): v is PinBackend` predicate so the narrowing is mechanical and the inner assertion cast disappears (`if (isPinBackend(value)) return value;`). Behavior is already correct; this removes an unchecked `as` that survives even if the guard were deleted.
- **De-duplicate the error string.** `Unrecognized pin backend: ${JSON.stringify(...)}` is repeated verbatim in `toPinBackend` and the `unpinFromIpfs` switch default. Hoist to one shared message constant/helper.

## Acceptance

- The containment query + its anti-revert rationale exist in exactly one place; `cidIsKnown` and `cidReferencedInHaf` both consume it.
- No behavioral change: known CIDs still resolve, unknown CIDs still 404, the cleanup unpin decision is unchanged for real references, and the tags-GIN index plan is preserved (the extraction must not inline the query in a way that defeats the indexed scope).
- `toPinBackend` narrows via a type predicate with no inner assertion cast; the unrecognized-backend message has one source.
- Existing IPFS tests stay green; `typecheck:src` + lint clean.

## Non-goals

- Changing the query semantics, the tags-GIN scope, or the appTag namespace (those are settled by the predecessor work — see the archived cidisknown-haf-scan-scope entry in `tasks-archive.md`).
- Reworking the gateway cache, the cleanup sweep cadence, or the pending-row short-circuit.

## References

- `backend/src/routes/ipfs.ts` (`cidIsKnown`)
- `backend/src/ipfs-cleanup.ts` (`cidReferencedInHaf`)
- `backend/src/lib/ipfs-shared.ts` (`imageSrfGuardExpr`, `toPinBackend`, `unpinFromIpfs`, `PinBackend`)
