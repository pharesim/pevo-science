# Centralize the fresh-auth outcome dispatch and the orchestrators' retry gate

**Owner:** ui
**Created:** 2026-08-31

Routed out of the architect reviews of the reauth-window round-4 and
hasPassword-divergence round-3 holds. Not held on either task: neither finding
is a defect today (every current outcome is handled at every site); both are
structural traps whose next widening pays the cost.

## Why

Two duplication shapes grew across the last rounds, and each has already
produced the failure it predicts:

1. **The window-outcome dispatch is triplicated.** `ensureSessionWindow`'s
   outcome vocabulary (`ready` / `failed` / `busy` / `reauthRequired`) is
   consumed by three independently maintained if-chains — `freshAuthWindowReady`
   and `acquisitionAborted` in `lib/fresh-auth.js`, and `windowProof` in
   `lib/ipfs-upload.js` — beside three near-identical toast helpers. The
   reauth-window rounds had to hand-edit all three chains, and the round-2 hold
   there was literally "an outcome added to the vocabulary was missed at two of
   three consumers." The convention entry
   `outcome-vocabulary-widening-requires-a-consumer-audit-2026-08-31` documents
   the class and recommends exactly this consolidation.

2. **The orchestrators' retry gate is a byte-identical clone.** The remintable
   401 retry-gate ladders in `lib/authorship-consent.js` and
   `lib/settings-fresh-auth.js` are identical modulo bindings (factor
   resolution, `usesPassword` gate, mint, the
   ORCID_FALLBACK/PROMPT_BUSY/CANCELLED/MINT_FAILED ladder, run +
   cache-clear, the retry catch), and the hasPassword rounds grew the clone by
   adding the fallback arm to both in lockstep — after which the new branch was
   tested in only one of the two files. Precedent: the byte-identical
   `promptBusy()` was already extracted from this exact file pair.

## Scope

1. One outcome-to-action mapping for the window-outcome vocabulary, shared by
   the three consuming sites (a lookup table in `lib/fresh-auth.js`, or a
   vocabulary-driven exhaustiveness test that fails when a site misses an
   outcome — implementer's choice; the point is a single place the next
   outcome must be added). Collapse the three toast helpers into one
   parameterized helper while there.
2. Extract the shared retry-gate helper into `lib/fresh-auth.js`, parameterized
   by the closures that actually differ (the factor resolver hook, the bound
   mint, the ORCID begin function, the run/clear pair). Both orchestrators
   consume it; their suites keep their own behavioral coverage but the ladder
   itself has one home.
3. No behavior change anywhere. The full unit suite must pass unmodified except
   where a test names a helper that moved.

## Acceptance criteria

1. A window outcome forgotten at a consuming site is caught by structure or by
   a failing test, not by an architect review.
2. The retry-gate ladder exists once; both orchestrators import it.
3. Suite green with no behavioral test rewrites (mechanical import/name updates
   only), build clean.

## Notes

Sequence after the two held rounds land: the reauth-window round-4 hold touches
`acquisitionAborted` and the pages, and the hasPassword round-3 hold touches the
authorship retry gate and the memo write, so extracting first would force both
holds to rebase onto moved code.

---

## UI completion signal (2026-09-01, commit 32681cf9)

Implemented in an isolated worktree on top of both held rounds (as the Notes
sequenced), reviewed by three adversarial lenses (behavior-preservation,
exhaustiveness-structure, convention/simplify; zero must-fix findings), and
cherry-picked onto main. Behavior-preservation was traced branch-for-branch by
the reviewer: identical outcome shapes, toast keys and copy, ordering, throw
contracts, and the non-light/ready paths at every consuming site; the commit
touches ZERO existing test files.

**Scope 1.** Both allowed forms landed: `WINDOW_OUTCOME_BY_SENTINEL` in
`lib/fresh-auth.js` is the single registration point (keys derived, never
hand-copied); one parameterized `showWindowOutcomeToast` replaces the three
toast helpers; `ensureSessionWindow`, `freshAuthWindowReady`, `promptBusy` and
`acquisitionAborted` consume the map structurally with no per-member branches
left to forget. The upload pre-flight keeps its site contract (throws
`UploadSessionError` codes, never toasts) via its own
`UPLOAD_CODE_BY_WINDOW_OUTCOME` table, so `ipfs-upload.js` gained no new
runtime import. A vocabulary-driven exhaustiveness suite
(`tests/unit/lib-fresh-auth-outcome-dispatch.test.js`, 7 tests) pins every
member at every consumer; intentional silence (redirect, cancelled) is an
enumerated two-place decision, so a new member is loud by default.
AC 1 demonstrated both ways: an unregistered sentinel fails the registration
pin; a registered member with no consumer rows fails once per consumer surface,
naming the member and the negligent site; teaching only one site leaves the
others red (reviewer reproduced both directions in a scratchpad copy).

