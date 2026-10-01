## Composer follow-ups: a native edit against a stale diff base, and what a draft is bound to (archived 2026-10-01) — decided: fix both; retries made safe, drafts bound to account and head; no implementer rounds

### Architect decision (2026-10-01)

Both questions decided as **fix**, approved by the user as recommended, with two open choices
answered: light-account RC is handled by a delegation at creation plus a pre-flight check, and
drafts stay in `localStorage`, keyed by account. Recorded in `ARCHITECTURE.md` § 8 (rewritten),
§ 2 "Body, edits and versions" (new) and § 1 "Light-Account Resource Credits" (new). Evidence came
from a nine-question traced sweep with a skeptic per question, then a six-lens adversarial review
of the draft and a completeness critic. § 8 and the tasks then went through `/ce-doc-review`
(coherence, feasibility, design-lens, security-lens, scope-guardian, adversarial): 1 fix applied,
4 proposed fixes and 10 decisions approved as recommended, 17 FYI observations (eight folded in
as wording or scope). The review's main changes: a confirmed existing post under a kept permlink
counts as a landing; a sign-in under a signed-out publish form adopts it instead of remounting;
an unreadable head is "could not confirm", never "newer version"; the newer-version card makes
the form read-only until a choice; legacy drafts are deleted, not adopted; a repeat is compared
on the replayed body; a lasting degraded walk keeps a head marker; the retry ui task is split so
the landing wait and the served diff base wait on the backend only.

What the evidence changed:

- The dominant stale-base route was not a retry. `hafsql.comments.body` never takes an edit
  (HafSQL swaps its arguments in `updateEditedComment`), and the detail route reads it for every
  single-post paper, so every edit after the first patched against the creation body and the
  paper page never showed an edit. The user reports the defect upstream.
- The composer's own landing re-cached the pre-edit paper for 30 minutes in most custody edits:
  the broadcast resolves on node acceptance, before the block, and the navigate's first read
  came before HAF had the op.
- Metadata-, files- and ticks-only native edits sent `body: ""`, which Hive rejects.
- Every edit-page load wrote a draft with nothing typed, the edit page restored it silently over
  a newer head, and a mounted composer broadcast one account's author entry under another.
- A new-permlink publish retry within 300 s is refused by consensus; a same-permlink resend is an
  edit, and an identical `comment_options` is accepted until payout.

Per question:

