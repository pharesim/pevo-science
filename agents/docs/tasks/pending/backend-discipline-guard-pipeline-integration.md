# BACKEND-DISCIPLINE-GUARD-PIPELINE-INTEGRATION — AST-based discipline rule + pipeline integration

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by β `/ce-code-review` cluster B)
**Priority:** P2 (security defense-in-depth + tooling)

## Why now

β's round-3 hardened the bridge-paper discipline guard (`backend/scripts/check-bridge-paper-discipline.sh`) — extended regex to single-/double-/backtick-quoted forms, added a negative test, etc. Cluster-B `/ce-code-review` surfaced three structural issues the round-3 work CAN'T close because they're inherent to the grep-based approach:

### 1. Six runtime-equivalent bypass classes (β-Finding 2, conf 100)

The current regex catches direct literals only. Six concrete bypasses:
- (a) string concatenation: `'bridge_' + 'paper'` (currently documented as out-of-scope).
- (b) template literal interpolation: `` `${prefix}_paper` ``.
- (c) `Array.join`: `['bridge', 'paper'].join('_')`.
- (d) case-toggle: `'bridge_PAPER'.toLowerCase()`.
- (e) `.slice` from a longer literal.
- (f) `String.fromCharCode(...)`.

A grep-based guard fundamentally CAN'T catch these without a JS parser. AST-based enforcement (TypeScript compiler API or ESLint custom rule) can resolve string-typed values for at least (a)-(c).

### 2. No actual CI integration (β-Finding 3, conf 100)

The script is wired only into `npm run lint`. There is no `.github/workflows/`, no pre-commit hook, no `prepare`/`pre-commit` script. `npm test` alone never fires the guard. A developer can land non-allowlisted `'bridge_paper'` literals as long as they don't run `npm run lint` (or run it and ignore the failure).

The "CI guard" framing in script header / test file / convention doc is misleading — there is no CI.

### 3. Whole-file allowlist scope (β-Security-Whole-File + β-ADV-1)

The current allowlist is per-file (`src/lib/hafsql.ts`, `src/helpers.ts`, `src/types/hive.ts`, `src/bridge.ts`). New code added to any of these files that branches on `'bridge_paper'` without author-pinning won't be caught by the guard. The convention `enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` explicitly warns against named-file exemption lists.

Re-export indirection laundering: a new `lib/bridge-paper-constants.ts` exporting `BRIDGE_PAPER_TYPE = 'bridge_paper'` plus a one-line ALLOWLIST append silently launders the literal.

## Goal

Replace the grep-based guard with an AST-based ESLint rule + integrate into a real CI/pre-commit pipeline + replace whole-file allowlist with structural-path enforcement.

## Acceptance

### 1. ESLint custom rule `no-bridge-paper-literal`

In `backend/eslint-plugin-pevo/` (NEW directory) or directly in the existing eslint config:
- Implement a custom rule that walks the AST and flags any string-literal `'bridge_paper'` (or `"bridge_paper"`) that is NOT the value of an allowlisted symbol.
- Resolve simple constant-folding: catch `'bridge_' + 'paper'` (binary expression with two string literals), simple template literals (`` `bridge_paper` `` with no interpolation), `['bridge', 'paper'].join('_')` (array-of-literals + Array.prototype.join with a literal separator).
- Catch enum/const declarations: `enum PostType { BridgePaper = 'bridge_paper' }`, `const BRIDGE_PAPER_TYPE = 'bridge_paper'`. Allowlist these in DESIGNATED files only (the helper module, type module, and write-side bridge module).
- Allowlist by structural path: `src/lib/hafsql.ts` (the helper), `src/helpers.ts` (the JS predicate `isPevoBridgePaper`), `src/types/hive.ts` (TS type literal — types/ files NEVER perform gate/routing/filter), `src/bridge.ts` (canonical write-side construction). Convert from a hard-coded list to a glob: `src/types/**` (no gate/filter ever) + named files for the others.

The rule cannot catch runtime-only constructions (case-toggle, slice, charCode); document those as known evasion that requires code-review attention. The rule's job is to catch ACCIDENTAL bypasses, not deliberate evasion.

### 2. Pre-commit hook integration

Add `.githooks/pre-commit` that runs `npm run lint` (or `npx eslint --rule no-bridge-paper-literal` if isolated) on staged files. Activated via the same `git config core.hooksPath .githooks` pattern as the existing `commit-msg` zone audit.

