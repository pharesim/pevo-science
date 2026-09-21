# The consent-op mint callbacks hand an empty-string proof to the guarded call

**Owner:** ui
**Created:** 2026-09-16

Surfaced by the reachability lens of the adversarial pass over
`ui-empty-string-proof-reads-as-ready-window`, confirmed at HEAD, and filed on
the user's triage. It is the consent-op twin of that task: the same type-only
narrowing, on the two mint callbacks that task's scope did not cover.

## What happens

Both consent-op orchestrators bind the password factor through a local
`mintViaPassword`, and both callbacks end the same way:

- `frontend/src/lib/settings-fresh-auth.js`:
  `return typeof proof === 'string' ? proof : FRESH_AUTH_MINT_FAILED;`
- `frontend/src/lib/authorship-consent.js`: the identical line.

`''` is a string, so a mint response carrying `"fresh_auth_proof": ""` is handed
back verbatim. From there:

1. `resolveProof` returns it. It is not `FRESH_AUTH_ORCID_FALLBACK`.
2. `withSettingsFreshAuth` / `withAuthorshipFreshAuth` compare it against the
   four sentinels with strict equality. `'' === null` is false, so it clears the
   `FRESH_AUTH_REDIRECT_PENDING` rung and every other, and reaches `run('')`.
3. Every `run` omits the field on a falsy proof. The settings and admin API
   functions in `api.js` spread `...(freshAuthProof ? { fresh_auth_proof } : {})`,
   and the paper-detail authorship call site passes
   `proof ? { freshAuthProof: proof } : {}` into `broadcastOps`, whose own
   `if (freshAuthProof)` would drop it anyway. So the request leaves with no
   proof at all.
4. The backend's consume check (`consumeFreshAuthTokenForSurface`) treats that
   as `reason: 'missing'`, which is in `REMINTABLE_REASONS`.
5. `consentOpFreshAuthRetryGate` therefore re-resolves the factor and mints
   again through the SAME callback, which prompts the user for their password a
   second time, gets `''` again, and calls `run('')` again. The second refusal
   is terminal: `{ freshAuthFailed: true }`.

Observed, not just traced. Driving each orchestrator in a private copy with the
mint mocked to `''` and `run` mirroring the real consumers (rejecting
`FRESH_AUTH_REQUIRED` / `missing` on a falsy proof) gave the same result on both
surfaces:

```
current:            {"out":{"freshAuthFailed":true},"runCalls":["",""],"prompts":2,"mints":2}
with && proof:      {"out":{"freshAuthFailed":true},"runCalls":[],"prompts":1,"mints":1}
```

So today a user who types a correct password is asked for it again, the tab
spends two mints and two refused writes (on the authorship surface, two refused
broadcasts), and the message they end on blames re-authentication for a failure
they had nothing to do with. The outcome object is the same either way; what
changes is everything it cost to get there.

## Why it is worth closing

After `ui-empty-string-proof-reads-as-ready-window`, these two lines are the
last type-only proof narrowings in the frontend except one that is already
owned:

- The session-kind mint callback in `acquireSessionProof` now reads
  `typeof proof === 'string' && proof`.
- `_handleFreshAuth` in `pages/orcid-callback.js` guards the consent-op cache
  write with the two-part predicate.
- `getCachedConsentOpProof` drops an entry on
  `!entry.token || typeof entry.token !== 'string'`, so the cache leg cannot
  hand an empty proof onward either. The hole is in the mint callbacks only.
- The backend's own consume check is two-part as well.
- The one remaining type-only site, `_handleSessionAuth`, is scoped to
  `ui-orcid-callback-session-window-proof-type-check`, whose scope already
  prescribes the two-part predicate.

The class is complete at these two: `mintViaPasswordFactor` has exactly three
callers (the session acquisition and these two orchestrators), and the first is
already fixed.

Reachable only through a backend contract violation (the issuers answer
`fresh_auth_proof: issued.token`), which is the same reachability the parent
task and the null coercion both had when they were closed.

