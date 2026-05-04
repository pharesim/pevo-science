# BE-SIGNUP-SMTP-STATUS-CODE-ORACLE — close the residual /signup status-code differential under SMTP failure

**Owner:** backend (likely needs architect brainstorm before implementer-ready)
**Created:** 2026-05-04 (filed by architect during round-2 archive of `backend-auth-smtp-status-code-oracle.md`)
**Priority:** P3

## Context

The original BE-AUTH-SMTP-STATUS-CODE-ORACLE task closed the SMTP failure-mode status-code disclosure on `/api/auth/reset-request` and `/api/auth/resend-verification` via Option C: wrap `sendMail` in try/catch + always return uniform 200 + log a structured warn. The architect's original scope decision (2026-04-22) explicitly carved `/signup` out:

> Apply to both `/api/auth/reset-request` and `/api/auth/resend-verification`. The `/login` success path already returns a JWT unconditionally; its email-sending (if any) is not in scope here.

`/signup` was simply not addressed. Adversarial review of the round-2 hold-fix (2026-05-04, conf 75) constructed the residual oracle:

Under SMTP outage, `/signup` distinguishes 4 outcomes by status code:
- **409 DUPLICATE** — known existing email (verified or unverified)
- **500 INTERNAL_ERROR** — unknown email on accredited domain + sendMail throws (account row inserted then deleted, error logged via `logger.error`)
- **200 OK** — unknown email on accredited domain + sendMail succeeds
- **422 VALIDATION_ERROR** — unaccredited domain (no SMTP attempt at all)

Combined with the institutional vs unaccredited domain axis, an attacker probing across email addresses can extract registration status by triggering an SMTP outage (or waiting for one) and observing the 4-bin response distribution.

## Why P3 (not P1)

- `/signup` is rate-limited at 10/hr/IP via `signupLimiter`. Practical exploitation requires distributed probing across many IPs and many email addresses.
- The differential is comparable in shape to `backend-resend-verification-smtp-timing.md` which was archived (2026-04-22) as accepted residual after weighing the rate-limit cap against the disclosure value.
- The closure is non-trivial because of the **account-row rollback question**: the current 500 path deletes the account row on sendMail failure; a 200-uniform behavior would need to keep the row so the user can recover via `/resend-verification`, changing semantics beyond a pure status-code unification.

## Why this is filed (not dismissed)

- The differential is on record and discoverable; future audits should not have to reconstruct the analysis.
- The round-2 helper docblock framed all 3 auth routes as benefiting from "the same canonical shape", which is timeout-true but status-code-misleading. The accompanying helper-promote-and-migrate task (`backend-smtp-transporter-helper-promote-and-migrate.md`) trims the parity framing, but the underlying behavioral asymmetry persists until this task closes (or is explicitly accepted).
- A clean accept-as-residual decision (mirroring the resend-verification timing precedent) requires architect deliberation, which belongs in a task body rather than a dismissed-finding line.

## [TODO Architect]

This task is **blocked on architect input** before backend can pick it up. Two distinct decisions are required:

### Decision 1: close the oracle, or accept-as-residual?

- **Close it:** apply Option-C-shape uniformity to `/signup` (see Decision 2 for shape).
- **Accept-as-residual:** mirror the precedent of `backend-resend-verification-smtp-timing.md`. Document the dismissal in `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` so future reviewers don't re-litigate. Justification: rate-limit cap + multi-IP / multi-domain probe requirement + the row-rollback semantic cost outweighs the disclosure value.

### Decision 2 (only if Decision 1 = close): account-row semantics on sendMail failure

If we close the oracle, `/signup` must return uniform 200 regardless of SMTP availability. The current behavior on sendMail throw is:
1. `await pool.query('DELETE FROM accounts WHERE email = $1', [normalizedEmail])` — rolls back the just-inserted row
2. `logger.error({ event: 'auth.signup.smtp_send_failed', ... }, 'verification email send failed; rolled back account')`
3. `return sendError(res, 500, 'INTERNAL_ERROR', ...)` — the leak source

A 200-uniform behavior has 3 plausible shapes:

- **Shape A: Keep the row, return 200.** User can re-trigger the email via `/api/auth/resend-verification`. Pro: simplest, matches the other two routes. Con: a determined attacker can use the duplicate-email check as a confirmation channel after-the-fact (POST /signup with same email later returns 409 if SMTP recovered, not 422 / 200) — but that's the existing 409-vs-422 oracle, which is already what the duplicate-email-then-accreditation check-order at `auth.ts:418-444` is designed around.

- **Shape B: Keep the row, return 200, schedule a background retry.** Adds a retry queue or `setImmediate` retry loop. Substantial new infrastructure; precedent rejected as out-of-scope in the original task (Option A/B alternatives).

- **Shape C: Roll back the row, return 200.** Maintains the current cleanup semantics but unifies the status code. Con: the user gets a 200 response but no usable account state; if SMTP recovers and they retry, they hit the row-not-present path and re-insert. Functionally similar to Shape A from the user's perspective but messier in the DB.

Shape A is the least surprising and most consistent with the existing `/reset-request` and `/resend-verification` behavior. It also surfaces a nice property: the user can recover via `/resend-verification` once SMTP is healthy, which is the same self-service path the other routes already advertise. Architect to decide; unblock by moving this task back to `pending/` with the chosen shape noted in the task body.

## Non-goals

- Closing the SMTP-latency tail oracle on `/signup` (sibling concern, not in scope).
- Reworking the duplicate-email → accreditation check-order at `auth.ts:418-444` — that's already correctly ordered to close the registration-status leak under non-SMTP conditions.
- Connection pooling, retry queues, dead-letter handling. If Shape B is chosen, scope ballooning is the architect's call.

## Cross-references

- Predecessor (round-2 archived 2026-05-04): `backend-auth-smtp-status-code-oracle.md` — closed the oracle on the OTHER two routes; explicitly carved `/signup` out.
- Sibling task: `backend-smtp-transporter-helper-promote-and-migrate.md` — trims the helper docblock parity framing that motivated filing this task.
- Precedent for accept-as-residual: `backend-resend-verification-smtp-timing.md` (archived 2026-04-22 in `tasks-archive.md`).
- Conventions: `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`, `timing-equalization-sub-branch-oracles-2026-04-21.md`.

---

**[BLOCKED by Architect] (2026-05-04, filed during round-2 archive review):** Backend cannot implement without Decision 1 (close vs accept-as-residual) and, if close, Decision 2 (account-row semantics on sendMail failure). Both decisions involve scope/semantic tradeoffs that don't have a single correct answer from code reading alone. Architect to deliberate (possibly via `/ce-brainstorm`) and move back to `pending/` with the decision noted in the task body.
