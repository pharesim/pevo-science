# BACKEND-NOTIFICATIONS-CITATION-ARMS-PAPER-EXISTS-GATE — citation arms admit fake citations of non-existent / non-authored papers (spam vector)

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #15 medium severity, correctness)
**Priority:** P2 (an accredited user can broadcast a "paper" with thousands of fake citation refs and spam unlimited citation notifications + digest emails)

## Problem

Arms 6a/6b in [notification-queries.ts:340-401](backend/src/notification-queries.ts#L340-L401) match by `cited_ref.author = $1` from the citing post's broadcaster-controlled JSON. `cited_paper` is `LEFT JOIN` for title-only with no requirement that the cited `(author, permlink)` actually exists as a PEvO paper authored by `$1`.

An accredited user (or anyone via the bridge path) can broadcast a "paper" with thousands of `{author: $1, permlink: 'fake-N'}` citations and spam unlimited citation notifications + digest emails to `$1`.

## Goal

Require the cited paper to actually exist as a PEvO paper authored by the recipient.

### Suggested approach

Promote `cited_paper` to `INNER JOIN` with `validPevoPaperWhere({alias:'cited_paper', source:'all'})` in both arms.

- **Arm 6a:** `cited_ref.author = $1` + `validPevoPaperWhere` guarantees a real native paper authored by `$1`.
- **Arm 6b:** the existing `user_bridge_papers` JOIN provides bridge identity; the INNER JOIN becomes belt-and-suspenders.
- Drop `COALESCE` on title (INNER guarantees the row).

## Acceptance

- Regression test: a citing paper with a fake `(author=victim, permlink='nonexistent')` citation produces NO citation notification to the victim.
- Regression test: a legitimate citation of a real PEvO paper the user authored still fires the notification.
- Regression test: bridge-arm equivalent — fake citation of a non-existent bridge paper produces no notification; legitimate one still fires.
- The `cited_paper.title` projection remains populated (now guaranteed non-null by the INNER JOIN).
- SQL-shape canary: assert `validPevoPaperWhere` is present in both arms 6a/6b.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Bundle SQL-shape canary churn with #7, #14, #16, #25.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 340-401 (arms 6a/6b).
- `validPevoPaperWhere` in [backend/src/hafsql.ts](backend/src/hafsql.ts).
- HAF-query review run `w274tijk0` rank #15.

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `c345053d`. The arm-6a existence gate is verified correct (author+permlink pinning, no JOIN fanout, `validPevoPaperWhere(source:'all')` covers native + bridge). Three items hold archive:

1. **Residual duplicate-citation spam vector** (P2, security). The INNER-JOIN gate closes fake-permlink spam but not duplicate-real-permlink: one broadcast listing the victim's real paper N times in the `citations` array fans out (via `jsonb_array_elements`) to N notifications + N digest-email lines (no `DISTINCT`, no per-pair dedup; the citing side is op-granular so re-edits re-amplify). The task's stated goal ("spam unlimited citation notifications") is only partially met. Fix: `SELECT DISTINCT cite_elem->>'author', cite_elem->>'permlink'` in the `cited_ref` lateral so a (citing-post, cited-paper) pair yields at most one notification regardless of array repetition.

2. **Arm 6b (bridge) has no behavioral test** (P1, tests). The new `it.skipIf` test exercises only arm 6a (no `user_bridge_papers` CTE/JOIN). Add a sibling behavioral test mirroring arm 6b: seed a `user_bridge_papers` row, apply the INNER JOIN + `validPevoPaperWhere` gate, assert `hit_count=0` for a fake permlink and `hit_count=1` with populated title for a registered bridge paper.

3. **Dropped COALESCE on title may emit null** (P2). INNER JOIN guarantees the row exists, not that `title` is non-null (`validPevoPaperWhere` gates on type/author only); the sibling `new_review` arms 1a/1b keep `COALESCE(p.title,'')` under the identical pattern. Restore `COALESCE(cited_paper.title,'') AS paper_title` in both arms 6a/6b, and flip the regression guard (which currently asserts COALESCE-absent) to assert COALESCE-present. Alternatively, if `comments.title` is provably NOT NULL, remove COALESCE across all arms in a separate change — do not leave 1a/1b vs 6a/6b split-brain.

## Backend re-review signal (2026-06-05, commit on main)

Held items 2 and 3 landed (held item 1 duplicate-spam was already closed by the sibling DISTINCT ON commit):
- (item 3, SQL) Citation arms 6a/6b now project `COALESCE(cited_paper.title, '') AS paper_title`, matching sibling arms 1a/1b (the INNER-JOIN gate proves the row exists but not that `title` is non-null). Flipped the regression guard from `not.toContain` to assert COALESCE present exactly twice (renamed to "title COALESCE parity"); updated the arm-6a behavioral test's projection for parity.
- (item 2, test) Added an arm-6b BRIDGE behavioral `it.skipIf` test seeding `user_bridge_papers` (registered → hit, unregistered fake permlink → no hit), mirroring the arm-6a structure with the arm-6b shape (no `cited_ref.author = $1` clause).
- (item 1, optional) Added the DISTINCT ON dedup regression test (a citations array naming the same ref 3x → one notification).
`npm run typecheck` + `npm run lint` clean; notification-arm-semantics + notifications-arm-sql-shape green.
