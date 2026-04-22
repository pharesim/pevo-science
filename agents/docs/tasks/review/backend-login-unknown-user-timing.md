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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES (round 2):**

Round-2 `/ce-code-review` on commit `1263f97` (10 personas: correctness, testing, security, adversarial, reliability, maintainability, project-standards, kieran-typescript, ce-agent-native, ce-learnings-researcher). Round-1's 7 hold items each applied. Round-2 surfaced **two factual errors in the backend re-review signal**, five further oracle gaps (including a P2 re-review signal claim that contradicts the code), and a pile of test-hygiene and code-hygiene items. Task stays in held-pending-fixes with a large round-3 bundle.

**Re-review signal factual errors to note:**
- "Other early returns audited and intentionally left alone: `/login` lockout + verify_token branches (post-argon2, already equalized)" — **incorrect**. Lockout (ACCOUNT_LOCKED 403) fires **before** `argon2.verify` in the code flow; it is not equalized. See hold item #1.
- Docblock at `auth.ts:25-31` now implies comprehensive coverage of cheap early-returns across auth endpoints. `/reset-request` is a cheap early-return not covered. See hold item #5.

Hold-block items below:

1. **P1 — `/login` ACCOUNT_LOCKED branch has no burnSentinel (re-review signal claim is wrong)** (testing T-002 0.82). `auth.ts:~512` short-circuits 403 ACCOUNT_LOCKED before `argon2.verify`. Locked known-username ~2-5ms vs active-wrong-password ~50ms — attacker with a known username distinguishes "this account is locked" (useful post-credential-stuffing to pick which accounts are already compromised). Fix: add `await burnSentinel(password)` immediately before the 403 return. Add a timing test asserting ≥40ms on the lockout branch (mirrors existing patterns).

2. **P1 — `/signup` pending-unverified (`verify_token` = hex) fall-through path unguarded** (adversarial ADV-R2-005 0.91). `auth.ts:184-200` has three email-already-registered branches: (a) `verify_token === null` burnSentinel → 409 ~50ms, (b) `verify_token.startsWith('confirmed:')` burnSentinel → 409 ~50ms, (c) `verify_token = hex` fall-through runs `argon2.hash` + upsert → ~100ms and likely 201 status. Three distinct timing+status signatures distinguish account state. Combined fix with item #3 below.

3. **P2 — burnSentinel uses argon2.verify (~50ms) but `/signup` happy-path uses argon2.hash (~100ms); hash-vs-verify asymmetry** (adversarial ADV-R2-001 0.82). Sentinel-burn was designed for verify-paired endpoints (/login, /resend-verification verify-password). On `/signup`, the 409 DUPLICATE path running burnSentinel and the happy-path running `argon2.hash` differ by ~2x. Fix items #2 + #3 together: **on `/signup` 409 DUPLICATE paths, replace `burnSentinel(password)` with `await argon2.hash(password, ARGON2_OPTIONS).catch(() => {})`** (discard the result — purely CPU time equalization). Applies to both the `verify_token === null` and `verify_token.startsWith('confirmed:')` paths. For the fall-through (#2): since it already pays `argon2.hash` cost via the upsert flow, no additional burn is needed there — confirm the 4-way path timing matrix (unknown + hash, known-null + hash, known-confirmed + hash, known-pending + hash) all round to ~100ms. Add timing tests asserting each path takes ≥40ms (the four paths don't need equal means, just none-in-the-~1-5ms band).

4. **P2 — burnSentinel silently opens oracle on attacker-controlled oversized input** (security SEC-R2-005 0.68). `argon2.verify` rejects inputs >4096 bytes BEFORE entering the compute phase. An attacker sending a >4096-byte password / input to `/login`, `/signup`, `/resend-verification`, or `/recover` gets burnSentinel returning in ~0ms via the silent catch. Fix: add `const safeInput = input.length > 1024 ? input.slice(0, 1024) : input;` inside burnSentinel before the `argon2.verify` call, so oversize inputs never short-circuit the compute phase. Add a test: send a >4096-byte password to `/login` with an unknown username, assert response ≥40ms.

5. **P2 — `/reset-request` has no burnSentinel; 200x unknown-vs-known timing oracle** (security SEC-R2-003 0.82 + adversarial ADV-R2-006 0.94). `auth.ts:~553-556` unknown email returns 200 in ~1ms; known email runs DB UPDATE + `await sendMail()` for 100-2000ms. Round-1's "SMTP-dominated timing" rationale was factually wrong — the unknown branch skips SMTP entirely. Fix: add `await burnSentinel(email)` before the unknown-email 200 early-return. Update the burnSentinel docblock at `auth.ts:25-31` to correctly list `/reset-request` as covered. Add a timing test mirroring the `/resend-verification` shape. Note: the SMTP-tail oracle on the known-email path is out of scope here; pre-filed as `backend-resend-verification-smtp-timing.md`. This hold item only closes the cheap-early-return half.