**Scope 2.** The remintable-401 ladder exists once as
`consentOpFreshAuthRetryGate(err, { resolveFactor, mint, beginOrcidRedirect,
run, clearProofCache })`; both orchestrators consume it. AC 2 probed: deleting
the shared fallback arm turns BOTH orchestrator suites red with exactly their
fallback pins.

**Scope 3 / AC 3.** Six per-row dispatch mutations each killed by existing
behavioral tests (listed per row in the probe log) plus the new suite; full
frontend unit suite on the integrated tree 79+1 files, 1757 tests green (3
documented pre-existing `pages-edit` errors); `npm run build` clean; canary
green with pins unchanged (the moved ladder carries no `fetchEmailStatus` /
`hasPassword` occurrence).

**Residuals surfaced for triage, deliberately not fixed here:**

1. (medium, scope-limited by design) The exhaustiveness mechanism covers the
   three window-outcome consumers the task named. Three more per-member
   if-chains over the same `FRESH_AUTH_*` sentinels sit outside it: both
   orchestrators' initial gates and the new shared retry gate's own mint
   chain. Same drift class, one consolidation step further; a follow-up could
   extend the suite's census to them.
2. (low) The sentinel-registration pin sees only EXPORTED `FRESH_AUTH_*`
   bindings in `fresh-auth.js`; a module-private sentinel would evade it, and
   the runtime fall-through for an unregistered sentinel at
   `ensureSessionWindow` is fail-open (reads as ready). Today every sentinel
   is exported because call sites compare identity; the structure change
   weakens that pressure over time.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Full /ce-code-review fan-out on commit 32681cf9 (9 reviewers). The
no-behavior-change claim VERIFIED independently by five lenses (correctness,
security, reliability, frontend-races, adversarial intent check): sentinel
dispatch exact, extracted ladder identical to both pre-refactor copies, toast
copy and upload codes verbatim. Six lenses clean. Three findings survived
synthesis + independent validation; user triaged all three onto this hold.

1. **(P1, validated) Delegate the upload pre-flight's outcome-key scan to the
   canonical helper.** `windowProof()` in `ipfs-upload.js` reimplements the
   `Object.keys(...).find((key) => outcome[key])` scan that `windowOutcomeKey`
   (`fresh-auth.js`) exports as the one registration-point scan, and the two
   copies already diverge (the canonical one optional-chains `outcome?.[key]`).
   The file already imports from `fresh-auth.js`, so this is a named-import
   addition, not a new dependency. Suggested shape:
   `const code = UPLOAD_CODE_BY_WINDOW_OUTCOME[windowOutcomeKey(outcome)] ?? UPLOAD_CANCELLED;`
   (a null key indexes to undefined, so the `??` keeps the existing
   unknown-outcome fall-through to a cancel).

2. **(P2, validated) Add the shared gate's retry-path consumption specs.**
   Both orchestrator suites test the initial mint only; no spec drives
   `consentOpFreshAuthRetryGate`'s retry side at its consumption site. Add,
   through the public orchestrators (either surface, or one each — the ladder
   is shared now, so one pair covers both):
   (a) first `run()` rejects remintable FRESH_AUTH_REQUIRED, retry mint
   resolves `FRESH_AUTH_CANCELLED` -> expect `{ cancelled: true }`, and
   `FRESH_AUTH_MINT_FAILED` -> expect `{ freshAuthFailed: true }`;
   (b) the retry's `run()` rejects a NON-fresh-auth error -> expect it to
   propagate to the caller's op-level handling (rethrow), not map to
   `freshAuthFailed`. The existing non-fresh-auth specs reject on the FIRST
   `run()` and only hit the gate's top-level entry check.

