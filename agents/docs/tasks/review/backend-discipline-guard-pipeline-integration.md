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

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` on commit `9bb8fec` (8 reviewers: correctness on Opus; testing, maintainability, project-standards, security, adversarial, kieran-typescript, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). User-triaged session 2026-05-15. Four items held — all are rule-correctness or test-coverage enhancements; architect-zone follow-ups are routed separately (no architect-blocking work in this round).

### Items held (must fix before archive)

1. **TS wrapper expressions silently bypass constant-folding** — file `backend/eslint.config.mjs` (the `resolveStringValue` recursion). The folding does strict `node.type === 'Literal'` / `node.type === 'ArrayExpression'` checks, so idiomatic-TS wrapper nodes — `TSAsExpression` (e.g., `'bridge_' as const`, `'bridge_' as string`), `TSNonNullExpression` (e.g., `'bridge_'!`), `TSTypeAssertion` — cause the recursion to bail silently. These are accidental-bypass forms, not adversarial evasion, so they fall squarely inside the rule's stated job ("catch ACCIDENTAL bypasses, not deliberate evasion"). Adversarial conf 70. Extend `resolveStringValue` to unwrap these TS-only wrapper nodes and recurse on the underlying expression — ~10 LOC addition mirroring the existing recursion shape. Update the `[TODO Architect]` convention-doc bullet to reflect the new in-scope coverage and the remaining adversarial-only evasion classes.

2. **No valid test case for `.join()` bail-out on non-resolvable array element** — file `backend/tests/eslint/no-bridge-paper-literal.test.ts`. The bail-out branch at `eslint.config.mjs:98` (`if (part === null) return null`) is in-scope by design (a `.join()` on a literal array containing a variable element should NOT fire). No valid test pins it. Add e.g.: `{ filename: abs('src/routes/papers.ts'), code: "const sep = '_'; const x = ['bridge', sep, 'paper'].join('_');" }`. Locks the contract against accidental removal of the early-return. Testing conf 75.

3. **Default `.join()` (no separator argument) is in-scope but untested** — same test file. The rule's handler defaults `sep=','` (matching JS runtime semantics), so `['bridge_paper'].join()` IS caught. No invalid test pins this default-comma behavior. Add an invalid case calling `.join()` with no separator argument on a literal array that resolves to `'bridge_paper'`. Correctness conf 100.

4. **Mixed-form constant folding untested** — same test file. The recursion is designed to handle mixed concat + template + join in any combination but the suite only exercises single-form cases. Add two invalid cases: (a) `` 'bridge_' + `paper` `` (concat + template), and (b) `'bridge_' + ['paper'].join('')` (concat + join). Correctness conf 75.

### Architect-zone follow-ups (separate landing on archive, not held by backend)

These do NOT block backend's round-3 commit — architect lands them when this task archives.

- **Stale `npm run check:bridge-paper-discipline` reference at `agents/docs/api-contracts/papers.md:5`** — corroborated correctness P2 + maintainability P1 conf 95+. Architect updates `papers.md` to reference `pevo/no-bridge-paper-literal` (inline in `backend/eslint.config.mjs`) + `npm run lint` during the same edit pass that lands the existing `[TODO Architect]` convention-doc update.
- **`src/types/**` glob coverage gap** (security SEC-001 P2 anchor 75 + adversarial corroboration) — types files are convention-only "never gate/route/filter at runtime"; future runtime-gating types file would be silently exempted. Architect adds a "Known coverage gap" section to the convention doc update at `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
- **`.concat()` omitted from documented out-of-scope evasion list** (adversarial P3 conf 65) — extend the evasion-list bullet in the same convention-doc update.
- **JSDoc/comment coverage delta vs old bash grep** (adversarial P3 conf 55) — old bash grep fired on literals inside comments/JSDoc; AST rule visits only executable nodes. Intentional behavior (runtime enforcement only), but the delta is worth documenting in the convention doc so a future reader (especially a fork maintainer) understands JSDoc drift is now a code-review concern, not a tool concern.

### Dismissed at triage (recorded for transparency)

- **`@ts-expect-error` on the `.mjs` import propagates `any` into `RuleTester.run()`** (kieran-typescript KT-01 conf 60) — theoretical failure mode; runtime RuleTester validation catches malformed rules today. Memory `feedback_dismiss_preemptive_test_hardening` analogy applies — wait until ESLint 10 or similar surfaces a real regression.

When the four held items land, `git mv` this file back to `tasks/review/` for re-review and archive.

---

## Backend re-review signal (2026-05-15, commit SHA `04a5a6b`)

All four held items landed. Summary by item:

### Item 1 — TS wrapper expressions now unwrap in `resolveStringValue`

`backend/eslint.config.mjs` — extended `resolveStringValue` with an early branch that unwraps `TSAsExpression`, `TSNonNullExpression`, and `TSTypeAssertion` and recurses on `.expression`. All three TS-AST nodes carry the wrapped child on `.expression` (verified against `@typescript-eslint/parser` ~v8.59 output for `'bridge_' as const`, `'bridge_'!`, and `<string>'bridge_'`). The unwrap runs before the existing `Literal` / `TemplateLiteral` / `BinaryExpression` / `CallExpression` branches so a wrapper at any depth composes naturally with constant-folding (e.g., `('bridge_' as const) + 'paper'` resolves through `BinaryExpression → TSAsExpression → Literal`). Header comment on `resolveStringValue` updated to enumerate the new TS-wrapper case.

### Item 2 — `.join()` bail-out on non-resolvable element pinned (valid case)

`backend/tests/eslint/no-bridge-paper-literal.test.ts` — added a valid case `const sep = '_'; const x = ['bridge', sep, 'paper'].join('_');` on a non-allowlisted filename. Pins the `if (part === null) return null` branch at the `.join()` array-element resolution site; locks the contract against accidental removal of the early-return.

### Item 3 — Default `.join()` (no separator argument) pinned (invalid case)

Same test file — added an invalid case `const x = ['bridge_paper'].join();` (singleton array, no separator argument). The resolver's `sep = ','` default matches JS runtime `[].join()` semantics; the singleton joins to `'bridge_paper'` and the rule fires. Pins the default-comma branch.

### Item 4 — Mixed-form constant folding pinned (two invalid cases)

Same test file — added two invalid cases:
- `const x = 'bridge_' + \`paper\`;` (concat + template) — exercises `BinaryExpression` recursing into `TemplateLiteral`.
- `const x = 'bridge_' + ['paper'].join('');` (concat + join) — exercises `BinaryExpression` recursing into a `CallExpression` (Array.join) whose array contains a string literal.

### Test suite delta

- Test count: 17 → 28 (+11 cases). New valid: 1 (Item 2's `.join()` array-element bail-out) + 2 (TS-wrapper sanity: unrelated literal + allowlisted-file wrapper). New invalid: 1 (Item 3 default-`.join()`) + 2 (Item 4 mixed-form) + 5 (TS-wrapper invalids: `as const`, `as string`, `!`, `<string>`, wrapper-in-concat).
- The TS-wrapper cases require `@typescript-eslint/parser` since plain `espree` doesn't parse `TSAsExpression` / `TSNonNullExpression` / `TSTypeAssertion`. A second `RuleTester` configured with `parser: tsParser` drives those cases; the existing parser-free `RuleTester` continues to drive the non-TS cases.

### Verification gates

- `npx vitest run tests/eslint/no-bridge-paper-literal.test.ts` — 28 passed.
- `cd backend && npx tsc --noEmit` — clean.
- `cd backend && npm run lint` — clean (two pre-existing `@typescript-eslint/no-explicit-any` warnings in `src/seed-phrase.ts` unrelated).
- Smoke test: temporary `backend/src/__violation_smoke__.ts` exercising all 5 TS-wrapper forms (`as const`, `as string`, `!`, `<string>`, wrapper-in-concat) — rule fires 5 times with the expected message; file deleted; clean lint re-verified.

### Updated `[TODO Architect]` coverage characterization

The convention-doc bullet above (Acceptance #5) needs one refinement when the architect lands the doc update:

- In-scope coverage now includes the TS-only wrapper forms `TSAsExpression` (`'bridge_paper' as const`, `'bridge_paper' as string`), `TSNonNullExpression` (`'bridge_paper'!`), and `TSTypeAssertion` (`<string>'bridge_paper'`) — these unwrap transparently and compose with the existing constant-folding (concat, template, join).
- Remaining out-of-scope evasion (documented as "known evasion requiring code-review attention", not lint enforcement): `.toLowerCase()`, `.slice()`, `String.fromCharCode(...)`, template-literal interpolation, non-literal `.join()` separator, and the architect-zone follow-up additions surfaced at re-review (`.concat()`, JSDoc/comment literals — code-review concern now that AST visits only executable nodes).

### Files touched in this commit

- `backend/eslint.config.mjs` — `resolveStringValue` TS-wrapper unwrap branch + header comment update.
- `backend/tests/eslint/no-bridge-paper-literal.test.ts` — 11 new cases (1 valid + 5 invalid in the parser-free suite, 2 valid + 5 invalid in the new TS-parser suite) + `@typescript-eslint/parser` import.
- `agents/docs/tasks/pending/backend-discipline-guard-pipeline-integration.md` — this signal block.

When ready, this file moves back to `tasks/review/` for the architect's re-review pass (parent serializes the `git mv`).
