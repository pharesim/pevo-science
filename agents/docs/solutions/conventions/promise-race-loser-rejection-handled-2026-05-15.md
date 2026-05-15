---
title: Promise.race losing-input rejection is handled — verify before accepting unhandledrejection escalations
date: 2026-05-15
category: conventions
module: frontend
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "A code-review finding claims `Promise.race(...)` produces an unhandled rejection from a losing input"
  - "A reviewer cites a project-side `window.addEventListener('unhandledrejection', ...)` handler as the harm path for an abandoned promise inside `Promise.race`/`Promise.all`/`Promise.allSettled`/`Promise.any`"
  - "Two or more reviewer personas independently escalate the same finding citing unhandled-rejection mechanics"
  - "Reviewing any timeout-racer pattern where `setTimeout` rejects a loser branch that wins the race"
tags:
  - promise-race
  - unhandled-rejection
  - code-review
  - ecmascript
  - reviewer-bias
  - ce-code-review
  - fact-check
---

# Promise.race losing-input rejection is handled — verify before accepting unhandledrejection escalations

## Context

During architect review of `agents/docs/tasks/review/ui-keychain-api-misuse.md` round-5 (commit `8c6b352`), the `/ce-code-review` fleet of 9 personas surfaced a finding about an abandoned `setTimeout` inside a `Promise.race`. The pattern, from `frontend/src/pages/settings.js:887-908`:

```js
const importPromise = new Promise((resolve, reject) => {
  window.hive_keychain.requestImportKey(this.username, wif, (res) =>
    res.success ? resolve(res) : reject(new Error(res.message || 'Keychain import failed'))
  );
});
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('keychain timeout')), 45_000);
});
await Promise.race([importPromise, timeoutPromise]);
```

When `importPromise` wins, the `setTimeout` is never cleared. It keeps firing 45s later and rejects `timeoutPromise`. **Two of nine reviewers (reliability + julik-frontend-races) independently claimed** the eventual rejection becomes "unhandled" because "no `.catch()` is attached to `timeoutPromise`". The julik reviewer escalated to P1 citing `frontend/src/error-tracking.js:15-18` (a real `window.addEventListener('unhandledrejection', ...)` handler that calls `showErrorToast()`) and predicted a spurious "Something went wrong" toast on the success screen 45s after every clean upgrade. The reliability reviewer independently echoed the unhandled-rejection claim at P3.

The intuition is widespread. The intuition is wrong.

## Guidance

When a code-review finding claims `Promise.race` produces an unhandled rejection from the losing input, fact-check with a 5-line node repro before accepting the severity escalation:

```js
let unhandledFired = false;
process.on('unhandledRejection', () => { unhandledFired = true; });
const timeoutP = new Promise((_, reject) => setTimeout(() => reject(new Error('loser')), 50));
const winnerP = new Promise((resolve) => setTimeout(() => resolve('won'), 10));
await Promise.race([winnerP, timeoutP]);
await new Promise(res => setTimeout(res, 200));
console.log(unhandledFired); // false
```

The repro takes ~10 seconds to write and run. It will print `false`.

**Spec mechanism** (ECMAScript §27.2.4.5 `Promise.race`, step 4.h): the race implementation internally calls `Then(nextPromise, resultCapability.[[Resolve]], resultCapability.[[Reject]])` on each input. The `Then` call counts as attaching a handler. The input promise is "handled" forever after, regardless of when it eventually settles or whether the race has already settled. The losing rejection routes into the race's internal `reject`, which is a no-op because the race already settled. `unhandledrejection` does NOT fire.

The same internal-handler-attachment applies to `Promise.all`, `Promise.allSettled`, and `Promise.any`. All four combinators register handlers at construction time.

## Why This Matters

