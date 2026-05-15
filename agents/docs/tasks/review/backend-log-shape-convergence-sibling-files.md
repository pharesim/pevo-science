# BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES — Migrate non-auth.ts route emissions onto the canonical structured-log shape

**Owner:** backend
**Created:** 2026-05-04 (architect, surfaced by `/ce-code-review` of `backend-auth-structured-log-convention-converge.md` round-1 — adversarial ADV-6 conf 70 + multi-reviewer corroboration)
**Priority:** P3

## Context

The auth-side convergence task (`backend-auth-structured-log-convention-converge`, commit `153605c`) reshaped all 18 logger.* emissions in `backend/src/routes/auth.ts` onto the canonical shape:

```ts
logger.<level>(
  {
    event: 'auth.<endpoint>.<sub_event>',
    route: 'auth.<endpoint>',
    email_hash?: hashEmailForLogs(email),
    emailKnown?: 'known' | 'unknown',
    err?: <Error>,
  },
  '<human-readable message>',
);
```

That task explicitly listed sibling-file migration as a non-goal: *"Migrating non-`auth.ts` routes onto the canonical shape. Scope is the auth surface; cross-cutting cleanup of accreditation/custody/settings/etc. is a follow-up if the auth-side convergence proves the shape."* The auth-side convergence is now archive-ready (held-pending-fixes for finishing touches but the shape itself has proved out); the follow-up condition is met.

## Goal

Migrate structured log emissions in non-auth.ts route files onto the canonical shape. The same merged shape applies, with the file-level prefix substituted for `auth.`:

- `backend/src/routes/accreditation.ts` → `accreditation.<endpoint>.<sub_event>` / `accreditation.<endpoint>`
- `backend/src/routes/custody.ts` → `custody.<endpoint>.<sub_event>` / `custody.<endpoint>`
- `backend/src/routes/signup-verify.ts` → `signup_verify.<endpoint>.<sub_event>` / `signup-verify.<endpoint>` (note: snake_case `signup_verify` for `event`, kebab-case `signup-verify` for `route`, mirroring the URL path)
- `backend/src/routes/settings.ts` → `settings.<endpoint>.<sub_event>` / `settings.<endpoint>`
- `backend/src/routes/orcid.ts` → `orcid.<endpoint>.<sub_event>` / `orcid.<endpoint>`
- Any other route file with structured log emissions in legacy shapes (run a grep before deciding the inventory)

## Acceptance

