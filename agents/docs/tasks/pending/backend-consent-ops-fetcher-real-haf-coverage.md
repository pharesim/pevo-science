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

## Architect re-review (2026-05-06) — HELD PENDING FIXES:

`/ce-code-review` on commit `5788519` surfaced 6 findings, all coherent enough to bundle into a single follow-up round. The architectural concern at F1 cascades through F2/F3/F5; F4 and F6 are independently fixable but bundle here because the implementer is already in the file.

**Reviewer team:** correctness, testing, maintainability, project-standards, ce-learnings-researcher, kieran-typescript (6 dispatched, 0 failures, ce-agent-native-reviewer skipped per root CLAUDE.md PEvO carve-out). Project-standards came back clean.

### F1 (P1, anchor 100, correctness + testing) — Blocks 3 and 4 don't actually exercise the production fetcher

`backend/tests/consent-ops-real-haf.test.ts:178-267`. The third `it` block (`block_num >= $2 floor honors the genesis-floor argument`) and fourth `it` block (`op_id is projected as a non-numeric-typed string at the SQL boundary`) both call `queryWithRetry(pool, CONSENT_OPS_SQL, [...])` against the test-local SQL constant at lines 52-66. Neither block calls `fetchConsentOpsForPaper`. If production at `consent-ops.ts:70-84` mutates (drop `block_num >= $2`, drop `cj.id::text`), both blocks continue passing because they execute the test's own copy of the SQL.

**Decision needed.** Pick one:

- **A1.** Refactor `fetchConsentOpsForPaper` to accept an optional `genesisFloor` parameter (defaulting to `getCachedGenesisBlock()`). Drives the floor through production. Block 3 calls the production fetcher with a high floor; block 4 still needs F2's separate fix.
- **A2.** `vi.spyOn(getCachedGenesisBlock)` in block 3 to inject the high floor without changing the production signature. Reintroduces a partial mock in a real-HAF test (a small backslide on the carve-out we are closing); evaluate whether the carve-out clause-c rationale extends to this targeted spy and document the justification at the test-file header if so.
- **A3.** Remove blocks 3 and 4 entirely; revise the header (lines 1-39) to honestly state the test catches only the mutations that flow through block 2's row-shape assertions. Most aligned with `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. Smallest change. Trades stated coverage for honest coverage.

A3 is the architect's lean (smallest defensible change; honest coverage beats overstated coverage), but A1 and A2 are also acceptable. Backend's call.

### F2 (P2, anchor 100, correctness + testing) — Block 4's `typeof === 'string'` is a placebo for the cited `::text` cast mutation

`backend/tests/consent-ops-real-haf.test.ts:225-268`. node-postgres maps PostgreSQL `bigint` (OID 20) to JavaScript string by default; `backend/src/db.ts` does not override (verified via `grep -r "setTypeParser"` returning nothing across the project). Therefore `expect(typeof row.op_id).toBe('string')` passes identically with or without the `::text` cast. Same for the `/^\d+$/` regex and the `BigInt(...)` parse — pg's default stringification satisfies all three. The block's stated mutation guard is non-functional.

**Resolution depends on F1.** If A3 (block 4 removed), this finding goes away. If A1 or A2 (block 4 kept), redesign the assertions to actually distinguish text-typed from bigint-typed projection. Two viable shapes:

- Inspect column metadata: `expect(result.fields.find(f => f.name === 'op_id')?.dataTypeID).toBe(25)` — text OID is 25, INT8/bigint is 20.
- Project `pg_typeof(...)` and assert: add `pg_typeof(cj.id::text) AS op_id_pg_type` to the SQL, assert returns `'text'`.

### F3 (P2, anchor 75, correctness) — Header overstates clause-c coverage

`backend/tests/consent-ops-real-haf.test.ts:12-15`. The header bullet "drops the `custom_id = $1` appTag scope and leaks ops from other PEvO deployments" implies real-HAF coverage of the appTag-scope mutation. The test does not exercise this mutation — it would require a fixture with consent ops in a different appTag namespace on the same chain, which doesn't exist (PEvO-beta runs only `pevotest`).

