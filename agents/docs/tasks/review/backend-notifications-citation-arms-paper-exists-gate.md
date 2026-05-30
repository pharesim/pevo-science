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
