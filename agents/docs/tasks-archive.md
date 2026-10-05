## Pin the subject across the page-level ORCID start round-trips (archived 2026-10-05) — archived clean at dbb9e8ab on the first pass

### Architect archive note (2026-10-05)

Reviewed 977409f3 + dbb9e8ab (range db7d91d1..dbb9e8ab) with /ce-code-review (correctness,
project-standards on root CLAUDE.md, testing, adversarial in-process, julik-frontend-races,
learnings): zero findings, all seven requirements (Scope 1-3, AC 1-4) met. Full frontend unit
suite at dbb9e8ab in an isolated copy: 87 files / 1975 tests, exit 0. Red at base reproduced by
three lenses (12 of 18 fail at db7d91d1). The testing lens re-probed the two mutants the signal
left unprobed after dbb9e8ab (username-compare predicate, a stale catch that reports): both killed.

Triage (user, as recommended): the recover.js ORCID start has the same unpinned shape and is
reachable with a live session; filed as ui-recover-orcid-start-subject-pin. The spec header's
clause (c) disclosure is accepted, no start-leg e2e follow-up. Dismissed: a cross-tab login as
another user while the tab is at orcid.org still scrubs the mode marker before the callback reads
it (fails closed, user-initiated, outside this task). No /ce-compound.

**Owner:** ui
**Created:** 2026-09-02

Routed out of the architect re-review of `ui-cross-user-session-teardown`
(`659131b8`). Not held there: these two flows are outside that task's scope
and have neither an acquisition flight nor a consent-op guard, so the
generation predicate that closed the session path is not available to them.

## Why

`settings.js#handleOrcidLink` (mode `link`) and
`accreditation.js#handleOrcidVerify` (mode `accredit`) both require an
authenticated subject. Each writes `pevo_orcid_mode` inline, awaits
`startOrcid`, then assigns `window.location.href` with no re-check. A subject
teardown landing inside that await (a cross-tab login storage event, or a
same-tab disconnect from the header) sends the new subject's tab to ORCID on
the previous subject's behalf: the OAuth state was minted under the previous
subject's JWT. On return the scrub has removed the mode key, so
`/orcid/callback` reads mode '' and completes unauthenticated; the backend
refuses before consuming state, and the user lands on the generic
"verification failed" dead-end after a full OAuth round-trip. Fail-closed,
nothing minted, but the same shape the cross-user task's redirect-boundary
hold closed for the session path.

The login, signup, and recover starters run without an authenticated subject
and are out of scope. The consent-op starters are covered by
`ui-consent-op-teardown-guard`.

## Scope

1. Before the navigation in each of the two flows, re-check that the tab still
   represents the subject the start request was made for. Two acceptable
   shapes; pick the smaller and say which: (a) capture the auth store's
   `username` (or the tab-subject marker) before `startOrcid` and compare
   after it resolves; (b) route both flows through the shared
   `beginOrcidFreshAuthRedirect` with a predicate built the same way.
2. On a mismatch, reset the flow's busy flag (`orcidLinking` /
   `orcidLoading`) and return without navigating, as a silent clean cancel
   matching the session path. Do NOT remove the mode or return-path keys in
   that branch: the scrub that changed the subject already removed this
   flow's keys, so a removal there can only hit a later flow's keys (the
   defect the cross-user task's round-2 hold corrects).
3. Tests, red at base, one per flow: `startOrcid` pending, subject change
   driven through the real store path (`loginFromResponse` for a different
   username, or the storage event), resolve the start, assert no navigation,
   the busy flag reset, and a successor flow's keys intact.

## Acceptance criteria

1. Neither flow navigates after a subject change during its start await.
2. The busy flag resets on that path.
3. The stale path removes no storage keys.
4. Both tests drive the real subject-change path, not a hand-rolled helper,
   and were observed red at base.

UI implementation signal (2026-09-30, commits `977409f3` + `dbb9e8ab`, both verified ancestors of `main`):

- **Shape chosen: (a), inline, with the teardown generation as the predicate
  rather than a username compare.** Both handlers open
  `subjectTeardownGuard()` before `await startOrcid(...)` and read
  `guard.tornDown()` after it. The task's "Why" says the generation predicate
  is not available to these flows; it is, the guard is an exported value any
  caller can open. It is also the stricter pin: the generation is bumped by
  the same scrub that removes the mode marker, so it fires exactly when this
  flow's key is gone. A username compare misses a sign-out followed by a login
  as the same user (username matches again, marker scrubbed, navigation
  dead-ends at the callback). Only `tornDown` is read, never `cancel`, so the
  unwind is silent as scope item 2 asks.
- **Stale resolve:** busy flag reset, return, no navigation, nothing removed.
- **Stale reject (beyond the literal scope, same rationale):** the catch also
  returns early when the guard reads torn down. Busy flag reset, no inline
  error or toast, no `console.warn`, no key removal. A live rejection is
  unchanged.
- **`fresh-auth.js`:** one docblock sentence on `beginOrcidFreshAuthRedirect`,
  which said the page-level flows carry no predicate.
- **Tests:** new `frontend/tests/unit/pages-orcid-start-subject-pin.test.js`,
  18 cases (9 per flow), driving the REAL auth store (`initAuth`) over the REAL
  `lib/fresh-auth.js`: `loginFromResponse` as another user, the storage-event
  handler for a cross-tab login and a cross-tab sign-out, `disconnect()`, and
  sign-out then same-user login. Plus stale reject, live reject, unchanged
  subject, and same-subject re-login (the last two must still navigate).
  Observed red at base: 10 of the first version's 16 cases (8 navigation, 2
  stale-reject key removal); the 2 stale-reject cases again red on the silence
  assertions before `dbb9e8ab`.
