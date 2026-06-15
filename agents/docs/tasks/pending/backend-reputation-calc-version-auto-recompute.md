# Auto-recompute reputation when the calc changes (calc-version stamp beside cycle:last)

**Owner:** backend
**Created:** 2026-06-15

## What

Make the reputation batch automatically recompute all finalized cycles when the
scoring logic changes on deploy, instead of leaving already-stored scores frozen
until an operator manually resets the cycle cursor.

## Why

`runBatchComputation` (`backend/src/reputation-batch.ts`) is a forward-only
catch-up loop: it only computes cycles newer than `${appTag}:reputation:cycle:last`
and never revisits a finalized cycle. So deploying a corrected reputation calc
does NOT retroactively re-score the already-stored cycles — they stay frozen
until the next cycle elapses (~1 day) or an operator runs `DEL cycle:last` +
restart. This bit us in production: beta showed stale scores for hours after a
fix landed. Full write-up: `agents/docs/solutions/conventions/reputation-scores-frozen-after-calc-deploy-reset-cycle-last-2026-06-15.md`.

Relying on an operator remembering a manual reset after every scoring-logic
deploy is the failure mode this task closes structurally.

## Desired behavior

1. Define a **calc-version** that changes whenever the reputation scoring behavior
   changes.
2. Persist it in Redis alongside the cursor (e.g. `${appTag}:reputation:calc:version`).
3. At the start of `runBatchComputation` (inside the existing batch lock), compare
   the running code's calc-version to the stored one. If they differ, force a full
   recompute by treating `lastComputedCycle` as `-1` (replay from cycle 0), and
   persist the new version once the recompute is durably applied.
4. When the version is unchanged, behave exactly as today (compute only new cycles).

## Design decisions to make (flag, don't guess)

- **Version source — explicit constant vs content hash.** An explicit `CALC_VERSION`
  constant a developer bumps in the same PR that changes scoring is simplest and
  most predictable, but relies on remembering to bump it. A hash over the calc's
  defining inputs (the composed query / CTE-builder outputs) auto-detects changes
  but is brittle (comment/whitespace churn triggers spurious full recomputes; the
  SQL is built dynamically). Recommend the explicit constant with a loud
  "bump this when scoring behavior changes" comment; consider a hash only if it can
  be made stable. Pick one and document the contract.
- **Weights coverage.** Reputation weights are read fresh per cycle
  (`getReputationWeights`) and applied to whatever cycles are computed — but
  finalized cycles are not recomputed, so an on-chain `update_weights` change has
  the SAME frozen-cycle problem as a code change. Decide whether the calc-version
  should also cover the active weight set (so a weights update auto-triggers a
  backfill) or whether weights changes stay a manual-reset case. If included, hash
  the sanitized weights into the version; if not, say so explicitly and note the
  manual-reset expectation for weight changes.
- **Crash safety / when to persist the version.** Persist the new version only once
  the catch-up has durably reached the current fully-elapsed cycle, so a crash or
  time-capped partial run does NOT mark the new version "done" and re-freeze. A
  partial run must keep retrying on the new version until complete. Make the
  read/compare/write idempotent and inside the batch lock (multi-instance safety).
- **No per-run recompute regression.** The version must be persisted so an unchanged
  calc never re-triggers a full recompute — otherwise every hourly run replays all
  cycles. Verify this explicitly.

## Interaction with the existing cursor invariant

The version-triggered reset moves `lastComputedCycle` BACKWARD (to `-1`), which is a
legitimate, deliberate reset — distinct from the forbidden "advance `cycle:last` on
failure" path guarded by
`agents/docs/solutions/conventions/reputation-cycle-last-must-not-advance-on-failure-2026-06-06.md`.
Do not let the new reset path weaken that guarantee: a failed/in-progress cycle must
still never advance the cursor.

## Acceptance criteria

- Changing the calc-version (and nothing else) causes the next batch run to recompute
  from cycle 0 and produce updated scores, with no manual `DEL cycle:last`.
- An unchanged calc-version does NOT trigger a recompute (no every-run full replay).
- A crash / time-cap mid-recompute after a version change leaves the system retrying,
  not frozen (scores converge once a full catch-up completes).
- The must-not-advance-on-failure invariant still holds (no regression).
- Tests: version-change-triggers-full-recompute, version-unchanged-skips,
  partial/crash-then-retry converges. Follow the project's real-infra test posture or
  the documented mock carve-out for the Redis/cursor seams.

## Context

Surfaced while diagnosing why beta reputation stayed at the pre-fix value after a
correct calc was deployed (the frozen-cycle gotcha). Low urgency — the manual
`DEL cycle:last` + restart fix is known and fast — but this removes the operator
footgun for good.

## Implementation note (backend)

- `CALC_VERSION` constant + `computeCalcVersion(weights)` in `reputation.ts`
  (explicit version joined with a key-sorted sha256 of the sanitized weights, so
  an on-chain `update_weights` auto-triggers a backfill without a code bump).
