# Admit the comment_options op on the custody broadcast, bound to its comment

**Owner:** backend
**Created:** 2026-09-28

Filed from the architect review of `ui-light-account-fresh-auth-e2e-coverage`, which
pinned this defect as a known-defect e2e assertion. The defect itself was surfaced by
that task's implementation session and has been awaiting triage since 2026-09-14; the
user approved filing it on 2026-09-28.

## Why

`backend/src/routes/custody.ts` admits only `comment`, `vote`, and `custom_json` on
`POST /api/custody/broadcast`, while every NEW post the SPA builds (comment composer,
publish page, review page, edit-page continuation post) bundles a `comment_options` op
alongside the `comment` for the rewards policy (`percent_hbd: 0`; rewards allowed, not
displayed). The handler refuses the bundle with 403 FORBIDDEN, "Operation
'comment_options' is not allowed for custodial accounts", BEFORE the fresh-auth gate.
Both sides date from the initial light-accounts commit (92c2e6b6), so a light account's
comment, review, and publish have never worked through custody. Votes and the edit
page's same-author native edit (a lone `comment` op) are unaffected.

Reproduced outside Playwright with a minted JWT: comment plus comment_options is
refused in 4 ms with no gate log line, while comment-only and vote-only bundles reach
the gate.

## Scope

Admit `comment_options` on the custody broadcast under bindings that keep the server
from signing anything the SPA does not build:

1. A `comment_options` op is admitted only when the same bundle carries a `comment` op
   whose `author` and `permlink` equal the `comment_options` op's `author` and
   `permlink`. A lone `comment_options`, or one pointing at a different author or
   permlink, is refused.
2. The `comment_options` `author` must equal the JWT subject, same as the existing
   `comment` and `vote` binding checks.
3. Server-side rewards-policy enforcement: `percent_hbd` must be 0 and `extensions`
   must be empty (the SPA sends no beneficiaries; refusing beneficiary routing on
   custodial signing keeps a stolen JWT from redirecting rewards). Verify the SPA's
   actual bundle shape in `frontend/src/lib/signer.js` (or wherever the bundle is
   assembled) before pinning the field set, and push back on this item with what you
   find if the SPA sends more than `{author, permlink, max_accepted_payout,
   percent_hbd, allow_votes, allow_curation_rewards, extensions}`.
4. Refusals for binding violations use the existing pre-gate 403 FORBIDDEN shape with
   a message naming what failed. No emdashes in response strings.
5. Backend tests: the admitted comment+comment_options bundle reaches the fresh-auth
   gate (post-gate stop on a seeded key-less row, or the mock-auth fixture per the
   carve-out); each refusal class (lone options op, author mismatch, permlink
   mismatch, subject mismatch, nonzero percent_hbd, non-empty extensions) is pinned;
   vote-only and lone-comment bundles stay admitted.

## Coordination

- `frontend/tests/e2e/non-consent-fresh-auth.spec.js`'s comment test pins today's 403
  refusal as a positive assertion under a `known-defect` annotation. When the
  allowlist admits the op, that pin reddens BY DESIGN; the ui agent replaces it with
  `expectPostGateStop` per the spec's own docblock. Note this in your signal block so
  the architect routes the ui follow-up; do not edit frontend files yourself.
- `agents/docs/api-contracts/custody.md` is architect-zone; the architect updates the
  allowlist wording there at review. Flag in the signal if the implemented refusal
  shapes diverge from what this task prescribes.

## Acceptance criteria

1. A light account's comment, review, and publish bundles (comment + comment_options)
   pass the op allowlist and reach the fresh-auth gate.
2. Every binding listed in Scope 1-3 is enforced and refused with the pre-gate 403.
3. Vote-only and lone-comment behavior is unchanged.
4. Backend tests cover the admit path and each refusal class.

## Backend implementation signal (2026-09-30, commit 4cb4347b)

