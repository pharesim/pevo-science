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
