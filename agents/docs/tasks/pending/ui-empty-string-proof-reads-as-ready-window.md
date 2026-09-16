# An empty-string proof passes every fresh-auth narrowing and arrives as a ready window

**Owner:** ui
**Created:** 2026-09-16

Surfaced by the round-4 review of `ui-fresh-auth-shared-dispatch-and-retry-gate`
while measuring what each falsy value does downstream. Not a defect that round
introduced: it is the empty-string sibling of the null-proof coercion that
round 3 landed, and it has been open since the window was built. Recorded in
that task's re-review signal and filed here on the user's triage, because
closing it is a code change and that round was prose-only.

## What happens

A mint response carrying `"fresh_auth_proof": ""` reaches the consumers as a
live window. Every narrowing in the path tests the TYPE, and `''` is a string.

1. The mint callback in `acquireSessionProof` ends
   `return typeof proof === 'string' ? proof : undefined;`. `''` is a string,
   so it is handed back verbatim.
2. `evictUnnamedAcquisition`'s predicate opens `typeof proof !== 'string'`, so
   it short-circuits and never clears.
3. `ensureSessionWindow`: `acquisitionOutcomeKey('')` is null, and the
   fail-closed guard is `typeof proof !== 'string'`, so neither fires. The gate
   returns `{ ready: true, proof: '' }`.

Downstream, no consumer compares against the self-custody `null`. They all test
truthiness, so `''` is indistinguishable from "this account needs no proof":

- `freshAuthWindowReady` returns `true` and shows no toast. The page starts the
  work.
- `uploadFile` and `retryOnce` take `if (!proof) return uploadFileToIpfs(file)`,
  the unproofed call self-custody uses. `api.js` then throws
  `FRESH_AUTH_REQUIRED` for a light account with no proof. That return sits
  AHEAD of `uploadFile`'s `try`, so the error escapes as a raw
  `ApiRequestError` rather than an `UploadSessionError`, no retry runs, and
  `describeUploadError` falls to its default. The user is told the upload
  failed, never that re-authentication is what they need, even though the
  throw carries `reason: 'missing'`, which is a remintable reason.
- `signer.js` does `if (freshAuthProof) body.fresh_auth_proof = freshAuthProof;`,
  so the broadcast leaves with the field absent and is refused by the backend a
  round-trip later.
- `cacheSessionProof('')` writes the slot, and the next `readSessionWindow`
  drops the entry on its `!token` test. So the account also pays a fresh
  re-auth on every single action for as long as the backend keeps answering
  this way.

## Why it is worth closing

The project has already decided this question on the sibling surface. The
consent-op leg of the ORCID callback refuses an empty-string proof with the
two-part predicate
`typeof data.fresh_auth_proof !== 'string' || !data.fresh_auth_proof`, and
`pages-orcid-callback.test.js` pins it with an `it.each` carrying an explicit
`empty-string` row beside the `non-string` and `missing` ones. The session-kind
window path applies only the type half of that predicate, at every one of its
narrowings. One surface enforces the rule and its sibling does not.

It is reachable only through a backend contract violation, which is exactly the
reachability the null-proof case had when round 3 held on it and required the
coercion. The failure mode here is worse than the null case's: null is refused
(loudly, since the unnamed class now falls through to `failed`), whereas `''`
is not refused at all and the light account is silently routed down the
self-custody branch.

No test would catch a regression here, in either direction.
`lib-ipfs-upload.test.js` mocks `ensureSessionWindow` wholesale, so the upload
surface has no coverage of a falsy-but-ready proof arriving from the real
window.

## Open question for the architect, to settle before implementing

Where the refusal belongs. These are not equivalent and the third has
documentation consequences.

1. **The mint callback only** (`typeof proof === 'string' && proof ? proof : undefined`).
   Smallest change, matches the shape round 3 landed for null, and lands `''`
   in the same fail-closed guard as every other malformed answer. Leaves the
   cache leg able to hand back an empty-string token if one is ever written to
   the slot, though `readSessionWindow`'s `!token` test already drops those.
2. **The fail-closed guard as well** (`typeof proof !== 'string' || !proof`).
   Defense in depth, and it makes the gate's contract "no usable proof" rather
   than "not a string". But the guard's docblock, `evictUnnamedAcquisition`'s
   docblock and the spec header all describe the class the guard names as the
   non-string class, and those three passages were just rewritten. Widening
   the predicate means re-auditing that prose in the same commit.
3. **`_handleSessionAuth` in `pages/orcid-callback.js` too**, the window slot's
   other writer. Note for whoever picks up
   `ui-orcid-callback-session-window-proof-type-check`: that task is scoped to
   a TYPE check, and a type check alone does not close this hole, because `''`
   passes it. If both land, the predicate there should be the two-part form the
   consent-op leg in the same file already uses, not `typeof` alone.

Recommend 1 plus 3, and treat 2 as a separate decision so the prose audit it
triggers does not ride along silently. The two tasks should be sequenced rather
than run in parallel: they touch the same handler.

## Acceptance criteria

1. A mint response carrying `"fresh_auth_proof": ""` does not produce a ready
   window. Driven proof-first: the new case is observed RED before the fix.
2. Whichever narrowings change, the empty-string case is covered by a test that
   fails if the `&& proof` half is reverted, so the two-part predicate is
   pinned and not just the type half.
3. The upload surface gets coverage of a falsy-but-ready proof that does not
   mock `ensureSessionWindow` away, OR a note in the task recording why the
   real path is impractical there, per the carve-out in root `CLAUDE.md`.
4. Any docblock or spec prose describing the guarded class as "the non-string
   class" is re-audited against whatever predicate lands, in the same commit.
5. Suite green, build clean.
