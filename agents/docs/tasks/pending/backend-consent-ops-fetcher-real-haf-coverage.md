# BACKEND-CONSENT-OPS-FETCHER-REAL-HAF-COVERAGE — close carve-out clause (c) for `fetchConsentOpsForPaper`

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` on `backend-coauthor-trust-model` rounds 1+3)
**Priority:** P2

## Problem

Round 1 of the multi-author trust model landed `fetchConsentOpsForPaper` (`backend/src/consent-ops.ts:50-100`) with a mocked-pool unit-test suite (`backend/tests/consent-ops.test.ts`). The test file's carve-out justification (lines 12-22) explicitly defers real-HAF coverage:

> Real-HAF coverage lands in round 2's integration tests once the consent-ops fetcher is exercised through `resolveContinuationChain`.

Per root `CLAUDE.md` "Carve-out for deterministic edge-case coverage" clause (c), targeted mocking is permitted IF "the same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add such coverage." This task is the filed follow-up.

The risk class is **SQL-shape mutations at the fetcher** (the `WHERE`/`SELECT`/`ORDER BY` against `hafsql.operation_custom_json_view`). Mock tests exercise the row-mapping and the validity-rule layer in `computeVouchedAuthors` but cannot catch a regression that, e.g., removes the `block_num >= $2` predicate, or breaks the `cj.id::text AS op_id` projection that the same-block tie-break depends on.

## Acceptance

- A new test file `backend/tests/consent-ops-real-haf.test.ts` (or extension to existing) that exercises `fetchConsentOpsForPaper` against the real HAF pool.
- Test fixtures: at least one consent op visible on the live HAF for a known paper. Most natural source is the local dev chain produced by Round 3's broadcast surface — once the SPA UI affordances ship via `ui-multi-author-consent-affordances`, real `author_accept` ops will exist on chain. Until then, the test can fall back to a manual broadcast via the dev backend (a one-off seed script or a fixture commit).
- Coverage targets:
  - SQL returns rows for a known paper with consent ops.
  - SQL returns `[]` for a paper with no consent ops.
  - The `op_id` projection is a valid `BigInt`-parseable string (regression guard for the tie-break primitive).
  - The `block_num >= $2` floor honors the genesis-floor argument.
- Skip-if-no-HAF guard so CI environments without HAF stay green; mirror the pattern used in other real-HAF integration tests.

## Coordination

- Most naturally lands alongside Round 2 of `backend-coauthor-trust-model` (the `papers.ts` integration tests will exercise the fetcher transitively, but a direct fetcher test is still valuable as a regression boundary).
- Compatible with whichever HAF-unavailability policy is chosen by `architect-haf-unavailability-vouched-set-policy` — the test doesn't need to assert that policy.

## Out of scope

- Validity-rule coverage in `computeVouchedAuthors` (already covered by mocked-pool unit tests; risk class is different).
- Round 2's integration test for `getVouchedAuthors` end-to-end through `resolveContinuationChain` — that's Round 2's own deliverable.

## Source

`/ce-code-review` (rounds 1+3) on 2026-05-05: project-standards reviewer flagged carve-out clause (c) gap (P2, conf 75). Filed per the carve-out's own "follow-up task is filed" alternative.
