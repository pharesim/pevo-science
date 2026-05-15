---
title: Docblock cross-references should anchor on stable symbols or invariants, not line numbers
date: 2026-05-15
category: conventions
module: backend/src + backend/migrations + backend/tests
problem_type: convention
component: documentation
severity: medium
applies_when:
  - Writing a JSDoc / docblock comment that references code in another file
  - Writing a SQL `COMMENT ON COLUMN` or migration header comment that cites a route/helper
  - Writing a test-file header docstring that cites a production call site (carve-out clause c real-path-companion framing)
  - Making a behavioral claim in a comment that hinges on a route-level branch
tags: [documentation, docblock, cross-references, comment-rot, drift, line-number-anchors, sql-comment, migrations]
---

# Docblock cross-references should anchor on stable symbols or invariants, not line numbers

## Context

Architect triage on 2026-05-15 surfaced this same pattern four times in one session across four different tasks. Implementers (including the architect) had written docblock / SQL-comment / test-header cross-references in the form `routes/auth.ts:153-160` or `custody.ts:282-289`, and each one rotted — either on the same commit that introduced the reference, or shortly after via an unrelated edit. The cited line ranges no longer pointed at the thing the comment claimed they pointed at.

Concrete instances from that one triage session:

- **`backend/src/lib/argon2-semaphore.ts:495-496`** cross-referenced `routes/auth.ts:153-160` for the UV_THREADPOOL_SIZE assertion. The round-1 commit that introduced this cross-reference (commit `04fddee` of `BE-P3-CLEANUP-SWEEP`) was the same commit that removed lines 153-160 (collapsed the VITEST gate into a bare block). The reference rotted in its first commit. Round-2 fix anchored on the stable symbol `SENTINEL_ARGON2_HASH_PROMISE` instead.
- **`backend/migrations/006_custody_audit_pii_annotation.sql`** SQL comments cited `settings.ts:312` (4 occurrences) for the right-to-erasure DELETE path — actual line was `:338`. Same comment cited `custody.ts:282-289` (4 occurrences) for the user_agent insert path — actual line was `:573-580` (specifically `:579`). Both were wrong at write time. Held back for symbol-anchored rewrite.
- Same migration's closing paragraph claimed "populated only on consent-op broadcasts" — true at write time, but coupled to the route-level discriminator `freshAuthMechanism === null` at `custody.ts:573`. A future change moving the assignment outside the consent branch would silently invalidate the doc claim. This is the *invariant-vs-branch-location* shape of the same lesson.
- **`backend/tests/lib/flush-and-exit.test.ts:23-25`** header docblock said the companion risk class is "exercised at the routes/auth.ts:175-193 production call site under integration tests." The cited block was deleted by commit `084d9ee` — the comment rotted on the same commit that made it stale.

## Guidance

When writing a docblock comment that references another file, anchor on something that won't shift:

- **Prefer an exported symbol name** over a line number. `SENTINEL_ARGON2_HASH_PROMISE`, `validPevoPaperWhere`, `flushAndExit`, `runWithArgon2Slot` — these survive line shifts, get caught by rename refactors, and are grep-findable.
- **When the referenced thing is unnamed** (a bare block, an anonymous catch handler, a closure body), describe its function relative to a named neighbor: "the bare-block check immediately before `SENTINEL_ARGON2_HASH_PROMISE`", "the catch handler inside `runWithArgon2Slot`", "the `.catch` of the `setInterval(cleanupExpiredTokens)` registration".
- **When citing a behavioral invariant or condition**, anchor on the *WHAT-triggers-the-behavior* form, not the *WHERE-the-branch-lives* form. "Populated only when a fresh-auth challenge has been answered" survives refactors. "Populated when `freshAuthMechanism === null` at custody.ts:573" does not.
- **File and function/symbol names** are fine. **Raw line numbers** (`:153-160`, `:282-289`, `:312`, `:175-193`) are the warning sign — they're the part that rots.

Applies in:

- JSDoc / TypeScript docblocks in `backend/src/**` and `frontend/src/**`
- SQL `COMMENT ON COLUMN` and SQL header-block comments in `backend/migrations/**`
- Test-file header docstrings, especially the carve-out clause (c) real-path-companion framing
- `agents/docs/solutions/**` convention docs that cite code surfaces

Does *not* apply to commit messages (those are time-stamped and never refactor-followed) or to task-coordination files in `agents/docs/tasks/**` (those are transient and re-grouped by the architect at archive).

## Why This Matters

Two costs accumulate when cross-references rot:

1. **Operator misdirection during a real investigation.** A CNPD inspector reading `\d+ custody_audit_log` follows the `COMMENT ON COLUMN` breadcrumb. If it points at `settings.ts:312` (`const row = rows[0]`) when the actual GDPR-right-to-erasure DELETE is at `:338`, the inspector lands on unrelated code and the comment loses its compliance-audit value. Generalizes to any time-pressed reader: a future maintainer chasing a bug, a fork maintainer trying to understand the architecture, an LLM agent reading the doc.