The mocked sibling at `backend/tests/consent-ops.test.ts:290` does cover this mutation via SQL-string regex (`expect(sql).toMatch(/cj\.custom_id\s*=\s*\$1/)`).

**Fix.** Narrow the header to drop the `custom_id` bullet (or move it to a "structurally uncoverable today" footnote) and add a one-line cross-reference along the lines of: "Clause-c coverage of the `custom_id = $1` appTag scope lives in `tests/consent-ops.test.ts:290` (SQL-string regex on the mocked sibling); a real-HAF check is not feasible while only one PEvO appTag namespace exists on chain." Pure documentation update.

### F4 (P3, anchor 100, correctness + testing) — Probe is non-deterministic across runs and across calls

`backend/tests/consent-ops-real-haf.test.ts:82-109`. `findKnownPaperWithConsentOps` has `LIMIT 1` with no `ORDER BY` and is called independently in blocks 2 (line 142), 3 (line 188), and 4 (line 235). Once consent ops accumulate post-UI-launch, the probe can return different fixtures across runs (PostgreSQL row order without `ORDER BY` is unspecified) and across calls within the same run (each block re-probes).

**Fix.** Add `ORDER BY cj.block_num ASC, cj.id ASC` before `LIMIT 1`, and hoist the probe into `beforeAll` so all surviving blocks share the same fixture. Halves the probe count against HAF as a side benefit.

If F1 lands as A3 (blocks 3 and 4 removed), only block 2 calls the probe and the cross-call inconsistency dissolves for free; the `ORDER BY` clause is still worth adding for cross-run determinism.

### F5 (P1, anchor 75, maintainability) — Inline comment overstates drift detection

`backend/tests/consent-ops-real-haf.test.ts:50-51`. The inline comment "Keep aligned with `consent-ops.ts:70-84` — the assertions below catch any drift" is false for blocks 3 and 4 (per F1) — they execute this constant directly so production drift can't fail them. The header at lines 35-38 has the careful framing ("the test still pins the SQL contract the production fetcher MUST honor"); the inline comment should match.

**Fix.** Rewrite the line-50/51 comment to match the header's careful framing. If F1 resolves as A3 (constant removed), this comment goes away with it.

### F6 (P1, anchor 75, kieran-typescript) — Throw-not-throw assertion is redundant

`backend/tests/consent-ops-real-haf.test.ts:162`. `expect(() => BigInt(op.opId)).not.toThrow()` is redundant given line 161's `expect(op.opId).toMatch(/^\d+$/)` — any string matching `/^\d+$/` is BigInt-parseable without throwing. The throw form also produces unhelpful failure diagnostics ("Expected function not to throw") instead of showing the actual bad value.

**Fix.** Replace line 162 with `expect(BigInt(op.opId)).toBeGreaterThanOrEqual(0n);` (asserts parsability and positivity in one assertion with diff-ready failure messages), or drop line 162 entirely if positivity isn't worth asserting (the regex already excludes negatives).

### Convention surface (informational, not blocking)

The carve-out clause-c convention at `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` requires the **mocked sibling** to back-reference its real-HAF companion by path. The mocked file at `backend/tests/consent-ops.test.ts:12-22` describes a stale plan ("Real-HAF coverage lands in round 2's integration tests once the consent-ops fetcher is exercised through `resolveContinuationChain`"), which is no longer accurate — the real-HAF coverage landed as `consent-ops-real-haf.test.ts` instead. While bundled fixes are in flight on this file, also update the mocked sibling's carve-out section to name `consent-ops-real-haf.test.ts` as the closing companion. Counts as part of this round, not a separate task.

### Verdict

**Not ready to archive.** F1 alone blocks; F2/F3/F4/F5/F6 fold cleanly into the same revision pass. After fixes land, `git mv` back to `tasks/review/` and the architect re-reviews scoped to commits since this hold block.