6. **P2 — `process.exit(1)` may race pino async log flush in dev transport** (security SEC-R2-002 0.75 + reliability REL-001 0.62). Production path (SonicBoom) is safe; dev path (worker-thread `pino/file` transport) has a documented sporadic race. If `SENTINEL_ARGON2_HASH_PROMISE` rejects during very early module init before the transport worker finishes startup, the error log is lost. Operator sees container restart with no diagnostic. Fix: replace `process.exit(1)` at `auth.ts:46-49` with `logger.flush?.(() => process.exit(1))` — drains the transport buffer before exit; safe in both transport and non-transport configs. 1 LOC change.

7. **P2 — `/resend-verification` three-way message-body oracle leaks account state** (security SEC-R2-001 0.85; **user decision: preserve privacy — unify messages**). `auth.ts:362-367` emits three distinct 200 response bodies for callers supplying a correct password: "already active", "already verified", "pending signup link sent". Any password-holder can probe other emails and read back account state. Timing equalization doesn't collapse the message-body axis. Fix per user decision: collapse all three branches to the uniform `"If that email has a pending signup..."` message (the generic fallback). Response status codes unchanged. Add a test asserting all three post-auth-success branches return the same message body — any divergence should fail loudly.

8. **P2 — timing test threshold calibration + retry masking** (testing T-001 0.85 upper-bound + testing T-003 0.78 lower-bound + adversarial ADV-R2-007 0.72). Two brittleness risks compound under `retry=1`: (a) `/recover` `<40ms` upper-bound assertion is fragile under stressed CI (DB + supertest + Express overhead alone can exceed 40ms without argon2); (b) `≥40ms` lower-bound is 2ms below the documented argon2 floor (42-55ms), and on faster hosts the floor drops to ~28ms while tests still pass, leaving a production oracle invisible at 28ms. `retry=1` masks first-flap. Fix: raise the upper-bound assertion from `<40ms` to `<150ms` with an inline comment explaining "no-burn path is structurally incapable of reaching 150ms without argon2"; lower the ≥40ms assertion to ≥35ms with a comment tying the choice to the fastest plausible production argon2 floor. If a shared module-level constant `TIMING_ORACLE_FLOOR_MS = 35` is added near the `burnSentinel` docblock, reference it in assertions across the test file.

9. **P3 — `burnSentinel` default parameter is dead** (maintainability M-04 0.95 + kieran-typescript KT-003 0.72). All 7 call sites pass an explicit argument. Either remove the default (interface becomes self-documenting — callers MUST specify the input) OR lift the literal to a named constant `SENTINEL_BURN_DUMMY_INPUT = 'pevo-login-timing-sentinel-burn'` with a doc comment explaining the value is arbitrary. Prefer removing the default.

10. **P3 — Task-slug comment at `auth.ts:346` will rot** (maintainability M-01 0.72). `// SEC-LOGIN-UNKNOWN-USER-TIMING hold #1:` in production source. Rewrite as self-contained rationale: the comment body already explains the WHY; drop the task-slug prefix. Apply the same pattern to any other `hold #N` references in the file (test describe names are a lesser concern since they only appear in CI output).

11. **P3 — `recover.test.ts` describe-block naming is split round-1 vs round-2** (maintainability M-02 0.68). Round-1 blocks: `SEC-LOGIN-UNKNOWN-USER-TIMING: /<endpoint> <detail>`. Round-2: `SEC-LOGIN-UNKNOWN-USER-TIMING hold #N: /<endpoint> <detail>`. Normalize to one shape (prefer the round-1 simpler form; drop "hold #N" qualifier — the prose comment above the describe already carries context).

12. **P3 — Dead `// eslint-disable-next-line @typescript-eslint/no-explicit-any` at `auth.ts:47`** (kieran-typescript KT-001 0.82). Repo has no ESLint config; the rule doesn't exist; the suppress comment silences nothing and misleads readers. Delete the comment (or narrow `err` to `unknown` with an explicit handler-local cast). See also `backend-enable-eslint-ts-rules.md` pending task which addresses the larger infrastructure gap.

13. **P3 — `hasPassword` inferred as `string | false`, not `boolean`** (kieran-typescript KT-004 0.65). `const hasPassword = password && typeof password === 'string'` preserves short-circuit type. Flow narrowing through the intermediate variable fails, forcing `as string` casts downstream. Fix: `const hasPassword: boolean = !!(password && typeof password === 'string')` — makes the type precise even though `as string` elsewhere still needs the broader Zod refactor tracked in `backend-request-body-typing-zod.md`.

14. **P3 — `redisReachable` startup block lacks try/catch** (reliability REL-003 0.65). `backend/tests/routes/recover.test.ts:326` — the new flag probes `redis.status` but has no try/catch wrapping the polling; if `getRedis()` throws or `.status` access fails, the exception propagates as an unhandled rejection at module evaluation time, failing the entire test file with a misleading error. Mirror the `dbReachable` block's try/catch pattern (the existing reference at `recover.test.ts:17-28`).