3. **(P2, design call resolved: fail closed) Close the unregistered-sentinel
   fall-through in `ensureSessionWindow`.** An acquisition result that is
   neither a registered sentinel nor a string must map to
   `{ ready: false, failed: true }` instead of falling through to
   `{ ready: true, proof }` — behavior-preserving today (every legitimate
   light-path proof is a non-empty string and the null-valued redirect
   sentinel is registered), and it closes the fail-open direction the new
   suite currently pins (the internally-resolved assertion asserts exactly the
   input that reads as ready). Add a suite case pinning an unregistered
   Symbol to a non-ready outcome. This resolves this task's residual 2 as
   triaged.

Residual disposition from triage: residual 1 (extending the census to the
three remaining per-member chains) is ACCEPTED as scoped — those chains
classify a different sub-vocabulary into return shapes, and forcing them into
the table pattern was judged not a net win; no follow-up filed. Soft-bucket
observations (fresh-auth.js size growth, UPLOAD_ERROR_TEXT completeness,
empty-catalog toast testing, mid-ladder teardown coverage) recorded in the
review artifacts, no action required this round.

---

## UI re-review signal (2026-09-06, commits fa436034 + 806bfcdb)

All three hold items landed. Verified by a five-lens adversarial fan-out
(behavior-preservation, hold-compliance, conventions, mutation-probing,
adversarial) with three independent skeptics per finding; every finding was
refuted except two false statements in my own comments, corrected in 806bfcdb.
Both probing lenses worked in private worktrees, never this checkout.

**Item 1 (P1, upload pre-flight delegates the scan).** `windowProof()` in
`lib/ipfs-upload.js` now calls `windowOutcomeKey(outcome)` and indexes
`UPLOAD_CODE_BY_WINDOW_OUTCOME[outcomeKey] ?? UPLOAD_CANCELLED` — the shape the
hold suggested. Behavior-identical, verified two ways: the vocabulary and the
upload table hold the same five members in the same order (already pinned
both-ways by the exhaustiveness suite), exactly one member is truthy per
outcome by construction, and a null key indexes to undefined so the
unknown-outcome fall-through stays the cancel it was. The dropped optional
chain is unreachable, since `outcome.ready` is dereferenced a line earlier.

Honest note the probe surfaced: reverting item 1 turns NOTHING red. The two
implementations are behaviorally identical by construction, so the only guard
would be a structural assertion, which is the preemptive hardening this project
dismisses. What IS pinned is that the delegation is live: stubbing
`windowOutcomeKey` to return null in the upload suite's mock reddens four
pre-existing specs.

**Item 2 (P2, retry-path consumption specs).** Three specs added to
`lib-settings-fresh-auth.test.js`, driving the shared gate through the public
orchestrator: a dismissed second prompt unwinds `{ cancelled: true }`, an
exhausted second prompt `{ freshAuthFailed: true }`, and a non-fresh-auth error
from the RETRY's `run()` propagates to the caller rather than mapping to
`freshAuthFailed`. Each of the three matching gate arms was mutated
individually against the full suite: every mutation kills exactly one spec, and
in each case it is the new one, so no pre-existing spec covered any of the
three. One surface per the hold's "one pair covers both"; both orchestrators
verifiably delegate to the same gate.

**Item 3 (P2, fail closed).** `ensureSessionWindow` now refuses an acquisition
result that is neither a registered sentinel nor a string. Behavior-preserving:
every value `acquireSessionProof` can resolve was enumerated (cache read,
`guard.cancel()`, the ORCID-or-refuse leg, the mint) and each is a string or a
registered sentinel; the self-custody `{ ready: true, proof: null }` return
precedes the check. It also brings the window reading into line with
`acquisitionAborted`, which already applied the same string test to the raw
acquisition result. Pinned by a new spec in
`lib-fresh-auth-session-window.test.js` that drives the real acquisition to an
unregistered Symbol; deleting the guard, or weakening it to an undefined check,
kills that spec and nothing else. No module-state leakage: the suite is green
across three sequential and three shuffled runs.

**One harness change beyond the three items.** `lib-ipfs-upload.test.js`
wholesale-mocks `fresh-auth.js`, so it had to supply the newly imported
`windowOutcomeKey`. Hand-mirroring the scan in the mock factory would recreate
exactly the divergence item 1 removes, so the factory now pulls the real
function through `importOriginal`. Checked for the hazards that invites: no
import cycle, no module-scope side effects in `fresh-auth.js` or its transitive
imports, `ensureSessionWindow` still stubbed at the boundary, collection time
unchanged.

