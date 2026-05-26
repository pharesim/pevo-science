# BACKEND-REVIEWS-REAL-HAF-INTEGRATION-COVERAGE — add real-HAF companion suite for `/api/reviews/:author/:permlink`

**Owner:** Backend Agent
**Created:** 2026-05-21 (filed as part of `backend-pevo-string-helper-adoption-sweep.md` round-3 hold item 2: clause-(c) follow-up for the mocked-pool reviews.test.ts file)
**Priority:** P3

## Problem

`backend/tests/routes/reviews.test.ts` is mocked-pool end-to-end: the file's top-level `vi.mock('../../src/db.js')` applies to every describe block, including the one previously labeled `(real HAF)`. The carve-out justification in the file header now correctly acknowledges that no real-HAF integration coverage exists for the `/api/reviews/:author/:permlink` route, and cites this task as the clause-(c) follow-up.

The risk class the mocked specs guard (the `buildReviewDetail` projection shape, the SQL accreditation gate, the SQL parent-paper parity gate, and the `pevoString` collapse semantics on `reviewer_attestation_id`) is partially exercised against real HAF by sibling SQL gates (e.g. `review-parity-invariant.test.ts`, `reputation-lifecycle.test.ts` — same shape patterns at different routes). But the single-doc `/api/reviews/:author/:permlink` endpoint itself has zero real-HAF coverage today.

## Goal

Add a real-HAF integration companion suite (in `backend/tests/routes/` or a new `reviews-real-haf.test.ts`) that exercises the GET-review route family against the live HAF pool:

1. **404 path against an unseeded permlink.** Hit `/api/reviews/<random>/<random>` and assert 404 + `NOT_FOUND`. No DB seed required.
2. **200 path against a live reviewer-authored record.** Walk the live HAF for a known accredited-reviewer record (or use a fixture account if available) and assert the response envelope shape: `author`, `permlink`, `body`, `rating`, `reviewer_attestation_id`, `paper.author`, `paper.permlink`, `paper.title`, `is_accredited`. Tolerant assertions only (shape, not values) so the spec stays green across drifting live data.
3. **404 for an unaccredited-author review** if a deterministic unaccredited-Hive-account-with-review-shaped-comment can be located on chain; otherwise note this branch remains in mocked-pool coverage only.

The real-HAF companion does NOT need to re-prove the helper-narrowing semantics that the mocked specs pin; it only needs to integrate the route against the real pool so a different mutation class (SQL composition errors, pool config errors, real CTE-binding bugs) is caught at the route layer.

## Acceptance

1. New test file(s) exist under `backend/tests/routes/` that exercise `/api/reviews/:author/:permlink` against the real HAF pool.
2. The 404 path is pinned end-to-end against real HAF.
3. At least one 200-path spec is pinned against a live record (with tolerant shape assertions).
4. The file uses the standard real-HAF setup (no `vi.mock('../../src/db.js')`, real pool config, the project-wide `getPool()` helper).
5. `npx tsc --noEmit` clean. Targeted vitest stays green.
6. Update the `backend/tests/routes/reviews.test.ts` file-header carve-out clause (c) to cite this new file (or remove the follow-up reference once landed).

## Coordination

This task is independent of the keystone helper-adoption sweep. It can land any time. The mocked-pool specs in `reviews.test.ts` remain valid coverage for the per-test deterministic shapes; this task adds the complementary real-path mutation-kill at the route layer.

## Cross-references

- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — the clause-(c) "follow-up filing IS the carve-out satisfier" convention this task implements.
- `backend/tests/routes/reviews.test.ts` — the mocked-pool sibling whose carve-out cites this task.

---

## Architect re-review (2026-05-26) — HELD PENDING FIXES (round 1)

Landed at commit `0162862b` (new file `backend/tests/routes/reviews-real-haf.test.ts` + clause-(c) header rewrite in `reviews.test.ts`). `/ce-code-review` (7 reviewers — correctness on Opus; testing/reliability/maintainability/project-standards/kieran-typescript/learnings on Sonnet; security/adversarial skipped as low-value on a read-only GET integration test; ce-agent-native-reviewer skipped per PEvO). The suite is well-built: the 404 path is sound (the route does zero input validation, so an unseeded pair falls through to empty rows → 404 NOT_FOUND), the `ctx.skip`-on-empty pattern correctly avoids vacuous passes, the config-mutation in beforeAll/afterAll is safe under vitest's fork-pool isolation, and the clause-(c) rewrite accurately cites this file as the real-path companion. Two items held; the skip-on-empty design (#1 below) and the serial-walk flake risk (#6) were reviewed and DISMISSED at triage (see note).

