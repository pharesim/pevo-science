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

---

## Backend resolution (2026-05-27)

Took **Option 1 (operator runbook)** only. **Skipped Option 2 (the distinct
NULL-binding-row message)** — analysis below shows it re-introduces a
token-validity oracle, so it is a security defect, not a nicety.

### Why the code-message option was skipped (oracle analysis)

The binding threat model deliberately makes the "invalid token" and
"binding mismatch" rejections an identical `400 BAD_REQUEST "Invalid or
expired auth token"` so a leaked-token holder cannot distinguish
"right token, wrong browser" from "wrong token" (which would confirm the
token is valid). Today a NULL-binding row also lands on that same generic
message: `verifyBinding(cookieValue, null)` returns `false`, so the
fail-closed reject is the generic one — no oracle.

A distinct "re-start ORCID signup" message for the NULL-binding case is
reachable ONLY when the `verify_token` lookup found a row (token IS valid)
AND its `signup_binding_hash` is NULL. Emitting a different message there
splits the response space three ways:

- invalid token → generic message
- valid token + non-NULL binding + no/wrong cookie → generic message
- valid token + NULL binding (stranded) → distinct message

An attacker submitting a leaked token with no cookie and receiving the
distinct message learns the token is valid AND in the stranded state — a
token-validity oracle for that subset, which the no-oracle invariant
forbids. The "may be safe to message differently" hypothesis in the task
Goal does not hold: the NULL-binding case is not separable from the valid-token
fact, so any distinct copy leaks validity. Backend leaves the rejection on the
generic message; the runbook (below) is the operator-facing remedy.

### [TODO Architect] Operator runbook addition (ARCHITECTURE.md is architect-owned; backend cannot edit it)

Add an operator note to the `Migrations` / deploy runbook section of
`agents/docs/ARCHITECTURE.md` covering the deploy-window strand of
`011_accounts_signup_binding_hash.sql`. Suggested content:

> **Post-deploy cleanup — migration `011` (signup binding hash).** The binding
> column is nullable and back-fills NULL on existing rows. `/confirm` and
> `/link` fail closed on a NULL `signup_binding_hash`, so any signup that was
> in-flight at deploy time is stranded. Email-flow rows self-recover via
> `/resume-signup` (password re-verify re-mints the cookie + hash).
> ORCID-only rows (no password) cannot, and will see a confusing
> `400 "Invalid or expired ..."` until they re-start the full ORCID signup or
> the row's 24h `expires_at` lapses. Immediately after the migration, clear any
> stranded ORCID-only pending rows so affected users get a clean re-signup.
>
> Stranded-row predicate:
>
> ```
> verify_token IS NOT NULL
>   AND signup_binding_hash IS NULL
>   AND orcid IS NOT NULL
>   AND password_hash IS NULL
> ```
>
> Verification SELECT (inspect before deleting — confirm the set is the
> in-flight ORCID-only strand and nothing else):
>
> ```sql
> SELECT id, orcid, full_name, created_at, expires_at
>   FROM accounts
>  WHERE verify_token IS NOT NULL
>    AND signup_binding_hash IS NULL
>    AND orcid IS NOT NULL
>    AND password_hash IS NULL
>  ORDER BY created_at;
> ```
>
> Cleanup action — DELETE the rows (not merely NULL `verify_token`). The
> ORCID-only signup INSERT in `auth.ts` is a plain INSERT (no ON CONFLICT) and
> the partial-unique index on `orcid` (migration `007`) would otherwise make
> the user's re-signup collide on the lingering stale row. Deleting clears the
> way for a clean re-signup:
>
> ```sql
> DELETE FROM accounts
>  WHERE verify_token IS NOT NULL
>    AND signup_binding_hash IS NULL
>    AND orcid IS NOT NULL
>    AND password_hash IS NULL;
> ```
>
> These rows are never-activated pending signups (no `username`, no
> `custody`), so deletion is non-destructive — there is no on-chain account or
> linked identity to lose. The window self-resolves within 24h via
> `expires_at` regardless; the cleanup just turns a confusing stuck `400` into
> an immediate clean re-signup for users mid-flight at deploy time.
