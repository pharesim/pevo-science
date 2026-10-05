# A native edit never sends an empty body, and never copies another post's `continues`

**Owner:** ui
**Created:** 2026-10-01
**Priority:** high

Two defects in the native-edit arm of `handleSubmit` in `frontend/src/pages/edit.js`, found
while deciding the composer retry-safety question. Neither depends on any other task. Read
`agents/docs/ARCHITECTURE.md` § 8, "What a native edit sends".

## Why

1. **An unchanged body is sent as `''`, and Hive rejects it.** On a head target the arm sends
   `broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText`, and
   `computeDiff(a, a)` is `''`, so the empty string wins. hived's `comment_operation::validate`
   rejects an empty body ("Body is empty"), and nothing between the page and the node checks
   first. Measured with the real page: a title-only native edit broadcasts `body: ""`. The
   no-change guard does not stop it whenever another field changed, and it is skipped outright
   when supplementary files or addressed-review ticks are present, so attaching a file to one's
   own paper, or ticking the reviews a revision addresses without touching the text, also sends
   `''`. Every such edit ends in "Edit failed". Addressing reviews is a core PEvO flow.
2. **A native edit on a non-head post writes the head's `continues` onto its target.** The
   arm builds its metadata from `...pevoMeta`, where `pevoMeta` is
   `this.paper.json_metadata?.[APP_TAG]`, the metadata of the latest op across the chain. When
   the root author edits the root after a co-author's continuation became the head, that
   metadata is the continuation's, so the root's new op carries `continues` pointing at the root
   itself (measured with the real page). By read: `resolveContinuationChain` then finds the root
   as its own continuation, stops at its cycle guard and returns the root alone, and every
   listing, search, profile and reputation query filters `continues IS NULL`, so the paper drops
   out of all of them. No continuation exists on chain yet, so this has not happened; it will on
   the first non-head edit after one does.

## Scope

1. **No-op patch for an unchanged body.** When the patch computed for a head target is empty,
   send `@@ -0,0 +0,0 @@\n`. It was measured to leave the body unchanged in the backend's and
   frontend's `diff-match-patch` and in hivemind's pinned Python port (bases of 0, 1, 47 and
   70000 chars, and one with a non-BMP character). Leave the other branches of the send rule
   alone; the full-body cases in § 8 belong to a later task.
2. **A native edit's `continues` is its target's own.** Absent when the target is the root; for a
   continuation post, the post it already continues. Never the head's. The spread of the rest of
   `pevoMeta` (the paper-level fields such as the current IPFS document) can stay. The target's
   own predecessor is derivable from the chain order in `versions[]`, or readable from the
   target's last version through `fetchPaper(canonical, canonicalPermlink, <version_number>)`;
   pick one and say which in the signal block.

## Out of scope

- The full-body fallbacks, the diff base, retries and the head check in § 8. A later task covers
  them, after the backend serves the replayed body. Do not send the full body for the empty case:
  until that backend task lands, the form holds the creation body, and a full body built from it
  would silently revert every earlier edit.
- The continuation arm's own metadata (it sets `continues` to the head deliberately).

## Acceptance criteria

1. A head-target native edit whose body is unchanged broadcasts exactly `@@ -0,0 +0,0 @@\n`:
   for a title-only change, a supplementary-file-only change, and an addressed-reviews-only
   change.
2. A head-target native edit that changes the body still broadcasts a patch; the existing
   `head-author native edit still computes diff` spec stays green.
3. A non-head native edit's broadcast metadata carries no `continues` when the target is the
   root, and carries the target's own predecessor when the target is a continuation post. Change
   the fixture the non-head specs use (unit, and `frontend/tests/e2e/edit-paper.spec.js`) so the
   head's metadata carries a `continues`, so the assertion can fail.
4. Each assertion is probed by reverting its own site; list the probes in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## Implementation notes

**UI implementation signal (2026-10-05, commits `6e10bd5e`, `62812370`, `4648252e`, `bdefe550`; follow-up tasks `0498a574`, `59018357`; each verified an ancestor of `main` with the expected file list):**