**Dismissed from round-2 findings (architect triage):**
- **P3** Restart-loop DoS under argon2 OOM at module load + Docker restart policy (adversarial ADV-R2-002 0.75): fail-loud is architect-intended. Monitoring / restart-backoff are out-of-code infra concerns tracked separately.
- **P3** SMTP tail oracle on `/resend-verification` happy path (adversarial ADV-R2-003 0.88): pre-filed as `backend-resend-verification-smtp-timing.md`. Not in this hold.
- **P3** `new_password as string` / `password as string` vacuous casts (kieran-typescript KT-002 0.78): pre-existing pattern across req.body-typed `any` code; fix requires Zod-parse adoption. Filed as `backend-request-body-typing-zod.md` (new pending task in this review pass).
- **P3** `burnSentinel` `Promise<void>` doesn't enforce await (reliability REL-002 0.70): no-floating-promises lint rule is the fix. Filed as `backend-enable-eslint-ts-rules.md` (new pending task in this review pass).

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-argon2-concurrency-cap.md` (P2) — libuv thread-pool saturation path that silently reopens every oracle burnSentinel is supposed to close. Infra knob (UV_THREADPOOL_SIZE) plus optional JS-level semaphore.
- `backend-signup-institutional-gate-ordering.md` (P2) — 422-vs-409 institutional-email timing oracle on `/signup`. **User pre-decision: equalize via gate reorder** (duplicate-email check before accreditation gate). Backend implements per the captured decision.
- `backend-request-body-typing-zod.md` (P3) — Zod schemas for auth/signup/orcid/recover request bodies; replaces the `as string` cast class.
- `backend-enable-eslint-ts-rules.md` (P3) — minimal ESLint config enforcing no-floating-promises; closes the burnSentinel fire-and-forget risk and the dead `eslint-disable` comment pattern.

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — exactly the failure arc round-1→round-2 documented. Its 5-step checklist should be walked against this hold-block diff at round-3 re-review.
- **New `/ce-compound` candidate at archive time:** `redisReachable` skipIf poll pattern (up to 20×50ms ticks + `it.skipIf(!dbReachable || !redisReachable)`). Not currently in solutions/; likely to recur on any future timing test that depends on a live Redis-backed rate limiter.

**Path to re-archive:** (1) Backend applies items #1-14 on this task (bundled into a single round-3 fix commit, grouped into auth.ts source + recover.test.ts tests). (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-3 with `/ce-code-review` — adversarial + security personas mandatory given the P1 findings. Archives on clean. Filed follow-up tasks archive independently.

---

**Backend re-review signal (2026-04-22 round-3, commit `4a83eef`, worktree `.claude/worktrees/agent-ab26cac9`):**

All 14 round-2 hold items landed in a single commit on the worktree branch (parent agent merges). `npx tsc --noEmit` clean. `backend/tests/routes/recover.test.ts` 27/27 pass on two consecutive runs. Full backend vitest suite deferred to parent per coordination rules.

1. **P1 /login ACCOUNT_LOCKED burnSentinel (fixed).** `auth.ts` — added `await burnSentinel(password)` before the 403 ACCOUNT_LOCKED return at the "Active account — check lockout" block. Timing test `SEC-LOGIN-UNKNOWN-USER-TIMING: /login ACCOUNT_LOCKED burns sentinel` seeds an account with 21 login_failures rows, sends the correct password, asserts wall-time ≥ TIMING_ORACLE_FLOOR_MS. Deviation from hold block text: the lockout gate runs AFTER argon2.verify in the current handler, not before. The burn is still added per architect instruction — it keeps wall-time symmetric with the other post-verify branches and equalizes against any future handler reshape that moves the check earlier.

2. **P1 /signup `verify_token === null` 409 → argon2.hash (fixed).** `auth.ts:192-194` — replaced `burnSentinel(password)` with `await argon2.hash(password, ARGON2_OPTIONS).catch(() => {})` so the 409 path pays argon2.HASH (~100ms) rather than argon2.VERIFY (~50ms), matching the happy-path argon2.hash cost.

3. **P2 /signup `confirmed:` 409 → argon2.hash (fixed).** `auth.ts:196-198` — same replacement on the already-verified branch. 4-way timing matrix test `SEC-LOGIN-UNKNOWN-USER-TIMING: /signup 4-way timing matrix` exercises unknown-email + `verify_token = NULL` + `verify_token LIKE 'confirmed:%'` + hex-pending fall-through; each path asserts ≥ TIMING_ORACLE_FLOOR_MS. Fall-through (hex verify_token) unchanged — it already pays argon2.hash via the upsert. SMTP-not-configured in the test env causes (a) and (d) to return 500; the wall-time assertion still holds because argon2.hash has already run.

4. **P2 burnSentinel oversized-input clip (fixed).** `auth.ts` — `const safeInput = input.length > 1024 ? input.slice(0, 1024) : input;` before `argon2.verify`. Test `SEC-LOGIN-UNKNOWN-USER-TIMING: burnSentinel clips oversized input` sends a 5000-byte password to `/login` with an unknown username and asserts wall-time ≥ TIMING_ORACLE_FLOOR_MS. Removing the clip drops the call to ~1ms via argon2.verify's early-reject + silent catch.

5. **P2 /reset-request unknown-email burn (fixed).** `auth.ts` — `await burnSentinel(normalizedEmail)` before the unknown-email 200 early-return. Docblock at `auth.ts:25-34` updated to list `/reset-request` under the covered endpoints. Timing test `SEC-LOGIN-UNKNOWN-USER-TIMING: /reset-request unknown-email burns sentinel` asserts 200 ≥ TIMING_ORACLE_FLOOR_MS.

6. **P2 logger.flush before process.exit (fixed).** `auth.ts:48-59` — replaced the raw `process.exit(1)` with `typeof logger.flush === 'function' ? logger.flush(() => process.exit(1)) : process.exit(1)`. Guards against both the dev pino-worker-thread race and a future logger shape that drops `.flush`.

7. **P2 /resend-verification uniform message (fixed per user decision).** `auth.ts:~362-378` — all three post-auth-success branches (`!verify_token`, `verify_token.startsWith('confirmed:')`, hex-pending fall-through) now emit the identical `"If that email has a pending signup, a new verification link has been sent."` body. Test `SEC-LOGIN-UNKNOWN-USER-TIMING: /resend-verification message body is uniform` seeds the three account states, calls each with the correct password, asserts the three message strings are equal. The pending-branch assertion is conditional on 200 (the test env has no SMTP configured so it returns 500); the active-vs-confirmed pair is asserted unconditionally — those branches never hit SMTP.

8. **P2 timing thresholds calibrated (fixed).** Module-level constants in recover.test.ts: `TIMING_ORACLE_FLOOR_MS = 35` (was `40`, lowered to survive the argon2.verify floor on faster CI hosts per hold rationale) and `TIMING_ORACLE_CEILING_MS = 150` (was `40`, raised to survive DB + Express + supertest overhead on stressed CI per hold rationale). All pre-existing `>=40` and `<40` numeric literals replaced with the named constants; inline comments near the constants tie the choice to the argon2 floor.

9. **P3 burnSentinel default-parameter dropped (fixed).** `auth.ts` — signature is now `async function burnSentinel(input: string)`. No default. All call sites pass an explicit argument.

10. **P3 task-slug comment rewritten (fixed).** `auth.ts` — the `SEC-LOGIN-UNKNOWN-USER-TIMING hold #1:` prefix on the /resend-verification null-hash burn comment is gone; the comment now reads as a self-contained rationale. `grep -n "hold #" backend/src/routes/auth.ts` confirms no remaining references.

