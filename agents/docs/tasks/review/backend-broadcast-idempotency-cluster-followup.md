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

---

## Architect re-review (2026-05-11) — HELD PENDING FIXES

Re-review of commit `c8153e3` via `/ce-code-review` invoked directly from the architect context. Reviewer team (11 personas): correctness, security, adversarial (Opus tier), testing, maintainability, project-standards, performance, api-contract, reliability, learnings, kieran-typescript (Sonnet tier). Skipped `ce-agent-native-reviewer` per CLAUDE.md.

The Option A.4 design is sound. The implementation has correctness gaps, a cascade-failure class, and several polish items. Triage produced 19 hold items grouped below; F14 / F25 / F27 dismissed; F6 part 2 + F7 filed as new pending tasks.

### Items held — accreditation /verify correctness (Hi)

1. **F1 — idempotency-hit cascade fix.** On the HAF-hit branch in `routes/accreditation.ts:489-525`:
   - Add `await decrementBroadcastAttempts(token, attemptId)` before `return sendOk(...)`. Mirror the timeout-path decrement at line 623. Without this, idempotency-hit retries permanently consume the broadcast-attempts cap; after `cap` retries the user gets 502 `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` on a confirmed-on-chain accreditation + 24h `/request` lockout.
   - Add `await seedAccreditationBonus(username)` (wrapped per F3's discipline below) before `return sendOk(...)` so the bonus seed fires on the hit branch too. Original spec acceptance #2(b) called for this; current code skips it. Bonus is otherwise missing until batch cycle reconciles.

2. **F2 — cross-op-type idempotency_key shadowing + fresh-auth proof bypass.** Plumb `embedded.opType` from `embedIdempotencyKey` through to `findCustodyBroadcastByIdempotencyKey` (NB: renamed below to `findAccreditationBroadcastByIdempotencyKey`'s sibling — see F23) and skip the non-matching probe arm in SQL. **AND** reorder `routes/custody.ts` so the consent-op fresh-auth verification (currently at line ~399) runs **before** the idempotency check (currently at line ~302) on consent-op bundles. Closes both shadowing (HAF lookup keyed on `(username, key, op_type)`) and fresh-auth-bypass-on-key-collision. Fresh-auth proofs are single-use anyway — a SPA retry must re-derive the proof regardless.

3. **F3 — PostBroadcastWriteError contract divergence: transient vs permanent discrimination.** `accreditation.ts:670-673` comment + 502 user message say "next cycle reconciles," but `reputation.ts:119-123` explicitly states permanent errors do NOT self-heal. Discriminate at the wrap site:
   - Introduce a new error code (e.g., `POST_BROADCAST_OPERATOR_REQUIRED`) for the permanent-error branch.
   - User message accurate per branch: transient → "will reconcile automatically"; permanent → "support has been notified."
   - Structured log severity bumped on the permanent branch (operator-paged dashboard signal). Use `logger.error` instead of `logger.warn` on the operator-required branch.
   - The new error code becomes a `common.md` addition (see supplementary TODO Architect below).

4. **F8 — wrap `deleteToken` on the success path.** `accreditation.ts:569` is currently a bare `await deleteToken(token)` after broadcast confirmed. Wrap in try/catch with `logger.warn({..., event: 'accreditation.verify.delete_token_failed_post_success' }, '...')`; same pattern as the existing idempotency-hit-path token cleanup at line ~501. Closes the `ERR_HTTP_HEADERS_SENT` Express-5 ordering risk previously hit on this same route (`helper-extraction-express5-response-ordering-2026-04-28.md`).

### Items held — broadcast-path infra (Mid)

5. **F4 — HAF pool `onConnect` race fix.** Replace `pool.on('connect', client => { client.query('SET statement_timeout = 30000').catch(...) })` in `backend/src/db.ts:21` with the `onConnect` Pool-constructor option:
   ```ts
   new Pool({
     // ...
     async onConnect(client) {
       await client.query('SET statement_timeout = 30000');
     },
   });
   ```
   Pre-existing race exposed by this commit's new HAF query volume on cold pools. Without the change, the first idempotency lookup on a new connection runs with NO statement_timeout applied.

6. **F5 — Redis short-circuit cache for HAF idempotency lookup.** **Explicit scope expansion** over the original task spec which excluded Redis caching ("Per-request HAF query is sufficient at current scale"). The HAF JSONB extraction is not indexed for `idempotency_key`, and HAF-side indexes are NOT a path (`reference_haf_indexes_cannot_be_modified.md`). Cache `(username, idempotency_key) → IdempotencyHit | null` with discipline from `caching-wrapper-discriminated-union-poisoning-2026-05-11.md`:
   - Cache only the resolved `Hit | null` values.
   - **Never cache** `haf_unavailable` or `lookup_failed` states — those must fall through to current degradation paths.
   - Key prefix per appTag convention (`${config.appTag}:idem:<scope>:<sha256(username|key)>` or equivalent).
   - Positive-cache TTL = `max(observed HAF indexer lag, 60s)` (per F12 — bridges the indexer-lag defense window).
   - Negative-cache TTL = short, 5-10s, to avoid masking genuine state changes.
   - Rationale documented inline at the cache layer + in the convention update (architect at archive).

7. **F10 — rename `isHafAvailable()` → `isHafConfigured()`.** The function tests config presence, not live reachability. Rename in `backend/src/db.ts:34` + all call sites. Rename log event `accreditation.verify.idempotency_haf_unavailable` → `accreditation.verify.idempotency_haf_unconfigured` (and the custody counterpart). Add clarifying comment at each idempotency call site: this tests config, not reachability; `_lookup_failed` is the real-outage signal. The supplementary TODO Architect below adjusts the contract docs to match the renamed events.

### Items held — type safety + lookup polish (Mid)

8. **F11 — `validateIdempotencyKey` returns a discriminated result.** Change the signature from `(value: unknown) => string | null` (null on success, error message on failure — ambiguous) to `(value: unknown) => { ok: true, value: string } | { ok: false, error: string }`. Narrow at call sites in `routes/custody.ts:197-201` and remove the `as string` cast. Closes the type-safety gap where future validator extensions would silently bypass the checker.

9. **F13 — coerce `block_num: null` to `undefined` in custody idempotency-hit response.** In `routes/custody.ts:319-323`, change `block_num: existing.block_num` to `block_num: existing.block_num ?? undefined`. SPA arithmetic on `undefined` produces NaN (visible failure) instead of silently coercing `null` to 0. Accreditation already omits `block_num` on its hit path; this brings custody to the same safe behavior.

10. **F15 — fold into F2's opType plumbing.** Use the plumbed `opType` to skip the non-matching HAF probe arm in `findCustodyBroadcastByIdempotencyKey` (now sibling to F23's rename). Halves HAF round-trips on cache-miss paths.

### Items held — module cleanup (Low)

11. **F22 — delete `logIdempotencySkip` + inline at call sites.** The wrapper at `lib/idempotency.ts:252-258` is a one-liner with no added discipline. Hit events bypass it (call `logger.warn` directly), creating an undocumented asymmetric rule. Replace each of the 4 call sites with `logger.warn({ ...fields, event }, msg)`; delete the wrapper.

12. **F23 — rename `findAccreditByIdempotencyKey` → `findAccreditationBroadcastByIdempotencyKey`.** Parallel symmetry with `findCustodyBroadcastByIdempotencyKey`. Three call sites. Establishes the naming precedent for the survey table's four follow-up surfaces (claims, papers, wot, anon-review).

13. **F24 — add one-line comment at `routes/accreditation.ts:554`** `customJsonPayload` construction explaining why `embedIdempotencyKey` is not used (single known-shape op; inline rather than via the generic bundle scanner). Documents the convention: future surfaces with opaque bundles use the helper; surfaces with internally-constructed single ops inline the field.

14. **F26 — hoist `params` cast in `embedIdempotencyKey`.** Move `const params = opParams as Record<string, unknown>` to immediately after the null-guard at `lib/idempotency.ts:83`; remove the per-branch casts at lines 86 and 110. Removes the "remember to cast" tax for future op-type additions.

### Items held — test coverage (Low; some folds together)

15. **F6 (part 1) — fix carve-out header overclaim in `backend/tests/lib/idempotency.test.ts:9`.** The header currently claims `tests/routes/{custody,accreditation}*.test.ts` exercise real HAF — both companions also mock `db.js`. Update the header to:
   - Acknowledge the integrated path is also mocked at the route layer.
   - Cite the new follow-up task slug **`backend-idempotency-haf-integration-test.md`** (architect files in this same pass — see below) as the real-path coverage commitment per carve-out clause (c).

16. **F9 + F19 + F20 — accreditation idempotency test additions.** Extend `backend/tests/routes/accreditation-idempotency.test.ts` with three new specs:
   - **HAF lookup throw:** `hafQueryMock` rejects → broadcast still fires; assert `logger.warn` called with `event: 'accreditation.verify.idempotency_lookup_failed'`; response is fresh-broadcast shape (no `outcome`).
   - **HAF unconfigured:** `isHafConfigured` returns false → broadcast still fires; assert `logger.warn` called with `event: 'accreditation.verify.idempotency_haf_unconfigured'` (per F10 rename); response is fresh-broadcast shape.
   - **Token cleanup failure on hit:** `deleteToken` mocked to throw on the idempotency-hit path → response is 200 unaffected; assert `logger.warn` called with `event: 'accreditation.verify.idempotency_hit_token_cleanup_failed'`.
   - **Hit-path event pin:** extend the existing HAF-hit specs to assert `logger.info` was called with `event: 'accreditation.verify.idempotency_hit'` + fields (`username`, `email_hash`, `tx_id`).

17. **F12 (part 2) — TTL choice + rationale in F5's Redis layer.** Implementation note in the cache layer documents: positive-cache TTL = `max(observed HAF indexer lag, 60s)` to bridge the documented indexer-lag defense window; negative-cache TTL = 5-10s short to avoid masking genuine state changes. Add the rationale inline.

18. **F21 — extend vote-only no-embed spec at `custody-idempotency.test.ts:243`.** Currently asserts only `event` discriminator. Pin the full warn payload shape via `toMatchObject`:
    ```ts
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'custody.broadcast.idempotency_no_embed_surface',
        idempotency_key: expect.any(String),
        op_types: expect.arrayContaining(['vote']),
      }),
      expect.any(String),
    );
    ```

### Dismissed at triage (recorded for transparency; do not implement)

- **F14 — `operations_hash` dropped from key derivation.** F2's `op_type` binding in the HAF lookup closes the cross-shadowing class without re-introducing `operations_hash` composition (which would require backend-side canonicalization with non-trivial determinism risk). Architect documents the chosen design (op_type-bound lookup, no operations_hash composition) in the convention update at archive.
- **F25 — `event` parameter typed `string` not literal union.** F22 deletes the helper; project-wide pino event-name discipline is out of scope for this task.
- **F27 — `idempotency_key` validator accepts 1-128 char strings, no shape enforcement.** F2's op_type binding closes the adversarial cross-shadowing class; remaining self-DoS via predictable keys is user-shoots-self-in-foot. Architect documents recommended SPA-side discipline (UUID v4 from `crypto.randomUUID()`) in convention update at archive; no backend enforcement.
- **F18 — pure-vote bundle bypass doubles VP burn on whale accounts.** Accepted limitation per PEvO's "no Hive rewards as value proposition" posture. Architect documents in the per-surface amplification table at archive.

### Filed as new pending tasks (architect at this pass)

- **`backend-idempotency-haf-integration-test.md`** — real-path HAF integration test (F6 part 2). Carve-out clause (c) compliance. Backend follow-up.
- **`backend-accreditation-existing-accreditation-gate.md`** — add `getExistingAccreditation` HAF gate to `/verify` before broadcast (F7). Returns `outcome: 'already_accredited'` on prior accredit op. Closes the multi-token duplicate-broadcast class structurally; pre-existing structural gap, not introduced by this commit.

When all 18 items above land, `git mv` this file back to `tasks/review/` for re-review and archive.

---

## [TODO Architect] (supplementary — added by re-review 2026-05-11)

### Convention update additions

Beyond the original 3 items in `chain-write-timeout-ambiguous-outcome-2026-04-22.md`, also land at archive:

4. **(F12 part 1) Defense window framing.** Document explicitly that Option A.4's defense window is bounded by HAF indexer lag (~5-30s typical), and that the PEvO Redis short-circuit layer (added under F5) is what bridges the fast-retry-after-timeout class — without the Redis layer, the bare HAF lookup catches only slow-retry-after-confirmed (>30s post-broadcast retries).
5. **(F14) Design choice: op_type-bound lookup, no operations_hash composition.** Document that the implementation chose to bind `op_type` into the HAF lookup at the SQL level (rather than re-introducing `operations_hash` composition into the embedded key) to avoid backend-side canonicalization determinism risk. The on-chain field is the raw client-supplied key; cross-op-type shadowing is closed at the lookup layer.
6. **(F18) Per-surface amplification table sub-note.** Under the `vote` op-class entry in the new per-surface amplification table: "pure-vote bundles have no embed surface; Hive re-vote semantics burn VP afresh on retry; idempotency layer cannot close this class. Accepted limitation given PEvO's no-rewards-value-proposition posture."
7. **(F27) SPA-side discipline.** Recommend (non-binding) that SPA implementers generate `idempotency_key` via `crypto.randomUUID()` to avoid predictable-key enumeration. PEvO backend does not enforce a shape per task spec rationale ("avoid coupling the wire shape to a specific format") to keep AGPL forks flexible.

### Contract update adjustments

- **(F17) Common.md framing.** The original item "Add `POST_BROADCAST_FAILED` to the broadcast-error code table" is **stale** — the row was already added by a prior commit in this cluster. Treat as a **verify step**: read the existing `common.md:73` row, confirm it matches code's emitted shape, mark complete. **AND** add the new permanent-error code from F3 (e.g., `POST_BROADCAST_OPERATOR_REQUIRED`) when that hold item lands.
- **(F10 rename propagation) Log event renames in contract docs.** When landing the original `accreditation.md` and `custody.md` updates, use the renamed event names: `idempotency_haf_unconfigured` (not `idempotency_haf_unavailable`).
- **(F13 part 2) AC-3 block_num nullability.** In the custody.md "success response shape extension" item, document `block_num: number | null` semantics — block_num is present and non-null on fresh broadcasts; may be null (or omitted post-F13-fix coercion) on the idempotency-hit path. SPA code must handle absence without throwing.
- **(F16) Hive-schemas.md addition.** Update `agents/docs/hive-schemas.md` section 2.1 (accreditation): add `idempotency_key` field to the `accredit` custom_json schema. One-line note: "Deterministic per `(token, username)` via `sha256(token:username)`; no PII (token entropy preserved, username already public). Used for pre-broadcast HAF dedup on `/api/accreditation/verify`."

---

## Backend re-review signal (2026-05-11, commit `689208f`)

All 18 hold items landed in a single round-2 commit (`689208f`, 40 files / +1039/-290).
Grouped by section below; `event:` discriminators + new error code are
operator-alert anchors and tested.

### Accreditation /verify correctness (Hi)

- **F1** — `backend/src/routes/accreditation.ts` HAF-hit branch now decrements
  the broadcast-attempt cap via `decrementBroadcastAttempts(token, attemptId)`
  AND wraps `seedAccreditationBonus(username)` inline. Both are best-effort;
  a transient decrement failure or token-cleanup failure logs and continues,
  but a PERMANENT `seedAccreditationBonus` throw surfaces as 502
  `POST_BROADCAST_OPERATOR_REQUIRED` via `handleBroadcastError` locally
  (separate try/catch on the hit branch — the success-path catch only covers
  the broadcast call, so a re-throw would propagate to Express's async-error
  handler). Test: `tests/routes/accreditation-idempotency.test.ts` "HAF hit
  returns existing tx_id ... but still seeds bonus and decrements cap
  counter" (asserts counter ≤ 0 after hit, `seedBonusMock` called, hit-event
  fields pinned via `toMatchObject`).