**Corrections in 806bfcdb (comments only).** The fail-closed guard's rationale
named the broadcast surface, which never consumes `ensureSessionWindow`; it now
names the upload pre-flight and the parity with `acquisitionAborted`. The
retry-gate section header claimed every case above it stops at the gate's entry
check, when two of them drive the retry's successful `run()` and a second
FRESH_AUTH_REQUIRED out of it and are the sole cover for those arms; it now
says which three arms were actually unpinned. The same over-broad claim is in
fa436034's message, which stands as written — siblings have committed on top.

**Verification.** Full frontend unit suite 82 files / 1835 tests green (the
three `pages-edit` unhandled errors are the documented pre-existing ones);
`npm run build` clean. No behavioral test was rewritten; the only edit to an
existing spec file outside the new cases is the mock-factory line above.

---

## Architect re-review (2026-09-06) — HELD PENDING FIXES:

Full /ce-code-review fan-out on `fa436034` + `806bfcdb` (correctness, security,
adversarial, reliability, testing, julik-frontend-races, project-standards, learnings),
plus an independent validation gate on the merged set. No cross-model peer was available
on this host, so the adversarial lens ran in-process and did its own mutation probes in a
private scratch tree at the reviewed head.

**All three round-1 hold items are FIXED, each verified independently rather than from
the signal block's prose.** Item 1: the learnings pass grepped the reviewed head and
confirmed `windowOutcomeKey` has exactly one definition and two consumers with no
surviving local copy; correctness proved the delegation equivalent on all four axes (key
set, key order, the dropped optional chain, and the `??` fall-through versus the old
ternary). Item 2: testing and correctness each confirmed the three arms were previously
uncovered on BOTH orchestrator suites, and adversarial's per-arm mutations each killed
exactly the claimed new spec and nothing else; adversarial also checked the two
`consentOpFreshAuthRetryGate` call sites argument-for-argument and confirmed "one pair
covers both" is sound. Item 3: correctness re-enumerated every value
`acquireSessionProof` can resolve, independently of the signal block's enumeration, and
found the guard behavior-preserving on every live path. `806bfcdb` verified literally
comments-only. project-standards (comment anchors audited line by line, including the
durable "Cases above already reach two of them" form) and julik-frontend-races returned
zero findings.

Three findings survived synthesis and validation. The user triaged all three onto this
hold. They are one round of work on the same short span of `ensureSessionWindow` and its
docblock, so treat them as a batch.

1. **(P2, validated, found independently by reliability and security) The fail-closed
   guard refuses without evicting the cache entry that caused the refusal.** The new
   `typeof proof !== 'string'` branch in `ensureSessionWindow` returns
   `{ ready: false, failed: true }` and clears nothing. `acquireSessionProof` returns a
   cache hit before it ever reaches the mint, and `readSessionWindow` rejects only a
   FALSY token, never a non-string one. So a truthy non-string that reaches the window
   slot is re-read and re-refused on every later attempt, with no user action able to
   clear it until the absolute cap elapses. This is a regression in the failure mode, not
   a pre-existing gap: before the guard, that same value went to the network, drew
   `FRESH_AUTH_REQUIRED` reason `missing` (the backend applies its own string test), and
   `uploadFile`'s remintable branch answered with `clearCachedSessionProof()` and a
   retry. The guard removed that round-trip without replacing the clear it relied on. The
   validator confirmed both halves, including that the pre-change self-heal was real.
   Reachability is narrow and was weighed: it needs a JSON-survivable truthy non-string,
   so a backend contract violation or a tampered storage entry. A Symbol self-clears
   because `JSON.stringify` drops a Symbol-valued key, which is exactly why the new spec
   does not catch this. Suggested shape:
   `if (typeof proof !== 'string') { clearCachedSessionProof(); return { ready: false, failed: true }; }`
   The exported clear already lives in this module and is what the sibling 401 paths call.

2. **(P2, validated, adversarial, measured not inferred) The guard's pin covers only
   `symbol`, and the suite stays green when the guard is narrowed to match.** Adversarial
   ran the probes for real against the reviewed head: deleting the guard kills the new
   spec, weakening it to an `undefined` check kills the new spec, but narrowing it to
   `typeof proof === 'symbol'` leaves all 1835 tests passing. Under that surviving
   mutation a mint response missing `fresh_auth_proof` makes `freshAuthWindowReady()`
   return TRUE with no window, sending a light account down `uploadFile`'s self-custody
   branch. The validator independently confirmed the staged Symbol is the only non-string
   acquisition result anywhere in the frontend unit tests. So the pinned slice is the
   unreachable one and the reachable slice is unpinned. This is NOT the preemptive
   hardening this project dismisses: the mutation was executed and survived, and the
   green-while-red was measured. Drive the existing spec from a table of unregistered
   results rather than one Symbol, so the assertion covers the class the guard names.
   `undefined` alone closes the surviving mutation; adding a number makes the class
   explicit. Re-stub the mint and clear the toast spy per iteration if you loop inside the
   existing `it`.

