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

## UI re-review signal (2026-05-11, commits 3532fa2, 5ba7b17)

All 7 hold items landed across two commits. Worker rebased onto main before applying so the alpine `:value` solutions doc (`8245059`) and the held spec (`5b3d763` + `2f70270`) were visible.

- Item 1 (P1, checkbox locator hits never-set HTML attribute) — `3532fa2`. Added `data-testid="address-review-checkbox"` to the review-addressing checkbox input in `frontend/src/pages/edit.js` (only production-code change). Spec switched to `page.getByTestId('address-review-checkbox')`; inline comment cites `agents/docs/solutions/conventions/alpine-value-property-vs-attribute-trap-2026-05-11.md`.
- Item 2 (P2, page.evaluate races async editor mount) — `3532fa2`. Added file-scope helpers `waitForEditorsMounted(page)` (gates on `data._abstractEditor && data._bodyEditor` populated) and `setEditorContent(page, {abstract, body})` (writes Alpine state AND calls editor `setContent` with `emitUpdate:false` per `editor.js:681`). Applied to the in-place, continuation, and reviews-addressing tests.
- Item 3 (P2, accepted-claimer positive test) — `5ba7b17`. New test `accepted-claimer (accredited, not author, not co-author) reaches the edit form and broadcasts`. Seeds `claims: [{ claimer, status: 'accepted' }]` via the existing `installPaperMocks` claims param; asserts continuation broadcast lands.
- Item 4 (P2, no-changes guard test) — `5ba7b17`. New test `no-changes guard blocks the broadcast and surfaces an error step`. Re-stamps Alpine abstract/body via `setEditorContent` to pin against Tiptap roundtrip jitter; asserts `step==='error'`, `errorMessage==='edit.noChanges'`, `__pevoBroadcastCalls.length===0`.
- Item 5 (P2, non-head-target full-body branch) — `5ba7b17`. New test `non-head edit target (own post no longer chain head) broadcasts full body, not a diff`. Builds 2-version chain where researcher authored `versions[0]` but `head_author/head_permlink` point at a synthetic later author; asserts broadcast targets researcher's own permlink, body starts with `## Abstract\n\n` (full body, not `@@`-prefixed diff), no `continues` pointer.
- Item 6 (P3, inverted route-handler comments) — `3532fa2`. Both comments rewritten to describe Playwright's reverse-registration dispatch order with `route.fallback()` walking back to earlier handlers.
- Item 7 (P3, `uniquePermlink` helper) — `3532fa2`. Added `function uniquePermlink(prefix)` at file scope; replaced 4 callsites in original tests; the 3 new tests in `5ba7b17` use it from the start.

Spec parses (`npx playwright test --list` discovers 7 tests, 4 original + 3 new). Worker flagged the editor-ready-gate pattern (`waitForEditorsMounted` + `setEditorContent` with `emitUpdate:false`) as a possible separate `/ce-compound` capture — distinct mechanism from the alpine attribute trap; left for architect to evaluate. Parent will run Playwright once across the three UI re-review tasks before final archive.

## Architect re-review (2026-05-16) — HELD PENDING FIXES (round-2):

Reviewed via `/ce-code-review` against commits `3532fa2 + 5ba7b17 + d0165a8` with 7 personas (correctness, testing, maintainability, project-standards, julik-frontend-races, adversarial, learnings-researcher; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). **All 7 round-1 hold items verified landed** (correctness reviewer cross-checked each item against the commits; julik-frontend-races answered 6 race-shape questions and found no residual race). 5 delta-finding items must land before re-review:

1. **P2 — Diff-broadcast branch in `handleSubmit` has no positive test coverage (`frontend/src/pages/edit.js:1033-1057`, `frontend/tests/e2e/edit-paper.spec.js:197-274`).** adversarial (P2/75). Test 7 covers the non-head full-body branch via `body.startsWith('## Abstract\n\n')` + `!startsWith('@@')`, but test 1 (in-place author edit at line 197) does NOT assert `body.startsWith('@@')`. A mutation that removes the diff branch (always broadcasting full body) passes all 7 tests. The diff-broadcast optimization is PEvO's only Hive-bandwidth-conscious code in the edit flow; a silent regression doubles every paper-revision chain footprint. Fix: add one assertion to test 1 around line 273:
   ```js
   expect(commentBody.body.startsWith('@@')).toBe(true);
   ```

