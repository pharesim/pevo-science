# ARCHITECT-RECOVER-EMAIL-API-CONTRACT-UPDATE — Document two-phase memo-key recovery in api-contracts/auth.md + ARCHITECTURE.md § 6.4

**Owner:** architect
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review on the recover-email cluster; api-contract reviewer flagged contract-doc drift across both new endpoints + breaking response-shape change on existing /api/auth/recover memo-key path)
**Priority:** P1 (production-facing contract drift)

## Problem

The recover-email backend task landed three contract changes that the architect-zone docs do not yet reflect:

1. **Breaking response-shape change on `POST /api/auth/recover` (memo-key path).** Old shape: `{ token, expires_at, custody, username }` at 200. New shape: `{ recovery: 'pending_verification', message }` at 200 (no token, no JWT). ORCID path is UNCHANGED (still returns the JWT envelope immediately). `agents/docs/api-contracts/auth.md` still describes the old single-shape response.

2. **NEW endpoint `POST /api/auth/recover/verify`** — not in the contract docs. Body: `{ token }`. Success 200: `{ token, expires_at, custody, username }`. Errors: 400 INVALID_TOKEN (invalid / expired / disputed / consumed / upgraded / account-gone), 409 DUPLICATE (new email taken since phase 1).

3. **NEW endpoint `POST /api/auth/recover/dispute`** — not in the contract docs. Body: `{ token }`. Success 200: `{ disputed: true, message }`. Errors: 400 INVALID_TOKEN (invalid / expired). Idempotent at the source-of-truth level (the staging row's `disputed_at` is set via `COALESCE(disputed_at, NOW())` on first click).

4. **`ARCHITECTURE.md` § 6.4 Recover row** does not reflect the two-phase shape. § 6.5 invariant #3 ("recovery proof must match a registered factor") is unaffected; this change adds an email-control proof ON TOP of the seed-phrase proof for the rebind. Memo-key recovery factor is now (seed-phrase AND email-control); ORCID recovery factor is unchanged.

5. **Dispute-mail PII discipline**: dispute mail names only the new email's DOMAIN (via the `emailDomain()` helper), not the full address. CNPD-defensible per Portugal jurisdiction. Document the convention so it survives future copy edits.

## Goal

Bring `agents/docs/api-contracts/auth.md` and `agents/docs/ARCHITECTURE.md` § 6.4 in sync with the landed backend implementation. Document the path-dependent response discriminator on `/api/auth/recover`, the two new endpoint contracts, and the dispute-mail PII convention.

## Acceptance

- `agents/docs/api-contracts/auth.md` updates the `POST /api/auth/recover` section to document the path-dependent response shape (memo-key path returns the `pending_verification` envelope; ORCID path returns the JWT envelope unchanged).
- New section in `auth.md` for `POST /api/auth/recover/verify` (body / success / error envelopes / TTL note).
- New section in `auth.md` for `POST /api/auth/recover/dispute` (body / success / error envelopes / idempotency note / dispute-window TTL).
- `ARCHITECTURE.md` § 6.4 Recover row reflects the two-phase memo-key flow + the email-control sub-proof requirement on the rebind.
- Dispute-mail PII convention (domain-only, never local-part) documented either inline in the auth.md endpoint section or as a brief note in the relevant existing section.

## Non-goals

- Adding a `details.reason` discriminator on the collapsed `INVALID_TOKEN` 400 envelope. The api-contract reviewer flagged this as a UX consideration for the SPA; if pursued, files as a separate task. The SPA can string-match the message text today.
- Updating the SPA frontend to consume the new path-dependent shape. That belongs to the UI agent; out of scope here.

## References

- Backend task (held to pending/ at round-1): `agents/docs/tasks/pending/backend-recover-email-verification-and-notify.md`
- The backend implementer signal-block at the end of that task file enumerates the contract-doc updates needed under `[TODO Architect]`.
- `backend/src/routes/auth.ts` — `/recover` memo-key path, `/recover/verify`, `/recover/dispute` handlers (source of truth).
- `backend/migrations/012_pending_recovery.sql` — staging table shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
