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

---

## Backend signal (2026-05-05, working tree at this commit)

**Files changed**

- New: `backend/src/lib/smtp.ts` — `createSmtpTransporter()` moved here with explicit `nodemailer.Transporter` return type. Docblock applies Findings 3 (28s sequential cascade ceiling), 4 (`dns.lookup` fallback caveat), 5(c) (parity-framing trim — only timeouts are uniform across the auth routes; status-code parity claim removed), 8 (round-1/round-2 archaeological narrative replaced with one-line cross-reference to the timing-equalization convention).
- New: `backend/tests/lib/smtp-helper-exhaustive-call-sites.test.ts` — the structural lock that asserts `grep -rln 'nodemailer.createTransport' backend/src/` returns only `src/lib/smtp.ts`. Implements the convention via `execFileSync('grep', ...)`; treats grep's exit-1 (no matches) as an empty result so a future move that drops the helper entirely also fails the assertion.
- Modified: `backend/src/routes/auth.ts` — removed the in-file `createSmtpTransporter()` definition + its docblock; removed the now-unused `nodemailer` import; added `import { createSmtpTransporter } from '../lib/smtp.js';`. The 3 in-file call sites at lines 531, 667, 959 (post-move offsets) continue to call the helper; only the import-source changed.
- Modified: `backend/src/digest.ts`, `backend/src/routes/contact.ts`, `backend/src/routes/settings.ts`, `backend/src/routes/accreditation.ts` — each migrated from inline `nodemailer.createTransport({...})` to `createSmtpTransporter()`; each removed its `nodemailer` import in favor of `createSmtpTransporter` from `../lib/smtp.js` (or `./lib/smtp.js` for `digest.ts`). Each site's existing surrounding `try/catch` and response-shaping logic preserved unchanged.
- Modified: `backend/tests/routes/auth-smtp-transporter.test.ts` — Finding 6 split: the bundled `toMatchObject({4 timeouts})` is now 4 separate `expect(opts.<knob>).toBe(<value>)` calls, one per `it(...)` block, so dropping any single knob fails the matching expectation with `expected <value>, received undefined` rather than a single bundled object diagnostic. Finding 7 header rewrite: clause-c is satisfied at the *risk class* level — option-shape mutations caught here, behavioral SMTP-failure mutations caught in `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block. References the architect's `architect-test-carve-out-clause-c-clarify` task. Import path updated to `../../src/lib/smtp.js`.

**Verification**

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing accepted `seed-phrase.ts` warnings, untouched).
- `npx vitest run tests/routes/auth-smtp-transporter.test.ts tests/lib/smtp-helper-exhaustive-call-sites.test.ts` — 8/8 pass.
- `npx vitest run tests/routes/recover.test.ts -t "BE-AUTH-SMTP-STATUS-CODE-ORACLE"` — 4/4 pass (no behavioral regression; sendMail-rejects → uniform 200 still holds with the helper at its new location).
- `npx vitest run tests/routes/accreditation.test.ts -t "POST /api/accreditation/request"` — 5/5 pass (the `/request` describe block is the SMTP-relevant area for accreditation).
- Pre-existing failures in `accreditation.test.ts` (2 specs in the BE-VERIFY-BROADCAST-ATTEMPTS-CAP `/verify` block — `round-3 hold #5` and a sibling) are unrelated to this task. They fail on a regex `/[0-9a-f]{64}/` against the serialized `redis.decr` `ReplyError` payload, which carries the full Redis key `pevotest:pending_accred_broadcast_attempts:<token-sha256>` (the 64-hex match comes from the key suffix). The `/verify` cap path is owned by `backend-verify-broadcast-attempts-cap.md` (still in `tasks/review/`); my diff to `accreditation.ts` is purely the `/request` SMTP transporter migration and does not touch the `/verify` decrement, redis, or logging code.
- Spec-fails-on-revert attestation per Finding 10 / `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`:
  > Confirmed locally: dropping any single timeout knob from `lib/smtp.ts:createSmtpTransporter` fails the corresponding `expect()` in `auth-smtp-transporter.test.ts` with `expected undefined to be <value>`. Each of the 4 knobs (`connectionTimeout`, `socketTimeout`, `greetingTimeout`, `dnsTimeout`) was deleted in turn (sed-d, restored from snapshot between runs), the `-t '<knob>'` filter was applied to vitest, and the matching `it(...)` block failed.
  >
  > Representative diagnostic (knob: `connectionTimeout`):
  >
  > ```
  > AssertionError: expected undefined to be 5000 // Object.is equality
  >
  > - Expected:
  > 5000
  >
  > + Received:
  > undefined
  > ```
  >
  > The remaining three knobs failed in identical shape, varying only the expected scalar (`socketTimeout: 10000`, `greetingTimeout: 8000`, `dnsTimeout: 5000`). The structural grep test in `tests/lib/smtp-helper-exhaustive-call-sites.test.ts` is itself mutation-evident: re-introducing any direct `nodemailer.createTransport(...)` call outside `src/lib/smtp.ts` fails its `toEqual(['src/lib/smtp.ts'])` expectation.

