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

---

## Architect decision (2026-04-22): Option C

**Chosen: Option C** — wrap `sendMail()` in try/catch, log at `warn` level with a structured metric ({route, emailKnown: known|unknown}), continue to return 200 on both branches. SMTP outage becomes operator-visible via the log/metric, never via the HTTP response shape.

**Rationale.** A and B require a background email pipeline + retry/dead-letter story we don't currently need for anything else; building that just to close this oracle trades one source of complexity for a larger one. Option C closes the status-code axis cheaply and preserves today's delivery semantics. Legitimate users who genuinely don't receive an email during an SMTP outage are no worse off than before (they'd already be not receiving it) — the change is that the attacker no longer learns anything from the failure.

**Scope clarifications for implementer:**
- Apply to both `/api/auth/reset-request` and `/api/auth/resend-verification`. The `/login` success path already returns a JWT unconditionally; its email-sending (if any) is not in scope here.
- Metric name: reuse an existing structured logger field convention (check recent logger.warn sites in `auth.ts` for the prevailing shape). No new metrics infra.
- Remove the `recover.test.ts:944-951` "skip body assertion when status is 500" carve-out — with Option C, that path always returns 200 + uniform body.
- Convention doc `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` ALREADY EXISTS and covers this case end-to-end. Implementer verifies the doc's guidance matches what lands; extends only if silent on a specific implementation choice (e.g., the logger.warn structured-field shape). Do NOT write a new convention doc.
- No `api-contracts/auth.md` update needed; the response shape for both branches stays "200 + uniform-message body" as already contracted.