2. **P2 — `setEditorContent` docblock ghost-references a removed call (`frontend/tests/e2e/edit-paper.spec.js:180-184`).** maintainability (M-E2E-1 P2/75). Current docblock says "We deliberately do NOT call `editor.setContent()` here" — but the helper never calls it in its current shape; that call was removed in `d0165a8`. Reads as if there's an active suppression of a temptation. Rephrase to positive framing:
   ```
   // Alpine state write is sufficient. Calling editor.setContent() after
   // the editor's own initialMarkdown application produces a tiptap
   // "Applying a mismatched transaction" RangeError (the in-progress
   // initial transaction conflicts with the imperative replace), so we
   // avoid the imperative path entirely. Verified the editor's onUpdate
   // does not fire on constructor content-init (tiptap dispatchTransaction
   // gates the callback to user transactions, not constructor init).
   ```

3. **P3 — Accepted-claimer test missing 4 continuation-broadcast assertions (`frontend/tests/e2e/edit-paper.spec.js:537-540`).** Cross-reviewer agreement: testing (P3/70) + adversarial (P3/75). The claimer test asserts the gate lets the user through (form renders, broadcast fires) but does not pin the broadcast-payload shape that test 1 establishes for in-place edits. Add 4 small assertions modeled after test 1's invariants (around line 540):
   - `expect(commentBody.parent_author).toBe('');` (top-level Hive post invariant)
   - `expect(meta[APP_TAG].version).toBeGreaterThan(1);` (continuation has version >1)
   - `expect(meta[APP_TAG].continues).toBeTruthy();` and `expect(meta[APP_TAG].continues.author).toBe(paper.author);` + `expect(meta[APP_TAG].continues.permlink).toBe(paper.permlink);` (chain pointer present)
   - `const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options'); expect(optionsOp).toBeTruthy();` (PEvO no-Hive-rewards principle is enforced via `comment_options.allow_curation_rewards: false`; a regression dropping this op enables curation rewards on continuations)

4. **P3 — Discipline disabled-state assertion lost when test 2 was rewritten by the narrow-gating commit (`frontend/tests/e2e/edit-paper.spec.js`, around line 508 in the accepted-claimer test).** adversarial (P3/75). The original test 2 was the ONLY assertion that the discipline input is disabled on continuations — the "discipline fixed across continuations" chain-coherence invariant. Narrow-gating's rewrite (commit 00d3f97) deleted that test; the new accepted-claimer test renders a continuation form but does not assert the disabled state. Restore the lost coverage in the claimer test, after `await expect(page.locator('input#edit-title')).toBeVisible();` (~line 508):
   ```js
   // Continuation forms freeze the discipline (chain-coherence invariant).
   const disciplineInput = page.locator('input.select-control[disabled]').first();
   await expect(disciplineInput).toBeDisabled();
   await expect(disciplineInput).toHaveValue('Computer Science');
   ```

5. **P3 — Stale comment in accepted-claimer test references the now-deleted "Test 2 via isAccredited route" (`frontend/tests/e2e/edit-paper.spec.js:472-477`).** testing (medium). The accepted-claimer docblock says "Test 2's continuation path exercises the accredited-non-author route via isAccredited" — but test 2 was rewritten by 00d3f97 to be the gating-panel assertion; the via-isAccredited path no longer exists in the suite by design. Comment misdescribes the current test layout. Rewrite (3 lines) to reflect current state:
   ```
   // edit.js:isAuthorized returns true for an accredited user with an
   // accepted authorship_claim against the paper. This is the only
   // positive non-author isAuthorized path in the suite (test 2 asserts
   // the negative gating for accredited non-authors without a claim).
   // A regression dropping the `claims.some(c => c.claimer === username &&
   // c.status === 'accepted')` check from isAuthorized would not be caught
   // by any other test.
   ```

When all 5 items are landed, `git mv` this file back to `tasks/review/`.

Dismissed at user triage (audit, not blocking): P3 `addresses_reviews` `length > 0` vs `toHaveLength(1)` (preemptive — no concrete signal of `toggleAddressedReview` regression risk); P3 `waitForEditorsMounted` no timeout arg (preemptive); P3 `errorMessage.toContain('No changes')` locale-fragile (test pins `/en/`); P3 `pickAccreditedResearcher` HAF-backpressure cascade (known tradeoff accepted on round-1); P3 latent discipline-field Alpine attribute trap "instance 3" (already noted in solutions doc as future-work).

**`/ce-compound` for the editor-ready gate pattern (`waitForEditorsMounted` + `setEditorContent` with Alpine-only-write + Tiptap mismatched-transaction trap)**: deferred to the next archive checkpoint when the task lands clean. The pattern is a non-obvious learning future agents could not reconstruct from code/docs alone (per learnings-researcher search), but per architect protocol the `/ce-compound` checkpoint is gated on Review→archive — invoke at archive time, not on hold.
