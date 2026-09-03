---
title: "A guard's reach is the callee graph, not the caller's body: 'check after every await' must be swept transitively into every helper reached after the guard opens"
date: 2026-09-01
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - "Adding a teardown, staleness, or abandonment guard that a caller checks after each of its own await points, then calling a shared helper the caller does not itself await into"
  - "Auditing a 'check the guard after every await' rule for completeness across a multi-caller orchestrator (several consent-op or session-window entry points sharing one helper)"
  - "A shared helper reached after the guard opens contains its own await (a network round-trip) followed by a side effect with no re-check in between (navigation, broadcast, state mutation)"
  - "A sibling fix already threaded the guard or a staleness predicate into the shared helper for ONE caller and the task is to confirm every other caller of the same helper is also covered"
  - "Architect or reviewer intake on a task that lands a guard fix at one call path and must confirm the fix's parent audit also covered sibling call paths into the same shared helper"
symptoms:
  - "The guard opens at the orchestrator's entry and is checked after every await inside that function's own body, but a helper it calls performs its own await before a side effect with no check in between"
  - "Multiple independent reviewers each surface the same class of gap that a prior review round already held and only partially fixed at one call path"
  - "A cross-tab subject change (logout, or login as a different user) lands during a callee's network round-trip and the departed subject's tab proceeds with the side effect (navigation, broadcast) anyway"
  - "The fix history shows a guard or staleness predicate threaded into a shared helper for exactly one caller while the helper's other callers still call it on the pre-fix signature"
related_components:
  - authentication
  - development_workflow
tags:
  - fresh-auth
  - guard-coverage
  - callee-graph
  - teardown
  - consent-op
  - transitive-audit
  - race-condition
  - frontend
---

# A guard's reach is the callee graph, not the caller's body: 'check after every await' must be swept transitively into every helper reached after the guard opens

## Context

PEvO's light-account fresh-auth flows run in a tab whose JWT subject can change underneath them: an explicit logout, or a login as a different user in another tab that arrives through the `storage` event. The auth store funnels both into one scrub, `_scrubSubjectBoundState` in `frontend/src/auth.js`: `disconnect` calls it directly, and `_adoptSubject` calls it when the incoming subject differs from the tab's marker, which is where the cross-tab path lands. The scrub clears the proof caches and the password-factor memo, calls `abandonInFlightAcquisitions()`, dismisses an open re-auth prompt, and removes every key in `SUBJECT_BOUND_STORAGE_KEYS` (`frontend/src/lib/subject-bound-keys.js`), which includes the per-tab ORCID mode marker.

`abandonInFlightAcquisitions` in `frontend/src/lib/fresh-auth.js` bumps a module-level counter, `_acquireGeneration`. The subject teardown guard is a snapshot of that counter: `subjectTeardownGuard()` captures the generation at open time and exposes `tornDown()` (the generation moved) and `cancel()` (toast once, return `FRESH_AUTH_CANCELLED`). Its docblock states the design rule: open the guard before the first await of the stretch, because a guard opened after the teardown compares the post-teardown value against itself and never fires, which is the whole reason the guard is a value callers pass down rather than something each layer captures for itself. `mintViaPasswordFactor` states the companion rule, "every await below is also a teardown boundary", and checks the guard after each of its awaits.

The two consent-op orchestrators adopt the rule. `withSettingsFreshAuth` (`frontend/src/lib/settings-fresh-auth.js`) opens one guard at entry, described as covering the whole action: the status read, the prompt, the mint, the guarded call, and the retry gate's re-mint. It passes the guard into `resolveProof`, which checks it after the status-read await and threads it into `mintViaPassword`, and into `consentOpFreshAuthRetryGate` as the `guard` hook. `withAuthorshipFreshAuth` (`frontend/src/lib/authorship-consent.js`) is the same shape. `consentOpFreshAuthRetryGate` checks the guard after its own status-read await and calls the `mint` hook with the guard threaded.

