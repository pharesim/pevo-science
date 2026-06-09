# BACKEND-REPUTATION-WEIGHTS-SIGNER-GATE — `loadReputationWeights` accepts `update_weights` custom_json from ANY Hive account

**Owner:** backend
**Created:** 2026-06-06 (surfaced by architect review of the reputation cluster: correctness + adversarial lenses on the decayMultiplierSql commit independently flagged it; verified by direct read)
**Priority:** P0 (any Hive account can take control of the reputation algorithm parameters on the live beta)

## Problem

`loadReputationWeights` in `backend/src/reputation.ts` selects the latest weights payload with:

```sql
SELECT cj.json FROM <custom_json view> cj
WHERE cj.custom_id = $1                            -- config.appTag
  AND cj.json::jsonb ->> 'action' = 'update_weights'
ORDER BY cj.block_num DESC
LIMIT 1
```

There is NO filter on the signing account. Hive `custom_json` ops can be broadcast by any account, so any account that broadcasts `{"action":"update_weights","weights":{...}}` with `custom_id = <appTag>` controls every reputation weight from the next 30-minute cache refresh onward: paper/review/citation weights, downvote multiplier, decay grace/rate/floor, accreditation bonus. The payload is spread raw over the defaults (`{ ...DEFAULT_REPUTATION_WEIGHTS, ...payload.weights }`) with no value validation; only `cycle_blocks` is defended downstream (`reputation-batch.ts` clamps it).

Every sibling custom_json consumer already gates on the signer:

- `accreditation.ts` — `cj.required_posting_auths ?| $2::text[]`
- `wot.ts` — `required_posting_auths ?| $2::text[]`
- `consent-ops.ts` — `cj.required_posting_auths ->> 0 IN (...)`
- `notification-queries.ts` — multiple signer-gated arms

`loadReputationWeights` is the outlier. The write side (`hive.ts` broadcastCustomJson) signs with `required_posting_auths: [config.hiveAdminAccount]`, so legitimate ops already carry the right authority; the read side just never checks it.

## Goal

Only `config.hiveAdminAccount`-signed `update_weights` ops may set reputation weights, and accepted values must be sane.

### Suggested approach

1. **Signer gate:** add `AND cj.required_posting_auths ?| ARRAY[$2]` (or the `->> 0 =` form matching how the write side signs) to BOTH weights queries (the cheap existence probe and the latest-op read), parameterized on `config.hiveAdminAccount`. Mirror the `accreditation.ts` shape. `config.hiveAdminAccount` is singular by design; do not widen to an authorities array.
2. **Value validation/clamp:** validate `payload.weights` before spreading: every accepted field numeric and finite; clamp `decay_floor` to `[0, 1]`, `decay_rate >= 0`, `decay_grace_months >= 0`; non-numeric or unknown-shaped fields fall back to defaults. Keep the existing downstream `cycle_blocks` clamp.
3. **Docblock follow-through:** once `decay_floor <= 1.0` is enforced, the `decayMultiplierSql` docblock claim in `hafsql.ts` ("the grace arm returns 1.0 >= decay_floor") becomes unconditionally true; confirm the wording needs no change, or tighten it while in the area.

## Acceptance

- An `update_weights` op signed by a non-admin account is ignored (weights stay at defaults / at the last admin-signed value). Pinned by test.
- An admin-signed op still applies. Pinned by test (real-path per project conventions where feasible; the SQL-shape canary pattern used by the reputation suite is acceptable for the signer-gate predicate).
- Out-of-range values (e.g. `decay_floor: 1.5`, `decay_rate: -1`, `paper: "abc"`) are rejected or clamped; pinned by test.
- Existing weights-cache tests stay green; `npm run typecheck` + `npm run lint` clean.
- Comment anchors clean (no task slug, round number, line number, SHA).

## Cross-references

- `backend/src/reputation.ts` — `loadReputationWeights` (both queries), `WEIGHTS_TTL` cache.
- `backend/src/accreditation.ts` — the established `required_posting_auths ?|` gate shape to mirror.
- `backend/src/hive.ts` — write side signs with `required_posting_auths: [config.hiveAdminAccount]`.
- `backend/src/reputation-batch.ts` — existing `cycle_blocks` clamp (defense-in-depth precedent).
- `backend/src/hafsql.ts` — `decayMultiplierSql` docblock (item 3).

## Backend completion note (2026-06-08)

Closed the P0 takeover and added value sanitization.

