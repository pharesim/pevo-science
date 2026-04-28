# E2E spec — paper edit flow

**Owner:** UI Agent
**Created:** 2026-04-28

## Problem

`frontend/src/pages/edit.js` is the largest untested mutation surface in the frontend. It handles paper editing for original authors, co-authors, accepted authorship-claim claimers, AND continuation posts by any accredited user (`isAuthorized` getter, `edit.js:354-371`). Continuation editing has subtle review-invalidation rules and creates a new post in a chain rather than diffing the original. None of this is exercised end-to-end today.

## Acceptance criteria

Add `frontend/tests/e2e/edit-paper.spec.js` covering at minimum:

1. **Original-author in-place edit** — accredited fixture user opens `/edit/<own-author>/<own-permlink>`, modifies title and abstract, submits. Assert a Hive `comment` op is broadcast with the same `parent_permlink` and `permlink` (in-place diff), `app: APP_TAG`, and updated content.

2. **Continuation edit by another accredited user** — fixture user A authored the paper; fixture user B (accredited, not co-author, no claim) opens `/edit/A/<permlink>`, makes changes, submits. Assert:
   - The continuation banner is shown (`x-if="isContinuation"`, `edit.js:62`).
   - Discipline field is disabled (`edit.js:92`, "fixed across continuations").
   - A `comment` op is broadcast as a NEW post (different permlink), with metadata linking it to the original chain.

3. **Authorization rejection** — non-author, unaccredited, no claim → `isAuthorized` is false. Assert the form does not render / submit is impossible.

4. **Review invalidation surfacing** — if the editing flow surfaces any "this will invalidate existing reviews" notice, assert it's visible before submit. (Cross-reference `project_edit_flow_decisions` memory for the canonical rules.)

Follow the existing E2E pattern (see `publish.spec.js`, `review-submit.spec.js`): intercept the broadcast at the Hive Keychain / dhive layer rather than hitting a real chain. Use `test.use({ trace: 'off', video: 'off', screenshot: 'off' })` for the broadcast-assembly tests.

Run via the standard E2E flow: `./deploy.sh restart && ./deploy.sh test-up && (cd frontend && nvm use 20 && npx playwright test edit-paper.spec.js)`, then `./deploy.sh up`.

## Out of scope

- IPFS upload error paths (covered or to be covered by `publish.spec.js`).
- Non-edit pages.
- Backend-side authorship-claim acceptance flow (separate concern).
