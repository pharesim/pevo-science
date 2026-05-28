# BACKEND-COMMENTS-HIDE-REPLIES-TO-UNACCREDITED-PARENTS — Hide accredited replies whose parent is non-accredited

**Owner:** backend
**Created:** 2026-05-21

## Context

`GET /api/papers/:author/:permlink/comments` returns accredited-authored replies whose **parent** comment was authored by a non-accredited Hive user (e.g., posted via peakd/ecency by a non-PEvO account). The non-accredited parent is correctly filtered out of the output, but its accredited child reply survives, surfacing as an orphan with no visible context.

**Reproducer:** `GET /api/papers/pevo.science/pevo-original-whitepaper-2016-2026-revision-mnczwwdm/comments` returns:

```
{ author: "pevo.science",
  permlink: "re-joann2-tdeuxx",
  parent_author: "joann2",                       // not accredited
  parent_permlink: "re-pevo-original-whitepaper-...-20260406t000554z",
  is_accredited: true }
```

`joann2` is not in `active_accreditations`; their comment is excluded from the response; the pevo.science reply ("Open access papers on arxiv or with a DOI can be linked...") renders against no context.

## Root cause

`backend/src/routes/comments.ts:100-152` builds a recursive comment tree, then applies accreditation **only** at the outer `filtered` step via `JOIN active_accreditations aa ON aa.account = dc.author`. The join filters on the comment's **own** author. Descent through the recursive arm is unrestricted, so a subtree rooted at a non-accredited comment passes through whenever any of its descendants happen to be accredited.

The base arm is structurally fine: its `parent_author = $paperAuthor` matches a paper, and paper authorship requires accreditation (PEvO invariant). The defect is the unrestricted recursive arm.

## Goal

In the recursive arm of the data query (`comments.ts:114-122`) and the count query (`comments.ts:143-148`), only descend through parents whose author is in `active_accreditations`. This excludes both the orphan reply and any accidental sub-thread that would similarly render against missing context.