## Scope

1. In both `mintViaPassword` callbacks, narrow to
   `typeof proof === 'string' && proof ? proof : FRESH_AUTH_MINT_FAILED`. Keep
   landing on `FRESH_AUTH_MINT_FAILED` rather than `undefined`: it is already
   these surfaces' word for re-auth that could not be completed, and both
   ladders turn it into `{ freshAuthFailed: true }` before `run` is reached.
2. Pin it in `lib-settings-fresh-auth.test.js` and
   `lib-authorship-consent.test.js`, one surface each:
   - An initial-leg case: an empty mint yields `{ freshAuthFailed: true }`, ONE
     prompt, ONE mint, and `run` never called. Give it its own `it` rather than
     a fourth row in the existing non-string `it.each`: `''` is not a member of
     that class, and the block's own explanation says the coercion "is a type
     test rather than a null check", which stops being true.
   - A retry-leg case, modelled on the existing
     'a mint that answers without a proof string on the RETRY surfaces
     freshAuthFailed too': first mint good, `run` rejects `missing`, retry mint
     answers `''`. Expect `{ freshAuthFailed: true }` with `run` called exactly
     once. The retry gate mints through the same callback, so a fix that only
     covered the initial resolution would leave this open.
   - Have `run` reject `FRESH_AUTH_REQUIRED` / `missing` on a falsy proof, the
     way every real consumer ends up, rather than resolving. Both suites'
     `beforeEach` default `run` to resolve, and against that default the
     current code reports `{ ok }` on the initial leg, which is red for the
     wrong reason and hides the double prompt this task exists to remove.