11. **P3 describe-block naming normalized (fixed).** recover.test.ts — round-2 describe blocks `SEC-LOGIN-UNKNOWN-USER-TIMING hold #1:`, `hold #2:`, `hold #3:` renamed to `SEC-LOGIN-UNKNOWN-USER-TIMING:` (round-1 shape). No `hold #N` qualifiers remain in describe block names. The prose comments above each describe block still carry round-2 context.

12. **P3 dead eslint-disable removed (fixed).** `auth.ts:47` — the `// eslint-disable-next-line @typescript-eslint/no-explicit-any` is gone.

13. **P3 hasPassword typed as boolean (fixed).** `auth.ts:136` — `const hasPassword: boolean = !!(password && typeof password === 'string');`.

14. **P3 redisReachable try/catch (fixed).** `recover.test.ts:39-51` — the block now wraps the `getRedis()` import + probe in try/catch, mirroring the dbReachable pattern.

**Test outcomes:**
- `recover.test.ts`: 27/27 pass on two consecutive runs. New round-3 tests added: /login lockout, burnSentinel oversized input, /reset-request unknown-email, /resend-verification uniform message body, /signup 4-way timing matrix.
- `npx tsc --noEmit`: clean.
- Full vitest suite: deferred to parent agent.

**Deviations / notes for architect:**
- Round-2 hold #1 asserted ACCOUNT_LOCKED fires before argon2.verify; the current handler fires it AFTER. Burn added per instruction; see item #1 note above. If the architect prefers to reorder the lockout check to run before argon2.verify (which would make the enumeration oracle match the hold text), that is a separate structural change and should be filed as a new task.
- Round-2 hold #7 test uniformity asserts on 200 responses only for the hex-pending branch, because the test env has no SMTP configured and that branch returns 500. The active-vs-confirmed pair is still asserted unconditionally, which is the specific oracle the fix closes (active and confirmed always bypass SMTP).
- No work touched in `backend-signup-institutional-gate-ordering.md`, `backend-argon2-concurrency-cap.md`, `backend-request-body-typing-zod.md`, or `backend-enable-eslint-ts-rules.md` — those are separately filed per architect.

