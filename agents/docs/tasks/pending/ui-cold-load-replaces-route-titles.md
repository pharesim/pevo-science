# A cold load replaces the route's title with the site title

**Owner:** ui
**Created:** 2026-10-06
**Priority:** low

## Why

`frontend/src/main.js` calls `initRouter()`, which sets the route's title
synchronously (`updateTitle(initial.route)` in `router.js`), and then
`initI18n()`, whose message load resolves later and sets `document.title` to
`metadata.title` (`frontend/src/i18n.js`). On a cold load (a mailed link, a
bookmark, a reload) the `ROUTE_TITLES` entry is therefore replaced by the
site title, and route titles show only after in-app navigation. The locale
switch in `i18n.js` also sets `metadata.title`.

Surfaced in the review of `ui-seed-recovery-confirm-and-dispute-pages`.

## Scope

1. After messages load, and after a locale switch, a route with a
   `ROUTE_TITLES` entry keeps that title. Check that the pages that set
   their own title (`paper-detail.js`, `profile.js`, `blog-post.js`) keep
   theirs as well.
2. Unit tests pin the cold-load order.

## Acceptance criteria

1. A cold load of a route with a `ROUTE_TITLES` entry shows that title.
