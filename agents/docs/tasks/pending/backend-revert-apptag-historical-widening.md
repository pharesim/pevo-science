# BACKEND-REVERT-APPTAG-HISTORICAL-WIDENING — revert the APP_TAGS_HISTORICAL cleanup-reference widening, keep the extraction

**Owner:** backend
**Created:** 2026-05-27 (architect, from `/ce-code-review` triage of the IPFS CID-containment review group)
**Priority:** P2

## Context

The `APP_TAGS_HISTORICAL` widening was built to keep old-tag (`pevotest`) IPFS files pinned after an `APP_TAG` flip, by OR-widening the shared CID-reference containment check over `[appTag, ...config.appTagsHistorical]`. A product decision during review rejects that premise: **old-tag content need not be served or retained by the production app after a flip** (an old-tag corpus may live on a separate instance instead — undecided). With that, unpinning old-tag files post-flip is acceptable, and the widening defends a non-problem on both the gateway (`cidIsKnown`) and cleanup (`cidReferencedInHaf`) paths.

The predecessor extraction (the shared `cidReferencedByAppTag` helper de-duplicating the containment query across both consumers) is unaffected and stays — it is pure de-duplication and correct regardless of the tag decision.

The widening landed in commit `28de10f8` (`backend(ipfs): widen cleanup CID-reference check over historical appTags`); the extraction it sits on top of is the immediately-preceding `b88a261a` (`backend(ipfs): extract tags-scoped CID-containment query into lib/ipfs-shared`).

## Goal

Remove the widening, restoring `cidReferencedByAppTag` to its single-tag form, while keeping the extraction. Re-addable later if the serve-old-tags decision calls for a transition mechanism — re-scope then rather than restoring this verbatim.

1. Remove `config.appTagsHistorical` and its `APP_TAGS_HISTORICAL` env read from `backend/src/config.ts`.
2. Restore `cidReferencedByAppTag` (`backend/src/lib/ipfs-shared.ts`) to scope the containment check to the single `config.appTag`: one `c.tags @> $N` tags-scope containment, one `ipfs_cid` namespace containment, one `supplementary_files` namespace containment, plus the image-SRF guard — the pre-widening shape. Keep the extraction: both `cidIsKnown` and `cidReferencedInHaf` continue to delegate to the helper.
3. Remove the widening-specific test `backend/tests/lib/ipfs-shared-cid-containment.test.ts`. If a single-tag SQL-shape test for the extracted helper is worth keeping, retain a reduced single-tag version (your call); do not keep historical-tag assertions.
4. `git revert 28de10f8` is acceptable IF it produces exactly the above with the extraction intact; otherwise apply surgically. Confirm `typecheck:src` + lint clean and existing IPFS tests green.

## Coordination

- Do NOT revert the extraction commit `b88a261a` — it is a separate, kept change.
- The extraction task (`backend-ipfs-cid-containment-query-extraction`) is in its own review/hold cycle for unrelated docblock / export / null-rowCount fixes in the same `ipfs-shared.ts`. Sequence your commits so the two do not collide on that file; landing the extraction-task hold fixes first is fine.
- The `.env.example` / `ARCHITECTURE.md` drain-runbook `[TODO Architect]` items are dropped (not written) — the widening they would document is going away.

## Non-goals

- Designing the old-tag retention / separate-instance approach — that is the blocked product decision; see the parked `backend-ipfs-apptag-flip-pending-upload-drain` task in `tasks/blocked/`.
- Touching the extraction boundary, the gateway cache, or the cleanup sweep cadence.

## References

- `backend/src/config.ts` (`appTagsHistorical` — remove)
- `backend/src/lib/ipfs-shared.ts` (`cidReferencedByAppTag` — restore single-tag form)
- `backend/tests/lib/ipfs-shared-cid-containment.test.ts` (remove or reduce to single-tag)
