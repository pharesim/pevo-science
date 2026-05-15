---
title: "Accreditation-state HAF reads must use latest-action-wins, not strict accredit equality"
date: 2026-05-15
category: conventions
module: backend/src/lib/idempotency.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Writing a new HAF read helper that asks whether an account is currently accredited"
  - "Adding a gating predicate on an accreditation-restricted route"
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

# Accreditation-state HAF reads must use latest-action-wins, not strict accredit equality

## Context

PEvO encodes the "is this account currently accredited?" predicate by example across five sibling HAF read sites but had no canonical doc until this entry. A new helper, `findExistingAccreditation` in `backend/src/lib/idempotency.ts`, was modeled on the name-similar sibling `findAccreditationBroadcastByIdempotencyKey` and inherited its strict `action = 'accredit'` filter. That sibling is a per-token idempotency dedup, not an accreditation-state read, so the filter is correct there. The name similarity ("find*Accreditation*") obscured the semantic divergence: dedup-by-key vs latest-action-wins state read. The mistake surfaced during architect code review as the headline P1 finding (correctness + adversarial reviewers corroborated at merged confidence 100).

Sibling read sites that already encode the correct pattern:

- `backend/src/routes/profile.ts:37` (profile-page accreditation status display)
- `backend/src/routes/orcid.ts:1756` (`getExistingAccreditation` in the ORCID flow)
- `backend/src/routes/accreditations.ts:59` (admin accreditations listing)
- `backend/src/hafsql.ts:79` (shared HAF accreditation helper)
- `backend/src/wot.ts:347` (WoT cleanup, the live PRODUCER of revoke ops)

## Guidance

Any HAF query that answers "is this account currently accredited?" must use latest-action-wins semantics over both action values:

1. The `WHERE` clause must match both action values: `cj.json::jsonb ->> 'action' IN ('accredit','revoke')`. Never filter to only `'accredit'` in a state-read query.
2. Order by block number descending, then HAF op id descending as the tiebreaker per `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2: `ORDER BY cj.block_num DESC, cj.id DESC`.
3. Fetch exactly one row: `LIMIT 1`.
4. The caller inspects the returned row's `action` field. `'accredit'` means currently accredited. `'revoke'` means not currently accredited. No row means never accredited.

Canonical SQL pattern (using the project's `T.customJson` view alias and the `hafsql.haf_operations` join required for `trx_id` recovery):

```sql
SELECT op.trx_id, cj.block_num, cj.json::jsonb ->> 'action' AS action
FROM ${T.customJson} cj
JOIN hafsql.haf_operations op ON op.id = cj.id
WHERE cj.custom_id = $1                                         -- ${config.appTag} binding
  AND cj.required_posting_auths ?| $2::text[]                   -- accreditationAuthorities (Rule 5)
  AND cj.json::jsonb ->> 'action' IN ('accredit','revoke')      -- both actions, not just accredit
  AND cj.json::jsonb ->> 'account' = $3                         -- target account
  AND cj.block_num >= $4                                         -- genesis floor
