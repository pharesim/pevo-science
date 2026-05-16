# UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING — supply `fresh_auth_proof` on every `/api/custody/broadcast` call

**Owner:** UI
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-1 @ 84602f8 — P0 frontend-coordination gap)
**Priority:** P0 (deploy-blocker — backend ships the new `fresh_auth_proof`-required wire contract on next deploy; current SPA broadcast helper omits the field, blocking ALL light-account publish/comment/vote/edit/vouch operations post-deploy)

## Problem

Backend commit `84602f8` requires `fresh_auth_proof` on every `/api/custody/broadcast` call (consent op or non-consent). Closes ARCHITECTURE.md § 6.5 invariant #1 — pre-change a stolen JWT was a one-step takeover vector for vote/comment broadcasts.

The SPA's universal broadcast entry point at `frontend/src/signer.js:16-23` sends `{ operations }` with no `fresh_auth_proof` field. Seven downstream call sites use `broadcastOps` for non-consent ops: `publish.js`, `review.js`, `comment-composer.js`, `paper-detail.js`, `vote-buttons.js`, `edit.js`, `vouch-section.js`. After the backend deploy every light-account user will receive 401 FRESH_AUTH_REQUIRED on each of these flows. State C (passwordless ORCID-only) is the originally-motivating case but the breakage is universal — State A and State B users are blocked too.

## Goal

Wire `fresh_auth_proof` minting + submission into the SPA's broadcast helper for non-consent ops. Each user state mints via the factor it has registered:

- **State A** (light + password, no ORCID) → password mint. Today only `/api/custody/fresh-auth` exists, and it requires per-op target fields (`action`, `root_author`, `root_permlink`) that don't apply to vote/comment. A backend follow-up (`backend-custody-session-auth-password-mint`) adds a session-kind password issuance; this UI task depends on that landing.
- **State B** (light + password + ORCID) → either password or ORCID mint. ORCID session_auth is the simpler shape (target-less, single OAuth round-trip per session). Recommend ORCID by default.
- **State C** (passwordless ORCID-only) → ORCID mint via `POST /api/orcid/start { mode: "session_auth" }`. Only path.

## Acceptance

### 1. `signer.js` broadcast helper signature change

`broadcastOps(operations, { freshAuthProof })` — accept an optional `freshAuthProof` parameter that is passed through into the request body as `fresh_auth_proof`. Document that the parameter is REQUIRED for any non-consent bundle going forward; the optionality at the JS API level is for the migration window only.

### 2. Mint flow integration

Add a `mintNonConsentProof()` helper that:

- Detects user state (custody, has-password, has-orcid).
- For State C: redirects through the ORCID OAuth round-trip via `mode: "session_auth"`. Cache the issued proof in memory for the session's 5-minute TTL; subsequent broadcasts in the same window reuse it without a new round-trip.
- For State B: prefer the cached session-kind proof if present; otherwise mint via ORCID session_auth. Optionally offer a password fallback (out of scope for round-1).
- For State A: mint via the new `backend-custody-session-auth-password-mint` endpoint (depends on that backend task landing first).

### 3. Per-call site wiring

Each of the seven non-consent broadcast call sites wraps its broadcast in `await mintNonConsentProof()` → `broadcastOps(ops, { freshAuthProof })`. The proof is consumed atomically; if the broadcast fails (502, 504), the proof is gone — re-mint on retry.

### 4. UX considerations

- ORCID session_auth requires a full OAuth round-trip (redirect to orcid.org, return). For State B/C users, the first non-consent op of a session triggers the round-trip; subsequent ops within the 5-minute TTL reuse the cached proof. Surface a clear "Authenticating..." UI during the round-trip.
- State A users do not redirect; the password mint is in-line.
- Consider showing a one-time "Re-authentication required" tooltip the first time a user encounters the new gate, to set expectations.

### 5. Error handling on the broadcast

- 401 `FRESH_AUTH_REQUIRED` `details.reason: "missing" | "expired" | "malformed"` → mint a new proof and retry the broadcast.
- 403 `FRESH_AUTH_REQUIRED` `details.reason: "username_mismatch"` → critical session inconsistency; force re-login.
- 403 `FRESH_AUTH_REQUIRED` `details.reason: "kind_mismatch"` → shouldn't happen on the non-consent surface (it accepts both kinds); if seen, log and treat as misconfiguration.

### 6. Tests

E2E tests cover: State C user (passwordless ORCID-only) publishes a paper, comments, votes; State B user does the same with ORCID mechanism; State A user does the same with password mechanism (depends on `backend-custody-session-auth-password-mint`). Cover the proof-cache reuse within the 5-minute window, and the re-mint behavior after TTL expiry.

## Out of scope

- Backend changes (already landed in commit `84602f8`).
- API contract doc updates (architect lands during the task-4 archive cycle).
- Consent-op broadcasts (`author_accept` / `author_resign`) — those already mint via `/api/custody/fresh-auth` per the existing flow; this task only adds the non-consent path.

## Dependencies

- `backend-custody-session-auth-password-mint.md` (pending) — adds the State A password session-kind mint endpoint. State A users cannot use this UI flow until that backend task lands.

## Cross-references

- `agents/docs/api-contracts/custody.md` — `/api/custody/broadcast` contract (updated by architect alongside this task's creation).
- `agents/docs/api-contracts/orcid.md` — `mode='session_auth'` documentation (also updated alongside).
- `agents/docs/ARCHITECTURE.md` § 6.4 (re-auth contract), § 6.5 invariant #1 (critical-action fresh-auth requirement, the invariant this fix closes).
- `backend/src/lib/fresh-auth.ts` — read for the consume function semantics + cross-kind accept rules.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` (architect session 2026-05-16): api-contract AC-1 P0 conf 100. Frontend-coordination gap surfaced during architect triage.