**Residual coupling with `backend-resend-verification-smtp-timing.md` (SMTP-latency axis):** that task is being archived as accepted residual (see its archive entry in `tasks-archive.md`). Rate-limit at 3/hr/IP bounds practical exploitability of the remaining ~200-2000ms delta. Re-open only if telemetry shows SMTP-outage-timed enumeration in the wild.

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `e6df0d7` (the Option-C implementation: wrap `sendMail()` in try/catch + `logger.warn` + always 200 on `/reset-request` and `/resend-verification`) with 10 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, reliability, adversarial, kieran-typescript). Architecture is sound: try/catch correctly catches sync + async failures, both routes wrap `sendMail`, the `recover.test.ts:944-951` `if (res.status === 200)` carve-out is gone (replaced with unconditional assertion per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`), the structured-log shape `{ err, route, emailKnown: 'known' }` matches the convention doc, and the new BE-AUTH-SMTP-STATUS-CODE-ORACLE describe block in `recover.test.ts` covers both routes × {SMTP-success, SMTP-failure} with body-equality assertions.

But two reliability items surfaced — one symmetry gap that operators will notice during incidents, and one transport-timeout default that can block request handlers under partial SMTP failure.

### Items to address

**1. (P2) `/resend-verification` lacks the symmetric `else { logger.warn(...) }` branch when `config.smtpHost` is unset**

- File: `backend/src/routes/auth.ts` around lines 576-596 (the `if (config.smtpHost) { try ... } catch ...` block in `/resend-verification`)
- The `/reset-request` handler emits `logger.warn({ route: 'auth.reset-request', emailKnown: 'known' }, 'SMTP not configured — verification email not sent')` (or equivalent message) at line 824 in the `else` branch when `config.smtpHost` is falsy. `/resend-verification` has no `else` branch at all — when `smtpHost` is empty, the token is silently rotated in the DB and the handler returns 200 with zero log output. An operator running with SMTP misconfigured will get no signal that verification emails are not being sent on the resend path.
- The asymmetry is mechanical: `/reset-request` gained the else-branch in this commit; `/resend-verification` did not. Both routes share the same Option-C contract (warn + always 200) and should be observably symmetric for misconfiguration too.
- Fix: add `else { logger.warn({ route: 'auth.resend-verification', emailKnown: 'known' }, '<message matching the /reset-request convention>'); }` after the `if (config.smtpHost)` block at line 576. Keep the structured-field shape identical to the `/reset-request` else-branch so a single grep/dashboard catches both routes' SMTP-misconfigured events.

**2. (P3) `nodemailer.createTransport` per-request with no `connectionTimeout` / `socketTimeout`**

- File: `backend/src/routes/auth.ts:578` (`/resend-verification`) and `:803` (`/reset-request`)
- Both routes call `nodemailer.createTransport({ host, port, secure, auth })` with no timeout options. Nodemailer's built-in default is **2 minutes** for the TCP connection attempt and unbounded for socket reads. If the SMTP relay accepts the TCP handshake but doesn't respond to EHLO (a common failure mode for misbehaving relays), `await transporter.sendMail(...)` blocks the request handler thread for up to 2 minutes before the catch fires. Under concurrent load this can exhaust the Node.js event loop. The transporter is also constructed fresh per request rather than reused — every call opens a new TCP connection.
- Fix: add `connectionTimeout: 5000, socketTimeout: 10000` to both `createTransport` option objects. 5s connection + 10s socket covers normal relay latency with a safe ceiling. (Consider extracting the transporter to a module-level singleton with connection pooling at a future task; not required for this hold.)

### Items dismissed during architect triage (do NOT address)

- **sendMail try/catch pattern duplicated verbatim across the two routes** (maintainability conf 75) — defensible at 2 sites; convention doc is the cross-cut reference. Re-evaluate at a third site.
- **Internal log oracle on /reset-request known branch only logging warn at line 824** (adversarial residual) — pre-existing log-stream concern; mitigated by access control. The new symmetric else-branch from item 1 above adds the resend-verification side, keeping the log-shape uniform across routes.
- **Token-not-cleared comment rationale ("retry on next SMTP attempt window") mechanically incorrect** (adversarial residual) — when sendMail throws, the message never reached the relay; there is no relay-level retry queue. Functional/UX comment cleanup, not security; defer.
- **`/reset-request` SMTP-unconfigured `else` branch not covered by new tests** (testing T01 conf 75) — the test forces `config.smtpHost = 'smtp-fail-test.invalid'` to exercise the throw path; the `else` (smtpHost empty) path is not directly tested. With item 1 above adding the symmetric else-branch on `/resend-verification`, this becomes a 2-route gap. Consider adding one test that leaves `config.smtpHost = ''` and asserts the warn log fires + 200 returns; not blocking archive.
- **Mock justification at describe-block level instead of file header** (testing T02 conf 50) — minor deviation from CLAUDE.md test-convention literal wording; the rationale is documented, just at a slightly different anchor.
- **`emailKnown: 'known'` field name could be misread as a nodemailer concept** (maintainability conf 50) — convention doc pins the shape; renaming would require updating the doc + both call sites in lockstep. Not worth the churn.
- **createTransport synchronous throw on malformed options would escape inner try/catch** (maintainability residual) — config options are validated at startup; the dynamic-options scenario is hypothetical.
- **Convention doc references `tasks/pending/...` paths for files that may have moved** (maintainability residual) — doc-maintenance, not functional.
- **No assertion that the warn log fires with expected structured fields** (maintainability T1) — concrete improvement; not blocking. Add a `vi.spyOn(logger, 'warn')` assertion alongside the new test from item 1's coverage if implementer wants to land it together.
- **No first-class metrics counter for SMTP failure** (agent-native Q3) — out of scope; project doesn't have ops-counter infrastructure for this surface yet.
- **ARCHITECTURE.md doesn't document the warn-level operator stance** (agent-native Q4) — architect-side documentation; the convention doc covers it. Consider after archive.
- **Pre-existing /signup error log includes plaintext email** (agent-native Q5, `auth.ts:478`) — out of scope; CNPD concern on a different handler. File separately if material.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

## Backend re-review signal (2026-04-29, working tree)

Both round-1 hold items landed at `backend/src/routes/auth.ts`:

1. **(P2) Symmetric `else { logger.warn(...) }` on `/resend-verification`.** Added the missing else-branch after the `if (config.smtpHost)` block on the `/resend-verification` known-email path so an operator running with SMTP unconfigured gets the same `'SMTP not configured — verification email not sent'` warn that `/reset-request` emits. Structured fields match (`route: 'auth.resend-verification', emailKnown: 'known'`) so a single grep/dashboard catches both routes' SMTP-misconfigured events.

2. **(P3) `connectionTimeout` + `socketTimeout` on `nodemailer.createTransport`.** Added `connectionTimeout: 5000, socketTimeout: 10000` to both `createTransport` option objects on `/resend-verification` and `/reset-request`. Bounds the request handler's wall-time under partial SMTP failure (relay accepts handshake, never responds to EHLO) — without these, nodemailer's 2-minute TCP-connect default + unbounded socket reads can pin a request thread for minutes and exhaust the event loop under concurrent load. Inline comment on the `/resend-verification` site documents the rationale; `/reset-request` cross-references it.

Verification:
- `npm run lint` — clean (only pre-existing accepted `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`).
- `npx tsc --noEmit` — clean.
- `npx vitest run tests/routes/recover.test.ts tests/routes/auth-reset-request-shutdown.test.ts` — 2 files / 33 tests passed against real Postgres + Redis.