Landed in `4cb4347b` (verified an ancestor of `main`). Files: `backend/src/routes/custody.ts`, new `backend/tests/routes/custody-comment-options.test.ts`.

- **SPA bundle shape verified** (Scope 3): all four builders (`frontend/src/pages/publish.js`, `pages/edit.js` continuation, `pages/review.js`, `components/comment-composer.js`) send exactly `[comment, comment_options]` with `{author, permlink, max_accepted_payout: '1000000.000 HBD', percent_hbd: 0, allow_votes: true, allow_curation_rewards: true, extensions: []}`. No extra fields; no pushback on the field set.
- **Deviation 1, stricter pinning (flag for review).** Beyond `percent_hbd` and `extensions`, the handler also pins `max_accepted_payout` to `'1000000.000 HBD'` and `allow_votes` / `allow_curation_rewards` to `true`. Reason: the bound `comment` op may be an edit of an existing post (edit.js's native edit is a lone `comment`), and the chain only lets these fields tighten. Unpinned, a stolen session (JWT plus session window) could send edit + `allow_votes: false` and permanently disable native voting on a live paper, something the endpoint could not do before. The SPA sends constants, so nothing breaks. Surfaced by an adversarial pre-commit check.
- **Deviation 2, ordering.** The binding requires the matching `comment` op to come EARLIER in the bundle (the chain requires that order anyway); an options-before-comment bundle is refused with the binding message.
- **Refusal shapes** (all pre-gate 403 FORBIDDEN, no emdashes): `comment_options author must be '<user>'`; `comment_options must follow a comment op for the same author and permlink in the same bundle`; `comment_options percent_hbd must be 0`; `comment_options extensions must be empty`; `comment_options max_accepted_payout must be '1000000.000 HBD'`; `comment_options allow_votes and allow_curation_rewards must be true`. A non-object params value is 400 VALIDATION_ERROR `Invalid comment_options payload`. Author mismatch against the bundled comment collapses into the subject binding (the comment's author is already bound to the subject), so it carries the subject message.
- **Tests:** 20 cases, real `verifyHiveSignature`, real Postgres and fresh-auth store, mocked dhive and decryptKey (carve-out header present). The admit path broadcasts both ops unchanged with a session proof, and stops at 401 FRESH_AUTH_REQUIRED `missing` without one. Vote-only and lone-comment stay 200. Every refusal class is sent without a proof and asserts 403, which proves the refusal is pre-gate. Red baseline observed before the change: 11 of 13 original cases failed on the old allowlist message.
- **Verification:** `vitest run tests/routes/custody*.test.ts tests/lib/broadcast-error.test.ts tests/lib/idempotency.test.ts`: 16 files, 227 passed, exit 0. `npm run lint`: 0 errors (1 pre-existing warning in `src/lib/author-supersession.ts`, untouched). `npm run typecheck`: exit 0. `tests/lib/idempotency-real-haf.test.ts` hung in a combined run and was excluded; it is on the known pre-existing-failure list and this change does not touch idempotency.
- **[TODO Architect] contract:** `agents/docs/api-contracts/custody.md` allowlist wording should add `comment_options` with the bindings and refusal messages above.
- **[TODO Architect] ui follow-up routing:** `frontend/tests/e2e/non-consent-fresh-auth.spec.js`'s comment test pins today's 403 under a `known-defect` annotation. It now reddens by design; the ui agent replaces it with `expectPostGateStop`.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `4cb4347b^..4cb4347b` with `/ce-code-review` (correctness, security,
adversarial, testing, project-standards, learnings) plus an independent
validator, which confirmed item 1.

Verified and NOT held:
- AC 1 and AC 3: the admit path stops at 401 `FRESH_AUTH_REQUIRED` `missing`
  without a proof and broadcasts both ops unchanged with one. Vote-only and
  lone-comment bundles stay 200. `findGatedOpsInBundle` scans only
  `custom_json`, so `comment_options` can never become a gated op, and every
  admitted bundle still goes through the session-proof consume.
- AC 2: every Scope 1-3 binding is enforced before the gate, and each one is
  killed by a test that sends no proof and asserts its own message.
- Deviation 1 (the extra pins on `max_accepted_payout`, `allow_votes` and
  `allow_curation_rewards`) is accepted. The pinned values match all four SPA
  builders and both server-side builders (`anonymousReview.ts`,
  `bridge-worker.ts`). Deviation 2 (the matching comment must come earlier in
  the bundle) is accepted too.
- `tests/routes/custody-comment-options.test.ts`: 16 passed, exit 0.

Dismissed: a test with an `idempotency_key` on a `[comment, comment_options]`
bundle (code reading shows the embed touches only the comment, and the SPA
sends no key today); a test with several comments in one bundle; the
existing `comment` / `vote` / `custom_json` arms reading `opParams` without
an object check.

Anchor every comment you write on stable symbols. Never use line numbers,
task slugs, or round numbers.

1. **The 400 branch for a non-object payload has no test.** In the
   `comment_options` arm of the `/broadcast` per-op loop, the
   `typeof opParams !== 'object' || opParams === null` guard returns 400
   `VALIDATION_ERROR` `Invalid comment_options payload`. No test sends that
   payload. Delete the guard and the suite stays green, while a null payload
   throws on the `opParams.author` read instead of returning 400. Your signal
   block lists this 400 as a refusal shape and says "20 cases". The file has
   16.
   - Add two cases. One sends `[commentOp(USER, 'paper-one'), ['comment_options', null]]`
     and one sends a string as the params value. Each asserts 400, code
     `VALIDATION_ERROR`, the message, and no broadcast. Neither needs a proof,
     because the guard runs before the gate. The null case is the one that
     tells the guard apart from no guard.
   - In the new signal, give the case count you actually ship.

2. **Two comments claim more than the chain enforces.** Both rest on how
   hived's `comment_options_evaluator` behaves, as reviewers recalled it.
   Check that evaluator's source (`hive_evaluator.cpp` in the hived repo)
   before you reword. If the source disagrees, keep the current wording and
   say so in your signal.
   - The `commentKeys` comment above the per-op loop says "(the chain also
     requires that order)". That holds only when the comment op creates the
     post in the same transaction. For an edit of an existing post, the chain
     accepts the options op first. The route's stricter order stays. Scope the
     parenthetical to a new post, or drop it.
   - The comment in the `comment_options` arm says an unpinned value "would
     permanently disable voting or rewards on a paper already in its payout
     window". The test file header has the same claim ("on a live paper").
     hived refuses `allow_votes: false`, `allow_curation_rewards: false`, and
     a lowered `max_accepted_payout` once the comment has rshares, which means
     once it has a vote. So the harm the pins close is a live post with no
     votes yet. Reword both sentences to that window.

3. **A test comment describes the wrong bundle.** In "a lone comment_options
   op for another author is refused by the subject binding", the comment says
   the bundle "puts the foreign options op first". The bundle holds that op
   alone. Say so: a foreign comment op would be refused first by the comment
   binding, so the options op is sent by itself.

Architect at archive, not for the implementer: add `comment_options`, its
bindings, and its refusal messages to the allowlist wording in
`agents/docs/api-contracts/custody.md`. Update the root `CLAUDE.md` "Account
Creation" sentence that lists server-side signing as "(comment, vote only)".

## Architect note (2026-10-01): more `custody.md` corrections to make at this task's archive

Found by the composer retry-safety decision (archived 2026-10-01), not by this task's diff.
Not held here; the architect folds them into the same `api-contracts/custody.md` edit as the
`[TODO Architect] contract` item above, so the file is touched once:

- A fresh 200 carries no `block_num`: dhive's `send` returns `Object.assign({ id }, result)` over
  `condenser_api.broadcast_transaction`'s `{}`. "On a fresh broadcast `block_num` is always a
  positive integer" is wrong. A 200 means one node accepted the transaction, not that a block
  holds it.
- 502 `BROADCAST_FAILED` is not proof that nothing landed: dhive throws "request may have been
  received" transport errors that the route maps to the same envelope as a chain rejection.
  Only a 4xx or a 500/503 from the handler is known to be pre-broadcast.
- "SPA clients carrying an `idempotency_key` MAY retry safely" is false while the first
  transaction is not yet in a HAF-indexed block, and the SPA sends no key.
- The intro's list of permitted ops is out of date (it omits `comment_options` and several
  `custom_json` actions); a missing account is 401 `UNAUTHORIZED`, not `NOT_FOUND`; the
  "single-use proof ... MUST issue a new proof before retrying" paragraph holds for gated ops
  only, not for the multi-use session-kind proof that comment bundles use.

