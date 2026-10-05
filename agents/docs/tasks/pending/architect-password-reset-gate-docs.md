# Bring the docs up to date with the password-reset account-state gate

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

Filed by the backend at the user's request, from the `[TODO Architect]` list in the signal block
of `tasks/review/backend-password-reset-gates-on-account-state.md`. Normal rather than low:
§ 6.3 and § 6.4 are what account-state reviews defend code against, and as written they list
reset transitions the code no longer has and miss ones it keeps.

## Why

Commits `8bf9283a`, `bd5d7e28` and `1dd8776a` landed the rule "reset rotates an existing password
and never adds one". `POST /api/auth/reset-request` selects only a row with a password, so a
passwordless row gets the unknown-email answer and no token. `POST /api/auth/reset` gates its
UPDATE on `password_hash IS NOT NULL` and answers a write that matches no row with the
unknown-token `INVALID_TOKEN` answer.

Measured outcome per § 6.1 state, now pinned by `backend/tests/routes/auth-reset-account-state.test.ts`:

- Rotates the password: A, B, D with a password, G with a password (email verified or not), E,
  and F on the email path.
- Refused: C, D without a password, G without a password (email verified or not), and F on the
  ORCID path. reset-request issues no token, and a token already on the row gets
  `INVALID_TOKEN`; the row is unchanged.
- An expired token on a passwordless row still takes the expiry branch first ("Reset token has
  expired", token cleared, no password written).

The backend signal block has the full before/after table.

## Scope

All architect zone. Wording is yours; the replacements below are suggestions that match the code.

1. **ARCHITECTURE.md § 6.3, "Forgot password" block.** Now:

   ```
   Forgot password (requires email access):
     A ──reset(email-link, new_password)──> A             (password rotated)
     B ──reset(email-link, new_password)──> B
     (C cannot use /reset — state C may have no email, and has no password to reset)
   ```

   It should list every state reset still rotates (A, B, D and G with a password, the
   pre-finalize E and email-path F rows) and say a row with no password is refused (C, a
   passwordless D or G, the ORCID-path F row). For the email-path F row it may be worth noting
   that `/resume-signup` then continues the signup, which is the forgot-password resume flow the
   rule had to keep.

2. **ARCHITECTURE.md § 6.3, Option C note.** "`POST /api/auth/reset` gates on no account state
   and stamps `sessions_invalidated_at` (§ 6.7) without touching `updated_at`, ..." is false now.
   The matching comment in `backend/src/routes/signup-verify.ts` (the `/link` stuck-recovery
   rationale) was narrowed to "gates on no account state but the password". The argument still
   holds for any row with a password.

3. **ARCHITECTURE.md § 6.4, reset row.** "A and B (states with email AND password). C: not
   applicable." Should read as: any row with an email and a password (A, B, D and G with one, E,
   email-path F); refused for a row with no password.

4. **ARCHITECTURE.md § 6.5, invariant #3.** "State C (no password) cannot use `/reset`" is now
   enforced as written. Optional: widen it to every row with no password, which is what the code
   refuses.

5. **`agents/docs/api-contracts/auth.md`:**
   - `POST /api/auth/reset` errors: `INVALID_TOKEN` is "token not found or expired". It is also
     the answer for a token whose account has no password.
   - `POST /api/auth/reset-request`: "Always returns success to prevent email enumeration." A
     passwordless account gets the same answer and no email; worth one sentence.
   - No emdashes in new contract text (root `CLAUDE.md`).

Not in scope: the two comments the backend task's architect note named (`routes/settings.ts`
set-password "Only ORCID-verified accounts can opt into password login", and the `ORCID_REQUIRED`
comment in `tests/routes/settings-set-password.test.ts`). The default rule made both true as
written.

## Related, triaged separately

The backend signal block lists three out-of-scope findings and one user-approved follow-up (an
ORCID-proven resume path for ORCID-path F rows). They are not doc updates and are not part of
this task.

## Acceptance criteria

1. § 6.3's "Forgot password" block and § 6.4's reset row match the outcome list under Why.
2. No sentence in ARCHITECTURE.md or `api-contracts/auth.md` says reset gates on no account
   state, or that reset applies only to A and B.
