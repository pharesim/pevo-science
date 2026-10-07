# The ORCID callback's session-window leg caches a proof it never type-checks

**Owner:** ui
**Created:** 2026-09-14
**Priority:** normal

Routed out of the round-4 re-review of the shared-dispatch task (an adversarial
residual, confirmed at HEAD by the architect). Low priority: pre-existing,
reachable only through a backend contract violation, and nothing is
misclassified. Filed for consistency with the mint-leg null coercion that round
closed, so the window slot's two writers hold the same standard.

## Why

The window slot has two writers. `acquireSessionProof`'s mint callback
(`lib/fresh-auth.js`) now narrows a non-string `fresh_auth_proof` to `undefined`
so the fail-closed guard refuses it, says so, and the acquisition-level drop
evicts the entry it wrote. The other writer is `_handleSessionAuth` in
`pages/orcid-callback.js`: it calls
`cacheSessionProof(data.fresh_auth_proof, data.expires_at, data.absolute_expires_at)`
with the response value unexamined, toasts `orcid.reauthSuccess`, and navigates
to the return path. Its sibling in the same component, `_handleFreshAuth`
(the consent-op leg), refuses a non-string or empty `fresh_auth_proof` BEFORE it
caches, by setting the page's error state and returning; the session-window leg
has no such check.

What a malformed response does on that leg depends on its shape, and neither
outcome is one the user is told about. A `null` (or absent) proof writes a
tokenless entry that `readSessionWindow` drops on the next read, so the next
gate on a passwordless account starts cold and begins another ORCID round-trip:
a success-toasted redirect loop with no refusal anywhere. A truthy non-string (a
number, an object) survives the JSON round-trip through `sessionStorage`, and the
next gate's fail-closed guard refuses, toasts and evicts it, after which that
gate also starts cold. Neither is a lockout; both are a re-auth act the user is
told succeeded and is then charged again.

## Scope

1. In `_handleSessionAuth`, mirror the consent-op leg's guard: when
   `typeof data.fresh_auth_proof !== 'string' || !data.fresh_auth_proof`, set
   `this.status = 'error'` and `this.errorMessage` to the same
   `orcid.verificationFailed` copy the sibling uses, and return before
   `cacheSessionProof`, the return-path clear, the success toast and the
   navigation. The deadlines need no check here: `cacheSessionProof` already
   fails closed on a non-finite deadline by dropping the slot.
2. Pin it through the page component with one case per shape the wire can
   produce (`null`, a number): nothing cached, no success toast, the error state
   shown, no navigation. Model the cases on whatever spec already drives
   `_handleFreshAuth`'s guard; if none does, that is a pre-existing gap to note
   in the signal block, not to close here.
3. No change to `cacheSessionProof`: its contract is to write what it is handed
   (the readers own the corruption checks and the writers own the wire), and
   the mint-leg coercion deliberately kept the raw write for the same reason.

## Acceptance criteria

1. A session-auth callback response whose `fresh_auth_proof` is not a non-empty
   string caches nothing, shows no success toast, does not navigate, and lands
   the page in the same error state a malformed consent-op response does.
2. The string-proof path is unchanged; its existing specs pass unmodified.
3. Suite green; deleting the new guard reddens exactly the new specs and
   nothing else (measured in a private copy, not this checkout).

## Notes

Comment text must stay free of line numbers, SHAs, task slugs and bare
positional anchors. The one docblock sentence that names the mint callback as
"the only coercion the wire needs" (in `ensureSessionWindow`'s fail-closed
guard) is scoped to the sentinel space and stays true after this lands, since
this writer never returns into the vocabulary; do not edit it for this task.

## UI implementation signal (2026-09-29, commit 91e6f22d)

Landed in `91e6f22d` (verified: `git merge-base --is-ancestor 91e6f22d main`).

- **Scope 1 / AC 1.** `_handleSessionAuth` now refuses
  `typeof data.fresh_auth_proof !== 'string' || !data.fresh_auth_proof` with
  `status = 'error'` and `orcid.verificationFailed`, returning before
  `cacheSessionProof`, `clearReturnPath`, the success toast and `navigate`.
  No deadline check added.
- **Scope 2.** New `_verify - session_auth mode` describe in
  `tests/unit/pages-orcid-callback.test.js`, an `it.each` over `null` and `42`
  modeled on the consent-op leg's proof-shape table. Each case drives
  `_verify(..., 'session_auth')` and asserts: error state and copy, no
  `pevo_fresh_auth_session_proof` entry, return path still stored, no toast,
  no navigation.
- **Scope 3.** `cacheSessionProof` untouched; the `ensureSessionWindow`
  docblock sentence untouched.
