# Composer follow-ups from the draft lifecycle decision: a native edit against a stale diff base, and what a draft is bound to

**Owner:** architect
**Created:** 2026-09-30

## Why

The draft lifecycle decision (`agents/docs/ARCHITECTURE.md` § 8, implemented by
`ui-composer-landing-is-terminal`) settles what happens once a broadcast is known to have
landed. Working it out, and reviewing it with `/ce-doc-review`, surfaced two questions it
does not settle. Neither is triaged. The evidence is written down here because the task it
came out of is archived and the archive trims.

Question 1 should be decided first. Until it is, a native edit can corrupt a paper body by
three routes the § 8 barrier does not reach.

## 1. A native edit sent against a stale diff base corrupts the body

The mechanism, measured on 2026-09-30. A same-author native edit sends
`computeDiff(_originalBody, newPostBody)`, a `diff-match-patch` patch against the body the
edit page loaded. `applyHivePatch` in `backend/src/lib/chain-walkers.ts` applies it to the
post's current body and takes `patch_apply`'s text without reading its per-hunk success
flags. When the current body is no longer `_originalBody`, the patch is applied fuzzily.
With the installed `diff-match-patch`, the same patch applied twice to a four-paragraph
body:

| Edit | Second application |
|---|---|
| insert a sentence mid-body | the sentence is inserted twice |
| append a paragraph | the paragraph is appended twice |
| delete a sentence opening | a second, similar passage is deleted as well |
| replace a word | a second, similar word is replaced as well |

In that fixture every hunk reported success. A reviewer's fixture saw one hunk report
failure with the text changed anyway. Either way the flags are discarded, and the corrupt
body becomes a version in the paper's history.

§ 8 closes one route to this: a second submit from an instance that knows it landed. Three
routes stay open.

- **A retry after a broadcast that rejected but landed.** § 8, Limits: the client learns
  of a landing only when the call resolves, so a rejection keeps the draft and leaves the
  instance submittable, with the pre-edit body still its diff base. On the custody path a
  rejection with a landed transaction is a lost response or `504 BROADCAST_TIMEOUT`
  (`details.outcome: 'uncertain'`, `verify_before_retry: true` per
  `api-contracts/custody.md`). Neither composer page branches on that code; both show the
  generic failure string and leave the form live. On the Keychain path it is a node error
  reported after the transaction was accepted.
- **A fresh edit page loaded from a stale cache.** The paper-detail entry is a 30 minute
  stable cache entry, and the `/invalidate` request the composer sends after landing is
  what evicts it. If that request fails (the route is authenticated and rate limited), the
  paper page serves the pre-edit body under a success message, the user sees the edit
  missing, opens the edit page again, and the new instance loads the pre-edit body as
  `_originalBody`. Not traced: whether a detail read that lands after a successful
  invalidation but before HAF has indexed the edit re-caches the pre-edit body for the
  same 30 minutes. Nothing in the read path was seen to guard against it.
- **Another instance that loaded before the landing.** A second tab on the same paper, or
  a visit opened in the same tab while the first instance's broadcast was still pending.

The continuation arm and the publish page have the sibling problem without the patch: both
mint the permlink inside `handleSubmit` from `slugify(title)` plus `Date.now()`, so a
retry after a rejected-but-landed broadcast is a second post. On the publish page that is
a duplicate paper. On the continuation arm it is a second post continuing the same head.
How the chain walk treats two continuations of one head was not traced here.

What already exists: `POST /api/custody/broadcast` accepts an optional `idempotency_key`
and short-circuits a retry whose key is already on chain (`backend/src/lib/idempotency.ts`).
The SPA does not send it. The lookup reads HAF, so it cannot see a transaction HAF has not
indexed yet, and the Keychain path does not pass through the backend at all. The class is
documented for the backend in
`agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`.

Shapes to weigh, not yet compared:

- **Make the write idempotent on chain, client side, both custody paths.** A native edit
  whose base the instance cannot vouch for sends the full body instead of a patch (a full
  body replaces, so applying it twice gives the same body). That covers a retry. It does
  not by itself cover a fresh instance on a stale cache, which does not know its base is
  stale. A publish or continuation instance mints its permlink once, so a retry addresses
  the same post. Open points: a second `comment_options` on an existing post, and the
  extra version entry a repeated op adds to the history.
- **Check the base before a native edit.** Read the target post's current body from a Hive
  API node (the real-time source per ARCHITECTURE "Data Source Policy") and send a patch
  only when it equals the diff base. Covers all three routes. Costs one read per edit.
- **Make the reconstruction refuse a patch that does not apply cleanly.** `applyHivePatch`
  could read the success flags. It would not catch the fixtures above where every hunk
  reports success, and what a refused version should render as is its own question.
- **Send `idempotency_key` from the SPA.** Covers the custody path once HAF has indexed
  the first attempt. Does not cover a quick retry or the Keychain path.
- **Branch on `BROADCAST_TIMEOUT` in the composers.** Tell the user the outcome is unknown
  and to check the paper before retrying, as `orcid-callback.js` and `signup-verify.js`
  already do for their own broadcasts.

## 2. A draft is bound to a storage key and to nothing else

§ 8, Limits. Three consequences, none of them new, all seen while reading the two pages:

- **Not bound to the chain head it was written against.** `_restoreDraft` on the edit
  page applies any stored draft over whatever the paper is now. A draft written before a
  co-author's continuation restores the older text over the newer head, and submitting it
  publishes a version without the co-author's changes, with neither author told. The same
  holds for the draft acceptance criterion 4 of the ui task deliberately preserves: it was
  written over a pre-edit load.
- **The edit page restores silently.** The publish page shows a "draft restored" card with
  the save time and a discard button. The edit page has no card and no discard, so the
  user cannot tell a restored form from a freshly loaded one and cannot drop a stale
  draft except by submitting it.
- **Not bound to the signed-in account.** Drafts live in `localStorage` and are not in
  `SUBJECT_BOUND_STORAGE_KEYS`, so they survive `auth.disconnect()` and a subject change.
  The publish draft carries `authorName`, `authorAffiliation` and `authorOrcid`, and
  restores them into the next account's form in the same browser.

A head binding cannot replace § 8's barrier: right after a landing, a fresh load can still
be served the pre-edit head, so a spent draft would pass the check. It is a separate guard
against a draft that has outlived its head, and it needs user-facing copy for the refusal,
in every locale.

## Output

For each of the two questions: a decision (fix, accept as a limit and say so in § 8, or
dismiss), and a ui or backend task if it changes code. They are independent and can be
decided separately. When question 1 is decided, revisit § 8's Limits: the entries on the
unknown landing, the per-instance barrier and the detail cache all describe routes it
closes or leaves open.
