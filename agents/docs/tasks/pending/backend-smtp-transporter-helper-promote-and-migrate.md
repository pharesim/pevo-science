# BE-SMTP-TRANSPORTER-HELPER-PROMOTE-AND-MIGRATE — promote createSmtpTransporter to lib/smtp.ts and migrate 4 cross-file callers

**Owner:** backend
**Created:** 2026-05-04 (filed by architect during round-2 archive of `backend-auth-smtp-status-code-oracle.md`)
**Priority:** P1

## Context

Round-2 of `backend-auth-smtp-status-code-oracle.md` extracted `createSmtpTransporter()` at `backend/src/routes/auth.ts:286-297` and consolidated the 3 inline `nodemailer.createTransport` call sites in `auth.ts` (/signup, /resend-verification, /reset-request) onto the new helper. The hold block scoped that work to the auth router. Architect re-review (2026-05-04, 9-persona pass) confirmed round-2 items 1-5 landed correctly for that scope, but cross-reviewer convergence (maintainability conf 100, adversarial conf 80, learnings advisory) surfaced that **4 sibling sites in non-auth files still call `nodemailer.createTransport` raw, with none of the 4 timeout knobs**:

- `backend/src/digest.ts:110`
- `backend/src/routes/contact.ts:32`
- `backend/src/routes/accreditation.ts:264`
- `backend/src/routes/settings.ts:43`

The wrapping-primitive convention (`agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`) is repo-wide; once a canonical wrapper is established, every direct caller becomes a structural drift risk. The round-2 archive entry notes the cross-file sites; this task closes them.

## Why P1

Adversarial reviewer (conf 80) constructed the cascade scenario:

- `/api/contact` is **unauthenticated** (no IP rate limiter on the SMTP path) and lacks all 4 timeout knobs. Under partial SMTP failure (DNS-stall, TCP-accept-but-no-EHLO), each request pins a handler at nodemailer's defaults (2-min TCP connect, unbounded socket reads, 30s greeting, 30s DNS).
- A 720-IP botnet sustaining 60 concurrent pinned handlers cascades into the argon2-semaphore (used by `/signup`, `/login`, `/recover`); under saturation those handlers return 503, **degrading login**.
- `/api/accreditation` and `/api/settings` are auth-gated but still take down request-handler threads under partial SMTP.
- `digest.ts` is a background cron — lower exposure but pins the worker.

The unauthenticated DoS amplifier is the P1 driver. The other three sites inherit the same multi-minute pin failure mode just without the public-internet attack surface.

## Goal

`grep -rn 'nodemailer.createTransport' backend/src/ --include='*.ts'` returns **zero hits outside `backend/src/lib/smtp.ts`**. Every transporter instantiation in the codebase routes through one canonical helper that pins the 5-field shape (host/port/secure/auth + 4 timeout knobs).

## Scope

### Structural (Finding 2)

1. **Move `createSmtpTransporter()` from `backend/src/routes/auth.ts:286-297` to `backend/src/lib/smtp.ts`.** Module-level export, no class wrapper. The file joins the existing `lib/` cross-route primitives (`argon2-error-handler.ts`, `log-pii.ts`, `authMessage.ts`).

2. **Update the 3 auth.ts call sites** (currently lines 571, 707, 999 — verify post-rebase) to import from `lib/smtp.js` instead of relying on the same-file export.

3. **Migrate the 4 sibling sites** to import and use `createSmtpTransporter()`:
   - `backend/src/digest.ts:110`
   - `backend/src/routes/contact.ts:32`
   - `backend/src/routes/accreditation.ts:264`
   - `backend/src/routes/settings.ts:43`

   Each site currently constructs its own options object inline; replace with `const transporter = createSmtpTransporter();`. Keep each site's existing surrounding `try/catch` and response-shaping logic — this task does NOT change error semantics on those routes; that's the scope of the separate `backend-signup-smtp-status-code-oracle.md` task and any future per-route oracle work.

4. **Update test imports** in `backend/tests/routes/auth-smtp-transporter.test.ts:31` to import from `lib/smtp.js` instead of `routes/auth.js`.

5. **Repo-wide grep test (or commit-time check):** add a single test that asserts `grep -rn 'nodemailer.createTransport' backend/src/` outputs only `backend/src/lib/smtp.ts`. This is the structural lock that prevents future regressions of the same shape.

### Docblock fixes at `lib/smtp.ts` (Findings 3, 4, 5(c), 8)

The docblock on `createSmtpTransporter` moves with the helper. During the move, apply four edits:

- **Finding 3 (~10s → 28s):** the line "All four together give a worst-case ceiling of ~10s under partial SMTP failure" is wrong about sequential cascades. Replace with: "Per-stage ceilings: 5s DNS + 5s TCP connect + 8s SMTP banner + 10s socket read. Single-stage failure caps at the dominant stage (~10s, dominated by `socketTimeout`); a sequential cascade where every stage stalls to its ceiling totals up to 28s. Size upstream timeouts and circuit-breaker windows against the 28s sequential figure, not the ~10s single-stage figure."

- **Finding 4 (dns.lookup fallback honesty):** add a sentence acknowledging that `dnsTimeout: 5000` only bounds nodemailer's `dns.Resolver` (resolve4/resolve6) path. When that returns no usable addresses, nodemailer falls back to `dns.lookup()` at `nodemailer/lib/shared/index.js:212` — that call receives no timeout and runs on libuv's thread pool. Under degraded system DNS the fallback is the live path. The other timers eventually fire from different anchor points, so the gap is partial. If telemetry surfaces real `dns.lookup` pins, file a follow-up to wrap the helper with a custom `dnsResolver` or pre-flight `dns.promises.lookup(host, {timeout: 5000})`.