3. Prose audit in the same commit: both `mintViaPassword` docblocks ("a
   non-string lands on" in settings, "the honest answer for a non-string" in
   authorship, and the authorship one's deferral to "the twin in
   settings-fresh-auth.js"), and the explanation above each suite's non-string
   `it.each`. Keep the twins saying the same thing.

## Acceptance criteria

1. An empty-string mint on either surface prompts once, mints once, never calls
   `run`, and returns `{ freshAuthFailed: true }`. Observed RED before the fix.
2. An empty-string answer on the retry leg returns `{ freshAuthFailed: true }`
   with `run` called exactly once.
3. Reverting the `&& proof` half on one surface reddens exactly that surface's
   new cases and nothing else. Measured in a private copy, not this checkout.
4. The docblocks and test explanations in Scope item 3 match the landed
   predicate.
5. Suite green, build clean.

## Notes

- Known side effect, already accepted on the session-kind twin, so it need not
  be re-litigated in review: `beginPasswordMintReport` only memoizes on a string
  result, so a mint that verified the password but answered `''` no longer
  refreshes the password-factor memo. The cost is one extra status read on the
  next resolution, during a backend contract violation, and it is exactly how a
  numeric malformed proof already behaves. It cannot trigger the ORCID fallback,
  which needs the mint to THROW a 401.
- Applying the fix to both callbacks in a private copy left all 335 tests in
  the two orchestrator suites, `lib-fresh-auth-consent-op-eviction`,
  `pages-settings`, `pages-admin` and `pages-paper-detail` green, so no existing
  test pins the current behavior.
- Disjoint from `ui-orcid-callback-session-window-proof-type-check`
  (`pages/orcid-callback.js`) and from `ui-window-outcome-tally-source-sentence`
  (`fresh-auth.js` docblocks). Safe to run alongside either.
- Comment text must stay free of line numbers, SHAs, task slugs and bare
  positional anchors; the pre-commit gate catches the article-against-noun form
  ("the case below") but not every variant.

---

**UI implementation signal (2026-09-21, commit `e86d03bb`):**

Both mint callbacks now read
`typeof proof === 'string' && proof ? proof : FRESH_AUTH_MINT_FAILED`
(`frontend/src/lib/settings-fresh-auth.js`, `frontend/src/lib/authorship-consent.js`).
Four new cases landed, one initial-leg and one retry-leg per suite, each using a
module-scope `refusesFalsyProof` so `run` rejects `FRESH_AUTH_REQUIRED` /
`missing` on a falsy proof the way the real consumers do. The docblocks above
both `mintViaPassword` functions and the explanation inside each suite's
non-string `it.each` were rewritten in the same commit.

Evidence per acceptance criterion:

1. Observed RED before the fix. The settings initial-leg case failed on
   `expect(run).not.toHaveBeenCalled()` with the spy recording two calls, both
   `[""]`; the authorship twin recorded the same. Prompts 2, mints 2. After the
   fix: prompts 1, mints 1, `run` never called, `{ freshAuthFailed: true }`.
2. Retry-leg cases green on both surfaces with `run` called exactly once.
3. Measured in private scratchpad copies, never in this checkout. Reverting
   `&& proof` on settings alone: 2 failed / 91 passed, both failures the two new
   settings cases. On authorship alone: 2 failed / 91 passed, both the two new
   authorship cases. Neither surface cross-covers the other. Two further
   mutants for context: dropping the type half instead reddens the pre-existing
   numeric row while the empty-string cases stay green, so both halves are
   independently pinned; and landing on `undefined` rather than
   FRESH_AUTH_MINT_FAILED reddens six settings cases, so the sentinel choice in
   scope item 1 is pinned rather than incidental.
4. Prose audited. A verification pass caught two defects in the first draft and
   both were corrected before this commit: the retry-leg comments had inherited
   the null case's "the leg with more to lose" framing, which is backwards for
   an empty proof (measured pre-fix, the initial leg spends two prompts and two
   refused writes, the retry leg one), and the settings docblock quoted the
   api.js spread in ES6 shorthand elision rather than as it is written.
5. Both suites 93/93. Full frontend unit suite 86 files / 1911 tests green.
   `npm run build` clean. Anchor gate clean on the added lines, checked with a
   live control.

Neighbouring suites green in a private copy: `lib-fresh-auth-consent-op-eviction`,
`pages-settings`, `pages-admin`, `pages-paper-detail` (244 tests).

Two observations for the architect, surfaced rather than acted on:

- The "Why it is worth closing" section describes `_handleSessionAuth` in
  `pages/orcid-callback.js` as the one remaining type-only site. The
  verification pass read it and found no guard there at all: it passes
  `data.fresh_auth_proof` straight into `cacheSessionProof`. That changes what
  its own task is scoped to fix, not this one.
- The type half of the predicate is pinned by exactly one assertion per suite,
  the `4242` row of the non-string `it.each`, since `null` and `undefined` are
  refused by either half alone. Pre-existing, and not weakened by this change.

---

## Architect re-review (2026-09-21) — HELD PENDING FIXES:

First review of `e86d03bb`, via `/ce-code-review` (correctness, adversarial,
testing, project-standards, frontend-races, learnings). The code change is
accepted as landed and is NOT part of this hold: all five acceptance criteria
were re-measured independently in private copies of `e86d03bb` and hold.
Pre-fix red observed (prompts 2, mints 2, `run` twice with `""`); each
single-surface revert reddens exactly that surface's two new cases, confirmed
by three reviewers separately; both retry-leg cases were shown to reach the
second mint; full unit suite 86 files / 1911 tests green and `npm run build`
clean. One comment sentence is held.

**Item 1. The new first-leg comments credit the fix with removing a message it
does not remove.**

In 'an empty-string mint refuses at the first leg, ...' in both
`lib-settings-fresh-auth.test.js` and `lib-authorship-consent.test.js`, the
comment closes:

> what the truthiness half removes is the second prompt and the two refused
> writes, and a re-authentication message that blames a password the user typed
> correctly.

(the authorship twin says "broadcasts" for "writes"). The last clause is false.
The outcome is `{ freshAuthFailed: true }` before and after the fix, which the
same sentence says itself when it opens with "either way", and every caller
turns that outcome into the same string: `settings.reauthFailed` on the four
settings actions and the admin action, `claims.reauthFailed` in
`_broadcastConsentOp`. The user who hits this contract violation still ends on
that message after the fix. What the fix removes is what the case measures: the
second prompt, the second mint, and the refused `run` calls. This task's own
"What happens" section had it right ("The outcome object is the same either
way; what changes is everything it cost to get there"); the comment drifted
from it.

Fix: end that sentence at the measured costs in both files, keeping the twins
saying the same thing. If you want to keep the point about the message, state
it the true way round: the message is unchanged, and it now costs the user one
prompt rather than two to reach it. Comment-only. No assertion changes, so the
mutant measurements above do not need re-running; a green run of the two suites
is enough evidence.

**Not held, offered while you are in those files (skip freely, it will not be
re-raised):** both `mintViaPassword` docblocks call `''` "the one value the
type half cannot refuse". Read literally the type half cannot refuse any
string, and the adversarial pass measured `' '`, `'null'` and
`'[object Object]'` walking the same two-prompt path, refused by the backend as
`expired`. `''` is the one value the consumers DROP, which is what the rest of
each docblock goes on to describe. A tighter phrasing would say that.

**Dismissed at triage (user, 2026-09-21), recorded so re-review does not reopen
them:**

- The retry-leg cases assert `run` once and the outcome but not a mint or
  prompt count of 2, so they would stay green if the gate never reminted
  (measured by two reviewers with the gate forced non-remintable). Dismissed as
  preemptive hardening: on the landed code the cases are sensitive, the shape is
  inherited from each suite's pre-existing null-proof retry case, and a
  different existing case reddens if the remintable set changes. Hardening only
  the new cases would leave the older twins weaker.
- The password-factor memo is no longer written on an empty-proof mint. Already
  accepted in this task's Notes; three reviewers reached it independently
  without being shown that note, and none found a consequence beyond the one
  extra status read.
- Truthy non-proof strings still take the two-prompt path. The client cannot
  tell them from a genuinely expired token without coupling to the token
  format. Out of reach of a client-side narrowing.
- Your observation on `_handleSessionAuth`: confirmed, it passes
  `data.fresh_auth_proof` straight into `cacheSessionProof` with no guard.
  `ui-orcid-callback-session-window-proof-type-check` already prescribes the
  two-part predicate there, so its fix is unaffected; only this task's
  description of that site ("type-only") was loose.
- Your observation on the type half being pinned by one row per suite:
  pre-existing, not weakened here.

**UI re-review signal (2026-09-21, commit `4cfa2c8f`):**

Item 1 landed in both files. The first-leg comments now end on the measured
costs and state the message the true way round: `{ freshAuthFailed: true }` and
the string rendered from it are unchanged, and what the truthiness half removes
is the second prompt, the second mint and the two refused writes (broadcasts on
the authorship surface) it used to cost to reach that message. The hold's claim
about the callers was re-verified at the call sites rather than taken on trust:
`settings.reauthFailed` at four sites in `settings.js` and one in `admin.js`,
`claims.reauthFailed` in `_broadcastConsentOp`. Both fixed keys, both unchanged
by the fix.

The offered, unheld docblock tightening is taken in both files. `''` is no
longer called "the one value the type half cannot refuse"; the docblocks now
say the type half refuses no string at all, that a malformed non-empty one
travels the same path to be refused at the backend instead, and that `''` is
the one the consumers themselves drop.

Comment-only, no assertion changes, so the round-1 mutant measurements stand.
Both suites 93/93, `npm run build` clean, pre-commit anchor gate clean on the
added lines (checked with a live control line, so the zero is not vacuous).

A learning was compounded from the round-1 prose defect, before this hold
arrived and independently of it: `agents/docs/solutions/conventions/modeling-a-sibling-test-case-copies-its-framing-not-its-facts-2026-09-21.md`
(commit `f844ea2d`), plus a `Twin Surface` entry in `CONCEPTS.md`. Item 1 is a
second instance of the same class on the same change, which the entry does not
cite and which is worth knowing at re-review.