- **AC 2, pre-existing gap noted.** No unit spec drives the session_auth
  string-proof path through the page component. Its only coverage is the E2E
  `orcid-callback session_auth caches the issued proof in sessionStorage` in
  `tests/e2e/non-consent-fresh-auth.spec.js` (not run for this change; the
  guard does not touch the string path). Not closed here, per scope 2.
- **AC 3.** Frontend unit suite: 86 files, 1957 tests, exit 0. Mutation in a
  scratchpad copy (guard deleted): exactly the two new cases fail. The copy
  also fails `sec-001-equivalence.test.js` at file load because it imports
  `backend/src/lib/authMessage.ts`, which the frontend-only copy lacks; it
  fails identically with the guard restored, so it is a copy artifact.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `91e6f22d` with `/ce-code-review` (correctness, project-standards,
testing, adversarial, frontend-races, learnings, plus one validator). The guard
is correct and in the right place, and every claim in the signal block
reproduced in a scratchpad copy of the commit: unit suite 86 files / 1957 tests,
exit 0; build clean; guard deleted, exactly the two new cases fail. Three items
hold it. Item 1 is wording that came from this task's own Why and scope 1, not
from the implementation, and is charged to the architect.

1. **Rewrite the rationale so it is true, in both comments.** Sites: the
   comment above the new guard in `_handleSessionAuth`, and the comment opening
   the `_verify - session_auth mode` describe. Two claims are wrong as written.
   - "The deadlines need no check here: `cacheSessionProof` already drops the
     slot on a non-finite deadline." On this leg the drop is not a defence.
     With a string proof and an absent or unparseable `expires_at` or
     `absolute_expires_at`, `anchoredSpan` returns NaN, `cacheSessionProof`
     drops the slot and returns nothing, and the handler still clears the
     return path, toasts `orcid.reauthSuccess` and navigates, so the next gate
     finds no window. (A `null` deadline is different: `new Date(null)` is the
     epoch, `anchoredSpan` falls back to the mirrored period, and a usable
     window is cached.) Say instead that an unanchorable deadline is left to
     `cacheSessionProof`, whose drop still lets this page report success and
     costs a later re-auth, and that the shape is left open because the backend
     always issues both deadlines and the consent-op leg leaves its own deadline
     to the same kind of read-side drop. Do NOT add a deadline check: widening
     the guard was considered and dismissed (reachable only through a backend
     contract violation, and it would break parity with the consent-op leg).
   - "either way that gate starts another ORCID round-trip". True for a null
     proof: `readSessionWindow` drops a falsy token, so the next gate finds no
     window and re-auths from scratch. Not true for a truthy non-string:
     `readSessionWindow` keeps it, `evictUnnamedAcquisition` clears the slot,
     and `ensureSessionWindow` refuses with `{ ready: false, failed: true }`,
     which its consumer reports as a failure. That gate starts no round-trip;
     the user's next attempt finds the slot empty and starts one. State what
     each shape costs: a null proof, a silent re-auth at the next gate; a
     truthy non-string, a refusal at the next gate and a re-auth at the attempt
     after it. Both follow a success toast.
   The comment-anchor rules apply as usual: stable symbol names only, no line
   numbers, SHAs, task slugs or bare positional anchors.

2. **Pin the truthiness arm.** Add `{ label: 'empty-string', proof: '' }` to the
   session_auth `it.each`. `null` and `42` are both refused by the `typeof`
   arm, so dropping `|| !data.fresh_auth_proof` leaves the file green (81/81,
   measured by three reviewers and the validator). The validator measured an
   empty-string row red against that mutant and green against the real guard.
   No `undefined` row: the `typeof` arm refuses it exactly as it refuses `null`,
   so it discriminates nothing.

3. **Pin the accepted path through the page.** Add one session_auth case with a
   non-empty string proof and valid deadlines, asserting: the window slot holds
   that token, the return path is cleared, `orcid.reauthSuccess` is toasted,
   navigation goes to the stored return path, and `status` is not `'error'`.
   Today no unit spec reaches past the new guard on this leg: an always-refuse
   mutant (`if (true) {`) passes all 81 specs in the file, and only the E2E
   `orcid-callback session_auth caches the issued proof in sessionStorage`
   would catch it. AC 2 assumed unit specs already covered this path; the
   signal block correctly reported that none did, and this item closes it.

Signal block for the re-review, each measured in a private copy, not this
checkout: (a) dropping `|| !data.fresh_auth_proof` reddens exactly the
empty-string row; (b) an always-refuse guard reddens exactly the new
accepted-path case; (c) deleting the whole guard reddens exactly the three
rejection rows. Suite green, by exit code.