Every await in those bodies was covered. The enumeration stopped at the call boundary. Both `resolveProof`s have two branches that leave the body: the passwordless branch and the ORCID-fallback branch after an assumed-password 401. The retry gate has a third exit, its `beginOrcidRedirect` hook. All three resolve to `beginSettingsActionOrcidFreshAuth` or `beginAuthorshipOrcidFreshAuth`, one-line wrappers around `beginOrcidFreshAuthRedirect`. That helper writes the return path and the per-tab mode marker, then awaits `startOrcid(mode, extra)`, a network round-trip, and then navigates with `window.location.href = data.redirect_url`. A subject change landing inside the `startOrcid` await is invisible to it unless a predicate is threaded in. When this entry was written neither consent-op starter threaded one, and the helper's own docblock recorded that as intended, naming the page-level and consent-op redirect starters as callers that pass none and keep the unconditional navigation. Both halves of that sentence have since been corrected. The consent-op starters now thread the orchestrator's predicate through `beginOrcidUnderGuard`, and the docblock's claim about the page-level flows was itself false: those flows never reach this helper at all, they write their own mode marker and call `startOrcid` directly. Every caller of the helper supplies a predicate today.

The identical gap had already been found on the session-window path. `acquireSessionProof` snapshots the generation itself, checks it after every await in its body, and reaches the same helper through `beginSessionAuthOrcidRedirect`. The fix for that leg threaded a staleness predicate, `isStale`, into `beginOrcidFreshAuthRedirect` as an optional fourth parameter, re-checked immediately after the round-trip and before the navigation, and passed `() => generation !== _acquireGeneration` from the session leg. That fix landed scoped to its own caller. At architect review of the consent-op guard work, three reviewers converged independently on the same finding: the shared helper still had an unguarded await-then-navigate for the two consent-op callers. That gap is now closed, and the audit this entry prescribes is what closed it.

How the split happened (session history): the review pass that first found the `startOrcid` gap found it on the session-window leg and held it there. The same pass found that the consent-op orchestrators had no generation check at all and routed that as a new task; the redirect helper was not carried into the new task's scope. The implementation session for the consent-op guard never referenced `startOrcid` or `beginOrcidFreshAuthRedirect`; its scope stopped at the mint primitives and the retry legs. Asked whether to compound the pattern after the first pass, the architect declined it as another instance of the general "sibling surfaces reopen a completed sweep" rule rather than a new class. The recurrence is the evidence that the general rule did not prevent it; the actionable form is the one below.

## Guidance

A teardown or staleness guard protects exactly the code that holds it. "Check after every await" is a property of a call tree, not of a function body, so the audit unit is the callee graph reached after the guard opens, and, for any shared helper, the helper's full caller set.

1. **Enumerate the callee graph from the guard's open site.** Walk every call expression reached after the guard is opened, including hooks and callbacks handed to other modules. For the consent-op flows the chain is: `withSettingsFreshAuth` / `withAuthorshipFreshAuth` -> `resolveProof` -> the factor read (`passwordFactorFor` / `resolvePasswordFactor`) -> `mintViaPassword` -> `mintViaPasswordFactor` -> (ORCID branch) `beginOrcidUnderGuard` -> `beginSettingsActionOrcidFreshAuth` / `beginAuthorshipOrcidFreshAuth` -> `beginOrcidFreshAuthRedirect` -> `startOrcid` -> `window.location.href`. Plus the retry gate: `consentOpFreshAuthRetryGate` -> `resolveFactor` hook -> `mint` hook -> `beginOrcidRedirect` hook -> the same starter -> the same helper -> the same navigation, and `run(retry)`.

2. **Classify each callee by "await before side effect".** Read the callee's body, not its name. If it performs no await before its irreversible effect (navigation, broadcast, storage or cache write, toast), it is safe under the caller's last check. If it does, thread the guard, or a predicate derived from it such as `guard.tornDown`, into it and re-check right after that await and before the effect. `beginOrcidFreshAuthRedirect` is the second kind: one await (`startOrcid`) between the caller's last check and a full-page navigation.

3. **When a shared helper gains a predicate parameter, grade every caller.** The fix that added `isStale` to `beginOrcidFreshAuthRedirect` was correct for `beginSessionAuthOrcidRedirect` and left the two consent-op starters passing nothing. A caller that passes no predicate must be one that genuinely runs outside any guarded flight, not one that happens to belong to a different task. `git grep -n 'beginOrcidFreshAuthRedirect('` returns the audit set; a docblock that lists the unguarded callers by name is a finding, not a resolution. Grade the tests by the same rule: once every caller threads a live predicate, a suite whose cases omit the parameter is exercising a shape production no longer has, and cannot tell the guard's condition from its mere presence.

