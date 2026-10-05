# Audit the remaining frontend pages

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The frontend pages no recent task has touched.

## Scope (line counts at filing)

- `frontend/src/pages/about.js` (165)
- `frontend/src/pages/blog-post.js` (90)
- `frontend/src/pages/blog.js` (109)
- `frontend/src/pages/bridge.js` (501)
- `frontend/src/pages/contact.js` (163)
- `frontend/src/pages/faq.js` (56)
- `frontend/src/pages/getting-started.js` (209)
- `frontend/src/pages/home.js` (100)
- `frontend/src/pages/index.js` (64)
- `frontend/src/pages/my-imports.js` (437)
- `frontend/src/pages/papers.js` (18)
- `frontend/src/pages/profile.js` (508)
- `frontend/src/pages/researchers.js` (221)
- `frontend/src/pages/review.js` (344)
- `frontend/src/pages/search.js` (343)
- `frontend/src/pages/stats.js` (100)

Total: 3428 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