**Architect notes**

- No `[TODO Architect]` markers were added. The task body did not require contract-file edits — `agents/docs/api-contracts/*.md` is unchanged because no route shape or response code changed; the migration is purely structural. The separate `/signup` status-code residual (in `tasks/blocked/backend-signup-smtp-status-code-oracle.md`) is the contract-relevant follow-up and is properly scoped out of this task.
- The convention referenced in the helper docblock (`agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`) is left untouched. If a follow-up wants to widen its title from "auth-route emissions" to the now-broader 7-site call-site set, the architect owns that edit; backend has not pre-empted it.

## Architect re-review (2026-05-21, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on round-1 commit `f8eb1725` with 7 reviewer personas (correctness on Opus; testing, maintainability, project-standards, reliability, learnings-researcher on Sonnet; security and adversarial on Opus; `ce-agent-native-reviewer` skipped per PEvO `CLAUDE.md`). Helper extraction is byte-identical at the 4 sibling sites; auth.ts imports correctly; surrounding error handling preserved at every migration site; per-knob mutation-kill attestation is sound. Two round-2 items hold — one P1 wiring-axis defect surfaced by adversarial + reliability + security cross-reviewer convergence, one P3 external-library line-number anchor in production code.

### Items to address (one round-2 commit)

**1. (P1, anchor 75, cross-reviewer convergence — adversarial + reliability + security + testing-residual + maintainability-gap) `backend/tests/lib/smtp-helper-exhaustive-call-sites.test.ts` structural grep test is bypassable via 5 idiomatic nodemailer import shapes.** The test greps for the literal substring `nodemailer.createTransport`. Five concrete bypass shapes produce a working timeout-less transporter while passing the lock:

   - Named import: `import { createTransport } from 'nodemailer'; createTransport({...});`
   - Namespace import: `import * as nm from 'nodemailer'; nm.createTransport({...});`
   - Renamed default: `import mailer from 'nodemailer'; mailer.createTransport({...});`
   - CJS destructure: `const { createTransport } = require('nodemailer');`
   - Bracket access: `nodemailer['createTransport']({...});`

   The named-import shape is documented in nodemailer's own README as idiomatic. A future contributor (human or agent) reintroducing the un-timed transporter via that shape is plausible, not theoretical. The structural lock is the load-bearing wiring-axis assertion under the carve-out clause-(c) "risk-class equivalence" framing (per `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`) — if it doesn't enforce the no-direct-call invariant, the entire convention layer of the test family is hollow.

   Fix: tighten the grep target from `nodemailer\.createTransport` to a pattern that matches any nodemailer import statement regardless of shape — `from ['\"]nodemailer['\"]`. Any file outside `lib/smtp.ts` that imports nodemailer fails the test. Closes all 5 bypass shapes. ~1 LOC change in the test file; mutation-kill attestation in the next signal block should add a brief note that each of the 5 bypass shapes was constructed in a scratch fixture and the new grep target rejected each.