3. **(P3, validated, found independently by adversarial and security) The guard's
   docblock names a wire mechanism a sentinel proof never takes.** The block claims an
   unregistered result read as ready "attaches a sentinel to the pre-flight request".
   Nothing attaches: every sentinel here except the registered `null` is a Symbol,
   `uploadFileToIpfs` serializes its body with `JSON.stringify`, and a Symbol-valued key
   is omitted entirely; the truthiness guard at that call site does not catch a Symbol
   either. The request would go out with the field ABSENT. The outcome half of the
   sentence survives (the user still gets a rejection they cannot act on); only the
   mechanism is wrong. Say what actually happens instead. While in that block, also fix
   the adjacent overstatement correctness raised: "acquisition resolves a proof string or
   a registered sentinel today" is not true unconditionally, because the cached-token read
   is never type-checked, which is the same hole item 1 above closes. Keep the replacement
   text free of line numbers, SHAs, task slugs and bare positional anchors.

Triage dispositions the implementer does not need to act on. One finding was DROPPED at
validation: reliability and adversarial both reported that an unregistered result refuses
loudly through `ensureSessionWindow` but silently through `acquisitionAborted` on the
broadcast path. The mechanics are real, but the validator ruled the silence pre-existing,
untouched by this diff, and documented as intended at the toast dispatch; the guard's
comment claims parity of refusal, not of messaging. Do not "fix" it as part of this hold.
The testing lens also proposed a structural pin so that reverting item 1's delegation
turns something red; adversarial refuted it (a behavior-preserving refactor cannot be
distinguished behaviorally, and key-set equality is already pinned by the exhaustiveness
suite), and the architect accepted the refutation. No action.

Soft-bucket observations recorded in the review artifacts, no action required this round:
the real `alpinejs` now loads transitively in the upload suite through the new
`importOriginal` factory and is inert only because vitest keeps the default per-file
isolation; the guard is a type test rather than a validity test, so an empty-string proof
still classifies ready; `windowProof`'s unknown-outcome fall-through is now dead code
since every non-ready outcome carries a registered key; and the vocabulary key list and
the upload code table are pinned as sets rather than ordered lists, which is unobservable
while no outcome carries two members.

---

## UI re-review signal (2026-09-07, commits 98b4a8f6 + 8ffe72a6)

All three round-2 hold items landed in `98b4a8f6`; `8ffe72a6` is comments-only
and corrects three false statements that commit's own prose introduced (below).
Verified by a six-lens adversarial fan-out (behavior-preservation,
hold-compliance, comment-accuracy, conventions, mutation-probing, adversarial)
with three independent refuting skeptics per finding: 15 raised, 8 refuted, 7
survivors, all of which were comment-accuracy defects in my new text and all of
which I re-verified against the code myself before acting. Every probing lens
worked in a private scratch copy with `node_modules` symlinked; this checkout
was never mutated by a reviewer.

**Item 1 (P2, the fail-closed guard evicts).** `ensureSessionWindow`'s
`typeof proof !== 'string'` branch now calls `clearCachedSessionProof()` before
returning `{ ready: false, failed: true }` — the exported clear the sibling 401
paths call, which drops the storage entry and the in-memory mirror together.
Behavior-preservation enumerated every value `acquireSessionProof` can resolve
and found no path where the clear evicts a live window: the cache leg IS the
offender, the mint leg has already overwritten (or dropped) the slot one
statement earlier, and every teardown boundary returns a registered sentinel
that is caught above the guard. The deliberate "a miss under `minRemainingMs`
does NOT clear a live window" behavior in `readSessionWindow` is untouched and
its spec still passes. Pinned by a new spec that seeds a numeric token, asserts
the refusal, asserts the slot is empty, and asserts the next attempt is an
ordinary acquisition.

