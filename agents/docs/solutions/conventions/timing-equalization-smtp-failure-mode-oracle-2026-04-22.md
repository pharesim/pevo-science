---
title: SMTP-failure status-code oracle bypasses timing-equalization on email-path endpoints
date: 2026-04-22
last_updated: 2026-04-28
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - An auth endpoint does timing equalization AND sends email on the known-identity path
  - Reviewing or implementing a fix claimed to close all user-enumeration oracles on /reset-request or /resend-verification
  - Adding or modifying any handler where the known-identity branch awaits an I/O operation (SMTP, SMS, webhook) that can throw
  - Writing tests that assert uniform body across known/unknown branches — the assertion must hold for ALL status codes, not just 200
  - Choosing between fire-and-forget email vs. synchronous sendMail on an anti-enumeration endpoint
tags:
  - "timing-oracle"
  - "user-enumeration"
  - "smtp"
  - "status-code-oracle"
  - "authentication"
  - "fire-and-forget"
  - "failure-mode-oracle"
  - "security-fix-review"
---

# SMTP-failure status-code oracle bypasses timing-equalization on email-path endpoints

## Context

SEC-LOGIN-UNKNOWN-USER-TIMING closed the wall-time user-enumeration oracle on `/reset-request` and `/resend-verification` using `burnSentinel()`. The fix was reviewed, the tests passed, and the comment "timing oracle closed" was inserted into the code. A round-3 architect review invoking an adversarial persona surfaced a completely distinct oracle class that the timing work could not touch: **status-code divergence under SMTP failure**.

The mechanism is straightforward. On `/reset-request` and `/resend-verification`, the known-email path executes: DB lookup (finds row) → DB UPDATE (write reset/verify token) → `await transporter.sendMail(...)`. If the SMTP relay is unreachable when `sendMail` runs, `sendMail` throws, the catch block fires, and the handler returns **500 INTERNAL_ERROR**. The unknown-email path, on the other hand, executes `await burnSentinel(normalizedEmail)` and returns **200**. The attacker's signal is the HTTP status code, not the wall time:

- **500** → the email exists in the database.
- **200** → the email is unknown.

No sub-millisecond timing. No specialized equipment. One pair of requests during or after an induced SMTP outage yields a deterministic answer.

The oracle was invisible to the SEC-LOGIN-UNKNOWN-USER-TIMING scope because that task was framed as a **wall-time** problem and solved with argon2 sentinel burns. The sentinel equalizes the argon2 portion of the request latency. It equalizes nothing about what HTTP status code the handler emits when `sendMail` throws. These are independent disclosure channels.

**How the outage is induced or exploited in practice:**

1. Transient SMTP outage waiting in the wild. A patient attacker probing during any outage window gets full enumeration.
2. SMTP quota exhaustion. Many providers have per-hour or per-day send limits; an attacker who controls or observes quota can exhaust it, then probe.
3. Attacker network-shaping their own egress toward the SMTP relay. Disrupts only the known-email path's TCP connection; the unknown-email path never reaches `sendMail`.
4. TLS handshake failure against the relay. Misconfigured or expired cert on the relay produces a throw without sending anything.
5. SMTP relay provider outage. Any transient provider outage between token write and email send triggers the same 500.

None of these scenarios require the attacker to have special access. Scenario 1 alone is sufficient.

**How the flaw survived testing:** `recover.test.ts:944-951` contained an explicit guard that skipped the body-equality assertion when status is 500:

```ts
if (pendingRes.status === 200) {
  expect(pendingRes.body.data.message).toBe(activeRes.body.data.message);
}
```

In the test environment, SMTP is not configured, so the pending-email path always returns 500. The `if (pendingRes.status === 200)` guard silently skips the assertion that should fail. The test passes every run. The production behavior is exactly the oracle the test was supposed to catch.

**Discovery pathway:** surfaced by an adversarial reviewer constructing explicit failure scenarios against a code path that had already received a "looks-complete" security fix. The adversarial question was: "what happens to the status code, not just the body, if each individual I/O step inside the known-email branch throws?" That question was not asked during the original SEC-LOGIN-UNKNOWN-USER-TIMING review or its round-1/round-2 holds. The round-3 pass's adversarial persona caught it with 0.95 confidence. The non-adversarial personas in the same pass did not flag it.

