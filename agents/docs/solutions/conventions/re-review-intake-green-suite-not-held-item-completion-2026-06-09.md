---
title: "Green typecheck + lint + tests is not evidence held items landed: gate-blind item classes need a per-item diff audit at re-review intake"
date: "2026-06-09"
category: conventions
module: hold-cycle
problem_type: convention
component: development_workflow
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "Architect re-review intake on a held task returning to review/ after a hold-fix cycle"
  - "The implementer signal block (or a parent that merged a worker's worktree commit) justifies the items as 'validated by typecheck + lint + tests', not a per-item diff audit"
  - "A hold item is a type-derivation refactor (derive a union + Set from one as-const tuple, drop an `as <Union>` cast)"
  - "A hold item is a structured-log-field rename (no test asserts log field names)"
  - "A hold item is an add-a-test-for-X item (the absence of a test is invisible to a green run)"
  - "A hold item asks to single-source an abstraction (the type can be shared while the parsing/normalization/consume layer is not)"
related_components:
  - testing_framework
  - documentation
tags:
  - "re-review-intake"
  - "hold-cycle"
  - "architect-protocol"
  - "green-suite-insufficient"
  - "per-item-diff-audit"
  - "type-derivation"
  - "structured-logging"
  - "test-coverage-claim"
---

# Green typecheck + lint + tests is not evidence held items landed: gate-blind item classes need a per-item diff audit at re-review intake

## Context

In PEvO's multi-round hold-fix cycle, a parent agent (or worker subagent)
lands the fix commit for an architect hold block and validates it by
"`npm run typecheck` + `npm run lint` + the targeted suites pass." That
green result is then offered, in the signal block, as evidence the held
items are done.

A green gate is necessary but it is not sufficient evidence of held-item
completion. Some held-item classes are *systematically invisible* to
typecheck, lint, and a passing test run: the code compiles and the suite
stays green whether or not the item actually landed. When a re-review
trusts the green gate instead of auditing each item against the diff,
exactly those classes slip through and the task gets archived with the
item unmet.

This surfaced sharply in a security re-review of a per-op fresh-auth
gate (the name-only-route credit ops on the custody broadcast endpoint).
The fix commit passed typecheck + lint + ~180 targeted tests fully green,
and its own signal block stated it was "validated by typecheck/lint/tests,
NOT a line-by-line item audit" and flagged three items as unconfirmed.
A per-item diff audit then found four of eight held items incomplete —
and the four were precisely the gate-blind classes below. The implementer's
own "confirm against the diff" flag predicted three of the four.

## Guidance

**At re-review intake, a green typecheck + lint + test run is not
evidence the held items landed. Run an explicit per-item diff audit, and
for each item pick the verification the green gate cannot fake.** Four
recurring item classes evade the gate; each has a cheap symbol-level check.

### 1. Type-derivation refactors — the cast compiles either way

A hold item like "derive the action Set and its union type from one
`as const` tuple and remove the `as <Union>` cast" exists to make a
structural invariant hold (a future enum member cannot be added to the
runtime list without the type, or vice versa). But the code compiles
identically whether the tuple is the single source of truth or the union
is hand-written beside a `ReadonlySet<string>` and bridged by a cast.
Typecheck is green either way; the invariant the item required was never
established.

**Check:** grep for the lingering `as <Union>` cast and confirm the union
is `typeof TUPLE[number]` (and the Set is typed by the derived union), not
a separately maintained literal union. A surviving `as X` at the bridge is
the tell the item did not land.

### 2. Structured-log-field renames — no test asserts field names

A hold item like "rename the `consent_*` structured-log fields to `gated_*`
now that they carry both op families" has no test oracle: suites do not
assert structured-log field names, so the run is green whether the rename
happened or not. The divergence (one event emits `gated_action`, a sibling
event still emits `consent_action` for the same surface) is invisible to
the suite and to typecheck.

**Check:** grep the emitting site(s) for the old field prefix. If the old
prefix is still present anywhere on the renamed surface, the item is unmet —
often *more* inconsistent than before, because a new sibling event already
uses the new name.

### 3. "Add a test for X" items — absence is invisible to a green run

A hold item like "add a route test that a session-kind proof on a credit-op
broadcast returns 403 `kind_mismatch`" cannot be confirmed by a green suite:
the *absence* of a test is not a failure. A passing run is not evidence the
requested test exists — the runtime behavior may even be correct while the
regression net the item demanded is simply missing.

**Check:** grep the named test file for the asserted error code / status /
scenario string. Do not trust the green checkmark to mean the test was added.

### 4. Single-source-an-abstraction items satisfied at one layer only

A hold item like "single-source the field validator" can be satisfied at the
*type* layer (a shared discriminated-union argument) while the
*parsing / normalization / consume* layer is left divergent — e.g. one
issuance path trims and length-caps a field, another reads it raw, and the
consume path reads it raw. Everything compiles and the happy-path suite is
green; the gap is a fail-closed self-mismatch (a padded field hashes one way
at issuance and another at consume) that only a hostile or whitespace input
reaches. Sharing the type is not sharing the normalization.

