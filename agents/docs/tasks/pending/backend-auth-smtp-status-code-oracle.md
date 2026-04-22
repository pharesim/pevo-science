# BE-AUTH-SMTP-STATUS-CODE-ORACLE — Close the SMTP-failure status-code oracle on /reset-request + /resend-verification

**Owner:** backend
**Created:** 2026-04-22 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING round-3 architect review)
**Priority:** P1

## Context

SEC-LOGIN-UNKNOWN-USER-TIMING closed wall-time enumeration oracles on `/reset-request`, `/resend-verification`, `/login`, `/recover`, and `/signup` via `burnSentinel()` and argon2.hash parity. The architect's round-3 review surfaced a distinct oracle class that timing equalization cannot close: **status-code divergence under SMTP failure**.

On `/reset-request`: a known email hits the DB UPDATE + `sendMail()` path. If SMTP is unreachable (transient outage, quota exhaustion, network shaping), `sendMail` throws → handler returns **500 INTERNAL_ERROR**. An unknown email takes the `burnSentinel` path → **200**. Same pattern at `/resend-verification`.

An attacker who induces or waits for an SMTP outage observes:
- **500** = email exists
- **200** = email unknown

Full enumeration from a single pair of requests, bypassing all the timing work. Doesn't require sub-millisecond precision — just observe the response code.

3-reviewer convergence (security 0.82, adversarial 0.95, adversarial 0.92). See `.context/compound-engineering/ce-code-review/aggregated/02-backend-login-unknown-user-timing.md` § F2.1.

The sibling task `backend-resend-verification-smtp-timing.md` (already filed) targets the SMTP **latency** tail; this task targets the **failure-mode status-code axis** which is a separate disclosure channel.

## Why the prior sweep didn't close it

SEC-LOGIN-UNKNOWN-USER-TIMING was scoped to wall-time oracles. The failure-mode axis was invisible to that scope — an attacker induces the SMTP outage, the timing work still fires, and the disclosure flows through the HTTP status code instead of the elapsed time.

The round-3 uniform-message-body test at `recover.test.ts:944-951` explicitly skips the body assertion when status is 500, papering over exactly this disclosure.

## Goal

Equalize the failure-mode response so known-email and unknown-email paths are indistinguishable under SMTP outage.

## Options (choose one)

- **A. Fire-and-forget email with uniform 200/202.** Known-email path: commit DB UPDATE, then enqueue `sendMail` via a background worker (or simple `setImmediate` + logger); respond 200/202 immediately. Unknown-email path: `burnSentinel` + respond 200/202. Both emit the same status + body regardless of SMTP health. Requires: a background task queue or fire-and-forget shim, and retry logic for failed sends (otherwise legitimate users get a silent no-email outcome).

- **B. Uniform 202 Accepted.** Same as A but semantically "we accepted your request, delivery pending" — aligns better with the fact that email delivery is inherently async. Simpler messaging; same retry requirement.

- **C. Wrap sendMail in try/catch + log + still return 200.** Cheapest. SMTP outage during a request is logged + metric-bumped, but user gets 200. Drawback: user who genuinely didn't receive the email has no signal (but they wouldn't anyway — they'd just not get the email).

## Non-goals

- Changing the timing-equalization work from SEC-LOGIN-UNKNOWN-USER-TIMING.
- SMTP-tail latency oracle (filed separately as `backend-resend-verification-smtp-timing.md`).
- Redesigning the email delivery pipeline beyond the scope needed to close the status-code axis.
- Accepting delivery-silence for legitimate users without a plan for retry / dead-letter.

## Acceptance

- `/reset-request` on known + unknown emails both return the same status code regardless of SMTP availability.
- `/resend-verification` same.
- A timing-env test (e.g., spec-level mock of `nodemailer.sendMail` to throw) asserts the status + body match across known/unknown pairs during simulated SMTP outage.
- Convention doc `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` extended with a "failure-mode axis" sub-rule — the timing-equalization doc currently describes wall-time oracles only.
- Mail-delivery retry / dead-letter strategy documented (or filed as a follow-up if the chosen option defers it).

## [TODO Architect]

- Decide Option A/B/C. Lean: Option C (cheapest, preserves existing delivery semantics) if combined with logger.warn + metric; Option A/B if we want to land a proper background-email pipeline for other reasons (e.g., upcoming verify-email redesign).
- Any contract update at `agents/docs/api-contracts/auth.md` if the response-code semantics change.

---

**[BLOCKED by Architect] (2026-04-22, backend intake triage):**

Backend cannot implement without the Option A/B/C product decision — each option has materially different downstream work (background queue + retry infra for A/B vs try/catch+metric for C). Please pick one (or delegate to C per your own stated lean) and move back to `pending/` with the decision noted in the task body. The convention-doc extension and any auth.md contract note are architect-owned regardless of which option lands.
