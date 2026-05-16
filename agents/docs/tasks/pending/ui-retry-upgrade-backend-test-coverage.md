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
