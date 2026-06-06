# BACKEND-AUTHORSHIP-CREDIT-OPS-FRESH-AUTH — require per-op fresh-auth for claim/approve/revoke_authorship on custody broadcast

**Owner:** backend
**Created:** 2026-06-05 (from the `architect-reconcile-authorship-claim-vs-vouched-tracks` brainstorm; § 6.4 gap)
**Priority:** P2 (security-contract gap: reputation-weighty credit ops lack the re-auth the consent ops already require)

## Problem

`ARCHITECTURE.md` § 6.4 requires a per-target fresh-auth proof for `author_accept` / `author_resign` on `POST /api/custody/broadcast` (implemented at `custody.ts`). The equally reputation-weighty, identity-binding **name-only-route credit ops** — `claim_authorship`, `approve_authorship`, `revoke_authorship` — are broadcastable through the same custody endpoint but currently have **no fresh-auth requirement**, so a JWT-only path can mint or revoke authorship credit. This violates § 6.5 invariant #1 (a stolen JWT must not be a one-step takeover vector on a critical action). § 6.4 now carries a row marking this **pending** (added 2026-06-05).

## Goal

Add per-target fresh-auth gating for `claim_authorship` / `approve_authorship` / `revoke_authorship` on custody broadcast, mirroring the `author_accept` / `author_resign` contract. The target binds `op_type` + `paper_author` + `paper_permlink` + `author_index`. Self-custody (Keychain) signers bypass the custody endpoint and the fresh-auth requirement, as today (the requirement is a custody-endpoint guard, not a chain-layer rule).

## Acceptance

- A light-account broadcast of `claim_authorship` / `approve_authorship` / `revoke_authorship` via `POST /api/custody/broadcast` requires and atomically consumes a per-target fresh-auth proof (password or ORCID path) before broadcast; a stolen JWT alone cannot mint these ops (§ 6.5 invariant #1).
- The proof is target-bound: cross-paper, cross-action, or cross-`author_index` substitution is rejected (`target_mismatch` → 403 `FRESH_AUTH_REQUIRED`).
- `custody_audit_log` records these ops with the consent-op columns (`auth_mechanism`, `fresh_auth_outcome`, `session_id`, `user_agent`), same as `author_accept` / `author_resign`; the `user_agent` PII-anonymize-on-delete behavior applies.
- § 6.4's **Pending** marker on the name-only-route credit-ops row is removed once landed (coordinate with architect).
- `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 6.4 (the name-only-route credit-ops row), § 6.5 invariant #1, § 2 "Light-account signing of consent ops".
- `agents/docs/hive-schemas.md` § 2.9–2.11.
- `backend/src/routes/custody.ts` (`allowedActions`, fresh-auth target build, `findConsentOpsInBundle`), `backend/src/lib/fresh-auth.ts` (`CONSENT_OP_ACTIONS` / `FreshAuthTargetAction`), `backend/src/custody-audit.ts` (`logCustodyBroadcast`), `backend/src/routes/orcid.ts` (ORCID fresh-auth issuance).
- **Related:** `backend-implement-consented-authorship-model`, `architect-reconcile-authorship-claim-vs-vouched-tracks`.

## Implementation note (backend, 2026-06-06)

Landed the per-target fresh-auth gate for `claim_authorship` / `approve_authorship` / `revoke_authorship` on `POST /api/custody/broadcast`, mirroring the `author_accept` / `author_resign` contract.

- `backend/src/lib/fresh-auth.ts`: added `CREDIT_OP_ACTIONS` (kept disjoint from `CONSENT_OP_ACTIONS` — the lib-level wire-predicate test pins that the credit ops are NOT in `CONSENT_OP_ACTIONS`, because the two op families use different payload field names), widened `FreshAuthTargetAction` with the three credit actions, added an optional `author_index?: number` to `FreshAuthTarget` folded into `computeFreshAuthTargetHash` (length-prefixed; when absent the encoding is byte-identical to the prior triple form so existing consent-op / non-broadcast-critical proofs are unchanged), and added the `creditOpFreshAuthTarget(action, paperAuthor, paperPermlink, authorIndex)` builder shared by all three call sites.
- `backend/src/routes/custody.ts`: generalized the bundle scan from consent-only (`findConsentOpsInBundle`) to consent+credit (`findGatedOpsInBundle`), returning the full `FreshAuthTarget` so the consume side computes the bound hash. The credit actions were already in the broadcast `allowedActions` allowlist (they could be broadcast JWT-only before this change); the scan now routes them through the fresh-auth gate. The `/fresh-auth` password issuance path and its body-shape validator now accept the credit actions (claim/approve require a non-negative-integer `author_index`; revoke carries none).
- `backend/src/routes/orcid.ts`: widened the `mode='fresh_auth'` issuance path (and `StartBodySchema`) to accept the credit actions for state C (ORCID-only) / state B accounts.
- `custody_audit_log` columns are populated unchanged: `logCustodyBroadcast` already writes `auth_mechanism` / `fresh_auth_outcome` / `session_id` / `user_agent` on every gated broadcast success, so credit ops inherit the consent-op audit shape with no `custody-audit.ts` change. The `user_agent` PII-anonymize-on-delete behavior is unchanged.
- Tests: `backend/tests/routes/custody-credit-ops.test.ts` (route-level: issuance, broadcast happy path + audit columns, missing/replay/cross-account, and cross-paper / cross-action / cross-`author_index` `target_mismatch`) and additions to `backend/tests/lib/fresh-auth.test.ts` (`CREDIT_OP_ACTIONS` predicate, `author_index` hash binding incl. backward-compat, `creditOpFreshAuthTarget` consume round-trip). typecheck + lint clean.

## [TODO Architect]

1. Remove the **Pending** marker on the name-only-route credit-ops row in `agents/docs/ARCHITECTURE.md` § 6.4 (the gate is now implemented at `custody.ts`). Architect-owned doc; not edited here.

2. `agents/docs/ARCHITECTURE.md` § 6.4 states the credit-ops target binds `op_type + paper_author + paper_permlink + author_index` for ALL THREE ops, but `agents/docs/hive-schemas.md` § 2.11 shows the `revoke_authorship` wire payload carries NO `author_index` (its pinning fields are `claimer` + `paper_author` + `paper_permlink` + `reason`). The implementation resolves this by binding `revoke_authorship` to `(action, paper_author, paper_permlink)` only (no `author_index`) and binding claim/approve to all four. Please reconcile the doc text: either narrow § 6.4's "+ author_index" to claim/approve only and note revoke binds paper+action, OR (if revoke should bind `claimer`) update § 2.11 / the broadcast contract to carry+bind that field and file a follow-up — the current code does not fold `claimer` into the revoke target.
