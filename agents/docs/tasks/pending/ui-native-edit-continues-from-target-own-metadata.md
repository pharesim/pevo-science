# A native edit in a multi-post response reads its predecessor from the target's own metadata

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Residual of the native-edit `continues` fix, filed at the user's choice (2026-10-05).

## Why

A native edit keeps its target's own `continues` (`targetOwnContinues` in `frontend/src/pages/edit.js`). When the detail response holds one post, it takes the served `continues`, which is that post's own. In a longer chain the served metadata is the latest op's, so the helper reads the predecessor from `versions[]`: the canonical root first, then the other posts in the order of their first version. That order is the chain's for every link the composer publishes, since a continuation continues a head already on chain.

`resolveContinuationChain` admits a link by its current `continues` and does not require it to be newer than the post it continues. A named co-author can therefore re-point an older post of their own onto the middle of a chain with a hand-made metadata edit. Its first version is then listed before links it follows, and the posts around it read out of order. Another author's ordinary native edit of their own continuation can then write a `continues` naming the wrong post, which can form a cycle among continuations, and those continuations drop out of the paper. A true root and the paper's listing are not affected: the root always reads first and continues nothing.

Widened at the architect review of the native-edit fix (2026-10-06): one canonical does continue a post. A continuation served as a paper of its own (the fail-closed branch of `findCanonicalRoot` in `backend/src/lib/chain-walkers.ts`) that a co-author has since continued is the canonical of a two-post response. `targetOwnContinues` reads it first, so its author's native edit sends no `continues`, and the post becomes a separate listed paper. Reachability is low: such a post is unlisted, and reaching its edit page takes a direct URL.

## Scope

For a native edit of any post in a multi-post response, the canonical included, take the target's `continues` from the target's own metadata: its last version through `fetchPaper(canonical author, canonical permlink, <that version_number>)`, whose served metadata is that version's. Keep the single-post case as it is.

Decide, and say in the signal block:

- where the read sits in `handleSubmit` relative to the re-auth gate and the uploads;
- what a failed read does (it must not send a `continues` it could not confirm);
- how it behaves when `versions[]` lacks per-version authors (the synthetic stub), where the version read returns 404.

## Acceptance criteria

1. With a chain whose `versions[]` lists a re-pointed link before posts it follows, a native edit of each continuation sends the `continues` its own last version carries.
2. A failed version read sends nothing and leaves the draft and the instance submittable.
3. The root, single-post and composer-built chain specs in `frontend/tests/unit/pages-edit.test.js` stay green.
4. Each new assertion is probed by reverting its own site; list the probes in the signal block.
5. The canonical of a multi-post response whose own last version carries a `continues` keeps it on its author's native edit; a canonical whose last version carries none still sends none.
