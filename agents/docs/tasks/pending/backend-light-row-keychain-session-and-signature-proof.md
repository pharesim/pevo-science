# A light row's Keychain session gets the light claim, and a signature is not its re-auth proof

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed at the architect review of `ui-state-d-session-settings-critical-actions`. User decision:
make the backend match ARCHITECTURE.md (option (a) of that triage).

## Why

A light account (ARCHITECTURE.md § 6.1 states A, B and C) can import its seed phrase into
Keychain, since all four Hive keys derive from it. When that user signs in through Keychain:

1. `verifyHiveSignature` sets `req.hiveCustody = 'self'` on the signature path for every signer,
   and `POST /api/auth/session` mints that claim (`req.hiveCustody || 'self'`). The session is
   `'self'` although `custodyClaimFor` derives `'light'` from the row.
2. The re-auth gates take a per-request signature as the fresh proof without reading the row
   (for example `consumeFreshAuthProof` returns ok whenever `hiveAuthMethod !== 'jwt'`, and the
   `isJwtPath` branches in `routes/settings.ts`). A posting-key signature therefore passes
   change-email, delete-account and the accreditation metadata edit for a light row.

§ 6.4 lists only a password or ORCID proof for A, B and C on change-email and delete-account,
and § 6.5 invariant #6 says critical actions other than upgrade do not accept a
seed-phrase-derived key as proof. A light account's posting key is one. The SPA now signs a
`'self'` session's settings critical actions, so this path is in use, not only reachable by a
hand-built request.

## Scope

1. `POST /api/auth/session` mints the claim `custodyClaimFor` derives from the caller's row when
   a row exists, and `'self'` when none does, on both of its auth paths.
2. List every gate that accepts a per-request signature as the fresh-auth proof for a § 6.4
   critical action, and make each refuse that path for a row whose derived claim is `'light'`.
   Put the list in your signal. Ask before changing a gate where the refusal would break a flow
   § 6.4 documents.
3. A light row may still hold a `'self'` session minted before this change. Say in your signal
   what such a session sees once the gates refuse, and whether signing in again clears it.
4. Tests: the session mint per case (light row, D row, G row, no row), and each listed gate
   refusing a signature-only request from a light row while D, G and no-row callers are unchanged.

The SPA's Keychain connect stores the `custody` this route returns (`frontend/src/auth.js`), so
no UI change is expected; say so in the signal if you find otherwise.

## Docs

ARCHITECTURE.md § 6.2 (State G: "`POST /api/auth/session` re-mints whatever claim it is shown";
No-row case: "mints a `'self'`-claim JWT for any Keychain-signed caller, row or not") and the
`POST /api/auth/session` section of `api-contracts/auth.md` describe the current mint. The
architect updates them at review.

## Acceptance criteria

1. A Keychain sign-in on a light row yields a `'light'` session; D, G and no-row sign-ins are
   unchanged.
2. Every listed gate refuses a signature-only request from a light row and is unchanged for the
   others, each pinned by a test.
3. Backend suite green apart from the standing pre-existing failures.
