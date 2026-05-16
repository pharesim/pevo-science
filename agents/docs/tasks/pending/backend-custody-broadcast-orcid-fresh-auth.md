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

## Implementer signal — 2026-05-16 (round 1)

**Design chosen:** Option A (require `fresh_auth_proof` on the non-consent path).

The current non-consent path runs no re-auth check at all — only the JWT (`verifyHiveSignature` middleware) is required. This violated § 6.5 invariant #1 ("Critical actions require fresh re-auth proof. A stolen JWT must not be a one-step takeover vector"). The task's "currently uses `password`" framing is historical aspiration, not an accurate description of HEAD. The fix is to ADD a fresh-auth gate, not deprecate an existing one.

**Storage primitive change:** extended `lib/fresh-auth.ts` `StoredEntry` with a `kind: 'consent_op' | 'session'` discriminator (default `'consent_op'` for backward compat). `issueFreshAuthToken` accepts an optional `kind` parameter — when `'session'`, the `target` argument is ignored and no `target_hash` is stored. Added a new `consumeSessionFreshAuthToken(token, expectedUsername)` that accepts EITHER a `kind: 'session'` entry (no target check) OR a `kind: 'consent_op'` entry (target check skipped — non-consent broadcasts don't need per-op binding). Cross-kind acceptance is the cheaper choice: State A/B users can mint via the existing `/custody/fresh-auth` (per-op proof) and reuse the same token for a non-consent broadcast on the same session.

**Issuance for State C:** added ORCID `mode='session_auth'` in `routes/orcid.ts`. Mints a target-less ORCID-mechanism session-kind proof. Avoids forcing State C users to send dummy per-op target fields when they're broadcasting a vote/comment/etc.

**`/custody/fresh-auth` left alone**, per the task's "out of scope" line. State A/B users keep using it (per-op issuance with action+root_author+root_permlink); the resulting token works for non-consent broadcasts too via the cross-kind accept on consume. If the operator ergonomics around requiring per-op fields on State A non-consent broadcasts become a real complaint, a follow-up can add a session-only password issuance route (or extend `/custody/fresh-auth` with a `purpose` discriminator).

**Wire shape change** — `[TODO Architect]`: `POST /api/custody/broadcast` now REQUIRES `fresh_auth_proof: string` on every call (consent op or not). Missing/expired/cross-account proofs are rejected with the same 401/403 FRESH_AUTH_REQUIRED envelope as the consent-op path. New ORCID mode `'session_auth'` requires only the authenticated session; no per-op target fields in the `/start` body. Update `agents/docs/api-contracts/custody.md` and the orcid contract doc accordingly.

**Tests:**
- `backend/tests/routes/custody-non-consent-fresh-auth.test.ts` (new) — state A/B/C/D real-path integration coverage. Mocks the chain broadcast helper + `decryptKey` per the custody.test.ts carve-out pattern, runs real Postgres + Redis + argon2 + verifyHiveSignature + fresh-auth.ts.
- `backend/tests/lib/fresh-auth.test.ts` — new section covers session-kind issuance/consume, cross-kind acceptance on `consumeSessionFreshAuthToken`, and rejection of session-kind proofs on `consumeFreshAuthToken` (the consent-op consume).
- `backend/tests/routes/custody.test.ts` — existing tests updated to pass `fresh_auth_proof` on non-consent broadcasts (was: no proof; now: required).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
