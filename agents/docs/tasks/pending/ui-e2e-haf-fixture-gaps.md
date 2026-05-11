# UI-E2E-HAF-FIXTURE-GAPS — Make 4 read-side E2E specs robust against sparse HAF / test-mode data

**Owner:** ui
**Created:** 2026-05-11 (ui, follow-up from batch-1 JFR-fix Playwright run)
**Priority:** P3

## Context

A full `npx playwright test` run after landing `ui(mount)` and `ui(search)` from batch-1 JFR triage surfaced 4 hard failures + 2 flaky-passes against the test-mode stack (`pevo_app_test` + `INSTITUTIONAL_EMAIL_DOMAINS=".test"`). Every hard failure traces to **fixture-finding assertions that fire when HAF / the test-mode app database doesn't currently expose the data shape the spec assumes**, not to product code. The 2 flaky-passes are `page.goto` timeout retries in `edit-paper.spec.js` (already partially hardened in `3532fa2`).

The full failure inventory:

| Spec | Line | Fixture assertion | Live state (dev `/api/papers`, `/api/accreditations`) |
|---|---|---|---|
| `paper-detail.spec.js` | 56 | "expected at least one pevotest paper with reviews **and** votes in HAF" | 1 paper total; 0 with `review_count > 0`; 1 with `net_votes != 0`. Conjunction never satisfied. |
| `papers-browse.spec.js` | 19 | discipline-filter narrows list to `> 0` papers | 1 paper, 0 disciplines tagged. Filter narrows to 0. |
| `researchers.spec.js` | 37 | `researchers.length > 0` | Dev returns 6 accreditations; test-mode (`pevo_app_test`) returned 0 in the failing run. Likely a denormalized table in `pevo_app` that test-mode doesn't seed. |
| `vote-comment.spec.js` | 141 | "expected a pevotest paper with reviews not authored by `pboulet`" | No PEvO-tagged paper in HAF currently has a review authored by anyone other than the test fixture user `pboulet`. |

All 4 specs share a design pattern: "pick whatever HAF currently indexes, fail loudly if nothing matches" — see the suite-header docstrings (`paper-detail.spec.js` lines 1-20, `researchers.spec.js` lines 1-16). The pattern is intentional, but the guards fire when testnet content is sparse.

The accreditations gap is more suspicious than the others. `/api/accreditations` is HAF-sourced, but the endpoint cross-references a denormalized table in the app database for display-name / reputation fields. Test-mode runs against `pevo_app_test`, which may not have that table populated. Investigate whether test-mode just needs a one-time seed of the accreditations cache, or whether the endpoint has a different code path that bypasses the cache.

## Acceptance

Pick ONE of the following remediation paths per spec (mixing is fine; different specs may want different approaches):

1. **Seed HAF/testnet fixtures.** Broadcast PEvO-tagged content on the Hive testnet that HAF then indexes — a paper with reviews from a non-`pboulet` reviewer, a paper with both `review_count > 0` and `net_votes != 0`, a paper with discipline tags, and at least one accredited researcher with a published paper. This is the highest-fidelity path but requires controlling testnet broadcasts and waiting for HAF indexing lag. Document the seed script under `frontend/tests/e2e/fixtures/` so it's repeatable.

2. **Skip-with-clear-reason on empty fixtures.** Replace each `expect(target).toBeTruthy()` guard with `test.skip(target == null, '<specific reason>')` so a CI run reports "skipped because HAF doesn't currently expose X" instead of "failed." This keeps the specs honest (they don't pretend to verify what they can't reach) but reduces coverage when testnet is sparse.

3. **Seed the test-mode app database directly for the accreditations gap.** Investigate `/api/accreditations` test-mode behavior. If a denormalized cache table in `pevo_app_test` is the gating factor, seed it via a migration or test-setup hook. This is narrower than path 1 and doesn't need HAF coordination.

Whichever path is picked, the spec must NOT silently pass when its fixture is missing — either a clear skip with reason or an explicit failure surface is required.

## Tests

For path 1 (seed): re-run `npx playwright test` after seed; assert all 4 specs pass.

For path 2 (skip): re-run `npx playwright test`; assert all 4 specs report `skipped` (not `failed`) with a human-readable reason that names the missing fixture shape. Then manually seed one fixture per spec on testnet and confirm the skip flips to a pass.

For path 3 (accreditations only): seed `pevo_app_test`, re-run `researchers.spec.js`, assert it passes.

## Out of scope

- The 2 flaky tests in `edit-paper.spec.js:276` and `:374`. They pass on retry and are tracked by Alpine `:value`/editor-mount-race hardening that `3532fa2` started; treat any further hardening as a separate task.
- Adding a global "skip when HAF empty" wrapper. Each spec's data dependency is different; a one-size-fits-all wrapper would mask which fixture is missing.
- Backend changes to `/api/papers`, `/api/accreditations`, `/api/profile/<u>/papers`. The data sparsity is upstream (HAF / test-mode app db), not in the endpoints.
- Frontend code changes in `papers.js`, `paper-detail.js`, `researchers.js`. These pages render correctly when data exists; the failures are spec-side, not page-side.

## References

- Failing Playwright run from batch-1 JFR-fix sweep (2026-05-11). 42 passed, 4 hard failed, 2 flaky-passed, 4 skipped. Output captured at runtime; not committed.
- Failing spec lines: `paper-detail.spec.js:56`, `papers-browse.spec.js:19`, `researchers.spec.js:37`, `vote-comment.spec.js:141`.
- Recent stability work on the same suite: `5028ee5 ui: stabilize E2E suite + document test-mode deploy workflow`, `0c01d4e harden E2E fixture correctness: localhost/DB guards, env rename, spec bugs`, `3532fa2 ui(tests): harden edit-paper e2e against Alpine :value + editor-mount races`. The 4 failures in this task survived all three.
- Test-mode deploy workflow: `agents/ui/CLAUDE.md` "E2E (Playwright)" section.

## Priority rationale

P3 because the failures are pre-existing fixture sparsity, not regressions from any specific PR. They don't block targeted feature work (each task can run its own scoped unit tests) but they DO undermine confidence in any full-suite E2E sweep run as a release gate. Bump to P2 if a release gate is imminent or if a PR needs full-suite green to merge.
