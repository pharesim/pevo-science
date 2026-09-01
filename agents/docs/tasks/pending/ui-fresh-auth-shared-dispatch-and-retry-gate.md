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
