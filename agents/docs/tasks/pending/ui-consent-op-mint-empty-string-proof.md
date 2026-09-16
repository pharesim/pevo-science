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
