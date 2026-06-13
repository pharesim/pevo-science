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

---

## Backend completion note (2026-06-09, commit `4f47ac84`, worktree-fan-out worker merged to main)

Landed `pevo/no-accred-state-read-missing-id-tiebreaker` in `backend/eslint.config.mjs`, mirroring the `noCustomIdBlockNumFloorRule` static-SQL-literal AST shape (shared `foldStringExpr` core, comments stripped). Zero suppressions; only the two allowed files changed (`eslint.config.mjs` + the `window-cte-deterministic-tiebreaker.test.ts` scope-note, which now names the lint rule as the guard for the inline reads).

**Detection fingerprint:** a flattened literal containing a single-line `'action' = / IN (...'accredit'|'revoke')` predicate gates the rule on the accreditation-state family (excludes `update_params`, `update_weights`, `'revote'`, idempotency probes by construction). Two region shapes are then classified as latest-action-wins reads: (a) `ORDER BY` clauses scanned with paren-depth tracking to a clause-depth `LIMIT 1` (pagination `LIMIT $N` skips; DISTINCT-ON subquery arms and `${'$'}{dir}` interpolations exit the region); (b) any `OVER (...)` window body (ROW_NUMBER rankings). In a classified region, every `block_num DESC` must be immediately followed by `, <alias.>id DESC` / `op_id DESC`.

**Probe evidence (both arms):** dropping `, cj.id DESC` from `getAccreditationFromHaf` (`routes/profile.ts`) → exactly one eslint error on that site (LIMIT-1 arm); dropping it from `getAccreditedSet`'s ROW_NUMBER ranking (`accreditation.ts`) → exactly one error (window arm). Both probes reverted.

**Calibration confirmed:** window-feed reads, the genesis `MIN()` aggregate, and the accepted-residual reads stay green (clean full-`src/` run). `npx eslint src/ --report-unused-disable-directives` clean except the pre-existing accepted `author-supersession.ts` directive; typecheck + lint clean; `window-cte-deterministic-tiebreaker.test.ts` 3/3 and `tests/eslint/` 47/47 green. Post-merge combined-tree verification (with the concurrently-landed orcid admin-broadcast migration): lint + typecheck clean, 152/152 across orcid + tiebreaker + eslint suites.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-12) — HELD PENDING FIXES (5 items)

`/ce-code-review` fan-out on commit `4f47ac84` (correctness + adversarial on the session model; testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO; the two adversarial design findings independently validated). **The rule itself is VERIFIED SOUND on the current tree**: the detection pipeline (shared `foldStringExpr` core — genuinely shared, no copy-paste drift — comment stripping, the action gate, both region classifiers) traced end-to-end; all guarded-family inline reads carry the tiebreaker today, so zero suppressions is genuine compliance; the out-of-family reads (window-feed arms, genesis `MIN()`, `update_params`/`update_weights`/`revote`/idempotency residuals) cannot trip the gate by construction; `npx eslint src/` clean; the scope-note accurately records the new division of guard labor; anchors clean; the convention-sweep entry's structural-enforcement prescription is satisfied. Five items before archive (user-triaged):

1. (P2; testing + correctness + adversarial + learnings corroborated, conf 100) **The rule has no test suite — the guard itself is unguarded.** Both sibling rules have dedicated RuleTester suites under `backend/tests/eslint/`; this rule's probe evidence was manual and reverted, so a future regression in the shared helpers or either region classifier silently disarms the guard with no CI signal. Invariant: every fire/skip behavior is pinned and replayable. Add `backend/tests/eslint/no-accred-state-read-missing-id-tiebreaker.test.ts` mirroring the sibling shape. Minimum invalid cases: the LIMIT-1 shape missing `id DESC` (the `getAccreditationFromHaf` form); the OVER/ROW_NUMBER shape missing it (the `getAccreditedSet` form); a bare unaliased `id DESC` variant pinning the alias-optional arm. Minimum valid cases: both shapes WITH the tiebreaker; `op_id DESC` accepted; action filter with no ORDER BY (the genesis `MIN()` shape); `LIMIT $N` pagination not firing; a LIMIT-1 read with no accredit/revoke filter not firing; an SQL line comment containing 'accredit' (pins `stripSqlLineComments`). Include a meta-mutation case that lints the REAL site literals with the tiebreaker stripped and asserts errors — this also converts item 3's silent-disarm into a red test.
2. (P2; correctness + adversarial, both probe-verified, conf 100) **Documented gate coverage does not match behavior.** The rule docstring claims the gate matches the bare ranked-CTE alias form `action IN ('accredit', ...)`; the gate regex requires the quoted jsonb key `'action'` and does not match the bare-alias form (probe: an alias-only latest-wins read missing the tiebreaker produces zero errors). Make doc and behavior agree — widen the gate with a bare-alias alternation (probe-verified to introduce no new errors on the current tree) OR correct the docstring to record alias-form consumers as a documented evasion class. Either form is acceptable; silent doc/behavior divergence is not.
3. (P2; adversarial, validated) **Fragment extraction silently disarms the rule.** Both the gate regex and the ORDER BY scanner stop at the NUL interpolation marker, so a future DRY refactor extracting the action filter or the ORDER BY into an interpolated constant un-guards every refactored site with no diagnostic — and the tiebreaker canary pins only the pre-existing named exported fragments, so the twice-recurred drop class would be invisible to BOTH layers. `${...}` fragment composition is established house style, making this the most probable real evasion path. Invariant: extraction must not be silent. Acceptable forms (compose as needed): a distinct "unverifiable — extracted fragment" diagnostic when an action-gated literal's latest-wins region contains a NUL marker; the item-1 meta-mutation pin; a docstring warning that an extracted fragment leaves the rule's sight and must then join the exported-fragment canary.
4. (P2; adversarial, validated) **DISTINCT ON latest-wins shape evades both classifiers.** A `SELECT DISTINCT ON (account) ... ORDER BY account, block_num DESC` accreditation-state read (no LIMIT 1, no OVER) clears both region scans; DISTINCT ON appears in the docstring only in its dedup-arm exit role, and it IS the codebase's existing idiom in the votes family, so a shape-harmonizing rewrite is a plausible in-family edit. Minimum acceptable: record DISTINCT ON accreditation-state reads in the deliberately-NOT-flagged list so the gap is a documented decision; a third region shape for DISTINCT ON-classified ORDER BYs is welcome but not required.
5. (P3; adversarial, conf 75) **Document suppression discipline in the rule docstring.** The gate is literal-global while the shape check is region-local: a future multi-CTE literal pairing a compliant accred CTE with an unrelated `ORDER BY block_num DESC LIMIT 1` read (the block-watcher shape) false-trips, and a suppression placed for that false positive then masks a later REAL violation in the same literal. Prescribe: split mixed literals into separate queries rather than suppress; any suppression must name the non-accred region it covers.

