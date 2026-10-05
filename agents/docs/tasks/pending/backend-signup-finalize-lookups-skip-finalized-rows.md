# Signup finalize lookups reach finalized rows that carry a `confirmed:` token

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Surfaced by the state G review of d33792ce. The user asked for it as its own task.

## Why

Before d33792ce, `POST /api/auth/verify` looked a row up by `verify_token` alone. A state G
row (ARCHITECTURE.md § 6.1) carries a random hex `verify_token` while its settings-registered
email is unverified, so its settings token presented to `/verify` matched. The handler then
wrote a `confirmed:` token and a `signup_binding_hash` onto the row and handed the presenter the
`auth_token` and the binding cookie. d33792ce scopes `/verify` to `username IS NULL` and
excludes `confirmed:` tokens, so no new row of this shape is written. Rows written before it
are not repaired, and no state in § 6.1 has a username together with a `confirmed:` token.

Three signup-ceremony lookups in `routes/signup-verify.ts` still reach such a row:

- `POST /api/auth/confirm` and `POST /api/auth/link` look the row up with
  `FROM accounts WHERE verify_token = $1` on the presented `auth_token`, then check the binding
  cookie. Whoever holds the cookie from that old `/verify` passes the check. The finalize
  UPDATE then sets `username` and `custody` on the row, replacing the G account's username.
- `POST /api/auth/resume-signup` looks the row up by email and requires a `confirmed:` token.
  A caller with the row's password rebinds the signup session to their browser.

Whether any such row exists is unknown. Measure before writing a repair.

## Scope

1. Measure. Run `SELECT count(*) FROM accounts WHERE username IS NOT NULL AND verify_token LIKE
   'confirmed:%'` against the dev database, and put the query in the signal block so the user
   can run it on production. Report the count. Do not run any write against production data.
2. Scope the three lookups to signup rows: add `AND username IS NULL` to the `/confirm` and
   `/link` token lookups and to the `/resume-signup` email lookup. A finalized row then gets the
   answer an unknown token gets (`/confirm`, `/link`) or the non-resumable answer
   (`/resume-signup`), with the same status, body and timing class.
3. Leave the stuck-resume path in `/confirm` and `/link` (the `verify_token` NULL lookup gated
   on a posting-key proof) as it is.
4. Write no repair of existing rows. If the dev or production count is not zero, say so in the
   signal block with each row's shape (which of `password_hash`, `orcid`, `custody`,
   `upgraded_at` are set). The architect decides the repair.

## Acceptance criteria

1. A route spec per lookup seeds a row with `username` set and a `confirmed:` token, presents
   the matching `auth_token` (with its binding cookie for `/confirm` and `/link`, or the right
   password for `/resume-signup`), and gets the unknown-token or non-resumable answer. The row
   is left unchanged. Each spec fails before the change.
2. The existing signup ceremony specs stay green.
3. No new error code and no new writer of `accounts.updated_at`.
