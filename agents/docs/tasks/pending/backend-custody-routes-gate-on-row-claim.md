# Custody routes trust a token's light claim for a row that was never light

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced by the architect re-review of the state-G account-state comments task and approved
for filing by the user on 2026-10-05.

## Why

The four custody routes that act on a light claim (`POST /api/custody/broadcast`,
`/fresh-auth`, `/session-auth`, `/upgrade`) gate on `req.hiveCustody === 'light'`.
`verifyHiveSignature` takes that value from the presented JWT. From the row, each route reads
`upgraded_at` (plus `password_hash` on the two proof routes, and the encrypted posting key on
`/broadcast`) and refuses a row with an epoch. That refuses every upgraded row. It does not
refuse a row that was never light. A state G row (ARCHITECTURE.md § 6.1) has `custody` NULL and
no `upgraded_at`, so only the token's claim stands between it and these routes.

A `'light'` JWT can reach a G row:

1. A light account (A, B or C) is deleted through `DELETE /api/settings/email`. Deleting the row
   deletes its `sessions_invalidated_at` with it, so `verifyHiveSignature` has no epoch to
   revoke the account's JWTs against.
2. `POST /api/auth/session` re-mints whatever claim the presented token carries, with a new
   `iat` and a full expiry, so the token can be kept alive.
3. The same username registers an email through the settings add flow (Keychain signature
   path). The INSERT stamps no `sessions_invalidated_at`, so the old token is still live.
4. Once the G row's email is verified and it has a password (ORCID linked, then
   `POST /api/settings/set-password`), the light JWT plus that password mints a consent-kind
   proof at `/fresh-auth` (for example `change_email` or `delete_account`, which the settings
   mechanism check accepts because it reads only `password_hash` and `orcid`) or opens a
   session window at `/session-auth`.
5. `/upgrade` needs no password. The light JWT plus a signature from a key in the account's
   on-chain key set moves the G row to `custody = 'self'` with `upgraded_at` set: the UPDATE
   is `WHERE username = $1` with no state predicate. § 6.3 lists no G → D transition. If the G
   row's email is still unverified, the result carries a hex `verify_token` and an epoch, a
   combination § 6.1 does not enumerate (§ 6.5 invariant #4).

Nothing is escalated today. Step 4 needs the G row's password, step 5 needs the owner's key,
and `/broadcast` fails for a G row because it holds no encrypted posting key. The defect is
that the routes rest their authority on a claim the row no longer backs, and the code's own
descriptions state a rule the code does not implement:

- `routes/settings.ts`, both fresh-auth factor tables (the POST /email and DELETE /email
  headers), the State G line: "'orcid' when linked (the password issuer refuses its non-light
  claim)". This wording came from an architect hold, not from an implementer miss. It becomes
  true once the issuer refuses the row.
- `lib/custody-claim.ts`, the `custodyClaimFor` docblock: "Every route that ACTS on a light
  claim re-reads `upgraded_at` itself and refuses a row that carries one", and the closing
  paragraph's "each of those re-reads the epoch and refuses the row the copy names". Both hold
  for an upgraded row and say nothing true about a G row, which has no epoch to re-read.
- ARCHITECTURE.md § 6.2 (State G) and § 6.4 (the password fresh-auth row and the upgrade row)
  now record this divergence and the intended gate.

## Scope

1. In each of the four routes, refuse the row unless `custodyClaimFor(row) === 'light'`: add
   `custody` to the row SELECT the route already makes and call the helper on that row. Keep
   the token-claim check where it is (it answers a `'self'` token without a row read), and keep
   each route's existing `upgraded_at` branch and its response unchanged, so a D row answers
   exactly as it does today. The new refusal sits after the `upgraded_at` branch and answers
   with the response the route already gives a non-light token claim: no new status, code or
   message, and no write.
2. Re-read the settings.ts State G line in both tables against the new gate, and correct the
   `custodyClaimFor` docblock so it states the rule the routes now apply (the row's derived
   claim, with the epoch branch answering first). Sweep `backend/src` and `backend/tests` for
   other comments that say these routes refuse by `upgraded_at` alone or that a G row's JWTs
   cannot carry a light claim, and report what the sweep found.
3. Tests: for each of the four routes, a G row (username set, `custody` NULL, no
   `upgraded_at`) presented with a `'light'`-claim JWT is refused with the non-light response,
   and the row is unchanged afterwards (for `/upgrade`, `custody` and `upgraded_at` still
   NULL). The existing light-row and upgraded-row cases must keep passing unchanged.

## Acceptance criteria

1. A G row presented with a `'light'` JWT gets the route's non-light refusal from
   `/broadcast`, `/fresh-auth`, `/session-auth` and `/upgrade`: no proof, no session window, no
   broadcast, no row write.
2. A/B/C rows with a light JWT and D rows behave exactly as before (same statuses, codes and
   messages).
3. Every comment that describes these gates is true against the new code, including the
   settings.ts State G line and the `custodyClaimFor` docblock.
4. Comment-anchor conventions hold (root CLAUDE.md "Comment anchors").
