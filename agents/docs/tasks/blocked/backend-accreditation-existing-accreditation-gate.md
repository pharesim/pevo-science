# BACKEND-ACCREDITATION-EXISTING-ACCREDITATION-GATE — Add HAF gate for prior accredit op on /verify

**Owner:** Backend Agent
**Created:** 2026-05-11 (architect, filed at re-review of `backend-broadcast-idempotency-cluster-followup` commit `c8153e3` — finding F7)
**Priority:** P2 (structural gap; bounded duplicate-op class)

## Why now

The `/api/accreditation/verify` route has no "is this user already accredited" gate before broadcasting. The only dedup is the new Option A.4 `idempotency_key` match (deterministic per token: `sha256(token:hive_username)`). This per-token dedup is correct for token-scoped retries but cannot prevent multi-token coexistence from producing duplicate accredit ops.

Reproducer:
1. User submits `POST /api/accreditation/request` at t=0 → token T1 issued, 24h TTL.
2. T1's email is delayed (greylist, spam filter).
3. User submits `/request` again at t=10min → token T2 issued (rate limiter allows 3/24h `byAccount`); both T1 and T2 are valid pending tokens.
4. Both emails arrive eventually. User clicks T2's link first → `/verify(T2)` computes `K2 = sha256(T2:hive_username)`, HAF miss (no prior K2 op), broadcasts accredit op signed by `accreditationAuthorities`, lands `tx=Tx2`, `deleteToken(T2)`.
5. User later clicks T1's link → `/verify(T1)` computes `K1 = sha256(T1:hive_username)` — **different from K2 because token is part of the hash**. HAF miss on K1 (chain only has K2). Broadcasts a **second accredit op**, lands `tx=Tx1`.

End state: two accredit ops on chain for the same user, both signed by admin authority, paying admin-key RC for the duplicate. The reputation cycle is unaffected (user is accredited; the duplicate doesn't change the score), but the on-chain row count grows + operator log noise + admin-key RC waste.

The class is bounded: at most 3 duplicate accredit ops per user per 24h (`/request` rate limiter cap). Not exploitable beyond auth boundaries (admin-key RC has high headroom). But the absence of an existing-accreditation gate is structurally surprising — every other state-mutating route in PEvO has an "is this already done" check before broadcasting.

Filed as a separate task from the parent because:
1. **Pre-existing structural gap** — would be a defect regardless of whether Option A.4 landed. Idempotency exposed it via the multi-token edge.
2. The fix is route-shape (HAF query) + new response value, deserving its own design pass.
3. The parent task is already carrying 19 hold items; bundling further bloats it.

## Goal

Add an existing-accreditation HAF gate to `/api/accreditation/verify` that fires **before** the broadcast step (and before the idempotency-key HAF lookup). On gate-hit, return 200 with a NEW `outcome: 'already_accredited'` value distinguishing it from `outcome: 'already_landed'` (which means same-key dedup).

## Acceptance

1. **New helper or extended lookup in `backend/src/lib/idempotency.ts`** (or co-located lib): `findExistingAccreditation(hiveUsername: string): Promise<{ tx_id: string; block_num: number | null } | null>`. Queries HAF for any prior `accredit` op scoped by:
   - `cj.custom_id = '${appTag}'`
   - `cj.required_posting_auths ?| $accreditationAuthorities::text[]`
   - The accredit payload's `account` field equals the input `hiveUsername` (extracted via the same JSONB operator pattern the rest of the module uses).
   - `cj.block_num >= getCachedGenesisBlock()`
   - `ORDER BY block_num DESC, trx_in_block DESC LIMIT 1` (per `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2).
2. **`routes/accreditation.ts /verify` integration:** the gate runs **before** the idempotency-key check (which itself runs before broadcast). Order: per-op validation → existing-accreditation gate → idempotency check → broadcast. On gate-hit: return 200 `{ message, username, tx_id, outcome: 'already_accredited' }`. Best-effort `deleteToken(token)` per the same wrap pattern as the idempotency-hit path.
3. **New `outcome` value documented:** `outcome: 'already_accredited'` is distinct from `outcome: 'already_landed'` (same-key dedup). The former means "this user has a prior accredit op from a DIFFERENT key (e.g., different token)"; the latter means "this exact key has been seen."
4. **Tests:** real-path or mocked (per carve-out) for: (a) gate-hit returns `'already_accredited'` with existing tx_id; (b) gate-miss flows to the idempotency-key check; (c) HAF-throw on the gate query degrades gracefully (broadcast proceeds with a warn).
5. **Architect at archive:** new `outcome` value documented in `agents/docs/api-contracts/accreditation.md` success-response shape extension. Add structured log event `accreditation.verify.existing_accreditation_hit`.

## Out of scope

- Generalizing to other routes (custody, claims, papers). Custody is intrinsically per-op so the analogous concept doesn't apply; claims/papers may have their own equivalent gates already.
- Refactoring the broader idempotency module structure.
- Changing the `idempotency_key` derivation. Keeping `sha256(token:hive_username)` because it's correct for the per-token retry case; this task adds the user-level gate ABOVE the token-level gate.

## Source

- `backend-broadcast-idempotency-cluster-followup.md` architect re-review 2026-05-11, finding F7.
- Adversarial reviewer "Multi-token coexistence breaks deterministic accreditation idempotency key" (anchor 90).

## Cross-references

- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2 (per-op ordering tiebreaker).
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` (apply if extending F5's Redis layer to cache this gate's result).
- `backend/src/routes/accreditation.ts` — `/verify` handler integration site.
- `agents/docs/hive-schemas.md` section 2.1 — accredit custom_json schema.

---

## [BLOCKED by Architect] (backend triage 2026-05-11)

Filed by the architect at the same re-review pass that produced the
parent task's hold block. This task depends on the parent
(`backend-broadcast-idempotency-cluster-followup`) archiving first
because:

1. F23 rename (`findAccreditByIdempotencyKey` →
   `findAccreditationBroadcastByIdempotencyKey`) is in the parent's
   round-2 commit `689208f` but not yet archived. The new gate helper
   (`findExistingAccreditation`) follows the same naming convention
   and sits alongside in `lib/idempotency.ts`.
2. F5 Redis cache layer is in `689208f` and this task's
   "Cross-references" line explicitly notes the gate's result MAY
   want a parallel cache wrap. The cache shape (TTLs, key prefix,
   negative-variant handling) is the architect's call at parent
   archive; implementing here before that lands risks divergent cache
   shapes between sibling lookups.
3. Architect's re-review of the parent (in `tasks/review/`) may
   surface additional API-shape changes (e.g. unified `lookup*`
   wrapper signature, alternative event names) that would propagate
   to this task's scope.

Move back to `tasks/pending/` once the parent task archives.
