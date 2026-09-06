# The mis-cited spec's own header still claims the coverage it lacks

**Owner:** ui
**Created:** 2026-09-06

Routed out of the architect round-5 review of `ui-consent-op-teardown-guard` (archived
2026-09-06). That review corrected five suite headers which cited
`frontend/tests/e2e/non-consent-fresh-auth.spec.js` as exercising broadcast, upload, or
window acquisition against the real backend. The five citers were fixed. The spec they
cited was not, and its own docblock is where the claim originates.

## Why

The spec's opening paragraph states its subject as:

> Non-consent broadcast paths must attach a `fresh_auth_proof` to
> `/api/custody/broadcast`, and the `/orcid/callback` page must handle the `session_auth`
> mode by caching the issued proof in sessionStorage and bouncing the user back to the
> page that initiated the broadcast.

The file contains one test. It registers a single route stub, on `**/api/orcid/callback`,
hand-seeds the ORCID mode and return path that `beginSessionAuthOrcidRedirect` would have
written, and asserts the `session_auth` handler caches the issued window in
sessionStorage. It issues no broadcast: every occurrence of `/api/custody/broadcast` in
the file is inside a comment. The first half of that opening sentence describes a
requirement the spec does not exercise, stated in the same voice as the half it does.

This is the sentence that made the five downstream citations plausible. Anyone reading the
spec's header rather than its body would conclude it drives a proof-carrying broadcast,
which is exactly the inference those five headers encoded and the round-5 review had to
unwind. Leaving it in place leaves the trap armed for the next reader.

Two further claims in the same header need checking, both the same unverified-prose class:

1. **Its own clause-(c) companion sentence** says the `orcid-link` / `orcid-no-password`
   specs cover the `/api/orcid/start` and `/api/orcid/callback` real-path edges for
   sibling modes, and that this spec "layers the session_auth mode atop the same proven
   plumbing." Partially supported, not wholly. `orcid-link.spec.js` does contain a
   genuine real-path test that posts to both endpoints against a live backend, but its
   earlier tests stub `/api/orcid/callback`, and `orcid-no-password.spec.js` stubs
   `/api/orcid/start` with an error in at least one test. The "layers atop the same proven
   plumbing" clause is the weakest part: this spec stubs the callback outright, so its own
   test layers on nothing real.
2. **The real-path companion can silently not run.** `orcid-link.spec.js`'s real-path test
   calls `test.skip(true, ...)` when `/api/orcid/start` returns a non-success status,
   on the theory that ORCID config is missing in that environment. A companion that skips
   itself when its dependency is absent discharges clause (c) only when it actually runs,
   and nothing reports that it did not. Compare `settings-orcid-factor.spec.js`, whose
   equivalent real-path test carries no conditional skip, so a missing sidecar fails
   loudly instead of quietly voiding the companion.

The clause-(a) sentence is sound and should be left alone: the cryptographic verification
it points at is genuinely covered by `backend/tests/routes/custody-non-consent-fresh-auth.test.ts`,
which runs the real `verifyHiveSignature` against signed requests.

## Scope

1. Rewrite the opening paragraph so it states what the single test actually drives, and
   names the broadcast-attach requirement as the thing this spec does **not** exercise.
   The five corrected headers are the model for the wording: say what runs, then say what
   does not, plainly. Keep the paragraph's explanation of *why* the requirement matters if
   it still reads as useful background, but it must not read as a description of this
   spec's coverage.
2. Resolve the clause-(c) companion sentence against what `orcid-link.spec.js` and
   `orcid-no-password.spec.js` actually drive. Credit the real-path test that exists,
   drop or qualify the parts the stubs contradict, and drop the "layers atop the same
   proven plumbing" claim unless you can defend it.
3. Decide the conditional-skip question and record the decision in the header. Either
   remove the skip so a missing ORCID sidecar fails loudly, or state in the citation that
   the companion is environment-gated and does not always run. Removing the skip is
   preferred if the sidecar is a standard part of the e2e environment; check before
   changing it, since a hard failure in an environment that legitimately lacks the config
   is worse than a disclosed gap.
4. Do not re-sweep the six suites that cite this spec. All six already carry the corrected
   form, describing what the spec does not do. Confirm that is still true at the head you
   work from, then leave them alone.

## Acceptance criteria

1. No sentence in `non-consent-fresh-auth.spec.js`'s docblock describes coverage the file
   does not provide, in either half of a compound sentence.
2. The docblock names, in behavioural terms, what its single test drives and what it does
   not.
3. The clause-(c) companion sentence resolves to specs that genuinely exercise what is
   claimed of them, or states the gap.
4. The environment-gated behaviour of the cited real-path test is either removed or
   disclosed in the header.
5. No added line carries a task slug, a path or file redirect to a task, a round or hold
   ordinal, a line-number or SHA anchor, or a bare positional anchor. State the condition,
   not the coordination artifact.
6. The e2e suite is no worse than its recorded baseline. This is a comment-only change
   unless scope item 3 removes the skip, in which case say which specs you ran and what
   they returned.

## Notes

Nothing mechanical will catch a regression here. The carve-out citation canary resolves
citations under `backend/tests/` only, so a frontend spec can describe coverage it does
not have indefinitely with every check green. That gap is recorded separately and is not
this task's job to close.

Scope item 3 may turn out to be a real decision rather than an edit. If removing the skip
would red the suite in a normal developer environment, say so in this file and take the
disclosure option instead; do not remove a guard that is load-bearing for people without
the ORCID sidecar.
