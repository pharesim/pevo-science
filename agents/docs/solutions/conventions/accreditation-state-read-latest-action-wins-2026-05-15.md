---
title: "Accreditation HAF reads must not filter to accredit alone; membership comes from active_accreditations"
date: 2026-05-15
category: conventions
module: backend/src/lib/idempotency.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Writing a new HAF read helper that asks whether an account is currently accredited"
  - "Writing a gate that branches on an account's latest accredit or revoke op"
  - "Modeling a new accreditation helper on an existing sibling helper by name similarity"
  - "Auditing accreditation-related HAF queries for revoke awareness"
tags:
  - accreditation
  - haf-sql
  - hive-custom-json
  - state-reads
  - latest-action-wins
  - revoke
related_components:
  - database
  - tooling
---

# Accreditation HAF reads must not filter to accredit alone; membership comes from active_accreditations

## Context

`findExistingAccreditation` in `backend/src/lib/idempotency.ts`, the user-level gate on `POST /api/accreditation/verify`, was first modeled on the name-similar sibling `findAccreditationBroadcastByIdempotencyKey` and inherited its strict `action = 'accredit'` filter. That sibling is a per-token idempotency dedup, not a read of accreditation state, so the filter is correct there. In the gate it matched an account's older `accredit` op after a later `revoke`. The name similarity ("find*Accreditation*") hid the difference. The mistake surfaced in architect code review.

Two kinds of read look at an account's `accredit` and `revoke` ops:

- **Membership** ("is this account accredited now"): `activeAccreditationsCteBody` in `backend/src/hafsql.ts`, which `profile.ts`, `accreditations.ts` and `wot.ts` compose. Its latest `accredit` op supplies the method and metadata, a later un-lifted `type: "sanction"` revoke suppresses it, a revoke without `type` (a legacy revoke) is ignored, and a `method: "wot"` accredit counts only while the account meets the live vouch threshold. `ARCHITECTURE.md` § 2 states the membership rule.
- **Latest-op gates**: helpers that take the account's single latest authority `accredit` or `revoke` op and branch on it. `findExistingAccreditation` decides whether `/verify` broadcasts; `getExistingAccreditation` in `backend/src/routes/orcid.ts` supplies the prior op to the ORCID flow.

## Guidance