- **Signer gate (both queries):** `loadReputationWeights` now appends `AND cj.required_posting_auths ? $2` to BOTH the cheap existence probe and the latest-op read, bound to `config.hiveAdminAccount` (singular, not widened to an authorities array). The `?` element-existence form mirrors the `retract_paper` / WoT singular-admin gate shape; `required_posting_auths` is jsonb in `operation_custom_json_view`, the same column the accreditation/WoT/consent readers gate on. A non-admin `update_weights` no longer returns from either query, so weights stay at defaults / the last admin-signed value.
- **Value sanitization:** extracted `sanitizeReputationWeights(raw)` (exported, pure). Each known weight is accepted only if a finite number (non-numeric / NaN / ±Infinity / missing / unknown-shaped fields drop, so the caller's spread over `DEFAULT_REPUTATION_WEIGHTS` restores the default). Domain clamps: `decay_floor` and `self_citation_discount` to `[0,1]`, `decay_rate` and `decay_grace_months` to `>= 0`. `cycle_blocks` stays unbounded here (clamped `> 0` downstream in `reputation-batch.ts`). The loader now spreads `sanitizeReputationWeights(payload?.weights)` (also null-safe vs the old raw `payload.weights`).
- **Item 3 docblock:** `decayMultiplierSql` in `hafsql.ts` now names the source of the `decay_floor <= 1.0` invariant ("which `sanitizeReputationWeights` clamps to [0, 1] at load time"), so the self-flooring claim is unconditionally true rather than resting on an unvalidated assumption.
- **`loadReputationWeights` is now exported** so the signer-gate canary can drive it directly (consistent with the file's existing exported helpers `queryWithStatementTimeout` / `scanAllKeys` / `batchKey`).
- **Tests:** new `tests/routes/reputation-weights-signer-gate.test.ts` — (1) a HAF-free SQL-shape canary (mocks `getPool`, carve-out clauses a/b/c documented in the header) asserting both queries carry `required_posting_auths ? $2` bound to the admin account, the latest read keeps `ORDER BY cj.block_num DESC`, and an admin payload applies + clamps (`decay_floor: 1.5 -> 1.0`); (2) pure-function unit tests pinning every clamp + the non-numeric/NaN/Infinity/unknown-field/non-object fallbacks. 9 tests green; `npm run typecheck` + `npm run lint` clean.

## On final archive (architect)

Invoke `/ce-compound` to capture the convention this defect instantiates: a HAF custom_json read gated only on `custom_id` + `action` is an authentication bypass, because any Hive account can broadcast any custom_id; every consumer must additionally gate on the signing authority (`required_posting_auths`), the way the accreditation, WoT, and consent-op readers already do. Deferred until the fix lands and this task archives clean, so the documented solution reflects the verified gate shape.

## Architect review (2026-06-09) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness + security + adversarial on Opus; testing, maintainability, project-standards, kieran-typescript, performance on Sonnet; learnings-researcher; ce-agent-native-reviewer skipped per PEvO) on commit 09329790. **The P0 is VERIFIED CLOSED** — correctness, security, AND adversarial each independently confirmed the bypass is shut: the `required_posting_auths ? $admin` gate on BOTH the existence probe and the latest-op read matches the sibling accreditation / WoT / consent gate shape; Hive consensus admits an op only if every named posting-auth actually signed, so a forged `required_posting_auths:[admin]` never reaches HAF; the write side signs with posting auth (matching the read gate's auth type); the existence-probe `LIKE '%update_weights%'` vs read `->>'action'` divergence fails closed to `DEFAULT_REPUTATION_WEIGHTS`, never to attacker-chosen weights; and `sanitizeReputationWeights` degrades safely on every adversarial input (array / string / NaN / ±Infinity / non-object → defaults). Two small items hold; nothing security-relevant.

### Items held (must fix before archive)

1. (P3, kieran-typescript) `sanitizeReputationWeights` array guard: `if (raw === null || typeof raw !== 'object')` admits arrays (`typeof [] === 'object'`), which reach the `as Record<string, unknown>` cast. It returns `{}` in practice (no array index matches a `DEFAULT_REPUTATION_WEIGHTS` key), so no behavior bug — but tighten the contract with `... || Array.isArray(raw)` and add a one-line unit asserting `sanitizeReputationWeights([{ paper: 99 }])` → `{}`.
2. (P3, maintainability) `decayMultiplierSql` docblock (`hafsql.ts`): the signer-gate edit split a sentence, leaving "…already floors via GREATEST. Sharing one helper" as a dangling clause. Reflow into one self-contained sentence (e.g. "the grace arm returns 1.0 (>= decay_floor, which `sanitizeReputationWeights` clamps to [0, 1] at load time), and the decay arm already floors via GREATEST."). Comment-only.

### Items dismissed at triage (no action)

- (P2, maintainability) Table-driven clamp map so a future domain-bounded weight is not silently left unclamped: preemptive. The current four explicit clamps are correct and the weight set is stable; the additive weights (paper / review / citation / downvote / …) are admin-trusted and bounded by the final `LEAST(100, GREATEST(0, …))` score clamp, so an unclamped finite value cannot escape [0, 100] or be reached by a non-admin. Revisit only when a new domain-bounded `[0,1]` / `>=0` weight is actually added.
- (P3, testing) Tests pinning negative/zero `cycle_blocks` pass-through and the `decay_floor == 1.0` exact boundary: `cycle_blocks` is intentionally unclamped here (clamped `> 0` downstream in `reputation-batch.ts`) and the clamp boundaries are mechanically trivial; preemptive per the project's dismiss-theoretical-hardening stance.
- (P3, testing) Carve-out clause (c) companion not named by a specific file: the wiring companion (the reputation lifecycle/batch suites exercising the gated query against real Postgres) exists; naming a specific file is nice-to-have, not required.

### Architect companion actions (deferred to clean archive — NOT implementer work)

- (P2, project-standards) `reputation-algorithm.md` `update_weights` section does not record the signer-gate invariant. Architect-owned doc; the architect will add it when this task re-reviews clean and archives.
- `/ce-compound` per the "On final archive" note above — the gate pattern is documented, but the specific "missing-from-day-one / applies to existing readers, not just new op types" framing is not yet a named entry, and there is a sibling cluster (`active-vouches-signer-gate`, `revoke-authorship-signer-gate`) of the same defect class. Architect runs it at clean archive.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next review scopes to the fix commit only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
