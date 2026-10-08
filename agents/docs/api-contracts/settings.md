# PEvO API Contract — Settings

Endpoints for account-level settings (email, password) that apply to the authenticated user.

All write endpoints are authenticated via `verifyHiveSignature` (Keychain signature or Bearer JWT from `/api/auth/session` or `/api/auth/login`).

---

### GET /api/settings/email

Read the authenticated account's email and password status. Used by the settings UI to decide which surfaces to show (add email, verify email, set password, etc.).

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Response `data`:**

```json
{
  "hasEmail": true,
  "email": "j***h@***.com",
  "verified": true,
  "custody": "light",
  "pendingChange": false,
  "pendingEmailChange": null,
  "pendingDeletion": null,
  "hasPassword": false
}
```

- `hasPassword`: `true` when the account has `password_hash` set, `false` when it has none (and for a caller with no row). `POST /api/settings/set-password` accepts only a row with no password, a linked ORCID and a verified email, so `false` alone does not make it available. Renamed from snake_case `has_password` to align with the rest of the response object's camelCase casing.
- `hasEmail` / `email` / `verified` — existing email-management fields (unchanged).
- `pendingChange`: `true` while a change is queued. Decided 2026-10-08 (lands with the hold task): true only while the queued change is confirmed or its verify token is unexpired.
- `pendingEmailChange` (decided 2026-10-08, lands with the hold task): `null`, or `{ "email": "<masked pending address>", "confirmed": false, "effectiveAt": "<ISO date>" }`. `confirmed` is true once the new address has opened its verify link; `effectiveAt` is the end of the hold, or `null` on a change that carries no hold (one proven by an ORCID proof or on the Keychain path). The pending address is masked like `email`.
- `pendingDeletion` (decided 2026-10-08, lands with the held-deletion task): `null`, or `{ "effectiveAt": "<ISO date>" }` while a password-proven deletion is queued.
- `custody` — `"self"` for upgraded/Keychain accounts, `"light"` otherwise.

When the authenticated user has no account row (Keychain user who never added an email), the response is `{ hasEmail: false, custody: 'self', hasPassword: false }`.

---

### POST /api/settings/email

Add or change the authenticated account's email. Sends a verification link to the address. On the change branch the account's email is not switched until `GET /api/settings/email/verify/:token` is hit. The add flow and the re-issue branch write the address at once, and it stays unverified until that link is clicked.

**Auth:** `verifyHiveSignature`.

**Body shape depends on the path:**

- **Change-email branch on an existing row, JWT-authenticated:** `{ "email": "new@example.com", "fresh_auth_proof": "<single-use token>" }`. A fresh-auth proof is required; the proof's `mechanism` must match a factor registered on the account (state A: `password`; state B: `password` or `orcid`; state C: `orcid`; states D and G: `orcid`, because the password issuer refuses their `'self'` claim). The proof is bound to `(change_email, <username>, '')`; mint via `POST /api/orcid/start mode='fresh_auth' action='change_email'` (ORCID factor) or `POST /api/custody/fresh-auth action='change_email'` (password factor). See ARCHITECTURE.md § 6.4 row "Change email" for the per-state contract.
- **Keychain (Hive-signature) authenticated:** `{ "email": "new@example.com" }`. No body proof required — the signed canonical message is already fresh-proof-bound at the middleware.
- **Add-flow no-row branch (account has no `accounts` row yet):** Keychain path only. A JWT does reach it (`POST /api/auth/session` mints one for a row-less Keychain caller, and deleting a row leaves earlier JWTs live) and gets 401 `UNAUTHORIZED` with no row written. Body is `{ "email": "new@example.com" }`; no body proof.
- **Re-issue branch (state G row whose email is still unverified):** the POST does not take the change branch. It replaces the row's email, `verify_token` and `expires_at`, clears any queued change, and mails a new link, so the earlier link stops working. The JWT-path fresh-auth gate and the duplicate checks are the same as on the change branch.

