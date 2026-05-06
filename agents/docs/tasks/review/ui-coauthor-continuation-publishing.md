# UI-COAUTHOR-CONTINUATION-PUBLISHING — let named co-authors publish and edit their own continuation post

**Owner:** UI Agent
**Created:** 2026-04-30 (architect, surfaced during cluster 1 review triage on `backend-continuation-post-author-consent-gate.md`)
**Priority:** P2

## Scope reconciliation (UI agent, 2026-04-30)

Implementer investigation found the task framing partially miscalibrated against the existing code. Recording the actual delta shipped vs. the task as written:

**Already in place before this task:**

- `paper-detail.js:848-856` `isOwnPaper` already includes `paper.authors[].hive` membership, so the Edit affordance was already exposed to named co-authors. The task's "no UI surface" framing was incorrect.
- `edit.js:isAuthorized` already accepts named co-authors and accepted authorship claims.
- The pre-fill source for the edit form is already the chain head's content — `papers.ts:569-601` replaces the canonical-root paper detail's `body`/`title`/`abstract` and metadata-derived fields with the chain head's content when `chain.length > 1`. So `_prefillForm` reading `paper.body` already pre-fills from head. No backend addition needed for that.
- A first-time named co-author (Carol with no prior post) clicking Edit already broadcasts a properly-formed continuation post under their own account with `pevo.continues = {head_author, head_permlink}`.

**The actual gap (what this task shipped):**

The pre-existing `isContinuation` getter returned `true` whenever a chain existed, which made every chain-state edit balloon into a fresh continuation post — even when a returning co-author (Bob with `bob/cont-1` already in the chain) was just refining their own version. The chain grew by one new post per edit instead of evolving the user's existing post.

