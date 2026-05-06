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

---

## [BLOCKED by Architect] (backend startup triage 2026-05-05)

The "Coordination" clause above sequences this task explicitly: "α round-4 lands (closes audit-log gap); this task lands (closes the duplicate-broadcast gap). Once δ archives, this task closes the X1 pre-existing gap that δ deferred." Both prerequisites are still in `tasks/review/`:

- `backend-continuation-post-author-consent-gate.md` (α) — round-3 hold items 1-2 landed at commit `77db9cf`; awaiting architect round-4 review.
- `backend-verify-broadcast-attempts-cap.md` (δ) — awaiting architect archive.

Implementing this task before α/δ archive risks colliding with their final hold-fix passes on the same broadcast surfaces. Move back to `tasks/pending/` once both predecessors archive.

---

## Backend round-1 implementation (2026-05-06)

### Files landed

- `backend/src/lib/idempotency.ts` (new) — `embedIdempotencyKey`, `findCustodyBroadcastByIdempotencyKey`, `findAccreditByIdempotencyKey`, `validateIdempotencyKey`, `logIdempotencySkip`. Pure-shape helper + two HAF lookup queries scoped by username (custody) or accreditationAuthorities (accredit).
- `backend/src/routes/custody.ts` — `idempotency_key` is an optional body field. When present, the route runs the HAF lookup BEFORE the consent-op fresh-auth verification (so a retry never burns a fresh proof) and AFTER per-op validation + multi-consent rejection (so malformed retries return 4xx, not a misleading 200). HAF hit returns `{ tx_id, block_num, outcome: 'already_landed' }` and skips broadcast. HAF miss embeds the key into the first comment / custom_json op's `json_metadata.<appTag>.idempotency_key` (comments) or `json.idempotency_key` (custom_json) before broadcasting. Pure-vote bundles emit `event:'custody.broadcast.idempotency_no_embed_surface'` warn and broadcast unembedded (vote re-cast is low-harm: VP cost only). Missing-key requests emit `event:'custody.broadcast.idempotency_key_missing'` warn so operators can measure the SPA migration window. HAF-unavailable / lookup-throw degrade gracefully with structured warns.
- `backend/src/routes/accreditation.ts` — `/verify` always emits `idempotency_key = sha256(${pending.token}:${pending.hive_username})` (deterministic per token, decoupled from email so the on-chain field carries no PII). Pre-broadcast HAF lookup short-circuits to `{ message, username, tx_id, outcome: 'already_landed' }` on hit + best-effort token cleanup. New `idempotency_key` field added to `customJsonPayload` (alongside the existing `evidence_hash`). `seedAccreditationBonus` is wrapped in `PostBroadcastWriteError(result.id, seedErr, 'reputation_seed')` so a downstream cascade failure surfaces as 502 `POST_BROADCAST_FAILED` with `details: { retriable: false, outcome: 'confirmed', tx_id, failed_step: 'reputation_seed' }` instead of the over-cautious 502 `BROADCAST_FAILED` (X1 from δ round-3 closes here). The catch's existing `'failure'` branch deletes the token; the new `'post_broadcast'` outcome path is a no-op (token was already cleaned on the success path before the seed throw, chain op is confirmed, missed bonus reconciles via the next reputation batch cycle).

### Tests

- `backend/tests/lib/idempotency.test.ts` (new, 18 specs) — pure-shape: validate, embed (comment / custom_json / vote-only no-embed / multi-op first-op-wins / fresh-array / malformed metadata fallthrough), find* (hit on first arm, fall through to second, both empty, scope assertions on SQL params).
- `backend/tests/routes/custody-idempotency.test.ts` (new, 7 specs) — HAF hit on each arm short-circuits (no broadcast call), HAF miss embeds key into broadcasted ops, malformed key → 400 before HAF call, missing key → migration warn + broadcast, pure-vote no-embed warn, HAF lookup throw → degraded warn + broadcast still succeeds.
- `backend/tests/routes/accreditation-idempotency.test.ts` (new, 3 specs) — HAF hit returns existing tx_id with `outcome: 'already_landed'` + token cleaned, HAF miss broadcasts with `idempotency_key` in payload, `seedAccreditationBonus` throw → 502 `POST_BROADCAST_FAILED` carrying `tx_id` + `failed_step: 'reputation_seed'`, internal error msg not leaked.

