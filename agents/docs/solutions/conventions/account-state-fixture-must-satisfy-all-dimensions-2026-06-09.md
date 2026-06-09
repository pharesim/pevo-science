---
title: "Account-state test fixtures must satisfy every §6.1 dimension, not just the one the assertion reads"
date: 2026-06-09
category: docs/solutions/conventions
module: account-state-machine
problem_type: convention
component: testing_framework
related_components:
  - authentication
  - database
severity: medium
applies_when:
  - "writing or reviewing a test fixture that INSERTs a row into the accounts table"
  - "a fixture comment claims a named §6.1 state (A, B, C, D, no-row, E/F)"
  - "un-fixme-ing a test that was green while its real-backend path was network-stubbed"
  - "reusing an existing account fixture in a test that hits a different route"
  - "running the Account-state defense review on test code, not just production code"
tags:
  - account-state
  - test-fixture
  - state-machine
  - orcid
  - fixture-fidelity
  - partial-discriminator
  - test-fixme
---

# Account-state test fixtures must satisfy every §6.1 dimension, not just the one the assertion reads

## Context

The `accounts` row has six dimensions that together fix which `ARCHITECTURE.md` §6.1 state it occupies: `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`. The root `CLAUDE.md` "Account-state defense review" rule targets *production* code that defends or branches on these combinations. The same six-dimension discipline applies to *test fixtures that seed a row claiming to be a specific state* — and that case is easy to miss, because a fixture can be wrong and still pass green.

Concretely: a `seedStateCAccount()` helper in `settings-orcid-factor.spec.js` labeled its row "State C (passwordless, ORCID-only)" but its INSERT omitted the `orcid` column. `accounts.orcid` is nullable with no default, so the seeded tuple was `(verify_token NULL, username SET, password_hash NULL, orcid NULL, custody 'light', upgraded_at NULL)` — which matches **no** §6.1 state. §6.1 State C requires `orcid SET`; a row with both `password_hash NULL` and `orcid NULL` has no registered re-auth factor at all, which §6.5 invariants #2 and #5 declare unreachable.

The spec passed green anyway, because the only real backend interaction the live tests exercised — `GET /api/settings/email` — derives `hasPassword` from `password_hash` alone and never reads `orcid`. With `password_hash` correctly NULL, the "Set a password" section rendered and every assertion held. The infidelity was invisible, concealed by the **partial-dimension discriminator** the green path happened to use.

## Guidance

**When writing or reviewing a test that seeds an `accounts` row, cross-check the full §6.1 six-dimension tuple against the state the comment claims — even when the test is green. Green via a partial-dimension discriminator is not evidence the seeded state is reachable.**

Checklist before committing an account fixture:

1. Name the target state in the comment (e.g. "State C per §6.1").
2. Look the state up in the §6.1 table and confirm the expected value of every column: `verify_token`, `username`, `password_hash`, `orcid`, `custody`, `upgraded_at`.
3. Confirm the INSERT sets (or deliberately NULLs) each of those dimensions. If a column is omitted, confirm the schema default yields the right value — `accounts.orcid` has no default, so omitting it yields NULL, which is correct for State A/D but wrong for B/C.
4. A non-null `orcid` must be per-run-unique: `accounts` carries a UNIQUE index on `orcid` (migration `007_accounts_orcid_unique`). Mirror the fixture's existing per-run uniqueness (the same `RUN_SUFFIX` it already uses to keep `email`/`username` collision-free across retries).
5. If a real-path companion is deferred via `test.fixme`, read the fixme body and trace which `accounts` columns the enabled backend path will evaluate. Seed those correctly now, not when the fixme is un-fixed.

Before (off-§6.1 — `orcid` omitted, yields NULL):

```sql
INSERT INTO accounts (email, username, password_hash, full_name, institution, field, custody, verify_token)
VALUES ($1, $2, NULL, $3, 'Test Institution', 'Test Science', 'light', NULL)
ON CONFLICT (email) DO UPDATE SET ... ;   -- no orcid set anywhere
```

After (genuine State C — `orcid SET`):

