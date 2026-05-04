# ARCH-TEST-CARVE-OUT-CLAUSE-C-CLARIFY — disambiguate CLAUDE.md "Running Tests" carve-out clause (c)

**Owner:** architect
**Created:** 2026-05-04 (filed during round-2 review of `backend-auth-smtp-status-code-oracle.md`)
**Priority:** Low

## Context

Root `CLAUDE.md` "Running Tests" section permits mocking `getPool()` / `getAppPool()` helpers under three clauses:

> (a) the test file header documents the justification explicitly (which real path is impractical and why),
> (b) `verifyHiveSignature` and other middleware are NOT mocked,
> (c) **a real-HAF variant of the same assertion exists or is filed as a follow-up.**

Clause (c) is genuinely ambiguous in two dimensions:

### Ambiguity 1: "the same assertion"

Does this mean:
- **Literal mirror** — there exists a test elsewhere that asserts the *same exact thing* the mocked test asserts, but using a real path (real HAF, real Postgres, real Redis, real external services)?
- **Risk-class equivalence** — there exists a test elsewhere that covers the *same failure mode* (the same class of bugs would be caught), even if the assertion shape is different?

The round-2 review of `backend-auth-smtp-status-code-oracle.md` surfaced this directly. The new file `backend/tests/routes/auth-smtp-transporter.test.ts` mocks `nodemailer.createTransport` (mock target outside the literal pool-helper scope, but the test header invokes the carve-out framework) and pins the canonical 4-timeout options shape. Its cited companion is the BE-AUTH-SMTP-STATUS-CODE-ORACLE block in `recover.test.ts`, which uses real Postgres + real Redis but `mockReturnValue({sendMail: ...})` — discarding the options arg. The companion catches mutations of the route's behavior under SMTP failure (uniform 200 maintained, structured-log shape preserved); the helper unit catches mutations of the helper's options-shape (timeout knob drops). Different mutation classes; arguably-equivalent risk-class coverage; not the same assertion literally.

### Ambiguity 2: mock target scope

The carve-out's named target is "the `getPool()` / `getAppPool()` helpers". Does the same framework extend to:
- Other shared test surface (e.g., `getRedis()`, `getHafPool()`)?
- Third-party libraries that are non-trivial to run for real (e.g., `nodemailer.createTransport`, hive-API clients, IPFS clients)?
- Logger/observability mocks (e.g., `vi.spyOn(logger, 'warn')`)?

The current convention text only names pool helpers. Project-standards review of round-2 (conf 45) flagged this as an unresolved gap. In practice, recent test files in the codebase have stretched the carve-out framework to cover several of the categories above without a doc update.

## Why this matters

- Future test authors hit the same ambiguity and either over-police literal compliance (rewriting tests to mirror assertions in real-path companions, often with diminishing return) or under-police it (citing the carve-out for any mock without verifying clause (c)).
- Code reviewers (human and persona) repeatedly flag the same compliance gap on every audit, generating churn in finding triage. Round-2 of `backend-auth-smtp-status-code-oracle.md` had two findings (testing T2 conf 90, project-standards conf 45) on this exact ambiguity.
- The fix is doc-only: settle the intent and document it.

## Goal

Update `CLAUDE.md` "Running Tests" clause (c) so future test authors can decide unambiguously whether their mocked test file complies. Settle both ambiguities (assertion-shape and mock-target-scope).

## Approach

1. **Decide the intent.** Two reasonable framings:
   - **Strict:** clause (c) means literal mirror — a real-path test asserts the same outcome. Mocked tests for shape/structure must be paired with real-path tests for behavior. Mock target scope is broad (any external dependency that's impractical for real-path coverage).
   - **Lenient (risk-class):** clause (c) means functional equivalence at the failure-mode level. The mocked test catches one mutation class; the real-path companion catches another; together they cover the failure modes the test author claimed. Mock target scope is broad. The "same assertion" wording becomes "covering the same risk class".

   Lean: lenient (risk-class). It matches what the codebase already does in practice and avoids the "two redundant tests for the same assertion" cost. The strict reading produces a lot of low-value churn (writing real-path duplicates of mock-pinned shape assertions) without catching additional bugs.

2. **Rewrite the clause text** in `CLAUDE.md` "Running Tests" section. Replace clause (c) with concrete, decidable wording. Sketch:

   > (c) **the same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add such coverage.** Risk class = the failure mode the assertion exists to catch (e.g., "options-shape mutations at the helper", "behavioral SMTP-failure handling at the route"). The real-path test does NOT need to assert the same thing as the mocked test; it needs to ensure the integrated path is exercised somewhere with real infrastructure. Mock target scope: covers `getPool()` / `getAppPool()` / `getRedis()` / `getHafPool()` shared helpers, third-party libraries that are non-trivial to run for real (nodemailer, hive-API, IPFS), and observability surfaces (logger spies). Does NOT cover `verifyHiveSignature` and other middleware (per clause (b)) — those must always run real.

3. **Document the rationale once** in `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` (via `/ce-compound`). The convention doc captures the decision and the dismissed strict reading so future reviewers don't relitigate.

4. **Apply retroactively to round-2's resolution.** The accompanying `backend-smtp-transporter-helper-promote-and-migrate.md` task already includes a header rewrite for `auth-smtp-transporter.test.ts` invoking the risk-class framing. Once this task lands, that header rewrite simply matches the updated convention.

## Non-goals

- Reviewing every existing test file for retroactive compliance with the clarified clause (c). The codebase will converge naturally as files are touched; flagging existing files for compliance-only edits is churn.
- Rewriting clauses (a) or (b) — both are unambiguous as written.
- Adding new mock-allowed surface beyond what the codebase already uses in practice.

## Acceptance

- `CLAUDE.md` "Running Tests" section's clause (c) reads decidably: a test author can apply it to their own mock without having to interpret "the same assertion".
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` exists, captures the decision, and links from the convention text.
- `backend/tests/routes/auth-smtp-transporter.test.ts` header (rewritten by `backend-smtp-transporter-helper-promote-and-migrate.md`) is consistent with the new clause (c) text. If the helper-promote-and-migrate task ships first, the header simply gets a follow-up touch-up commit; if this clarification ships first, the helper-promote-and-migrate task naturally aligns.

## Cross-references

- `CLAUDE.md` "Running Tests" section.
- Sibling task: `backend-smtp-transporter-helper-promote-and-migrate.md` (header rewrite per Finding 7, depends on this clarification's framing).
- Surfaced by: round-2 review of `backend-auth-smtp-status-code-oracle.md` (testing T2 conf 90; project-standards residual conf 45).
