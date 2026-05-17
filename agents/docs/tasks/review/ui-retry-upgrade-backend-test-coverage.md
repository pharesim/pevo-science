# UI-RETRY-UPGRADE-BACKEND-TEST-COVERAGE — add unit tests for retryUpgradeBackend's catch branches

**Owner:** UI Agent
**Created:** 2026-05-16 (architect, follow-up from /ce-code-review round-6 of ui-seed-phrase-keychain-compat)
**Priority:** P3

## Problem

`frontend/src/pages/settings.js`'s `retryUpgradeBackend()` is the 503-retry path for the custody-upgrade flow's `_completeUpgradeAfterBackend` step. The function and its `handleRetry()` dispatcher have zero unit-test coverage across:

- All catch branches inside `retryUpgradeBackend()` (transient vs permanent errors, different status codes, network failures, the discriminator-based decisions about whether to allow further retry)
- The happy-path retry success
- The dispatcher's gating logic in `handleRetry()` — when retry IS attempted vs explicitly suppressed by a terminal discriminator

This was discovered by the testing reviewer during `/ce-code-review` round-6 of `ui-seed-phrase-keychain-compat`. The round-5 fix's new `canRetryUpgrade` specs establish that the 503 sub-case is retryable but do not exercise what the retry actually does. The gap pre-dates round-5; round-5's specs made it more visible because they assert "retry is possible" without testing the retry path itself.

## Acceptance criteria

1. Identify every reachable branch in `retryUpgradeBackend()` and `handleRetry()` (`frontend/src/pages/settings.js`; line numbers may shift across rounds — search by symbol). At the top of the new test block, add a code-comment annotation enumerating the branches as a short list (one line each).
2. Add unit tests in `frontend/tests/unit/pages-settings.test.js` exercising each branch via the existing `vi.stubGlobal('fetch', ...)` + `createComponent()` pattern (see existing `canRetryUpgrade` specs and `executeUpgrade` 503-path specs for the harness shape). Each branch needs at least one assertion proving the branch fires — state assertion on `upgradePhase` / `upgradeError` / `upgradeWarnings`, OR a warning-emission spy assertion, per existing test style.
3. Tests must reach the actual `retryUpgradeBackend` code path — do NOT stub `retryUpgradeBackend` itself. Stubbing the dispatcher away leaves the gap intact.
4. No new code in `settings.js` — this is a test-coverage-only task.

## Out of scope

- Refactoring `retryUpgradeBackend` for testability. If a branch is genuinely unreachable without dependency injection or a test seam, document the constraint in the test block as a one-line `// untestable without DI: <reason>` comment and skip that branch. Do NOT add a new seam.
- Behavior changes to retry semantics. The function's contract is settled by `ui-seed-phrase-keychain-compat` round-5 and prior rounds; this task adds coverage, not changes.
- E2E or integration tests. Unit-level coverage at the `createComponent()` boundary suffices.

## Cross-references

- `frontend/src/pages/settings.js` — `retryUpgradeBackend()` and `handleRetry()` symbols (search by name; line numbers may have shifted).
- `frontend/tests/unit/pages-settings.test.js` — existing test harness; the `canRetryUpgrade` specs in the `executeUpgrade` describe block are the closest reference shape.
- Source: `/ce-code-review` round-6 of `ui-seed-phrase-keychain-compat` (2026-05-16), testing-ui-r5 testing_gap. Pre-existing per the reviewer's note; round-5 specs surfaced the visibility.

## Architect re-review (2026-05-17, round-1) — HELD PENDING FIXES:

`/ce-code-review` of commit `70ccf2d` ran with 5 personas (correctness Opus; testing/maintainability/project-standards/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md; security/adversarial/reliability/julik-frontend-races skipped — test-only diff, test lines don't count toward adversarial threshold, no auth/contract/async-UI changes). Branch enumeration H1, H2, R1-R11 verified accurate against production code (`handleRetry()` at `settings.js:469-475`, `retryUpgradeBackend()` at `settings.js:937-1014`, `loginFromResponse` at `auth.js:121-133`). R6 "untestable without DI" claim verified: `loginFromResponse` is fully synchronous, no suspension window between R5 and R6 guards for navigate-away to interleave. Status codes (503/409/429), error-key strings, post-await guard order, and catch-arm precedence all match. ACs #1-#4 satisfied.

### Items to address

**1. (P3, testing T1, anchor 80)** The R3 test (empty-newSeedPhrase defensive branch) omits two assertions present in every sibling terminal-sub-case test (R7, R9, R10, R11): `expect(comp.upgradePhase).toBe('error')` and `expect(comp.canRetryUpgrade).toBe(false)`. Production R3 routes to `upgrade.partialApplyFailed` which is on the `NON_RETRYABLE_UPGRADE_ERROR_KEYS` list, so `canRetryUpgrade` must be false; production R3 does NOT explicitly write `upgradePhase` so the entry-invariant `'error'` must hold. A mutation that omits the `partialApplyFailed` routing, or that adds an upgradePhase write before the `!newSeedPhrase` check, would pass the existing R3 test. Mutation-killing power is weaker than the sibling pattern.

   **Fix:** add the two missing assertions to the R3 test, matching the pattern used in R9/R10/R11. ~2 lines.

**2. (P3, maintainability M1, anchor 80)** The new `stubKeychainImportKeySuccess` helper (line ~2289 of the test file) is structurally identical to two existing `stubKeychainImportKey` helpers defined inside other describe blocks (lines 431 and 619). All three call `queueMicrotask(() => cb({success: true}))`. The new helper's `Success` suffix doesn't reflect a behavioral difference. The three copies are each scoped to their own describe block so cross-block reuse isn't possible without refactoring.

   **Fix:** extract a single file-level `stubKeychainImportKeySuccess()` helper at the top of the test file (above the `describe('settingsPage', ...)` block), then call it from all three sites instead of defining three private copies. If the Keychain callback contract ever changes (e.g., adds a second argument), one update covers all callers. The two pre-existing copies should be removed in the same commit — leaving them creates 3-of-3 duplicates instead of 0-of-3.

### Items dismissed at architect triage

- (P3, maintainability M2, anchor 75) `seedBackendUnavailableErrorState` mirrors the pattern of 3 existing per-describe seed helpers as a cumulative-debt observation. Dismissed: the new helper is not a duplicate (different fields, different error-state shape); the maintainer's flagged risk is "if a field is renamed, four helpers must be updated" which is a cumulative-pattern note, not a defect against this diff. PEvO YAGNI applies — extract a shared seed factory only when a fourth helper appears, not preemptively.

Pre-existing surfaced but explicitly NOT part of this hold:
- PS-001 (project-standards): `pages-settings.test.js` lacks top-of-file carve-out JSDoc header per root CLAUDE.md clause (a). 50+ existing tests already lack it; this diff inherits the gap, doesn't worsen it. File-separately if a uniform-carve-out-header sweep is desired.

### Architect signal

Move this file from `review/` back to `pending/` per rule #8. Implementer addresses items 1 (add 2 R3 assertions) and 2 (extract file-level keychain stub helper, replace 3 per-describe copies) in a single commit, then `git mv`s the file back to `review/` for round-2 architect re-review.

## UI re-review signal (2026-05-17, round-2, working tree)

Both round-1 hold-block items landed in a single commit.

**Item 1 (T1, P3 anchor 80 — R3 test missing two assertions):** added the two missing assertions to the R3 (empty-newSeedPhrase defensive branch) test in `frontend/tests/unit/pages-settings.test.js`:

- `expect(comp.upgradePhase).toBe('error')` — entry invariant. Production R3 doesn't write `upgradePhase`, so the value set on entry must hold; matches sibling terminal-sub-case tests R7/R9/R10/R11.
- `expect(comp.canRetryUpgrade).toBe(false)` — `upgrade.partialApplyFailed` is on `NON_RETRYABLE_UPGRADE_ERROR_KEYS`, so the derived getter must be false. Mutation-killing: a regression that omitted the partialApplyFailed routing (e.g., left `upgradeErrorKey` at `backendUnavailable`) is now caught independently of the `upgradeErrorKey` assertion above.

Inline comments explain the mutation-killing rationale for each (matching the architect's hold-block reasoning) so future readers don't strip them.

**Item 2 (M1, P3 anchor 80 — duplicate keychain stub helpers):** extracted a single file-level `stubKeychainImportKeySuccess()` at line ~144 of `frontend/tests/unit/pages-settings.test.js`, above the `describe('settingsPage', ...)` block. Removed the three previously-private copies (the two pre-existing nested `stubKeychainImportKey()` functions in the FE-UPGRADE-CREDENTIAL-WIPE and FE-UPGRADE-CLOSURE-WIPE describe blocks, and the new `stubKeychainImportKeySuccess()` in the UI-RETRY-UPGRADE-BACKEND-TEST-COVERAGE block). All 9 call sites renamed to the new file-level helper. If the Keychain callback contract ever changes (e.g., adds a second argument), one edit covers all callers.

**Files touched:**
- `frontend/tests/unit/pages-settings.test.js` — file-level helper extraction, 3 nested-helper removals, 9 call-site renames, 2 new R3 assertions.

All 77 tests in `pages-settings.test.js` pass (no test count change — refactor + assertion additions, no new test cases).

**Out of scope (unchanged):** no production-code changes to `retryUpgradeBackend()`/`handleRetry()`. Project-standards PS-001 (top-of-file carve-out JSDoc header) noted as pre-existing across 50+ tests; not bundled per architect dismissal posture.
