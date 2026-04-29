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