- **F2** — `lib/idempotency.ts` `findCustodyBroadcastByIdempotencyKey` accepts
  optional `opType: 'comment' | 'custom_json'` and probes only the matching
  HAF arm when supplied. `routes/custody.ts` now runs `embedIdempotencyKey`
  FIRST (it's pure), threads the resolved `embedded.opType` into the
  lookup, and commits the embedded ops only on the miss path. Fresh-auth
  verification was hoisted ABOVE the idempotency check on consent-op
  bundles (the previous "idempotency-first" ordering allowed a key-collision
  to bypass the fresh-auth gate). Tests: `tests/lib/idempotency.test.ts`
  new "opType-scoped lookup" describe block (5 specs: scoped-comment,
  scoped-custom_json, undefined falls back to two-arm probe);
  `tests/routes/custody-idempotency.test.ts` per-arm hit specs assert
  `hafQueryMock.toHaveBeenCalledTimes(1)` and matching SQL substring.
- **F3** — `lib/broadcast-error.ts` `PostBroadcastWriteError` gains
  `severity: 'transient' | 'permanent'` (default `'transient'` so existing
  ORCID callers retain POST_BROADCAST_FAILED semantics).
  `handleBroadcastError` discriminates on `severity`: permanent →
  `POST_BROADCAST_OPERATOR_REQUIRED` + "support has been notified" message;
  transient → existing POST_BROADCAST_FAILED + "will reconcile automatically".
  Both branches log at `.error` with `severity` in the structured payload.
  `routes/accreditation.ts` wrap site now passes `'permanent'` because
  `reputation.ts:119-123` (`isPermanentSeedError`) only rethrows
  TypeError/SyntaxError/RangeError; transient blips stay swallowed inside
  the cascade fn. ErrorCode union extended in `src/types/api.ts`. Test:
  `tests/routes/accreditation-idempotency.test.ts` "seedAccreditationBonus
  throws → 502 POST_BROADCAST_OPERATOR_REQUIRED ..." pins code +
  failed_step + permanent user-message regex.
- **F8** — New module-local helper `deleteTokenBestEffort` in
  `routes/accreditation.ts` wraps the success-path `deleteToken(token)` and
  the idempotency-hit-path cleanups in try/catch + structured warn.
  Caller passes `event` discriminator (e.g.
  `accreditation.verify.delete_token_failed_post_success`,
  `accreditation.verify.idempotency_hit_token_cleanup_failed`). Closes the
  `helper-extraction-express5-response-ordering-2026-04-28.md` recurrence
  for this route. Test: `tests/routes/accreditation-idempotency.test.ts`
  "token cleanup failure on hit" stubs `redis.del` to throw on the
  hit-path delete and asserts 200 unaffected + warn emitted.

### Broadcast-path infra (Mid)

- **F4** — `backend/src/db.ts` Pool constructor uses the `onConnect` option
  (typed at `pg.Pool` constructor) instead of `pool.on('connect', ...)`.
  The first query on a new connection now waits for
  `SET statement_timeout = 30000`; pre-fix listener fired asynchronously
  and the first query could run before the timeout applied. No unit test
  added — the race is structural and asserting on event ordering against
  pg internals would couple the test to library internals.
- **F5/F12** — `lib/idempotency.ts` exports new
  `lookupCustodyBroadcastIdempotency` + `lookupAccreditationBroadcastIdempotency`
  wrappers that consult a Redis short-circuit cache before the bare HAF
  lookup. Cache stores discriminated `{kind:'hit',tx_id,block_num} |
  {kind:'miss'}` variants only; HAF throws and `haf_unconfigured` paths
  degrade to existing structured-warn handlers and are NEVER cached
  (per `caching-wrapper-discriminated-union-poisoning-2026-05-11.md`).
  Cache keys: `${config.appTag}:idem:custody:<sha256(username|key)>` and
  `${config.appTag}:idem:accred:<key>` (the accreditation key is already
  sha256 hex). TTLs: positive 60s (bridges HAF indexer-lag defense
  window), negative 10s (short, avoids masking genuine state changes).
  Rationale documented inline in the cache layer. Tests: cache is
  transparently exercised by the route-level specs; per-test cleanup of
  `${config.appTag}:idem:accred:*` keys in the accreditation suite's
  `afterEach` prevents cross-test pollution.
- **F10** — `isHafAvailable()` → `isHafConfigured()` in `src/db.ts` plus
  every caller across `src/` (12 sites) and `tests/` (~16 sites). Log
  events `*.idempotency_haf_unavailable` → `*.idempotency_haf_unconfigured`
  at custody + accreditation call sites. Docstring at the function says
  config-only, not reachability; outage discrimination lives on the
  error path (`_lookup_failed` warns). Wire field `haf_available` in
  `/api/health` deliberately left as-is — it's a documented contract
  field (`agents/docs/api-contracts/misc.md`), and the rename was
  function-semantics not contract-semantics. [TODO Architect: decide
  whether `haf_available` should also be renamed at contract level for
  consistency, or remain because the wire field is an effective-state
  observation rather than a config-only check.]

### Type safety + lookup polish (Mid)

- **F11** — `validateIdempotencyKey` returns
  `{ok:true,value:string} | {ok:false,error:string}` (was `string | null`).
  `routes/custody.ts` narrows via `if (!validation.ok)` and assigns
  `validation.value` without `as string`. Tests rewritten in
  `tests/lib/idempotency.test.ts` to assert on the discriminated shape.
- **F13** — `routes/custody.ts` hit-branch response uses
  `block_num: existing.block_num ?? undefined`. Test
  `tests/routes/custody-idempotency.test.ts` "HAF hit with block_num:null
  coerces to undefined" asserts `not.toHaveProperty('block_num')` on the
  serialized response.
- **F15** — Folded into F2 (the opType plumbing IS the F15 implementation —
  scoped probe halves HAF round-trips when the embed picks a known
  surface).

### Module cleanup (Low)

- **F22** — `logIdempotencySkip` deleted from `lib/idempotency.ts`. Four
  call sites in `routes/custody.ts` + `routes/accreditation.ts` inlined
  with direct `logger.warn({...}, '...')`. Hit-event sites (which already
  used `logger.info` directly) now share the same shape as the
  skip-event sites — no asymmetric rule.
- **F23** — `findAccreditByIdempotencyKey` →
  `findAccreditationBroadcastByIdempotencyKey` in
  `lib/idempotency.ts`. Three call sites (route, unit test, sibling
  function comment). Establishes the naming precedent for the survey
  table's per-surface follow-up lookups (`backend-claims-approve-revoke-idempotency`,
  `backend-papers-retract-idempotency`, optional `backend-wot-vouch-idempotency`,
  optional `backend-anonymous-review-attestation-idempotency`).
