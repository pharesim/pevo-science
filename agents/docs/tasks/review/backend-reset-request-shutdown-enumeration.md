# BE-RESET-REQUEST-SHUTDOWN-ENUMERATION — Close `/reset-request` email-enumeration oracle that opens during SIGTERM drain

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-shutdown-drain.md`, security persona)
**Priority:** P1

## Problem

`POST /api/auth/reset-request` exists to handle password-reset requests for known emails AND to look indistinguishable for unknown emails (closing email-enumeration). The wall-time equalization is provided by `burnSentinel(normalizedEmail, abortSignal)` on the unknown-email branch — it runs an ~50ms argon2.verify against a sentinel hash so the unknown-email path doesn't return faster than the known-email path (which does a DB UPDATE + `await sendMail()` taking 100–2000ms).

`backend-argon2-semaphore-shutdown-drain.md` (commit `66f010f`) added `ShuttingDownError` propagation through `runWithArgon2Slot`. `burnSentinel` rethrows `ShuttingDownError` (correctly, by design — to preserve the timing-oracle property). The outer catch at `auth.ts:917-921` calls `handleArgonQueueFull(res, err)` which translates `ShuttingDownError` to `503 SERVICE_UNAVAILABLE`.

Result: during the SIGTERM drain window (up to 30s per rolling deploy):

```
Unknown email path:   pool.query → rows.length === 0 → burnSentinel(email)
                                                       ↓ during drain
                                                       throws ShuttingDownError
                                                       ↓ outer catch → handleArgonQueueFull → 503

Known email path:     pool.query → rows.length > 0 → DB UPDATE → sendMail (try/catch fall-through)
                                                                 ↓
                                                                 sendOk → 200
```

The known-email branch never touches argon2, so it never throws `ShuttingDownError`. During every rolling-deploy drain window:
- **Known emails: 200**
- **Unknown emails: 503**

Status-code differential = direct email enumeration via paired probes during a predictable window (every operator-known rolling restart).

This is the same enumeration vector the burn equalization exists to close, reopened during drain. Documented as a class of failure in `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` ("pool-unavailable 503s preempting the sentinel … self-equalizes in most cases; **confirm rather than assume**").

## Goal

Close the status-code differential during SIGTERM drain. Two viable shapes; implementer picks one:

### Option A: Catch `ShuttingDownError` on the unknown-email branch, fall through to `sendOk`

```ts
if (rows.length === 0) {
  try {
    await burnSentinel(normalizedEmail, abortSignal);
  } catch (err) {
    if (err instanceof ShuttingDownError) {
      // Service is shutting down; the burn would have produced uniform 200 in steady state.
      // Returning 200 here preserves the enumeration-prevention invariant at the cost of
      // briefly "lying" about service availability. Acceptable: the next request lands on
      // the new instance, and the legitimate user retries with no information leak.
      sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
      return;
    }
    throw err;  // any other error propagates to outer catch (queue-full → 503, generic → 500)
  }
  sendOk(res, { message: 'If an account exists with that email, a reset link has been sent.' });
  return;
}
```

**Tradeoff**: enumeration prevention preserved; users on aborted/shutdown requests see "success" but the email isn't sent. Acceptable because (a) clients retry naturally, (b) no information leak, (c) the next instance handles the retry correctly.

### Option B: Pre-flight `isShuttingDown()` check at top of handler, return 503 symmetrically

```ts
import { isShuttingDown } from '../lib/argon2-semaphore.js';

router.post('/reset-request', resetRequestLimiter, async (req: Request, res: Response) => {
  if (isShuttingDown()) {
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Service shutting down. Please retry.');
  }
  // ... rest of handler unchanged
});
```

Requires exporting `isShuttingDown()` from `argon2-semaphore.ts` (a new public surface).

**Tradeoff**: shutdown semantics preserved (503 is honest); enumeration prevention preserved (both branches return 503 symmetrically). Cost: a new module export and a check at the top of every endpoint that uses `burnSentinel`.

## Lean (Architect)

**Lean: Option A.** Reasons: (1) the existing equalization invariant is "indistinguishable response"; returning 200 on shutdown preserves that invariant cleanly. (2) Option B requires identifying every `burnSentinel`-using endpoint with a known-email branch that skips argon2 (only `/reset-request` today, but the audit grows over time). (3) Frontend retry-on-failure semantics for `/reset-request` are already "show success message regardless" (see the response message string), so returning 200 during drain is consistent with the user-facing UX. (4) Avoids exporting a new module-level state-check function whose discipline future endpoints would need to remember.

Implementer may push back on the lean if Option B fits a broader pattern they're seeing.

## Acceptance

- The chosen fix lands in `backend/src/routes/auth.ts /reset-request`.
- A new test in `backend/tests/routes/auth.test.ts` (or a dedicated file) injects a `ShuttingDownError` from `runWithArgon2Slot` (via the established `MockShuttingDownError` pattern from `auth-signup-dup-saturated.test.ts`) and asserts that **both** branches (known email and unknown email) return identical status codes during drain — either both 200 (Option A) or both 503 (Option B). The test must fail under the pre-fix state.
- If Option B: `isShuttingDown()` is exported from `argon2-semaphore.ts` with a JSDoc note describing its single intended use case (pre-flight gate to prevent argon2-vs-non-argon2 sub-branch oracle).
- Audit of other routes that mix argon2-using and argon2-skipping branches in the same handler. Candidates from the cluster A audit: review `wot.ts`, `signup-verify.ts`, `accreditation.ts` for similar patterns. File follow-ups if any are found.

## Non-goals

- Changing the 30s force-timeout on `server.close()`.
- Changing the `burnSentinel` rethrow semantics for `ShuttingDownError` (those are correct).
- Hardening unrelated timing oracles on `/reset-request` (e.g., the SMTP-tail oracle on the known-email path is tracked separately as `backend-resend-verification-smtp-timing.md`).

## Related

- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the canonical convention this finding reactivates.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — Case 3 documents the auth.ts:401,407 status-code differential under saturation; this task is the same shape applied to `/reset-request`.
- `backend-argon2-semaphore-shutdown-drain.md` — drain task that introduced `ShuttingDownError` propagation; this is a follow-up not a hold against that task.

## [TODO Architect]

None — implementer chooses A vs B. Architect re-review verifies the chosen shape closes the oracle without introducing a new one.
