---
title: Test-mock carve-out clause (c) is risk-class equivalence, not literal-mirror — and the mock-target scope covers shared helpers, third-party libs, and observability surfaces
date: 2026-05-04
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Authoring a test file that mocks `getPool()`, `getAppPool()`, `getRedis()`, `getHafPool()`, or any shared pool/cache helper
  - Authoring a test file that mocks a third-party library that is non-trivial to run for real per-test (e.g., `nodemailer.createTransport`, hive-API client, IPFS client)
  - Authoring a test file that uses observability spies (e.g., `vi.spyOn(logger, 'warn')`)
  - Reviewing a test file that invokes the carve-out framework in its header — judging whether clause (c) is satisfied
  - Triaging a recurring `/ce-code-review` finding that flags "the cited companion test does not assert the same thing"
  - Identifying which mutation axis (transform-logic vs wiring) a mocked test covers and whether the complementary axis needs a real-path companion
tags:
  - test-mocks
  - carve-out
  - real-path
  - risk-class
  - mutation-axis
  - getpool
  - nodemailer
  - testing-convention
---

## Rule

Clause (c) of root `CLAUDE.md` "Running Tests" carve-out is **risk-class equivalence**, not literal-mirror. A mocked test file complies with clause (c) when there exists a real-path test elsewhere that catches the same failure mode (risk class), OR when a follow-up task is filed to add such coverage. The real-path companion does NOT need to assert the same thing as the mocked test; it only needs to exercise the integrated path with real infrastructure so a different mutation class is caught.

A common risk-class split worth naming explicitly when invoking clause (c):