**2. (P3, cross-reviewer convergence — maintainability + project-standards + security-info) `backend/src/lib/smtp.ts` docblock cites external-library line number `nodemailer/lib/shared/index.js:212`.** Raw line-number anchor on a file we do not control — drifts on any `npm update nodemailer` that adds or removes a line above 212. The convention scope (per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`) enumerates PEvO-internal docblock refs as the primary worked example; external-library refs are at minimum the same rot class with worse drift dynamics. Rephrase to a behavioral anchor: "inside its `dns.Resolver` shared helper" / "in nodemailer's shared DNS-resolution code path" / equivalent. Preserves the load-bearing information (the fallback exists, runs without timeout, runs on libuv pool); drops the rot-prone `:212`. ~1 LOC.

### Items dismissed at architect triage (recorded for transparency, not held)

- **dns.lookup + libuv-pool + argon2 coupling not stated in docblock** (adversarial, conf 50). The structural fix (custom `dnsResolver` or pre-flight `dns.promises.lookup`) is explicitly scoped out by task non-goal #2 pending telemetry. Adversarial confidence is at the action threshold; PEvO memory `project_single_instance_only` bounds the threat model considerably; adding a "here's a known scary thing" doc note without operator-decided guardrail values risks low-actionability documentation. If telemetry surfaces real `dns.lookup` pins, file a follow-up; not blocking round-1 archive.
- **Structural lock as single-point-of-failure** (adversarial, conf 75). Depth-of-defense observation; no per-test fix in scope. The hardening (`from 'nodemailer'` grep tightening in item 1) closes the more concrete defect at the same site.
- **Task framing of `/api/contact` as "no rate limiter on SMTP path"** (adversarial + security). FALSE per security review — `contactLimiter` at `contact.ts:17` is `windowMs: 3_600_000, max: 5, keyFn: byIp`. The argon2-semaphore cascade scenario in the task body also does NOT mechanically hold per security (contact handler has no `runWithArgon2Slot`). The fix is still load-bearing — the real amplifier closed is the event-loop / SMTP-handler pin under partial SMTP failure, not the argon2-semaphore. Note for the eventual archive entry: the task body's threat-model framing was partly inaccurate but the structural fix is correct and the convention rule the fix operationalizes is sound.
- **Per-call transporter instantiation in digest loop** (security, reliability). Operational cost only; bounded by 28s ceiling.
- **No integration test for digest.ts/contact.ts/settings.ts SMTP-failure timing** (testing). Theoretical preemptive coverage per memory `feedback_dismiss_preemptive_test_hardening`; the option-shape pin + structural lock (after item 1 tightening) cover the helper-application axis; behavioral SMTP-failure coverage is at `recover.test.ts` BE-AUTH-SMTP-STATUS-CODE-ORACLE block.

### Architect notes (no implementer action — grandfathered)

- **`backend/src/lib/smtp.ts` docblock cites `BE-AUTH-SMTP-STATUS-CODE-ORACLE round-1`** (production-code task-slug + round-number citation, per project-standards + maintainability + learnings).
- **`backend/tests/lib/smtp-helper-exhaustive-call-sites.test.ts` header narrates "round-1 of BE-AUTH-SMTP-STATUS-CODE-ORACLE lost the /signup site"** (test-file slug + round citation).
- **`backend/tests/routes/auth-smtp-transporter.test.ts:27-29` "See architect-test-carve-out-clause-c-clarify (architect task)"** (test-file "see task <slug>" redirect, the exact shape the convention prohibits).

  Convention `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` was filed 2026-05-15; this commit landed 2026-05-05 (10 days pre-convention). Per learnings researcher: "Surface as forward-looking cleanup, not a round-1 finding." Grandfathered per timing; the in-flight `backend-comment-anchor-sweep-*` task series picks these sites up on its next pass. Will be noted in the eventual archive entry.

### Re-review signal

When items 1-2 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