- **F24** — One-line comment added at
  `routes/accreditation.ts` customJsonPayload construction documenting
  why `embedIdempotencyKey` is not used (single known-shape op; inline
  is clearer than round-tripping through the generic scanner).
- **F26** — `embedIdempotencyKey` hoists `const params = opParams as
  Record<string, unknown>` once after the null-guard; per-branch casts
  at the comment and custom_json arms removed.

### Test coverage (Low)

- **F6 part 1** — `tests/lib/idempotency.test.ts` header rewritten. Now
  acknowledges the route-level companions ALSO mock `db.js` (per their
  own carve-out headers) and explicitly cites
  `backend-idempotency-haf-integration-test.md` as the real-path
  commitment per carve-out clause (c).
- **F9 + F19 + F20** — `tests/routes/accreditation-idempotency.test.ts`
  gains four new specs: (a) HAF lookup throw → broadcast still fires +
  `idempotency_lookup_failed` warn; (b) HAF unconfigured → broadcast
  still fires + `idempotency_haf_unconfigured` warn (uses a hoisted
  mutable `hafConfiguredFlag.value` to flip configuration presence
  per-test without re-mocking the module); (c) token cleanup failure
  on hit → 200 unaffected + `idempotency_hit_token_cleanup_failed` warn
  (one-shot stub on `redis.del`); (d) hit-path event pin extends the
  existing HAF-hit spec to assert `logger.info` called with the
  `accreditation.verify.idempotency_hit` event + structured fields.