---

**Architect re-review (2026-04-22, round 3) — HELD PENDING FIXES:**

Round-3 `/ce-code-review` on commit `4a83eef` (10 personas). 14 round-2 hold items correctly applied. The pass surfaced a new P1 and several P2s. The SMTP-failure status-code oracle is filed as a separate new task (`backend-auth-smtp-status-code-oracle.md`) because it's a failure-mode axis distinct from the timing-axis the task was scoped to. The `/resume-signup` sibling-endpoint oracle is also filed as its own task (`backend-auth-resume-signup-timing-guard.md`). The ACCOUNT_LOCKED structural reorder is noted as a future design question, not a hold item on this task.

Hold items below are scoped to in-task bugs worth closing before archive.

1. **P2 — `/signup` 409 `argon2.hash().catch(() => {})` silently swallows runtime argon2 crashes** (correctness C2-01 0.88 + reliability R2-2 0.85 + maintainability M2 0.72, 3-reviewer convergence). `backend/src/routes/auth.ts:~301, ~305` — two 409 DUPLICATE paths call `argon2.hash(password, ARGON2_OPTIONS).catch(() => {})`. The inline comment claims "the startup .catch handles it" — but the startup rejection handler on `SENTINEL_ARGON2_HASH_PROMISE` fires ONCE at module load, NOT on per-request runtime crashes. A runtime argon2.hash failure on either path (OOM, libuv exhaustion, native binding crash) silently reopens the oracle with zero operator signal. All other burn sites go through `burnSentinel()` which has `logger.warn` on the catch. Fix: replace `.catch(() => {})` at both sites with `.catch((err) => { logger.warn({ err }, 'argon2 signup-dup burn failed — timing oracle may be open'); })`. Or extract a named helper `burnHashSentinel(password)` that mirrors `burnSentinel`'s log-and-swallow shape for the HASH case (when 4-sites-threshold is met — today there are just 2, so inline logger.warn is preferable).

