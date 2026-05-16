# BACKEND-SETTINGS-EMAIL-REAUTH-AUDIT — Audit `/api/settings/email` re-auth and document or fix any gap

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6 — § 6.4 row marked "TBD")
**Priority:** P2

## Problem

`agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract) lists `POST /api/settings/email` with re-auth "TBD — re-auth model unverified; see open audit task". This task is that audit.

Email is a critical-action route per § 6.5 invariant #1: changing the email address controls who receives `/reset-request` password-reset links, so an attacker who can change the email to one they control can reset the password and take over the account. The re-auth model must be at least as strong as `/reset`'s effective barrier — typically: a current-password proof, an ORCID fresh-auth proof, or both.

## Goal

Read the current `/api/settings/email` handler at `backend/src/routes/settings.ts` (lines 96-198 per the route table) and the `/email/verify/:token` partner at line 199. Determine:

1. What re-auth (if any) the change-email request requires today.
2. Whether the model satisfies § 6.5 invariant #1 (no JWT-only critical-action access).
3. Whether per-state availability matches § 6.4's intent — state A (password registered), state B (password + ORCID), state C (ORCID only) should each have a path.

## Acceptance

After the audit, EXACTLY ONE of the following happens:

- **(a) Gap found:** file a follow-up backend task with the same shape as `backend-settings-set-password-fresh-auth.md` documenting the required re-auth and the per-state proof factors. Architect updates `agents/docs/ARCHITECTURE.md` § 6.4 to remove the TBD and document the intended re-auth at archive time.
- **(b) No gap:** the existing model already requires a sufficient re-auth proof (current-password OR ORCID fresh-auth, properly verified). Architect updates § 6.4 to document the current correct model and removes the TBD at archive time. No code change.

## Out of scope

- Implementation of any fix discovered. If a gap exists, this audit task closes with the filing of a follow-up; the follow-up is the implementation task.
- Auditing other `/settings` endpoints. Each is its own audit; this one is scoped to `/email` only.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract — current row marked TBD)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (no JWT-only critical actions)
- `backend/src/routes/settings.ts:96` (current POST /email handler)
- `backend/src/routes/settings.ts:199` (POST /email/verify/:token — completion path)
- `backend/src/routes/auth.ts:850` (`/reset-request` — the downstream takeover vector if change-email is unguarded)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
