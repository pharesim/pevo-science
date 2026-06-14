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

## Backend completion (2026-06-14) — moved to review/

**Scope decision (user-directed):** this task's Acceptance writes the canary
against ALL of `backend/src/` ("no `round-\d+ hold` or `^BACKEND-` slug refs in
`backend/src/`"), which contradicts the Architect's 3-file unblock scoping. A
fresh re-enumeration found rot in ~33 source files, so the broad canary cannot
pass on a 3-file sweep. Surfaced the contradiction to the user, who elected the
**full `backend/src/` sweep** (not the narrow 3-file scope). Done accordingly.
Test tree (`backend/tests/`) was NOT swept — user scoped to `src/`; the
pre-existing test-header rot noted in the 2026-06-09 / 2026-06-12 sections above
(`profile-reviews-accred-gate.test.ts`, `reputation-batch-internals.test.ts`)
remains for a future tests/ sweep.

**Landed in commit `324ca283`** (one focused commit). 34 src files comment-swept
+ 1 canary test upgraded. Rot classes removed: round/hold ordinals; F-finding /
`item #N` / `Option A.N` / `acceptance #N` labels; orphan task slugs
(`BACKEND-*`, `BE-*`, `SEC-*`) and `see task` / `tasks-archive` / dead-`.md`
redirects; line-number cross-refs (incl. third-party + cross-repo); one commit-SHA
cite. All re-anchored on stable symbols / behavior; load-bearing WHY docblocks
preserved. NOT-ROT deliberately kept: timing/latency estimates, block-stride
quantities, hex encode() example outputs, persistent `solutions/` + `api-contracts/`
`.md` references.

**Extraction:** `citationsArrayGuardSql(citingAlias, appTagParam)` in
`notification-queries.ts` (exported, mirrors `imageSrfGuardExpr`; alias
identifier-validated, `$N` appTag param interpolated verbatim). Replaces the
verbatim arm 6a/6b SRF guard; emits byte-equivalent SQL. The sibling
`notification-queries-lateral-guard-canary.test.ts` now composes the production
builder (drift-proof) and gained a builder + call-site presence canary.

**Verification:** comprehensive rot grep clean (every class + the literal
acceptance canary); `npm run typecheck` + `npm run lint` clean (0 errors; the one
remaining lint warning is a pre-existing unused-eslint-disable in
`lib/author-supersession.ts`, which this task did not touch); citations-guard
canary (incl. real-Postgres behavioral) + arm-semantics + 11 source-shape canary
tests green. Every change outside `notification-queries.ts` is provably
comment-only (`git diff` non-comment-line check returns empty).

**Note for archive:** the adversarial verify pass also confirmed several
`agents/docs/solutions/conventions/*.md` and `agents/docs/api-contracts/*.md`
references in source are durable (files exist on disk) and correctly left intact —
the convention distinguishes those persistent knowledge-store filenames from
rotting task-slug / round / line anchors.

## Architect re-review (2026-06-14) — HELD PENDING FIXES

Reviewed commit `324ca283` via `/ce-code-review` (7 personas; `ce-agent-native-reviewer`
skipped per root CLAUDE.md). The substantive change is clean and archive-ready on its
own: the `citationsArrayGuardSql` extraction is semantically equivalent to the inline
arm 6a/6b guards (guard stays at the `jsonb_array_elements` argument site, preserving
the LATERAL-before-WHERE invariant), the alias is identifier-validated, the `appTagParam`
trace confirms it is always a `$N` bound placeholder (appTag value lands bound, no
injection), and the canary is drift-proof by construction. Correctness, security,
adversarial, and learnings all returned zero findings.

Held only on TWO completeness gaps against this task's own (user-chosen, full
`backend/src/`) acceptance. Both are P3 paperwork, neither is a behavior/security defect.

1. **Incomplete Option-A.N removal in `routes/orcid.ts` (INTRODUCED by this commit).**
   The sweep deleted the `Option A.1` expansions from the orcid binding-lock docblocks
   but left SIX bare `A.1` shorthand references orphaned — the text defining what "A.1"
   meant is gone, so the shorthand now dangles (an operator sees "A.1 lock-TTL extension
   skipped" in logs with nothing defining the term). Sites: the two BroadcastTimeoutError
   operator-log strings ("lock-TTL extension skipped" / "protection degraded") and four
   comments around the binding-lock TTL-extend / skipRelease branches. Re-anchor each on
   the behavior ("lock-TTL extension" / "duplicate-bind protection" / "the duplicate-bind
   race"), matching how the removed docblocks were re-anchored. Do NOT reintroduce the
   `Option A.N` label. This is unfinished by the commit's own stated `Option A.N` removal
   scope.

2. **Eight dead lowercase task-slug citations remain in `backend/src/`.** The acceptance's
   grep-canary matches only UPPERCASE line-anchored `^BACKEND-`, so lowercase mid-comment
   `<role>-<kebab>` / `<role>-<kebab>.md` citations slipped through. All eight are
   confirmed dead pointers (absent from `tasks/`, `solutions/`, and `tasks-archive.md`):
   - `hafsql.ts` — `backend-orcid-claim-mismatch-post-revocation-audit.md` (active-accred CTE docblock)
   - `lib/argon2-error-handler.ts` — `backend-503-message-genericize.md`, `backend-503-reason-discrimination.md`, `backend-503-retry-after.md`
   - `lib/request-abort-signal.ts` — `backend-argon2-error-handler-extract.md`
   - `routes/auth.ts` — `backend-argon2-jslevel-concurrency-cap` (inside a thrown error STRING, not a comment) and `backend-resend-verification-smtp-timing.md`
   - `routes/search.ts` — `backend-papers-filter-accreditation`
   Re-anchor each on behavior / stable symbol per the Comment Anchors convention. For the
   `auth.ts` runtime-error-string one, keep the behavioral reason (the JS-level semaphore
   is the real cap) and drop the slug. Two of these files (`argon2-error-handler.ts`,
   `request-abort-signal.ts`) were not touched by `324ca283` at all.

3. **Tighten the acceptance canary so this class cannot recur.** The current canary
   (`round-\d+ hold` + `^BACKEND-`) is case- and position-limited. Extend it to also fail
   on lowercase `\b(backend|ui|architect)-[a-z0-9]+(-[a-z0-9]+)+(\.md)?` task-slug
   citations and bare `Option [A-Z]\.[0-9]` labels anywhere in `backend/src/`, EXCLUDING
   durable `solutions/` and `api-contracts/` path references (those are the allowed
   persistent-knowledge-store class). Re-run after the fixes to confirm green.

**Before editing: RE-ENUMERATE.** Grep `backend/src/` fresh for all 14 anchors above plus
the new lowercase + Option-A.N classes — a concurrent sibling may have cleaned some, and
new occurrences may have appeared since this snapshot. Per
`convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, audit your own
replacement text for any new rot class (do not substitute one rot form for another). Then
`git mv` the file back to `tasks/review/` — the move is the re-review signal; the architect
re-reviews only the diff since this hold block.
