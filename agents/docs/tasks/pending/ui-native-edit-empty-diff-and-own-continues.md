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