**Relationship to the wall-time convention:** `timing-equalization-sub-branch-oracles-2026-04-21.md` covers **wall-time** oracles (one code path skips the expensive argon2 KDF and is therefore measurably faster). This doc is a sibling category: **failure-mode** oracles, where a distinct disclosure channel (HTTP status code) opens under a specific environmental condition (SMTP outage) that the timing work does not affect. Both categories are attack axes on the same invariant ("the response must not distinguish known from unknown identity"), but they require different defenses. Timing equalization closes the wall-time axis; fire-and-forget or catch-and-return-200 close the failure-mode axis. Neither defense does anything about the other axis.

## Guidance

**Rule: any auth endpoint that sends email on the known-identity path MUST return the same HTTP status code for known and unknown identity regardless of SMTP availability. Timing equalization is not sufficient — `burnSentinel()` burns argon2 latency, not SMTP throw semantics.**

Two mechanically sound options:

**Option A — Catch `sendMail` and return 200 anyway (cheapest):**

```ts
if (config.smtpHost) {
  try {
    await transporter.sendMail({ /* ... */ });
  } catch (err) {
    logger.warn(
      { err, route: 'auth.reset-request', emailKnown: 'known' },
      'SMTP send failed',
    );
    // DO NOT return 500 here. Returning 500 only on the known-email path
    // is a status-code oracle: 500 = "this email exists in our database."
  }
}
sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
```

Structured-log-field shape (landed via BE-AUTH-SMTP-STATUS-CODE-ORACLE on 2026-04-22):

