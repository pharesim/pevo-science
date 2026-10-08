# A link to another paper or profile from the same kind of page changes the URL but not the page

**Owner:** ui
**Created:** 2026-10-09
**Priority:** normal

## Why

Reported as a residual by the ui agent in `ui-composer-surfaces-navigate-over-undrafted-work` and
confirmed from the code at the architect review. User triage: "as recommended". Not clicked
through in a browser.

`router.navigate()` pushes the new URL and replaces `params`; the `popstate` listener does the
same for Back and Forward. `pageMount` re-renders only when `route` or the router's `generation`
changes, and `generation` moves only on `remount()`. `paperDetailPage` and the profile page load
their entity once, from `init()`, and nothing on either page watches the params. So a navigation
between two URLs of the same route keeps the mounted page and its loaded entity:

- a citation link on a paper page (`/paper/...` to `/paper/...`);
- a voucher link, or a co-author link in the publication list, on a profile page
  (`/profile/...` to `/profile/...`);
- Back or Forward between two such entries.

The URL then names one entity while the page shows another. The pages' `author` / `permlink` /
`username` getters read the router params and so name the new entity, while the loaded `paper` or
profile is the old one, and the ORCID return path and the navigation stash read the URL. The edit
page already handles this case for itself (ARCHITECTURE § 8: it flushes its draft and remounts
once no submit is in flight); no other page does.

## Scope

Make a same-route navigation show the entity the URL names. Enumerate every route in
`frontend/src/router.js` that carries params, say in the signal which of them an in-app link or
Back/Forward can reach same-route, and cover each reachable one. The paper and profile pages are
the known cases.

Recommended default, implement unless you see a reason to deviate, in which case flag before
landing: such a page calls `Alpine.store('router').remount()` when the params it loaded for stop
matching the router's, the mechanism the edit page uses. Keep the edit page's own rule as it is.

## Acceptance criteria

1. From a paper page, following a citation link to another paper shows that paper, and Back shows
   the first one again.
2. The same between two profiles, through a voucher link and through a co-author link.
3. After such a navigation, a comment, vote or vouch goes to the entity on screen.
4. The edit page's behavior is unchanged (its suites stay green).
5. Unit coverage per covered page, each probed by reverting its own fix.
6. New comments cite no task slug, round number or line number (root `CLAUDE.md` "Comment
   anchors").
