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

---

## UI implementation signal (2026-09-16, commits 33e10833 and 3b75bab9)

Both SHAs verified on `main` with `git merge-base --is-ancestor`. No worktree
fan-out: the whole change is one file cluster and a fan-out would have collided
on it.

### The open question, as settled

Option 1 only, on the user's triage. The mint callback in `acquireSessionProof`
now returns `typeof proof === 'string' && proof ? proof : undefined`. Nothing
else changed predicate.

Option 2 (widening `ensureSessionWindow`'s fail-closed guard) was declined, and
the implementation produced positive evidence for that rather than just an
argument. Reverting the mint narrowing and widening the guard in its place
passes the two gate-routed cases and still leaves the broadcast red:
`broadcastWithFreshAuth` never consults the gate, it reads the raw acquisition
result through `acquisitionAborted`, whose own `typeof proof === 'string'` test
an empty string satisfies. So the guard placement would have closed two of the
three symptoms this task names and left the third. The mint placement closes
all three at their common upstream point, and the guard's class stays the
non-string one its docblock, `evictUnnamedAcquisition`'s docblock and the spec
header all describe, so no prose re-audit was triggered.

Option 3 (`_handleSessionAuth` in `pages/orcid-callback.js`) was declined as
already owned. This task's note that the sibling
`ui-orcid-callback-session-window-proof-type-check` is "scoped to a TYPE check"
reads that task's title, not its scope: its scope item 1 already prescribes the
two-part predicate `typeof data.fresh_auth_proof !== 'string' || !data.fresh_auth_proof`
verbatim. Landing it here would have emptied that task. It is also not needed
for AC1: a `''` written to the slot by that leg is dropped by
`readSessionWindow`'s `!token` test before any reader sees it, so it costs a
wasted re-auth (that task's documented harm) and never produces a ready window.

### Acceptance criteria

1. Met. `ensureSessionWindow` returns `{ ready: false, failed: true }` for a
   mint carrying `""`. Observed RED first, at both surfaces and for the right
   reasons: `{ ready: true, proof: '' }` at the gate, and a raw
   `FRESH_AUTH_REQUIRED` `ApiRequestError` escaping `uploadFile` where an
   `UPLOAD_REAUTH_FAILED` was expected.
2. Met, and measured rather than asserted. Reverting only the `&& proof` half in
   an isolated copy reddens exactly three cases and nothing else: the new
   session-window case, the new broadcast case, and the new upload case.
3. Met by coverage, not by the note alternative. New file
   `frontend/tests/unit/lib-ipfs-upload-real-window.test.js` drives `uploadFile`
   through the real `lib/fresh-auth.js`, mocking only `api.js` exports and the
   Alpine stores. Two control cases (a live window reaching the pre-flight as
   its minted proof, and self-custody still taking the unproofed call) keep the
   red from being scaffolding failure.
4. Met by audit, with no edit required. The guard predicate did not change, so
   every passage naming the non-string class stays true, including
   `evictUnnamedAcquisition`'s empty-string sentence, whose subject is which
   value a hypothetical swallow would pick and not what the wire can now
   produce. Two docblock sentences that the change did falsify were rewritten in
   the same commit: the mint callback's own, and `acquireSessionProof`'s
   "without a proof string".
5. Met. 86 files / 1907 tests green, build clean.

### Adversarial pass

Five independent lenses (reachability, mutation, prose, regression, acceptance)
over 33e10833, each finding refuted by two skeptics. 21 raised, 0 survived; the
convergent clusters were re-checked by hand rather than trusted to the vote.

- The load-bearing justification was verified empirically by two lenses on both
  legs: a `''` token seeded into the slot is dropped by `readSessionWindow`
  before the deadline checks, on the sessionStorage leg and on the
  `_memoryWindow` mirror leg alike, and `acquireSessionProof`'s `if (cached)` is
  a second truthiness gate behind it. `slideSessionWindow` cannot re-introduce
  one.
- Four lenses independently raised that a mint which verifies the password but
  answers `''` no longer refreshes the password-factor memo. Correctly refuted,
  re-checked by hand: the ORCID-fallback escalation one lens drew from it needs
  `assumed && mint throws 401`, and a 200-with-empty-proof never reaches that
  branch. The real delta is one extra status read per acquisition while the
  backend is violating its contract, which is exactly how a numeric malformed
  proof already behaved. Recorded here because four lenses tripping on it is
  evidence it is worth knowing, not evidence it is wrong.
- The one finding worth acting on came from the mutation lens and is what
  3b75bab9 closes.
- Three lenses flagged two slips of mine, both fixed in 3b75bab9: the new test's
  explanation still described the mint callback as asking what the value IS,
  the one clause the change falsified, and a rewrapped docblock line ran to 91
  columns in a block wrapping at 78.
- No new flakiness: three full-suite runs and ten focused runs of the touched
  specs surfaced only the known pre-existing absolute-cap clock flake.

### Residual for triage, NOT filed as a task

The reachability lens found the same type-only narrowing on two sibling
surfaces, and it is confirmed at HEAD: `mintViaPassword` in
`frontend/src/lib/settings-fresh-auth.js` and in
`frontend/src/lib/authorship-consent.js` both read
`typeof proof === 'string' ? proof : FRESH_AUTH_MINT_FAILED`, so a consent-op
mint answering `''` is delivered to `run()` as a usable proof. Different slot
from this task's, and the consent-op CACHE is clean on both sides
(`_handleFreshAuth` guards the write, `getCachedConsentOpProof` drops on
`!entry.token || typeof entry.token !== 'string'`), so the hole is in the mint
callbacks only. Surfaced for the user to triage per root `CLAUDE.md` "Code
Review Findings"; no task file created.

### Sequencing note

`ui-window-outcome-tally-source-sentence` also edits `fresh-auth.js`, but
`WINDOW_OUTCOME_BY_SENTINEL`'s and `evictUnnamedAcquisition`'s docblocks only,
which this change did not touch. No conflict expected.