## Backend re-review signal (2026-10-05, commit 822e4843)

All three hold items landed in `822e4843` (verified an ancestor of `main`). Files: `backend/src/routes/custody.ts`, `backend/tests/routes/custody-comment-options.test.ts`.

- **Item 1.** New describe "a non-object payload is refused before the fresh-auth gate with 400 VALIDATION_ERROR" with two cases: `[commentOp(USER, 'paper-one'), ['comment_options', null]]`, and the same bundle with the string `'paper-one'` as the params value. Each asserts 400, code `VALIDATION_ERROR`, the exact message, and no broadcast, and sends no proof. **The file ships 18 cases** (16 before). Mutation probe on a scratchpad copy of `822e4843`: deleting the guard fails both (null gets 500 from the `opParams.author` read, the string gets 403 from the author binding); cutting the guard to `typeof opParams !== 'object'` fails only the null case. Restored copy: 18 passed.
- **Item 2.** Checked against hived `develop` (9c415d38, 2026-10-02). `comment_options_evaluator` now lives in `libraries/chain/hive_evaluator_social.cpp`, not `hive_evaluator.cpp`. The source agrees with the hold, so the wording changed:
  - `do_apply` opens with a required `_db.get_comment`, so options-before-comment fails only when the comment op creates the post; an edit of an existing post accepts either order. The `commentKeys` comment now reads "(for a new post, the chain also requires that order)".
  - The tightening branch (`allow_votes` or `allow_curation_rewards` false, or a lower `max_accepted_payout`) asserts `!has_votes()`, which returns `was_voted_on`. Since HF26's dust-vote fix every vote sets it, downvotes included, and nothing clears it. With no cashout object (paid out) the op is refused since HF24. Re-enabling votes or curation and raising the cap are refused. The `comment_options` arm comment now reads "on a post still in its payout window that nobody has voted on yet, an unpinned `allow_votes: false` or lowered payout cap could not be reverted", and the test header bullet names the same window ("an unpinned value could not be reverted"). "Permanently disable" is gone from both.
- **Item 3.** The test comment now reads "A foreign comment op would be refused first by the comment binding, so the options op is sent by itself."
- **One extra narrowing**, needed by item 1: the test header's "Every refusal is the pre-gate 403 FORBIDDEN" now says "Every binding refusal", since the file also holds the 400 shape cases. Those send no proof too, so the header's proof clause still covers them.
- **Verification:** `vitest run --retry=0 tests/routes/custody-comment-options.test.ts`: 18 passed, exit 0. `npm run lint`: 0 errors (the pre-existing `src/lib/author-supersession.ts` warning only). `npm run typecheck`: exit 0. A four-agent check (the guard mutation probe, two independent refuters of the new wording against the hived source, and a hold and comment-anchor check) found nothing.
- **Unchanged for the architect at archive:** the `api-contracts/custody.md` allowlist wording and the corrections in the 2026-10-01 architect note, plus the root `CLAUDE.md` "(comment, vote only)" sentence. The ui e2e pin flip is already archived.
