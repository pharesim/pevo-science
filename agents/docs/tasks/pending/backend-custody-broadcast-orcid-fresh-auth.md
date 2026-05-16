# BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — Accept ORCID fresh-auth proof on `/custody/broadcast` (non-consent path)

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6)
**Priority:** P2

## Problem

`POST /api/custody/broadcast` (`backend/src/routes/custody.ts`) for non-consent ops currently uses `password` as the re-auth factor. The consent-op path (lines ~273-354) already accepts a `fresh_auth_proof` discriminator that can carry either a password-mechanism or ORCID-mechanism proof; non-consent ops do not.

This blocks state C accounts (passwordless ORCID-only — see `agents/docs/ARCHITECTURE.md` § 6.1) from broadcasting any non-consent op via the server. State C users have ORCID as their only registered auth factor; they can produce an ORCID fresh-auth proof via `/api/orcid/callback mode='fresh_auth'`, but the non-consent broadcast path does not accept it.

Per `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract), non-consent broadcast's required re-auth is "fresh-auth proof matching a factor registered on the account." Per-state availability: A — password proof only; B — password OR ORCID proof; C — ORCID proof only.

## Goal

Extend the non-consent `/api/custody/broadcast` re-auth gate to accept `fresh_auth_proof` (same shape as the consent-op path) in addition to / instead of bare `password`. State C accounts become able to broadcast non-consent ops via ORCID fresh-auth proof.

## Approach

The consent-op path's primitives at `backend/src/lib/fresh-auth.ts` already verify both password-mechanism and ORCID-mechanism proofs. Reuse them on the non-consent branch.

Open design choice (architect's call at implementation time, document in the implementer signal block):

- **Option A: deprecate the bare `password` field on the non-consent path.** Require all callers to pass `fresh_auth_proof` issued via `/api/custody/fresh-auth` (password mechanism) or `/api/orcid/callback mode='fresh_auth'` (ORCID mechanism). Symmetric with the consent-op path; one re-auth shape for both branches; clean wire contract.
- **Option B: support both.** Backward-compatible: accept either `password` (legacy shape for state A/B users) OR `fresh_auth_proof` (new shape, required for state C). More code paths, but no UI migration pressure.

Option A is cleaner; Option B is the safer rollout if there are deployed UI clients pinning the bare `password` shape. The architect's brainstorm recommendation is Option A — wire contract uniformity is a strong invariant per the API-contract review lens.

## Acceptance

1. State A users can broadcast non-consent ops with a password-mechanism `fresh_auth_proof`.
2. State B users can broadcast with either password OR ORCID-mechanism `fresh_auth_proof`.
3. State C users can broadcast with an ORCID-mechanism `fresh_auth_proof` — previously blocked.
4. State D users continue to receive 403 / not applicable (encrypted keys wiped at upgrade; nothing to decrypt and broadcast with).
5. Per-target binding semantics for ORCID-mechanism proofs on non-consent ops: the proof should not require a per-op target (only consent ops need that — see `agents/docs/ARCHITECTURE.md` § 6.4 second row). A general session-level ORCID proof suffices.
6. Real-path integration tests cover the new ORCID branch for state C accounts, plus regression tests for A and B.
7. `agents/docs/api-contracts/custody.md` updated to document the wire-shape change (architect-zone — flag as `[TODO Architect]` at implementer-signal time).

## Out of scope

- Consent-op path changes — already correct, per `custody.ts:312`.
- `/custody/fresh-auth` itself — issues proofs, doesn't consume them; no change needed.
- `/custody/upgrade` re-auth — separate task (`backend-custody-upgrade-seed-phrase-reauth.md`), uses seed-phrase-derived key, not fresh-auth proof.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariants #1, #2 (re-auth at critical actions; factor must match registered set)
- `backend/src/routes/custody.ts:312` (consent-op fresh_auth_proof verification — pattern to extend)
- `backend/src/lib/fresh-auth.ts` (proof verification primitives, password and ORCID mechanisms)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
