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