- **Finding 5(c) (parity framing trim):** the existing docblock paragraph at `auth.ts:259-267` says round-2 "collapsed the three per-route inline calls (/signup, /reset-request, /resend-verification) into this single helper so every site gets the same canonical 5-field shape". After migration, the helper covers 7 sites across 5 files. More importantly, the parity claim is misleading: only **timeouts** are uniform across the auth routes. `/signup` still returns 500 on sendMail failure (account-row rollback) while the other two return uniform 200 (Option-C oracle closure). Trim language that implies status-code parity. The separate task `backend-signup-smtp-status-code-oracle.md` tracks the /signup oracle residual; the docblock should not preempt that decision.

- **Finding 8 (task-history paragraph removal):** the round-1/round-2 archaeological narrative is not load-bearing once the helper is in `lib/smtp.ts`. Replace it with a one-line cross-reference: `// See agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md for the full SMTP-failure oracle and timeout rationale.` Keep the per-stage rationale paragraph (currently `auth.ts:269-280` after the trims) verbatim — those lines explain *why* each timeout exists and are non-obvious.

### Function signature (Finding 9)

Add explicit return type annotation: `export function createSmtpTransporter(): nodemailer.Transporter { ... }`. Cross-reviewer convergence (maintainability + kieran-typescript) → anchor 100. Pins the contract against silent widening; documents the return shape on IDE hover without traversing nodemailer's six-overload set.

### Test changes (Findings 6, 7)

- **Finding 6 (split bundled toMatchObject):** in `backend/tests/routes/auth-smtp-transporter.test.ts:54-59`, the existing test claims "per-field assertions kill option-revert mutations one at a time" but uses a single bundled `expect(opts).toMatchObject({4 timeout fields})`. Split into 4 separate `expect()` calls so the diagnostic shape matches the comment's stated intent and a single dropped knob produces a clean per-field failure message. After the split, each `expect(opts.connectionTimeout).toBe(5000)` (etc.) line is itself the assertion that drops-of-that-field fail.

- **Finding 7 (clause-c risk-class header):** the test file header at `auth-smtp-transporter.test.ts:13-27` cites CLAUDE.md "Running Tests" carve-out clause (c) ("real-HAF variant of the same assertion exists or is filed as a follow-up") and names the BE-AUTH-SMTP-STATUS-CODE-ORACLE block in `recover.test.ts` as the companion. But that companion uses `mockReturnValue({sendMail: sendMailSpy} as any)` — discards the options arg, asserts on behavioral outcomes, not options-shape. The "same assertion" (options-shape pin) has no real-HAF mirror. **Rewrite the header** to acknowledge that clause (c) is satisfied at the *risk-class* level: helper unit covers options-shape mutations; the round-1 integration tests in `recover.test.ts` cover behavioral SMTP-failure mutations; together they cover the failure modes round-2 hold item 5 called for. The architect has filed a separate task (`architect-test-carve-out-clause-c-clarify.md`) to disambiguate the convention text for future authors; reference it in the header.

### Re-review attestation (Finding 10)

Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, the implementer's signal block on this task's `git mv` from `pending/` to `review/` MUST include an explicit attestation line of the form:

> Confirmed locally: dropping any single timeout knob from `lib/smtp.ts:createSmtpTransporter` fails the corresponding `expect()` in `auth-smtp-transporter.test.ts` with `expected <value>, received undefined`.

After the per-field split (Finding 6), each timeout knob has its own `expect(opts.<knob>).toBe(<value>)` line. Run vitest once with each knob deleted (in turn) and confirm the corresponding test fails. Record the four diagnostic excerpts (or a single representative excerpt) in the signal block.

The attestation also covers the cross-file migration: a structural test that `grep -rn 'nodemailer.createTransport' backend/src/` returns only `lib/smtp.ts` is itself mutation-evident — adding back any inline call fails the test.

## Non-goals

- Closing the `/signup` SMTP status-code oracle. That's the scope of `backend-signup-smtp-status-code-oracle.md` (P3, may need brainstorm — the account-row rollback question is genuinely architect-territory). Do NOT change the `/signup` sendMail catch behavior in this task.
- Bounding the `dns.lookup` fallback path. Documented as a partial gap in the helper docblock; closing it requires a custom `dnsResolver` or pre-flight resolve, both of which are non-trivial. File a follow-up only if telemetry surfaces real pins.
- Per-route per-tenant SMTP configuration, connection pooling, dead-letter queues for failed sends, retry semantics on the 4 migrated sites. Each is its own scope. The migration preserves existing error handling at each call site.

## Acceptance

- `grep -rn 'nodemailer.createTransport' backend/src/ --include='*.ts'` outputs only `backend/src/lib/smtp.ts`.
- `npm run lint` clean (only pre-existing accepted warnings).
- `npx tsc --noEmit` clean.
- `npx vitest run tests/routes/auth-smtp-transporter.test.ts` passes (with the per-field split).
- Targeted vitest on `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block passes (no behavioral regression).
- A spot-check vitest run on at least one of the 4 migrated sites' existing tests (e.g., `tests/routes/contact.test.ts` if it exists, or accreditation/settings/digest equivalents) passes.
- The signal block on `git mv` to `review/` includes the spec-fails-on-revert attestation per Finding 10.

## Cross-references

- Predecessor (round-2 archived 2026-05-04): `backend-auth-smtp-status-code-oracle.md` — see archive entry in `tasks-archive.md`.
- Sibling task (separate scope): `backend-signup-smtp-status-code-oracle.md` — closes the `/signup` status-code residual.
- Architect-owned follow-up (separate scope): `architect-test-carve-out-clause-c-clarify.md` — clarifies CLAUDE.md "Running Tests" clause (c) convention text.
- Conventions: `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`, `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, `auth-structured-log-shape-2026-04-29.md`.
