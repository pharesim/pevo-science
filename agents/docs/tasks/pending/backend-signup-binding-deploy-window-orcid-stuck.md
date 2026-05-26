# BACKEND-SIGNUP-BINDING-DEPLOY-WINDOW-ORCID-STUCK — Recovery for ORCID-only in-flight signups stranded by the binding migration

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the signup-binding range — reliability P2 advisory, deploy-window)
**Priority:** P3 (bounded by the 24h signup-token expiry; operator-facing)

## Context

The signup session-binding work (migration `011_accounts_signup_binding_hash.sql`) adds a nullable `signup_binding_hash` column. `verifyBinding` returns `false` for a NULL stored hash, so `/confirm` and `/link` fail closed for any pending-signup row that predates the migration (NULL hash, no cookie).

- **Email-flow in-flight signups** can self-recover: `/resume-signup` (password re-verify) re-mints the binding cookie and sets the hash.
- **ORCID-only in-flight signups** (`orcid` set, `password_hash` NULL) have no password and therefore cannot use `/resume-signup`. Their only path is to re-initiate the full ORCID signup, and until they do (or the row's 24h `expires_at` lapses) they get a confusing `400 "Invalid or expired ..."` with nothing actionable.

The window is bounded by `expires_at` (24h) and only affects users who were mid-signup at deploy time, so it is self-resolving — but a low-traffic deploy can still strand a real user with a confusing error.

## Goal

Pick the lighter of:

1. **Operator runbook (minimum):** document that immediately after deploying the binding migration, any stranded ORCID-only pending rows should be cleared so affected users get a clean re-signup rather than a stuck `400`. Identifying predicate: `verify_token IS NOT NULL AND signup_binding_hash IS NULL AND orcid IS NOT NULL AND password_hash IS NULL`. Provide the verification + cleanup SQL.
2. **Optional code nicety:** distinguish the NULL-binding-row rejection from the generic invalid-token `400` with a message that points the user to re-start ORCID signup (only if it can be done without re-introducing a token-validity oracle — keep the invalid-vs-mismatch responses indistinguishable; a NULL-hash row for an otherwise-valid token may be safe to message differently, verify).

Coordinate timing with the deploy of `backend-auth-token-session-binding` once it clears its hold cycle.

## Acceptance

- A runbook note (or `deploy.sh`/migration companion doc) describes the stranded-ORCID-row predicate, the verification query, and the cleanup action.
- If the code-message option is taken: the new message does not create a token-validity oracle (architect re-review checks this against the no-oracle invariant).

## Non-goals

- Backfilling bindings for in-flight rows (impossible — the cookie value never existed server-side).
- Changing the 24h expiry or the binding mechanism.