**Held change (decided 2026-10-08, lands with the hold task; ARCHITECTURE.md § 6.3).** When the request is on the JWT path, the consumed proof's mechanism is `password`, and the row holds an email, the change is held: the verify token still goes to the new address at once, and a second mail, with no link, goes to the current address naming the new address in masked form and by domain and saying that the change takes effect no earlier than 72 hours after the request and only once the new address has confirmed, and that resetting the password stops it. The hold ends 72 hours after the request. A change proven by an ORCID proof, on the Keychain path, or on a row with no email, carries no hold and sends no second mail. A password-proven request cannot replace a queued change that carries no hold. A failed send of the second mail changes nothing; a failed send of the verify mail restores the prior state and answers the same 200 as today.

**Rate limits.** 10 writes per IP per minute (shared with other settings writes). Decided 2026-10-08 (lands with the hold task): also 5 per account per hour shared with `DELETE /api/settings/email`, counting successful requests only.

**Response `data`:** `{ "message": "Verification email sent" }`

**Errors:**
- `VALIDATION_ERROR` — invalid or missing email. Decided 2026-10-08 (lands with the hold task): also an address equal to the account's current email, message `This is already the email address on this account.`, checked after the fresh-auth gate.
- `DUPLICATE` (409): email is already held by another account row, a pending signup included, or is another account's `pending_email`
- `PENDING_CHANGE` (409, decided 2026-10-08, lands with the hold task): a password-proven request while a change that carries no hold is queued. Message: `Another email change is already queued and cannot be replaced with this proof.`
- `UNAUTHORIZED` (401): the add flow (no row) reached on the JWT path.
- `FRESH_AUTH_REQUIRED` (401) — `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. `missing` fires when the JWT path body has no `fresh_auth_proof`; `expired` fires when the proof has been consumed, exceeded its TTL (5 min), or is unknown; `malformed` fires on token-format failure; `wrong_mechanism` fires when the proof's mechanism does not match the per-state matrix (e.g., a `password`-mechanism proof submitted against a state-C account that has no password registered).
- `FRESH_AUTH_REQUIRED` (403) — `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. `username_mismatch` fires when the proof was issued for a different user than the JWT subject; `target_mismatch` fires when the proof's target hash does not match the change-email binding (e.g., a consent-op proof replayed at this surface); `kind_mismatch` fires when a session-kind proof is submitted to this consent-op-kind consume surface.

---

### GET /api/settings/email/verify/:token

Confirm an email address via a one-time token (from the link sent by `POST /api/settings/email`).

**Auth:** none (unauthenticated — the token itself is the proof).

**Response `data`:** `{ "verified": true }`

Decided 2026-10-08 (lands with the hold task): the response gains `applied`. `{ "verified": true, "applied": true }` means the address is now on the account (the add flow, a change with no hold, and a held change whose hold had ended when the link was opened). `{ "verified": true, "applied": false }` means the new address is confirmed and the change takes effect when its hold ends unless it is cancelled or the password is reset before then; a confirmed link opened again during the hold answers the same, whatever the token's age. The response carries no date; the hold's end is read from the authenticated `GET /api/settings/email`.

**Errors:**
- `INVALID_TOKEN` — token not found or expired
- `DUPLICATE` (409): another account took the address while the change was queued (see `backend-email-change-swap-500s-on-a-taken-address`); the queued change is dropped.

---

### POST /api/settings/email/cancel-change

Decided 2026-10-08, lands with the hold task. Drops the authenticated account's queued email change.

**Auth:** `verifyHiveSignature`.

**Body:** JWT path: `{ "fresh_auth_proof": "<single-use token>" }`, a proof bound to `(change_email, <username>, '')` whose mechanism is registered on the account, as for `POST /api/settings/email`. Keychain path: `{}`; no body proof.

A password-mechanism proof clears a held change only. An ORCID-mechanism proof or the Keychain path clears any queued change.

**Response `data`:** `{ "cancelled": true }`, whether or not a change was queued. No mail is sent.

**Rate limit:** 10 writes per IP per minute (shared with other settings writes).

**Errors:**
- `PENDING_CHANGE` (409): a password-mechanism proof against a queued change that carries no hold. Message: `This email change was queued with a stronger proof and cannot be cancelled with this one.`
- `UNAUTHORIZED` (401): no account row for the authenticated user.
- `FRESH_AUTH_REQUIRED` (401 / 403): as for `POST /api/settings/email`.

---

### POST /api/settings/email/cancel-delete

