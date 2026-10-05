# Audit the remaining frontend components and libs

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The frontend components, shared libs and app entry files no recent task has touched.

## Scope (line counts at filing)

- `frontend/src/authorships.js` (80)
- `frontend/src/components/accreditation-badge.js` (5)
- `frontend/src/components/accreditation-banner.js` (35)
- `frontend/src/components/comment-composer.js` (98)
- `frontend/src/components/footer.js` (12)
- `frontend/src/components/header.js` (119)
- `frontend/src/components/pagination.js` (92)
- `frontend/src/components/paper-card.js` (138)
- `frontend/src/components/paper-feed.js` (243)
- `frontend/src/components/paper-filters.js` (5)
- `frontend/src/components/rating-bar.js` (12)
- `frontend/src/components/review-card.js` (4)
- `frontend/src/components/threaded-comments.js` (167)
- `frontend/src/components/version-selector.js` (4)
- `frontend/src/components/vote-buttons.js` (242)
- `frontend/src/config.js` (28)
- `frontend/src/error-tracking.js` (37)
- `frontend/src/i18n.js` (154)
- `frontend/src/main.js` (106)
- `frontend/src/notifications.js` (183)
- `frontend/src/toast.js` (36)
- `frontend/src/lib/accreditation-tenure.js` (22)
- `frontend/src/lib/accredited-directory.js` (117)
- `frontend/src/lib/authors.js` (53)
- `frontend/src/lib/credit.js` (47)
- `frontend/src/lib/discipline-display.js` (72)
- `frontend/src/lib/discipline-filter.js` (96)
- `frontend/src/lib/format-eta.js` (35)
- `frontend/src/lib/pagination.js` (7)
- `frontend/src/lib/timer-guard.js` (102)
- `frontend/src/lib/url-sync.js` (21)
- `frontend/src/lib/version-diff.js` (62)

Total: 2434 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
