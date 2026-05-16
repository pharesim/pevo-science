# UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW — replace `password` upgrade body with seed-phrase-derived-pubkey + signed challenge

**Owner:** UI
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-upgrade-seed-phrase-reauth` round-1 @ 1f1be4e — P0 frontend-coordination gap)
**Priority:** P0 (deploy-blocker — backend ships the new `/api/custody/upgrade` body shape on next deploy; current SPA hits 400 VALIDATION_ERROR on every upgrade attempt post-deploy)

## Problem

Backend commit `1f1be4e` replaced the `/api/custody/upgrade` re-auth from password to seed-phrase-derived-pubkey + signed challenge. The SPA at `frontend/src/pages/settings.js:744` still sends `{ password: this.upgradePassword }`. Every State A, B, and C user attempting to upgrade post-deploy receives 400 VALIDATION_ERROR. The gate at `frontend/src/pages/settings.js:656` (`!this.upgradePassword`) also still blocks the upgrade UI on a password field the backend no longer reads.

## Goal

Wire the SPA upgrade flow to derive the upgrade pubkey from the user's BIP39 seed phrase client-side, sign the canonical challenge, and send the new body shape. Remove `upgradePassword` from the upgrade state machine.

## Acceptance

### 1. New body shape

`POST /api/custody/upgrade` body changes from `{ "password": "..." }` to:

```json
{
  "derived_pubkey": "STM<base58>",
  "signed_proof": "<hex signature>",
  "signed_at": "<ISO-8601 timestamp, within 60s of request>"
}
```

See `agents/docs/api-contracts/custody.md` for the full contract.

### 2. Client-side derivation

UI derives the upgrade pubkey from the BIP39 mnemonic (the seed phrase the user wrote down at signup, stored client-side — never sent to the server). Use the same `@hiveio/dhive` `PrivateKey.fromSeed` / equivalent helper the signup flow uses. Acceptable to derive from any of posting/active/owner — the backend accepts any pubkey that appears in the on-chain account's key_auths. Recommend deriving active (it is the strongest single-key authority that doesn't expose owner rotation capacity).

### 3. Canonical challenge format

Challenge string: `${appTag}-custody-upgrade|v1|${username}|${signed_at}`.

- `appTag` matches `config.appTag` on the backend (e.g., `pevotest` in beta).
- `username` comes from the authenticated user's session.
- `signed_at` is an ISO-8601 timestamp generated client-side immediately before signing.

Sign with the seed-derived private key (same one whose pubkey is sent in `derived_pubkey`). Send the signature in hex.

### 4. UX flow

Prompt user to enter or paste the seed phrase. Derive the keypair in-browser. Build challenge → sign → POST. On success the response shape is unchanged (`{ custody: 'self', token, expires_at }`); persist the new JWT and flip the UI to self-custody mode.

The current upgrade UI's password input should be removed; the seed-phrase input replaces it. Validation: at minimum, sanity-check the input parses as a valid 12-word BIP39 mnemonic before attempting derivation.

### 5. 503 retriability fix (also closes finding #9)

Current SPA at `frontend/src/pages/settings.js:809` groups 503 with non-retriable errors (routes to support screen). The new backend 503 means "transient Hive RPC, please retry" — retriable. Update the SPA error-handling to distinguish 503 from terminal errors on this endpoint and offer "Retry" rather than support-contact.

### 6. Error handling

- 400 VALIDATION_ERROR → seed phrase missing/invalid, show inline error.
- 401 UNAUTHORIZED → "Could not verify upgrade proof. Please check the seed phrase you entered." (uniform message; the backend deliberately does not disclose which sub-failure mode fired.)
- 409 ALREADY_UPGRADED → "This account has already been upgraded." Refresh JWT and reload settings.
- 503 SERVICE_UNAVAILABLE → "Could not reach the Hive network to verify your upgrade. Please retry." Offer retry button (NOT support contact).
- 429 (rate limit) → "Too many upgrade attempts. Please wait an hour and try again."

### 7. Tests

E2E test covers: enter seed phrase → derive pubkey → sign challenge → submit → receive new self-custody JWT. Cover the rejection paths (wrong seed phrase → 401, already-upgraded → 409, 503 retriability).

## Out of scope

- Backend changes (already landed in commit `1f1be4e`).
- API contract doc updates (architect lands during the task-5 archive cycle).
- The seed-phrase verification step at signup (verifying the user wrote down the mnemonic).

## Cross-references

- `agents/docs/api-contracts/custody.md` — `/api/custody/upgrade` contract (updated by architect alongside this task's creation).
- `agents/docs/ARCHITECTURE.md` § 6.3 (light → self upgrade), § 6.4 (re-auth contract), § 6.5 invariant #6 (seed phrase is upgrade proof).
- `backend/src/routes/custody.ts` (the new handler) and `backend/tests/routes/custody-upgrade.test.ts` (state coverage + rejection paths) — read these to understand the proof verification path and the canonical challenge format the backend expects.

## Source

`/ce-code-review` on `backend-custody-upgrade-seed-phrase-reauth` (architect session 2026-05-16): api-contract AC-1 P0 conf 100 + AC-3 P1 conf 100. Frontend-coordination gap surfaced during architect triage.