- `runBatchComputation` reads `${appTag}:reputation:calc:version` inside the
  batch lock; on mismatch it forces an IN-MEMORY `lastComputedCycle = -1`
  (replay from 0) and persists the new version ONLY after the loop durably
  reaches the latest fully-elapsed cycle (`reachedFullyElapsed`). The reset never
  writes `cycle:last`, so the must-not-advance-on-failure invariant is intact (a
  failed/partial run leaves both `cycle:last` and the version stamp untouched and
  retries on the next run). A time-capped partial run re-replays from 0 next run
  (idempotent; the 30-min budget fits the full cycle range many times over at
  this scale) — inline comment documents the eager-atomic upgrade path if cycle
  counts ever outgrow one run.
- The run's single weights snapshot is threaded into `computeReputationBatch`
  (new optional arg) so the persisted fingerprint always matches the weights
  actually applied to scoring, even if the WEIGHTS_TTL periodic refresh swaps the
  cache mid-run (review finding; also removes redundant per-cycle weights fetches).
- No API-contract surface: `runBatchComputation` is a scheduler internal.

Test-isolation learning (candidate for `/ce-compound`): `calc:version` is a NEW
cross-file-shared singleton Redis key. Sibling batch tests that need a resume
(`startCycle > 0`) or must avoid leaking a stub fingerprint now spy ONLY the
`calc:version` READ (returning the matching fingerprint) instead of writing the
shared key — this makes them immune to concurrent-file clobbering and writes
nothing to leak. All affected files pass in isolation; the remaining combined-run
flakiness is the pre-existing batch-lock contention (e.g. `stats-profile-parity`
acquires the lock to guard against concurrent runs), not introduced here.

## Architect review (2026-06-15) — HELD PENDING FIXES:

`/ce-code-review` (8 personas; correctness/adversarial at Opus) found the shipped
code correct and well-tested: all batch-loop invariants verified (the in-memory
`effectiveLastCycle=-1` reset never advances `cycle:last`; the `cycle:last` rewind
during replay is safe under the held lock; persist-only-on-`reachedFullyElapsed`
gates convergence). Conforms to all three cited convention docs, and the new tests
cover every acceptance criterion with exact-value assertions. Three cheap,
risk-tied items hold archive:

1. **CALC_VERSION bump reminder at the scoring SQL (`computeReputationBatch` in
   `backend/src/reputation.ts`).** The "BUMP THIS" obligation lives only on the
   `CALC_VERSION` constant's docblock, far from the scoring SQL it governs. A
   developer editing the scoring SQL without bumping the constant deploys silently
   stale scores into the forward-only loop — the exact footgun this task exists to
   close. Add a one-line reminder comment immediately above the SQL string inside
   `computeReputationBatch` pointing back to `CALC_VERSION` / `computeCalcVersion`,
   so the bump obligation is visible at the point of edit.

2. **Locale-independent key comparator in `computeCalcVersion`
   (`backend/src/reputation.ts`).** The weight-key sort uses `localeCompare` with no
   pinned locale, so the fingerprint's stability depends on the process locale
   (harmless for today's ASCII weight keys, latent if a key ever carries a
   locale-sensitive character). Switch to a locale-independent comparator
   (`(a, b) => (a < b ? -1 : a > b ? 1 : 0)`) so an identical weight set always
   hashes identically regardless of deploy environment.

3. **Assert the `weightsArg` threading in the recompute test
   (`backend/tests/routes/reputation-calc-version-recompute.test.ts`).** The
   "changed calc-version forces a full replay" case inspects the compute spy's call
   count and `cycleEndBlock` arg but never the weights snapshot. Add an assertion
   that the threaded weights argument equals the run's `TEST_WEIGHTS`, so a
   regression dropping the snapshot thread (reverting to a per-cycle
   `getReputationWeights()` and reopening the mid-run WEIGHTS_TTL-swap race) is
   caught.

Dismissed (recorded, no action):
- Replay-from-0 is non-resumable, so a calc bump would freeze convergence IF the
  finalized-cycle count ever exceeds one run's time budget. Real correctness-class
  risk but far from current scale (single-instance, ~100 cycles, seconds each), and
  the eager atomic version+cursor reset fix is already named inline in
  `runBatchComputation`. Relying on the inline escape-hatch note; no follow-up task
  filed (revisit only if cycle count approaches the per-run budget).
- No test for the time-cap-leaves-version-unstamped path (preemptive; correct by
  inspection). The four `as never` casts in the mock files (test idiom for the
  overloaded `redis.get` / partial compute stub). The duplicated calc:version-read
  spy block across three test files (DRY; `pinCalcVersionRead` could move to
  fixtures). The optional 4th-positional `weightsArg` shape (existing codebase
  pattern). All dismissed as polish.

When the three items land, `git mv` this file back to `tasks/review/` for
re-review and archive. (The `/ce-compound` test-isolation candidate noted above
stays open for the archive checkpoint.)
