---
title: Negative/security tests must assert the discriminating error message when the error code is shared across guards
date: 2026-06-09
category: conventions
module: backend/src/routes (sendError envelope) + frontend/tests/e2e
problem_type: convention
component: testing_framework
related_components:
  - authentication
  - documentation
severity: medium
applies_when:
  - Writing or reviewing a negative/security test whose stated purpose is to prove a specific guard or invariant fired
  - "The expected (status, code) is emitted by more than one guard reachable through the same route handler (e.g. 403 FORBIDDEN, 400 BAD_REQUEST)"
  - Testing the §6.1 account-state machine or the §6.5 fresh-auth invariants, where multiple rejection paths share one code
  - "Reviewing a test whose assertion is (status, code)-only on an endpoint with overlapping guards"
tags:
  - negative-testing
  - security-test
  - error-envelope
  - senderror
  - false-pass
  - assertion-strength
  - orcid
  - account-state
---

# Negative/security tests must assert the discriminating error message when the error code is shared across guards

## Context

PEvO's HTTP error helper `sendError(res, status, code, message)` is intentionally coarse at the `code` field. `code` encodes the HTTP-level rejection category (`FORBIDDEN`, `BAD_REQUEST`, `UNAUTHORIZED`) for SPA routing, not the specific application-level cause. As a result the same `(status, code)` pair is emitted by many semantically distinct guards: `FORBIDDEN` alone has dozens of call sites across `backend/src/routes/` (32 at the time of writing) covering state-hijack defense, registered-factor equality, custody checks, accreditation gates, authorship authorization, and admin-only guards. Within a single endpoint the situation repeats — the `/api/orcid/callback` handler emits `403 FORBIDDEN` from three independent guards.

Two of those guards sit on the fresh-auth path and matter for this convention:

1. **Caller-mismatch guard** (top-level `/callback`, the `AUTHENTICATED_MODES` branch, which includes `fresh_auth`): fires when `callerUsername !== storedUsername` (the `/start` initiator). Message: `Callback caller does not match initiator`.
2. **Registered-factor equality guard** (`handleFreshAuth`, and its sibling `handleSessionAuth`): fires when `accountOrcid !== orcidId`. Message: `The ORCID you authenticated with is not linked to this account.` This is the §6.5 invariant #2 path — the security property that an OAuth round-trip for a foreign ORCID the caller controls cannot mint a fresh-auth proof.

The negative-path E2E test in `settings-orcid-factor.spec.js` (the registered-factor mismatch describe) seeds `accounts.orcid = A`, drives the OAuth round-trip with a mismatching `code = B`, and asserts `status === 403` plus `error.code === 'FORBIDDEN'` (plus no proof cached, `password_hash` stays NULL). The construction is correct against current code: caller and initiator are the same seeded user, so the caller-mismatch guard does not fire, the flow reaches `handleFreshAuth`, and the equality guard fires. The test observes the right 403 today.

