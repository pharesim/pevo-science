# Draft lifecycle on the composer pages: decide between a write barrier and exit-by-exit clears

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
