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