In the FE-KEYCHAIN-API-MISUSE round-5 review, accepting the unhandled-rejection claim would have:
- Escalated a P3 cleanliness finding to P1 user-visible regression
- Held the task open for another round of implementer work (changes to `_performKeychainImport`, a new test asserting `unhandledrejection` does NOT fire on the success path)
- Generated implementer time chasing a non-bug

The escalated severity rested on a falsifiable spec claim. Two independent reviewer personas reached it because the abandoned-promise-becomes-unhandled intuition is widespread in JavaScript code-review heuristics. It is correct for naked `new Promise((_, reject) => ...)` whose rejection has no attached handler. It is wrong for promises passed into `Promise.race`, `Promise.all`, `Promise.allSettled`, or `Promise.any`, all of which attach internal handlers at construction time.

This is a JS-spec fact invisible from `grep`. When a reviewer makes the claim, neither the codebase nor the persona's training corpus differentiates the wrong-intuition case from the genuine unhandled-promise case. Architect-level fact-check is the only defense, and the cost is 10 seconds.

## When to Apply

Run the 5-line node repro before accepting any review finding that:
- Claims `Promise.race(...)` produces an unhandled rejection from a losing input
- Claims `Promise.all(...)` or `Promise.allSettled(...)` losing inputs become unhandled when the wrapper rejects or settles early
- Cites a project-side `unhandledrejection` handler as the harm path for an abandoned promise inside any `Promise.*` combinator

The legitimate residual concern with an abandoned `setTimeout` inside `Promise.race` is timer + closure resource hold (cleanliness, P3) — NOT `unhandledrejection`. If the code wants to be clean, capture the timer id and clear it in a `finally`:

```js
let timerId;
const timeoutPromise = new Promise((_, reject) => {
  timerId = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
});
try {
  await Promise.race([primaryPromise, timeoutPromise]);
} finally {
  clearTimeout(timerId);
}
```

This is the idiomatic JS resource-cleanup pattern. The `try/finally` does not interfere with upstream catch or error handling.

## Examples

**Anti-pattern (review finding that should be fact-checked first):**

> Reviewer: This `setTimeout(45_000)` is never cleared. When `importPromise` wins, the abandoned promise will reject 45s later with no `.catch()` attached. The project has a `window.addEventListener('unhandledrejection', ...)` handler that calls `showErrorToast()`. Every successful upgrade will produce a spurious error toast 45s after success. **P1.**

**Correct architect response:**

Run the node repro. Get `unhandledFired = false`. Downgrade the finding to P3 cleanliness-only. Document the falsification in the hold block (or dismissal note) so the implementer does not get whiplashed by the original framing. If multiple reviewers converged on the false escalation, surface the convergence + falsification together so the user can see both that the bias is real and that the bias does not survive the fact-check.

## Related

- [[constructor-throw-in-settimeout-escapes-as-uncaught-exception]] — same `Promise.race` timeout-racer pattern in PEvO (`broadcastJsonWithTimeout`), but a structurally different hazard (constructor throw escaping the call frame as an `uncaughtException`). Mechanically unrelated to this convention; the resemblance is at the pattern level only.
- [[verify-library-claims-before-load-bearing-security-margins]] — parent meta-convention for the "plausibility-cascade / verify before accepting" pattern. This learning is an instance of that family applied to ECMAScript spec claims during code review, rather than to third-party library behavior.
- [[verify-resource-knob-math-before-load-bearing-security-margins]] — sibling in the same verify-before-load-bearing family; different domain (runtime arithmetic), same review discipline.
- [[agent-native-persona-calibration-for-pevo]] — establishes that reviewer personas can systematically overproduce findings for PEvO's architecture. This learning is a concrete instance: 2-of-9 persona convergence on a false P1 that didn't survive a 5-line repro.
- [[test-marker-stub-vacuous-or-fallback-2026-05-15]] — a different review-process fact-check pattern (sentinel-prefixed `$t` stub making OR-fallback assertions vacuous); same architect-fact-check posture, different mechanism.
