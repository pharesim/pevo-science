# BACKEND-RECOVER-EMAIL-VERIFICATION-AND-NOTIFY — Memo-key recovery must verify new email and notify old

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-1-security-reviewer.md` + `chunk-1-adversarial-reviewer.md`)
**Priority:** P1 (security)

## Context

`backend/src/routes/auth.ts` `/recover` (memo-key seed-phrase path) currently:

- Accepts proof of seed-phrase possession (memo-key signature).
- Swaps `email = $2` and `password_hash = $3` in `accounts` for the matching username in a single UPDATE.
- Returns success.

Two defects, both P1:

1. **No email-verification challenge** on the new email. A seed-phrase holder rebinds `email` to anything they want, no confirmation, no token round-trip. Whoever holds the seed phrase silently captures all future password resets, account notifications, GDPR contact paths, and audit trails.

2. **No notification to the old email**. The previous email-holder has no idea the rebinding happened. By the time they notice (next login attempt, next notification not arriving), the attacker has rotated keys and possibly upgraded to self-custody.

Plus an adjacent defect from `chunk-1-adversarial-reviewer.md`: **ORCID recovery still works after the account upgraded to self-custody** (`backend/src/routes/custody.ts:195-203`). Upgrade-to-self-custody doesn't sever the ORCID-recovery path, so an attacker with the original ORCID link can still trigger recovery on an account that is no longer under platform control.

## Goal

Treat memo-key recovery as a sensitive operation that requires email-side proof and full notification:

1. **Two-phase recovery.**
   - Phase 1: caller submits seed-phrase signature + new email. Server stages the request (no swap yet), issues a verification token to the new email.
   - Phase 2: caller hits the verification link from the new mailbox; server applies the swap.
2. **Notify old email** synchronously during Phase 2 (or sooner, at Phase 1). The notification should describe the change, name the new email's domain (not full address), and include a 24-48h dispute link that reverses the swap.
3. **Log recovery success** to `custody_audit_log` (or equivalent) including timestamp, requesting IP, and old-email digest. Forensic trail must survive even the email-delete path (see related task `backend-settings-audit-log-preservation-on-account-delete.md`).
4. **Sever ORCID recovery after upgrade.** In `custody.ts` upgrade path, either:
   - Delete the `orcid` column for upgraded accounts.
   - Or gate `/recover` on `upgraded_at IS NULL` for the ORCID-branch only.

   The audit recommends deleting `orcid`; that's cleaner, but if other surfaces depend on the column (e.g., display purposes), the gate path is acceptable.

## Non-goals

- Adding a recovery cooldown / per-account counter. Audit P2; separate task if pursued.
- Rotating posting + memo keys automatically on recovery. The current swap-email-and-password flow is the minimum; key rotation is a follow-on UX.

## Acceptance

- `/recover` does not commit `email` / `password_hash` swap until the new email proves possession of a server-issued token.
- Old email receives a notification with dispute link.
- ORCID-recover path is gated on `upgraded_at IS NULL` (or `orcid` is cleared on upgrade).
- A test exercises the full flow: recover request → new-email token → swap, plus failure path where new-email token is never opened (state expires).
- A test verifies that an upgraded self-custody account cannot be recovered via the original ORCID link.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-1-security-reviewer.md` (P1: memo-key recovery bypasses email verification).
  - `.context/audit-2026-04-21/chunk-1-adversarial-reviewer.md` (P1: ORCID recovery still works after upgrade).
- Related: `backend-settings-audit-log-preservation-on-account-delete.md`, `backend-auth-token-session-binding.md`.
