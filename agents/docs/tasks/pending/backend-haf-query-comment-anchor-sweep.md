# BACKEND-HAF-QUERY-COMMENT-ANCHOR-SWEEP — stale comment anchors: round-N citations, orphaned task slugs, drifted line numbers in production source

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #36 low severity, simplification)
**Priority:** P3 (violates documented Comment Anchors convention)

## Problem

Multiple files cite orphaned task slugs (BACKEND-REPUTATION-SSOT, BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS, BACKEND-SELF-REVIEW-EXCLUSION) not present in `tasks/` or `tasks-archive.md`, round numbers ('round-1 hold #6/#14/#27', 'round-2 hold #7'), and drifted line-number cross-references (e.g. `reputation.ts:694-695` cites "lines 555-560" which are actually elsewhere; line 933 cites "743" which is wrong).

Directly violates the documented [Comment Anchors](CLAUDE.md) convention.

`notification-queries.ts` also has the citation-array SRF guard duplicated verbatim across arms 6a/6b with identical preceding comment blocks.

## Affected files

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 22-50, 118-148, 335-359, 626-684, 748-771, 851-862, 928-934.
- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 33-37, 46-58, 60-64, 109-114, 180-191, 282-291, 302-321, 440-460.
- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 156-216, 350-355, 386-391.

## Goal

Replace stale anchors with symbol names; preserve the load-bearing behavioral docblocks (they ARE the durable WHY).

### Suggested approach

- Stale line-number refs → symbol names (`paper_resolved_votes`, `paper_scores`, `citing_paper_quality.weighted_upvotes`).
- Strip round-N + orphan-slug citations but preserve surrounding WHY prose.
- Leave the long behavioral docblocks intact (defense-in-depth co-author exclusion, etc.).
- For `notification-queries.ts`' citation-guard duplication, extract `citationsArrayGuardSql(citingAlias, appTagParam)` mirroring the existing `imageSrfGuardExpr` precedent.

## Acceptance

- No production source under `backend/src/` cites a task slug not present in `tasks/` or `tasks-archive.md`.
- No production source cites a `round-N hold #X` reference.
- No production source cites a line-number cross-reference (those drift; symbol names are stable).
- Behavioral docblocks (defense-in-depth, co-author exclusion, etc.) remain in place — only the coordination-state anchors are stripped.
- `notification-queries.ts` citation guard extracted to a helper.
- Grep canary: no `round-\d+ hold` or `^BACKEND-` slug refs in `backend/src/`.
- Comment anchors clean (the fix itself must not introduce new rot per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`).
- `npm run typecheck` + `npm run lint` clean.

## Notes

- The fix is paperwork-heavy. Land it as one focused commit after the substantive fixes (#1-#10) — those will reshape some of the cited lines anyway.
- Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, audit the replacement text for any new rot class (do NOT substitute slugs for SHAs or vice versa).

## Cross-references

- [CLAUDE.md](CLAUDE.md) "Comment anchors" section.
- [agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md](agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md).
- [agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md](agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md).
- [agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md](agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md).
- HAF-query review run `w274tijk0` rank #36.
