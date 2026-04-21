# SEC-LOGIN-UNKNOWN-USER-TIMING — Close the unknown-account timing oracle on /api/auth/login

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-004-BE round-2 archive review 2026-04-21c)
**Priority:** P2

## Context

SEC-004-BE round-2 added a `SENTINEL_ARGON2_HASH_PROMISE`-based timing-equalization burn on the `NO_PASSWORD_SET` (null-hash) branch of `POST /api/auth/login`, closing the `~1ms vs ~100ms` oracle that distinguished ORCID-only accounts from password-loginable accounts. The sibling **unknown-account** branch at `backend/src/routes/auth.ts:~388` returned `401 UNAUTHORIZED` without any argon2 work, leaving a separate timing oracle: an unauthenticated attacker can enumerate which usernames/emails have accounts on the platform.

Same enumeration class the round-2 fix addressed; closing only half was asymmetric and provided a false sense of completeness.

## Goal

Burn `SENTINEL_ARGON2_HASH_PROMISE` on the unknown-account branch and audit siblings across `/api/auth/*` for the same timing-oracle class. Expected to grow to 2-3 sites.

## Non-goals

Closing the status-code oracle (401 stays distinct). Rate-limit-based detection. Extracting a `burnSentinel()` helper unless 3+ call sites land.

## Implementation notes

Landed at commit **6c9a1e0** ("SEC-LOGIN-UNKNOWN-USER-TIMING: close unknown-account timing oracles on auth endpoints"). 19/19 pass in `backend/tests/routes/recover.test.ts`; full backend vitest 39 files / 268 pass.

Three sites converted, all mirroring the existing `SENTINEL_ARGON2_HASH_PROMISE` null-hash burn shape (`await argon2.verify(await SENTINEL_ARGON2_HASH_PROMISE, password).catch(() => {})` before the early return). Status codes unchanged.

1. `backend/src/routes/auth.ts:386` — `/login` unknown-username 401 branch.
2. `backend/src/routes/auth.ts:286` — `/resend-verification` unknown-email 200 branch (uniform-message response).
3. `backend/src/routes/auth.ts:675` — `/recover` unknown-username 404 branch.

