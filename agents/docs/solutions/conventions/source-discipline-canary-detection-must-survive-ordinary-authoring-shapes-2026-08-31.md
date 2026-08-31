---
title: "Source-discipline canary detection must survive the shapes an ordinary author writes — line wraps, shorthand, comment tails, split imports, helper extraction, literal values"
date: 2026-08-31
category: conventions
module: backend/tests + code-review process
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing or reviewing a standing source-scanning canary whose detection is textual (regex over lines) rather than a parse"
  - "A canary's docblock says WHAT it matches; you want to know which legal spellings of the same code it does NOT match"
  - "A pairing or registry canary keys on a call shape, a one-line literal, or a per-line veto"
  - "Probing a guard by replaying its own scan logic against mutated copies of the tree"
tags:
  - conventions
  - canary-tests
  - source-discipline
  - detection-precision
  - mutation-resistance
  - silently-disarmed-guards
---

# Source-discipline canary detection must survive the shapes an ordinary author writes

## Context

Two successive review passes probed the session-proof canaries under
`backend/tests/eslint/` by replaying their own scan logic against mutated
copies of `backend/src`, with the baseline confirmed to reproduce the expected
sets first. Both passes found the same class of hole: the canaries asserted on
the right unit (`file#symbol` occurrence keys, per the call-site-granularity
convention) and compared against the right sets, but their DETECTION missed
spellings an ordinary developer could write without any intent to evade. This
is the third rung of a ladder the two sibling entries name: collection unit
(call-site granularity), comparison shape (set-equality vs pairing), and now
detection reach. A regex that matches the idiomatic spelling of a forbidden or
required shape enforces nothing about the other legal spellings of the same
code.

## Guidance

Ask, for every textual scan, "which legal respelling of the matched code does
this pattern not see?" — and either widen the detection or pin the residual in
prose. The recurring shapes, each found live:

- **Line wraps.** A scan keyed on `key: value` on ONE line is stepped around
  by `key:` at end of line with the value on the next, and a per-line import
  veto (`name as alias`) is stepped around by the specifier and the `as` on
  different lines. Fix shape: match a bare-key signal (`kind:` at EOL, or a
  shorthand `kind,`) alongside the value-anchored form, and run vetoes against
  the JOINED statement — occurrence helpers that hand skip predicates the
  surrounding lines make this cheap. Accept that a key-anchored signal cannot
  see the value and will over-match (a wrapped construction of the OTHER
  discriminator value); over-matching is a loud red bar, which is the safe
  direction.
- **Shorthand properties.** `{ kind, username }` forwarding a local binding
  constructs the same object as `kind: 'session'` while writing no literal on
  any line. If the widened signal grows the allowlist (a validator that
  legitimately echoes a stored field), take the visible allowlist member over
  the blind spot and write down why the member is safe.
- **Comment tails on live lines.** Whole-line and block-toggled comments are
  not the only dead code: `done(); // requiredCall(x)` carries a dead call on
  a live line. On a REQUIRED-call pairing scan an over-match is what makes the
  pairing pass, so strip trailing comment content before a line may satisfy
  the demand — and accept that a naive strip truncating at a marker inside a
  string literal fails closed there (the call after it goes unread and the bar
  turns red). The same strip is deliberately WRONG on a forbidden-call scan,
  where an over-match is loud; direction decides, per scan.
- **Definition self-satisfaction.** A required-call pattern matches the
  callee's own definition line, so a demand arising INSIDE that function is
  satisfied by its own signature. Every scan needs a definition-line skip for
  its own subject, including required-call scans.
- **Helper extraction collapsing a registry.** A registry keyed on a literal
  call shape (`jwt.sign(`) collapses to one member when the call is extracted
  into a helper — an edit that reads as ordinary maintenance — after which new
  callers of the helper are invisible. Fix shape: attribute transitively to a
  fixpoint (callers of any plain-function symbol that encloses the matched
  call are members too), so extraction keeps every caller in the set and a
  new caller is a new member. A member-count floor makes deliberate shrink a
  two-edit act.
- **Value-position literals.** Requiring a field to be MENTIONED is satisfied
  by `sessionsInvalidatedAtMs: undefined`, which compiles and disables the
  guarded behavior. When the semantics are "this field must carry the real
  value", classify the value text (literal vs reference), joining wrapped
  values before classification so the new seam does not inherit the
  line-wrap hole it was built beside.

Two disciplines make the fixes trustworthy. First, every widened detection
gets planted probes exercising the EVASION shape (not a nearby one), run as
real mutations against the committed tree so the probe demonstrably fails
before the fix. Second, a fix that closes one shape must be audited against
this same list — the value-seam classifier and the joined-statement veto were
both born wrapped-line-safe only because the line-wrap lesson was applied to
them at write time.

## Why This Matters

These canaries are last-line backstops for invariants whose failure is silent
by construction: every behavioral test stays green, the guarded property is
still enforced on the idiomatic spelling, and the only thing that changed is
that one legal respelling now carries the regression invisibly. The evasions
above are not adversarial — a wrapped literal is what a formatter or a
long-name author produces, a helper extraction is routine cleanup, a trailing
comment is a debugging leftover. Detection that survives only the idiomatic
spelling converts "guarded" into "guarded until someone writes it
differently".

## When to Apply

- Any new textual scan over source, at write time — walk the list above
  against it.
- Review intake for changes to guarded modules: when a diff restyles code the
  canary watches (wraps a literal, extracts a helper, renames via import
  alias), check whether the scan still sees it.
- When probing guards: mutate the TREE and rerun the canary, not just the
  canary's own self-tests — self-tests pin regexes against single lines and
  cannot surface a gap that lives between lines or between scans.

## Examples

The worked instances live in `backend/tests/eslint/` (the session-proof mint
and revocation-epoch canaries) and the wiring canary in
`backend/tests/routes/session-proof-invalidation.test.ts`: a bare-key
discriminator signal beside the value-anchored one, a joined-statement alias
veto, a trailing-comment strip on the sweep pairing's satisfying side only, a
transitively-attributed session-JWT registry with a count floor, and a
value-seam classifier for session-accepting consume surfaces. Each carries
planted probes for its evasion shape.

## Related

- `source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`
  — the collection-unit rung; it assumes detection matches precisely and
  scopes this entry's territory out.
- `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md`
  — the comparison-shape rung; the module-scope pairing vacuity (both sides of
  a pair resolving to the module-scope label and satisfying each other) is
  documented there in full and deliberately not re-derived here.
- `static-sql-lint-rule-blind-to-extracted-fragments-2026-06-14.md` — the same
  extraction-blindness mechanism in a SQL-shape rule.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — the
  helper-body vs call-site-bypass distinction behind the registry fix.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the parent
  principle; the planted-probe discipline here is its application to scans.
- Distinct from `eslint-custom-rule-unwrap-arms-need-compound-form-canary-2026-05-16.md`:
  that entry is about a rule's own TEST SUITE missing an AST arm; this one is
  about a production scan's reach over real source.