2. **Mechanical re-review churn.** The architect's `/ce-code-review` re-review pass on commits that rotate touched files routinely surfaces stale cross-references as findings. Each one becomes a hold-block item, a re-round, and a re-commit. The fix is mechanical (rewrite to anchor on a symbol) but the round-trip cost is real. Surfacing the same pattern four times in one triage session is what made this convention worth writing.

Line-number citations *feel* concrete when written — the author has literally located the thing. The implementer mind doesn't naturally project forward to: "what happens to this comment when an unrelated edit inserts 30 lines above the cited location?" Symbol-name anchoring is the obvious-in-retrospect fix but it's not the natural first-draft shape. This convention exists to make it the deliberate first-draft shape.

## When to Apply

- Drafting any comment that names another file's content. Default to symbol anchors.
- Reviewing a commit (especially via `/ce-code-review`) where the diff edits the cited file or its neighbors — check whether any nearby comments that reference the edited region need updating, even if the comments themselves aren't in the diff.
- Writing a SQL migration's header comment or `COMMENT ON COLUMN` string that references application code. SQL comments are especially exposed because they're read out of band (via `\d+`, via the migration file itself during `./deploy.sh migrate`) and their drift is often invisible during normal code review.
- Writing the `Insert path reference:` / `Deletion path:` operator-facing breadcrumbs in a PII-bearing migration's column comment (see `column-level PII annotation pattern` — first instance was `backend/migrations/006_custody_audit_pii_annotation.sql`).

## Examples

### SQL `COMMENT ON COLUMN` — rotted vs anchored

**Rotted (avoid):**

```sql
COMMENT ON COLUMN custody_audit_log.user_agent IS
  'PII (GDPR / CNPD). Raw HTTP User-Agent header from the consent-op fresh-auth request. '
  'Insert path: backend/src/routes/custody.ts:282-289. '
  'Deletion path on user request: backend/src/routes/settings.ts:312 (account-deletion sweep).';
```

Both line ranges in this comment were wrong at write time and would have rotted anyway on the next edit.

**Symbol-anchored / invariant-anchored (prefer):**

```sql
COMMENT ON COLUMN custody_audit_log.user_agent IS
  'PII (GDPR / CNPD). Raw HTTP User-Agent header from the consent-op fresh-auth request. '
  'Populated only when a fresh-auth challenge has been answered for the broadcast '
  '(the consent-op signing flow); other broadcasts write NULL. '
  'Erased on account deletion via the DELETE FROM custody_audit_log inside the '
  'deleteAccount transaction (routes/settings.ts).';
```

No line numbers. The "fresh-auth challenge has been answered" anchors on a WHAT-condition; the DELETE breadcrumb names the SQL statement shape and the function context.

### JSDoc cross-reference — rotted vs anchored

**Rotted (avoid):**

```ts
/**
 * Drain the argon2 in-flight queue at shutdown.
 *
 * Mirrors the `process.env.VITEST` gate at routes/auth.ts:153-160
 * for the UV_THREADPOOL_SIZE assertion.
 */
export function drainArgon2Queue(): void {
```

Rotted on the same commit that introduced it (round-1 of `BE-P3-CLEANUP-SWEEP` removed the cited line range).

**Symbol-anchored (prefer):**

```ts
/**
 * Drain the argon2 in-flight queue at shutdown.
 *
 * Mirrors the defense-in-depth UV_THREADPOOL_SIZE startup assertion at
 * routes/auth.ts (the bare-block check immediately before
 * SENTINEL_ARGON2_HASH_PROMISE).
 */
export function drainArgon2Queue(): void {
```

No line numbers. The bare-block reference uses a positional anchor against a named neighbor (the exported `SENTINEL_ARGON2_HASH_PROMISE` constant).

### Test-file header — rotted vs anchored

**Rotted (avoid):**

```ts
/**
 * The companion risk class (real flush-then-exit when the callback fires
 * normally) is exercised at the routes/auth.ts:175-193 production call
 * site under integration tests.
 */
```

The cited block was deleted by the commit that closed that exact convergence.

**Symbol-anchored (prefer):**

```ts
/**
 * Both branches of flushAndExit() are covered by the mock-based tests
 * in this file. The production call sites — the SENTINEL_ARGON2_HASH_PROMISE
 * .catch handler in routes/auth.ts and the boot-fatal handlers in index.ts —
 * delegate end-to-end behavior to this helper, so this test file is the
 * authoritative behavioral coverage.
 */
```

References the symbol name and the function role, not a line range. Survives any future migration of the call sites to other locations.

## Related

- `load-bearing-greps-at-signal-block-write-time-2026-05-06.md` — the *companion* meta-rule. Asks "did you grep-verify the claim?" This convention asks "does the claim shape survive refactors?" Together: verify the claim, then write it in a shape that stays true.
- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — adjacent meta-rule about audits-must-be-mechanical. Same family of "make claims that the toolchain can still verify next year."
- `boot-fatal-flush-watchdog-pattern-2026-05-11.md` — convention that this rule was applied to (one of the four 2026-05-15 instances was the cross-reference in this pattern's helper).