- **Transform-logic axis** — does the helper compute the right output for each input shape? The mocked test usually pins this (controlled-input → expected-output cases).
- **Wiring axis** — is the helper actually called from the production code path? Catches mutations like: import reverted, branch short-circuited, helper invocation replaced with the raw pre-helper value, route never reaching the call site at all. The mocked test cannot detect wiring mutations (the mock takes the helper's place at module-resolution time, so a missing call still resolves to the mock); a real-path test against real infrastructure can.

The two axes are independent. A test corpus can be "vacuous on the transform axis" (e.g., an all-lowercase corpus when the helper is a canon-lowering transform: input = output) without being vacuous on the wiring axis. "Vacuous on the corpus" is not a license to skip the real-path companion; it only argues that the companion need not re-assert the transform. Other axis decompositions exist (e.g., structural-shape-at-helper vs behavioral-at-route — see the SMTP example below) — transform-vs-wiring is named explicitly here because it is the recurring trap: per-shape mocked coverage feels exhaustive when it really only covers one axis.

The mock-target scope covered by the carve-out is broader than the helpers literally named in the original lead-in. It covers:

- Shared pool/cache helpers — `getPool()`, `getAppPool()`, `getRedis()`, `getHafPool()`.
- Third-party libraries non-trivial to run for real per-test — nodemailer transporter, hive-API client, IPFS client.
- Observability surfaces — logger spies (e.g., `vi.spyOn(logger, 'warn')`).

Always-real surfaces (NOT carve-out-eligible, unchanged from clause (b)): `verifyHiveSignature` and other auth/permission middleware.

The strict (literal-mirror) reading was considered and **dismissed**. Future findings citing "the cited companion does not assert the same thing" should be rejected as relitigating settled convention; reviewers must ask "do the two tests cover the same risk class?" instead.

## Why

The carve-out paragraph in `CLAUDE.md` "Running Tests" was genuinely ambiguous in two dimensions, and reviewers (human and persona) kept relitigating the same finding on every audit:

1. **"the same assertion" (clause (c)):** unclear whether literal mirror (a real-path test asserts the same exact thing) or risk-class equivalence (a real-path test catches the same failure mode, even if assertion shape differs).
2. **Mock-target scope:** the lead-in only named `getPool()` / `getAppPool()`, but the carve-out framework was being applied to `getRedis()`, `getHafPool()`, third-party libs (nodemailer, hive-API, IPFS), and logger spies without doc support.

Round-2 review of `backend-auth-smtp-status-code-oracle.md` produced two findings (testing T2 conf 90, project-standards conf 45) on this exact ambiguity. The new file `backend/tests/routes/auth-smtp-transporter.test.ts` mocks `nodemailer.createTransport` (outside the literal pool-helper scope) and pins the canonical 4-timeout options shape. Its real-path companion (BE-AUTH-SMTP-STATUS-CODE-ORACLE block in `recover.test.ts`) uses real Postgres + real Redis but `mockReturnValue({sendMail: ...})` discarding the options arg. Different mutation classes; arguably-equivalent risk-class coverage; not the same assertion literally.

**Why lenient over strict:**

- Strict (literal-mirror) reading would force redundant real-path duplicates of mock-pinned shape assertions for diminishing return. The strict and mocked tests catch the same mutation class twice.
- Lenient reading matches what the codebase already does in practice. Helper-shape unit tests catch options-shape mutations at the helper. Integration tests catch behavioral mutations at the route. Together they cover the failure modes the test author claims, and each catches mutations the other misses.
- Decidability: a test author can answer "does a real-path test catch the same failure mode my mock catches?" without reinterpreting "the same assertion" against multiple plausible readings.

## When to Apply

- Authoring any new test file that invokes the carve-out framework in its header. The header must name (i) the real path that is impractical and why (clause (a)), (ii) the mock target and confirm it is in the carve-out-eligible scope above, and (iii) the real-path companion that covers the same risk class — or the follow-up task filed to add that coverage.
- Reviewing a test file in `tasks/review/` whose diff adds or extends mocked-helper / mocked-third-party / observability-spy usage. Verify clause (c) is satisfied at the risk-class level, not the literal-assertion level.
- Triaging a `/ce-code-review` finding from project-standards or testing personas that flags "carve-out clause (c) compliance" against an existing test. If the finding cites "the companion does not assert the same thing", dismiss as settled-convention relitigation. If the finding cites "no real-path test exercises this failure mode anywhere", that is a genuine clause (c) gap and should be triaged.
- Authoring a follow-up task for a missing real-path companion. The follow-up must specify the failure mode being covered, not the assertion shape — e.g., "real-path test for the 504 BROADCAST_TIMEOUT branch of `/api/orcid/callback`", not "assert the same response object that the mocked test asserts".

## How to Apply

**Test-file header template:**

```ts
/**
 * Carve-out invocation: mocking <target> here because <real path> is impractical
 * for this test (e.g., per-test seeding cost, third-party dependency boot time,
 * non-deterministic timing).
 *
 * Risk class covered by THIS file: <failure mode this test catches>
 *   (e.g., "options-shape mutations at the SMTP transporter helper")
 *
 * Real-path companion: <test file path + describe-block name> covers the
 * complementary risk class <failure mode> with real <Postgres / Redis /
 * external service>. Together the two files cover the integrated path.
 *
 * (Or, if no companion exists yet:)
 * Follow-up task filed: agents/docs/tasks/pending/<task>.md will add a
 * real-path test for <failure mode> against real <infrastructure>.
 */
```

**Reviewer checklist (during `/ce-code-review` of a test file):**

1. Does the header invoke the carve-out framework explicitly? If not — finding (clause (a) violation), regardless of clause (c).
2. Is the mock target in the carve-out-eligible scope (shared helpers / third-party libs / observability surfaces)? If not — finding (scope violation; the carve-out does not cover, e.g., `verifyHiveSignature` mocking).
3. Does a real-path test elsewhere catch the same failure mode? Or is a follow-up task filed?
   - "Same failure mode" = the same class of bugs would surface if the real path broke. The companion does NOT need to assert the same shape.
   - Identify which axis the mocked test covers (transform-logic or wiring). If it covers only the transform axis, the wiring axis must be covered by a real-path companion or filed follow-up. The recurring failure mode is a transform-axis mocked test with a "vacuous on corpus" justification used to skip the wiring-axis companion entirely.
   - If a companion exists with risk-class equivalence — clause (c) satisfied.
   - If no companion AND no follow-up task — finding (genuine clause (c) gap, file follow-up).
   - If a companion exists but asserts something different — NOT a finding. The whole point of the lenient reading is that complementary mutation classes are caught by complementary tests.

**What NOT to flag (settled, do not relitigate):**

- "The cited companion test does not assert the same thing the mocked test asserts." This is by design. Reviewers should ask "do the two tests cover the same risk class?" instead.
- "The mock target (e.g., `nodemailer.createTransport`) is not literally `getPool` / `getAppPool`, so the carve-out does not apply." The mock-target scope is broader, see Rule above.

**What TO flag (recurring implementer failure mode):**

- **"Vacuous on the corpus, so the mocked test is the load-bearing net" used to skip the real-path companion entirely.** The argument is valid for the transform axis only: if the on-chain corpus is uninformative for transform assertions, the real-path companion need not re-assert the transform. But the wiring axis (is the helper called at all? is the import still there? is the branch reached?) is independent and is not covered by the mocked test, so the companion is still required. Reviewers should request either a filed follow-up task or an inline wiring-axis assertion in the real-path companion. See the SSR-discipline-canon example below.

## Examples

**Compliant (helper-shape unit + route-behavior integration):**

`backend/tests/routes/auth-smtp-transporter.test.ts` mocks `nodemailer.createTransport` and pins the canonical 4-timeout options shape (risk class: options-shape mutations at the helper).

`backend/tests/routes/recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block uses real Postgres + real Redis, mocks only `sendMail` (risk class: behavioral SMTP-failure handling at the route — uniform 200 maintained, structured-log shape preserved).

The two tests catch different mutation classes. Together they cover the integrated SMTP path. Clause (c) is satisfied at the risk-class level even though neither test asserts what the other asserts.

**Compliant (transform-axis mocked + wiring-axis real-path companion):**

`backend/tests/routes/app-ssr-discipline-canon.test.ts` mocks `hiveClient.database.call` and pins the canon-lowering transform across 4 discipline shapes — mixed-case + whitespace-padded → canon-lowered; absent / whitespace-only / non-string → `about` omitted (risk class: transform-logic mutations at `paperDisciplineField()`).

The filed follow-up `agents/docs/tasks/pending/backend-app-ssr-real-path-companion.md` (P3) specifies a real-path SSR smoke test: pick an existing all-lowercase corpus paper, issue `GET /en/paper/:author/:permlink` against real Hive API + HAF, assert the ScholarlyArticle JSON-LD block is present with `about` matching the on-chain value (risk class: wiring mutations — import reverted, branch short-circuited, helper bypassed).

The mocked test cannot detect wiring mutations (the mock resolves the helper at module load, so a missing call site still hits the mock). The real-path companion cannot detect transform mutations on an all-lowercase corpus (input = output). Together they cover both axes. The implementer's signal block argued "vacuous on the current corpus, so the mocked spec is the load-bearing regression net" and treated that as license to skip the companion entirely — that argument is valid for the transform axis only; the wiring axis still required the companion, satisfied here via the filed-task alternative of clause (c).

**Non-compliant (genuine clause (c) gap, would require follow-up):**

A hypothetical test file that mocks `getRedis()` to pin the rate-limit-key construction shape, with no real-path test elsewhere that exercises the rate-limit path against real Redis. The mocked test catches key-shape mutations; nothing catches behavioral mutations under real Redis (e.g., TTL behavior, EVAL / EVALSHA fallback). Reviewer should request a follow-up task: "real-path test for rate-limit behavior against real Redis", not "rewrite the mocked test to also assert behavior".

**Non-compliant (scope violation, NOT a clause (c) issue):**

A test file that mocks `verifyHiveSignature` to skip signature verification. This is excluded by clause (b), not clause (c). The carve-out does not authorize this regardless of what real-path companions exist.

## Related

- Root `CLAUDE.md` "Running Tests" section — the canonical convention text. Links back to this doc.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — complementary principle. Mutation-killing is *what* a test must do; clause (c) governs *which paths* (mocked vs real) must be covered for the mutation-killing to span the integrated stack. A test that satisfies mutation-killing at the helper but has no real-path companion is a clause (c) gap; a test that has a real-path companion but does not actually kill mutations is a different failure.
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — when mocking IS used under the carve-out, the mocked call must be asserted shape-and-args, not just call-count. Composes with this doc: clause (c) governs whether the mock is allowed at all; mock-guard governs the assertion strength once it is allowed.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — domain-specific application of the risk-class principle to SMTP-failure timing. The route-level oracle (uniform 200, equalized timing) is a behavioral risk class; the helper-level options-shape pin is a structural risk class.