The problem is what the assertion *proves*. `(status: 403, code: 'FORBIDDEN')` is satisfied by **either** guard. A future regression that caused the caller-mismatch guard to fire in place of the equality check — an auth-middleware change that cleared the caller identity on a state-lookup race, a guard reordering, a change to caller-identity propagation — would keep the test green with a 403 while the registered-factor guard (invariant #2) went entirely unexercised. The test's stated purpose would be silently unverified.

This class of false-pass survived multiple review cycles because the construction looks correct from outside: the account is seeded right, the mismatch iD is valid ORCID format, and the flow routes deterministically through the intended guard under current code. It took three independent `/ce-code-review` reviewers (correctness, adversarial, testing) converging on it — because catching it requires simultaneously holding the guard ordering in `handleFreshAuth`, the shared `FORBIDDEN` code across the `AUTHENTICATED_MODES` dispatch, and the question "what does this assertion actually prove", none of which is visible from the test file alone.

## Guidance

**R1 — A negative or security test whose stated purpose is to prove a specific guard fired must assert the discriminating `message`, not just `(status, code)`.** When a test is described as proving a named invariant (e.g. "§6.5 invariant #2: registered-factor equality"), tighten the assertion until only a response from that exact guard satisfies it. For a `sendError` envelope the `message` string is the discriminator, because `code` is reused across guards.

**R2 — Anchor the asserted message on the literal text at the guard site, not on a line number or task slug.** Assert the exact string from the `sendError` call (e.g. `The ORCID you authenticated with is not linked to this account.`). The message string is itself the stable anchor — it lives in a named handler (`handleFreshAuth`) and changes only when the guard's semantics change, at which point the test *should* break so the change is intentional. Per the repo's comment-anchor conventions, do not annotate the assertion with `orcid.ts:<N>` or a task slug.

**R3 — `(status, code)`-only assertions stay valid when no other reachable guard shares the envelope.** The discriminator test is: *does any other guard on any code path the test input can reach through this handler emit the same `(status, code)`?* If no, `(status, code)` is sufficient and a message assertion would only add brittleness. If yes, the message assertion is mandatory for the test to mean what it claims. To check: grep `sendError(` in the handler under test and list the call sites sharing that `status`+`code`.

## Why This Matters

A security-invariant test that silently stops proving its invariant is worse than no test: it manufactures false confidence. The suite stays green, the review records the invariant as covered, and the property can be quietly violated by a refactor that never touches the test file. The registered-factor equality check is load-bearing — it stops an authenticated user from minting a fresh-auth proof by completing an OAuth round-trip with a foreign ORCID. A bare `403 FORBIDDEN` assertion does not prove that check ran.

The structural root is that `code` is coarse *by design*. With dozens of `FORBIDDEN` call sites route-wide, `expect(code).toBe('FORBIDDEN')` asserts "some guard rejected this", not "the guard I care about rejected this". For correctness tests on non-security endpoints that is often fine. For a test that names a security invariant as its purpose, it is not.

**This class of finding is NOT preemptive test hardening, and must not be dismissed as such.** (auto memory [claude]) PEvO's standing guidance to default-dismiss test-quality findings whose failure modes are theoretical-only — rare flakes, hardening against mutation classes with no current evidence — applies when the existing assertion *already* proves what the test claims and an extra assertion would only catch a hypothetical. That is not this. The mismatch test claims to prove §6.5 invariant #2; without the message assertion that claim is unverified **under current code**, not in a future hypothetical. The gap is an existing assertion-validity defect in a currently-authored security test, so the dismiss-preemptive-hardening rule does not reach it.

## When to Apply

Apply when writing or reviewing a negative/security test where all of these hold:

- The test targets a specific named guard, invariant, or security property at a known call site in `backend/src/routes/`.
- The expected `(status, code)` is also emitted by at least one other guard on any code path the test input can reach through the same handler.
- The test's stated purpose would be unverified if that other guard fired instead.

Concretely: any negative-path test against the §6.1 account-state machine, the §6.5 fresh-auth invariants (`fresh_auth` / `session_auth` modes), or any endpoint whose dispatch contains multiple branches that can return the same `(status, code)`. The cheap mechanical check is the `sendError(` grep described in R3.

## Examples

### Bad — asserts only `(status, code)`; does not prove which guard fired

```js
expect(cbResp.status()).toBe(403);
const cbBody = await cbResp.json();
expect(cbBody?.error?.code).toBe('FORBIDDEN');
```

This passes whether the caller-mismatch guard fired (`Callback caller does not match initiator`) or the registered-factor equality guard fired (`The ORCID you authenticated with is not linked to this account.`). For a test whose purpose is proving §6.5 invariant #2, it does not prove that purpose.

### Good — adds the discriminating message assertion

```js
expect(cbResp.status()).toBe(403);
const cbBody = await cbResp.json();
expect(cbBody?.error?.code).toBe('FORBIDDEN');
expect(cbBody?.error?.message).toBe(
  'The ORCID you authenticated with is not linked to this account.',
);
```

Now any refactor that runs a different guard in place of the equality check in `handleFreshAuth` falsifies the test. The message text is the exact string from that `sendError` call — anchored on the handler and the guard semantics, not on a line number or slug.

## Related conventions

- `agents/docs/solutions/conventions/account-state-fixture-must-satisfy-all-dimensions-2026-06-09.md` — same latent-false-pass family at the fixture-seeding layer: a fixture passes green via a partial-dimension discriminator while the claimed §6.1 state is not actually seeded. The message-assertion rule here is the assertion-layer analog of that doc's full-tuple-seed rule; both touch `orcid.ts` and the §6.5 invariants.
- `agents/docs/solutions/conventions/test-fabricated-error-shape-masks-dead-branch-2026-06-09.md` — same family at the error-construction layer: a hand-built test error carrying a `.status` the real class never sets made a production guard always-false while tests stayed green. Identical "assertion accepts a shape the real path never produces" mechanism.
- `agents/docs/solutions/conventions/wire-contract-shape-pinned-on-backend-not-stub-2026-05-16.md` — structural sibling at the response-shape layer: `typeof`-only pins (like `(status, code)`-only pins) accept a correct-enough surface while the real invariant goes unexercised. "Assert every dimension the test claims to protect."
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the foundational mutation-soundness principle this instantiates: a `(status, code)`-only assertion survives a mutation swapping which guard fires; the message assertion restores mutation-soundness against that swap.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — the dual-guard path is a defense-in-depth structure; per-layer canaries are only writable once the assertion can discriminate which layer fired, which is exactly what the message pin enables.

## Sources

- Detection: architect `/ce-code-review` of the UI tasks `ui-orcid-factor-negative-path-e2e` and `ui-orcid-stub-real-roundtrip-unfixme` (2026-06-09). Three independent reviewers (correctness, adversarial, testing) independently flagged the same finding → synthesis promoted to max confidence.
- Code verified at documentation time: `backend/src/routes/orcid.ts` `/callback` — `AUTHENTICATED_MODES` includes `fresh_auth`; the caller-mismatch guard and the `handleFreshAuth` registered-factor guard both emit `403 FORBIDDEN`; `FORBIDDEN` has dozens of `sendError` call sites across `backend/src/routes/`.
- The fix (pin the message) was handed back to the UI agent as a held finding on `ui-orcid-factor-negative-path-e2e`, not yet landed at documentation time; this convention documents the trap and the rule independent of that specific edit.
