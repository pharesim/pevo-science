# A composer landing waits for the index, and a native edit diffs against the body the chain holds

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

Implements, from `agents/docs/ARCHITECTURE.md` § 8 ("Composer Drafts"), item 4 of "Landing is
terminal" and "What a native edit sends" except its first rule (the retry window, which a later
task adds). Read § 8 and § 2 "Body, edits and versions" first; they are the contract this task
is reviewed against.

## Why

Measured on 2026-09-30 and 2026-10-01.

- **The composer's own landing re-caches the pre-edit paper for 30 minutes.** `_finishLanded`
  invalidates and navigates 1.5 s after the broadcast resolves. The broadcast resolves on node
  acceptance, before the block exists, so in most custody edits (73 to 90 %, by arithmetic on the
  measured lag) the paper page's first read precedes the index and refills the cache with the
  old paper.
- **The diff base is not the chain body for 3 of 5 roots.** `_prefillForm` strips a leading
  `## Abstract` heading and `composePostBody` puts a canonical one back, so a body that lacked it
  (both bridge posts and the edited whitepaper) gets a 13 to 14 character prefix the chain never
  held, and a variant heading is rewritten. Separately, the editor wrapper re-serialises some
  markdown (lists) on the first transaction, so an untouched form does not reproduce a
  list-bearing body: a title-only edit of such a paper would send a patch rewriting the body's
  formatting instead of the no-op patch.
- **Some patches are placed elsewhere by hivemind.** JavaScript counts patch offsets in UTF-16
  units and hivemind's Python port in code points; with enough characters outside the Basic
  Multilingual Plane ahead of an edit (measured from about 500), hivemind misplaces or drops a
  correct patch, and every other Hive frontend shows a different body from PEvO. `computeDiff`
  also throws on some non-BMP edits, which today ends in "Edit failed" on every retry.
- **Files are re-uploaded on every submit** (CIDs are `handleSubmit` locals), under a limit of 10
  uploads per account per hour.
- **Repeats** (§ 2) no longer outdate reviews once the backend ships `current_version`; the
  frontend still compares against the last version entry.

## Scope

Depends on `backend-paper-body-from-replay-and-head-endpoint` (the replayed detail body, the head
endpoint, `current_version`). The editor-baseline item below is shared with
`ui-composer-drafts-bound-to-account-and-head`.

1. **Landing waits for the index** (both pages). Before the invalidation and the navigate, poll
   `GET /api/papers/:author/:permlink/head` about once a second, for at most about 15 s, until it
   shows the landed op: on the edit page a `head_marker` different from the loaded one and
   `indexed: true`; on the publish page `exists: true` and `indexed: true` for the new post. Then
   invalidate (edit page only; the publish page has no cached entry to evict) and navigate. Keep
   the broadcasting label during the poll (no new copy). On timeout or a failed read, invalidate
   and navigate anyway: best effort, per item 4 of "Landing is terminal".
2. **The diff base is the served chain body.** Keep `paper.body` as served (the replay, after the
   backend task) as the diff base and the full-body source. Recompose the form losslessly
   (remember the served heading text and separator). While both editors still hold their
   post-mount baseline, use the served abstract and body text as they are, so an untouched form
   reproduces the served body byte for byte. The baseline is the one the draft-binding task
   introduces (its Scope 2 says how it must be taken); if that task has not landed when this one
   starts, introduce it here to the same rule, and whichever lands second reuses the first's.
3. **The send rule** (native arm), in the order § 8 states, without its first rule:
   an unchanged body sends the no-op patch (as today, whatever characters the body holds);
   otherwise `computeDiff` throwing, or a base or new body containing a character outside the
   Basic Multilingual Plane, sends the full body; otherwise the existing fallbacks (a non-head
   target, a patch not shorter than the body) send the full body; otherwise the patch.
4. **CIDs.** Reuse the CIDs this instance already uploaded, per `File` object, on a resubmit.
5. **`current_version`.** Wherever the frontend compares a version with the latest one (for
   example `voteIsOutdated` in `frontend/src/components/vote-buttons.js`), compare with the
   payload's `current_version`, so a repeat does not outdate anything.

## Out of scope

- The retry window, the attempt marker, the kept permlink and the head check before a submit
  (`ui-composer-retry-safety`, blocked behind this task).
- How the version selector displays a repeat entry.

## Acceptance criteria

1. The landing waits for the head endpoint and then invalidates (edit page) and navigates; a
   poll that never sees the op still navigates within the bound.
2. An untouched form recomposes byte-identically for a body with the canonical heading, without
   it, with a variant heading, and for a list-bearing body with the real editors mounted.
3. A title-only edit of a list-bearing paper sends the no-op patch.
4. Each full-body trigger in Scope 3 sends the full body; a plain head-target edit still sends a
   patch; an unchanged body with a non-BMP character still sends the no-op patch.
5. CIDs are reused on a resubmit from the same instance.
6. A repeat version does not mark a vote outdated in the ui.
7. Every assertion is probed by reverting its own site; list probe and spec in the signal block.
8. New comments follow root `CLAUDE.md` "Comment anchors".

## [BLOCKED by Architect] (2026-10-01) — sequenced behind the backend task

Needs the replayed detail body, the head endpoint and `current_version` from
`backend-paper-body-from-replay-and-head-endpoint`. The architect moves this file to `pending/`
once that task is archived.