4. **Pass the guard down as a value; do not let each layer capture its own.** The existing rationale in the `subjectTeardownGuard` docblock already says why: a guard opened inside a callee, after the caller's earlier awaits, captures a generation the teardown may already have moved and never fires. The consent-op starters are exactly such a callee, so the predicate must originate at the orchestrator's guard and travel through the starter, as it already does through `mintViaPassword` and the retry gate's `guard` hook.

The helper carries the seam and every caller now reaches it through the orchestrator's own guard. The landed shape, abridged to the seam (the real helper also stashes the return path, unwinds its throw exits, and validates the redirect host):

```js
// fresh-auth.js: the re-check between the round-trip and the navigation
async function beginOrcidFreshAuthRedirect(mode, extra, returnPathDefault, isStale) {
  sessionStorage.setItem(ORCID_MODE_KEY, mode);
  const data = await startOrcid(mode, extra);          // teardown can land here
  if (isStale?.()) return FRESH_AUTH_CANCELLED;         // re-check before the effect
  window.location.href = data.redirect_url;             // the irreversible effect
  return FRESH_AUTH_REDIRECT_PENDING;
}

// the consent-op starters thread the orchestrator's guard through
export async function beginSettingsActionOrcidFreshAuth(action, isStale) {
  return beginOrcidFreshAuthRedirect('fresh_auth', { action }, '/settings', isStale);
}
// settings-fresh-auth.js, both ORCID branches and the retry-gate hook, via one
// wrapper that also maps the cancel through the guard:
async function beginOrcidUnderGuard(action, guard) {
  const started = await beginSettingsActionOrcidFreshAuth(action, guard.tornDown);
  return started === FRESH_AUTH_CANCELLED ? guard.cancel() : started;
}
```

The authorship starter and `withAuthorshipFreshAuth` took the same change. Note what the stale branch does NOT do: it leaves the flow keys alone. The predicate reads true only after the subject scrub has already removed them, so anything standing in their place belongs to a later flow in the tab, and a departed flight that tidied on its way out would strand it. The invariant to preserve is that no caller inside a guarded flight reaches the navigation without the flight's own predicate, and a cancelled return from the starter is mapped through `guard.cancel()` so the teardown reports once.

## Why This Matters

The observable harm is concrete. A cross-tab login as a different user during the `startOrcid` round-trip lets the departed subject's action navigate the new subject's tab to ORCID. The scrub has already removed the per-tab ORCID mode marker, so when the tab returns, the callback page (`frontend/src/pages/orcid-callback.js`) reads an empty mode, matches none of its dispatch branches, and dead-ends. The user has lost their page, spent a round-trip, and gets no proof; the backend has an ORCID start it will never complete.

Per-body audits feel complete because the function whose guard was just added visibly checks after each of its own awaits, and every callee it calls "just starts the redirect". The name of a callee says nothing about whether it awaits before its effect. `beginSettingsActionOrcidFreshAuth` reads like a synchronous handoff; it is a network round-trip followed by navigation.

It recurred because two fixes were filed for the same helper from two callers, each scoped to its own caller. The session-leg fix threaded the predicate for `beginSessionAuthOrcidRedirect` and documented the consent-op starters as intentionally unguarded; the consent-op guard work covered the orchestrator bodies and stopped at the starter boundary. Each was complete for its own scope. The helper's caller set is the unit that was never audited as a whole. A sweep that is complete for its own task scope is silently reopened when a parallel task adds another path of the same class (auto memory [claude]); the callee graph and the caller set are how that rule is made checkable for guards.

This is the guard-reach instance of two conventions already in this corpus: mutation probes and discriminating tests are per site, not per fix (`agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md`), and widening an outcome vocabulary is a consumer audit, not a new member (`agents/docs/solutions/conventions/outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md`). The helper-contract entry (`agents/docs/solutions/conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md`) makes the same point for defaulting semantics: diff-touched call sites are not the audit set.

## When to Apply