Other early returns audited and intentionally left alone: `/reset-request` (uniform 200, SMTP-dominated timing); `/reset` (token-based, not user-enumerable); `/session`, `/signup` (don't have this oracle class); `/login` lockout + verify_token branches (post-argon2, already equalized).

Tests: 3 new `describe` blocks under `SEC-LOGIN-UNKNOWN-USER-TIMING:` with per-site wall-time assertions. Stability: 8/8 consecutive runs of the new tests passed locally.

## [TODO Architect]

1. **Wall-time threshold deviation.** Task spec called for ≥50ms matching the existing SEC-004-BE null-hash assertion. On this hardware `argon2.verify` at `ARGON2_OPTIONS` (64 MiB, time=3) runs 42-55ms median, so the new tests use ≥40ms (still 40× above the ~1ms pre-sentinel path, mutation-kill intact) with inline comment. The existing 50ms assertion already flakes here. Architect may want to revisit tolerance across the suite or tune `ARGON2_OPTIONS` for test envs.
2. **Rate-limit test-infra fix.** `recover.test.ts` gained a per-test `clearRateLimitKeys` helper (not just `beforeAll`) because vitest `retry=1` reruns only the test body, and the 3/hr `resendLimiter` had no headroom across a retry. Discretionary: generalize to a shared helper if other files need it.
3. **No `burnSentinel()` helper extracted.** Three sites landed right at the task's 3-call-site threshold. Kept inline since each call site has slightly different context comments; architect can request extraction at review if preferred.

---

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-1 `/ce-code-review` on commit `6c9a1e0` (10 personas including adversarial since diff crosses auth surface). Cross-reviewer convergence on 3 P1 oracle findings — the fix as-shipped **opens new enumeration oracles** that are worse than the one it closed for several account classes. Additional P2/P3 items bundled.

1. **P1 — `/resend-verification` oracle INVERTED for ORCID-only accounts** (adversarial 0.92 + correctness 0.88, 2-reviewer convergence). `auth.ts:299` short-circuits the ternary `account.password_hash ? argon2.verify(...) : false` when password_hash is null (ORCID-only accounts), returning in ~1ms. Unknown emails now cost ~50ms via the new sentinel burn. Response body + status identical. An attacker probes two emails: ~1ms = ORCID-only account exists, ~50ms = no account. The fix made enumeration WORSE for the ORCID-only subset (the platform's preferred identity path). Fix: add the same sentinel-burn pattern on the null-hash known-email sub-path BEFORE the `sendOk(res, {message:...})` early-return. Add one timing test asserting the null-hash known-email response wall-time is ≥40ms.

2. **P1 — `/recover` oracle INVERTED for ORCID recovery without password** (adversarial 0.81 + correctness 0.92, 2-reviewer convergence). `auth.ts:783-785` runs `argon2.hash` ONLY when `passwordProvided=true`. ORCID-based recovery (no new password) skips argon2 entirely → happy-path ~5-15ms. The sentinel burn on unknown-username costs ~50ms regardless. Unknown user slower than known-ORCID-recovery user. Exploitable by any ORCID account holder with their own `orcid_token`. Fix: gate the sentinel on `passwordProvided` — burn only when the happy path would run argon2.hash. For the no-password recovery path, both branches are cheap, no burn needed. Add one timing test for the ORCID-recovery-no-password path asserting unknown-username and known-username take similar time (neither >40ms).

3. **P1 — `/signup` enumeration oracle missed** (security 0.90). Implementer's out-of-scope rationale was wrong: `/signup` DOES have this oracle class. Already-registered email returns 409 DUPLICATE in ~1ms (before `argon2.hash`); new-email happy-path runs argon2.hash in ~50-100ms. Two orthogonal enumeration signals leak simultaneously (status code + timing). signupLimiter at 10/hr per-IP; distributed rate-limit bypass magnifies. Fix: add sentinel burn on the 409 DUPLICATE early-return path, matching the 3 existing sites. Add one timing test.

4. **P2 — Silent argon2 failures swallow security regression** (reliability 0.92 + security 0.65). All 4 sentinel burn sites use `.catch(() => { /* ignored */ })`. An argon2 crash (OOM, native module failure, libuv thread exhaustion) causes the burn to silently skip, returning in ~1ms, reopening the oracle with no operator signal. Fix: `logger.warn({ err }, 'argon2 sentinel burn failed')` inside each catch. Logger already imported and used throughout auth.ts. One-liner × 4 sites (3 existing + the /signup site added by item #3).

5. **P2 — `SENTINEL_ARGON2_HASH_PROMISE` startup-rejection unhandled** (reliability RR-002, 0.92). If `argon2.hash()` rejects at module load (missing native binding, memory pressure at boot), the promise is permanently rejected. Every `await SENTINEL_ARGON2_HASH_PROMISE` throws, every `.catch(() => {})` silently swallows, oracle permanently open for the lifetime of the process, zero operator signal. Fix: top-level rejection handler logging + either `process.exit(1)` (fail-loud for a security primitive) or at minimum `logger.error(...)` with a test that the sentinel pre-computed successfully at startup. Prefer fail-loud.

6. **P2 — `/resend-verification` timing test fails incorrectly when Redis unavailable** (testing 0.82). `clearRateLimitKeys` is a no-op when `redis.status !== 'ready'`, and the in-memory `memStore` closure inside `resendLimiter` cannot be cleared externally. Under `retry=1` without Redis, the 3/hr limiter exhausts across the retry: attempt 1 consumes 2 slots, attempt 2 sends warmup (slot 3, passes) + measured (slot 4, 429). The test fails for the wrong reason. Fix: add `skipIf(!redisReachable)` guard at the top of the `/resend-verification` timing spec, matching the existing `dbReachable` pattern. Alternative (test-only export of `resetMemStore()` from rateLimit.ts) is more work for the same mitigation value.

7. **P3 — Extract `burnSentinel()` helper** (maintainability M-02, 0.63). User triage: extract. With 4 sites after item #3 lands, the extraction threshold is clearly crossed. Helper shape: `async function burnSentinel(input?: string): Promise<void>` with a single docblock covering (a) the timing-equalization purpose, (b) why `.catch` is silent, (c) the 40ms-not-50ms threshold rationale. Default `input` is the caller's password; `/recover` passes `'recover-timing-dummy'` (or rename as module-level constant). Call sites become one-liners.

**Dismissed from round-1 findings (architect review):**
- **P3 40ms threshold 2ms below argon2 floor** (testing T-003): ship as-is. Worst case is CI flake, not security regression. Revisit on flake.
- **P3 Mixed 40/50ms thresholds without inline explanation** (maintainability M-04): subsumed by the helper extraction in item #7 — rationale lives in one docblock, per-site comments no longer needed.
- **P3 Concurrent-burn libuv thread pool saturation** (adversarial ADV-004): design-level concern, no actionable fix at this layer. Global argon2 concurrency cap is an infrastructure decision, not a code change.
- **P3 Statistical timing distinguisher under 1000+ samples** (adversarial ADV-005): 64MiB argon2id working set dominates cache warmth effects; distinguishability is marginal. Accepted residual.
- **Emdashes in comments** (project-standards PS-001, 0.72): rule is scoped to user-facing text; comments are fine. Pre-existing pattern.
- **File-header documentation of wall-time test justification** (project-standards PS-002, 0.80): inline per-site comments cover intent; file-header addition is discretionary polish.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-resend-verification-smtp-timing.md` — P2 SMTP sync-await timing oracle (adversarial ADV-002). The happy-path awaits `nodemailer.sendMail` (200-2000ms); sentinel equalizes only the argon2 portion. Known-pending-verification still distinguishable. Fix is architectural (fire-and-forget sendMail + 202 Accepted, or artificial delay padding); warrants independent design discussion.
- `backend-test-rate-limit-helper-extract.md` — P3 shared `clearRateLimitKeys` helper (maintainability M-03). Now the 4th copy of this pattern (this commit added the newest variant with a ready-wait poll that older copies lack). Consolidation candidate.
- `backend-rate-limit-xff-spoof-guard.md` — P2 pre-existing issue surfaced by security SEC-RATE-LIMIT-X-FORWARDED-FOR-SPOOFING (0.75). `rateLimit.ts:69-72` `byIp()` trusts raw X-Forwarded-For header without a trusted-proxy allowlist. IP rotation bypasses per-IP limits across all auth endpoints. Directly undermines the rate-limit defense layer the timing fixes rely on. Pre-existing, not introduced by this commit, but the commit surfaces it as load-bearing.

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/hive-signature-request-binding-shape-2026-04-21.md` — SETNX-with-fallback idiom in auth middleware; structurally similar pattern, confirms the repo's degrade-gracefully posture.
- `conventions/object-shape-fix-every-reset-site-2026-04-21.md` — "partial fix covering obvious branches leaves others open to the same bug class" — maps directly onto findings #13-15 (this commit is the partial fix).

**Path to re-archive:** (1) Backend applies items #1-7 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` (adversarial persona must dispatch again given the P1 inversions); archives on clean. Filed follow-up tasks archive independently.

---

**Backend re-review signal (2026-04-22, working tree on `main` post hold-block fixes):**

All 7 hold items addressed. Full backend vitest 276/279 pass + 3 skipped on the happy path (one more pass on the SEC-004-BE ≥50ms legacy assertion; still susceptible to the argon2-verify floor flake dismissed in the hold block as "ship as-is"). `recover.test.ts` alone: 21/22 with the same SEC-004-BE flake. `npx tsc --noEmit` clean.

1. **/resend-verification ORCID-only oracle INVERTED (P1 fixed).** `backend/src/routes/auth.ts:299-309` — the ternary `account.password_hash ? argon2.verify : false` was split into an explicit `if/else`, with `else { await burnSentinel(password); }` on the null-hash known-email path. Both branches now take ~50ms before hitting the uniform-message 200. Test at `recover.test.ts:569-625` seeds an account with `password_hash = NULL` and asserts the `/resend-verification` response to that email takes ≥40ms.
2. **/recover ORCID-no-password oracle INVERTED (P1 fixed).** `backend/src/routes/auth.ts:689-703` — the unknown-username sentinel burn is now gated on `passwordProvided`. ORCID-recovery-without-password callers see unknown and known branches both complete in ≤ a few ms (neither runs argon2). Test at `recover.test.ts:627-659` posts to `/api/auth/recover` without `new_password` and asserts the unknown-username response takes **less than** 40ms, which would fail if the sentinel burn fires.
3. **/signup enumeration oracle MISSED (P1 fixed).** `backend/src/routes/auth.ts:144-165` — 409 DUPLICATE early-returns now call `burnSentinel(password)` when `hasPassword` is true (email-signup or ORCID+email-signup with password). Test at `recover.test.ts:661-716` seeds a fully-verified account at `mit.edu` (real institutional domain so the 422 accreditation gate doesn't short-circuit), then asserts a second signup against the same email returns 409 DUPLICATE in ≥40ms.
4. **Silent argon2 failures logged (P2 fixed).** Consolidated inside `burnSentinel()` at `auth.ts:55-73`: one `try/catch` logs `argon2 sentinel burn failed — timing oracle may be open` on any failure (pre-computed-promise rejection, verify throw, native binding crash). All 7 call sites (4 pre-existing + 3 new from items #1-3) go through this one helper so adding another burn site in the future cannot regress the logging.
5. **SENTINEL_ARGON2_HASH_PROMISE startup rejection handler (P2 fixed).** `auth.ts:39-48` — top-level `.catch` on the startup promise logs and `process.exit(1)` (fail-loud per architect preference in the hold block). No unit test added for the fail-loud path directly — it would require forcing argon2 to reject at module load, which is environmental, not unit-testable without a mock of the `argon2` module that defeats the purpose. The existing `≥40ms` tests implicitly validate the sentinel resolved at module import (if it hadn't, those assertions would fail with `~1ms` elapsed).
6. **/resend-verification skipIf redis unreachable (P2 fixed).** `recover.test.ts:15-33` — added a `redisReachable` top-level flag mirroring `dbReachable`, waits up to 1s for `redis.status === 'ready'`. The `/resend-verification` timing spec at line 497 now uses `it.skipIf(!dbReachable || !redisReachable)` so it skips cleanly rather than failing 429 under retry when the in-memory rate-limit fallback is active.
7. **`burnSentinel()` helper extracted (P3 landed).** `auth.ts:55-73` — single helper with a long docblock covering the timing-equalization purpose, the silent-catch rationale, the ≥40ms threshold reason (argon2-verify floor), and the `input` parameter conventions. Default argument `'pevo-login-timing-sentinel-burn'` for sites that don't have a natural password to pass (only `/recover` unknown-username used `'recover-timing-dummy'` pre-extraction; that call now passes `new_password as string` since the burn is gated on `passwordProvided`). All 7 call sites are now one-liners: `await burnSentinel(password)` or `await burnSentinel(new_password as string)`.

**Dismissed-finding still-dismissed:** T-003 (40ms two-below-floor — accepted flake), M-04 (per-site threshold comments subsumed by helper docblock), ADV-004 (libuv thread pool saturation — infra decision), ADV-005 (1000-sample statistical distinguisher — residual accepted), PS-001 (emdashes in comments — rule is user-facing text), PS-002 (file-header wall-time justification — inline per-site comments are sufficient).

**Filed follow-up still-pending:** `backend-resend-verification-smtp-timing.md` (architectural, architect/user decision on shape), `backend-test-rate-limit-helper-extract.md` (test-infra refactor), `backend-rate-limit-xff-spoof-guard.md` (pre-existing) — per architect's hold block.

**Deviations from hold block:**

- Item #6: landed a top-level `redisReachable` flag instead of the alternative "`resetMemStore()` test-only export from `rateLimit.ts`". Architect explicitly noted the export was "more work for the same mitigation value"; the skipIf path ships the smaller change.
- No dedicated unit test for item #5's fail-loud path (see rationale above). If the architect requires one, I can mock the `argon2` module to reject on startup and assert `process.exit(1)` fired, but that mock undermines the actual security primitive under test.