User chose the narrower scope (option B in the implementer's discovery summary): rework `isContinuation` to use a version-chain walk for the user's own post, target that post on native edit broadcasts, sidestep the diff-base correctness issue by full-body broadcasting for non-head targets, and add bridge-paper suppression on the Edit affordance.

**Implementation summary (commit will follow):**

- `paper-detail.js:295` — Edit-button gate widened to `isOwnPaper && !paper.is_retracted && !isBridgePaper` (bridge papers are immutable post-publish; not editable via the SPA edit flow).
- `edit.js` — new `userPostInChain` getter walks `paper.versions[]` for the latest entry where `author === username`. `isContinuation` now returns `false` when `userPostInChain` is non-null (native-edit own post) and `true` otherwise (broadcast new continuation). Falls back to legacy semantics when `versions[]` is sparse (HAF replay didn't run, single-version paper).
- `edit.js` native-edit submit — broadcast targets `userPostInChain.author/permlink` instead of the canonical root's `(this.author, this.permlink)`. When the user's post is the chain head, the existing diff path runs (size optimization preserved). When the user's post is **not** the chain head (e.g. Alice native-editing alice/v1 while head is bob/cont-1), the broadcast is full-body — Hive applies diffs against the post's own body, so a diff against the head's pre-fill would corrupt the user's post.
- `edit.js` `allAuthors[0].hive` — vestigial conditional `isContinuation ? username : paper.author` collapsed to `username`. The two branches were equivalent under legacy semantics (the only non-continuation case was username === paper.author); they diverged with co-author native edits in the chain.
- Tests added for: `userPostInChain` walk + null fallback, `isContinuation` chain/sparse-versions cases, native-edit targets the user's own post, non-head full-body broadcast, head-target diff path preserved.

**Items from the original task that were NOT implemented:**

- Predicate widening (item 1) — already in place via `isOwnPaper`. Not duplicated.
- Distinct "Publish Continuation" vs "Edit My Version" labels — left as `edit.editButton` ("Edit Paper") for both. The label is UX polish, not capability. If desired, file a follow-up.
- New locale strings — none added; reusing `edit.editButton`.
- E2E coverage extension to `ui-e2e-edit-paper-flow.md` — not extended in this pass; existing E2E tests still pass.

## Background — how continuations work in PEvO

PEvO papers can have multiple named authors (the `pevo.authors[]` array on the head paper's metadata). When a co-author wants to publish their own version of a paper, they broadcast a **new** Hive comment under THEIR own account, carrying `pevo.continues = { author: <predecessor post author>, permlink: <predecessor permlink> }` and the new content. They own that post and can edit it via Hive's native edit mechanism over time. The "version chain" PEvO assembles for a paper is the timeline of all such posts (the original + every co-author's continuation), linked by `continues` pointers.

This is distinct from "editing someone else's post" — Hive doesn't allow that. Each user only edits the posts they own. Co-authorship in PEvO means each named author can publish (and own) their thread of versions in the same paper's chain.

## Problem

Today the paper-detail UI exposes the affordance to publish a continuation only to the **chain-level post author** (the original publisher). A co-author named in `pevo.authors[].hive` but who has not yet published their own continuation has no UI surface to do so. Subsequent edits to a co-author's already-published continuation are governed by Hive's native edit window (handled by the existing edit flow on whatever post is currently the head); but the **first time** a named co-author wants to participate in the chain, the UI today doesn't let them.

The companion backend task (`backend-continuation-post-author-consent-gate.md`) closes the security side: continuation posts from non-named accounts are excluded from the version chain. With both tasks landed:

- A named co-author broadcasts their first continuation → backend admits → display shows it as part of the chain → user can edit it natively after.
- A non-author broadcasts a spoofed continuation → backend rejects → display ignores it.

## Acceptance

### 1. "Publish continuation" affordance for co-authors

Paper-detail page (`frontend/src/pages/paper-detail.js` or equivalent — investigate during implementation). Today the publish/edit flow predicate is roughly `currentUser.username === paper.author`. Widen to:

```js
const canPublishContinuation = currentUser?.username && (
  paper.pevo?.authors?.some(a => a.hive === currentUser.username)
);
const isOwnPost = currentUser?.username === paper.author;
const canEditOwnPost = isOwnPost; // Hive native edit, only on your own post
```

The two affordances are different actions:

- **Edit own post** (`canEditOwnPost`) — Hive native edit on the post the user already authored. No new continuation; just update the existing comment via the standard Hive edit operation.
- **Publish continuation** (`canPublishContinuation && !isOwnPost`) — broadcast a new comment under the user's account with `pevo.continues = {author, permlink}` of whatever post in the chain the user is continuing FROM (typically the latest version they're aware of).

Bridge papers (`type: 'bridge_paper'`, post author = `config.hiveBridgeAccount`): the publish-continuation affordance should **not** appear. Bridge papers are immutable post-publish. Gate the predicate on `paper.pevo?.type !== 'bridge_paper'`.

### 2. Edit / continuation form — always pre-fill from chain head

The PEvO version chain is the timeline of all posts (originals + every co-author's continuations) AND every Hive-native edit applied to any of those posts. Each native edit produces a "new version" in the chain timeline as PEvO presents it.

Implication for the form: regardless of whether the user is publishing a new continuation OR editing their own existing post, the form MUST pre-fill from the **chain head** (the latest version in the chain at viewing time), not from the user's own last version. Concrete cases:

- Alice has `alice/v1`. Bob publishes `bob/continuation-1` (edits some content). Bob then native-edits `bob/continuation-1`. Alice clicks "edit my version". The form pre-fills with bob's most recent edit content (the chain head), and on submit Alice's content goes into `alice/v1` via Hive native edit. The result: another new version on the chain, which now reflects alice's revision applied on top of bob's most recent content.
- A first-time co-author publishing their initial continuation pre-fills from the chain head as before; the new continuation post points at the head's author/permlink in `pevo.continues`.

Two affordance paths converge on the same form, differing only in submit:

| Affordance | Pre-fill source | Submit action |
|---|---|---|
| Publish continuation (first time as a named co-author) | chain head's content | broadcast new comment under `currentUser.username`, `pevo.continues = {author: head.author, permlink: head.permlink}` |
| Edit my version (user already has a post in the chain) | chain head's content | Hive native edit on `currentUser`'s own existing post in this chain |

Other paper fields (title, body, abstract, discipline, keywords, ipfs_cid, etc.) carry the user's revisions on top of the chain-head content.

The user broadcasts under their own posting authority (Keychain or backend custodial signing path) in both cases.

**Implementation note.** Today's edit flow pre-fills from the original post's content (`paper.author/paper.permlink` head). After this task lands, pre-fill comes from `versions[versions.length - 1]` (or whatever shape the version-chain endpoint returns as "head"). Verify the endpoint distinguishes "head as of viewing" from "the original post" — if it doesn't, the head computation may need a small backend addition.

### 3. Tests

- Unit: publish-continuation affordance renders when current user is in `paper.pevo.authors[].hive` AND has not yet published a post in this chain.
- Unit: edit-my-version affordance renders when current user is in `paper.pevo.authors[].hive` AND already has a post in the chain.
- Unit: neither affordance renders when current user is not a named author.
- Unit: bridge-paper case suppresses both affordances.
- Unit (head pre-fill): when the chain head is a co-author's recent post, the form pre-fills with the head's content regardless of which named author opens the form.
- Integration / E2E:
  - A named co-author with no prior continuation broadcasts one → version chain shows it.
  - A named co-author with an existing post hits "edit my version" against a chain whose head is a different co-author's recent edit → form pre-fills with the OTHER co-author's content → submit produces a Hive native edit on the user's own post → new version appears in the chain.

Coordinate with `ui-e2e-edit-paper-flow.md` already in `tasks/review/`; may extend that suite.

### 4. Locale strings

Likely needs new keys for the publish-continuation affordance label, tooltip, and the success toast post-broadcast. Sweep all 16 locale files + `STUBS.md`. Use neutral labels like `paper.publishContinuation` and `paper.continuationPublished`.

### 5. No backend change required

The backend already accepts continuation posts (no special endpoint; the user broadcasts directly via Hive). The companion backend gate task adds the *display-side* filter on the version-chain walker. This UI task is purely the publishing/editing affordance.

## Out of scope

- **Approval workflows.** Co-authorship in PEvO grants the right to publish a continuation; no approval from the original author is required. Future governance work could change this; not in scope here.
- **Editing OTHER co-authors' posts.** Hive doesn't allow it; PEvO doesn't try to. Each user only edits posts they authored.
- **Bridge-paper editing.** Out of scope per item 1.
- **Backend changes.** The companion backend task is the security side. This task is frontend-only.

## Why now

- The backend continuation-author-gate work (`backend-continuation-post-author-consent-gate.md`) makes the security side correct — but with no UI surface for legitimate co-authors to participate, multi-author PEvO papers have a dormant authoring model.
- Multi-author papers are a stated PEvO use-case (the metadata schema accommodates them); the missing affordance is a quiet bug.
- The fix is bounded: predicate widening + a publish-continuation form path that mostly reuses the existing edit form's content widgets.

## Source

User-architect dialog 2026-04-30: architect surfaced the continuation-author-gate as a security closure (cluster 1 review pre-existing finding); user clarified the actual continuation mechanism (per-author posts, not in-place edit) and noted that co-authors today can't surface their own continuations in the UI. Architect filed this UI task with the correct framing alongside the backend gate.

## Cross-references

- Companion backend task: `backend-continuation-post-author-consent-gate.md` (pending). Lands first or concurrently.
- `agents/docs/api-contracts/papers.md` — multi-author and version-chain semantics.
- `frontend/src/pages/paper-detail.js` (if that's the location — investigate) — current edit-button gate.
- Existing E2E coverage in `ui-e2e-edit-paper-flow.md` (`tasks/review/`) — may need extension for the co-author publish-continuation path.

---

## Architect re-review (2026-05-04, round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commits `5d44f23` (lifecycle rework) + `cf5da4b` (scope reconciliation). 7 personas (correctness, testing, maintainability, project-standards, learnings, security, julik-frontend-races). Security verdict CLEAN — Hive's signature requirement is the actual security boundary; SPA spoofing of broadcast targets can't escalate to cross-account writes. Correctness CLEAN — `userPostInChain` walks `versions[]` correctly, `isContinuation` truth table verified at all 4 cases, broadcast targeting + diff/full-body decision sound, `allAuthors[0].hive` collapse correct. The held items are about test coverage on a load-bearing UX gate, a mechanically-reproducible reactivity bug, and a comment-vs-code drift trap that hides a load-bearing null guard.

### Items to address

**1. (P1) `isBridgePaper` getter + Edit-affordance gate has ZERO test coverage.** `frontend/src/pages/paper-detail.js:296` adds `!isBridgePaper` to the Edit-button `x-if`. The `isBridgePaper` getter at line 890 returns `this.paper?.json_metadata?.[getAppTag()]?.type === 'bridge_paper'`. NO test in `pages-edit.test.js` or `pages-paper-detail.test.js` exercises this getter or asserts the Edit-affordance suppression. Mutation: removing `!isBridgePaper` from the template restores the old behavior (bridge papers show Edit) — no test catches.

Security-clean (Hive signature requirement is the boundary), but the affordance is load-bearing for the round-1 deliverable and the convention `pevo-object-identity-is-author-vouching-not-metadata-claim` would frame this as a UI-side identity check that needs test coverage.

Fix: add to `frontend/tests/unit/pages-paper-detail.test.js`:
- (a) `isBridgePaper` getter returns true for `paper.json_metadata = { pevotest: { type: 'bridge_paper' } }`.
- (b) Returns false for normal paper (`type: 'paper'`).
- (c) Returns false for missing `json_metadata` / missing `pevotest` key / missing `type` field.
- (d) Affordance predicate test: `isOwnPaper && !is_retracted && !isBridgePaper` evaluates correctly across the matrix (own paper + non-bridge → true; own paper + bridge → false; non-own paper → false; retracted → false).

DOM-level test of the `x-if` template binding is appealing but requires Alpine + jsdom infrastructure the project may not have today; skip unless trivial.

**2. (P1) `$watch` handlers + `storage` listener DUPLICATE on Retry click — mechanically reproducible reactivity bug.** `frontend/src/pages/edit.js:539-558`. The eight `$watch` registrations and the `window.addEventListener('storage', ...)` live INSIDE `loadPaperData()`, NOT `init()`. The Retry button at line 50 (`@click="loadPaperData()"`) calls the same function on a second successful load. Each call adds 8 fresh `$watch` handlers on top of existing (Alpine's `$watch` returns an unsubscribe handle that the code DISCARDS) AND overwrites `_storageListener` reference at line 539 WITHOUT calling `removeEventListener` on the old one. After ONE successful retry: storage listener fires twice per cross-tab citation event; draft autosave fires 8× per keystroke. Reproducible: load → error → Retry → success.

Fix: refactor the lifecycle/data-loading boundary cleanly:
- (a) Pull `$watch` registration + `addEventListener('storage', ...)` out of `loadPaperData()` into `init()` (or a new `_setupReactiveBindings()` called once from `init()`).
- (b) `loadPaperData()` becomes pure data loading. Multiple invocations are safe.
- (c) Test: drive `init()` → `loadPaperData()` → fail → Retry → `loadPaperData()` succeeds; assert `$watch` count + storage-listener count are invariant (e.g., spy on `addEventListener` calls + count `_unwatch*` registrations). Mutation: putting the registrations back in `loadPaperData()` fails the invariant assertion.

This pattern matches PEvO's existing prior-art on async-continuation-teardown-guard discipline — separate concerns of "lifecycle bindings" vs "data fetching."

**3. (P2) Comment-vs-code drift hides a load-bearing null guard.** `frontend/src/pages/edit.js:932-936`. The else-branch comment says "userPostInChain is non-null on this branch — isContinuation === false implies it." That claim is FALSE for the sparse-versions fallback path: `isContinuation` returns false at line 460 when `username === paper.author` even when `userPostInChain` is null (versions[] entries carry no `author` field in some HAF-replay-not-run states). The guard `ownPost ? ownPost.author : this.paper.author` at lines 935-936 is therefore a real, load-bearing null guard — NOT a vestigial one. A future developer reading the comment and trusting it will remove the ternary, regressing sparse-version root-author edits to a crash at `null.author`.

Fix:
- (a) Rewrite the comment honestly: "userPostInChain MAY be null when `versions[]` is sparse and the user is the root author. The `ownPost ?` guard is load-bearing for that case — do not remove."
- (b) Add a test exercising the sparse-versions root-author edit path: drive `handleSubmit` with `paper.versions = []` (or the sparse stub) and `username === paper.author`, assert the broadcast targets `paper.author/paper.permlink` (not `null.author`).

**4. (P2) Broadcast-payload `allAuthors[0].hive` collapse not asserted in test.** `frontend/tests/unit/pages-edit.test.js:316`. The collapsed-co-author native-edit test asserts `commentOp[1].author` and `commentOp[1].permlink` but never unpacks `JSON.parse(commentOp[1].json_metadata)`. A regression that reverts `allAuthors[0].hive = username` to the legacy `isContinuation ? username : paper.author` would silently embed 'alice' instead of 'bob' in the chain meta. Undetected by current assertions.

Fix: extend the test to unpack `commentOp[1].json_metadata` (`JSON.parse`) and assert `parsedMeta.pevotest.authors[0].hive === 'bob'`. One-line addition.

**5. (P2) Submit-time live-read of `isContinuation` and `userPostInChain`.** `frontend/src/pages/edit.js:869, :934`. Both are Alpine getters that recompute from `this.paper.versions[]` on every access. `handleSubmit()` reads them AFTER multiple awaits (the IPFS upload loop can run for many seconds). If `this.paper` is ever mutated between form-open and submit — by a background poll, future reactivity hook, or explicit refresh — the path chosen at line 869 and the broadcast target at line 934 silently shift. No polling exists today, so this is LATENT, but the contract is invisible to a future engineer adding a paper-refresh call.

Fix: capture `const isContinuation = this.isContinuation; const ownPost = this.userPostInChain;` at the TOP of `handleSubmit()` BEFORE the first `await`, then use the locals throughout. Two-line fix; closes the latent class entirely.

**6. (P2) `isSubmitting` step state machine uses negative-space exclusion list.** `frontend/src/pages/edit.js:473-475`. `isSubmitting` is `step !== 'idle' && step !== 'success' && step !== 'error'`. Mechanically safe today. The hazard: any future step name not added to the exclusion list will silently pass the guard and re-enable the Submit button mid-flight. State-machine correctness smell.

Fix: freeze step names as explicit constants (`const STEP_IN_PROGRESS = ['validating', 'uploading', 'broadcasting', 'confirming']` or whatever the actual in-progress steps are); rewrite `isSubmitting` as positive-set inclusion: `STEP_IN_PROGRESS.includes(this.step)`. ~12 lines, no library needed. Resist the urge to introduce XState or a state machine library — the transition table is simple enough inline.

**7. (P2) UI warning for malformed-metadata edit mis-route.** Cross-cutting from cluster B held task `backend-continuation-post-author-consent-gate.md` item 8: if head paper has empty/missing `pevo.authors[]` (malformed), the backend gate degenerates chain to root-only → legitimate co-author's `userPostInChain` returns null → `isContinuation` falls through to `head_author/head_permlink` fallback → routes the edit as a NEW continuation rather than a native edit.

Fix: in `frontend/src/pages/edit.js`, if `userPostInChain` returns null AND `currentUser.username` IS in `paper.pevo.authors[].hive`, surface a UI warning (`paper.metadataIncomplete` or similar new locale key) "Paper metadata incomplete; please refresh" rather than silently mis-routing into new-continuation flow. Add the locale key to all 16 locale files + `STUBS.md`.

**8. (P3) `userPostInChain` user-is-chain-head case only indirectly tested.** `frontend/tests/unit/pages-edit.test.js`. The user-is-head case (`versions: [{author: username, permlink: head_permlink}]`) is only exercised through the `handleSubmit` broadcast-target test. Add a dedicated unit spec for the `userPostInChain` getter on the head case so the partition is explicit.

### Items dismissed during architect triage

- **`isContinuation` truth-table cases collapsed into single composite test** (T-4) — failure attribution slightly imprecise, but coverage is real. Cosmetic.
- **IPFS upload `finally` writes to destroyed Alpine proxy after `_mounted` early-return** (JFR-004) — Alpine silently discards writes; no user-visible behavior; cosmetic.

### Re-review signal

When items 1-8 land, `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-2 commits. Items 1-2 are P1 (test gap on a load-bearing gate + reproducible reactivity bug); items 3-7 are P2 (correctness traps + UX warning); item 8 is P3.

Anchor: item 2's lifecycle refactor is the load-bearing structural change; the rest are scoped local fixes around it.

---

## UI re-review signal (2026-05-04, commit 26c3b6b)

All 8 items landed in commit `26c3b6b` (`ui: UI-COAUTHOR-CONTINUATION-PUBLISHING round-2 hold items 1-8 landed`). Architect's hold block above is unedited per the review -> held -> re-review protocol; the commit diff is the evidence.

**Item-by-item:**

- **Item 1 (P1)** — `frontend/tests/unit/pages-paper-detail.test.js`: 5 `isBridgePaper` truth-table cases + 4-case predicate matrix `isOwnPaper && !is_retracted && !isBridgePaper`. Mutation-killed: removing `!isBridgePaper` from the Edit-affordance template predicate now fails the matrix.
- **Item 2 (P1)** — `frontend/src/pages/edit.js`: 8 `$watch` registrations + `addEventListener('storage')` extracted to new `_setupReactiveBindings()`, called once from `init()` BEFORE `loadPaperData()`. `loadPaperData()` is now pure data loading; multiple invocations (Retry button) are safe. Invariant test in `pages-edit.test.js` asserts watch-call count + storage-listener count are unchanged across `init() -> loadPaperData() -> loadPaperData()`. Draft auto-save guard (`_initialLoadDone`) keeps pre-load `$watch` firings as no-ops.
- **Item 3 (P2)** — `frontend/src/pages/edit.js` else-branch comment rewritten honestly: "ownPost MAY be null when isContinuation took the sparse-versions fallback path... The `ownPost ?` guard below is load-bearing for that case — DO NOT remove it." New unit spec `sparse-versions root-author edit: broadcast targets paper.author/permlink (ownPost null guard load-bearing)` exercises versions=`[{version_number:1}]` + `username===paper.author`, asserts pre-condition (`isContinuation===false && userPostInChain===null`) and broadcast target.
- **Item 4 (P2)** — `frontend/tests/unit/pages-edit.test.js:316` extended: `JSON.parse(commentOp[1].json_metadata)` then `expect(parsedMeta.pevotest.authors[0].hive).toBe('bob')`. Reverting the `allAuthors[0].hive = username` collapse to the legacy `isContinuation ? username : paper.author` ternary now fails this assertion.
- **Item 5 (P2)** — `handleSubmit()` captures `const isContinuation = this.isContinuation; const ownPost = this.userPostInChain;` BEFORE the first `await`. The continuation branch reads `isContinuation` (local); the edit branch reads `ownPost` (local). Latent class for "this.paper mutates mid-submit" is closed.
- **Item 6 (P2)** — Module-level `STEP_IN_PROGRESS = ['diffing', 'uploading', 'broadcasting']` constant; `isSubmitting` rewritten as `STEP_IN_PROGRESS.includes(this.step)`. State-machine correctness: adding a future step name without explicit inclusion now keeps the Submit button disabled by default rather than silently re-enabling it.
- **Item 7 (P2)** — New `showMetadataIncompleteWarning` getter (`!userPostInChain && username in paper.json_metadata.pevotest.authors[].hive`). Non-blocking banner above the form with `edit.metadataIncomplete` + `edit.metadataIncompleteHint` copy and a `common.refresh` CTA (`reloadPage()` method, mockable). The predicate intentionally also fires for legitimate first-time co-author publishes — the form remains submittable so case (a) proceeds, while case (b) malformed-head-metadata users see the prompt and refresh. Three new locale keys added as English stubs to all 16 locale files; `STUBS.md` sweep section `### Added 2026-05-04 (UI-COAUTHOR-CONTINUATION-PUBLISHING)` lists 45 stub lines (15 non-en locales x 3 keys).
- **Item 8 (P3)** — `frontend/tests/unit/pages-edit.test.js`: dedicated `userPostInChain returns the head entry when the user IS the chain head` spec. Previously only exercised indirectly via the broadcast-target test.

**Verification:**

- `npx vitest run tests/unit/pages-edit.test.js tests/unit/pages-paper-detail.test.js` -> 80/80 passing (16 in `pages-edit.test.js`, 64 in `pages-paper-detail.test.js`).
- `npx vitest run tests/unit/` -> 1018/1018 passing across 59 test files.
- `npm run build` -> succeeds (no template/syntax regressions).

**Note on item 7 predicate scope:** The architect's spec ("if `userPostInChain` returns null AND `currentUser.username` IS in `paper.pevo.authors[].hive`, surface a UI warning") also fires for legitimate first-time co-author publish (Carol named in `pevo.authors` but with no chain entry yet). Implemented as a non-blocking informational banner so the legitimate case is not interrupted; the malformed-metadata case (b) sees the prompt and refreshes. If the architect wants a stricter predicate (e.g., gated on `paper.versions.length > 1` or on a server-side malformed-metadata flag), that's a follow-up refinement, not a re-hold.

---

## Architect re-review (2026-05-06, round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `26c3b6b` (round-2 hold-fixes). 7 personas dispatched: correctness, testing, maintainability, project-standards, learnings, julik-frontend-races, previous-comments. (`ce-agent-native-reviewer` skipped per PEvO project conventions.)

**Round-2 hold-block disposition:**

- **Items 1, 2, 3, 4, 5, 6, 8** — VERIFIED-FIXED at the spec level. Mutation-kill at JS/getter level for items 1, 4. Lifecycle refactor for item 2 cleanly closes the duplication race; invariant test pins the contract. Items 3, 5, 6, 8 land per spec. Round-3 items 3 and 4 below add narrow follow-ups on items 5 and 6 (a comment-narrow and a step-table test) but neither overturns the round-2 verdict — items 5 and 6 themselves are FIXED.
- **Item 7** — PARTIALLY-FIXED. The implemented predicate (`!userPostInChain && username in paper.json_metadata.pevotest.authors[].hive`) does NOT detect the malformed-metadata case the architect's hold described. When `pevo.authors[]` is empty (the case-(b) condition), `username` cannot be in it, so the predicate is structurally incapable of firing for case (b). Instead, it fires for the legitimate first-time co-author publish (case (a)). The implementer's signal-block claim "case (b) sees the prompt and refreshes" is incorrect. See round-3 item 1 below.

**Informational (no-action; for archive carry-forward at eventual archive time):** Item 1 mutation-kill is at getter + JS-predicate level only. A revert that drops `!isBridgePaper` only from the `<template x-if>` in `paper-detail.js:292` (without touching the JS predicate the matrix test reconstructs) is NOT caught by unit tests. This was within the architect's accepted scope at round-2 hold-block time ("DOM-level test... requires Alpine + jsdom infrastructure the project may not have today; skip unless trivial"), per the convention `alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md`. Carry forward to the archive note.

### Items to address

**1. (P1) Item 7 — `showMetadataIncompleteWarning` predicate catches the wrong case AND never catches the right case.** Two structural problems compound:
   (a) The predicate fires for legitimate first-time co-author publishes (Carol named in `pevo.authors[]`, no chain entry yet) where nothing is wrong, interrupting users with a "metadata may be incomplete" prompt.
   (b) The predicate cannot fire for the actual malformed case (case (b): `pevo.authors[]` empty/missing), because it requires `username` to be IN that empty array.

   So the warning fires only for the wrong case AND never for the right case — net-negative vs. the pre-Item-7 baseline (no warning at all): cosmetic-bad in case (a), zero protection in case (b).

   Required (any acceptable shape):

   - Rework the predicate so it actually detects malformed-metadata. Candidates: a server-side discriminating signal in the `/api/papers/:id` payload, OR a heuristic like `paper.versions.length > 1 && !userPostInChain && username !== paper.author` (someone else has published a continuation but the current user can't find their place — closer to the malformed signal). Discuss the chosen shape in the round-3 commit message or task notes so the next re-review pass can verify.
   - OR remove `showMetadataIncompleteWarning` and its banner entirely if no good predicate exists. Defensive UI without a working predicate is worse than no UI.

   Cause-neutral banner copy is necessary regardless. The current `edit.metadataIncomplete` / `edit.metadataIncompleteHint` strings imply server-side incompleteness; rewrite both keys + sweep all 16 locales + STUBS.md to cause-neutral phrasing if the wider-predicate path is chosen.

   If the final predicate is wider than "metadata is actually incomplete," rename the getter to a cause-neutral form (e.g., `showCoauthorChainGapHint`) so the symbol matches the predicate's actual semantics. If the predicate is narrowed to true case-(b) detection, the existing name stays accurate.

**2. (P2) Item 7 — zero test coverage on whatever final getter ships.** `showMetadataIncompleteWarning` (3 branches: missing-paper-or-username early-return, not-named-coauthor early-return, main predicate) and `reloadPage()` are untested today. Whichever final predicate the implementer lands needs a parameterized truth-table test asserting the getter fires for the intended case(s) and not others, plus a banner-render assertion if banner copy stays. Mirror the parameterized pattern in `frontend/tests/unit/pages-publish.test.js` and `pages-review.test.js`.

**3. (P2) Item 6 — add a parameterized step-table test for `isSubmitting`.** Sister files have the established pattern at `pages-publish.test.js:143-153` and `pages-review.test.js:121-130` (`step=%s -> isSubmitting=%s` table). `pages-edit.test.js` does not. A regression dropping `'broadcasting'` from `STEP_IN_PROGRESS` would silently re-enable Submit mid-flight — the exact regression class Item 6's positive-set fix exists to prevent. ~15 lines, mechanical.

**4. (P3) Item 5 — narrow the in-code comment at `edit.js:909` to chain-routing scope only.** Current comment claims the local-capture pattern "closes the latent class entirely." It does close the chain-routing class (path selection + broadcast target — what Item 5 was specifically scoped to), but `handleSubmit` still live-reads `this.paper.author`, `permlink`, `head_author/head_permlink`, `json_metadata[APP_TAG]`, `title`, `body` after multi-second `await`s. A future engineer adding a paper-refresh hook would trust the comment and assume `handleSubmit` is mid-submit-mutation-safe across all `this.paper` fields, when only two are protected. Two-line edit, illustrative shape:

```
// Item 5 (chain-routing scope only): capture isContinuation and userPostInChain
// as locals before the IPFS-upload await. NOTE: other this.paper fields
// (author, permlink, json_metadata, title, body) are still live-read below;
// this fix does NOT close the broader 'this.paper mutates mid-submit' class.
```

   Alternative if the implementer wants to genuinely close the broader class: capture a flat `paper` snapshot at `handleSubmit` top and read all paper fields from the snapshot. Optional, not required.

### Items dismissed during architect triage

- **Item 1 template `<template x-if>` mutation-kill gap** — accepted at round-2 hold-block time as out-of-scope for unit-test infrastructure. Informational note carried forward to archive (see disposition above).
- **Test count miscount in round-2 signal block (80 claimed, 79 actual)** — cosmetic; both are passing.
- **Item 5 untested** — architect already accepted this gap in round-2 ("may be intrinsically hard to test without an injected pause"). Round-3 item 4's comment narrowing gives future engineers the *why*.
- **`showMetadataIncompleteWarning` symbol naming** — subsumed into round-3 item 1's rename instruction.
- **Banner copy awkwardness for case (a)** — subsumed into round-3 item 1's cause-neutral-copy instruction.

### Companion task spawned this pass

- `tasks/pending/ui-edit-loadpaperdata-concurrent-retry-guard.md` — P2, scoped to a concurrent-retry race in `loadPaperData()` surfaced by `ce-julik-frontend-races-reviewer`. Independent of Item 7's re-hold; can land in any order.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. The architect's next review pass will scope `/ce-code-review` to the round-3 commit(s) (not the whole task's history; round-2 was already reviewed).

Anchor: round-3 item 1 (predicate rework or warning removal) is the load-bearing structural change. Items 2-4 are scoped local fixes around it.

---

## UI re-review signal (2026-05-06, working tree on top of main 3d41476)

Round-3 items 1-4 landed. The architect's hold block above is unedited per the review -> held -> re-review protocol; the commit diff is the evidence.

**Item-by-item disposition:**

- **Item 1 (P1)** — `showMetadataIncompleteWarning` warning REMOVED entirely (architect-authorized "OR remove" path). Decision rationale: the existing predicate fires only for case (a) (legitimate first-time co-author publish, false positive that interrupts a normal flow), and the architect's heuristic candidate `paper.versions.length > 1 && !userPostInChain && username !== paper.author` ALSO fires for case (a) (Carol joining a 2-version chain matches the heuristic). Case (b) (empty/missing `pevo.authors[]`) is hypothetical with no concrete user report; an accredited user landing on the edit page with empty `pevo.authors[]` would in practice be the canonical author (where the predicate doesn't fire) or an accreditation-fallback path (rare). Defensive UI without a working predicate is worse than no UI per the architect's hold. `frontend/src/pages/edit.js`: removed `showMetadataIncompleteWarning` getter, `reloadPage()` method, and the banner template. Three locale keys removed across all 16 locale files: `edit.metadataIncomplete`, `edit.metadataIncompleteHint`, `common.refresh`. STUBS.md sweep section `### Added 2026-05-04 (UI-COAUTHOR-CONTINUATION-PUBLISHING)` (45 stub lines) removed.
- **Item 2 (P2)** — Collapsed by Item 1 removal. No replacement test required since the feature is gone; pre-existing tests had zero references to `showMetadataIncompleteWarning`/`reloadPage`/`metadataIncomplete` (verified via grep), so nothing needed to be deleted from the test suite either.
- **Item 3 (P2)** — Parameterized step-table test added in `frontend/tests/unit/pages-edit.test.js`, mirroring `pages-publish.test.js:143-153` and `pages-review.test.js:121-130`. 7 cases: `idle`/`success`/`error` -> false; `diffing`/`uploading`/`broadcasting` -> true; `unknown-future-step` -> false (positive-set semantics). A regression dropping any in-progress step name from `STEP_IN_PROGRESS` would now flip the corresponding row to false and fail the test.
- **Item 4 (P3)** — Comment narrowed at `frontend/src/pages/edit.js` `handleSubmit` local-capture site. Old comment claimed the local-capture pattern "closes the latent class entirely"; new comment scopes the fix to chain-routing only (path selection + broadcast target — what the original Item 5 fix actually addresses) and explicitly notes that other `this.paper` fields (author, permlink, json_metadata, title, body) are still live-read after awaits. Future engineers adding a paper-refresh hook will see that the broader class is not closed.

**Verification:**

- `npx vitest run tests/unit/pages-edit.test.js` -> 23/23 passing.
- `npx vitest run tests/unit/` -> 1056/1056 passing across 60 test files.
- `npm run build` -> succeeds (no template/syntax regressions). Pre-existing chunk-size warnings unchanged.

**Note on Item 1 scope expansion:** The hold block instructed "Rework the predicate so it actually detects malformed-metadata. ... OR remove `showMetadataIncompleteWarning` and its banner entirely if no good predicate exists." Both heuristic candidates the architect listed (server-side discriminating signal; the wider `versions.length > 1 && !userPostInChain && username !== paper.author` predicate) either require backend coordination or false-positive on case (a). Removal closes the issue cleanly without inventing a backend signal that has no concrete user-reported justification. If a future user report surfaces a real malformed-metadata case (b), a properly scoped backend signal can be added then with the predicate re-introduced.