Decided 2026-10-08, lands with the held-deletion task. Drops the authenticated account's queued deletion.

**Auth:** `verifyHiveSignature`.

**Body:** JWT path: `{ "fresh_auth_proof": "<single-use token>" }`, a proof bound to `(delete_account, <username>, '')` whose mechanism is registered on the account, as for `DELETE /api/settings/email`. Keychain path: `{}`; no body proof.

**Response `data`:** `{ "cancelled": true }`, whether or not a deletion was queued. No mail is sent.

**Rate limit:** 10 writes per IP per minute (shared with other settings writes).

**Errors:**
- `UNAUTHORIZED` (401): no account row for the authenticated user.
- `FRESH_AUTH_REQUIRED` (401 / 403): as for `DELETE /api/settings/email`.

---

### DELETE /api/settings/email

Delete the authenticated account's email and all associated data (notification preferences, pending recovery rows, and the account row itself; custody audit log rows are anonymized in place rather than deleted). This is the de-facto right-to-erasure path: it removes the entire account, not just the email column. For light accounts this removes login access; Keychain self-custody users lose only their email subscription. The on-chain Hive account is untouched, so a light user who still holds their BIP39 seed phrase can re-import it into Keychain and continue as pure self-custody.

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Re-auth:** account erasure is a critical action, so a fresh-auth proof is required on the JWT path. The Keychain (Hive-signature) path is fresh at the middleware and needs no body proof. On the JWT path the body must carry a `fresh_auth_proof` bound to the `delete_account` action (target `(delete_account, <username>, '')`), and the proof's `mechanism` must match a factor registered on the account (state A: `password`; state B: `password` or `orcid`; state C: `orcid`; states D and G: `orcid`, because the password issuer refuses their `'self'` claim). A proof minted for a different action (`change_email` or `set_password`) is rejected as a cross-action replay. Mint via `POST /api/custody/fresh-auth action='delete_account'` (password factor) or `POST /api/orcid/start mode='fresh_auth' action='delete_account'` then `POST /api/orcid/callback` (ORCID factor). See ARCHITECTURE.md § 6.4 row "Delete account data / right-to-erasure" for the per-state contract. Implemented at `settings.ts` DELETE /email.

**Body:** `{ "confirm": true, "fresh_auth_proof": "<single-use token>" }`. The JWT path requires `fresh_auth_proof`; the Keychain path requires only `confirm: true`.

**Held deletion (decided 2026-10-08, lands with the held-deletion task; ARCHITECTURE.md § 6.3).** On the JWT path with a password-mechanism proof on a row that holds an email, nothing is deleted yet: the deletion is queued for 72 hours after the request, a mail with no link tells the current address that a deletion was requested and that resetting the password stops it, and the response is `{ "deleted": false, "effectiveAt": "<ISO date>" }`. The row is deleted once the hold has ended unless the deletion was cancelled at `POST /api/settings/email/cancel-delete`, or dropped by a password reset, a recovery or the custody upgrade. Any other accepted proof, and a row with no email, deletes at once. Shares the 5 per account per hour limit with `POST /api/settings/email`.

**Response `data`:** `{ "deleted": true }`, or `{ "deleted": false, "effectiveAt": "<ISO date>" }` for a held deletion.

**Errors:**
- `VALIDATION_ERROR` (400) when `confirm: true` is not provided.
- `UNAUTHORIZED` (401) when no account row exists for the authenticated user. Returned instead of 404 for the same enumeration-oracle reason documented under POST /api/settings/set-password: a holder of a stale JWT must not be able to distinguish account-deleted from other authed-error states by status code.
- `FRESH_AUTH_REQUIRED` (401) with `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. Same taxonomy as POST /api/settings/email above. `missing` fires when the JWT path body carries no `fresh_auth_proof`; `wrong_mechanism` fires when the proof's mechanism is not registered on the account (for example, an ORCID-mechanism proof against a state-A password-only account).
- `FRESH_AUTH_REQUIRED` (403) with `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. Same taxonomy as POST /api/settings/email above; a `change_email` or `set_password` proof replayed here returns `target_mismatch`.

---

### POST /api/settings/set-password

Opt into password login for an account that currently has `password_hash IS NULL`. This is the path ORCID-only signups and null-password-recovered accounts use to enable email/username + password login without re-running the signup flow.