Failure-mode UX: hook prints clear error + filename:line + suggested fix (use the helper) + reference to convention doc. `--no-verify` still bypasses (per CLAUDE.md the prohibition on `--no-verify` without explicit user authorization is the cultural backstop).

Test: `bash .githooks/tests/test-pre-commit.sh` (or wherever the existing commit-msg tests live) — clean tree → exit 0; staged file with literal in disallowed location → exit 1.

### 3. GitHub Actions workflow (optional, parallel)

If the project moves toward CI: add `.github/workflows/lint.yml` that runs `npm run lint` on every PR. Workflow has zero infrastructure cost beyond establishing the workflow file. PEvO has no CI today; this is a separate decision.

If GH Actions is rejected, the pre-commit hook + `npm run lint` discipline is the enforcement story; document the choice clearly.

### 4. Apply to other discipline guards

Survey existing guards in `backend/scripts/check-*-discipline.sh` (if any others exist; there may be just the bridge-paper one). For each: convert from grep to ESLint rule using the same template. Document in the convention doc.

### 5. Convention update

Update `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`:
- Strip the "CI guard" framing.
- Reference the new ESLint rule + structural-path allowlist as the enforcement story.
- Acknowledge runtime-only bypass classes as known-evasion-requiring-code-review.
- Architect-owned; backend leaves [TODO Architect] markers.

### 6. Decommission the bash script (optional)

If the ESLint rule fully subsumes `check-bridge-paper-discipline.sh`, decommission the script. Otherwise keep both as belt-and-suspenders. Implementer's call; document the decision.

## Out of scope