### Survey of other broadcast surfaces (Acceptance #3)

Each surface classified as `chain-deduped` (Hive consensus rejects the duplicate at op-validation), `query-deduped` (chain accepts duplicates but the read-side CTE/query collapses to latest-wins), or `needs-idempotency` (no dedup at any layer; duplicate persists with material effect or operator-visible noise).

| Surface | Op type | Class | Notes |
|---|---|---|---|
| `bridge.ts` `POST /register` (`broadcastSendOperationsWithTimeout` at `routes/bridge.ts:391`) | `comment` (deterministic permlink, bridge-signed) | **chain-deduped** | Hive `comment_operation` rejects duplicate `(author, permlink)` pairs at consensus → second broadcast emits 502 `BROADCAST_FAILED` ("permlink already exists"). Class is "operator-misclassified": the chain op succeeded, but the route reports failure → broadcast on-call paged for a benign retry. Could benefit from the `PostBroadcastWriteError`-style discrimination at archive time (file as separate followup), but **does not need an idempotency_key** because the chain layer is already enforcing uniqueness. |
| `bridge.ts` `POST /update` (`routes/bridge.ts:549`) | `comment` (same) | **out-of-scope** | Being retired by `backend-retire-bridge-update-route.md`. Skip. |
| `claims.ts` `POST /:claimer/approve` (`routes/claims.ts:216`) | `custom_json` `approve_authorship` (bridge-signed) | **needs-idempotency** | Custom_jsons are NOT chain-deduped. The active-claim CTE collapses to latest-wins, so a duplicate approve has no MATERIAL effect, but the on-chain row count grows and operator log noise increases. Medium priority — file separate followup `backend-claims-approve-revoke-idempotency.md`. |
| `claims.ts` `POST /:claimer/revoke (bridge signer)` (`routes/claims.ts:313`) | `custom_json` `revoke_authorship` (bridge-signed) | **needs-idempotency** | Same class as approve. Same followup task. |
| `claims.ts` `POST /:claimer/revoke (admin signer)` (`routes/claims.ts:347`) | `custom_json` `revoke_authorship` (admin-signed) | **needs-idempotency** | Same class. Same followup task. |
| `papers.ts` `POST /:author/:permlink/retract` (`routes/papers.ts:1953`) | `custom_json` `retract` (admin-signed) | **needs-idempotency** | Custom_json. Latest-wins at the read-side `retractedPapersCteBody` → no MATERIAL effect from a duplicate, but on-chain row noise. Medium priority — file separate followup `backend-papers-retract-idempotency.md`. |
| `wot.ts` vouch path (`wot.ts:225`) | `custom_json` `vouch` (user-signed) | **query-deduped** | Custom_json. `activeVouchesCte` ranks by `(voucher, vouchee)` `ROW_NUMBER() OVER ORDER BY block_num DESC` → only the latest counts. Low priority; the row-noise class is the only delta. File optional followup `backend-wot-vouch-idempotency.md` if/when on-chain noise becomes operator-visible. |
| `wot.ts` retract_vouch path (`wot.ts:364`) | `custom_json` `retract_vouch` (user-signed) | **query-deduped** | Same as vouch. Same optional followup. |
| `anonymousReview.ts` proxy comment (`routes/anonymousReview.ts:175`) | `comment` (deterministic permlink, anon-proxy-signed) | **chain-deduped** | Same as bridge `/register` — Hive `comment_operation` rejects the duplicate. Operator-misclassification class only. |
| `anonymousReview.ts` attestation (`routes/anonymousReview.ts:216`) | `custom_json` `anon_attestation` (anon-proxy-signed) | **needs-idempotency** (low priority) | Custom_json fired in its OWN try/catch where errors are logged-and-swallowed — the duplicate-on-retry case is already silently absorbed at the call site, but the on-chain row noise persists. Low priority — file optional followup `backend-anonymous-review-attestation-idempotency.md` only if the noise becomes operator-visible. |

### Followup tasks recommended (architect to file at archive)