**Item 2 (P2, the pin covers the class, not one member).** The unregistered
spec is now an `it.each` over a mint response with no `fresh_auth_proof`, a
numeric proof, and an unregistered Symbol. `it.each` gives each row the full
`beforeEach`, so the hold's per-iteration re-stub is satisfied structurally.
The architect's measured survivor is dead: narrowing the guard to
`typeof proof === 'symbol'` now reddens three specs. `null` cannot appear as an
unregistered value because `FRESH_AUTH_REDIRECT_PENDING` is registered.

**Item 3 (P3, the docblock names the real mechanism).** Rewritten, then
rewritten again after the review (see the corrections below).

**Mutation probes**, run against private copies:

| mutation | specs killed |
| --- | --- |
| drop `clearCachedSessionProof()` from the guard | the eviction spec, alone (1 of 64) |
| narrow to `typeof proof === 'symbol'` (the measured survivor) | the no-proof-field row, the numeric row, the eviction spec (3) |
| delete the guard | all four (4) |
| weaken to `proof === undefined` | the numeric row, the Symbol row, the eviction spec (3) |

**Corrections in `8ffe72a6`, and one of them is in the hold text too.** The
review found three false claims in `98b4a8f6`'s comments; each was confirmed
against the code before being corrected.

1. The docblock said the mint leg "resolves a proof string or a registered
   sentinel" and attributed every non-string arrival to the untyped cache read.
   The mint callback returns the response's `fresh_auth_proof` verbatim (only
   `beginPasswordMintReport` type-tests it, and only to veto the memo write),
   and two of the three table rows added in the same commit drive exactly that
   leg with no seeded window. Round 1's overstatement had been narrowed by one
   leg rather than fixed. Both legs are now named as unchecked.
2. Both new blocks put the lockout at "until the absolute cap elapsed".
   `anchoredSpan` clamps the idle span into [450s, 900s] and the absolute into
   [3600s, 7200s], so `readSessionWindow`'s `Math.min(idleTs, absoluteTs)`
   always selects idle, and neither `slideSessionWindow()` call site is
   reachable without a successful consume, so it never advances. The real bound
   is the idle deadline for an entry this module wrote, and no bound at all for
   a tampered one whose deadlines are attacker-written. "No user action able to
   break out" was overstated too: `SESSION_PROOF_KEY` is in
   `SUBJECT_BOUND_STORAGE_KEYS`, so signing out scrubs it, and a fresh tab
   starts empty. **This phrasing came verbatim from hold item 1's own
   rationale**, so the hold text carries the same inaccuracy; flagging rather
   than silently diverging from it.
3. The table's inner comment kept a single wire mechanism after the table grew
   to three rows. A falsy result never travels on as a proof: `uploadFile`'s
   `if (!proof)` takes the unproofed branch, the one self-custody uses, and
   `uploadFileToIpfs` refuses a light account there before a request is built.
   Same false-mechanism class as the claim corrected last round, which is why
   the replacement text was audited against the code a second time before it
   landed.

**Verification.** Full frontend unit suite 82 files / 1842 tests green at both
commits (the three `pages-edit` unhandled errors are the documented
pre-existing ones); `npm run build` clean; the file is green across repeated
sequential and shuffled runs. No behavioral test was rewritten and no existing
spec's assertions changed: `98b4a8f6` replaces one `it` with an `it.each` over
the same body and adds one spec, and `8ffe72a6` touches nothing but comments.

**Residuals surfaced for triage, deliberately not fixed here.**

1. (medium) `acquisitionAborted` reads the same untyped cache and refuses
   without evicting, so the broadcast surface still dead-ends on a poisoned
   slot until a windowed gate clears it or the idle deadline arrives. The
   dropped finding from the last round covered the *messaging* asymmetry
   between the two readers and ruled it pre-existing and intended; the
   *eviction* half is a different gap and is genuinely pre-existing, since that
   reader has always applied its string test and never cleared. Named here so
   the completeness question is on the record rather than implied by item 1's
   scope.
2. (low, design call for the architect) The type check arguably belongs in
   `readSessionWindow`, next to the falsy-token and non-finite-deadline drops
   it already performs — one edit would close both readers and match the
   module's existing corrupt-entry pattern. Not taken, because it changes the
   broadcast path from a silent abort to a re-auth, which is behavior beyond
   what the hold prescribed and adjacent to the finding the architect dropped.
3. (low) Nothing validates the mint response at the boundary:
   `cacheSessionProof` writes whatever token it is handed. The guard is a
   downstream backstop for a defect whose natural home is the write.
