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

## Architect re-review (2026-05-27) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on the extraction diff (the commit that introduced `cidReferencedByAppTag`). The extraction itself is sound — correctness/security/performance came back clean, the forward call-site audit confirms `cidIsKnown` and `cidReferencedInHaf` are the only two consumers and both delegate to the shared helper, and the documented CROSS-JOIN-LATERAL SRF-guard pattern is preserved. Three items hold the archive, all in `backend/src/lib/ipfs-shared.ts`:

1. **Stale `imageSrfGuardExpr` docblock.** The docblock states the guard is interpolated into `cidIsKnown` (`routes/ipfs.ts`) and `cidReferencedInHaf` (`ipfs-cleanup.ts`). After this extraction neither contains an SRF call — both delegate to `cidReferencedByAppTag`, which is now the sole interpolation site. Repoint the docblock at `cidReferencedByAppTag` (same file). Anchor on the symbol, not a line number. (maintainability, confidence 100.)

2. **Drop the `export` on `unrecognizedPinBackendMessage`.** Both consumers (`toPinBackend` and the `unpinFromIpfs` switch default) live in `ipfs-shared.ts`; no other module imports it. The `export` signals a false public-API obligation on the exact string format. Make it module-local. (maintainability.)

3. **Throw on null `rowCount` in `cidReferencedByAppTag` (irreversible-path guard).** The final return coerces a null `rowCount` to `false` = "not referenced", which on the cleanup path routes to `unpinFromIpfs` + DELETE (irreversible; Kubo `pin/rm` is not refcounted). This is pre-existing (the same coercion predated the extraction) and practically unreachable for a `SELECT 1 … LIMIT 1` under node-pg, so it is NOT a regression this task caused — but the cost asymmetry on the most dangerous line in the IPFS subsystem justifies the one-line guard while the file is open: `throw` on null `rowCount` so `runCleanup`'s per-row try/catch skips the row and keeps it pinned (uncertainty biases to keep-pinned). Add a unit case asserting the null-`rowCount` path does NOT yield an unpin on the cleanup side.

When all three land, `git mv` this file back to `tasks/review/` — the move is the re-review signal. Do not edit this hold block; the commit diff is the evidence.

## Backend re-review signal (2026-05-27, working tree)

All three round-1 items landed in `backend/src/lib/ipfs-shared.ts`:

1. `imageSrfGuardExpr` docblock repointed at `cidReferencedByAppTag` as the sole production interpolation site (symbol-anchored, no line number); the "imported by the SRF guard test" clause stays accurate (`tests/lib/ipfs-image-srf-guard.test.ts` still imports it).
2. `unrecognizedPinBackendMessage` is now module-local (no `export`); verified no external importer.
3. `cidReferencedByAppTag` throws on null `rowCount` instead of coercing to `false`. Verified both downstream paths are safe under the throw: `runCleanup`'s per-row try/catch logs+skips and keeps the row pinned (`ipfs-cleanup.ts`), and the gateway route's catch turns it into a transient 502 (`routes/ipfs.ts`, no wrong content served).

Test coverage: the helper-level null-`rowCount` test in `tests/lib/ipfs-shared-cid-containment.test.ts` flipped from resolves-false to rejects-throw; a new cleanup-side case in `tests/ipfs-cleanup-backend-dispatch.test.ts` asserts a null reference-check result yields no unpin fetch and no row DELETE (the HAF `getPool` mock is now per-test controllable via `hafRefRowCount`). Targeted IPFS suite green (15 tests), `typecheck` + `lint` clean.

## Architect re-review (2026-05-28) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on the round-1 hold-fix diff (9-persona fan-out). Round-1 items 2 (de-export `unrecognizedPinBackendMessage`) and 3 (null-`rowCount` throw + the cleanup-side no-unpin/no-DELETE test) are confirmed FIXED and clean: both downstream throw paths were traced (the cleanup per-row catch fires before both DELETEs, keeping the pin AND the tracking row; the gateway yields a transient 502, never wrong content), no module imports the de-exported message, and the new cleanup-side test is a genuine mutation detector (the `rowCount=0` control routes to unpin, `null` does not). The revert-widening task was reviewed in the same pass and archived clean.

One item holds the archive — round-1 item 1 (docblock repoint) landed incompletely:

1. **`imageSrfGuardExpr` docblock still names the de-duplicated call sites.** Item 1 repointed the "Interpolated into …" sentence at `cidReferencedByAppTag` (correct), but the same docblock's earlier alias-rationale parenthetical still reads "the comment relation at the call site (`cidIsKnown` and `cidReferencedInHaf` both alias `comments` as `c`)." After the extraction, neither of those functions interpolates `imageSrfGuardExpr` — the sole call site is `cidReferencedByAppTag`. The two statements now contradict each other inside one docblock (upper: two callers; lower: "sole … site … de-duplicated out of `cidIsKnown` and `cidReferencedInHaf`"). Repoint the alias parenthetical at `cidReferencedByAppTag` (which aliases `comments` as `c` in the containment scan) so the example names the actual call site. Anchor on the symbol, not a line number, and confirm the replacement introduces no new anchor rot. (maintainability; cross-reviewed across both review passes, confidence 100.) Note: this is the `imageSrfGuardExpr` docblock, distinct from the `cidReferencedByAppTag` invariants docblock — do not edit the latter.

When item 1 lands, `git mv` this file back to `tasks/review/` — the move is the re-review signal. Do not edit this hold block; the commit diff is the evidence.

## Backend re-review signal (2026-05-28, working tree)

Round-2 hold item 1 landed. The `imageSrfGuardExpr` docblock's alias-rationale parenthetical now reads "(`cidReferencedByAppTag` aliases `comments` as `c` in its containment scan)" — repointed from the de-duplicated `cidIsKnown` / `cidReferencedInHaf` call sites to the actual sole interpolation site, so it no longer contradicts the docblock's lower "Interpolated into the shared `cidReferencedByAppTag` … sole production interpolation site" statement. Symbol-anchored; no line-number / slug / SHA / round-N anchor introduced. The separate `cidReferencedByAppTag` invariants docblock was left untouched.

Comment-only change. Verification: ipfs suites green (`ipfs-image-srf-guard`, `ipfs-shared-cid-containment`, `ipfs-cleanup-backend-dispatch`); `npm run typecheck` + `npm run lint` clean.
