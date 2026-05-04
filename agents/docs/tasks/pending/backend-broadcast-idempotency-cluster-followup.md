# BACKEND-BROADCAST-IDEMPOTENCY-CLUSTER-FOLLOWUP — Option A.4 idempotency on custody /broadcast and accreditation /verify

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by cluster-B `/ce-code-review` of α and δ + pre-existing δ X1)
**Priority:** P1 (reliability)

## Why now

Two cluster-B reviews surfaced the same retry-amplification class on broadcast paths:

1. **α custody `/broadcast`** — Reliability R-3 + adversarial adv-1 cross-corroborated, conf 100. dhive constructs a fresh transaction per `sendOperations` call with a new expiry, so a retried `/broadcast` does NOT collide at the Hive dedup layer. `logCustodyBroadcast` (audit log) fires only on success. Per-account rate limit is 30/min. 504 envelope's `verify_before_retry: true` is advisory only; the SPA may retry blindly. Net: a network hiccup → 504 → user retries → both broadcasts land → silent duplicate vote / duplicate `comment` / duplicate `custom_json`. Audit log shows only the second.

2. **δ accreditation `/verify`** — Pre-existing finding X1 from δ round-3 review. `seedAccreditationBonus` permanent-error throw at `accreditation.ts:357` propagates as a bare error to `handleBroadcastError` → emits 502 BROADCAST_FAILED with "Failed to broadcast accreditation to Hive" even though the broadcast succeeded. The ORCID surface fixes this via `PostBroadcastWriteError` (`BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`); accreditation `/verify` does not have the equivalent discipline. The cap that round-3 added bounds amplification but doesn't ensure outcome convergence.

Both surfaces are documented in `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.4 as the durable structural fix. Round-3 of δ declined to implement Option A.4 ("out of scope"). α's first round noted: "no idempotency token, audit log success-only, advisory verify_before_retry."

## Goal

Implement Option A.4 (idempotency_key in payload + post-broadcast HAF check) on both surfaces, plus survey other broadcast surfaces for the same class.

## Acceptance

### 1. Custody `/broadcast` idempotency

Add an idempotency layer to `backend/src/routes/custody.ts`:
- Client (frontend SPA) generates a UUID per logical operation; passes as `idempotency_key` in the request body.
- Backend computes `evidence_hash = sha256(${username}:${idempotency_key}:${operations_hash})` for HAF dedup.
- BEFORE broadcasting: query HAF for an existing op with `evidence_hash` in `json_metadata.pevotest.idempotency_key` (or equivalent). If found, return 200 with the existing tx_id (`outcome: 'already_landed'`). NO second broadcast.
- AFTER broadcasting: include the `idempotency_key` in the broadcast op's `json_metadata`.
- On 504 timeout: response carries `{idempotency_key, verify_before_retry: true}` so the client can retry SAFELY (the retry's HAF lookup will find the landed op).
- On 502 failure: rate-limit + Redis tracking of failed `idempotency_key`s prevents replay-storm.

Per-op uniqueness: the idempotency check must be scoped per-op-type. A duplicate vote and a duplicate custom_json have different downstream effects; the check key must distinguish them.

### 2. Accreditation `/verify` idempotency + post-broadcast write isolation

Two parallel fixes:

(a) **Idempotency_key in `accredit` custom_json payload.** Add `idempotency_key: sha256(token + nonce)` to the `customJsonPayload` constructed at `accreditation.ts`. Backend reads existing `accredit` ops via HAF before broadcasting; if a row with the same `idempotency_key` exists, return 200 with the existing tx_id (no second broadcast).

(b) **`PostBroadcastWriteError` discipline.** Per the existing `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` pattern (used by ORCID), `seedAccreditationBonus` failures should NOT propagate as a 502 BROADCAST_FAILED when the broadcast itself succeeded. Wrap `seedAccreditationBonus` in the cascade-fns-rethrow-permanent-errors discipline:
- Broadcast successful + bonus-seed fails → emit `PostBroadcastWriteError` → 502 with `code: 'POST_BROADCAST_FAILED'` (different code from `BROADCAST_FAILED`) + structured log `event: 'accred_verify_post_broadcast_write_failed'`.
- Operator alert wires to "broadcast confirmed but post-broadcast write failed" — different on-call routing.

This is a CONTRACT change; architect adds the new `POST_BROADCAST_FAILED` code row to `accreditation.md` + `common.md` at archive.

### 3. Survey other broadcast surfaces

Audit + classify each surface for amplification class:
- `bridge.ts /register` + `/update` — admin-signed; bridge writes are per-deterministic-permlink so chain rejects duplicate. May not need idempotency_key, but verify.
- `papers.ts /retract` — admin/author-signed; what's the duplicate-retract behavior?
- `claims.ts /approve` + `/revoke` — bridge or admin signer; idempotent?
- `wot.ts /vouch` — vouch op idempotency?
- `anonymousReview.ts` — proxy-signed; per-review uniqueness?

For each: document the amplification class in a new convention sub-section. File follow-up tasks for any that need explicit idempotency.

### 4. Convention update

Update `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`:
- Move Option A.4 from "documented but not implemented" to "implemented at custody + accreditation; remaining surfaces audited in `<this task slug>`".
- Cross-reference the new `POST_BROADCAST_FAILED` code (separate from `BROADCAST_FAILED`).
- Architect-owned zone; backend adds [TODO Architect] markers, architect lands the prose at archive.

## Out of scope

- Refactoring `handleBroadcastError` to wire the idempotency layer in. The helper is generic; idempotency is per-route. Each route adds its own pre-broadcast HAF check.
- Cross-route idempotency cache (e.g., Redis-backed lookup of recent idempotency_keys). Per-request HAF query is sufficient at current scale.
- Generic outbox pattern. Per-route per-op idempotency is the right level of abstraction for now.
- Frontend SPA changes to generate + send `idempotency_key` for custody `/broadcast`. File as a separate UI task `ui-custody-broadcast-idempotency-key.md` (the SPA today posts ops without idempotency keys; the backend layer needs the key from SOMEWHERE — design choice on whether SPA generates it or backend generates + returns).

## Coordination

- **α's hold-block:** α landed the audit-log half ("always-log custody attempts, not just success"). The full idempotency layer is THIS task. Sequence: α round-4 lands (closes audit-log gap); this task lands (closes the duplicate-broadcast gap).
- **δ's hold-block:** δ round-4 doesn't depend on this task. Once δ archives, this task closes the X1 pre-existing gap that δ deferred.
- **Frontend SPA work:** if SPA-generated idempotency_key is the chosen design, file `ui-custody-broadcast-idempotency-key.md` and coordinate.

## Source

- α `/ce-code-review` (cluster B, 2026-05-04): reliability R-3 + adversarial adv-1 cross-corroborated. Filed in α's "Items dismissed" → "Filed as separate task".
- δ `/ce-code-review` (cluster B, 2026-05-04): pre-existing finding X1 carried forward.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.4 — the durable structural fix this task implements.

## Cross-references

- ORCID's `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` (archived) — the pattern accreditation `/verify` will adopt.
- `agents/docs/api-contracts/custody.md`, `accreditation.md`, `common.md` — contract additions at archive.
