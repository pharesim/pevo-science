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

## Architect re-review (2026-05-11) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` against commits `5b3d763 test(ui): e2e coverage for /edit/:author/:permlink` + followup `2f70270 test(ui): fix edit-paper continuation discipline locator` with 6 personas (correctness, testing, maintainability, project-standards, julik-frontend-races, learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md).

The followup commit (`2f70270`) caught one Alpine `:value` property-vs-attribute trap in the continuation-edit discipline locator. The same trap recurs at the review-addressing checkbox locator (item 1 below). Address all items before re-review:

1. **P1 — Checkbox locator hits a never-set HTML attribute (edit-paper.spec.js:437).** `input[type="checkbox"][value*="reviewer-"]` returns ZERO matches at runtime: Alpine's `:value="rev.author + '/' + rev.permlink"` binding at `frontend/src/pages/edit.js:338` routes through `bindInputValue` (`alpinejs/module.cjs.js:2843-2853`) which assigns `el.value = String(...)` as a JS PROPERTY only — `setAttribute('value', ...)` is never called for checkbox `:value` bindings. CSS attribute selectors read `getAttribute('value')`, which returns `null`. The subsequent `await expect(reviewCheckboxes).toHaveCount(2)` fails; `.first().check()` then errors with no matching element. **This is the SAME class of bug `2f70270` fixed for the discipline locator one site away.** Fix direction (mirror 2f70270's approach): add a stable handle to the production template — e.g., `data-testid="address-review-checkbox"` on the input at `edit.js:337` — and locate by test-id in the spec. Verify the test actually runs through to the broadcast assertions and not just the visibility-of-panel assertion.

2. **P2 — `page.evaluate` injection of abstract/body races the async editor mount (edit-paper.spec.js:195-207, 246-258, 415-420).** `_mountEditors()` is dispatched via `$nextTick` → dynamic `import('../editor.js')`. If the editor resolves and fires an initial `onChange` callback with `initialMarkdown` (the pre-fill value) AFTER the test writes `data.abstract = NEW_ABSTRACT` but BEFORE the submit click, the editor's onChange overwrites `this.abstract` back to the pre-fill. The submit handler then sees unchanged content, hits the no-changes guard, sets `step='error'`, and the broadcast never fires; the `expect.poll` times out at 10s with the opaque "expected 0 to be greater than 0" message. Verify in `editor.js` whether the editor emits an initial-onChange-on-construct, and either gate `page.evaluate` on a `waitForFunction` that the editor instance is fully mounted, or set the markdown via the editor's public API.

3. **P2 — Accepted-claimer edit path has no positive test.** `edit.js:isAuthorized` returns true for an accredited user with an accepted `authorship_claim`. The fixture helper already accepts a `claims` parameter and threads it through the enrichment mock. AC3 only asserts the negative gating for an unaccredited-non-author-no-claim; the positive mirror (accredited non-author WITH accepted claim sees the form and the broadcast lands) is uncovered. A regression that drops the claim check from `isAuthorized` would not be caught. Add a 5th test seeding `claims: [{ claimer: reviewer.username, status: 'accepted' }]` and asserting the form renders + a broadcast fires.

4. **P2 — No-changes guard (`edit.noChanges`) is untested.** `edit.js:1036-1048`: when title, body, abstract, metadata, and addressed-reviews are all unchanged, `handleSubmit` sets `step='error'` with `errorMessage='edit.noChanges'` and returns without broadcasting. A regression removing or broadening this guard (allowing a no-op broadcast) would not be caught. Add a test that opens the form and submits without modifying anything; assert the error state renders and `__pevoBroadcastCalls` is empty.

5. **P2 — Non-head-target full-body branch (edit.js:1052-1057) is untested.** Fixture always sets `head_author === paper.author` and `head_permlink === paper.permlink`, so `targetIsHead === true` and the diff-only broadcast path is the only branch exercised. The non-head case (a user editing their own continuation when a later continuation by someone else is now the chain head) takes the full-body broadcast branch with no coverage. Add a fixture variant with a 3-version chain ending on a different author and assert the reviewer's edit broadcasts the full body (not a diff) targeted at the reviewer's own permlink.

6. **P3 — Route-handler order comments are inverted (edit-paper.spec.js:102-104 and 124-126).** Playwright dispatches the MOST-recently-registered match first; `route.fallback()` walks back to earlier-registered handlers. The current registration (enrichment + invalidate first, bare paper last) is correct in behavior, but the comment at L102-104 ("more specific routes ... must be registered before the bare paper route") reads the order backwards. A future maintainer who "fixes" the registration order to match the comment will silently break interception. Rewrite both comments to describe the actual dispatch semantics: bare paper is registered LAST (fires first by Playwright's dispatch order), and `route.fallback()` is what routes suffix paths to the more-specific earlier handlers.

7. **P3 — `Date.now().toString(36)` permlink idiom repeated 4× (edit-paper.spec.js:162, 218, 316, 396).** Extract a one-liner helper `function uniquePermlink(prefix) { return \`${prefix}-${Date.now().toString(36)}\`; }` at file scope to make each call site self-documenting.

When all 7 items are landed, `git mv` this file back to `tasks/review/`.

Dismissed (audit, not blocking): P2 submit-then-poll-broadcast 3× duplication across this+sibling specs (DRY judgment call — viable future cleanup, no correctness risk); P2 `Alpine.$data(el).abstract = X` 3× duplication (same); P3 Tiptap onChange bypass (deliberate test-design choice documented in file header); P3 draft restore path untested (clearDraft is called precisely for determinism, separate task surface if draft testing is wanted); P3 followup-pattern advisory; P3 poll error message improvement; P3 `pickAccreditedResearcher` failure mode (known real-HAF tradeoff); P3 `test(ui):` conv-wrap commit prefix on both commits (hook now accepts conv-wrap — not actionable retroactively).

Note: the recurrence of the Alpine `:value` property-vs-attribute trap (item 1 here + the 2f70270 fix + the residual on `input.select-control[disabled]` for the discipline input) is a learnable pattern that has no `docs/solutions/` entry yet. Architect will evaluate for `/ce-compound` capture after the held round closes.
