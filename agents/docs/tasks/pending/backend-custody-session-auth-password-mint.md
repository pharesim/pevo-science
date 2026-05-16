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

## Backend implementation signal (2026-05-16, worktree)

Acceptance items 1-4 landed.

**Design chosen: Option A** (new dedicated route `POST /api/custody/session-auth`).

- New route handler at `backend/src/routes/custody.ts:813` (route declaration) through `backend/src/routes/custody.ts:880` (handler end). Mirrors the `/fresh-auth` route shape minus the per-op target fields (no `action` / `root_author` / `root_permlink` body discriminators, no `FreshAuthTarget` construction). New rate limiter `sessionAuthLimiter` declared at line 61: 10 req/min/account via `byAccount` keyFn, same shape and budget as `freshAuthLimiter`, distinct `name: 'custody-session-auth'` so the observability surface stays separable.
- `backend/src/lib/fresh-auth.ts`: NO extension needed. `issueSessionFreshAuthToken(username, mechanism)` already accepts `mechanism: FreshAuthMechanism` ('password' | 'orcid') per the round-1 implementation of `backend-custody-broadcast-orcid-fresh-auth` (kind-neutral `KEY_PREFIX` shared with the consent-op-kind path, kind discriminator inside the JSON value). Imports in `custody.ts` extended to add `issueSessionFreshAuthToken` alongside the existing `issueFreshAuthToken` / `consumeSessionFreshAuthToken` / `consumeFreshAuthToken` set.
- Password-existence oracle pinned: `null password_hash` branch returns the same 401 + UNAUTHORIZED + 'Invalid password' envelope as the wrong-password branch, matching the convention already proven on `/api/custody/fresh-auth` (round-4 hold #18) and asserted byte-equivalent in `custody-fresh-auth-null-hash.test.ts`.
- Tests landed in `backend/tests/routes/custody-session-auth.test.ts` (10 canaries across the 6 acceptance branches):
  - State A happy path: `mint → broadcast vote → 200`, separate `mint → broadcast comment → 200` (each broadcast consumes a single-use proof; documented in the test header).
  - Wrong password → 401 UNAUTHORIZED.
  - Null `password_hash` (State C) → 401 with byte-equivalent envelope assertion against the wrong-password baseline (oracle check).
  - Self-custody JWT → 403 FORBIDDEN.
  - Upgraded row (light JWT, `upgraded_at` set, State D) → 403 FORBIDDEN.
  - Kind isolation: session-kind proof on the consent-op surface → 403 FRESH_AUTH_REQUIRED `details.reason: 'kind_mismatch'` (consume path validated; broadcast NOT called).
  - Body validation: missing password → 400 VALIDATION_ERROR; empty-string password → 400 VALIDATION_ERROR.
- Cross-kind accept on the non-consent broadcast surface is exercised by the State A happy-path tests (session-kind proof admits a vote/comment broadcast without per-op binding). The reverse direction (consent_op-kind on non-consent surface) is already pinned in `custody-non-consent-fresh-auth.test.ts`.
- Test mock-target scope is identical to the sibling `custody-non-consent-fresh-auth.test.ts` (dhive client + `decryptKey` mocked under the carve-out's "third-party libraries non-trivial to run for real per-test" allowance); `verifyHiveSignature` runs REAL because the suite's focus IS authentication semantics on the mint path. Clause (c) real-path companion: `custody-non-consent-fresh-auth.test.ts` exercises the same fresh-auth consume path against the real middleware.

[TODO Architect] — `agents/docs/api-contracts/custody.md`: document the new `POST /api/custody/session-auth` route. Body shape `{ "password": "..." }`, response `{ "fresh_auth_proof", "expires_at" (epoch seconds, matches `/fresh-auth` and `/orcid/start mode=session_auth`), "mechanism": "password" }`. Error envelopes mirror `/api/custody/fresh-auth` minus the target-field 400s: `400 VALIDATION_ERROR` (missing/empty password), `401 UNAUTHORIZED` (wrong password OR `password_hash IS NULL`, byte-equivalent envelope — oracle guard), `403 FORBIDDEN` (custody !== 'light', or `upgraded_at` set), `500 INTERNAL_ERROR` (argon2/DB failure). Rate limit `10 req/min/account` keyed by JWT subject, same shape and budget as `/api/custody/fresh-auth` but under the distinct bucket name `custody-session-auth` for separable observability.

`npm run lint`: clean (only the pre-existing `seed-phrase.ts` warnings, unchanged by this commit). `npx tsc --noEmit`: clean (against the symlinked `node_modules` from the main checkout — worktree had no own install). Vitest NOT run in the worktree (parent serializes).