Dismissed/suppressed at triage (recorded, no action): named-WINDOW (`OVER w` + `WINDOW w AS`) evasion; `FETCH FIRST 1 ROW ONLY` / wrapped-IN / `= ANY($n)` spellings; `NULLS LAST` and block-comment false-positive shapes; `timestamp DESC` fingerprint widening; the eslint.config.mjs file-organization note — all anchor-50 or below the action bar; revisit only if one materializes.

When the five items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commits. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-14, single fix commit on main)

All five hold items landed in one commit (worktree fan-out; stale base detected and rebased onto main before work; commit cherry-picked to main).

1. **Test suite added** — `backend/tests/eslint/no-accred-state-read-missing-id-tiebreaker.test.ts` (RuleTester, mirrors the sibling suites): 10 valid + 7 invalid cases pinning every fire/skip path: both real LIMIT-1 (`getAccreditationFromHaf`) and OVER/ROW_NUMBER (`getAccreditedSet`) shapes with and without the tiebreaker, `op_id`/bare-`id` keys, the genesis `MIN()` no-ORDER-BY shape, `LIMIT $N` pagination, a no-action-filter read, the `stripSqlLineComments` comment shape, and a meta-mutation pair that lints the REAL site literals with the tiebreaker stripped (converting the prior manual+reverted probe into a red test).
2. **Gate/behavior divergence resolved** — `ACCRED_STATE_FILTER_RE` widened to match the bare ranked-CTE alias form (`action` / `ar.action = 'accredit'`) alongside the quoted jsonb `'action'` key, so documented coverage equals matched coverage. The bare-alias alternation `\b(?:\w+\.)?action` excludes `transaction`/`my_action` and accepts `ar.action`. Probe-verified zero new errors on the combined `src/` tree.
3. **Fragment-extraction guard** — the scanner became `classifyLatestWinsTiebreaker` returning `'missing'`/`'extracted'`/`null`; a `${...}` interpolation marker inside a latest-wins region (OVER body or a classified `ORDER BY ... LIMIT 1` clause) now reports a distinct `extractedFragment` diagnostic instead of silently disarming. A docstring warning directs extracted clauses to the exported-fragment tiebreaker canary.
4. **DISTINCT ON gap documented** — recorded in the deliberately-NOT-flagged list as a decided gap, pinned by a valid test that fires if a future classifier change starts flagging it.
5. **Suppression discipline documented** in the rule docstring (split mixed literals rather than suppress; any suppression must name the non-accred region it covers).

`window-cte-deterministic-tiebreaker.test.ts` left untouched (already names the rule as the inline-read guard). Anchors on convention names and stable symbols; no slug/round/line/SHA introduced.

Verification (combined-tree, post-merge with worker B's notification tiebreaker + the inline polish): `npx eslint src/` 0 errors; `npx eslint src/ --report-unused-disable-directives` only the pre-existing accepted `author-supersession.ts` directive; `npm run typecheck` + `npm run lint` clean; `tests/eslint/` 64/64 green (new file 17). Mutation probes (disable OVER extracted-detection / revert gate widening / disable LIMIT-1 extracted-detection) each broke exactly one corresponding test, confirming non-vacuous coverage.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