Dismissed at triage, no action: widening the guard to the deadlines; the
consent-op leg's matching deadline gap (pre-existing, contract-violation only,
no task filed); the return path left stored on refusal, and an older window
entry left in place rather than overwritten (both traced harmless).

## UI re-review signal (2026-10-07, commit b2aa6c25)

Landed in `b2aa6c25` (verified: `git merge-base --is-ancestor b2aa6c25 main`).
Two files: `frontend/src/pages/orcid-callback.js` (comment only) and
`frontend/tests/unit/pages-orcid-callback.test.js`.

- **Item 1.** Both comments rewritten. The round-trip claim is gone from
  both. Each now states the cost per shape. A falsy proof is dropped on the
  next slot read, so the next gate finds no window. A truthy non-string is
  refused as a failed re-auth by the first gate the slot hands it to, and
  evicted, so the gate after that finds none. Both would follow a success
  toast. The deadline sentence, in the source comment only (the describe
  comment never carried it), now says that an unanchorable deadline makes
  `cacheSessionProof` drop the slot while the page still reports success.
  It says why the deadlines go unchecked: the backend always issues both
  (`handleSessionAuth` / `issueSessionFreshAuthToken`, both return paths),
  and the consent-op leg leaves its deadline to `getCachedConsentOpProof`.
  No deadline check was added. Three wording departures from the hold, each
  forced by the code:
  - The hold's "the same kind of read-side drop" became "which drops an
    unreadable one on read". The session leg's drop is at write time, in
    `cacheSessionProof`, so "same kind" would have been false.
  - "Re-auth" became "finds no window". A non-navigating gate
    (`allowRedirect: false`) returns `reauthRequired` and starts no re-auth
    itself.
  - "Refusal at the next gate" became "the first gate the slot hands it to".
    A gate reading inside its pre-flight margin gets a miss from
    `readSessionWindow` without a clear. So does a gate after the idle
    deadline. In both cases the entry is never handed over and never refused
    as `failed`. This one was caught by a probe-backed verification pass (see
    below) and narrowed, not qualified.
- **Item 2.** `{ label: 'empty-string', proof: '' }` added. No `undefined` row.
- **Item 3.** New case `session_auth with a string fresh_auth_proof: caches the
  window, clears the return path, toasts success, navigates back`, with a
  non-empty proof and parseable deadlines. It asserts the five listed
  behaviours: the slot token, the return path cleared,
  `('orcid.reauthSuccess', 'success')`, `navigate('/publish')`, and status
  not `'error'`.
- **Measurements.** Each was run as the full frontend unit suite in a private
  two-level scratchpad copy (frontend plus `backend/src/lib/authMessage.ts`),
  not this checkout:
  - Baseline: 98 files / 2286 tests, exit 0.
  - (a) Dropping `|| !data.fresh_auth_proof` fails exactly the empty-string
    row. Result: 1 failed / 2285, exit 1.
  - (b) `if (true) {` fails exactly the new accepted-path case. Result:
    1 failed / 2285, exit 1.
  - (c) Deleting the guard fails exactly the null, numeric and empty-string
    rows. Result: 3 failed / 2283, exit 1. The first run of (c) also failed
    `lib-fresh-auth-session-window > the slide never pushes past the absolute
    cap`, the known 1 ms clock flake; that file does not import the page. A
    re-run gave exactly the three rows.
- **Suite.** Checkout, final tree: 98 files / 2286 tests, exit 0. The
  callback spec file alone: 83/83.
- **Verification pass.** A four-lens workflow (claim trace, adversarial,
  hold compliance plus standards, test strength) checked the diff with
  probes in private copies, with three refuters per finding. 54 claims were
  checked. One finding survived 3/3: the margin overclaim, now narrowed and
  described in the Item 1 list. The test-strength lens planted 11
  accepted-path regressions; each one fails only the new case.
  Noted, no action:
  - A swapped-deadlines mutant survives. It is equivalent in practice:
    `anchoredSpan` clamps both spans to the mirrored periods.
  - Dropping `_handleSessionAuth`'s own `_mounted` check survives. `_verify`
    checks `_mounted` before dispatch, and the line predates this change.
- **Learnings checkpoint.** Three entries name the touched symbols:
  `fail-closed-guard-must-replace-the-recovery-a-round-trip-provided`,
  `sibling-docblock-tallies-must-each-state-precisely-what-they-count` and
  `fresh-auth-guard-coverage-must-sweep-the-callee-graph`. None claims
  anything about the callback's session-auth writer, and nothing this work
  established contradicts them. No new entry: the margin miss-without-clear
  behind the narrowing is already in `readSessionWindow`'s docblock.