Equivalent shape (final SQL is the implementer's call):

```sql
-- Recursive arm
SELECT c.author, c.permlink, ...
FROM ${T.comments} c
JOIN comment_tree ct ON c.parent_author = ct.author AND c.parent_permlink = ct.permlink
WHERE (c.json_metadata -> $${appTagIdx} ->> 'type') IS DISTINCT FROM 'review'
  AND ct.depth < 20
  AND EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = ct.author)
```

The outer `accreditedJoin` on `dc.author` stays; it's the author-side gate and continues to enforce the "is_accredited: true for every row" invariant.

## Acceptance

1. `re-joann2-tdeuxx` (or any reply with `parent_author` not in `active_accreditations` and `parent_author != paperAuthor`) is **not** returned by the endpoint.
2. The existing positive canary still passes: `jesusalejos/...` paper still returns both `re-tica-y-meta-antropologa-...` (PEvO-authored) and `re-jesusalejos-texm5t` (peakd-authored, accredited scientist, **parent is the paper itself** so still admitted).
3. The "every returned comment is accredited-authored" canary still passes.
4. New regression test added to `backend/tests/routes/comments.test.ts` that, for the bug paper specifically, asserts the orphan reply is absent. Pinning by permlink avoids drift if other comments land.
5. `meta.total` matches `data.length` after pagination — the count query must apply the same descent restriction as the data query, otherwise paging counts will drift from rendered counts.

## Non-goals

- No change to reviews (`reviews.ts` uses a single-level parent join, not recursive — unaffected).
- No change to the `/papers/:author/:permlink` enrichment route.
- No change to the outer `accreditedJoin` shape. The fix is descent-side only.
- No frontend change. The tree currently renders flat (no client-side parent-stitching), so hiding the row at the API is sufficient.

## References

- `backend/src/routes/comments.ts:72,100-152`
- `backend/src/hafsql.ts:102-131` (`activeAccreditationsCteBody`)
- `backend/tests/routes/comments.test.ts:58-71` (existing accreditation canary; this task adds a parent-accreditation companion)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect review (2026-05-27) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `55ff696a` (correctness, security, adversarial, performance, testing). The descent-gate fix is CONFIRMED CORRECT: the recursive arm gates on `ct.author` (the parent), prunes whole subtrees rooted at non-accredited nodes transitively, the count query carries the identical EXISTS so `meta.total === data.length`, `active_accreditations` is authority-gated, the added EXISTS is a net perf win (prunes descent before the JOIN expands), and there is no injection vector. Two items hold before archive:

1. **(P1, conf 100 — adversarial + testing convergence) The two new tests can pass vacuously on a silent-empty listing.** Both `hides accredited replies whose parent author is non-accredited` and `meta.total matches the unpaginated data length...` assert against the `pevo.science` whitepaper, but neither asserts any POSITIVE presence for THAT paper — the only positive canary (`PEVO_COMMENT`/`PEAKD_COMMENT` must appear) targets a DIFFERENT paper (`jesusalejos/...`). `fetchCommentsFromHaf` swallows a CTE/HAF error and returns `[]` (an over-prune logic bug is not a thrown error, so it never surfaces as 503); on `[]`, `.not.toContain(orphan)` passes and `0 === 0` passes — both green while the endpoint shows nothing, and the mutation-kill (revert the EXISTS → orphan reappears) only fires when the paper is non-empty. Fix: add a positive-presence floor on the SAME `pevo.science` whitepaper to the orphan test — minimally `expect(res.body.data.length).toBeGreaterThan(0)`, or `.toContain(<a known-present accredited sibling permlink on that paper>)`. That single assertion also de-vacuifies the `meta.total` test (shared response).

2. **(P3, conf 75 — correctness + security) The base-arm safety comment's stated justification is imprecise.** The comment says the base arm is safe because "paper authorship requires accreditation (PEvO invariant)", but `paperExistsInHaf`'s native-paper arm is type-only (it does NOT gate on `active_accreditations`, unlike the `papers.ts` listing), and bridge papers are authored by `config.hiveBridgeAccount` which need not be in `active_accreditations`. The base arm is in fact orphan-safe because the parent IS the paper page itself (the rendered context), not because the paper author is guaranteed accredited. Reword the comment to anchor on "parent is the paper page itself". No code change — the descent fix is correct as-is.

When both items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 review scopes to the fix commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-27) — item 1 resolved with a documented deviation from the hold prescription

**Item 2 (P3)** landed clean: the base-arm safety comment in `fetchCommentsFromHaf` was reworded to anchor orphan-safety on "the parent IS the paper page itself" (noting `paperExistsInHaf`'s native-paper arm is type-only and bridge papers are authored by `config.hiveBridgeAccount`, so the paper author need not be accredited).

**Item 1 (P1) — the prescribed positive-presence floor is infeasible for the reproducer paper; corrected per user triage.** The hold asked for `expect(data.length).toBeGreaterThan(0)` (or `.toContain(<a known-present accredited sibling on that paper>)`) on the `pevo.science` whitepaper. A direct HAF query of that paper's full comment tree shows the floor cannot hold: the tree is 6 comments — all **5 direct replies** (askrafiki, hivebuzz, joann2, pedrobrito2004, stayout.bot) are by **non-accredited** authors (dropped by the outer `accreditedJoin`), and the **sole accredited comment is the orphan itself** (`pevo.science/re-joann2-tdeuxx`, parent `joann2` unaccredited), which the descent gate correctly hides. So the endpoint's correct result for this paper is `[]`; there is no accredited non-orphan sibling to assert presence on. The hold's "known-present accredited sibling on that paper" premise does not hold against the chain data.

The hold's other stated premise — "`fetchCommentsFromHaf` swallows a CTE/HAF error and returns `[]`" — also no longer matches the code: the catch **loud-fails** (`throw new HafQueryError(...)` -> route returns 503 retriable / 500 deterministic), it does not return `[]`. (Two stale in-code comments still describe the old swallow behavior; left untouched as out of this task's scope, flagged here.)