**Check:** confirm *every* layer converged — type AND parsing AND
normalization AND consume — not just that the shared type exists. Grep each
field-reading site and compare its trim/cap/coercion against the canonical
one.

### The implementer's own hedge is a predictor

When a signal block names items as "ambiguous", "confirm against the diff",
or "validated by tests, not a line-by-line audit", treat those exact items
as the highest-probability slips. The hedge is the implementer telling you
which items the green gate did not cover.

## Why This Matters

A held item that compiles and keeps the suite green but did not land gets
archived as closed. The type-safety invariant a future contributor relies on
(class 1) is absent; an operator querying structured logs by the documented
field name (class 2) gets nothing or a misnomer; the regression a future
refactor would otherwise trip (class 3) is unguarded; and a fail-closed
self-mismatch (class 4) waits for the first input that reaches it. Each costs
another full hold round-trip once finally caught, and the gap lives in
deployed code between rounds.

The deeper point is about evidence. This convention is the successor to
"run the suite at intake, do not trust the completion note's coverage
claims": running the suite establishes that the claimed green state is real,
but a *real* green state is still not evidence these four item classes
landed. For held items, the green gate and the per-item diff audit answer
different questions — "does it compile and pass?" versus "did this specific
item actually happen?" — and only the second is the archive criterion.

## When to Apply

- **Architect at re-review intake**, for every held task returning to
  `review/`: do not let a green typecheck/lint/test run stand in for a
  per-item audit. Walk each held item and run its gate-blind check (grep the
  cast / the old log prefix / the asserted test scenario / each layer's
  field read).
- **When the fix was landed by a parent merging a worker's worktree commit**
  and validated only by suite state: assume none of the four classes were
  verified and audit them directly. The parent's green run says nothing about
  item completeness for these classes.
- **When drafting the hold block**, prefer wording that names the gate-blind
  check the implementer (and the next reviewer) should run — "derive both from
  one `as const` tuple so no `as <Union>` cast remains", "rename every
  `consent_*` field on the gated surface", "add a test asserting
  `kind_mismatch`" — so the completion criterion is the grep, not the green
  suite.

## Examples

A re-review of a per-op fresh-auth gate received a fix commit that passed
typecheck + lint + ~180 targeted tests. Per-item audit against the diff
(`git show <commit>:<path>` plus targeted greps) found four of eight items
unmet — one per class:

- **Class 1 (type-derivation):** the action set was still
  `ReadonlySet<string>` with a separately hand-written union and an
  `as CreditOpAction` / `as FreshAuthTargetAction` cast at the bridge — the
  `as const` derivation the item required was absent, yet typecheck was green.
  *Caught by:* grep for the cast; confirm the union is not `typeof TUPLE[number]`.
- **Class 2 (log rename):** the rejection log still emitted `consent_action`
  / `consent_root_*` and the commit had *added* a `consent_claimer` field,
  while a new sibling event already used `gated_action` — same route, two
  schemes. No test asserts log field names, so the suite was green.
  *Caught by:* grep the emitting site for `consent_`.
- **Class 3 (add-a-test):** zero occurrences of `kind_mismatch` in the
  credit-op route test file; the runtime behavior was correct but the
  regression net the item demanded did not exist. *Caught by:* grep the test
  file for the asserted code.
- **Class 4 (one-layer-shared):** the discriminated-union argument was shared,
  but the ORCID issuance path validated fields with bare
  `typeof x !== 'string' || x.length === 0` (no trim, no length cap) while the
  password issuance path trimmed and capped — a fail-closed self-mismatch on
  padded input. *Caught by:* compare each field-reading site's normalization
  against the canonical one.

A green suite plus a "validated by tests" signal block would have archived all
four as closed.

## Related

- [`completion-note-coverage-claim-run-suite-at-intake-2026-05-26.md`](./completion-note-coverage-claim-run-suite-at-intake-2026-05-26.md)
  — the predecessor: at intake, run the suite rather than trusting the
  completion note's coverage claims. This convention is the next step: even a
  *real* green suite does not evidence the four gate-blind held-item classes;
  a per-item diff audit does.
- [`hold-item-completion-structural-vs-behavioral-2026-05-12.md`](./hold-item-completion-structural-vs-behavioral-2026-05-12.md)
  — the consumer-orphan case (a typed affordance added but never consumed) is
  the behavioral-contract instance of class 4; this convention generalizes the
  "structural pass is not completion" insight to three further classes the
  green gate is blind to.
- [`worktree-fanout-orphan-detection-2026-04-29.md`](./worktree-fanout-orphan-detection-2026-04-29.md)
  — an earlier check in the same intake pipeline: is the claimed work an
  ancestor of main at all? This convention assumes the work is on main and
  asks whether each held item's content actually landed.
- [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md)
  — the intake pipeline's content-match dimension for diff scope; this
  convention is the content-match dimension for held-item classes specifically.
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md)
  — same "grep is the evidence, the claim is not" discipline, applied to
  call-site adoption rather than held-item completion.
