# BE-VERIFY-BROADCAST-ATTEMPTS-CAP — Bound the broadcast-retry amplification on /api/accreditation/verify 504

**Owner:** backend
**Created:** 2026-04-28 (architect, follow-up from round-3 archive review of `backend-orcid-broadcast-abort-timeout.md`; surfaced by adversarial + reliability + security 3-reviewer convergence)
**Priority:** P1

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-3 (commit `8d2ea00`) finalized the 504 BROADCAST_TIMEOUT envelope at `/api/accreditation/verify` with `{retriable:false, outcome:'uncertain', verify_before_retry:true, timeout_ms}`. The token deliberately survives 24h on 504 (per `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.2) so the legitimate caller can retry after verifying chain state.

Round-3 review surfaced an amplification class the A.2 envelope alone does not close. From the adversarial review:

- Trigger: a user (or attacker) holds a valid pending-accreditation token. Hive node is in a degraded state where broadcasts hang past 30s but eventually land.
- Each `/verify` retry that hits the slow-node window enters the broadcast catch (304 BROADCAST_TIMEOUT) AND enqueues a fresh broadcast attempt at the dhive layer. Five-per-minute rate (per `accreditationVerifyLimiter`) × 24h TTL = up to 7200 retry attempts per IP. Across rotating IPs, unbounded.
- `evidence_hash = sha256(${pending.email}:${pending.hive_username}:${pending.token})` is identical for every retry on the same token. Hive does not deduplicate `custom_json`. Every retry that lands produces a distinct on-chain `accredit` op for the same account.
- `seedAccreditationBonus(pending.hive_username)` is a DB write that may not be idempotent (architect to verify); a network-flake-then-retry could double-seed.
- The "verify_before_retry" hint relies on the user actually verifying — an attacker (or impatient user retrying via curl) skips verification and re-POSTs.

The convention doc lists Option A.4 (idempotency_key in payload + post-broadcast HAF check) as the durable structural fix; round-3 declined to implement (out of scope).

## Goal

Bound broadcast-retry amplification on `/verify` 504 paths. Two shapes worth considering:

### Option 1 — Per-token broadcast-attempts counter

Add a `broadcast_attempts` counter to the pending row (or a Redis side-key). Increment before each broadcast call. On 504, check the counter:
- attempts < MAX (e.g. 3): allow retry; return current 504 envelope.
- attempts >= MAX: delete the token + return 502 BROADCAST_FAILED with a "limit exceeded; request a fresh token" message.

Pros: small surface change, Redis or DB-backed state. Closes the amplification axis without changing the on-chain payload schema.
Cons: tightens the "verify_before_retry" UX — users with legitimate slow-node windows hit the cap.

### Option 2 — Idempotency key in custom_json (Option A.4)

Include `idempotency_key: sha256(token + nonce)` in the customJsonPayload. Backend reads existing `accredit` ops via HAF before broadcasting; if a row with the same idempotency_key already exists, return 200 with the existing tx_id (no second broadcast).

Pros: structurally closes the duplicate-broadcast race even if amplification happens. HAF-side dedup is the correct trust boundary.
Cons: schema change to the on-chain payload (adds a new field). HAF query for the key adds 1 RTT to every /verify. Bigger surface.

### Combined

Option 1 is the immediate amplification cap. Option 2 is the durable HAF-side dedup. Both are compatible — Option 1 limits per-token retry volume; Option 2 ensures any retry that DOES happen converges to the same on-chain outcome.

## Acceptance

- Pick Option 1, Option 2, or both.
- Verify `seedAccreditationBonus` is idempotent (a UNIQUE constraint on `hive_username` in the `accredit_bonus` table or equivalent). If not, fix or document why double-seeding is acceptable.
- Test: mocked broadcast hangs N+1 times → assert the (N+1)th retry returns the cap-exceeded envelope (Option 1) AND that broadcastJsonMock was called exactly N times (broadcast not enqueued past the cap).
- Test: same token retried after a successful broadcast (Option 2) → assert the second call returns 200 with the original tx_id, no second broadcast.

## Non-goals

- Changing the 30s broadcast timeout (stays as-is per parent task non-goals).
- Generic outbox pattern for all backend writes.
- Closing the amplification on other broadcast surfaces (orcid /callback, papers /retract, claims) — file separately if the same shape applies.

## Source

`agents/docs/tasks-archive.md` BE-ORCID-BROADCAST-ABORT-TIMEOUT round-3 archive entry; `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.4.

---

## Architect re-review (2026-04-30, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `19365d4`. The pre-broadcast cap-check is correctly placed (before the broadcast site, after config + token validation), counter cleanup fires on success and 502 paths, the 5/min IP limiter is correctly dodged in tests via XFF rotation, and the cap reduces amplification from ~7200/IP to ~3/account/24h-window (combined with the existing `accreditationRequestLimiter`). Six items surface from the round-1 review.

### Items to address

**1. (P2) `BROADCAST_FAILED` code reuse for cap-exceeded conflates client-retry-pressure with chain rejection.** Cross-reviewer convergence (api-contract conf 75 + adversarial MED conf 75 + agent-native — promoted to conf 100). Cap-exceeded path emits `502 BROADCAST_FAILED` — same envelope as a real Hive node rejection. HTTP-only consumers can't programmatically distinguish "request a fresh email" from "Hive rejected your op." Operators alerting on `BROADCAST_FAILED` rate can't separate client retry-pressure from real chain failure. Semantically wrong — the broadcast was never invoked when the cap fires.

Fix: introduce a distinct error code `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` (preferred per the api-contract reviewer's recommendation as the higher-signal choice). Architect will add the corresponding row to `agents/docs/api-contracts/accreditation.md` at re-review archive time.

**2. (P2) 3 transient 504 timeouts permanently destroy a verified accreditation token.** The cap counter increments BEFORE broadcast and is NOT decremented on 504 timeout. The 504 envelope tells the client "retriable after verifying chain state" (`{retriable:false, outcome:"uncertain", verify_before_retry:true}`). The cap punishes that exact verify-then-retry behavior. Worst case: user burns 3 cap slots on transient Hive lag → token destroyed → must hit `/api/accreditation/request` for a fresh token → that endpoint has 3/24h per-account limit → if those slots also burned earlier, user is locked out for 24h on a flaky Hive day.

Fix: implementer's call on shape. Suggested options:
- **(i) simplest:** don't increment the counter on 504 paths; only count broadcasts that produced a definitive 502 BROADCAST_FAILED.
- **(ii)** differentiate timeout-burned slots from rejection-burned slots (e.g., 5 timeout attempts allowed but only 3 rejection attempts).
- **(iii)** decrement counter on cap-exceeded path's verify-chain-state response.

Implementer chooses; document the rationale in the round-2 signal block.

**3. (P2) `MAX_BROADCAST_ATTEMPTS=3` hardcoded module constant.** `backend/src/routes/accreditation.ts:21-27`. An amplification-defense parameter that gates user-impacting behavior should be flippable without redeploy. Move to `config.ts` env var (e.g., `VERIFY_BROADCAST_ATTEMPTS_CAP`).

**4. (P1) No concurrent-retry test for cap atomicity.** The production code comment at `accreditation.ts:240` claims the cap holds under concurrent retries via atomic INCR, but no test fires `Promise.all`-style concurrent `/verify` calls on the same token. Fix: add a `Promise.all([verify, verify, verify, verify])` spec where 4 concurrent requests on the same token assert exactly 3 broadcasts fire and the 4th returns the cap-exceeded envelope. Note: must dodge the 5/min IP limiter via distinct synthetic XFFs (existing pattern in the file).

**5. (P3) Cap-exceeded log missing structured `event:` field.** `backend/src/routes/accreditation.ts:243-251` `logger.warn` for cap-exceeded uses message-substring grep. Sibling operator anchors in `routes/orcid.ts` and `lib/broadcast-error.ts` use structured `event:` keys (`a1_extend_*`, `lock_contention_held`, `post_broadcast_msg_fn_threw`, `post_broadcast_write_failed`). Add `event: 'accred_verify_broadcast_cap_exceeded'` (or analog) to the warn payload.

**6. (P3) INCR + EXPIRE non-atomic.** `backend/src/routes/accreditation.ts:78-82` — `INCR` then `EXPIRE` are two separate Redis round-trips. If a crash or hiccup occurs between them, the counter has no TTL and persists past the 24h token life; the legitimate user is locked out for 24h with no automatic recovery. Fix: Lua atomic OR `SET ... NX EX <ttl>` priming + `INCR`. Cross-reviewer convergence (security conf 60 + correctness conf 50 + reliability low + adversarial conf 50 — promoted via cross-corroboration).

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit. Architect adds the new error-code row to `accreditation.md` at archive time.

---

## Round-2 implementer signal (2026-04-30)

Items 1-6 landed. Summary by item:

1. **Distinct error code** — Added `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` to the `ErrorCode` union in `backend/src/types/api.ts`. Cap-exceeded path now returns `502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED` (NOT `BROADCAST_FAILED`). [TODO Architect] Add the corresponding row to `agents/docs/api-contracts/accreditation.md` at archive time per the original re-review note.

2. **504 timeouts no longer consume cap slots** — Chose option (i) shape, implemented as pre-INCR + decrement-on-timeout (compensating). Rationale: option (i) literally means "only count 502 failures", but item 4's atomic-concurrent-claim guarantee requires pre-INCR (otherwise 4 parallel retries all fire broadcasts before the cap can fire). Pre-INCR + decrement-on-timeout gives both: (a) atomic concurrent-claim under bursts of size N → at most `cap` broadcasts fire, and (b) sequential timeouts on a verified token never permanently consume cap slots → no 24h lockout on a flaky-Hive day. Only definitive 502 BROADCAST_FAILED outcomes count toward the cap (decrement is skipped on the failure branch). New helper `decrementBroadcastAttempts()` mirrors the increment shape; `DECR` floor at 0 + `DEL` on a missing key handles a parallel-deleteToken race.

3. **MAX_BROADCAST_ATTEMPTS to config** — New env var `VERIFY_BROADCAST_ATTEMPTS_CAP` (default 3) wired through `config.verifyBroadcastAttemptsCap`. Documented in `.env.example` under the SMTP section (alongside the related accreditation surface).

4. **Concurrent-retry test** — `it('round-2 hold #4: concurrent retries claim slots atomically …')` fires `cap + 1` parallel `/verify` calls on the same token via distinct synthetic XFFs to dodge the per-IP rate limiter. Asserts exactly `cap` broadcasts fire AND exactly one response is `502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED`. The hung-broadcast pattern (mockImplementation returning a held promise, released after the parallel burst lands) sidesteps the post-broadcast deleteToken race.

5. **Structured `event:` field** — Added `event: 'accred_verify_broadcast_cap_exceeded'` to the `logger.warn` payload at the cap-gate site. Mutation-sensitive test `round-2 hold #5` pins the call shape via `expect.objectContaining({ event, attempts, cap })` so a future log-message edit can't silently drop the discriminator.

6. **Atomic INCR + EXPIRE** — Replaced the two-RTT `INCR` then `EXPIRE` pair with a single `redis.eval` of a Lua script (`INCR_AND_EXPIRE_IF_FIRST_LUA`) that runs `INCR` and the conditional `EXPIRE` (only on `count == 1`) in one round trip. Test `round-2 hold #6` asserts the on-disk invariant directly against the same Lua script (replayed verbatim) — first write sets TTL within bound, second write does NOT re-prime TTL.

### Files changed (this round)

- `backend/src/routes/accreditation.ts` — Lua script, helper rewrite, decrement helper, route arithmetic, error code, structured event field.
- `backend/src/config.ts` — `verifyBroadcastAttemptsCap` env wiring.
- `backend/src/types/api.ts` — `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` ErrorCode addition.
- `.env.example` — `VERIFY_BROADCAST_ATTEMPTS_CAP` documentation.
- `backend/tests/routes/accreditation.test.ts` — 6 new specs replacing the round-1 burns-slots-on-timeout shape (cap-exceeded path with pre-seeded counter, timeout-decrement, concurrent-retry, structured-event log, Lua-atomicity unit).

### Test status

`npx vitest run tests/routes/accreditation.test.ts` — all 7 BE-VERIFY-BROADCAST-ATTEMPTS-CAP specs pass; no regressions in BE-ORCID-BROADCAST-ABORT-TIMEOUT specs. The 2 pre-existing `rejects free email` / `rejects yahoo email` failures are rate-limit pollution from prior `/api/accreditation/request` specs (occurs even on `git stash`'d HEAD); unrelated to this task.

### Notes

- Existing tests for "clears the attempt counter on broadcast success" and "clears the attempt counter on terminal (502) broadcast failure" continue to pass — the success and failure paths still drop the counter via `deleteToken`'s side-effect on the counter key.
- `seedAccreditationBonus` idempotency was already verified in round-1 (Redis-layer SET NX), no DB-level UNIQUE constraint needed.

---

## Architect re-review (2026-05-01, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1e90b87`. The 6 round-2 hold items are correctly applied: distinct error code wired through the union, decrement-on-timeout closes the 24h-lockout-on-flaky-Hive case, env-var cap exposed, concurrent-retry test pins the atomic-claim guarantee, structured event field with mutation-sensitive call-shape assertion, atomic Lua INCR + first-write EXPIRE. Thirteen items require backend follow-up; two are architect-owned for archive time; one is pre-existing (file separately if desired).

### Items to address (backend)

**1. (P1) Raw 64-hex verification token logged in fallback warn/error.** Single-reviewer (security) conf 75 — actionable. New code at `backend/src/routes/accreditation.ts:401` emits `{ err: decrErr, token, username, event: 'accred_verify_broadcast_decrement_failed' }`; pre-existing site at `:414` emits the same shape on `deleteToken` failure. The token is the SOLE credential at `/api/accreditation/verify` (no Hive sig, no other auth). Anyone with read access to operator logs (aggregation, archives, log-shipping pipelines, third-party SaaS log services) for the duration of the 24h TTL can replay the token to enqueue an `accredit` `custom_json` op signed by the admin key.

Fix: introduce `hashTokenForLogs(token)` in `backend/src/lib/log-pii.ts` (analogous to existing `hashEmailForLogs`; sha256 → first 12 hex chars). Replace `token` with `token_hash` at both lines 401 and 414 (yes, address the pre-existing site too — same exposure shape). Add a mutation-sensitive test for each path asserting the raw 64-hex token does NOT appear in the logger.warn / logger.error payload (e.g., serialize the call args and assert no 64-hex substring).

**2. (P2) Cap-exceeded path destroys valid token → token-burn DoS.** Cross-reviewer convergence (security + adversarial, 2-way → conf 100). Stolen-token attacker with `cap+1` distinct XFFs (dodging 5/min/IP, exactly as the round-2 test demonstrates with synthetic XFFs to dodge the rate limiter) trips the gate, calls `deleteToken`, and destroys the legitimate user's token. Re-`/request` is rate-limited 3/24h byAccount → 24h lockout if quota already spent that day. Asymmetric cost: cheap rotating IPs vs 24h capability loss.

Decision required (implementer drafts a recommendation; architect arbitrates if needed): pick one of —
   (i) **Accept-and-document:** this is the architect's intended tradeoff per the round-1 hold note; flag in the route-level WHY comment so the next maintainer knows this is by design. Lowest-friction.
   (ii) **Soft-block:** return 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED but do NOT call `deleteToken` on the cap-exceeded path. Token stays alive; counter persists; Redis 24h TTL eventually clears both. Trade-off: the legitimate user's retry on the same token will hit the cap again until the counter TTLs out (~24h from first INCR), but they retain the option to wait it out instead of burning a fresh `/request` slot.
   (iii) **Require `verifyHiveSignature` on `/verify`:** forces the user to sign each verify call with their Hive account, eliminating the "stolen-token-from-anywhere" threat. UX cost: requires Hive Keychain on the verify-link landing page; light-account users may not have ready access.

**3. (P2) Test-suite silent zero-coverage when CI runs without Redis.** Single-reviewer (testing) conf 75. All 6 round-2 hold specs early-return on `if (!redis) return` (`backend/tests/routes/accreditation.test.ts` lines 419, 450, 478, 544, 561, 577, 607). In CI without Redis, every cap spec passes without exercising any cap behavior. The `seedPendingAccreditation` helper already throws on no-Redis; these specs do not.

Fix: replace `if (!redis) return` with `if (!redis) throw new Error('Redis required for cap specs')` to fail loudly on misconfigured CI, matching the seedPendingAccreditation pattern.

**4. (P3) Lua `INCR_AND_EXPIRE_IF_FIRST_LUA` duplicated verbatim in test file.** Cross-reviewer convergence (testing + maintainability + learnings, → conf 100). Test at `tests/routes/accreditation.test.ts:622-628` duplicates the route's Lua body character-for-character. The header acknowledges the drift risk: "If the script changes, this test must be updated in lockstep."

Fix: export `INCR_AND_EXPIRE_IF_FIRST_LUA` from `backend/src/routes/accreditation.ts` (or move to a new `backend/src/lib/redis-scripts.ts` if you anticipate sibling scripts), import in the test. The original "export-only-for-tests would invite drift" rationale for not exporting is weaker than the verbatim-duplication drift risk it accepts.

**5. (P3) Decrement-failure log path untested.** Cross-reviewer convergence (testing + maintainability, → conf 100). The new inner try/catch around `decrementBroadcastAttempts` (`accreditation.ts:396-403`) emits `event: 'accred_verify_broadcast_decrement_failed'` if decrement throws; no spec drives Redis to reject the decrement.

Fix: mirror the existing 502+deleteToken-rejection spec shape — spy on `redis.decr`, `mockRejectedValueOnce`, drive a 504 timeout, assert response stays 504 + the decrement-failed warn line fires + no `ERR_HTTP_HEADERS_SENT` log appears.

**6. (P3) Concurrent-retry test brittleness — 100ms scheduling heuristic.** Cross-reviewer convergence (testing + maintainability + correctness, → conf 100). Test at line 523 uses `await new Promise((r) => setTimeout(r, 100))` to fence the cap+1 parallel pre-INCR burst before releasing the held broadcast promise. Brittle on slow CI or operator-tuned high cap (cap=10 → 11 parallel supertest invocations tighten the window).

Fix: replace the 100ms sleep with a deterministic barrier — poll `broadcastAttemptCount(token)` until it equals `cap + 1`, then release. Resilient regardless of CI speed or cap value.

**7. (P3) Lua doc/impl divergence — EXPIRE re-fires on every transition-to-1, not first-write-only.** Single-reviewer (adversarial) conf 75. Comment at `accreditation.ts:27-29` claims "tying TTL to the first-write branch." After a pre-INCR + DECR-on-timeout cycle, the Redis key persists at value 0 (no DEL because `after >= 0` per `decrementBroadcastAttempts:126`). Next pre-INCR makes count==1 again, EXPIRE re-fires. Safety preserved (TTL value = remaining-token-life, monotonically shrinking) but documented invariant ≠ implemented invariant. Future maintainer reading the comment may believe "first-write-only" is the safety property and modify the Lua under that wrong mental model.

Fix: rewrite the comment to describe the actual invariant: "EXPIRE fires on every transition-to-1 (count==0 → count==1). After decrement-on-timeout cycles, the key persists at 0 and a subsequent INCR re-primes EXPIRE; safety is preserved because the TTL anchor `pending.expires_at` monotonically shrinks across cycles, so the counter cannot outlive the token."

**8. (P3) Cap engages only on concurrent-burst, not sequential 502 retries.** Single-reviewer (adversarial) conf 75. `deleteToken` (line 178-187) deletes both the pending row AND the counter side-key; the 'failure' branch in catch (line 405-417) calls `deleteToken` on the first 502, ending the lifecycle. Sequential 502 retries cannot accumulate the counter. Round-2 hold #2's claim "only definitive 502 outcomes count toward the cap" is technically true but vacuous on the sequential path — the cap is effectively a concurrency-burst defense, not a sequential-flood defense.

Fix: update the route-level WHY comment at `accreditation.ts:286-298` to clarify that the cap is a concurrency-burst defense (atomic claim under N parallel retries) — the sequential-retry case is bounded by `deleteToken` on the first 502, not by the cap. If a follow-up commit lands, adjust the commit-message claim ("Bounds per-token broadcast-retry amplification") to match. Optionally, rename the existing test at `accreditation.test.ts:559` ("clears the attempt counter on terminal (502) broadcast failure") to make the structural reason explicit.

**9. (P3) Backend re-review signal block header diverges from prescribed form.** Single-reviewer (project-standards) conf 75. Header at line 97 reads `## Round-2 implementer signal (2026-04-30)`; `agents/backend/CLAUDE.md` prescribes `## Backend re-review signal (<date>, working tree or commit SHA):` with the SHA recorded. Cosmetic but breaks grep-based architect inbox scans.

Fix: rename the round-2 signal header to `## Backend re-review signal (2026-04-30, commit 1e90b87)`. Apply the prescribed form for the round-3 signal block when this task moves back to review/.

**10. (P3) Redis flap between INCR and DECR-on-timeout silently inflates the counter.** Single-reviewer (reliability) conf 75. `incrementBroadcastAttempts` runs Lua INCR via Redis; if Redis becomes unavailable BEFORE catch-path `decrementBroadcastAttempts`, the latter falls through to the memory-fallback branch (which has no record of the token) and returns silently. Redis-side counter persists inflated until 24h TTL. The new `accred_verify_broadcast_decrement_failed` event fires only if Redis throws — the silent-noop case has no signal.

Fix: in `decrementBroadcastAttempts`, when the Redis path is unavailable but the increment was Redis-backed (`redis && isRedisAvailable()` was true at INCR time), emit a structured warn (`event: 'accred_verify_broadcast_decrement_redis_unavailable'`) so operators have an anchor for counter drift correlated with Redis outages. The fallback-path silent-noop should NOT remain silent.

**11. (P3) `incrementBroadcastAttempts` rejection escapes the route's envelope discipline.** Single-reviewer (reliability) conf 75. The pre-INCR call at `accreditation.ts:300` sits OUTSIDE the try at line 349. A `redis.eval` rejection (OOM, Lua error, connection drop) propagates to Express 5's async handler → 500 INTERNAL_ERROR with no retry guidance. Asymmetric vs the broadcast site's 502/504 envelope discipline.

Fix: wrap the pre-INCR call in a try/catch returning 503 SERVICE_UNAVAILABLE with `{ retriable: true }` per the existing 503 pattern in this file. If a 500 is intentional (operator alerting captures it), document that decision in a one-line comment so the asymmetry isn't a future "what should I do here" question.

**12. (P3) Item 3 (env var wiring) has no direct test.** Single-reviewer (testing) conf 75. `config.verifyBroadcastAttemptsCap` is wired from `process.env.VERIFY_BROADCAST_ATTEMPTS_CAP`, but no test asserts this exact env-var name is read. All cap-related specs read `config.verifyBroadcastAttemptsCap` directly, so a typo in `config.ts` (e.g., `VERIFY_BROADCAST_CAP`) would silently pass every spec — they would just pin the default 3. Item 3's claim "operators can flip without redeploy" is not enforced.

Fix: add a config-level spec that mutates `process.env.VERIFY_BROADCAST_ATTEMPTS_CAP`, calls `vi.resetModules`, re-imports config, and asserts `config.verifyBroadcastAttemptsCap` reflects the mutated value.

**13. (P3) `decrementBroadcastAttempts` `if (after < 0) DEL` race-recovery branch untested.** Single-reviewer (testing) conf 75. The defensive floor at `accreditation.ts:126-131` handles the parallel-deleteToken-races-the-decrement case. Mutation: removing the DEL → counter at -1 persists in some orderings.

Fix: targeted unit-style spec — DEL the counter key, call `decrementBroadcastAttempts(token)` directly, assert the key is absent (`redis.get` returns null).

### Architect followups (land at archive, do NOT block backend re-submit)

**A1. (P2) `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` row missing from `agents/docs/api-contracts/accreditation.md` and `common.md`.** Cross-reviewer convergence (maintainability + api-contract, → conf 100). Architect's round-1 hold note explicitly committed to "Architect adds the corresponding row at archive time"; implementer's signal block carries `[TODO Architect]` marker. **MUST land before archive.**

**A2. (P3) Commit `1e90b87` body factual error about `[skip-zone-audit]` scope.** Single-reviewer (project-standards) conf 100. Body lines 52-56 claim `backend/src/types/api.ts` is "outside the strict ^backend/ zone the commit-msg hook validates." The path matches `^backend/` and would pass the zone audit on its own; only `.env.example` actually required `[skip-zone-audit]`. Already pushed; flag in this hold block (no rewrite of the pushed commit) so future agent commits don't repeat the error. Architect notes this in the round-3 archive entry.

### Pre-existing finding (file separately if desired)

**X1. (P2)** `seedAccreditationBonus` permanent-error throw at `accreditation.ts:357` propagates as a bare error to `handleBroadcastError` → emits 502 BROADCAST_FAILED with "Failed to broadcast accreditation to Hive" even though the broadcast succeeded. The ORCID surface fixes this via `PostBroadcastWriteError` (BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS); accreditation `/verify` does not have the equivalent discipline. NOT introduced by this round; pre-existing. File as a new follow-up task if you want to align `/verify` with the orcid post-broadcast cascade discipline. Listed here for visibility, not blocking round-3.

### Re-review signal

When items 1-13 land, `git mv` this file back to `tasks/review/` (use the prescribed `## Backend re-review signal (<date>, commit <sha>)` header per item 9). Round-3 architect review scopes `/ce-code-review` to the round-3 commit only. Architect addresses A1 + A2 at archive time.

---

## Backend re-review signal (2026-05-04, working tree)

Round-3 hold-fix items 1-13 landed. Architect followups A1 + A2 remain architect-owned at archive. Pre-existing X1 not addressed in this round.

### Item 1 — Token-hash redaction at decrement-failure + cleanup-failure log paths

Added `hashTokenForLogs(token)` (sha256 → first 12 hex chars) to `backend/src/lib/log-pii.ts`, mirroring the `hashEmailForLogs` shape. Replaced raw `token` with `token_hash` in two operator-log call sites in `backend/src/routes/accreditation.ts`: the timeout-decrement-failure warn (line 467) and the post-broadcast-failure delete-failure error (line 482). Both raw 64-hex tokens are removed from the log payload; operator correlation is preserved via the stable hash prefix.

Mutation-sensitive test for the warn path lives in the new round-3 hold #5 spec (item 5 below) — it serializes all `logger.warn` call args and asserts no 64-hex substring leaks. The existing 502+deleteToken-failure spec at line 345 was updated to expect `token_hash` instead of `token`.

### Item 2 — Soft-block on cap-exceeded

Chose **sub-option (ii) soft-block**: do NOT call `deleteToken` on the cap-exceeded path. Token stays alive; counter persists; both keys TTL out independently within 24h. Rationale documented inline at the route-level WHY comment block: a stolen-token attacker with `cap+1` rotating XFFs cannot mount the asymmetric token-burn DoS that destroys the legitimate user's token (cheap rotating IPs vs the 24h re-`/request` lockout under the 3/24h byAccount limiter). Sub-option (i) accept-and-document gives up the capability for free; sub-option (iii) verifyHiveSignature imposes a UX penalty on light-account users without ready Keychain access on the verify-link landing page.

User-facing message tweaked from "Request a fresh accreditation email" to "Please wait or request a fresh accreditation email" — soft-block lets the user wait out the burst rather than burn a fresh `/request` slot.

The cap-exceeded round-1 spec at line 416 was updated to assert `tokenExists(token) === true` and `broadcastAttemptCount(token) === cap + 1` (instead of the round-1 `false` and `0` shape).

### Item 3 — Loud no-Redis throw across all 7 cap specs

Replaced `if (!redis) return` with `if (!redis) throw new Error('Redis required for cap specs')` at all 7 cap-related specs (the 4 the round-2 worker landed plus the 3 the worker missed: lines 570, 586, 617 in the latest test file — `clears the attempt counter on terminal (502) broadcast failure`, `round-2 hold #5: cap-exceeded log emits structured event field`, and `round-2 hold #6: Lua INCR + EXPIRE-if-first`).

### Item 4 — Lua script imported instead of duplicated

Exported `INCR_AND_EXPIRE_IF_FIRST_LUA` from new `backend/src/lib/redis-scripts.ts` (created during this round to centralize shared Lua scripts; future scripts land here). The route imports from the lib; the Lua-atomicity test now imports the constant and uses it via `const script = INCR_AND_EXPIRE_IF_FIRST_LUA;` — verbatim duplication eliminated.

### Item 5 — Decrement-failure log path test

Added `round-3 hold #5: decrement-failure log path fires the structured warn discriminator on a 504 + redis.decr rejection without writing headers twice`. Spies on `redis.decr` with `mockRejectedValueOnce`, drives the `MockBroadcastTimeoutError` through the broadcast site, asserts response stays 504, the structured `event: 'accred_verify_broadcast_decrement_failed'` warn fires with the username discriminator, no raw 64-hex token leaks (cross-check of item 1), and `ERR_HTTP_HEADERS_SENT` does not appear in any captured warn payload (negative assertion for the Express-double-write regression).

### Item 6 — Deterministic barrier in concurrent-retry test

Replaced the brittle 100ms `setTimeout` fence at `tests/routes/accreditation.test.ts:523` with a deterministic poll loop: `while (Date.now() < deadline) { if (counter === cap+1) break; await sleep(5); }` with a 5-second deadline. Resilient on slow CI and on operator-tuned high caps (cap=10 → 11 parallel supertest invocations would have tightened the prior 100ms window).

### Item 7 — Lua docblock corrected to match implementation

Rewrote the Lua-script docblock in `backend/src/lib/redis-scripts.ts` (and the parallel comment in the route's `incrementBroadcastAttempts`) to describe the actual EXPIRE-on-every-transition-to-1 invariant (count==0 → count==1), not the prior "first-write-only" framing. Documented why safety is preserved across pre-INCR + DECR-on-timeout cycles: the TTL anchor `pending.expires_at` monotonically shrinks, so the counter's lifetime cannot exceed the token's even when EXPIRE re-fires after a decrement-recovery cycle. Re-priming TTL on EVERY INCR (irrespective of count) would break the invariant — the conditional gate is load-bearing.

### Item 8 — Concurrency-burst-vs-sequential-flood scope clarified

Updated the route-level WHY comment at the broadcast-cap section to explicitly state the cap is a **concurrency-burst defense**, not a sequential-flood defense. Sequential 502 retries are bounded by `deleteToken`'s side-effect on the first definitive failure (which drops both the pending row and the counter side-key); the cap engages on parallel retries where N concurrent `/verify` calls atomically claim slots and at most `cap` broadcasts fire. The existing test at line 568 was renamed to `clears the attempt counter on terminal (502) broadcast failure (sequential-flood scope per round-3 hold #8)` so the structural reason is grep-discoverable.

### Item 9 — Signal block header form

This round's signal block uses the prescribed form `## Backend re-review signal (<date>, working tree or commit SHA)` per `agents/backend/CLAUDE.md`. The historic round-2 `## Round-2 implementer signal (2026-04-30)` header was NOT renamed — past content stays as-is to preserve git-blame continuity; only this round's header follows the convention.

### Item 10 — Redis-unavailable warn in `decrementBroadcastAttempts`

Added an explicit Redis-unavailable branch inside `decrementBroadcastAttempts`: if `redis && !isRedisAvailable()` (Redis was reachable at INCR time but flapped before DECR), emit `event: 'accred_verify_broadcast_decrement_redis_unavailable'` warn with the `token_hash` discriminator before falling through. The silent-noop case now has an operator anchor for counter-drift correlation with Redis incidents.

### Item 11 — Pre-INCR wrapped in try/catch returning 503

Wrapped the pre-INCR `incrementBroadcastAttempts` call site at `accreditation.ts:300` in a local try/catch that emits a structured `event: 'accred_verify_broadcast_increment_failed'` warn and returns 503 SERVICE_UNAVAILABLE with `{ retriable: true }`. Symmetric to the existing 502/504 envelope discipline at the broadcast site; replaces the prior implicit 500 INTERNAL_ERROR-via-Express-async-handler shape with explicit retry guidance.

### Item 12 — Config-level env-var spec

Added `round-3 hold #12: VERIFY_BROADCAST_ATTEMPTS_CAP env var is wired through to config.verifyBroadcastAttemptsCap` spec. Mutates `process.env.VERIFY_BROADCAST_ATTEMPTS_CAP` to `'42'`, calls `vi.resetModules()`, dynamically re-imports `../../src/config.js`, and asserts `freshConfig.verifyBroadcastAttemptsCap === 42`. Restores the original env value + resetModules in the `finally` so subsequent tests aren't perturbed. A typo in `config.ts` (e.g., `VERIFY_BROADCAST_CAP`) would now fail this spec at the assert.

### Item 13 — Race-recovery DEL spec via `__test_seams`

Added a test-only seam export `export const __test_seams = { decrementBroadcastAttempts }` at the bottom of `accreditation.ts` (mirroring the precedent in `routes/orcid.ts`). The new `round-3 hold #13` spec pre-DELs the counter key, calls `accreditationTestSeams.decrementBroadcastAttempts(token)` directly, and asserts `redis.get(counterKey) === null` afterwards — the defensive `if (after <= 0) DEL` floor's race-recovery branch is now mutation-killed (removing the DEL leaves the counter at -1).

### Verification

- `npx tsc --noEmit` from `backend/` — clean.
- `npm run lint` — clean (only pre-existing `seed-phrase.ts` `any` warnings, unrelated).
- `npx vitest run tests/routes/accreditation.test.ts` (with docker-network Redis/Postgres IPs per root CLAUDE.md) — 20 passed (17 round-1+2 + 3 new round-3 specs), 0 failed, 4.47s. Pre-existing rate-limit pollution in `rejects free email`/`rejects yahoo email` is gone in this run because the test ordering happens to clear before they execute.

### Files changed (this round)

- `backend/src/routes/accreditation.ts` — Item 1 (token_hash at 2 sites), Item 2 (soft-block + WHY-comment), Item 7 (decrement-cycle docstring), Item 8 (cap-scope WHY-comment), Item 10 (Redis-unavailable warn), Item 11 (try/catch around pre-INCR), Item 13 (`__test_seams` export).
- `backend/src/lib/log-pii.ts` — Item 1 (`hashTokenForLogs` helper).
- `backend/src/lib/redis-scripts.ts` — NEW (Item 4 centralizing Lua scripts; Item 7 corrected docstring).
- `backend/tests/routes/accreditation.test.ts` — Item 3 (7 if-redis throws), Item 4 (import + use shared Lua constant), Item 5 (decrement-failure log spec), Item 6 (deterministic barrier), Item 12 (config env-var spec), Item 13 (race-recovery DEL spec), plus the existing 502+deleteToken spec updated to assert `token_hash` instead of raw `token`.
