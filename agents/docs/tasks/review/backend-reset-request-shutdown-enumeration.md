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

---

## Architect re-review (2026-04-29) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `c72cefe` (Option A landed: catch `ShuttingDownError` on the unknown-email branch and fall through to `sendOk` 200) with 10 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, security, reliability, adversarial, kieran-typescript). Mechanically sound: the catch uses `if (!(err instanceof ShuttingDownError)) throw err;` so `ArgonQueueFullError` (saturation), `ArgonAbortError` (disconnect), and generic Errors all propagate to the outer catch correctly. The new test file `auth-reset-request-shutdown.test.ts` covers (drain + unknown → 200), (drain + known → 200), and (queue-full + unknown → 503 retained), with unconditional body-equality assertions. The `vi.hoisted` mock-class hierarchy is module-scoped and the route's `instanceof` check resolves against the mock class correctly.

But three items surfaced — one invariant-loadbearing maintenance gap, one operator-visibility gap, and one comment cross-reference. All three harden the catch path the task delivers.

### Items to address

**1. (P2) Duplicated success-message literal — extract to a module-scoped constant**

- File: `backend/src/routes/auth.ts:849` (the `ShuttingDownError` catch fall-through `sendOk`) and `:901` (the known-email path's normal `sendOk`)
- The string `'If an account exists with that email, a reset link has been sent.'` appears as **two separate string literals** in the same handler. The indistinguishable-response invariant the endpoint exists to enforce **requires both sites to emit byte-for-byte identical responses**. Nothing at the type or lint level enforces they stay in sync. A wording change at one site and not the other — a typo fix, a localization update, a "make it more friendly" PR — silently re-opens the enumeration oracle.
- Fix: extract `const RESET_REQUEST_OK_MESSAGE = 'If an account exists with that email, a reset link has been sent.'` to module scope; replace both literal sites with the constant. Mechanical; ~3 line change. The constant name should explicitly say "OK_MESSAGE" so a future contributor cannot mistake it for a comment string.

**2. (P3) Silent `ShuttingDownError` swallow — add a `logger.debug` emission for operator visibility**

- File: `backend/src/routes/auth.ts:846-848` (the catch body)
- The current catch is `catch (err) { if (!(err instanceof ShuttingDownError)) throw err; /* fall through to sendOk */ }` with **no logger emission at any level**. During a SIGTERM rolling-deploy drain window, the only signal that the suppression fired is an external diff between the two branch response codes — which is exactly the oracle being closed. Every other semaphore path in the cluster emits structured log: `ArgonQueueFullError` → `logger.warn` (`argon2-error-handler.ts:234`), `ShuttingDownError` (helper path) → `logger.info` (line 240), `ArgonAbortError` → `logger.debug` (line 250-254). This swallow is the sole silent exception.
- Fix: add `logger.debug({ event: 'reset_request_drain_suppression', email_hash: hashEmailForLogs(normalizedEmail) }, 'ShuttingDownError on unknown-email branch suppressed to 200 — drain window');` inside the catch body before the fall-through. Use `debug` level (default-off; available via `LOG_LEVEL=debug` for investigation). The `email_hash` field uses the existing `hashEmailForLogs` helper to avoid plaintext-email-in-logs (CNPD).
- Asymmetry note: emitting a log only on the drain-suppression branch creates a one-sided log signal (presence implies unknown email). Internal-log-stream observers can enumerate via this signal, but log access is an operational boundary, not API contract — and the existing `emailKnown: 'known'` field on the SMTP warn at `auth.ts:892` already accepts this internal-side disclosure for the known-branch. Implementer's call whether to also emit a symmetric debug log on the unknown-branch SUCCESS path (no drain) for full symmetry, or to live with the one-sided signal at log-access boundary.

**3. (P3) Inner-catch comment doesn't cite the canonical solution doc**

- File: `backend/src/routes/auth.ts:831-851` (the comment block above and around the catch)
- The comment cites only the task file (`backend-reset-request-shutdown-enumeration.md`), which moves into `tasks-archive.md` after archive — making the link stale-by-construction once this task closes. The SMTP-oracle catch blocks elsewhere in the same file (lines 627 + 869) explicitly cite their solution doc (`timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`). The matching solution doc for THIS catch is `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the durable canonical reference for why the uniform-200 invariant must hold through drain.
- Fix: add a reference line to the comment block: `// See agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md for the broader sub-branch oracle pattern this catch is part of.` Mirrors the SMTP-oracle catch comments' shape.

### Items dismissed during architect triage (do NOT address)

- **No regression test for sibling-route audit** (security + adversarial residuals) — concrete parametric harness "every endpoint that calls runWithArgon2Slot returns indistinguishable status under ShuttingDownError across all branches" would lock in the audit. Out of scope for this task; consider as a future cluster-wide test infra task.
- **`ArgonAbortError` on unknown-email branch not directly tested** (correctness + reliability TG-001 + adversarial T1) — coverage exists transitively via `handleArgonError` unit tests + the `instanceof ShuttingDownError` negation guarantees rethrow. Add if the abort-class cell becomes a real concern; not blocking.
- **No metrics counter for drain-suppression** (agent-native F2) — project doesn't have ops-counter infrastructure for this surface; log-based counter via item 2 above suffices.
- **Wall-time latency oracle remains during drain** (adversarial residual) — pre-existing SMTP-tail timing oracle on the success path; sibling task tracks as accepted residual under 3/hr/IP rate-limit.
- **Token persists for 1hr after SMTP failure** (adversarial residual + reliability RR-001) — pre-existing behavior, intentional for legitimate-user retry. Functional/UX, not security.
- **Project-standards F-001: task file in `pending/` at this commit** — historical at the commit; the file IS in `tasks/review/` at HEAD. Pre-existing state at the reviewed commit.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal (no need to edit this hold block).

## Backend re-review signal (2026-04-29, working tree)

All three round-1 hold items landed at `backend/src/routes/auth.ts`:

1. **(P2) Module-scoped success-message constant.** Added `const RESET_REQUEST_OK_MESSAGE = 'If an account exists with that email, a reset link has been sent.'` near the other module constants (`auth.ts:111`, alongside `RESET_TOKEN_EXPIRY_MS` etc.) with a comment naming the indistinguishable-response invariant the constant defends. Replaced both literal `sendOk` call sites — the unknown-email fall-through and the known-email post-DB-update path — with the constant. The wall-time-equalization invariant is now backed by a single source of truth at the response-string layer.

2. **(P3) Operator-visibility log on drain suppression.** Added `logger.debug({ event: 'reset_request_drain_suppression', email_hash: hashEmailForLogs(normalizedEmail) }, 'ShuttingDownError on unknown-email branch suppressed to 200 — drain window')` inside the `if (!(err instanceof ShuttingDownError)) throw err;` catch body, after the rethrow guard. Used `debug` level (default-off, available via `LOG_LEVEL=debug` for investigation). Email is hashed via the existing `hashEmailForLogs` helper for CNPD compliance. Did NOT add a symmetric debug log on the unknown-branch success path — opted to live with the one-sided log signal at the operational/log-access boundary, mirroring the architect's note that internal-side disclosure is already accepted via the existing SMTP `emailKnown: 'known'` warn.

3. **(P3) Solution-doc cross-reference.** Replaced the comment block's stale-by-construction reference to the task file with `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md`. Mirrors the SMTP-oracle catch block's existing solution-doc citation pattern at `auth.ts:872`.

Verification:
- `npm run lint` — clean (only pre-existing accepted `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`).
- `npx vitest run tests/routes/auth-reset-request-shutdown.test.ts` — 3 tests passed (drain + unknown → 200, drain + known → 200, queue-full + unknown → 503 retained).
