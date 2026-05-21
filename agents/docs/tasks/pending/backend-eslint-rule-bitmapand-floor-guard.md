# ESLint rule: guard against the BitmapAnd-toxic SQL floor pattern

**Owner:** backend
**Created:** 2026-05-21

The toxic SQL shape `cj.custom_id = $appTag AND cj.block_num >= $genesis` against `hafsql.operation_custom_json_view` triggers a PostgreSQL BitmapAnd plan on the live HAF that scans tens of millions of operation rows, blows the 3000ms walker budget, and surfaces as 503 SERVICE_UNAVAILABLE. Two commits closed all known instances on 2026-05-21 (`285e7c14` and `e31c984f`), but the convention currently lives only in a docstring on `activeAccreditationsCteBody` and the commit messages. Without a structural guard, any future custom_json query is a re-occurrence risk — and the failure mode is hard to catch in tests (performance-only, planner-dependent, data-volume-dependent; local Postgres in CI does not trigger the BitmapAnd plan).

Add an ESLint rule modelled after the existing `pevo/no-bridge-paper-literal` precedent in `backend/eslint.config.mjs`.

## Acceptance criteria

1. New rule named something like `pevo/no-custom-id-block-num-floor` defined in `backend/eslint.config.mjs`, exported alongside the existing `noBridgePaperLiteralRule`.

2. The rule fires when a single template literal (or string-concat chain) under `backend/src/` contains BOTH:
   - The token sequence `cj.custom_id` (or any alias-qualified `custom_id` that the rule's matcher recognizes)
   - AND a `block_num >=` predicate

   in the same SQL fragment. The matcher does not need to parse SQL — a regex over the literal's string value is sufficient (this is what `no-bridge-paper-literal` does for its target).

3. The error message points to the BitmapAnd documentation on `activeAccreditationsCteBody` and the known-safe remediation ("drop the `block_num >=` floor; `custom_id = $appTag` is selective enough on Mahdi's HAF").

4. New test file `backend/tests/eslint/no-custom-id-block-num-floor.test.ts`, modelled after `backend/tests/eslint/no-bridge-paper-literal.test.ts`, with these cases:
   - **Violation: CTE-body shape** — `WHERE cj.custom_id = $1 AND cj.block_num >= $2` in a template literal → flagged
   - **Violation: inline pool.query** — same shape across separate `cj.custom_id` and `cj.block_num >=` template-literal lines → flagged
   - **Allowed: custom_id only** — `WHERE cj.custom_id = $1` with no block_num predicate → silent
   - **Allowed: block_num only** — `WHERE cj.block_num >= $2` without custom_id → silent (different pathology, not this rule's concern)
   - **Allowed by allowlist** — at least one site where the floor is legitimately load-bearing (if any exist; otherwise the rule has no allowlist). Audit the codebase for genuine cases before deciding.

5. The rule runs as part of the normal lint step (no separate skip/allow toggles).

6. After the rule is in place, audit every existing `custom_id` callsite across `backend/src/` to confirm no other instances of the toxic shape remain. The audit shape:

   ```bash
   grep -rn "cj.custom_id" backend/src/ --include="*.ts" -A5
   ```

   Cross-check against the lint output. Any divergence (rule misses a hit visible to grep, or grep hits something the rule does not flag) is a rule-shape bug.

## Implementation notes

- Precedent: `backend/eslint.config.mjs` already defines `noBridgePaperLiteralRule` and exports it for RuleTester drive-by-import in `backend/tests/eslint/no-bridge-paper-literal.test.ts`. Match that structure exactly.
- The rule should be a structural check on string-literal values, not a SQL parser. PEvO's existing canary tests (`notification-queries-lateral-guard-canary.test.ts` and friends) use the same shape-only approach.
- Background: see `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` for the audit-discipline lesson that motivated this task, and commits `285e7c14` + `e31c984f` for the technical reasoning on why the floor is plan-toxic.