2. **P2 — ACCOUNT_LOCKED path double-burns: ~100ms vs wrong-password ~50ms creates new 2x timing asymmetry** (correctness C2-02 0.72 + security info 0.75 + adversarial ADV2-1 0.82). The `/login` ACCOUNT_LOCKED check runs AFTER `argon2.verify` (per round-2 item #1 implementer note). Correct-password on locked account now runs verify (~50ms) + burnSentinel (~50ms) = ~100ms. Correct-password on unlocked account runs only verify (~50ms). The implementer's claim that the burn "keeps wall-time symmetric with the other post-verify branches" is wrong — wrong-password post-verify takes ~50ms, locked post-verify takes ~100ms. Net oracle gain from the burn is zero (403 status code already reveals lockout), AND the asymmetry contradicts the stated intent. Fix options: (a) remove the burn on this branch entirely (the structural point was made; 403 is the tell anyway), OR (b) reorder the lockout gate to fire BEFORE argon2.verify so the burn at that branch produces post-verify-path parity. Pick (a) — cheapest, consistent with the "status code already discloses" reasoning.

3. **P2 — `logger.flush` has no timeout guard; stuck pino worker hangs process.exit(1)** (reliability R2-1 0.82 + security SEC-LOGGER-FLUSH-HANG-ON-BROKEN-TRANSPORT 0.65 + adversarial ADV2-5 0.61, 3-reviewer convergence). `auth.ts:~111-115` — `logger.flush?.(() => process.exit(1))` relies on pino's `thread-stream.flush(cb)` which uses `timeout=Infinity`. If the pino worker thread deadlocks (same OOM conditions that kill argon2 at startup), the flush callback never fires → `process.exit(1)` never runs → process survives with permanently-broken `SENTINEL_ARGON2_HASH_PROMISE` + silent burnSentinel no-op → oracle permanently open + supervisor cannot restart. Fix: wrap with timeout fallback: `const t = setTimeout(() => process.exit(1), 2000); t.unref(); logger.flush?.(() => { clearTimeout(t); process.exit(1); }) ?? process.exit(1);`.

**Dismissed from round-3 findings (architect triage):**
- **P3** SMTP-unavailable status-code oracle on `/reset-request` + `/resend-verification` — filed as new task `backend-auth-smtp-status-code-oracle.md`; distinct failure-mode axis, out of this task's timing-scope.
- **P3** `/resume-signup` unknown-email oracle — filed as new task `backend-auth-resume-signup-timing-guard.md`; sibling endpoint out of this task's named scope.
- **P3** Pre-existing `/resend-verification` token-overwritten-before-SMTP no-rollback gap (R2-3 0.80): pre-existing, not introduced by this commit; user can file separately if it becomes operationally relevant.
- **P3** ACCOUNT_LOCKED structural reorder (lockout-before-verify) — design-level change deferred; file a new task if we decide to pursue it.
- **P3** `hasPassword` boolean guard doesn't narrow `password` through TS flow (kieran KT2-1 0.82): the `if (hasPassword)` sites at `:~301, ~305` still pass `string | undefined` to `argon2.hash`; compiler silent only because `@types/argon2` overloads are loose. Dismissed as pre-existing type-safety posture; `backend-zod-migration-extension.md` and `backend-request-body-typing-zod.md` follow-up work is the right path for a general fix. Inline `if (password)` tightening is fine to apply opportunistically while landing item #1.
- **P3** `logger.flush` typeof guard dead-branch (kieran KT2-2 0.78): cosmetic; subsumed by hold #3 (the rewrite lands the optional-chain shape).
- **P3** TIMING_ORACLE_CEILING_MS=150 too loose to mutation-kill the passwordProvided-gate on `/recover` no-password path: separate-constant suggestion acknowledged, not blocking.
- **P3** Multiple test-hygiene items (ACCOUNT_LOCKED test zero mutation-kill given handler order; `/signup` 4-way matrix cleanup; `$.body.message` uniformity test dead on 500 env; residual "hold round-2" prose in test comments): noted for inline fix-while-there.
- **P3** 1024-byte clip magic number (maintainability M1 0.75): dismissed — clip's rationale is in the docblock; extracting to named constant is polish.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-auth-smtp-status-code-oracle.md` (new P1) — close the 500-vs-200 status-code oracle on known-vs-unknown emails under SMTP outage on `/reset-request` + `/resend-verification`.
- `backend-auth-resume-signup-timing-guard.md` (new P2) — apply the unknown-email burnSentinel pattern to `/api/auth/resume-signup` (out-of-scope sibling site).

**Architect-owned fix-in-place (applied in this review pass):**
- `agents/docs/api-contracts/auth.md:107` — trim the "If the account is already active, returns..." clause; the uniform message is the contract post-item-#7 round-3.

**Path to re-archive:** (1) Backend applies items #1-3 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-4 with `/ce-code-review` (adversarial + security mandatory); archives on clean. Filed follow-up tasks archive independently.

---

**Backend re-review signal (2026-04-22 round-4, worktree `.claude/worktrees/agent-ae33bace`):**

All 3 round-3 hold items landed. `npx tsc --noEmit` clean. `backend/tests/routes/recover.test.ts` 27/27 pass. Full backend vitest suite deferred to parent per coordination rules.

1. **P2 C2-01 /signup 409 silent swallow (fixed).** `backend/src/routes/auth.ts:~301, ~305` — both 409 DUPLICATE paths now have inline `.catch((err) => { logger.warn({ err }, 'argon2 signup-dup burn failed — timing oracle may be open'); })` instead of the silent `.catch(() => {})`. An argon2 runtime crash on either path now emits an operator-visible warning on the same channel as `burnSentinel()`'s own catch. No helper extracted (only 2 sites; architect's note in the hold block preferred inline). Opportunistic tightening per architect's P3-dismissed-but-suggested note: swapped `if (hasPassword)` to `if (password)` at both sites so the truthy-narrowing gives TS `password: string` rather than relying on `hasPassword: boolean` which doesn't flow-narrow `password`.

2. **P2 C2-02 ACCOUNT_LOCKED double-burn removed (fixed per architect option (a)).** `backend/src/routes/auth.ts:~643-651` — removed `await burnSentinel(password)` on the ACCOUNT_LOCKED 403 branch. Comment rewritten to document the decision: the lockout gate runs AFTER argon2.verify, so the burn was creating a 2× asymmetry (verify + burn ~100ms locked vs verify-only ~50ms unlocked) instead of closing one, and 403 status code already discloses lockout state to callers who reach that branch (they already supplied the correct password). The matching timing test `SEC-LOGIN-UNKNOWN-USER-TIMING: /login ACCOUNT_LOCKED burns sentinel` at `backend/tests/routes/recover.test.ts:~755` is removed (its describe block, beforeAll, afterAll, and it replaced with a short explanatory comment pointing at the handler rationale). Also dropped "login ACCOUNT_LOCKED" from the file-header burnSentinel coverage comment at `auth.ts:~77`.

3. **P2 R2-1 logger.flush timeout guard (fixed).** `backend/src/routes/auth.ts:~105-120` — added a 2s `setTimeout(() => process.exit(1), 2000); t.unref();` fallback before the flush call, and `clearTimeout(t)` inside the flush callback. Guards against both the missing-flush case (no-flush path immediately exits) and the deadlocked-pino-worker case (supervisor gets a clean exit within 2s even if flush callback never fires). Comment expanded to document the pino `thread-stream.flush(cb)` `timeout=Infinity` behavior. Note: deviated from the literal snippet in the round-3 hold block (`logger.flush?.(cb) ?? process.exit(1)`) because that shape fires `process.exit(1)` synchronously immediately after calling `logger.flush()` (which returns `void`/undefined), defeating the wait-for-flush intent. The `if/else` + setTimeout composition preserves both the timeout guard and the wait-for-flush-callback behavior the hold block wanted.