- A full type-system check that resolves string values from any expression. Constant-folding for the simple cases (a)-(c) is sufficient. Complex flow analysis would need a real type-checker pass.
- Generic discipline-rule framework (multiple rules, plugin packaging, etc.). Single rule for `bridge_paper`; extend the pattern when a second rule lands.
- Runtime enforcement (asserting at app startup that production code doesn't import a known-bad symbol). Lint-time is the right boundary.

## Coordination

- **β's hold-block:** β round-4 lands the regex named-groups refactor + 6-bypass-class documentation + "CI guard" → "lint check" rename. After β archives, this task replaces the rename with the actual implementation.
- **Architect must approve** the ESLint plugin location + the convention-doc landing path (architect-owned zone).
- **Pre-commit hook UX** — coordinate with the existing `commit-msg` zone-audit hook so developers don't get confused about which hook is firing on a violation.

## Source

- β `/ce-code-review` (cluster B, 2026-05-04): adversarial adv-2 + adv-4 + security findings cross-corroborated.
- `agents/docs/solutions/conventions/enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` — meta-convention this task addresses.

## Cross-references

- β round-3 commit `e521a96` — current grep-based guard implementation.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — the convention this guard enforces.
- `.githooks/commit-msg` — existing hook precedent for the pre-commit pattern.

---

## [BLOCKED by Architect] (backend startup triage 2026-05-04)

Two structural blockers prevent backend from picking this up:

1. **Cross-zone work outside `backend/`.** Acceptance #2 (pre-commit hook integration) writes `.githooks/pre-commit` and `.githooks/tests/test-pre-commit.sh`, both outside the backend zone. The repo's commit-msg zone-audit hook will reject any backend-prefixed commit that stages `.githooks/` paths. Backend agent boundaries (`agents/backend/CLAUDE.md` "Boundaries") explicitly forbid modifying files outside `backend/`. The hook + test-harness pieces need to land via the architect (or a separate cross-cutting commit with `[skip-zone-audit]` authorization from the user).
2. **ESLint plugin location decision.** Acceptance #1 says "in `backend/eslint-plugin-pevo/` (NEW directory) or directly in the existing eslint config" and #4's coordination block says "Architect must approve the ESLint plugin location + the convention-doc landing path." Backend cannot ship a new `eslint-plugin-pevo/` package without architect sign-off on whether it's a sub-package, whether to keep it inline in `eslint.config.mjs`, or whether to defer the plugin packaging entirely.

What backend needs from architect to unblock:
- (a) Decision on ESLint rule packaging — inline in `backend/eslint.config.mjs` (simplest, recommended for single-rule scope) vs `backend/eslint-plugin-pevo/` directory.
- (b) Decision on whether `.githooks/pre-commit` lands at all, and if so whether backend ships it under `[skip-zone-audit]` or it lands as architect-zone work.
- (c) Decision on optional GH Actions workflow (`.github/workflows/lint.yml`) — repo-wide infra, not backend-zone.

Once (a)–(c) are settled, backend can implement the ESLint rule + tests within its zone; the hook + workflow pieces need their own implementing agent / authorization path.

---

## Architect decision (2026-05-04) — UNBLOCKED, returning to `pending/`

**(a) ESLint rule packaging = inline in `backend/eslint.config.mjs`.**

Single rule today (`no-bridge-paper-literal`). A new `backend/eslint-plugin-pevo/` sub-package adds `package.json`, name/version concerns, and publication-pathway questions for one rule. Refactor to a plugin only if a second rule lands.

**(b) `.githooks/pre-commit` = YES, lands as architect-zone work in a separate commit.**

Clean cross-zone split — no `[skip-zone-audit]` needed:
- **Backend** ships the ESLint rule + tests in `backend/` (this task's primary work).
- **Architect** then ships `.githooks/pre-commit`, `.githooks/tests/test-pre-commit.sh`, and the `commit-msg` `allowed_for_agent()` update for the new hook in a separate architect-owned task created after backend's ESLint rule lands.

Hook implementation: runs `cd backend && npm run lint` (or staged-file-only equivalent for speed). Bypass = `--no-verify` only with explicit per-invocation user authorization (existing prohibition).

Sequencing: hook is a no-op without the rule, so either order is safe; backend lands the substantive work first.

**(c) GH Actions `lint.yml` = DEFER.**

PEvO has no CI today. Enforcement story = pre-commit hook + `npm run lint` + architect's `/ce-code-review`. Document the deferral explicitly in the convention doc. Re-evaluate if/when CI becomes the primary gate.

**Acceptance updates:**
- Drop Acceptance #3 (GH Actions) — file separately if it ever happens.
- Drop Acceptance #4 (other discipline guards) — only one exists today; extend the pattern when a second one is needed.
- Acceptance #5 (convention update): backend leaves `[TODO Architect]` markers; architect lands the convention-doc edits on review pass.
- Acceptance #6 (decommission `check-bridge-paper-discipline.sh`): YES, decommission once the ESLint rule lands. Belt-and-suspenders here would just be drift surface.

**Follow-up architect-owned task** (created after backend's ESLint rule lands and is reviewed):
`architect-discipline-guard-precommit-hook.md` — covers `.githooks/pre-commit`, its test, and the zone-audit map update.

This task returns to `tasks/pending/` for backend pickup.

---

## Backend re-review signal (2026-05-04, working tree)

ESLint custom rule `pevo/no-bridge-paper-literal` lands inline in `backend/eslint.config.mjs` per the architect's 2026-05-04 unblock decision (a). The grep-based bash guard is decommissioned.

### Rule shape

- Defined inline in `backend/eslint.config.mjs` as the `pevo` plugin (no separate `eslint-plugin-pevo/` sub-package — single rule today; revisit when a second discipline rule lands).
- Allowlist (structural-path):
  - **Glob:** `src/types/**` (every file under the directory — types modules never gate/route/filter at runtime; per architect note in (a)).
  - **Named files:** `src/hafsql.ts`, `src/helpers.ts`, `src/bridge.ts` (the SQL helper, the JS predicate, the write-side bridge construction). Note: the architect's brief said `src/lib/hafsql.ts`, but the actual file is `src/hafsql.ts` — the bash script's allowlist agrees, so I used the actual path. [TODO Architect] confirm.
  - Allowlist matches via `path.relative(configDir, absoluteFilePath)` normalized to POSIX separators; RuleTester drives `filename` for fixtures.
- Constant-folding coverage (the three forms scoped in by the architect):
  - **(a)** `BinaryExpression` with `+` operator, recursive on both sides — catches `'bridge_' + 'paper'`, `('bri' + 'dge_') + 'paper'`, etc.
  - **(b)** `TemplateLiteral` with `expressions.length === 0` — catches `` `bridge_paper` ``. Templates with interpolation (`` `${prefix}paper` ``) deliberately NOT folded; documented as known evasion.
  - **(c)** `CallExpression` where callee is `<ArrayExpression>.join(<StringLiteral>)` and every array element resolves recursively — catches `['bridge', 'paper'].join('_')`. Bails if separator is non-literal or array has a non-resolvable element.
- Reports at the OUTERMOST resolvable node and marks descendants in a `WeakSet` to suppress double-reports on the inner Literal under a folded BinaryExpression.
- Out-of-scope (silent by design, must stay silent — verified in valid-test cases): `.toLowerCase()`, `.slice()`, `String.fromCharCode(...)`, template-literal interpolation, non-literal `.join()` separator. These are runtime-only; lint cannot catch them and the rule's job is accidental drift, not adversarial evasion.

### Tested

- New test file: `backend/tests/eslint/no-bridge-paper-literal.test.ts`. Imports the rule via the named `noBridgePaperLiteralRule` export from `eslint.config.mjs` and drives ESLint's `RuleTester` directly. Covers:
  - 11 valid cases: 3 named-file allowlist hits, 2 src/types/ glob hits, 1 unrelated-literal sanity, 3 runtime-only-bypass non-flags, 1 interpolated-template non-flag, 1 non-literal-`.join`-sep non-flag.
  - 6 invalid cases: single-quoted, double-quoted, concat, no-interp template, literal-array `.join`, nested-concat (recursion path).
  - All 17 cases pass (`npx vitest run tests/eslint/no-bridge-paper-literal.test.ts` — 17 passed).
- `npm run lint` against the live `src/` tree: clean. Existing `'bridge_paper'` literals (in `src/hafsql.ts`, `src/helpers.ts`, `src/types/hive.ts`, `src/bridge.ts`) all sit in allowlisted paths so the rule is silent there. The two pre-existing `@typescript-eslint/no-explicit-any` warnings in `src/seed-phrase.ts` are unrelated.
- Smoke-test on a temporary `src/__violation_smoke__.ts` with all 4 violation forms (direct, concat, template, join): rule fires exactly 4 times with the expected error message. File removed after verification.
- `npx tsc --noEmit` from `backend/`: clean. No type regressions.

### Decommission

- `git rm backend/scripts/check-bridge-paper-discipline.sh` (the regex bash guard).
- `git rm backend/tests/scripts/check-bridge-paper-discipline.test.ts` (the negative-coverage harness for the bash guard — superseded by `tests/eslint/no-bridge-paper-literal.test.ts`).
- `backend/package.json`: removed the `check:bridge-paper-discipline` npm script and the `&& npm run check:bridge-paper-discipline` tail on the `lint` script. `lint` is now plain `eslint src/`.
- Updated stale `check:bridge-paper-discipline` / `scripts/check-bridge-paper-discipline.sh` references in `backend/src/hafsql.ts` (JSDoc on `validPevoPaperWhere`) and `backend/tests/hafsql.test.ts` (header comment) to point at the new ESLint rule + `npm run lint`.

### `[TODO Architect]` markers

- **Acceptance #5 — convention-doc update at `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`** (architect-owned zone, untouched by this commit): strip the "CI guard" / `check-bridge-paper-discipline.sh` framing; reference `pevo/no-bridge-paper-literal` (inline in `backend/eslint.config.mjs`) + the structural-path allowlist (`src/types/**` glob + named `src/hafsql.ts`, `src/helpers.ts`, `src/bridge.ts`) as the enforcement story; acknowledge the runtime-only bypass classes (`.toLowerCase()`, `.slice()`, `String.fromCharCode(...)`, interpolated templates, non-literal join separator) as known evasion that requires code-review attention; document the GH Actions / CI deferral per architect decision (c).
- **Acceptance #2 — follow-up architect-owned task at `agents/docs/tasks/pending/architect-discipline-guard-precommit-hook.md`**: covers `.githooks/pre-commit`, its test under `.githooks/tests/test-pre-commit.sh`, and the `commit-msg` `allowed_for_agent()` zone-map update for the new hook. Sequencing per architect decision (b): the ESLint rule lands first (this commit), the hook lands separately and is a no-op without the rule.
- **Allowlist path confirmation:** verify `src/hafsql.ts` (the actual file path) vs `src/lib/hafsql.ts` (the brief's path) — the rule uses `src/hafsql.ts` to match the existing bash-guard allowlist and the actual file location. If the architect intended a future `src/lib/hafsql.ts`, the allowlist needs updating in tandem with the file move.