- **Verification:** full frontend unit suite 87 files / 1975 tests, exit 0, no
  Errors line. Mutation probes in scratchpad copies at `977409f3` (delete
  either early return, un-gate either catch removal, remove a key in the stale
  branch, open the guard after the await, drop the busy reset) were all
  killed. Two mutants survived there and are what `dbb9e8ab` closes: a
  username-compare predicate, and a stale branch that sets an inline error.
  Those two were not re-probed after the fix; the cases that kill them are in
  the suite. No browser check and no `npm run build`: the change has no
  rendered surface and the pages load under vitest.
- **No e2e companion** for the start leg of either flow (the spec header's
  clause (c) says so). `orcid-link.spec.js` covers the link callback leg only.
- **Out of scope, for the architect to route:** the task says the recover
  starter runs without an authenticated subject. `recover.js` has no
  `isConnected` gate and `/recover` has no guest-only route guard, so its
  ORCID start is reachable with a live session and has the same unpinned
  shape: a teardown inside its await scrubs `pevo_orcid_return_to` and
  `pevo_orcid_mode`, it navigates anyway, and the return lands on signup
  instead of `/recover`; its catch removes both keys unconditionally. Login
  and signup render their starters only under `!isConnected`, so the claim
  holds for those. Not touched here.

## The loose-claim guard accuses the prose its own docblock cites as protected (archived 2026-10-05) — one hold; archived at 3b98e303 with two findings dismissed

### Architect archive note (2026-10-05)

Re-reviewed 3b98e303 against its parent with /ce-code-review (focused: orchestrator correctness,
standards and requirements read plus one independent in-process adversarial read). All three
items of the 2026-10-01 hold are fixed as prescribed. Canary 11/11, exit 0, on an isolated copy.
Narrowings (a) and (b), rebuilt from the header's own wording, reproduce the signal exactly:
alone red at the accusedProse pin, re-pinned red at droppedNearMiss, loop removed green. The
new `unparsed` message is true: ratchetClass returns exempt before unparsed.

Two findings, both dismissed by the user ("as recommended", 2026-10-05): (P2) a lower-case-only
variant of narrowings (b) and (c) keeps every pin green while dropping `with an argon2
companion:`. That is a narrowing no code makes, so it is preemptive hardening. (P3) header
bullet (c), built as worded with a lower-case `the`, also drops three existing sentence-break
pins, so "each narrowing on its own turns the canary red" credits the new pins with a red that
other pins produce. That is prose about a declined alternative, with no reader consequence.
The sibling tasks on the same file (reverse declaration, mixed-script) were held the same day.

**Owner:** backend
**Created:** 2026-10-01

## Why