Resolution (user-approved deviation): kept the worker's added `expect(res.status).toBe(200)` and the existing `.not.toContain(ORPHAN_REPLY_PERMLINK)`, and **dropped** `toBeGreaterThan(0)`. The test is still non-vacuous: `status === 200` proves a real response (an error throws non-200, never an empty `200 []`), and `.not.toContain` kills the descent-gate mutation because reverting the recursive-arm `EXISTS` makes the orphan reappear (its own author is accredited) -> the response turns non-empty -> the assertion fails. The mutation-kill does not require a non-empty correct result. The rationale comment was rewritten accordingly (behavioral anchors only).

**Secondary observation (not a regression from this task):** under concurrent full-suite load the comments endpoint can return 500 on HAF connection-pool contention even with `retry: 5`; in isolation it is a clean `200 []` and `comments.test.ts` passes 8/8. The descent-gate query predates this task; flagging as a pre-existing real-HAF test-robustness item for awareness.

Verification: `npm run typecheck` clean; `tests/routes/comments.test.ts` 8/8 passing in isolation. Landed: the item 2 reword plus the worker's `status === 200` addition arrived in commit `4b4f669f`; the item 1 floor correction (dropping `toBeGreaterThan(0)` + rewriting the rationale comment) lands in the commit that moves this file to `review/`.

## Architect re-review (2026-05-28) — HELD PENDING FIXES (round 3):

`/ce-code-review` on the round-2 fix commits (`4b4f669f` + `5994c01a`), scoped to `comments.ts` + `comments.test.ts` (correctness + testing on Opus; maintainability + project-standards + learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO). The round-2 work is CONFIRMED CORRECT and the floor-drop deviation is ACCEPTED: the catch loud-fails (throws `HafQueryError`), so `status === 200` closes the error-masking path; the existing positive-presence canary on the `jesusalejos` paper closes the "descent silently returns nothing" path; and the item-2 base-arm comment reword is accurate (`paperExistsInHaf` is type-only / bridge-account-pinned, no accreditation gate). Dismissed at triage: the learnings-researcher's call for an additional same-block positive floor (mitigated by the `jesusalejos` canary + loud-fail; the uncovered mutation class is out of this task's scope). One item holds before archive:

1. **(P3, conf 100 — correctness + maintainability convergence) Stale `WITH RECURSIVE` docblock contradicts the loud-fail catch and the freshly-reworded item-2 comment.** In `fetchCommentsFromHaf`, the `WITH RECURSIVE` rationale comment's parenthetical still reads "the failure is silent here — the caller catches the parse error and returns []". The catch loud-fails (`throw new HafQueryError(...)`); it never returns `[]`. This contradicts (a) the actual catch behavior, (b) the item-2 base-arm comment a few lines below it that this round just corrected, and (c) the test rationale comment, which explicitly states the helper loud-fails. It is the exact failure mode the "convention-enforcing fix must audit its own new code" rule guards against — the adjacent comment was corrected without auditing this one. The `WITH RECURSIVE` necessity claim itself is accurate; only the error-behavior parenthetical is wrong. Reword the parenthetical to reflect the loud-fail (a parse error throws `HafQueryError`, the route returns 503/500; it is never a silent `200 []`). Anchor on the loud-fail semantics, not on round/slug/line markers. NOTE: this is the only genuinely stale comment in the file — the backend signal above flagged "two stale in-code comments", but the only other `200 []` reference (inside the catch block) is an accurate counterfactual ("would otherwise collapse to `200 []`") explaining why the loud-fail exists; leave it untouched.

When the reword lands, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-4 review scopes to the fix commit only. Do not edit this hold block; the commit diff is the evidence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-28) — round-3 item 1 resolved

Reworded the `WITH RECURSIVE` docblock parenthetical in `fetchCommentsFromHaf`. The stale text ("the failure is silent here ... the caller catches the parse error and returns []") now states the opposite and correct behavior: a parse error is **not** silent — the catch below throws `HafQueryError`, so the route returns 503/500, never a silent `200 []`. Anchored on the `HafQueryError` symbol and "the catch below" (behavioral); no line/round/slug markers. Left the accurate `200 []` counterfactual inside the catch block untouched per the hold's NOTE.

Verification: `npm run typecheck` clean. Comment-only change — no behavior, query, or test surface touched, so the round-2 test posture (8/8 in isolation) is unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
