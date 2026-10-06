# The teardown message names a confirmation that was not there, and two mapper mocks misdescribe themselves

**Owner:** ui
**Created:** 2026-10-06
**Priority:** low

Routed out of the architect review of `ui-upload-batch-teardown-guard` (`4781efac`): the
implementer's out-of-scope follow-ups 2 and 4.

## Why

1. **Teardown message.** `reportTeardownOnce()` in `frontend/src/lib/fresh-auth.js` shows
   `auth.reauthCancelled`, "Your session changed, so the confirmation was cancelled."
   (`frontend/public/messages/en.json`). It is called by the `cancel()` of every
   `subjectTeardownGuard` and by the session-inconsistency detection. Many of those reports
   have no confirmation on screen, for example an upload leg stopped by `uploadFile`'s own
   guard, or a batch-guard unwind between two uploads on the publish and edit submits. On
   those paths the message's second clause is false.
2. **Mapper mocks.** The `describeUploadError` mocks in
   `frontend/tests/unit/pages-publish.test.js` and `frontend/tests/unit/pages-edit.test.js`
   carry the comment "Mirrors the real mapper, including the null contract for the
   already-reported teardown code". The real mapper in `frontend/src/lib/ipfs-upload.js`
   returns null for both `UPLOAD_SESSION_TORN_DOWN` and `UPLOAD_SUBJECT_CHANGED`. The mocks
   return null only for the first, so `UPLOAD_SUBJECT_CHANGED` falls through to
   `common.uploadFailed`.

## Scope

1. Make the teardown message true for every caller of `reportTeardownOnce()`. Rewording the
   one string or splitting it by caller are both acceptable; ask if the choice is unclear. A
   changed English string follows the locale re-stub rule in `agents/ui/CLAUDE.md`.
2. Make the two mocks map `UPLOAD_SUBJECT_CHANGED` to null like the real mapper, so the
   comment is true. If a test then fails, that test was depending on the mock's divergence:
   report it in the signal block rather than reverting the mock.

## Acceptance criteria

1. No caller of `reportTeardownOnce()` shows a message that names something the user did not
   see.
2. Both mocks match the real mapper for every code it handles, and their comment is true.
3. The frontend unit suite is green.

`ui-confirm-dialog-answered-after-subject-teardown` adds teardown reports from dialog paths;
either task may land first.