**Test outcomes:**
- `recover.test.ts`: 27/27 pass (one net-removed ACCOUNT_LOCKED test is intentional; no net-new tests added in round 4 because item #1 is logging-only, item #2 is a removal, item #3 is environment-only fail-loud).
- `npx tsc --noEmit`: clean.
- Full vitest suite: deferred to parent agent.

**Deviations from hold block:**
- Item #3: the literal snippet `logger.flush?.(cb) ?? process.exit(1)` would fire `process.exit(1)` synchronously immediately after calling flush (pino's flush returns void). Landed an `if (typeof logger.flush === 'function') { ... } else { ... }` + setTimeout shape that preserves both the timeout guard and the wait-for-callback intent. Rationale above.
- Opportunistic `if (password)` tightening applied per architect's P3-dismissed-but-suggested note at both item-#1 sites (one-line change, matches the "fine to apply opportunistically" guidance).

---

**Architect re-review (2026-04-22, round 4) — HELD PENDING FIXES:**

Round-4 `/ce-code-review` on commit `1cbd210` (10 personas: correctness, testing, security, adversarial, reliability, maintainability, project-standards, kieran-typescript, ce-agent-native, ce-learnings-researcher). All 3 round-3 hold items correctly applied: the setTimeout+flush composition is sound (correctness + reliability confirm the literal-snippet deviation was the right call — pino's `flush` returns `void` so the `??` fallback would never fire), ACCOUNT_LOCKED burn removal does not reopen an oracle (wrong-password callers on both locked and unlocked accounts return 401 at ~50ms via `!valid` path; correct-password's 403 vs 200 is status-code oracle explicitly accepted by design), and the /signup 409 `logger.warn` on argon2.hash failure matches `burnSentinel`'s operator-visible failure-log pattern.

Re-review surfaced 3 P3 comment/naming-drift items worth closing before archive. All in-scope of the round-4 commit.

1. **P3 — Stale comment "Gate on `hasPassword`"** (adversarial ADV-R4-003 0.95 + maintainability M-02 0.76 + kieran KT-001 0.72, 3-reviewer convergence). `backend/src/routes/auth.ts:~306` — the block comment reads "Gate on hasPassword to avoid paying argon2 cost on ORCID+email signup with no password" but the code beneath was changed in round-4 from `if (hasPassword)` to `if (password)`. Update the comment to reference the `password` truthy-narrow (e.g., "Gate on truthy `password` to avoid paying argon2 cost on ORCID+email signup with no password — the narrow also gives TS `password: string` for the `argon2.hash` call below"). One-line fix.

2. **P3 — Dead `clearTimeout(t)` in startup-reject else branch** (maintainability M-03 0.85). `backend/src/routes/auth.ts:~121` — the else branch (no-flush path) has `clearTimeout(t); process.exit(1);` where `t` is already `.unref()`'d, no flush callback is pending in this branch, and `process.exit(1)` on the next line terminates the process before the timer could ever fire anyway. The `clearTimeout` is pure structural symmetry with the `if` branch (where clearing is necessary to suppress the 2s fallback once flush succeeds); here it creates cognitive overhead for zero behavioral benefit. Remove it; optional one-line comment: `// no flush callback pending; exit directly`.

3. **P3 — "round-4" task-history phrasing in test replacement comment** (maintainability M-04 0.72). `backend/tests/routes/recover.test.ts:~748-758` — the comment replacing the removed ACCOUNT_LOCKED describe block says "The /login ACCOUNT_LOCKED timing test was removed in round-4". Round-2 item #10 rule requires production/test comments to be self-contained invariant prose (no hold/round references — they rot once the task archives). Rewrite as: `(No timing test for /login ACCOUNT_LOCKED: the check runs after argon2.verify, so adding a burn creates a 2× asymmetry — verify+burn on locked vs verify-only on unlocked. 403 already discloses lockout state to correct-password callers. See the handler comment in auth.ts for full rationale.)` — keeps the rationale, drops the round reference.

**Dismissed from round-4 findings (architect triage):**
- **P2** Startup double-failure 2s oracle window (adversarial ADV-R4-001 0.63): requires simultaneous OOM of argon2 native + pino worker thread at module init; window bounded at 2s by the setTimeout fallback. A structural fix (sentinel-ready middleware gate awaiting `SENTINEL_ARGON2_HASH_PROMISE` before dispatching auth requests) is non-trivial and beyond this task's scope. Accepted residual; noted for future hardening if the dual-OOM scenario is observed in prod.
- **P3** Duplicated `logger.warn` string across 2 /signup 409 sites (maintainability M-01 0.82): below the task's explicit 4-site extraction threshold. Inline is preferred per the round-3 hold block's own guidance.
- **P3** `hasPassword` boolean alias still gates `argon2.hash(password, ...)` at `:~339` (kieran KT-002 0.65 pre-existing): masked by `skipLibCheck: true` allowing `string | undefined` to slip through argon2's overloads. Partial migration leaves two idioms for the same gate in adjacent code. Pre-existing; `backend-request-body-typing-zod.md` + `backend-zod-migration-extension.md` follow-up work is the right path for a general fix. Not blocking.
- **P3** SIGNUP_EXPIRED DB-DELETE latency oracle vs other post-verify branches (adversarial ADV-R4-002 0.61 pre-existing): not introduced by round-4. Status-code oracle already discloses state; timing axis marginal.
- **P3** Signal block appended to `pending/` not `review/` (project-standards PS-01/PS-02 0.72/0.65): addressed separately this review via an `agents/backend/CLAUDE.md` rule clarification — both sequences are now explicitly permitted.
- **P3** Hold #1 test coverage for the ACCOUNT_LOCKED burn removal (testing T-R4-02 0.62): the architect already dismissed in round-3 that the removed burn-assertion was zero-mutation-kill given handler order. A negative test asserting the branch does NOT pay burn wall-time would cost more than it protects.
- **P3** Hold #3 test coverage for the setTimeout+flush composition (testing T-R4-03 0.60): architect accepted in round-3 as environmental/fail-loud — not unit-testable without mocking argon2 in a way that defeats the security primitive under test.

**Filed follow-up still-pending:** `backend-auth-smtp-status-code-oracle.md`, `backend-auth-resume-signup-timing-guard.md`, `backend-argon2-concurrency-cap.md`, `backend-signup-institutional-gate-ordering.md`, `backend-request-body-typing-zod.md`, `backend-enable-eslint-ts-rules.md` — per prior hold blocks. No new follow-ups filed from round 4.

**Path to re-archive:** (1) Backend applies items #1-3 (single commit, all in `auth.ts` + `recover.test.ts`). (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-5; archives on clean.

---

**Backend re-review signal (2026-04-22 round-5, worktree `.claude/worktrees/agent-a67d9e4c`):**

All 3 round-4 P3 hold items landed in a single commit. `npx tsc --noEmit` clean. `backend/npm run lint` clean (6 pre-existing `no-explicit-any` warnings at Express/dhive boundaries, per backend CLAUDE.md these are accepted). `backend/tests/routes/recover.test.ts` 24/27 pass on this worktree. The 3 failures are pre-existing on the worktree's base commit `55fc03b` (verified by running the suite on that baseline before applying any changes); all are SMTP-not-configured 500-vs-409 status code mismatches in `BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING` tests, unrelated to this task. Full backend vitest suite deferred to parent per coordination rules.

1. **P3 Stale "Gate on `hasPassword`" comment (fixed).** `backend/src/routes/auth.ts:~306-311` — rewrote the block comment to reference the round-4 `if (password)` truthy-narrow: "Gate on truthy `password` to avoid paying argon2 cost on ORCID+email signup with no password (both 409 and happy-path are ~1ms there, no oracle to close). The truthy-narrow also gives TS `password: string` for the `argon2.hash` call below without an `as string` cast. The hex-pending fall-through path below runs argon2.hash + upsert naturally, so no burn is needed there." The comment now accurately describes the code and captures the type-flow benefit.

2. **P3 Dead `clearTimeout(t)` in startup-reject else branch (fixed).** `backend/src/routes/auth.ts:~122-124` — removed `clearTimeout(t);` from the no-flush else branch. Replaced with the architect-suggested clarifying comment `// no flush callback pending; exit directly`. The `if (typeof logger.flush === 'function')` branch still calls `clearTimeout(t)` inside the flush callback, which is where it remains load-bearing (clearing the 2s fallback after flush succeeds).

3. **P3 "round-4" task-history phrasing in test replacement comment (fixed).** `backend/tests/routes/recover.test.ts:~747-751` — rewrote as architect-suggested self-contained invariant prose: "(No timing test for /login ACCOUNT_LOCKED: the check runs after argon2.verify, so adding a burn creates a 2× asymmetry — verify+burn on locked vs verify-only on unlocked. 403 already discloses lockout state to correct-password callers. See the handler comment in auth.ts for full rationale.)". Opportunistic cleanup: also removed the adjacent `// ─── Round-3 additions ─── ...` section-heading comment (same rot class — task-history marker with no invariant value).

**Test outcomes:**
- `recover.test.ts`: 24/27 pass (3 pre-existing SMTP-config failures on baseline `55fc03b` — not introduced by this commit). No net-new tests added; all 3 hold items are comment/dead-code edits with no behavioral change.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (6 pre-existing `no-explicit-any` warnings accepted per backend CLAUDE.md).
- Full vitest suite: deferred to parent agent.

**Deviations from hold block:**
- None substantive. All 3 items landed as the architect specified. Minor: also removed the adjacent `Round-3 additions` section-heading comment in `recover.test.ts` under item #3 as cleanup-while-there (same task-history-phrasing class as item #3 itself).