```sql
INSERT INTO accounts (email, username, password_hash, orcid, full_name, institution, field, custody, verify_token)
VALUES ($1, $2, NULL, $3, $4, 'Test Institution', 'Test Science', 'light', NULL)
ON CONFLICT (email) DO UPDATE SET orcid = EXCLUDED.orcid, ... ;
```

## Why This Matters

The failure is latent, not immediate. A fixture seeding the wrong state passes the whole suite green as long as the live interactions only read the dimensions it happened to set right. The defect surfaces only when a new test — or an un-fixed `test.fixme` — exercises a route that reads a dimension the original tests ignored.

Here that route is `POST /api/settings/set-password`, which checks eligibility *before* the fresh-auth proof gate: if `orcid` is NULL it returns `403 ORCID_REQUIRED` and never reaches proof verification. The deferred real-backend `test.fixme` exists precisely to verify the ORCID-minted proof round-trip — but reusing the `orcid NULL` seed would 403 on eligibility and never exercise that proof at all. The seed would have to be fixed before the fixme could do its job, and the failure ("requires a linked ORCID account") would read as confusing to anyone who saw "State C (orcid SET)" in the seed comment but missed that the INSERT omitted the column.

More broadly: §6.5 invariants #2 and #5 hold that every reachable row has at least one registered re-auth factor and that code defending off-§6.1 combinations is dead code. A fixture that seeds an off-§6.1 row is not testing the production invariants — it is testing an unreachable state, and routes written against the real invariants behave differently on it than on a genuinely reachable row.

## When to Apply

- Writing a new `seedXxxAccount()` (or equivalent) that INSERTs into `accounts`.
- Reviewing any test that claims to seed a named account state.
- Reusing an existing account fixture in a test that hits a *different* route than the fixture was written for — re-verify the full tuple against what the new route reads.
- Un-fixme-ing a deferred test: before removing the skip, trace every `accounts` column the enabled path evaluates and confirm the seed covers them. This is especially important for `test.fixme` entries blocked on infrastructure, where the fidelity gap can sit undetected until the blocker is resolved.

## Examples

**Partial-dimension discriminator (why it stayed green):** `GET /api/settings/email` returns `hasPassword: row.password_hash !== null` and never reads `orcid`. A `(password_hash NULL, orcid NULL)` row returns `hasPassword: false` — indistinguishable, from this endpoint, from a genuine State C row. The SPA renders "Set a password", the ORCID-start request fires, the proof caches, all assertions pass. The `orcid NULL` defect is invisible until a route that reads `orcid` runs for real.

**The 403 trap (where it bites):** `POST /api/settings/set-password` evaluates `password_hash` (→ 409 if already set), then `orcid` (→ **403 `ORCID_REQUIRED`** if NULL), then consumes the `fresh_auth_proof`. An `orcid NULL` fixture stops at step 2 and never reaches proof verification — the exact behavior the deferred real-backend test was written to exercise.

This is the test-fixture analog of the production "Account-state defense review": don't construct a stand-in (here a seeded DB row) from only what the green assertion needs — construct it from the authoritative §6.1 enumeration.

## Related

- [[test-fabricated-error-shape-masks-dead-branch-2026-06-09]] — same family, different substrate: a test stand-in (there an in-memory error object, here a seeded DB row) misrepresents a shape the real path depends on; the infidelity is invisible until the real path runs. Candidate for consolidation review.
- [[test-mock-carve-out-clause-c-2026-05-04]] — the deferred `test.fixme` backed by a real-backend companion is a clause-(c) carve-out; a fixture feeding that companion must itself satisfy §6.1 completeness or the companion exercises an unreachable state.
- [[wire-contract-shape-pinned-on-backend-not-stub-2026-05-16]] — broader family: a stub/seed pins a shape that diverges from the real system, so assertions pass on the stand-in's reality, not production's.
- [[accredited-orcid-is-optional-not-edge-case-2026-05-16]] — the omitted field (`orcid`) is commonly-null-by-design; a fixture with no ORCID is seeding a normal account, which is exactly why a missing-orcid State-C seed looks plausible.
- [[hold-block-shape-coverage-must-walk-full-lattice-2026-05-14]] — sibling principle: incomplete enumeration of a multi-axis shape space leaves a gap that passes green; this is the fixture-seeding analog over the §6.1 state tuple.
