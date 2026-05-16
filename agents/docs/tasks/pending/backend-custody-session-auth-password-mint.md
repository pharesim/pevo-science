# BACKEND-CUSTODY-SESSION-AUTH-PASSWORD-MINT — add a password-mechanism session-kind fresh-auth issuance route

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced as the missing State A mint path during `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-1 @ 84602f8)
**Priority:** P1 (unblocks State A users on the non-consent broadcast flow; depends-on for `ui-non-consent-broadcast-fresh-auth-wiring`)

## Problem

Commit `84602f8` made `fresh_auth_proof` required on every `/api/custody/broadcast` call. State A users (light + password, no ORCID) have two ways to mint a proof today:

1. `POST /api/custody/fresh-auth` — password mechanism, but mints a **consent_op-kind** proof bound to specific `(action, root_author, root_permlink)` target fields. Hostile UX for vote/comment broadcasts (every vote requires the SPA to know the per-op target before minting, and the proof is single-use so it can't span multiple votes in a session).
2. `POST /api/orcid/start { mode: "session_auth" }` — but State A users have no ORCID linked.

Result: State A users have no usable mint path for non-consent broadcasts. The implementer signal in the parent task anticipated this: *"If the operator ergonomics around requiring per-op fields on State A non-consent broadcasts become a real complaint, a follow-up can add a session-only password issuance route (or extend `/custody/fresh-auth` with a `purpose` discriminator)."*

This is that follow-up.

## Goal

Add a password-mechanism **session-kind** fresh-auth issuance path so State A users can mint a target-less proof that admits any non-consent broadcast within the 5-minute TTL.

## Approach

Two shape options:

**Option A — new route `POST /api/custody/session-auth`** (mirror of the ORCID session_auth shape, password mechanism). Body: `{ "password": "..." }`. Response: `{ "fresh_auth_proof", "expires_at", "mechanism": "password" }`. Symmetric with `/api/orcid/start { mode: "session_auth" }`; clean wire surface.

**Option B — extend `POST /api/custody/fresh-auth` with a `purpose` discriminator**. Body adds `"purpose": "consent_op" | "session"`. On `purpose === "session"`, the `action`/`root_author`/`root_permlink` fields become optional and the issued proof is session-kind. Backward-compatible; single endpoint surface.

Architect recommendation at implementation time: **Option A**. Mirrors the existing ORCID session_auth shape, clearer wire contract, no overloading of one endpoint with two semantically-different behaviors. The backend team should choose at implementation time and document in the implementer signal.

## Acceptance

### 1. New endpoint (assuming Option A)

`POST /api/custody/session-auth`:
- Auth: JWT (account must have `custody: "light"`).
- Body: `{ "password": "..." }`.
- Verifies password via argon2 (same path as `/api/custody/fresh-auth`).
- Mints a session-kind proof bound to the JWT subject with `mechanism: "password"` and NO target binding.
- Response: `{ "fresh_auth_proof": "...", "expires_at": "<ISO>", "mechanism": "password" }`.
- Rate limit: 10 requests per account per minute (same as `/api/custody/fresh-auth`).
- Errors: same shape as `/api/custody/fresh-auth` minus the target-field errors.

### 2. Cross-kind accept verified

The new session-kind proofs minted via this endpoint must be accepted on `POST /api/custody/broadcast` non-consent surface (already true via the existing cross-kind accept in `consumeSessionFreshAuthToken`). Verify with an integration test.

### 3. Kind isolation verified

A session-kind proof minted via this endpoint must be REJECTED on the consent-op surface with 403 `FRESH_AUTH_REQUIRED` `details.reason: "kind_mismatch"` (already true via the existing strict-kind check in `consumeFreshAuthToken`). Verify with an integration test.

### 4. Test coverage

Real-path integration test against Postgres + Redis + argon2 + real `verifyHiveSignature`:
- Happy path: State A user mints, broadcasts a vote, broadcasts a comment in the same session (proof reuse via cross-kind accept — single-use, so each broadcast consumes one proof; the test pattern is mint-vote-mint-comment, not single-mint-multi-broadcast).
- Wrong password → 401.
- No-password account (State C) → 401 (`password_hash IS NULL` returns the same shape to avoid becoming a password-existence oracle).
- Self-custody → 403.
- Cross-kind accept on non-consent surface confirmed.
- Kind-mismatch reject on consent surface confirmed.

### 5. API contract doc

Add the new endpoint to `agents/docs/api-contracts/custody.md` (architect-zone — flag as `[TODO Architect]` at implementer-signal time).

## Out of scope

- Changes to `/api/custody/fresh-auth` (this task is additive; the existing consent-op-kind mint stays as-is).
- State B password mint via this endpoint (State B already has the ORCID session_auth path, recommended); the new endpoint is also available to State B users who prefer password.
- UI integration (lives in `ui-non-consent-broadcast-fresh-auth-wiring.md`).

## Dependencies

- None. This task is the dependency-on for `ui-non-consent-broadcast-fresh-auth-wiring`.

## Cross-references

- `backend/src/lib/fresh-auth.ts` — extend `issueSessionFreshAuthToken` to accept `mechanism: "password"` (it already takes a mechanism parameter per the round-1 implementation; verify).
- `backend/src/routes/custody.ts` — add the new route handler.
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract, per-state availability table).
- `agents/docs/api-contracts/custody.md` — the existing `/api/custody/fresh-auth` section is the template to mirror.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` (architect session 2026-05-16): api-contract AC-1 P0 conf 100 — surfaced the State A mint-path gap during the parent task's triage. The implementer signal in the parent task explicitly anticipated this follow-up.
