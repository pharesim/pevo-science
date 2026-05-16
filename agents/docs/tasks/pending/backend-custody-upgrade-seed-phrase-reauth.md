# BACKEND-CUSTODY-UPGRADE-SEED-PHRASE-REAUTH — Replace password re-auth on `/custody/upgrade` with seed-phrase-derived-key proof

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6)
**Priority:** P1

## Problem

`POST /api/custody/upgrade` (`backend/src/routes/custody.ts:746`) currently requires `password` in the request body and validates via `argon2.verify` against `account.password_hash`. This blocks state C accounts (passwordless ORCID-only — see `agents/docs/ARCHITECTURE.md` § 6.1) from upgrading at all, because they have no password registered.

More fundamentally, **password is the wrong re-auth factor for this operation**. Upgrade transfers key control from server-encrypted to user-managed (Keychain). The proof should be "I already control the keys client-side" — which the user must control post-upgrade anyway. Password is unrelated to that capability.

Per `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract), upgrade's required re-auth is the **seed-phrase-derived pubkey**. UI derives a key client-side from the BIP39 mnemonic (generated at signup, never sent to the server); backend verifies the derived pubkey matches the on-chain account's posting/active key via `getAccounts` (Hive API). All light states (A, B, C) have a seed phrase from signup and are eligible to upgrade with this proof.

## Goal

Replace the `password`-based re-auth on `/api/custody/upgrade` with a seed-phrase-derived-pubkey proof. State C users become eligible to upgrade (closing the gap surfaced during the brainstorm); state A and B users use the same upgrade path with the same proof shape.

## Approach

Request-body shape change: `{ derived_pubkey: <string>, signed_proof?: <string> }`. The simplest correct verification is:

1. UI derives the active (or owner) pubkey from the BIP39 seed phrase client-side and sends it.
2. Backend fetches the on-chain account's posting/active key set via `getAccounts(username)`.
3. Backend compares the supplied `derived_pubkey` against the on-chain key set.

If a simple pubkey match is judged insufficient (an attacker who knows the pubkey but not the seed could submit one), require a signed proof (sign a server-issued challenge with the derived key) — same shape as the `verifyHiveSignature` middleware's challenge-signature path. Architect's call at implementation time: the simpler pubkey-match is likely sufficient because the pubkey itself is on-chain (public), but a server-issued challenge add adds a freshness guarantee. Pick whichever matches the existing fresh-auth primitives' rigor; document the choice in the implementer signal block.

The encrypted-keys-wipe + `custody='self'` + `upgraded_at=NOW()` writes stay the same. Only the re-auth check changes.

## Acceptance

1. `POST /api/custody/upgrade` accepts requests with seed-phrase-derived-pubkey proof; rejects requests missing or carrying invalid proof.
2. State A, B, and C accounts can all upgrade successfully (state C is the new case; A and B continue to work).
3. State D account returns 409 `ALREADY_UPGRADED` as today.
4. Pure self-custody (no-row) users return 403 / not-applicable as today.
5. The proof verification path uses `getAccounts` from `backend/src/hive.ts` and does not introduce new HAF dependencies.
6. Real-path integration test in `backend/tests/routes/custody-upgrade.test.ts` (or sibling) exercises happy paths for A, B, C; rejection paths for missing proof / wrong pubkey / wrong username.
7. Existing password-based upgrade tests are migrated to the new proof shape; any test seeding `custody='light' + password_hash=NULL` to drive the null-hash branch becomes obsolete and is deleted.

## Out of scope

- UI work for the seed-phrase entry + client-side derivation flow. UI agent picks up in a separate task after this lands.
- Re-auth model for `/custody/broadcast` (separate task: `backend-custody-broadcast-orcid-fresh-auth.md`).
- Anything related to `password_hash`'s lifecycle on the account row post-upgrade — § 6.2 documents that it's preserved; no change.

## References

- `agents/docs/ARCHITECTURE.md` § 6.3 (Light → self upgrade transition)
- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #6 (seed phrase is the upgrade proof)
- `backend/src/routes/custody.ts:746` (current handler — needs replacement)
- `backend/src/hive.ts` (getAccounts wrapper for pubkey lookup)
- `backend/src/middleware/verifyHiveSignature.ts` (existing signature-challenge primitive, if the signed-proof variant is chosen)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