**Auth:** `verifyHiveSignature` (Bearer JWT or Keychain signature).

**Body:**

```json
{ "password": "NewSecurePass1", "fresh_auth_proof": "<single-use token>" }
```

`fresh_auth_proof` is REQUIRED on all paths. The handler accepts only a row with no password, a linked ORCID and a verified email: state C, and a D or G row of that shape (ARCHITECTURE.md § 6.4 "Set password from null"). A row with a password gets `PASSWORD_ALREADY_SET` 409, a G row whose email is unverified gets `PENDING_UNVERIFIED` 409, and a row with no ORCID gets `ORCID_REQUIRED` 403, checked in that order. Such a row has no password to base a password fresh-auth on, so the proof's `mechanism` MUST be `'orcid'`; `password`-mechanism proofs are structurally invalid here and return `FRESH_AUTH_REQUIRED` 401 with `details.reason: "wrong_mechanism"`. Mint via `POST /api/orcid/start mode='fresh_auth' action='set_password'` (no `root_author`/`root_permlink` body fields needed; the backend synthesizes the target from the authenticated username). The proof binds to `(set_password, <username>, '')`. See ARCHITECTURE.md § 6.4 row "Set password from null" for the per-state contract.

Password must meet the signup policy: at least 10 characters with lowercase, uppercase, and numbers. Validated server-side via the shared `backend/src/lib/password-policy.ts` `isPasswordValid` helper, mirrored by `frontend/src/password-policy.js`.

**Response `data`:** `{ "message": "Password set. You can now log in with your email/username and this password." }`

**Rate limit:** 10 writes per IP per minute (shared with other settings writes).

**Errors:**
- `VALIDATION_ERROR` — password missing, too short, or missing required character classes
- `UNAUTHORIZED` (401) — no account row for the authenticated user (session is no longer valid). Returned instead of 404 because, for an authed endpoint, "your account no longer exists" is functionally equivalent to "your session is invalid" — flipping to 401 closes a small enumeration oracle (a holder of a stale JWT could otherwise distinguish account-deleted from other authed-error states by status code). The same 404→401 treatment applies to `DELETE /api/settings/email`, `POST /api/custody/broadcast`, and `POST /api/custody/upgrade`.
- `ORCID_REQUIRED` (403) — caller has no linked ORCID. The set-password opt-in is deliberately scoped to ORCID-verified accounts: today only ORCID-path signup/recover leaves `password_hash IS NULL`, but the runtime guard makes the invariant explicit so future flows that null the hash for other reasons cannot silently inherit set-password eligibility.
- `PENDING_UNVERIFIED` (409): the row's settings-registered email is not verified yet (a state G row). Checked after `PASSWORD_ALREADY_SET` and before `ORCID_REQUIRED` and the proof consume, so the proof is not spent. Message: `"Verify your email before setting a password."`
- `PASSWORD_ALREADY_SET` (409) — account already has a password. Use the (separate) change-password flow, which must require the current password to authorize the rotation. Rotating a known password via `set-password` is deliberately disallowed because `set-password` authenticates via Keychain or JWT only; allowing it to overwrite an existing hash would let any live JWT silently rotate the password without re-proving the current one.
- `SERVICE_UNAVAILABLE` (503) — argon2 capacity exhausted or backend draining. See [common.md](common.md).
- `FRESH_AUTH_REQUIRED` (401) — `details.reason ∈ {"missing", "expired", "malformed", "wrong_mechanism"}`. Same taxonomy as POST /api/settings/email above. `wrong_mechanism` on this route specifically fires when the proof's mechanism is not `'orcid'` (state C has no password, so a password-mechanism proof is invalid here).
- `FRESH_AUTH_REQUIRED` (403) — `details.reason ∈ {"username_mismatch", "target_mismatch", "kind_mismatch"}`. Same taxonomy as POST /api/settings/email above.

**Why a distinct endpoint from `/api/auth/reset`:** `/api/auth/reset` is token-gated (email reset link) and targets the "I lost my password" path. `POST /api/settings/set-password` is session-gated and targets the "I never had one" path — no email round-trip required, and the account must be in the `password_hash IS NULL` state.
