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