- **F12 part 2** — TTL rationale documented inline in the cache layer
  (`IDEMPOTENCY_CACHE_POSITIVE_TTL_MS = 60_000`,
  `IDEMPOTENCY_CACHE_NEGATIVE_TTL_MS = 10_000`).
- **F21** — `tests/routes/custody-idempotency.test.ts` vote-only
  no-embed spec extended with `toMatchObject` pin on the full warn
  payload shape (event + route + username + idempotency_key +
  op_types).

### Dismissed at triage (architect's call; not implemented per hold-block instructions)

F14, F25, F27, F18 — recorded for transparency only; no code change.

### Filed as separate tasks (architect at re-review pass)

Both already filed in `tasks/pending/` per the hold block:
- `backend-idempotency-haf-integration-test.md` (F6 part 2)
- `backend-accreditation-existing-accreditation-gate.md` (F7)

### Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — only pre-existing `@typescript-eslint/no-explicit-any`
  warnings in `src/seed-phrase.ts` (unrelated to this task).
- `npx vitest run tests/lib/idempotency.test.ts
  tests/routes/custody-idempotency.test.ts
  tests/routes/accreditation-idempotency.test.ts` — 37/37 pass.
- `npx vitest run` (full backend suite, with `REDIS_URL` +
  `APP_DATABASE_URL` pointing to the Docker container IPs per
  CLAUDE.md "Running Tests") — 91/93 test files pass. Two failures
  reproduce on clean `main` HEAD (verified by stashing the round-2
  changes and re-running):
  1. `tests/routes/disciplines-canon-mocked.test.ts` "continuation-chain
     head-override lowercases head metadata" — unrelated to idempotency
     (papers.ts discipline pipeline); pre-existing flake.
  2. `tests/routes/stats-profile-parity.test.ts` —
     `ECONNRESET`/`ETIMEDOUT` against the external HAF SQL host
     `65.108.207.187:5432`; transient network flake (re-running in
     isolation passed).

