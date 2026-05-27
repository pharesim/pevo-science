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

## Audit findings (rule fires on existing sites)

Running the new rule against `backend/src/` surfaces 15 pre-existing toxic-shape callsites. None of them match the original-bug shape exactly (CTE-body builder against the unconstrained accreditation namespace); each carries an additional selective JSONB predicate (per-account `account = $username`, per-orcid `orcid = $orcidId`, per-paper `root_author + root_permlink`, per-key `idempotency_key = $key`, scheduled-job statement_timeout bounds, etc.) that the original `activeAccreditationsCteBody` case lacked. The planner *may* favor the selective JSONB predicate path on each of these, but the BitmapAnd-toxic shape is still present as the static-SQL fingerprint, and a planner-stats shift on Mahdi's HAF could flip any of them.

For this task, each site was suppressed with an `eslint-disable-next-line pevo/no-custom-id-block-num-floor` directive carrying a rationale anchored on the route handler or helper symbol (no task slugs, no SHAs, no line numbers — per the comment-anchoring convention). The rule lands as a structural guard for new code without forcing per-site SQL surgery in this task.

[TODO Architect] File follow-up tasks (or one consolidated sweep task) to audit and either fix or permanently approve the disable at each of these 15 sites:

- `backend/src/accreditation.ts` — `getAccreditedSet` batch lookup with `account IN (...)` further-narrowing.
- `backend/src/consent-ops.ts` — `fetchConsentOps` with `root_author`, `root_permlink`, and claimed-signer IN-list further-narrowing.
- `backend/src/hafsql.ts` — `authorshipClaimsCteBody` with optional `scope` (claimer or paper-key) JSONB predicates.
- `backend/src/lib/idempotency.ts` — three sites: `findOpByIdempotencyKey`, `findAccreditationBroadcastByIdempotencyKey`, `findExistingAccreditation`.
- `backend/src/reputation.ts` — three sites: `loadReputationWeights` existence probe (2s LOCAL statement_timeout), `loadReputationWeights` latest-update read (5s LOCAL statement_timeout), `computeReputationDelta` batch CTE (background job, multiple sub-CTEs each scoped by `target_users`/`target_authors`).
- `backend/src/routes/accreditations.ts` — two sites: `fetchAccreditationsFromHaf` listing (60s `hafCache.getOrSet`) and `fetchAccreditationStatusFromHaf` per-account read.
- `backend/src/routes/orcid.ts` — three sites: `getOrcidAccount` recent-binding probe (per-orcid), `getOrcidAccount` status re-check (per-account), `getExistingAccreditation` per-account read.
- `backend/src/routes/profile.ts` — profile-page accreditation read (per-account).

The fix shape per site is the same as `285e7c14` / `e31c984f`: drop the `cj.block_num >= $genesis` predicate (the additional JSONB filter is already selective enough; the genesis floor is by-construction inert because pre-genesis PEvO-namespace custom_jsons cannot exist), then remove the disable directive. Each site needs its own behavioral test pass against a real HAF to confirm the row count and ordering are unchanged.

## Architect review (2026-05-27) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `058fad47` (correctness, testing, maintainability, project-standards). The rule is well-built and the 15 disable rationales are clean (anchored on helper/route symbols; the "pending audit per the BitmapAnd-floor sweep follow-up" phrasing is acceptable — no slug). The RuleTester suite passes and `npx eslint src/` is clean with all 15 suppressions live. Three items hold:

1. **(P2, conf 100 — correctness) `wot.ts` `loadWotThreshold` is an unflagged 16th BitmapAnd-toxic site.** It runs `FROM ${T.customJson}` with `WHERE custom_id = $1 ... AND block_num >= $2` — both columns UNALIASED. `CUSTOM_ID_RE = /\b\w+\.custom_id\b/` requires an `<alias>.` prefix, so the rule never fires there (`npx eslint src/wot.ts` → 0 errors). This is both a rule false-negative class (the docstring's "every PEvO callsite uses an alias" assumption is already false) AND a real unguarded toxic site with the same plan profile as several of the 15 suppressed sites — and it fails this task's acceptance #6 ("the rule fires on the pre-existing toxic sites; any divergence from the grep audit is a rule-shape bug"). Fix: broaden `CUSTOM_ID_RE` to also match bare/unaliased `custom_id` (at minimum when co-occurring with the `block_num >=` floor — the rule already requires both predicates present), then handle `wot.ts` (alias the query + add the disable with rationale, OR drop its `block_num >=` floor). Re-run the grep-vs-lint audit and confirm no further unflagged sites.

2. **(P3, conf 75 — testing) The NUL-placeholder quasi-join is not mutation-killed.** The two substitution-boundary valid cases split on the COLUMN side (`cj.${col}` / `cj.${otherCol}`), where joining quasis with `\0` vs `''` produces the identical no-match — so a mutation dropping the NUL separator survives green. Add a valid case where a substitution splits an IDENTIFIER mid-token (e.g. `cj.custom_${suffix}` with `suffix='id'`): with the NUL join it stays silent; without it the quasis concatenate to `cj.custom_id` and false-positive. That case kills the NUL-drop mutation.

3. **(P2, conf 75 — maintainability) `flattenSqlString` duplicates ~25 lines of the bridge rule's `resolveStringValue`** (TS-wrapper unwrap + Literal + BinaryExpression recursion), diverging only at TemplateLiteral and CallExpression handling. Acceptable at two rules, but a third would copy it again. Extract a shared string-flattening walker both rules parameterize. If you judge the extraction churn not worth it now, say so in the re-review signal and this item can be dismissed — but see the residual below, which may make the shared walker worth it anyway.

Residual to weigh while in item 1: the rule's visitor set omits `CallExpression` (the bridge rule includes it), so a `.join()`-assembled toxic SQL fragment would evade the rule. Not required, but consider adding it alongside the matcher broadening (and it interacts with item 3's shared-walker decision).

When items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 review scopes to the fix commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-27, landed at commit 94f2305e)

Round-2 hold items 1-3 landed.

1. **(item 1 — decision: suppress-with-disable for wot.ts)** Broadened `CUSTOM_ID_RE` from `/\b\w+\.custom_id\b/` to `/\b(?:\w+\.)?custom_id\b/` so it matches both alias-qualified and bare/unaliased `custom_id` (the `\b` anchors still exclude `my_custom_id` substrings). Added an `eslint-disable-next-line` on `loadWotThreshold`'s query with a rationale anchored on the `loadWotThreshold` symbol (consistent with the existing 15; no SQL behavior change, so no real-HAF re-verification needed). Updated the module docstring + the rule's `meta.docs.description`/`messages.forbidden` to say "aliased or bare". Grep-vs-lint audit: 16 sites flagged and suppressed, `--report-unused-disable-directives` shows 0 unused floor-rule disables, `eslint src/` is 0 errors, no further unflagged toxic sites. Verified by mutation: stripping the wot.ts disable makes the broadened rule fire on the bare `custom_id` with the BitmapAnd message.

2. **(item 2)** Added a valid RuleTester case splitting an identifier mid-token (`` `cj.custom_${suffix}` `` with `suffix='id'`): the NUL quasi-join keeps it silent; dropping the NUL separator concatenates the quasis to `cj.custom_id` and false-positives — kills the NUL-drop mutation.

3. **(item 3 — decision: extracted the shared walker)** Extracted `foldStringExpr` + `foldArrayJoin` (TS-wrapper unwrap + Literal + BinaryExpression-`+` recursion), parameterized by per-rule TemplateLiteral/CallExpression handlers; the bridge rule's `resolveStringValue` and the floor rule's `flattenSqlString` both delegate, removing the ~25-line duplication. Also added `CallExpression` to the floor rule's visitor set with `foldArrayJoin` as the `.join()` handler, closing the residual where a `.join()`-assembled toxic fragment evaded the rule (pinned by a new invalid `.join(' AND ')` case).

Verification: `npm run typecheck` clean; `npm run lint`/`eslint src/` 0 errors; RuleTester `no-custom-id-block-num-floor` 17 passed, `no-bridge-paper-literal` 30 passed (the shared-walker refactor preserved bridge behavior). An unrelated `no-restricted-imports` config block was added to `eslint.config.mjs` on main after the worker's branch point; it was preserved through the cherry-pick 3-way merge (verified present).