- Adding or extending any generation, epoch, or staleness guard (`subjectTeardownGuard`, the `_acquireGeneration` snapshot in `acquireSessionProof`, the password-factor memo's generation, or a future equivalent).
- Any code comment or task acceptance criterion that says "check after every await", "every await is a teardown boundary", or "all N awaits covered": the claim is only true after the callee graph has been walked.
- Any shared helper that both awaits and then performs an irreversible side effect: full-page navigation, a Hive broadcast, a sessionStorage or localStorage write, a cache write that a scrub may have just emptied, a toast that reports on behalf of a subject.
- Re-reviewing a task that claims full coverage of a guard: at intake, re-enumerate from the code (`git grep -n 'await'` over each callee) rather than from the task's list.
- A sibling task is fixing, or has just fixed, the same helper from a different caller. The two fixes must be reconciled against the helper's full caller set before either is archived; splitting the callers of one helper across two tasks is how this gap survived a review that had found it.

## Examples

**The PEvO instance.** `withSettingsFreshAuth` and `withAuthorshipFreshAuth` open a guard at entry and re-check it after every await in their own bodies, in `resolveProof`, in `mintViaPasswordFactor`, and in `consentOpFreshAuthRetryGate`. `beginOrcidFreshAuthRedirect`, reached from three sites per orchestrator (the passwordless branch, the ORCID-fallback branch, the retry gate's `beginOrcidRedirect` hook), awaits `startOrcid` and then navigates. For a period the two consent-op starters passed it no predicate while the session-window caller did; all three sites per orchestrator now route through `beginOrcidUnderGuard`, which threads the orchestrator's `guard.tornDown`.

**The session-window twin.** `acquireSessionProof` reaches the same helper through `beginSessionAuthOrcidRedirect` and passes its flight's staleness predicate, which the helper checks before navigating. That was the finished shape for one caller while the consent-op starters, the other callers of the same helper, still lacked it.

**A checklist an implementer can run.**

1. Find the guard's open site (`const guard = subjectTeardownGuard()` or `const generation = _acquireGeneration`). Everything reachable after that line is in scope.
2. List every callee reached after it, including hooks passed as options (`beginOrcidRedirect`, `mint`, `resolveFactor`, `run`).
3. For each callee: `git grep -n 'await' -- <file>` and read the body; write down each await and every side effect that follows it (navigation, broadcast, storage write, cache write, toast).
4. Classify: no await before the effect, safe under the caller's last check; otherwise thread the predicate and re-check after the await and before the effect.
5. For any helper that gained a predicate parameter: `git grep -n '<helper>('` and grade every caller. A caller passing nothing must be provably outside any guarded flight.
6. Add a test per caller, not per fix: tear down (bump the generation, or run the real scrub) while the awaited round-trip is pending, and assert the side effect did not fire and the flow resolved as `FRESH_AUTH_CANCELLED`.
7. Add the same test's opposite: a live predicate that answers false, driving the same helper to the same exit, asserting the effect DID fire. Step 6 alone leaves the guard's other direction unpinned, and a suite holding only step 6's cases plus cases that omit the parameter cannot distinguish a guard that reads its predicate from one that merely checks a predicate was passed.

## Related

- Two entries bound this one, and both landed after it. Apply them in this order. `agents/docs/solutions/conventions/await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md` is the logically prior gate: an await hosts a teardown only if it yields to a macrotask, so an await that fails that test is not a site at all and the question below never arises. `agents/docs/solutions/conventions/subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md` then decides what to do at each surviving site: a check earns its place only where the step after it would otherwise take identity or credential material from the ambient store, or land its effect on something the current subject owns. This entry answers where to LOOK; neither the Guidance nor the checklist below answers whether a site found that way deserves a check, and threading a predicate everywhere one CAN rather than everywhere one MUST is how a sweep re-adds guards a later reader removed on purpose.
- `agents/docs/solutions/conventions/optional-predicate-gate-needs-live-false-case-not-just-absent-2026-09-02.md`: what step 7 above exists for. Once the sweep prescribed here threads a predicate into every caller, the suite's no-predicate cases match no caller, and the guard's presence-vs-truth reading goes untested.
- `agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md`: the test-coverage form of the same rule (per site, not per fix); its worked example names the same settings/authorship twin pair.
- `agents/docs/solutions/conventions/outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31.md`: the outcome-vocabulary form (every consumer of a shared fresh-auth mechanism, not the one the finding named).
- `agents/docs/solutions/conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md`: when a shared helper's contract changes, untouched adopters are the audit set.
- `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`: the backend form (a predicate fixed at one composition site while a sibling site is missed).
- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`: adjacent but distinct: that entry is about when a guard is written relative to the first await inside one function; this one is about whether a guard's predicate reaches a callee's own await.