- **Level:** `warn`. `error` is reserved for conditions that warrant paging; an SMTP outage where the request still returns 200 is a delivery-gap metric, not an availability incident. Bump to `error` only if the outage blocks a response.
- **Shape:** `logger.warn({ err, route: '<handler-name>', emailKnown: 'known' | 'unknown' }, 'SMTP send failed')`.
  - `err` is the raw Error (pino serializes it; do NOT pre-stringify via `(err as Error).message` — that drops the stack).
  - `route` identifies the handler so operators can aggregate by endpoint: `'auth.reset-request'`, `'auth.resend-verification'`, future additions follow `'<router>.<path>'`.
  - `emailKnown: 'known'` on branches that looked up a real account; `'unknown'` on the burnSentinel/no-row branches (even though those don't send email, keep the shape uniform if a future refactor adds a send there).
  - Message string: `'SMTP send failed'` verbatim. Operators grep for it; keep it stable across call sites.

Requires retry or dead-letter infrastructure so legitimate users are not silently dropped. At minimum, an async retry queue or a metrics alert on the `sendMail` failure rate.

**Option B — Fire-and-forget email, respond 200/202 before SMTP:**

```ts
sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
setImmediate(() => {
  transporter.sendMail({ /* ... */ }).catch((err) => {
    logger.error({ err }, 'Background sendMail failed — retry or dead-letter needed');
  });
});
```

Requires the same retry / dead-letter infrastructure. Aligns semantically with the fact that email delivery is inherently async (202 Accepted is even more accurate than 200 OK).

**Which option to choose:** Option A is a minimal invasive change with no architectural impact. Option B aligns with async email semantics and removes the SMTP latency from the request path entirely (closing the related SMTP-tail timing oracle at the same time — see `backend-resend-verification-smtp-timing.md`). Both close the status-code oracle. The choice trades off implementation cost against the latency-oracle closure.

**Test pattern that MUST accompany either fix:**

```ts
vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
  sendMail: vi.fn().mockRejectedValue(new Error('SMTP connection refused')),
} as any);

const knownRes = await request(app).post('/api/auth/reset-request').send({ email: KNOWN_EMAIL });
const unknownRes = await request(app).post('/api/auth/reset-request').send({ email: UNKNOWN_EMAIL });

// Both MUST return the same status code regardless of SMTP health.
expect(knownRes.status).toBe(unknownRes.status);
expect(knownRes.body.data.message).toBe(unknownRes.body.data.message);
expect(knownRes.status).toBe(200);
```

Do NOT use `if (res.status === 200) { expect(...) }` — that guard silently passes when SMTP is unconfigured.

## Why This Matters

Timing equalization defends one axis of the user-enumeration invariant: wall-time distinguishability. Status-code divergence under failure conditions is a completely orthogonal axis. The sentinel burns `burnSentinel()` installs do nothing to close the failure-mode axis — they equalize argon2 latency, not what HTTP status code the handler emits when `sendMail` throws.

The practical attack is straightforward. An attacker enumerating email addresses on `/reset-request` does not need sub-millisecond timing resolution. They wait for or induce an SMTP outage (any of the five mechanisms listed in Context), then probe candidate addresses. Every address that returns 500 is confirmed present in the database. Every address that returns 200 is absent. Full enumeration at HTTP-status granularity, with zero special tooling.

The "looks-complete" dynamic is the most dangerous aspect. SEC-LOGIN-UNKNOWN-USER-TIMING was a thorough, multi-round fix. The comment "timing oracle closed" was inserted in good faith. A developer reviewing the endpoint post-fix sees: `burnSentinel()` on the unknown-email branch, uniform 200 response, uniform message body, the authoritative comment. Nothing about that picture signals "check what happens when `sendMail` throws." The false attestation discourages exactly the adversarial scrutiny that would catch the flaw.

The test gap compounds this. The conditional guard at `recover.test.ts:944-951` means the uniform-body assertion is never actually executed in the test environment. The test signals green on every run while the production behavior is precisely what it was meant to prevent.

Three practical consequences of leaving this open:

1. An attacker can enumerate every email address in the database in bulk during any SMTP outage, bypassing rate limiting (the probe pairs are structurally indistinguishable from normal traffic), bypassing timing equalization (the timing work still fires; the signal is in the status code), and bypassing the uniform message body (the 500 response body is not the uniform message body).
2. Any subsequent security audit will likely stop at "timing oracle closed" in the comment and not investigate the failure-mode axis. The fix creates a false negative in the review process.
3. The test suite provides false confidence. Green tests that paper over the oracle make it harder to notice when a regression reintroduces the same pattern on a new endpoint.

## When to Apply

1. Any endpoint that returns a uniform success response to prevent identity enumeration AND sends email on the known-identity path.
2. Any security review of `/reset-request`, `/resend-verification`, or any future endpoint with the same shape. Concretely: after confirming that timing equalization is in place, ask explicitly "what HTTP status code does this handler return if `sendMail` throws?" and "is that status code the same for the known and unknown identity branches?"
3. Any test that asserts uniform response behavior across known and unknown identity branches. The assertion MUST be unconditional on status code — it MUST NOT use a guard like `if (res.status === 200)`.
4. Any time a handler returns a different HTTP status code depending on the success or failure of a downstream I/O operation (SMTP, webhook, push notification) that is only reached on the known-identity path.
5. When choosing between synchronous `await sendMail()` and fire-and-forget email on an anti-enumeration endpoint.

## Examples

### Why `burnSentinel()` does not help here

```ts
// Unknown email:     DB read (~5ms) → burnSentinel (~50ms) → 200
// Known email OK:    DB read (~5ms) → DB UPDATE (~2ms) → sendMail (~200ms) → 200
// Known email SMTP↓: DB read (~5ms) → DB UPDATE (~2ms) → sendMail throws → 500
//
// The sentinel closes: "unknown vs known wall-time."
// The sentinel does NOT close: "sendMail-throws 500 vs sendMail-absent 200."
// Different signals on different channels. Close them with different tools.
```

### Oracle-open (current state) vs Option A fix

```ts
// OPEN — /reset-request known-email branch:
if (config.smtpHost) {
  try {
    await transporter.sendMail({ /* ... */ });
  } catch (mailErr) {
    logger.error({ err: (mailErr as Error).message }, 'Failed to send reset email');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send reset email');  // <-- ORACLE
  }
}
sendOk(res, { message: 'If an account exists...' });

// CLOSED (Option A, as landed by BE-AUTH-SMTP-STATUS-CODE-ORACLE):
if (config.smtpHost) {
  try {
    await transporter.sendMail({ /* ... */ });
  } catch (err) {
    logger.warn(
      { err, route: 'auth.reset-request', emailKnown: 'known' },
      'SMTP send failed',
    );
    // Fall through to uniform 200 below.
  }
}
sendOk(res, { message: 'If an account exists...' });
```

## Related

- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the parent convention covering **wall-time** oracles. Both docs apply simultaneously on `/reset-request` and `/resend-verification`; neither subsumes the other.
- `backend-auth-smtp-status-code-oracle.md` (in `agents/docs/tasks/`) — open task tracking the fix.
- `backend-resend-verification-smtp-timing.md` — sibling SMTP **latency** oracle. Archived 2026-04-22 as accepted residual (rate-limit-bounded; not closable at the sentinel layer without a background job pipeline). Option B (fire-and-forget) from the status-code task would close both axes simultaneously if the team ever lands a job queue for unrelated reasons.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — the `{ err, route, emailKnown }` SMTP-failure log shape this doc prescribes is now subsumed by the unified `{ event, route, emailKnown, err }` canonical shape for `auth.ts` emissions. The `route` and `emailKnown` keys still apply unchanged; an `event: 'auth.<endpoint>.smtp_send_failed'` (or `_smtp_not_configured`) discriminator is added on every catch.