### [TODO Architect] note (new — added by this round)

The F3 supplementary contract item ("Add new permanent-error code from
F3 when that hold item lands") is ready: `POST_BROADCAST_OPERATOR_REQUIRED`
is in `src/types/api.ts` and emitted by `lib/broadcast-error.ts`. At
archive, document the new code in `agents/docs/api-contracts/common.md`
broadcast-error code table alongside `POST_BROADCAST_FAILED` with the
discrimination semantics ("support has been notified" vs "will
reconcile automatically"; same `details.outcome:'confirmed'` shape, but
distinct user-recovery copy and operator routing).

---

## Architect re-review (2026-05-11) — HELD PENDING FIXES (round 3)

`/ce-code-review` of round-2 cluster (base `3489f43`, 21 commits, 72
files) fanned out 12 personas. Aggregated findings ranked, triaged with
user. Architect-zone TODOs (contract docs in `common.md`,
`custody.md`, `accreditation.md`, `misc.md`) landed in commit `5bcd95c`.
The 7 items below are implementer-side and gate archive. Two items
have related new-task spawns (see "Spawned tasks" below) for
out-of-scope but related work surfaced during this review.

**Items** (apply in any order; commit on a per-item or per-cluster basis
as you prefer):

1. **Cache key in `buildCustodyCacheKey` must include `op_type`.**
   `backend/src/lib/idempotency.ts:337`. F2 added op-type scoping to
   the HAF SQL probe (`findCustodyBroadcastByIdempotencyKey` accepts
   `opType?: 'comment' | 'custom_json'` and probes only the matching
   arm). But F5's cache key hashes only `(username, idempotency_key)`,
   so once any HAF probe lands a positive cache entry for one op-type,
   the next request with the same `(username, key)` but a different
   op-type returns the cached hit without consulting F2's scoping.
   Concrete sequence: user submits comment with `idempotency_key=K`
   (cache writes hit for cj's tx_id); within the 60s positive TTL the
   user submits custom_json with the same key → cache returns the
   comment's tx_id and the custom_json broadcast is suppressed (the
   SPA receives `outcome: 'already_landed'` with the WRONG op-type's
   tx_id). Fix: hash `(username, key, op_type)` in
   `buildCustodyCacheKey`, OR skip the cache entirely when `op_type`
   is unknown at the call site. Add a unit test pinning
   "comment-then-custom_json with same key → second request does NOT
   return `outcome: 'already_landed'` with the comment's tx_id."
   Today this is dead code in production (SPA does not yet send
   `idempotency_key` to custody), but the bug bites the moment the UI
   side adopts the key. Adversarial reviewer A1, conf 75.

2. **`readCached` JSON.parse cast in `lib/idempotency.ts:362` is
   unchecked.** A stale Redis entry from a future format mutation
   (e.g., adding a field, renaming `tx_id`, changing the discriminant
   key) that persists past a process restart can slip through the
   `cached.kind === 'hit'` discriminant check at the caller and let
   the route return `{ tx_id: undefined, block_num: ... }` typed as
   `IdempotencyHit`. Today there are no stale entries (cache format
   is new), but the gap is real for any future migration. Fix: after
   `JSON.parse(raw)`, runtime-validate the discriminated union:
   `typeof parsed?.kind === 'string'` and
   `parsed.kind === 'hit' || parsed.kind === 'miss'`. On `'hit'` also
   assert `typeof parsed.tx_id === 'string' && parsed.tx_id.length > 0`
   and `(typeof parsed.block_num === 'number' || parsed.block_num === null)`.
   On validation failure: log
   `event: 'idempotency.cache.corrupt_entry'` with the key + parsed
   shape, return `undefined` (degrade to cache miss, preserving the
   fail-open policy). The discipline anchor is
   `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md`,
   which the cluster's F5 cite-block already references — apply the
   same convention at the readCached boundary. Kieran-typescript KT-2,
   conf 75.

3. **User-facing message string `defaultPostBroadcastOperatorRequiredMsg`
   in `lib/broadcast-error.ts:251` is a false promise.** The string
   "support has been notified" is wire-visible to SPA error pages, but
   no PagerDuty/Slack/email integration exists in the codebase to back
   the claim. Only `logger.error({event:'post_broadcast_write_failed',
   severity:'permanent', ...})` fires; operators learn only by greping
   logs. The single-instance beta has no alerting backend wired today.
   Fix in this round: change the user-facing message to remove the
   false promise. Suggested replacements:
   `"please contact support"` (honest about today's state) or
   `"this has been logged for operator review"` (accurate about the
   current mechanism). Pick one; the actual alerting-wiring decision
   is filed as a separate `[BLOCKED by User]` task
   (`backend-post-broadcast-operator-alerting.md`) and is NOT in this
   round's scope. Reliability R1 + adversarial A4 cross-reviewer,
   conf 100.

4. **Add unit tests for the `severity: 'permanent'` branch of
   `handleBroadcastError`.** `backend/tests/lib/broadcast-error.test.ts`
   has zero occurrences of `'permanent'`,
   `'POST_BROADCAST_OPERATOR_REQUIRED'`, or the permanent fallback
   message. The branch is only exercised end-to-end via
   `accreditation-idempotency.test.ts`. A mutation swapping
   `=== 'permanent'` to `=== 'transient'` at lines ~391 and ~424 (or
   either code string) is invisible at the unit layer. Add 2 specs
   following the existing fixture pattern: (a) construct
   `new PostBroadcastWriteError(txId, cause, 'reputation_seed',
   'permanent')`, call `handleBroadcastError`, assert code is
   `POST_BROADCAST_OPERATOR_REQUIRED` and message contains the new
   permanent copy from item 3; (b) default severity, assert
   `POST_BROADCAST_FAILED` and message contains "reconcile". Pairs
   with item 3 — land in the same round so the test pins the
   post-item-3 message text. Correctness C3 + testing T1 +
   kieran-typescript KT-3 three-way cross-reviewer, conf 100.

5. **Negative cache TTL in `lib/idempotency.ts:335`
   (`IDEMPOTENCY_CACHE_NEGATIVE_TTL_MS = 10000`) can serve stale
   misses inside the HAF indexer lag window.** Sequence: pre-broadcast
   probe at t=0 caches `{kind:'miss'}` for 10s; backend broadcasts and
   chain confirms in ~3s; SPA receives 504 at t=5 (timeout, network
   blip); SPA retries at t=5; F5 cache returns the stale negative
   entry, HAF probe is skipped, backend re-broadcasts. For comment
   ops, chain rejects the duplicate `(author, permlink)`. For
   custom_json ops (consent ops on custody, etc.) — NO chain-level
   dedup — the op is duplicated on chain. Pick one of three
   alternatives with rationale in your signal block: (a) drop
   negative caching entirely (every probe-miss reaches HAF; bounded
   cost at PEvO single-instance scale), (b) shorten negative TTL to
   ~2-3s (below typical HAF lag minimum so any landed op has time to
   become indexable; preserves retry-storm absorption), (c) skip the
   negative cache on the pre-broadcast probe path and only cache
   POST-broadcast outcomes (most structurally correct: cache state
   reflects reality after the broadcast resolves; a negative result
   is only safe to cache after the subsequent broadcast attempt has
   completed). Adversarial A2 + reliability R3 cross-reviewer,
   conf 100 (promoted from 50/75).

6. **Add observability for the F1 hit-branch decrement degraded path.**
   `backend/src/routes/accreditation.ts:556`. The HAF-hit branch wraps
   `decrementBroadcastAttempts` in a try/catch that fires
   `idempotency_hit_decrement_failed` on throw. But inside
   `decrementBroadcastAttempts` (defined at accreditation.ts:154-175),
   the `isRedisAvailable() === false` path emits its own internal warn,
   calls `enqueueDecrement`, and returns void (does NOT throw). So the
   hit-branch outer warn never fires for the degraded path. Operators
   monitoring `idempotency_hit_decrement_failed` rate miss this case;
   sustained Redis degradation can inflate cap counters without a
   hit-branch-specific signal. Fix: either return a status
   discriminator from `decrementBroadcastAttempts`
   (`'decremented' | 'enqueued_for_drain' | 'failed'`) that the
   hit-branch caller switches on to emit
   `event: 'accreditation.verify.idempotency_hit_decrement_degraded'`
   alongside the enqueue, OR have the hit-branch pre-check
   `isRedisAvailable()` and emit the distinct event before invoking.
   The return-status discriminator is cleaner — preserves the helper's
   existing internal warn AND gives callers per-site context for
   their own structured logs. Reliability R2, conf 75.

7. **Verify cap-counter check ordering vs idempotency probe in
   `/verify`; restructure if cap-check runs first.** Adversarial A3
   constructed a mixed-envelope scenario: under cap exhaustion AND
   idempotency hits combined, concurrent retries for the same logical
   accreditation can receive 502 `BROADCAST_ATTEMPT_LIMIT_EXCEEDED`
   AND 200 `outcome: 'already_landed'` for the same logical op
   depending on timing. The fix depends on what verification shows:
   - If cap-counter check runs BEFORE idempotency probe: restructure
     to (a) idempotency probe (no state change), (b) if hit → 200
     (no cap consumed), (c) if miss → increment cap, broadcast. This
     mirrors the F2 fresh-auth hoist ordering principle ("checks that
     depend on state changing should run AFTER checks that establish
     whether the operation is needed at all").
   - If idempotency probe already runs first: document why the mixed-
     envelope concern is bounded to the narrow t=2 window (broadcast
     in flight, HAF doesn't have it yet) in your signal block, and
     pin the ordering with a test asserting "idempotency hit returns
     200 even when broadcast-attempts counter is at cap." This is the
     minimum verification step regardless of which branch the code is
     in today. Adversarial A3, conf 60 (low because reviewer didn't
     verify ordering; first action is verify).

### Spawned tasks (related but separate from this hold-block)

The following NEW task files are filed for work surfaced during this
review but not in this cluster's scope:

- `agents/docs/tasks/blocked/backend-post-broadcast-operator-alerting.md`
  — wire actual outbound alerting (PagerDuty/Slack/email/etc.) on
  `event:'post_broadcast_write_failed' severity:'permanent'` with
  dedup. **BLOCKED by User-input on alerting backend.** Separated from
  this cluster because the decision is strategic and beta-stage-
  specific. Once item 3 here lands (user message no longer claims
  alerting), this task can take whatever timeline the user prefers.
  Surfaced by reliability R1 + adversarial A4.
- `agents/docs/tasks/pending/backend-tests-typecheck-coverage.md` —
  sweep to extend tsc coverage over `backend/tests/` and patch ~11
  test cases in `broadcast-error.test.ts` that bypass the
  `LogContext` interface's excess-property protection. Surfaced by
  kieran-typescript KT-1 + maintainability M3.
- `agents/docs/tasks/pending/backend-mask-email-helper-extract-and-fix.md`
  — extract `maskEmail` to a shared helper and fix the dead conditional
  at `routes/accreditation.ts:288` (both ternary branches produce the
  same template). Surfaced by maintainability M1 + M2.
- `agents/docs/tasks/pending/backend-orcid-post-broadcast-severity-classification.md`
  — walk every `PostBroadcastWriteError` throw site in
  `backend/src/routes/orcid.ts`, classify severity at the call site
  (permanent for TypeError/SyntaxError/RangeError/23xxx-DB-codes/42xxx-
  DB-codes; transient otherwise). Surfaced by correctness C1
  (pre-existing). Pairs conceptually with item 3 + item 4 above but
  is out-of-cluster-scope per the round-2 back-compat preserve.
- `agents/docs/tasks/pending/ui-search-dosearch-inflight-guard.md` —
  guard `frontend/src/pages/search.js` `doSearch` against stacked
  in-flight requests from `goToPage` and `popstate`. Surfaced by
  julik-frontend-races JFR-001.
- `agents/docs/tasks/pending/ui-mount-editors-destroyed-guard.md` —
  add `if (!this._mounted) return;` after the dynamic
  `await import('../editor.js')` in `_mountEditors` on both
  `frontend/src/pages/publish.js` and `frontend/src/pages/edit.js`.
  Surfaced by julik-frontend-races JFR-002.

### Dismissed findings (recorded for traceability)

- **Adversarial A5: Hit-path token cleanup before seed-error 502 leaves
  user without recovery path.** Dismissed with rationale: the HAF hit
  confirms the accreditation IS on chain (chain-is-canonical model);
  the 502 `POST_BROADCAST_OPERATOR_REQUIRED` carries
  `details.outcome: 'confirmed'` + `details.tx_id`, which the SPA can
  surface to the user as "accredited; auxiliary step failed, support
  notified." Token cleanup ordering after HAF hit is correct for the
  chain-is-canonical model; the bonus row reconciles via the next
  reputation-batch cycle (or operator manually). Re-clicking the
  verification link would not help anyway since the chain state is
  already set. File a separate SPA-side task IF testing surfaces
  actual user confusion with the 502-but-confirmed shape.

---

## Backend re-review signal (2026-05-11, commit `aa303c9`)

All 7 round-3 hold items landed in a single commit (`aa303c9`, 7 files /
+559/-217). Item 5 chose alternative (a) — drop negative caching
entirely. Grouped per-item below; `event:` discriminators + new test
coverage are operator-alert anchors and pinned at the unit/integration
layers.

### Item 1 — buildCustodyCacheKey op_type binding

- `backend/src/lib/idempotency.ts` `buildCustodyCacheKey(username, key,
  opType)` now hashes `sha256(${username}|${idempotencyKey}|${opType})`.
  Closes the cache-layer shadowing class that F2 had already closed at
  the HAF SQL layer.
- `lookupCustodyBroadcastIdempotency` skips the cache entirely when
  `opType` is undefined (pure-vote bundles have no embed surface, so no
  op-type to bind). Pure-vote retries hit HAF live — at PEvO scale that
  cost is acceptable vs. introducing a cross-op-type-shadowable row.
- Test: new describe block "lookupCustodyBroadcastIdempotency — cache
  key includes op_type" in `tests/lib/idempotency.test.ts`. Sequence:
  request 1 with `opType='comment'` writes the cache; request 2 with
  same `(username, key)` but `opType='custom_json'` does NOT receive
  the comment's tx_id from the cache (asserted via
  `expect(hit2).not.toEqual({tx_id: commentTxId, ...})` AND the HAF
  probe ran). Uses real Redis; afterEach clears the namespace.

### Item 2 — readCached discriminated-union validation

- `backend/src/lib/idempotency.ts` adds `isValidCachedResult` type
  guard. `readCached` invokes it after `JSON.parse`; on validation
  failure logs `event:'idempotency.cache.corrupt_entry'` with the key
  + parsed shape and returns undefined (degrade to cache miss; fail-
  open per the convention anchor).
- Test: new describe block "readCached — discriminated-union shape
  validation" in `tests/lib/idempotency.test.ts`. Pre-seeds a corrupt
  entry (`kind:'hit'` missing `tx_id`) into Redis at the production
  cache-key shape; asserts the warn fired AND the live HAF probe ran
  (fail-open evidence).

### Item 3 — defaultPostBroadcastOperatorRequiredMsg honest copy

- `backend/src/lib/broadcast-error.ts:~304` now returns "...please
  contact support." in place of the prior "...support has been
  notified." Pinned at the unit layer (item 4 below) and at the
  integration layer (existing
  `tests/routes/accreditation-idempotency.test.ts` permanent-
  discrimination spec was updated to assert `/contact support/i`).
- Docblock at `PostBroadcastSeverity` updated to describe the new
  copy. The `tests/routes/orcid.test.ts` stale-comment reference
  also updated for consistency (no test assertion change there).

### Item 4 — handleBroadcastError severity branch coverage

- `tests/lib/broadcast-error.test.ts` gains 2 unit specs alongside the
  existing case B/C/D PostBroadcastWriteError discrimination block:
  - (a) severity:'permanent' → 502 POST_BROADCAST_OPERATOR_REQUIRED
    with message containing "contact support" and details matching
    `{outcome:'confirmed', tx_id, failed_step:'reputation_seed'}`;
    asserts sanitized message (does not leak `failed_step`).
  - (b) default severity → 502 POST_BROADCAST_FAILED with message
    matching `/restore the backend record/i` and details
    `{outcome:'confirmed', tx_id, failed_step:'cache_write'}`.

### Item 5 — Negative cache TTL — chose alternative (a) DROP

- `IDEMPOTENCY_CACHE_NEGATIVE_TTL_MS` constant deleted.
  `writeCached(key, value)` no-ops when `value.kind !== 'hit'`.
  `lookupCustodyBroadcastIdempotency` and
  `lookupAccreditationBroadcastIdempotency` no longer write on miss;
  stale `kind:'miss'` reads from pre-change Redis entries are
  treated as cache miss (degraded to live HAF probe).
- Rationale documented inline at the cache layer (replacing the
  prior negative-TTL rationale block): positive-cache hit case is
  load-bearing retry-storm absorption; negative caching's bounded
  benefit doesn't justify the stale-miss bug at single-instance
  scale. The convention anchor's "never cache transient failures"
  framing is the cited discipline source.

### Item 6 — Decrement degraded-path observability

- `decrementBroadcastAttempts(token, attemptId?)` signature changed
  from `Promise<void>` to
  `Promise<'decremented'|'enqueued_for_drain'|'failed'>`. New
  exported type `DecrementBroadcastAttemptsResult`. Helper-internal
  warn (`broadcast_decrement_redis_unavailable`) preserved
  unchanged; the return discriminator gives callers per-site context
  for their own structured logs.
- Hit-branch caller switches on the result: on
  `'enqueued_for_drain'` emits
  `event:'accreditation.verify.idempotency_hit_decrement_degraded'`
  with `username`, `email_hash`, `token_hash`. The throw path's
  existing `_hit_decrement_failed` warn remains untouched (the
  throw branch is the DECR-throws-mid-request class; the new
  event covers the silent-degraded class).
- Other caller (timeout-branch decrement at the broadcast catch)
  ignores the return value non-destructively. Test seams in
  `tests/routes/accreditation.test.ts` likewise ignore the
  return; surface change is backward-compatible.

### Item 7 — Cap-counter vs idempotency probe ordering

- `backend/src/routes/accreditation.ts`: idempotency probe block
  hoisted to run BEFORE the cap `incrementBroadcastAttempts` call
  (was the reverse). The probe is a no-state-change HAF read; the
  cap exists to bound chain ops; a hit consumes zero chain ops, so
  the probe-first ordering is structurally correct. The F1 hit-
  branch decrement logic became dead with the reorder (no INCR ran
  yet) and was deleted from the hit branch.
- Test: new spec "idempotency hit returns 200 even when broadcast-
  attempts counter is at cap (round-3 hold #7 ordering)" in
  `tests/routes/accreditation-idempotency.test.ts`. Pre-seeds the
  counter at `cap`, mocks the HAF probe to hit, asserts the
  response is 200 outcome:'already_landed' (not 502
  BROADCAST_ATTEMPT_LIMIT_EXCEEDED) and broadcastJson was NOT
  called. Counter assertion was relaxed to `res.body.error
  === undefined` because the hit-branch token cleanup cascades
  into `deleteBroadcastAttempts` and drops the pre-seeded counter
  key as a side effect — the absent error envelope is the load-
  bearing signal.
- The pre-fix mixed-envelope class adversarial A3 surfaced is
  closed: under cap exhaustion AND a confirmed-on-chain
  accreditation, all concurrent retries now receive the same 200
  shape.

### Verification

- `npx tsc --noEmit` — clean (touched src files).
- `npx tsc --noEmit -p tests/tsconfig.json` — touched test files
  clean. Pre-existing 222 errors in unrelated files persist; out
  of scope per task body ("IGNORE those").
- `npm run lint` — only the pre-existing
  `@typescript-eslint/no-explicit-any` warnings in
  `src/seed-phrase.ts` (unrelated).
- `npx vitest run tests/lib/broadcast-error.test.ts
  tests/lib/idempotency.test.ts
  tests/routes/accreditation-idempotency.test.ts
  tests/routes/custody-idempotency.test.ts` — all green
  (broadcast-error: 41 pass; idempotency: 27 pass; accreditation-
  idempotency: 8 pass; custody-idempotency: 7 pass).
- Broader regression: `tests/routes/accreditation.test.ts` —
  105/107 pass. The two failures
  (`POST /api/accreditation/request > rejects free email
  providers` and `rejects yahoo email`) reproduce on clean
  pre-change HEAD (verified via `git stash`); they are pre-
  existing and unrelated to this task (likely the
  free-email-domain check returns 500 instead of 422 in this
  environment).

### Items resolved per architect hold block

| Item | Status |
|---|---|
| 1 — buildCustodyCacheKey op_type folded in | closed (code + spec) |
| 2 — readCached union-shape validation | closed (code + spec) |
| 3 — defaultPostBroadcastOperatorRequiredMsg honest copy | closed (code + integration spec update) |
| 4 — handleBroadcastError severity:'permanent' unit specs | closed (2 new unit specs) |
| 5 — Negative cache TTL — chose (a) drop entirely | closed (code + rationale inline) |
| 6 — Hit-branch decrement degraded-path event | closed (discriminator + new event) |
| 7 — Cap-counter vs idempotency probe ordering | closed (restructure + spec) |
