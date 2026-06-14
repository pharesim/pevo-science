---
title: A static-SQL ESLint rule that scans literal query text is silently disarmed when a guarded clause is extracted into an interpolated constant
date: 2026-06-14
category: conventions
module: backend/eslint.config.mjs + backend/tests/eslint
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Writing or extending a custom ESLint rule that folds template-literal `pool.query` strings to static text and asserts a SQL-shape invariant (a required ORDER BY tiebreaker, an action filter, a floor predicate)"
  - "Reviewing a DRY refactor that lifts a SQL clause (an ORDER BY, a WHERE predicate, a column list) out of an inline query literal into a shared interpolated constant"
  - "Relying on a static-SQL lint rule as the durable guard for an invariant that is currently inline at every site"
tags:
  - eslint
  - custom-rule
  - static-sql
  - fragment-extraction
  - interpolation
  - silent-disarm
  - lint-blind-spot
related_components:
  - tooling
  - database
---

# A static-SQL ESLint rule that scans literal query text is silently disarmed when a guarded clause is extracted into an interpolated constant

## Context

PEvO has custom ESLint rules (`pevo/no-custom-id-block-num-floor`, `pevo/no-accred-state-read-missing-id-tiebreaker` in `backend/eslint.config.mjs`) that fold a template-literal `pool.query` string down to static text and assert SQL-shape invariants on it — for example, that a latest-wins `ORDER BY ... block_num DESC` carries a secondary `id`/`op_id` tiebreaker, or that an accreditation-state read filtered on `action IN ('accredit','revoke')` is not missing that tiebreaker. The rules exist precisely because these queries are inline, non-exported `pool.query` literals that the exported-fragment shape canaries cannot reach.

The blind spot: a static-SQL rule only sees what is **inline literal text**. If a future DRY refactor lifts the guarded clause — the ORDER BY, the action filter, the floor predicate — out of the inline literal and into an interpolated `${...}` constant, the rule's scanner hits the interpolation marker, stops seeing the clause, and goes **silently green** on code that no longer satisfies the invariant. The exported-fragment shape canary does not catch it either (it only pins the named fragments that already existed), so BOTH defense layers miss it. `${...}` fragment composition is established house style, which makes this the most probable real evasion path, not a hypothetical one.

## Guidance

A static-SQL lint rule's sight ends at the interpolation boundary. Extraction is its structural blind spot, and it must be made **loud**, never silent:

1. **Emit a distinct diagnostic when a guarded region contains an interpolation marker** — classify it as "extracted / unverifiable" rather than passing it. Do not let an interpolated guarded region read as compliant. The accred-state rule's resolver was changed from a boolean "missing tiebreaker?" to a three-state `classifyLatestWinsTiebreaker` returning `missing` / `extracted` / `null`, so a `${...}` inside an OVER body or a classified `ORDER BY ... LIMIT 1` clause reports a separate `extractedFragment` diagnostic.
2. **Route the extracted clause to the other layer.** A docstring on the rule must direct any clause that gets extracted into a constant to join the exported-fragment shape canary (the layer that CAN see exported fragments), so the invariant does not fall through the gap between the two defenses.
3. **Pin the rule against the REAL production literals, not only synthetic cases.** A meta-mutation RuleTester case that lints the actual production site literals (reproduced into the test) with the invariant stripped converts a manual-and-reverted probe into a standing CI signal — so a regression in the rule's own scanner/classifier is caught, not just a regression in the guarded code.

## Why This Matters

A lint rule is a guard that future code is checked against. If the guard can be disarmed by a routine, well-intentioned DRY refactor with zero diagnostic, the invariant it protects silently lapses and the next reviewer sees green. The two failure shapes compound: the inline-literal rule loses sight of the extracted clause, and the exported-fragment canary never covered the now-extracted clause, so an invariant that looked doubly-guarded becomes unguarded. The cost is exactly the drift class the rule was written to make impossible (a dropped tiebreaker, an inert floor reappearing) — invisible until it ships.

Distinct from `eslint-custom-rule-unwrap-arms-need-compound-form-canary` (which is about a rule's *test suite* vacuously failing to exercise an AST unwrap branch). This entry is about the *production rule itself* going blind to extracted clauses — a coverage gap in the rule's reach over real code, not a gap in the rule's test cases.

## When to Apply

When authoring or extending any custom ESLint rule that asserts a shape over folded SQL literal text, and when reviewing any refactor that moves a guarded SQL clause into an interpolated constant. Ask: if someone extracts the guarded clause into a `${...}` constant tomorrow, does the rule go red, or silently green? If silently green, add the extracted-fragment diagnostic and the docstring pointer to the fragment canary before relying on the rule.
