# BACKEND-ACCRED-STATE-READ-TIEBREAKER-ESLINT-GUARD — structural guard so an accreditation-state read missing the same-block `id` tie-breaker fails lint, not silently passes

**Owner:** backend
**Created:** 2026-06-09 (architect, from the `/ce-code-review` of `backend-accreditation-state-read-tiebreaker-sweep`; sub-goal 2 / canary-reachability gap, user-elected at triage)
**Priority:** P2 (no live defect — every accreditation-state read carries `block_num DESC, cj.id DESC` today; this is the durable structural enforcement so the partial-fix-drift that has now recurred twice cannot recur a third time silently)

## Problem

The accreditation-state "latest accredit/revoke wins" reads must carry the same-block deterministic tie-breaker `ORDER BY cj.block_num DESC, cj.id DESC` (the monotonic HAF op id; the deployed HAF mirror views omit `trx_in_block`, so `id` is the only intra-block key). The canonical CTE (`activeAccreditationsCteBody`) and the exported fragments are guarded by the `window-cte-deterministic-tiebreaker.test.ts` shape canary (`toContain`). But several of these reads are **inline `pool.query` template strings**, not exported SQL fragments, so the `toContain` canary cannot reach them:

- `routes/orcid.ts` — `findAccreditedAccountWithOrcid` (first read + binding-live re-check), `getExistingAccreditation`.
- `routes/profile.ts` — `getAccreditationFromHaf`.
- `accreditation.ts` — `getAccreditedSet` (inline ROW_NUMBER ranking).
- `routes/accreditations.ts` — `fetchAccreditationsFromHaf`, `fetchAccreditationStatusFromHaf`.

A future edit dropping `, cj.id DESC` from any inline read **passes the whole suite** — the live HAF corpus is unlikely to contain a same-block accredit/revoke pair for a test account, so the route integration tests do not catch it either. This is exactly the partial-fix-drift class that the prior `window-cte-deterministic-tiebreaker` task and then `backend-accreditation-state-read-tiebreaker-sweep` had to remediate — the syntactic sweep missed the semantic siblings **twice**. `convention-sweep-syntactic-form-misses-semantic-siblings` Section 2 prescribes structural enforcement (an ESLint rule) as the only durable gate for a recurring drift class.

## Goal

Add an ESLint rule that flags any HAF `custom_json` read filtering on `action IN ('accredit','revoke')` / `action = 'accredit'` whose `ORDER BY ... block_num DESC` lacks the secondary `id DESC` (or `cj.id DESC` / `op_id DESC`) key, so a dropped tie-breaker turns lint red instead of passing silently. The rule stands purely as a guard for new code (like `pevo/no-custom-id-block-num-floor`); all current sites already comply, so it lands with **zero** suppressions.

### Suggested approach

- Mirror the precedent rule `pevo/no-custom-id-block-num-floor` (`noCustomIdBlockNumFloorRule` in `backend/eslint.config.mjs`): a static-SQL-literal AST check over template-literal `pool.query` strings. Detect the fingerprint — a literal that co-occurs `'action'` with `'accredit'`/`'revoke'` AND `block_num DESC` — and require the literal to also contain `id DESC` after `block_num DESC` in the same `ORDER BY`.
- Calibrate to avoid false positives: the window-feed reads (`block_num > $N`, no `LIMIT 1` latest-wins, e.g. the notification feed) and the `MIN()`/genesis aggregates are NOT of this shape and must not trip. The defining shape is "latest-action-wins LIMIT-1 (or ROW_NUMBER rn=1) read filtered to accredit/revoke."
- If a pure-AST string check proves too brittle to express precisely, the acceptable narrower form is extracting the accreditation "latest accredit/revoke wins" `ORDER BY` clause into a shared exported constant/fragment that the inline sites compose and the existing shape canary asserts (the task's original sub-goal 2). Prefer the ESLint rule (lower hot-path risk — `getAccreditedSet` is a hot path the prior task deliberately left append-not-refactor to preserve its query plan); fall back to the fragment extraction only if the lint rule can't be made precise.

## Acceptance

- A rule (`pevo/no-accred-state-read-missing-id-tiebreaker` or similar) in `backend/eslint.config.mjs` flags the missing-`id`-tie-breaker fingerprint on accreditation-state reads; verified by a probe edit (drop `, cj.id DESC` from one inline read → `npx eslint src/` errors on exactly that site).
- All current sites pass with **zero** `eslint-disable` suppressions; `npx eslint src/ --report-unused-disable-directives` clean.
- The rule does NOT trip on the window-feed reads, the genesis `MIN()` aggregate, or the accepted-residual reads (wot `update_params`, reputation `update_weights`, `lib/idempotency.ts`, papers `batchResolveVotes`) — those are out of family (verify each stays green).
- Update the `window-cte-deterministic-tiebreaker.test.ts` scope-note: the inline reads it currently records as "guarded only by route integration tests" are now guarded by the lint rule (name the rule).
- `npm run typecheck` + `npm run lint` clean. Comment anchors clean (no slug/round/line/SHA; anchor the rule's own doc comment on the convention name).

## Cross-references

- `backend/src/routes/orcid.ts`, `backend/src/routes/profile.ts`, `backend/src/accreditation.ts`, `backend/src/routes/accreditations.ts` (the inline reads).
- `backend/eslint.config.mjs` — `noCustomIdBlockNumFloorRule` (the precedent rule shape).
- `backend/tests/window-cte-deterministic-tiebreaker.test.ts` (the exported-fragment canary + the scope-note to update).
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` (the family enumeration).
- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` (Rule 2 — `(block_num, id)` ordering; its text already warns inline hand-copies are "the easy miss").
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` (Section 2 — structural enforcement for a recurring drift class).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
