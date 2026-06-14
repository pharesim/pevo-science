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

## [BLOCKED by Backend] (2026-06-02)

Premature. This task's own Notes say to land it "as one focused commit after the
substantive fixes (#1-#10) ... those will reshape some of the cited lines anyway."
That is a WAIT condition, and it is not yet met. The substantive HAF-query review
findings map to a batch of `backend-reputation-*` and `backend-notifications-*`
tasks still sitting in `pending/`, several being edited by concurrent backend
sessions right now (`backend/src/reputation.ts` is modified in the working tree at
the time of this move).

Concrete conflict surface:

- The three target files (`reputation.ts`, `reputation-batch.ts`,
  `notification-queries.ts`) are all touched by still-pending substantive tasks
  (e.g. `backend-reputation-claims-cte-dedup` extracts ~100 lines and will
  massively reshape `reputation.ts` line context; `backend-reputation-decay-
  multiplier-helper` reshapes the exact `citation_scores`/`review_scores` region
  the drifted anchors sit in).
- `backend-notifications-citation-arms-paper-exists-gate` and
  `backend-notifications-edit-revote-dedup` restructure the exact arms 6a/6b whose
  citation-array SRF guard this task wants to extract into `citationsArrayGuardSql`
  — head-on conflict, not adjacent.
- The line-number cross-references this task cites have ALREADY drifted vs current
  code (verified), which is itself proof the churn is ongoing.
- A sibling commit shows the architect is sequencing per-arm comment-anchor cleanup
  INTO the substantive notification tasks themselves, so part of this task's
  notification-queries.ts scope may be absorbed before it ever runs.

**Unblock condition.** The substantive `backend-reputation-*` and
`backend-notifications-*` tasks that touch these three files archive. At that point
the implementer must RE-ENUMERATE the live stale anchors (the snapshot in this file
will have drifted, and some anchors may already be cleaned by the per-arm work)
rather than trusting the line/anchor list above, then sweep whatever remains in one
focused commit and extract `citationsArrayGuardSql`. Whoever lands the last of
those substantive tasks (or the architect, noticing the batch has cleared) moves
this file back to `pending/`.

Verified-and-still-true facts for the eventual implementer: the three cited slugs
(BACKEND-REPUTATION-SSOT, BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS,
BACKEND-SELF-REVIEW-EXCLUSION) are genuinely absent from `tasks/` and
`tasks-archive.md`; no `citationsArrayGuardSql` helper exists yet; the arm 6a/6b
SRF guards are byte-identical; `imageSrfGuardExpr` in `lib/ipfs-shared.ts` is the
precedent, but the citations guard needs a second `appTagParam` argument (a $N
placeholder threaded through the appTag index) and that param must NOT be
identifier-validated like the alias.

## Additional pre-existing anchor-rot sites surfaced 2026-06-09 (architect, profile-cluster review)

The `/ce-code-review` of the `profile.ts` accreditation-state-read cluster
(`buildwith-adoption`, `canary-stale-param-slots`, `tiebreaker-sweep`) incidentally
surfaced two pre-existing rot-class comment anchors. They were NOT introduced by
those commits and are recorded here against the anchor-rot sweep effort (user
elected "note for the existing sweep", not a dedicated task):

- `backend/src/routes/papers.ts` — `// Per task hold-block item 4d.` (inside
  `fetchPaperDetailFromHaf`, near the continuation-chain resolve). Task-slug + hold-item
  ordinal; re-anchor on the behavior ("resolve the continuation chain once up-front to
  avoid duplicate fetchHeadAuthorizedAuthors / chain-walk queries").
- `backend/tests/routes/profile-reviews-accred-gate.test.ts` — the file header
  (the un-edited block, roughly the first ~50 lines) carries `round-1 hold #2` /
  `round-3 hold #1` ordinals. The body's slot-map comment was already de-rotted by
  the canary task; only the header remains.

These sit OUTSIDE this task's original three-file scope (`reputation.ts`,
`notification-queries.ts`, `lib/ipfs-shared.ts`). Sweep them here only if the
re-enumeration at unblock widens to cover these files; otherwise fold them into the
next general anchor-rot sweep that touches `routes/papers.ts` / the route test tree.
Re-verify they still exist (and have not already been cleaned by in-flight work)
before editing.

## Additional pre-existing anchor-rot site surfaced 2026-06-12 (architect, redis-keys-scan archive review)

- `backend/tests/routes/reputation-batch-internals.test.ts` — the file header
  (roughly the first ~18 lines) and the describe near the prev_scores rehydration
  block carry round/hold ordinals. Pre-existing; NOT introduced by the redis-keys
  commits (the members-index write-path describe added there is clean). Same
  treatment as the 2026-06-09 entries above: sweep here only if the unblock
  re-enumeration widens to the test tree; re-verify before editing.

## [Architect] (2026-06-14) — UNBLOCKED; moved to pending/

The unblock condition above is met. The substantive `backend-reputation-*` and
`backend-notifications-*` tasks that churn the three target files
(`reputation.ts`, `reputation-batch.ts`, `notification-queries.ts`) have all
landed and archived — `tasks/review/` and `tasks/pending/` are both empty, so
nothing is reshaping those files anymore. The most recent of that batch
(`backend-notification-vote-arms-id-tiebreaker`, `backend-notifications-digest-window-cursor`,
`backend-reputation-batch-seam-eslint-guard`) archived 2026-06-14. Per this
task's own unblock instruction ("the architect, noticing the batch has cleared,
moves this file back to pending/"), moving it now.

**Mandatory for the implementer (do NOT skip):** the line/anchor snapshot in the
sections above has drifted across all that churn, and some anchors may already
have been cleaned by the per-arm comment work folded into the substantive tasks.
RE-ENUMERATE the live stale anchors from scratch (grep the three files for
round/hold ordinals, task slugs, line-number and SHA cites) rather than trusting
the lists above, then sweep whatever remains in one focused commit and extract
`citationsArrayGuardSql` (the arm 6a/6b SRF guard; `imageSrfGuardExpr` in
`lib/ipfs-shared.ts` is the precedent, but the citations guard needs a second
`appTagParam` `$N` argument that must NOT be identifier-validated like the alias).