ORDER BY cj.block_num DESC, cj.id DESC                          -- latest wins (Rule 2)
LIMIT 1
```

Caller-side branching:

```typescript
const row = result.rows[0];
if (!row) return null;                                // never accredited
if (row.action === 'accredit') return { tx_id: row.trx_id, block_num: row.block_num };
// row.action === 'revoke' falls through — currently revoked, treat as not accredited
return null;
```

## Why This Matters

**Concrete user-visible failure.** A revoked user who retries `/api/accreditation/verify` hits a strict-equality gate that finds their old `accredit` op, receives `200 outcome='already_accredited'` with the stale `tx_id` from before revocation, and has their fresh `/request` token deleted by cleanup. They are silently locked out of re-accreditation. Every other read site (`profile.ts`, `orcid.ts`, `accreditations.ts`, `hafsql.ts`) correctly reports them as not accredited; only the broken gate diverges. The chain truth (revoked) is unchanged.

**Architectural reason.** The chain is always SSoT in PEvO (auto memory [claude]). Accreditation state is a derived value computed from the latest relevant on-chain operation for a given account. The `custom_json` schema admits both `accredit` and `revoke` action values by design. A query filtering to only `'accredit'` is not reading state, it is reading the existence of any past accredit operation, which is a weaker and unintended predicate.

**The bug is reachable, not theoretical.** `backend/src/wot.ts:347` is a live producer of revoke ops. The WoT cleanup path broadcasts a revoke when an account loses its vouch chain, so revoked-then-retrying accounts are a real production population.

## When to Apply

- Any new HAF helper whose question is "is account X currently accredited?", regardless of where in the call stack it sits.
- Gating predicates on accreditation-restricted routes (publish, review, edit, comment, vote).
- Membership checks for any feature that should be unavailable to revoked accounts.
- Any "dedup before broadcast" gate that semantically reads current accreditation state, even when it structurally resembles a per-token idempotency check.
- Any query that touches `custom_json` rows under `custom_id = ${config.appTag}` and inspects the `action` field of accreditation ops.

Do NOT apply this pattern to idempotency-key dedup helpers (e.g., `findAccreditationBroadcastByIdempotencyKey`) whose key is per-broadcast (`sha256(token:username)`). Those helpers are not reading accreditation state; they are checking whether a specific broadcast has already been sent. Strict equality on `action = 'accredit'` is correct there because the key space scopes the query to a single candidate operation.

## Examples

**WRONG — strict equality on `'accredit'` in a state-read context:**

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

A revoked account still has an older `accredit` op in the chain. This query finds it and incorrectly reports the account as accredited.

**RIGHT — latest-action-wins over both action values:**

```sql
SELECT op.trx_id, cj.block_num, cj.json::jsonb ->> 'action' AS action
FROM ${T.customJson} cj
JOIN hafsql.haf_operations op ON op.id = cj.id
WHERE cj.custom_id = $1
  AND cj.required_posting_auths ?| $2::text[]
  AND cj.json::jsonb ->> 'action' IN ('accredit','revoke')  -- include both
  AND cj.json::jsonb ->> 'account' = $3
  AND cj.block_num >= $4
ORDER BY cj.block_num DESC, cj.id DESC
LIMIT 1
```

```typescript
// Caller (backend/src/routes/accreditation.ts, /verify gate):
const row = await findExistingAccreditation(pool, hiveUsername);
if (row && row.action === 'accredit') {
  return sendOk(res, { message: 'Accreditation confirmed', username: hiveUsername,
                       tx_id: row.tx_id, outcome: 'already_accredited' });
}
// row is null OR row.action === 'revoke' — fall through to per-token check + broadcast
```

**ALSO RIGHT (for contrast) — per-token idempotency dedup, strict equality is correct here:**

```sql
-- findAccreditationBroadcastByIdempotencyKey
-- Key is sha256(token:username); the key space has no revoke concept.
-- Strict equality on action='accredit' is correct; do NOT "fix" this query.
SELECT op.trx_id, cj.block_num
FROM ${T.customJson} cj
JOIN hafsql.haf_operations op ON op.id = cj.id
WHERE cj.custom_id = $1
  AND cj.required_posting_auths ?| $2::text[]
  AND cj.json::jsonb ->> 'action' = 'accredit'
  AND cj.json::jsonb ->> 'idempotency_key' = $3
  AND cj.block_num >= $4
ORDER BY cj.block_num DESC, cj.id DESC
LIMIT 1
```

This is correct because the idempotency key is derived from a one-time token; the only question is whether this specific broadcast was already sent, not the account's current accreditation state.

## Related

- `hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` — sibling convention. Rule 2 covers the `(block_num, cj.id)` ordering tiebreaker for the `active_accreditations` CTE; this doc covers the predicate-shape rule (action-set inclusion). Together they form the complete latest-action-wins contract for HAF accreditation reads.
- `sql-semantic-shift-cross-surface-audit-2026-05-12.md` — when fixing the predicate at one accreditation read site, audit all sibling sites (`profile.ts`, `orcid.ts`, `accreditations.ts`, `hafsql.ts`, `wot.ts`) for semantic drift.
- `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — same-file sibling audit when several callers compose the same CTE.
- `pevo-inverted-predicate-collapse-encode-invariant-structurally-2026-05-05.md` — if the action-type predicate drifts again, consider collapsing the check into a dedicated `isCurrentlyAccredited()` helper that centralizes the `IN ('accredit','revoke') LIMIT 1` logic rather than re-asserting the predicate at every call site.
- `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — upstream motivation: authorization gates must terminate in chain-derived identity, not metadata claims. Latest-action-wins is the chain-derived computation; cached or metadata-only signals are not authoritative.
- `agents/docs/tasks/pending/backend-accreditation-existing-accreditation-gate.md` — the task where this finding originated; hold-block round 1 contains the canonical fix recipe for `findExistingAccreditation`.