### Items held (must fix before archive — bundle into one round-1-fix commit)

**1. (P3, conf 75, project-standards) Comment cites "per task acceptance #3" — a coordination-state anchor that rots on archive.** In `backend/tests/routes/reviews-real-haf.test.ts`, the trailing comment explaining why the unaccredited-author 404 branch stays in mocked coverage reads "...impractical per task acceptance #3." This is a numbered reference into a task artifact (same rot class as a round-number or slug citation, per root CLAUDE.md "Comment anchors"). It goes stale the instant this task archives — which is imminent. Fix: replace with the inline behavioral rationale, e.g. "...impractical because seeding an unaccredited-reviewer record against the public HAF DB requires a controlled chain account and is not feasible per-test." Anchor on the behavioral reason, not the acceptance-criterion number.

**2. (P3, conf 75, testing) The `created` field is projected by `buildReviewDetail` but not asserted in the 200-path shape check.** The 200-path test pins every other projected field (`author`, `permlink`, `body`, `rating` + sub-keys, `reviewer_attestation_id`, `paper` triple, `is_accredited`, `is_anonymous`, `net_votes`, `reviewer_reputation`) but omits `created` (the SQL selects `c.created`). A CTE regression dropping that column returns `undefined` undetected — the one gap in an otherwise-complete projection-shape assertion. Fix: add one tolerant assertion in the same 200-path block, e.g. `expect(typeof data.created).toBe('string')` (confirm the runtime type — it is whatever `buildReviewDetail` emits for `c.created`; use the type the projection actually produces).

### Items dismissed at architect triage (recorded for transparency)

- **(testing P1, conf 75)** The 200-path can permanently `ctx.skip` on a sparse/empty corpus, hiding the SQL/CTE/pool mutation class behind a green-but-skipped run. DISMISSED: the task goal + acceptance #2/#3 explicitly sanctioned `ctx.skip`-on-empty for this real-HAF-against-live-corpus design, and the pevotest corpus is populated (beta live), so the 200 path exercises in practice. The proposed mitigation (a CI skip-streak metric) is disproportionate infra for a sanctioned design.
- **(testing P2 / correctness + reliability residual, conf 75)** The 200-path serial walk issues up to ~102 live HAF calls under a 90s budget (flake risk). DISMISSED: mitigated by early-break-on-first-match + vitest `retry: 3`, and it matches the established sibling real-HAF pattern (`papers.test.ts`). Probabilistic, no current break; default-dismiss per `feedback_dismiss_preemptive_test_hardening`. (If the implementer is editing this block anyway, lowering the walk page to `limit=20–30` is a welcome cheap hardening but not required.)
- **(reliability P3, pre-existing)** The listing-call `expect(200)` hard-fails on a transient HAF 503 instead of skipping — identical to `papers.test.ts`; not introduced by this commit. Out of scope.
- **(correctness P3, conf 50)** ~102 calls vs the shared `readLimiter` 120/60s could 429. Below the confidence gate; default-dismiss zone.

### Re-review signal

When items 1–2 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal. Round-1-fix re-review scopes `/ce-code-review` to the fix commit only. Both items are a one-line comment rewrite + a one-line assertion in the same new test file; no production change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-26)

Both round-1 items landed in `backend/tests/routes/reviews-real-haf.test.ts` (test-only, no production change):

- **Item 1 (coordination-anchor rot).** The trailing comment on the unaccredited-author 404 branch no longer cites "per task acceptance #3". It now reads that seeding such an account against the public HAF DB "requires a controlled chain account and is not feasible per-test" — anchored on the behavioral reason, not the acceptance-criterion number.
- **Item 2 (`created` projection assertion).** Added `expect(typeof data.created).toBe('string')` in the 200-path shape block, with a comment noting `created` is projected from `c.created` and pg serializes the timestamp to an ISO string in the JSON envelope; a CTE regression dropping the column would surface as `undefined` and flip the assertion RED.

Verification: `npm run typecheck` clean (src + tests); `npm run lint` clean on the test file; targeted `npx vitest run tests/routes/reviews-real-haf.test.ts` green against real HAF — the 404 path and the 200-path (walked the live corpus, found a reviewed paper) both exercised.

Moves the task back to review/.