The `LOOSE_CLAIM_SRC` docblock in
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
reads: "The room after the noun stays tight: prose about a real code path and
some unrelated companion thing ("running on the real path with a mocked
companion here:") is common, and every extra character of slack there accuses
more of it." A reader takes that example as prose the tight room protects.

It is not protected. Measured on 2026-10-01 against an isolated copy of HEAD,
on the normalised text:

| Input | `labelCount` | `unparsedClaims` | `ratchetClass(blockShape(...))` |
|---|---|---|---|
| `running on the real path with a mocked companion here: the pool is stubbed` | 0 | `["real path with a mocked companion here:"]` | `unparsed` |
| `This drives the real path with a mocked companion: getAppPool is stubbed.` | 0 | `["real path with a mocked companion:"]` | `unparsed` |

The window after the noun is `{0,8}`, and ` here` is five characters, so the
colon is in reach. A block carrying either sentence is an `unparsed` violation.
The ALLOW_MARKER exempts it, so an author has a way through, but the docblock
gives no hint that the marker is needed. No corpus file contains this shape
today. The previous implementation round recorded it as found and not fixed,
and confirmed it predates that round.

The finding here is the sentence, not only the behaviour. A docblock that
implies a guarantee the code does not provide is the defect class this canary
has been held for in nearly every round.

## Scope

1. Correct the `LOOSE_CLAIM_SRC` docblock to measured behaviour. Either its
   example becomes one the guard actually refuses, or the docblock says
   plainly that this prose shape is accused and names the marker as the
   author's remedy.
2. Decide whether to narrow the guard so that prose shaped like the example is
   not accused. The constraint is recall: every existing near-miss probe must
   keep its current `unparsedClaims` count. Note that the obvious filter,
   refusing a span whose filler's first word is a stop word, would drop the
   pinned near-miss `(c) REAL-PATH (also routes/foo.test.ts) COMPANION: covered`
   (one of the casing-recall probes, pinned at 1), whose filler's first word
   is `also`. If no narrowing preserves every near-miss
   probe and the corpus census, keep the behaviour, fix the docblock, and add
   this shape to the header's list of known precision costs.

## Acceptance criteria

1. The docblock's example and wording match measured behaviour, and a probe
   pins the example at its stated count: 0 if the guard now refuses it, 1 if
   the docblock names it as accused.
2. If the guard is narrowed, every existing `unparsedClaims` near-miss probe
   returns its current count, the whole-tree census is unchanged, and the new
   arm has a probe that goes red when the arm alone is neutered.
3. The canary is green. `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
   deferred maps and `LANDING_DIGEST` are untouched.

## Notes

This task and two sibling tasks edit the same canary file:
`backend-carve-out-canary-mixed-script-confusable-set` and
`backend-carve-out-canary-reverse-declaration-in-mocking-file`. Land them one
at a time. Anchor any comment you write on stable symbols, never on line
numbers, task slugs or round numbers.

Reproduce on a probe copy built per the backend probe recipe, never in the
shared checkout. Apply `normalizeCommentText` before calling `unparsedClaims`,
`labelCount` or `blockShape`, as `auditSources` does. Console output is
silenced in this suite, so write results to a file with the already-imported
`writeFileSync`.

## Backend implementation signal (2026-10-01, commit 615d77ce)

Decision: keep the behaviour, fix the docblock (scope item 2's fallback).
Three narrowings were measured on isolated copies of `d90204fa`, each green
against every existing pin and the non-self census, and each dropped a
plausible claim-shaped near-miss unaudited (labels=0, unparsed=0):

| Narrowing | Prose spared | Near-miss dropped |
|---|---|---|
| refuse whitespace + lower-case word after the noun | P1 only (not the colon-straight-after variant) | `(also routes/foo.test.ts) companion here:` |
| refuse (preposition +) article before the noun, `real` excepted | both examples | `Real-path with a Postgres companion:` |
| refuse an article-led noun phrase (lookbehind) | both examples | `Real-path with a Postgres companion: <backticked path> [A]`, `THE COMPANION:` family |

Three independent judges (recall, precision/scope, docblock truth) all chose
keep-behaviour. Landed:

- `LOOSE_CLAIM_SRC` docblock: the room is stated as measured (colon at most
  eight characters past the noun and any plural ending, no sentence break),
  the example is named as accused, and ALLOW_MARKER is named as the remedy.
- Header "Gaps left open on purpose": new precision-cost entry naming the
  three measured narrowings and what each drops.
- `accusedProse` probe beside `nearMissGap`: both task sentences, after
  `normalizeCommentText`, pin at unparsed 1, labels 0, class `unparsed`, and
  `exempt` with the marker (AC 1, "names it as accused" branch).

AC 2 not applicable (no narrowing). AC 3: canary green (11/11, exit 0),
`typecheck:tests` clean; `LANDING_*`, deferred maps and `LANDING_DIGEST`
untouched.

Side finding, not acted on (for triage): the `unparsed` failure message asks
for the structured form and never mentions ALLOW_MARKER, so prose accused this
way is pointed at a fix it cannot take.

## Architect re-review (2026-10-01) — HELD PENDING FIXES:

Reviewed `615d77ce` via `/ce-code-review` (focused: orchestrator correctness
and standards read plus one independent adversarial read). Verified on an
