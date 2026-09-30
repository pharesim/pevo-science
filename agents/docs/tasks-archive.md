## Draft lifecycle on the composer pages: decide between a write barrier and exit-by-exit clears (archived 2026-09-30) — decided: write barrier, landing is terminal; no implementer rounds

### Architect decision (2026-09-30)

Decided: a write barrier, not exit-by-exit clears. Recorded in `ARCHITECTURE.md` § 8 ("Composer
Drafts") as "landing is terminal for the composer instance": from the moment the broadcast call
resolves with a result, the draft is removed once, the instance writes no draft again (the refusal
is in `_writeDraft`, which every writer passes through), it accepts no further submit, and nothing
after that point ends in the failure state. Implemented by `ui-composer-landing-is-terminal` on
both `edit.js` and `publish.js`. § 8 and the ui task went through `/ce-doc-review` (coherence,
feasibility, scope-guardian, adversarial, design-lens) before filing; the user approved the
findings and the open decisions as recommended.

Per item:

1. Try/catch around `invalidatePaperCache`: yes, caught where it is called, continue to `success`,
   and run it whether or not the component is still mounted. A landed post reported as "edit
   failed" invites a second submit.
2. Writer re-arm after an error: closed by the barrier. No clear could close it, because a resting
   state has no exit to hang one on.
3. The unmounted re-clear deleting a later visit's draft: closed by removing every clear after the
   landing clear. `savedAt` scoping not adopted: a timestamp cannot tell this instance's late
   writes from a later visit's, and it leaves item 2 open. The landing clear itself can still
   remove a draft written during the broadcast await; recorded as a limit.
4. `publish.js`: audited. Its `_mounted` guard precedes its only clear (leaving during the
   broadcast keeps the draft of a landed paper), the clear does not cancel the debounce, and a file
   selection in the success window flushes the draft back. Same rule, same task.
5. `landed` means the call resolved: kept as the definition, the two overclaiming comments are
   reworded in the ui task. The untraced retry is traced and is NOT safe: a second native edit
   re-sends a patch against the pre-edit body and `applyHivePatch` applies it to the patched body
   (insertions doubled, a second similar passage deleted). Routed to
   `architect-composer-retry-safety-and-draft-binding`, question 1.
6. Coverage of the file-selection writer: required by the ui task. It is the spec that tells a
   barrier in `_writeDraft` from one placed only in the scheduler.

Added beyond the six items: the second-submit refusal. `isSubmitting` excludes `success`, so the
submit button is live for the 1.5 s before the navigate, and the edit page has no confirm dialog.

Found at review and not closed here: the paper-detail cache entry lasts 30 minutes and only the
invalidation evicts it, so a failed invalidation leaves a fresh edit page with a stale diff base
(three reviewers, independently). Recorded as a § 8 limit and routed to the same architect task,
which also carries what a draft is bound to (no account, no chain head, silent restore on the edit
page). The same-instance `draftKey` re-pointing residual is untouched by the barrier and stays
with `tasks/blocked/ui-composer-surfaces-navigate-over-undrafted-work.md`.


**Owner:** architect
**Created:** 2026-09-30

## Why

The edit-draft ticks task (archived 2026-09-30, clean at round 6) closed every
post-landing exit of `handleSubmit` in `frontend/src/pages/edit.js` with a clear
placed at that exit: one after each arm's broadcast, one after each arm's
`invalidatePaperCache` await, and one in the shared terminal catch behind the
`landed` marker. Across its six rounds a set of related questions was
deliberately kept out of the implementer's scope and reserved for one architect
decision. They lived only in that task's hold blocks, which the archive trim
drops. This file is their home.

## The decision

Whether a spent draft stays protected by exit-by-exit clears, or by a write
barrier in `_writeDraft` (a `_draftSpent` style flag set once the broadcast
lands, so no writer can put the draft back). The barrier removes the class; the
clears are what is on main and what the specs pin per arm and per exit.

## Items that ride on it

1. **The try/catch around `invalidatePaperCache`.** A rejecting invalidation
   sends a landed post to `step = 'error'`. Catching it locally would turn that
   exit into a success. Held back in every round so the clears could be fixed
   without it.
2. **Writer re-arm after an error.** At `step = 'error'` the form is
   interactive, so a keystroke re-arms the debounce and a file selection flushes
   through `_windowReady`. After a landed post that writes the spent draft back.
3. **The unmounted re-clear deletes a successor visit's draft.** The clears
   ahead of the `_mounted` guard run by captured key after the component is
   gone. A later visit to the same paper shares that key. The base did this only
   on a rejecting invalidation; the round-4 prescription widened it to the
   resolving exit. A `savedAt` scoping of the clear was floated as an
   alternative to the barrier.
4. **The same clear-without-cancel shape on `publish.js`.** Not audited exit by
   exit the way `edit.js` was.
5. **`landed` records that the broadcast call resolved, not that nothing is on
   chain.** A broadcast can reject with the transaction on chain: on the light
   path a lost response or an error status after the server-side broadcast, on
   the Keychain path a late node error after acceptance. The client cannot tell,
   and keeping the draft is the right default. Two comments say more than the
   code knows: the terminal catch comment in `handleSubmit` ("nothing landed")
   and the header of the spec `a broadcast that fails before landing keeps the
   flushed draft` in `frontend/tests/unit/pages-edit.test.js` ("has put nothing
   on chain"). Reword both to "the broadcast did not resolve" when this area is
   next touched. Not traced: what a retry from the kept draft does after an edit
   that did land, since the form has not reloaded the new chain head it diffs
   against.
6. **Coverage note.** No spec drives the file-selection writer
   (`handleSupplementaryFiles` reaching `_windowReady`'s flush) during the
   invalidation await. The specs stage only the debounce arm.

## Related

`agents/docs/tasks/blocked/ui-composer-surfaces-navigate-over-undrafted-work.md`
carries the same-instance edit-to-edit `draftKey` re-pointing residual. A write
barrier or a captured key would both bear on it.

## Output

A decision recorded in `agents/docs/ARCHITECTURE.md`, and a ui task under
`tasks/pending/` if the decision changes code. Items 5 and 6 can ride with that
task or be dismissed there.

## The mis-cited spec's own header still claims the coverage it lacks (archived 2026-09-30)

Architect archive note (2026-09-30, round 2): archived after two rounds with one P3 routed
onward. Re-reviewed `7551b218` alone (an ancestor of `main`, four files under
`frontend/tests`, +21/-16, comment-only) with /ce-code-review: correctness,
project-standards on root `CLAUDE.md`, testing, adversarial in-process (no different-model
peer on this host) and learnings. All three items held on 2026-09-22 and the same-day
architect note are FIXED.

- Items 1 and 2 and the two further citers: all seven sites name the posting-key
  availability guard. Checked against the custody broadcast handler on both the consent-op
  and session-window paths: row read, missing-row 401, upgrade 403, then the guard's 500
  `Posting key not available`, with `decryptKey` on the next statement.
  `expectPostGateStop` pins exactly that envelope. `git grep "posting-key decrypt"` and
  `"first post-gate"` over `frontend/tests` are empty.
- Item 3: clause (a) states the actual condition (the ORCID test stubs the callback at the
  network layer instead of driving the in-network stub). Clause (c)'s gap sentence is
  unchanged and still true.
- Comment-only confirmed; no new slug, ordinal, line, SHA or bare positional anchor.

One finding, P3, four lenses: `expectPostGateStop`'s JSDoc says the outer catch's generic
envelope "would mean a step past the guard threw", but the account-row read sits in the
same `try` ahead of the guard. The wording was transcribed from the hold's own
prescription. User triage: not worth a third hold; folded into
`ui-non-consent-spec-comment-options-pin-flip`.

Drift, not caused by this task: backend `4cb4347b` admitted `comment_options` to the
custody allowlist, which falsifies this spec's known-defect paragraph, its "vote is the
only broadcast that reaches the gate" sentence and the comment test's 403 pin. Routed to
the same new ui task. `790eee0e` touched none of the reworded sentences.

The e2e suite was not re-run; the review was by reading. The clause-(a) solutions entry
written during the hold is refreshed via /ce-compound-refresh alongside this archive. No
new /ce-compound entry.

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