1. **Every structured log emission in the listed files** uses the canonical shape with the appropriate file-level prefix.
2. **CNPD compliance preserved:** any `email:` plaintext field migrates to `email_hash: hashEmailForLogs(...)` (or `safeHashEmailForLogs(...)` for nullable inputs, depending on the outcome of `backend-log-pii-email-hash` round-1 hold-fix item 1).
3. **No regression on operator-relevant log lines** — every key currently grepped/dashboarded by operators (`route`, `emailKnown`, `event`, `err`) remains present and named the same. Convergence is additive, not breaking.
4. **Spy-assertion coverage on operationally-critical emissions** per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. Pragmatic scope: outer-catch `*.failed` events, broadcast-failure / token-write-failure paths, any emission that drives an operator dashboard. Skip startup-time and helper-internal emissions where driving the path is structurally hard.
5. **`burnSentinel` helper emissions stay `auth.burn_sentinel.*`** — the helper lives in `auth.ts`; the convention's "prefix tags the file the emission lives in" rule means the auth.* prefix is correct even when called from custody.ts / signup-verify.ts. The hold-block on `backend-auth-structured-log-convention-converge` covers the inline-comment + convention-doc updates clarifying this for cross-file readers.
6. **Convention doc updates** at `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — narrow the title from "auth-route emissions" to whatever the realized scope is, OR file a sibling convention doc if the shape rules diverge for non-auth files. Architect's call when reviewing the migration.
7. **`npx tsc --noEmit` clean. `npm run lint` clean. Full backend vitest passes.**

## Non-goals

- Migrating non-route library code (e.g., `lib/argon2-error-handler.ts`, `lib/broadcast-error.ts`) — those have their own shape conventions (`event: 'argon2_abort_summary'` etc., per ARCHITECTURE.md Section 5). Scope is route-handler emissions.
- Adding new fields beyond the canonical set.
- A typed discriminated union for `event` strings — explicit-string approach is the convention's accepted enforcement model. Single-spec spy assertions kill the typo class without compile-time coupling.

## Suggested approach

1. Inventory: `rg -n 'logger\.(error|warn|info|debug)' backend/src/routes/` minus `auth.ts`. Group by file. The `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` convention applies — grep is the audit, not eyeballs.
2. For each file, choose the file-level prefix (per the list in Goal above).
3. Rewrite each emission in canonical shape.
4. Add spy assertions per acceptance #4 — likely 2-4 per file.
5. Run targeted vitest on the affected files plus full backend vitest as final check.

## Related

- `backend-auth-structured-log-convention-converge.md` (cluster A, 2026-05-04) — the auth-side proof.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — the convention doc defining the shape.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — apply during the audit step.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — apply during the spy-assertion design.

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `54532c2` with 5 personas (correctness, testing — re-run after first attempt got confused by a 89-commit diff range, maintainability, project-standards, learnings, adversarial). The 41 emissions migrated correctly onto the canonical shape. 20 spy assertions in the 3 updated test files (accreditation, custody, orcid) catch typo regressions on the renamed events with exact-match objectContaining. The implementer correctly preserved CNPD email-hashing across the migrated sites, kept burnSentinel emissions under `auth.burn_sentinel.*`, and respected the per-attempt vs error event role split in custody.ts.

But acceptance #4 (spy assertions on operationally-critical emissions per the mutation-kill convention) is unmet for two whole files plus three additional groups within the migrated files. Plus the convention doc title was not broadened — fixed inline by the architect in commit `c21d856`.

### Items to address

**1. (P1) signup-verify.ts: 4 new outer-catch `*.failed` events have ZERO spy coverage**

- Source: testing T1 (conf 100).
- File: `backend/tests/routes/signup-verify.test.ts` was untouched in commit `54532c2` despite signup-verify.ts gaining 4 new outer-catch events at the canonical shape.
- Missing specs:
  - `signup_verify.verify.failed` (signup-verify.ts ~line 122, outer-catch /verify)
  - `signup_verify.resume_signup.failed` (~line 232, outer-catch /resume-signup)
  - `signup_verify.confirm.failed` (~line 542, outer-catch /confirm)
  - `signup_verify.link.failed` (~line 755, outer-catch /link)
- The 2 existing `errorSpy` assertions in signup-verify.test.ts match by log MESSAGE text (emitted from broadcast-error.ts), NOT by `event` field — they do not cover these 4 new events. A typo or rename mutation on any of the 4 passes the entire suite green.
- Fix: 4 new spy assertions (one per event), each filtering by exact `event` value and asserting `route` + structural shape.

**2. (P1) settings.ts: 7 new event emissions have ZERO spy coverage; settings.test.ts has no logger-spy infrastructure**

- Source: testing T2 (conf 100).
- File: `backend/tests/routes/settings.test.ts` has no logger spy at all (the only mock is `verifyHiveSignature`). Commit `54532c2` added 7 new structured event fields; all are uncovered.
- Missing specs:
  - `settings.email_get.failed` (settings.ts ~line 86, outer-catch GET /email)
  - `settings.email_post.smtp_send_failed` (~line 160, SMTP failure POST /email)
  - `settings.email_post.failed` (~line 184, outer-catch POST /email)
  - `settings.email_verify.failed` (~line 273, outer-catch GET /email/verify/:token)
  - `settings.email_delete.light_account_login_loss` (~line 318, warn branch DELETE /email)
  - `settings.email_delete.failed` (~line 353, outer-catch DELETE /email)
  - `settings.set_password.failed` (~line 422, outer-catch POST /set-password)
- 5 of 7 are outer-catch error paths (the priority class per acceptance #4). 1 is an SMTP failure path. 1 is a defense-in-depth login-loss warning.
- Fix: introduce logger.error/logger.warn spy infra to settings.test.ts (model on accreditation.test.ts's pattern), then add a spy assertion per event. The existing accreditation/custody/orcid pattern (`mock.calls.find((args) => args[0]?.event === ...)` with exact-match) is the template.

**3. (P2) Sibling-event coverage gaps in orcid.ts (7), custody.ts (4), accreditation.ts (4)**

- Source: testing T3+T4+T5 (conf 95).
- These are NEW events in already-test-covered files, but they fall outside the 20 rename-only assertion sites the implementer updated. Critical paths uncovered:
  - **orcid.ts** (7 events, none asserted): `orcid.callback.token_exchange_failed`, `orcid.callback.failed`, `orcid.binding_lock.release_failed`, `orcid.binding_cache.write_failed`, `orcid.binding_cache.read_failed`, `orcid.works_fetch.failed`, `orcid.account_update.transient_failed`. All error paths.
  - **custody.ts** (4 events, none asserted): `custody.broadcast.fresh_auth_rejected`, `custody.fresh_auth.failed`, `custody.upgrade.null_hash_unreachable`, `custody.upgrade.failed`. fresh_auth_rejected and fresh_auth.failed are operationally-critical rejection/outer-catch; null_hash_unreachable is a safety sentinel; upgrade.failed is outer-catch.
  - **accreditation.ts** (4 events, none asserted): `accreditation.request.smtp_send_failed`, `accreditation.request.smtp_not_configured`, `accreditation.verify.token_cleanup_failed`, `accreditation.cleanup.failed`. token_cleanup_failed has partial coverage by message-text match at accreditation.test.ts:414 but no `event` field assertion.
- Fix: spy assertions on each event using the established pattern. Pragmatic priority: outer-catch `*.failed` events first, then SMTP/operational paths. Skip startup-time and helper-internal emissions where driving the path is structurally hard (per acceptance #4's pragmatic-scope carve-out).

### Items dismissed during architect triage (do NOT address)

- **Wholesale event rename without alias period or dual-emit (adversarial)** — single-instance PEvO has no production aggregator dashboards; no rolling-deploy split-brain. Acceptable here.
- **5 unmigrated emissions in signup-verify.ts (correctness residual)** — out of THIS task's scope; flagged for a future targeted sweep if those paths surface operationally.
- **Stale event names in `it()` description strings at orcid.test.ts:2186/2678** — descriptive only; assertion bodies updated correctly. Cosmetic doc drift, not a regression vector.
- **Doc-comment drift at orcid.ts:1205-1206 / orcid.test.ts:2668,2730** — same class as above; cosmetic.
- **`safeHashEmailForLogs` → `hashEmailForLogs` swap in signup-verify.ts (learnings residual)** — verified at HEAD: the swap is correct because the call sites are now downstream of typed-non-null DB rows; no nullable-input regression introduced.

### Re-review signal

When items 1, 2, 3 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. Convention-doc scope update (acceptance #6) is already done by the architect in commit `c21d856`; not in implementer scope.

---

## Backend re-review signal (2026-05-15) — round 2

Items 1, 2, and 3 (parts A + B + C) landed via parallel worker fan-out, then cherry-picked onto main:

- **Item 1 (P1) — signup-verify.ts** (commit `bac0615`, was worker SHA `d54a288`):
  4 new spy-assertion specs in `backend/tests/routes/signup-verify.test.ts` covering `signup_verify.verify.failed`, `signup_verify.resume_signup.failed`, `signup_verify.confirm.failed`, `signup_verify.link.failed`. Each driven via per-test `pool.query` patch that throws on first call only and restored in finally. The `/link` spec uses real `verifyHiveSignature` with a deterministic signed request and primes `getAccountsMock`. Mutation-kill verified per spec (typo on event literal → red, restore → green).

- **Item 2 (P1) — settings.ts** (commit `ade1d20`, was worker SHA `313f775`):
  7 new spy-assertion specs in `backend/tests/routes/settings.test.ts` covering all 7 emissions (`settings.email_get.failed`, `settings.email_post.smtp_send_failed`, `settings.email_post.failed`, `settings.email_verify.failed`, `settings.email_delete.light_account_login_loss`, `settings.email_delete.failed`, `settings.set_password.failed`). Introduced fresh logger-spy infrastructure in this file (settings.test.ts previously had no logger spy, only `MOCK_VERIFY_SIGNATURE`): `findEvent` helper, `nodemailer` import, `logger` import, `clearRateLimitKeys` import, file-header carve-out docblock (clauses a/b/c). Mutation-killed per spec.

- **Item 3 part A (P2) — orcid.ts** (commit `21eb8b7`, was worker SHA `8e6dabc`):
  7 new spy assertions in `backend/tests/routes/orcid.test.ts` covering `orcid.callback.token_exchange_failed`, `orcid.callback.failed`, `orcid.binding_lock.release_failed`, `orcid.binding_cache.write_failed`, `orcid.binding_cache.read_failed`, `orcid.works_fetch.failed`, `orcid.account_update.transient_failed`. Drivers: fetch-stub for token-exchange + works-fetch + outer-catch, narrow `redis.set`/`redis.get`/`redis.eval` rejections for binding cache/lock paths, direct `__test_seams.updateAccountOrcid` against pg `08006` for transient failure. All 7 mutation-killed.

- **Item 3 part B (P2) — custody.ts** + **Item 3 part C (P2) — accreditation.ts** (commit `8200b85`, was worker SHA `d948bd5`):
  4 specs in `custody.test.ts` covering `custody.broadcast.fresh_auth_rejected` (consent-op bundle without `fresh_auth_proof`), `custody.fresh_auth.failed` (per-test `appQueryMock` throw), `custody.upgrade.null_hash_unreachable` (per-test impl returns `password_hash: null`), `custody.upgrade.failed` (per-test impl throws on `password_hash` SELECT, distinct usernames per test to dodge per-account `upgradeLimiter` max=1/hr). 4 specs in `accreditation.test.ts` covering `accreditation.request.smtp_send_failed`, `accreditation.request.smtp_not_configured`, `accreditation.verify.token_cleanup_failed` (pins `event` field; prior spec at line 414 only matched message-substring), `accreditation.cleanup.failed` (captures the `setInterval` callback via `globalThis.setInterval` spy + `vi.resetModules()` re-import; forces a rejection by patching `Map.prototype[Symbol.iterator]` for one call so `cleanupExpiredTokens`'s for-of throws — documented inline as a future-proofing log-shape pin, real-path companion infeasible without route-file `__test_seams` expansion). All 8 mutation-killed.

### Verification

- `npx tsc --noEmit` — clean across all 5 modified files.
- `npm run lint` — clean (only pre-existing seed-phrase warnings).
- Targeted vitest per file, all new specs pass. Pre-existing intentional reds and unrelated flakes (2 SEC-004-BE in signup-verify; 6 unrelated `Settings email (with DB)` maskEmail/stale-row reds; 1 `concurrent retries claim slots atomically` flaky concurrency red in accreditation; 2 documented intentional reds in accreditation forcing functions for `backend-bridge-key-startup-validation-and-pino-redact.md`) are NOT introduced by this round and reproduce on HEAD before this round's diff was applied.
- Mutation-kill verified on every new spec per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`.

### Coordination notes

- Worker fan-out: 4 parallel worktree subagents (`agent-a5a90b2f375f7ce9f`, `agent-aab0a845914612d30`, `agent-a16031c1f3bd7321c`, `agent-ae9b5c276d40cd715`). No file overlap between workers; cherry-picks onto main were clean (no conflicts on test files).
- Workers were instructed not to modify the task file or route files; this signal block is the parent's unified summary.
- Total: 23 new spy assertions across 5 test files (4 + 7 + 7 + 4 + 4 — wait, recount: 4 sigup-verify + 7 settings + 7 orcid + 4 custody + 4 accreditation = 26).