1. **Stale diff base: fix.** Backend: the detail serves the replayed body (as hivemind does), a
   failed or aborted walk is never stable-cached, a new uncached head endpoint (existence, index
   state, head marker) evicts a stale detail, and an exact repeat op no longer outdates reviews.
   ui: a no-op patch for an unchanged body; a head check before the first gate and before the
   broadcast; the landing waits for the index; the diff base is the served body, recomposed
   losslessly; full body for non-BMP text or an uncomputable patch; retries made safe (a kept
   permlink checked for existence before reuse, a native-edit attempt marker that sends the full
   body inside the earlier attempt's landing window). Dismissed: classifying rejections
   (`BROADCAST_TIMEOUT`), the SPA `idempotency_key`, a reconstruction that refuses fuzzy patches,
   always sending the full body (footprint and RC).
2. **Draft binding: fix.** A draft holds user work only (baseline after editor normalisation),
   is keyed by account and canonical paper captured at load, is restored silently only over the
   head it was written against (otherwise a read-only newer-version card with Restore and
   Discard), and the composer remounts when a different account signs in or the edit route names
   another paper. Pre-binding drafts are deleted, not adopted.

Filed: `backend-paper-body-from-replay-and-head-endpoint`, `ui-native-edit-empty-diff-and-own-continues`
(also fixes a non-head native edit copying the head's `continues` onto the root),
`ui-composer-drafts-bound-to-account-and-head`, `backend-light-account-rc-delegation-and-preflight`
(pending); `ui-composer-landing-wait-and-served-diff-base`, `ui-composer-retry-safety`,
`ui-custody-insufficient-rc-message`, `backend-display-reads-frozen-hafsql-body` (blocked). Not filed, recorded as a § 8 limit: the
review page and comment composer mint a permlink per submit. Dismissed: `/invalidate` has no
ownership check. Deferred to the custody allowlist archive: `api-contracts/custody.md` corrections
(noted on that task).


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

## Correct the Playwright retry-model comments in six e2e specs, and the trace scan's spec list (archived 2026-10-01), two rounds, archived clean

### Architect archive note (2026-10-01)

Re-reviewed `795f6df0` with `/ce-code-review` (correctness, project-standards, in-process
adversarial): no findings. All 5 held items are FIXED (items 1-3 held 2026-09-30, items 4-5
added 2026-10-01). The diff is comment-only: the token streams match and the non-comment
changed-line filter is empty. The anchor gate has no hit on the added lines, and its control
line fires. Each Playwright claim was checked against installed 1.59.1 and by throwaway
probes. The signal's reason for leaving out the item-5 qualifier is accepted.

Triage at archive (user-approved as recommended):
- The false "the test.fixme below" pointer, and the pointers that locate a test by position
  or count in `settings-orcid-factor.spec.js`, are filed as
  `ui-settings-orcid-factor-test-pointers`.
- The missing trace opt-out in `authorship-consent-actions.spec.js` and
  `authorship-pending-discovery.spec.js` is filed as `ui-authorship-specs-trace-opt-out`.
  `unzip` is absent on the dev host, so the trace scan never runs there.
- Dismissed as loose but true: the `login-email` docblock's "the seeded row starts fresh
  each time", and the hook comments' UNIQUE(email) framing (both seeds upsert
  ON CONFLICT (email)).
- Extending the trace scan to the other typed password literals stays out of scope, as
  before.

**Owner:** ui
**Created:** 2026-09-30

Routed out of the architect round-3 review of `ui-light-account-fresh-auth-e2e-coverage`
(archived 2026-09-30). That task corrected one false comment about how Playwright
retries run, in the two fresh-auth specs it owned. The same false model is still written
in six sibling specs, so the e2e directory now states two incompatible retry models. One
adjacent false sentence in the trace scan's docblock rides along. Comment-only work: no
assertion, fixture, or harness behavior changes.

## Why

**The retry model.** Installed Playwright (1.59.1, `frontend/node_modules/playwright`)
stops the worker process whenever a test in it fails, and runs the retry in a newly
started worker. Verified at review in `lib/runner/dispatcher.js`: the job-finished path
stops the worker when the result reports a failure, and the requeued job gets a worker
from `_createWorker`. `frontend/playwright.config.js` sets `workers: 1, retries: 1`. So on
a retry:

- the spec module is loaded again, which means module scope IS evaluated again;
- `beforeAll` runs again in the new worker;
- nothing runs "in the same worker" as the failed attempt.

The seven comment sites below say otherwise, in two shapes.

Shape 1, "retries re-run X but do NOT re-evaluate module scope" (false: module scope is
re-evaluated):

- `login-email.spec.js`, the comment above `TEST_PASSWORD` ("Identity strings derived
  from RUN_SUFFIX are computed in beforeAll ...").
- `password-recovery.spec.js`, the comment above `RUN_SUFFIX` inside the
  "user requests password reset ..." test body.
- `settings.spec.js`, the comment above `NEW_LOCALE` ("Stable constants stay at module
  scope ...").
- `settings-orcid-factor.spec.js`, the comment above `let RUN_SUFFIX` ("Populated in
  beforeAll from (Date.now, testInfo.retry) ...").

Shape 2, "retries in the same worker re-evaluate it" (false: a retry is never in the same
worker):

- `email-signup.spec.js`, the comment above `RUN_SUFFIX` inside the "fresh visitor signs