1. **"Is this account accredited now" is a membership question.** Compose `activeAccreditationsCteBody`; do not hand-roll a latest-op read for it. A latest-op read answers it wrongly for a legacy revoke after an accredit, and for a `wot` accredit below the threshold.
2. **A latest-op gate matches both action values** inside its candidate CTE: `cj.json::jsonb ->> 'action' IN ('accredit','revoke')`. Filtering to `'accredit'` alone lets the gate see an accredit that a later revoke superseded.
3. **Order by `block_num DESC, id DESC`, then `LIMIT 1`,** outside the `AS MATERIALIZED` candidate CTE. `id` is the same-block tie-breaker (`hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2), and the fence keeps an account with no matching op from walking the blocks index backward (`haf-custom-json-latest-op-materialized-fence-2026-06-14.md`). Add no `block_num >=` floor: `pevo/no-custom-id-block-num-floor` bans it on this view.
4. **The latest op's `action` does not by itself mean "accredited".** Branch on what the gate decides. `findExistingAccreditation` hits only when the latest op is an `accredit` whose `method` is not `wot`; a revoke, a `wot` accredit or no op is a miss.

Canonical SQL, as `findExistingAccreditation` runs it (`T.customJson` is the project's view alias; the `hafsql.haf_operations` join supplies `included_trx_id`, the transaction id):

```sql
WITH candidates AS MATERIALIZED (
  SELECT cj.id, cj.block_num, cj.json::jsonb ->> 'action' AS action,
    cj.json::jsonb ->> 'method' AS method,
    cj.json::jsonb ->> 'orcid' AS orcid
  FROM ${T.customJson} cj
  WHERE cj.custom_id = $1                                       -- config.appTag
    AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')   -- both actions, not just accredit
    AND cj.json::jsonb ->> 'account' = $2                       -- target account
    AND cj.required_posting_auths ?| $3::text[]                 -- accreditationAuthorities (Rule 5)
)
SELECT op.included_trx_id AS trx_id, c.block_num, c.action, c.method, c.orcid
FROM candidates c
JOIN hafsql.haf_operations op ON op.id = c.id
ORDER BY c.block_num DESC, c.id DESC                            -- latest wins (Rule 2)
LIMIT 1
```

The helper's branching, which returns the `ExistingAccreditationGate` union:

```typescript
if (result.rows.length === 0) return { kind: 'miss', wot_orcid: null };
const row = result.rows[0];
if (row.action !== 'accredit') return { kind: 'miss', wot_orcid: null };
if (row.method === 'wot') return { kind: 'miss', wot_orcid: row.orcid || null };
return { kind: 'hit', tx_id: row.trx_id, block_num: row.block_num };
```

## Why This Matters

**Concrete failure.** With the strict `action = 'accredit'` filter, an account whose latest op was a revoke still matched its older accredit. `/verify` answered 200 `already_accredited` with the pre-revoke `tx_id`, deleted the fresh token in cleanup, and broadcast nothing.

**Architectural reason.** The chain is the source of truth. A query that filters to `'accredit'` alone does not read state; it reads whether any accredit op ever existed, which is a weaker and unintended predicate.

**Revokes exist.** The admin sanction route (`/accreditation/sanction` in `backend/src/routes/admin.ts`) broadcasts `type: "sanction"` revokes, and older WoT code broadcast typeless revokes on threshold drops.

## When to Apply

- Any new HAF helper that asks whether account X is accredited now: compose `activeAccreditationsCteBody`.
- Any gate that branches on an account's latest accreditation op, including a "dedup before broadcast" gate that resembles a per-token idempotency check: match both actions, order by `(block_num, id)`, take one row.
- Any query under `custom_id = ${config.appTag}` that inspects the `action` field of accreditation ops.

Do NOT apply this pattern to idempotency-key dedup helpers (e.g., `findAccreditationBroadcastByIdempotencyKey`) whose key is per-broadcast (`sha256(token:username)`). They check whether one specific broadcast was already sent, not accreditation state, so strict equality on `action = 'accredit'` is correct there.

## Examples

**WRONG: strict equality on `'accredit'` in a gate that must see revokes:**

```sql
-- findExistingAccreditation (initial, broken implementation)
-- Matches any prior accredit op, even if a subsequent revoke op exists.
SELECT op.trx_id, cj.block_num
FROM ${T.customJson} cj
JOIN hafsql.haf_operations op ON op.id = cj.id
WHERE cj.custom_id = $1
  AND cj.required_posting_auths ?| $2::text[]
  AND cj.json::jsonb ->> 'action' = 'accredit'   -- BUG: ignores subsequent revokes
  AND cj.json::jsonb ->> 'account' = $3
  AND cj.block_num >= $4
ORDER BY cj.block_num DESC, cj.id DESC
LIMIT 1
```

A revoked account still has an older `accredit` op in the chain. This query finds it, and the gate treats the account as already accredited.

**RIGHT: the canonical SQL in Guidance,** with `action IN ('accredit', 'revoke')` inside the candidate CTE, and a caller that branches on the gate's union:

```typescript
// /verify gate (backend/src/routes/accreditation.ts)
const existingForUser = await findExistingAccreditation(hafPool, pending.hive_username);
if (existingForUser.kind === 'hit') {
  return sendOk(res, { message: 'Accreditation confirmed', username: pending.hive_username,
                       tx_id: existingForUser.tx_id, outcome: 'already_accredited' });
}
wotOrcid = existingForUser.wot_orcid;
// miss: the sanction guard, the per-token check, then a method:'email' broadcast
// that carries wotOrcid when it is set.
```

**ALSO RIGHT (for contrast): per-token idempotency dedup, where strict equality is correct:**

```sql
-- findAccreditationBroadcastByIdempotencyKey
-- Key is sha256(token:username); the key space has no revoke concept.
-- Strict equality on action='accredit' is correct; do NOT "fix" this query.
WITH candidates AS MATERIALIZED (
  SELECT cj.id, cj.block_num
  FROM ${T.customJson} cj
  WHERE cj.custom_id = $1
    AND cj.json::jsonb ->> 'action' = 'accredit'
    AND (cj.json::jsonb ->> 'idempotency_key') = $2
    AND cj.required_posting_auths ?| $3::text[]
)
SELECT op.included_trx_id AS trx_id, c.block_num
FROM candidates c
JOIN hafsql.haf_operations op ON op.id = c.id
ORDER BY c.block_num DESC, c.id DESC
LIMIT 1
```

The idempotency key derives from a one-time token, so the only question is whether this specific broadcast was already sent.

## Related

- `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`: sibling convention. Rule 2 covers the `(block_num, cj.id)` ordering tie-breaker; this doc covers the action-set predicate.
- `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`: the `AS MATERIALIZED` fence for latest-op reads on the custom_json view.
- `sql-semantic-shift-cross-surface-audit-2026-05-12.md`: when the predicate changes at one accreditation read site, audit the sibling sites for drift.
- `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`: same-file sibling audit when several callers compose the same CTE.
- `pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md`: if the action-set predicate drifts again, consider centralizing it in one helper rather than re-asserting it at every call site.
- `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`: upstream motivation; authorization gates terminate in chain-derived identity, not metadata claims.