1. `backend-claims-approve-revoke-idempotency.md` — extend the idempotency layer to claims `/approve` + `/revoke` (both signers).
2. `backend-papers-retract-idempotency.md` — extend the layer to `papers /retract`.
3. (optional, low priority) `backend-wot-vouch-idempotency.md` and `backend-anonymous-review-attestation-idempotency.md` — extend to wot vouch / retract and anonymous-review attestation if on-chain row noise becomes operator-visible.
4. (optional) `backend-bridge-register-postbroadcast-discrimination.md` — adopt `PostBroadcastWriteError` discrimination on `bridge /register` so the chain-rejected-as-duplicate path emits 200 with `outcome: 'already_landed'` instead of 502 `BROADCAST_FAILED`. Same followup applies to `anonymousReview.ts` proxy comment.

These are P2 (medium-priority) followups for the chain-noise-only class and can land in any order against this task's archive.

---

## [TODO Architect] Convention update

Update `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` at archive:

1. Move Option A.4 from "documented but not implemented" to "implemented at custody `/broadcast` (opt-in via SPA-supplied `idempotency_key` body field) + accreditation `/verify` (deterministic per-token key)". Cross-reference this task's slug as the implementation marker.
2. Add a sub-section "Per-surface amplification class" with the survey table above (chain-deduped / query-deduped / needs-idempotency). Cross-reference the four followup task slugs.
3. Document the new `POST_BROADCAST_FAILED` code as the discrimination pattern for "broadcast confirmed but post-broadcast cascade failed". Note the operator-alert-routing distinction (DB on-call vs broadcast on-call). Cross-reference `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` (ORCID's adoption) and this task (accreditation's adoption).

## [TODO Architect] Contract updates

Update `agents/docs/api-contracts/custody.md` at archive:

1. Add optional `idempotency_key: string` (1-128 chars) body field to `POST /api/custody/broadcast`. Document semantics: client generates a UUID per logical operation; backend embeds in the first comment or custom_json op's `json_metadata.<appTag>.idempotency_key` (comment) or `json.idempotency_key` (custom_json); pre-broadcast HAF lookup short-circuits to 200 with `outcome: 'already_landed'` if a prior op carrying the same key landed. Pure-vote bundles silently bypass the layer.
2. Document the success response shape extension: `{ tx_id, block_num, outcome?: 'already_landed' }`. The `outcome` field is omitted on a fresh broadcast and present only on the idempotency-hit path.
3. Document the new operator log events: `custody.broadcast.idempotency_hit`, `custody.broadcast.idempotency_key_missing` (migration-window signal), `custody.broadcast.idempotency_no_embed_surface`, `custody.broadcast.idempotency_haf_unavailable`, `custody.broadcast.idempotency_lookup_failed`.

Update `agents/docs/api-contracts/accreditation.md` at archive:

1. Document the new `idempotency_key` field embedded in the on-chain `accredit` custom_json payload alongside the existing `evidence_hash`. The on-chain field is `sha256(${token}:${hive_username})` (deterministic per token, no PII).
2. Document the success response shape extension: `{ message, username, tx_id, outcome?: 'already_landed' }`. The `outcome` field is present only on the HAF idempotency hit (no re-broadcast).
3. Add a new error row `POST_BROADCAST_FAILED` (HTTP 502) with `details: { retriable: false, outcome: 'confirmed', tx_id: string, failed_step: 'reputation_seed' }`. Discriminates from `BROADCAST_FAILED`: the chain op is confirmed; the failure is in the post-broadcast cascade (`seedAccreditationBonus`). Operator alerts route to DB on-call instead of broadcast on-call.
4. Document the new operator log events: `accreditation.verify.idempotency_hit`, `accreditation.verify.idempotency_lookup_failed`, `accreditation.verify.idempotency_haf_unavailable`, `accreditation.verify.idempotency_hit_token_cleanup_failed`.

Update `agents/docs/api-contracts/common.md` at archive:

1. Add `POST_BROADCAST_FAILED` to the broadcast-error code table alongside `BROADCAST_FAILED` and `BROADCAST_TIMEOUT`. Note the `details.outcome: 'confirmed'` discriminator.

The architect lands these contract edits in the archive commit (per CLAUDE.md "Boundaries" — backend agent does NOT edit `api-contracts/*.md` under any circumstances).