- `6e10bd5e`: the fix, the new unit specs, and the e2e fixture change. `62812370`: the head-target continues spec reshaped to cover a root version listed between two continuations. `4648252e`: the seven `form button[type="submit"]` locators in `edit-paper.spec.js` scoped to `[x-data="editPage"] form button[type="submit"]` (user-approved fold-in: the always-rendered re-auth modal form made all seven specs fail at the click or at `toHaveCount(0)`, so the AC3 e2e assertion was never reached). `bdefe550`: the fixes from the review below.
- Scope 1 / AC1-2: the head-target branch sends `NO_OP_PATCH` (`@@ -0,0 +0,0 @@\n`) when `computeDiff` returns `''`; every other branch of the send rule is unchanged. Unit specs cover a title-only, a supplementary-file-only and an addressed-review-only edit. The `head-author native edit still computes diff` spec stays green and now also asserts the patch carries the change (`toContain('TWEAK')`), since the no-op patch also starts with `@@`; the e2e in-place spec gained the same check (`toContain('drift detection')`).
- Scope 2, the choice: the target's `continues` is derived from the chain order in `versions[]`, not read through `fetchPaper(..., version_number)`. `targetOwnContinues` puts the canonical root first (it continues nothing), then the other posts in the order of their first version, and returns the post before the target. When the response holds one post (a fork of an already-continued head, or a continuation whose PEvO block another frontend stripped, both served as papers of their own), the served metadata is that post's own, so its served `continues` is kept. Chosen for no network read, and no new failure path, inside the submit. The rule applies to every native edit, head or not: with the head excluded, a head continuation edited after a later root edit would have lost its `continues`, since the served metadata is then the root's.
- AC3: the unit non-head spec's served metadata is now parsed and names `continues`, and asserts the root sends none. New unit specs: a non-head continuation target sends its own predecessor; a head continuation target keeps its predecessor when the latest op is the root's (with a root version listed between two continuations); a continuation served on its own keeps its served `continues`; with a link whose first version is older than the root's, the root sends none and the link names the root. The e2e non-head fixture's served metadata now names `continues`.
- AC4 probes (unit probes in scratchpad copies of `bdefe550`, `tests/unit/pages-edit.test.js`, baseline 137 passed):
  - no-op site reverted to the old ternary: the three unchanged-body specs fail, nothing else;
  - `NO_OP_PATCH = ''`: the same three fail;
  - the else branch always sends `NO_OP_PATCH`: only `head-author native edit still computes diff` fails (on `TWEAK`);
  - `continues: targetContinues || undefined` deleted: the root non-head, continuation non-head, head-target and inverted-root specs fail (the fork and inverted-link specs pass because the served metadata happens to carry the right value there);
  - single-post branch deleted: only the fork spec fails;
  - canonical-root-first removed (`posts = []`): only the two inverted-chain specs fail;
  - de-duplication removed: the head-target spec and the fork spec fail.
  - E2E: with the `continues` line removed, the non-head spec fails at `expect(meta[APP_TAG].continues).toBeUndefined()`, receiving the root as its own `continues`; unmutated it passes (both served by vite dev from scratch copies carrying the backend's `__PEVO_CONFIG__`).
- AC5: the new comments anchor on `targetOwnContinues`, `NO_OP_PATCH` and the specs' fixtures; the commits passed the pre-commit anchor gate.
- Verification: full frontend unit suite 91 files / 2149 passed, exit 0. E2E on the final tree (`./deploy.sh restart`, `test-db-up`, `test-up`; dev routing restored after): `edit-paper.spec.js` 7/7 passed from the repo checkout. A scratch-only browser check (not committed) confirmed a title-only and an addressed-review-only head edit send the no-op patch on the real page.
- Review (verification workflow: mutation probes plus chain, send-rule and conventions lenses, one refuter each), triaged by the user, all as recommended:
  1. Fixed in `bdefe550`: a continuation post served as a paper of its own lost its `continues` under the first derivation (it read as a root).
  2. Fixed in `bdefe550`: the head-diff unit and e2e specs could not tell a real patch from the no-op patch.
  3. Fixed in `bdefe550`: a link re-pointed onto the chain by a hand-made op, older than the root, made the root's own edit write a cycle; the root now always reads first.
  4. Fixed in `bdefe550`: the e2e non-head spec's opening comment called the edited post a continuation; the fixture makes it the root.
  5. Filed as `ui-edit-no-change-guard-compares-served-authors` (normal, `0498a574`): the no-change guard compares the form with the raw head claim, so an untouched form whose served authors differ from it now lands a metadata-only version instead of failing.
- Residual, filed at the user's choice as `ui-native-edit-continues-from-target-own-metadata` (low, `59018357`): a link re-pointed onto the middle of a chain by a hand-made op reads out of order, so another author's edit of a continuation can name the wrong predecessor. The root and the listing are protected.
