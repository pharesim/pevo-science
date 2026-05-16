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

---

Backend implementer signal (2026-05-16, worktree):

**Proof variant chosen: pubkey-match + signed-challenge (mandatory).** Body shape lands as `{ derived_pubkey: string, signed_proof: string, signed_at: string }`. Rationale:

- Pubkey-match-alone is a public-knowledge check (the rotated pubkey is on-chain and world-readable post-`account_update`). An attacker who knows only the new pubkey could replay; the freshness gate the architect flagged is the closure.
- Existing fresh-auth primitive rigor is **signature recovery against an on-chain pubkey** (`verifyHiveSignature.ts:160-176` — `Signature.fromString().recover()` + `crypto.timingSafeEqual` against `account.posting.key_auths`). Matching that rigor here means: client signs a canonical challenge with the derived private key; backend recovers the pubkey and compares timing-safe to both the declared `derived_pubkey` AND the on-chain key set.
- Canonical challenge: `${appTag}-custody-upgrade|v1|${username}|${signed_at}`. The middleware's 60s freshness window is reused on `signed_at`. Chain key set is posting + active + owner key_auths — any one match suffices, because the UI rotates all three in `account_update` and we don't want to lock the proof to a specific authority slot.
- All four checks (timestamp window, signature recover-and-match-to-`derived_pubkey`, chain-key set membership, no on-chain account) collapse to **401 UNAUTHORIZED** with a uniform generic message so the route never becomes a chain-state / signature-validity oracle. Operator logs carry structured-warn events with discriminators: `custody.upgrade.proof_malformed`, `custody.upgrade.pubkey_binding_mismatch`, `custody.upgrade.chain_key_mismatch`, `custody.upgrade.hive_account_missing`. Hive read failure surfaces as **503 SERVICE_UNAVAILABLE** so the SPA can retry.

**State coverage** (real-path integration tests in `backend/tests/routes/custody-upgrade.test.ts`, 13 cases all green against real Postgres + real Redis + real crypto, with `hiveClient.database.getAccounts` mocked to return a deterministic key set per test):

- State A (light + password + no ORCID): valid proof → 200, row's `posting_key_enc`/`iv_posting`/`memo_key_enc`/`iv_memo` all NULL post-call, `upgraded_at` populated.
- State B (light + password + ORCID): valid proof → 200, `upgraded_at` populated.
- State C (passwordless ORCID-only — the new case): valid proof → 200, `upgraded_at` populated, `password_hash` preserved as NULL per § 6.2.
- State D (already upgraded): 409 `ALREADY_UPGRADED`.
- Rejection paths: missing `derived_pubkey` → 400; missing `signed_proof` → 400; missing `signed_at` → 400; expired `signed_at` → 401; malformed `signed_proof` → 401; pubkey binding mismatch (signature recovers a different key than declared) → 401; `derived_pubkey` not in chain key set → 401; chain `getAccounts` returns empty → 401; self-custody JWT → 403 (gate fires before proof verification, `getAccounts` never called).

**Obsoleted tests deleted:**
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` — the null-hash branch is gone (the `password_hash` SELECT itself is gone; the route now SELECTs only `upgraded_at`).
- `backend/tests/routes/custody-upgrade-argon-error-translation.test.ts` — argon2 is no longer in the upgrade path.
- `custody.upgrade.null_hash_unreachable` log-shape test inside `custody.test.ts` — same branch deletion. The sibling `custody.upgrade.failed` outer-catch test was kept but rewritten to throw on the new SELECT shape (`upgraded_at` instead of `password_hash`) and send the new body shape.

**Verification run on this worktree:**
- `npm run lint` clean (2 pre-existing warnings in `seed-phrase.ts`, neither in changed files).
- `npm run typecheck` clean.
- `npx vitest run tests/routes/custody-upgrade.test.ts` → 13/13 green.
- `npx vitest run tests/routes/custody.test.ts` → 13/13 green.
- `npx vitest run tests/routes/custody-{fresh-auth-null-hash,consent-ops,non-consent-fresh-auth,idempotency}.test.ts` → 41/41 green (sanity check that sibling custody tests still pass).

**[TODO Architect] — Contract update for `agents/docs/api-contracts/custody.md`:** the `POST /api/custody/upgrade` section currently documents `{ "password": "SecurePass123" }` body shape. New body shape is:

```json
{
  "derived_pubkey": "STM<base58>",
  "signed_proof": "<hex hive signature>",
  "signed_at": "<ISO-8601 timestamp, within 60s of request>"
}
```

Errors section also needs updating: `UNAUTHORIZED` covers the new failure modes (missing/expired timestamp, malformed signature, pubkey binding mismatch, derived_pubkey not in chain key set, no on-chain account); `VALIDATION_ERROR` now covers missing `derived_pubkey`/`signed_proof`/`signed_at` instead of missing `password`; `SERVICE_UNAVAILABLE` (503) is added as a new error for Hive API unavailability during chain-key lookup. The `argon2`/password references should be removed.

Files landed (commit SHA in re-review intake):
- `backend/src/routes/custody.ts` — handler replaced (lines ~787 onward in the new layout).
- `backend/tests/routes/custody-upgrade.test.ts` — new real-path integration test (13 cases).
- `backend/tests/routes/custody.test.ts` — null-hash log-shape test removed, outer-catch test rewritten for the new SELECT/body shape, doc comment in (c) updated.
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` — DELETED (branch gone).
- `backend/tests/routes/custody-upgrade-argon-error-translation.test.ts` — DELETED (argon2 not in path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
