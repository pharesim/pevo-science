# Flip the non-consent spec's known-defect pin now that the allowlist admits `comment_options`

**Owner:** ui
**Created:** 2026-09-30

Routed out of the architect re-review of `ui-non-consent-spec-header-overclaims`
(archived 2026-09-30) and out of the `[TODO Architect] ui follow-up routing` row on
`backend-custody-allowlist-comment-options`.

## Why

Backend commit `4cb4347b` added `comment_options` to the custody broadcast allowlist
(`ALLOWED_OPS` in `backend/src/routes/custody.ts`), bound to its bundled `comment` op.
`frontend/tests/e2e/non-consent-fresh-auth.spec.js` was written against the defect that
commit fixes. It pins the old refusal as a positive assertion and describes it in its
header and in several inline comments. All of that is now stale:

- The header says the vote is the only broadcast in the file that reaches the gate, and
  that the comment and publish bundles are refused earlier at the op allowlist.
- The header's known-defect paragraph says the allowlist admits `comment`, `vote` and
  `custom_json` only, and that the handler refuses the bundle before the fresh-auth gate.
- The comment test carries a `known-defect` annotation and asserts a 403 `FORBIDDEN`
  whose message names `comment_options`.
- The publish test's comments say the allowlist refuses before the gate, and that the end
  state is "refused before the gate as today".

This was established by reading at the archive review. The e2e suite was not run, so
whether the comment test is red at HEAD is not yet measured.

One trap to check before trusting a green run. Every binding refusal `4cb4347b` added
(author mismatch, bundled-comment mismatch, nonzero `percent_hbd`, non-empty
`extensions`, the pinned `max_accepted_payout` and `allow_votes` / `allow_curation_rewards`
values) also answers 403 `FORBIDDEN` with `comment_options` in the message. The old pin's
three assertions are satisfied by any of those. If the composer's op misses a binding, the
comment test stays green while reporting the old defect. A green comment test before the
flip is therefore a finding about the SPA's op, not evidence that nothing needs doing.

## Scope

1. Run `non-consent-fresh-auth.spec.js` against the test stack first and record what the
   comment test returns at HEAD. If it is green, read the refusal body: it is a binding
   refusal, and the SPA's `comment_options` op disagrees with the backend's bindings. Stop
   and record which binding in this file; that is a backend or composer decision, not a
   pin flip.
2. Replace the comment test's 403 pin with `expectPostGateStop` on the broadcast response
   and drop the `known-defect` annotation.
3. Rewrite the header so it describes the admitted allowlist: which broadcasts in the file
   now pass the gate and where each stops. Delete the known-defect paragraph or reduce it
   to what is still true. Rewrite the inline comments in the comment test and the publish
   test that describe the allowlist refusal.
4. Decide whether the publish test can now pin its broadcast response. It currently
   asserts the request only. Its account is the HAF-indexed accredited researcher, not
   necessarily the seeded keyless row, so check what the handler answers for that account
   before pinning anything, and say in this file what you found.
5. Reword the tail of `expectPostGateStop`'s JSDoc in
   `frontend/tests/e2e/fixtures/light-account.js`. It says the outer catch's generic
   envelope "would mean a step past the guard threw". The account-row read sits inside the
   same `try` ahead of the guard, so a row-read throw produces the same generic envelope.
   Say that the generic envelope would mean something inside the handler's `try` threw:
   the account-row read ahead of the guard, or a step past it.
6. Sweep the citers. `git grep -n -i "known.defect\|allowlist" -- frontend/tests` and read
   every hit that describes this spec or the old refusal. The unit suites that cite this
   spec as a clause-(c) companion describe the vote only and were true at the archive
   review; confirm that at the head you work from rather than assuming it.

## Acceptance criteria

1. No sentence in `non-consent-fresh-auth.spec.js` or its citers says the custody
   allowlist refuses `comment_options`, in either half of a compound sentence.
2. The comment test asserts the post-gate stop, and no `known-defect` annotation remains
   for this defect.
3. The header states, per test, how far the real backend leg runs, and matches what the
   tests assert.
4. The `expectPostGateStop` JSDoc names the row read as a source of the generic envelope.
5. No added line carries a task slug, a task redirect, a round or hold ordinal, a
   line-number or SHA anchor, or a bare positional anchor.
6. The signal block names the specs run against the test stack and what each returned,
   including the pre-flip result from scope item 1.

## Notes

The solutions entry
`agents/docs/solutions/conventions/carve-out-clause-a-impracticability-claims-are-unverified-prose-2026-09-22.md`
is refreshed by the architect separately. Do not edit it here.
