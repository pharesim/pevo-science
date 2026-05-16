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

---

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1f1be4e` (round-1 implementation). Account-state defense review (project CLAUDE.md): `(custody, upgraded_at)` combinations defended match § 6.1 enumerated states (A/B/C → success path; D → 409; self-custody → 403). § 6.4 contract holds (seed-phrase-derived pubkey verified via signature recovery AND chain-key-set membership). § 6.5 invariant #6 honored (seed phrase is upgrade proof; not session-auth factor). Uniform 401 + structured-warn event slugs avoid the oracle surface. Real `verifyHiveSignature` middleware used in the new 13-case integration suite.

Six items surface — four P2, two P3. The P0 frontend-coordination gap (SPA still sends `{ password }` on `/upgrade`) is filed separately as `ui-custody-upgrade-seed-phrase-derive-flow` and does NOT block this backend task's archive.

### Items to address

**1. (P2, conf 90, testing + adversarial) No test for `getAccounts` throws → 503 SERVICE_UNAVAILABLE path.** `backend/tests/routes/custody-upgrade.test.ts` — the existing suite covers `getAccounts` returning empty (→ 401 hive_account_missing) and `getAccounts` returning a mismatched key set (→ 401 chain_key_mismatch), but the throw path (`getAccountsMock.mockRejectedValueOnce(new Error('rpc unreachable'))`) is not exercised. Hive RPC failures are routine in production; the 503 branch is reachable. Add a 14th case: state A row + valid proof body + `getAccountsMock.mockRejectedValueOnce(...)` → expect 503 SERVICE_UNAVAILABLE.

**2. (P2, conf 75, adversarial) Cascade: Hive RPC transient 503 + 1/hr upgradeLimiter already consumed = legitimate user locked out for 59 minutes despite the "Please retry" instruction.** `backend/src/routes/custody.ts:42` (limiter registration order) + `:963-966` (503 UX message). A single transient Hive RPC failure burns the `upgradeLimiter` slot; user follows the "Please retry" message; second request hits 429. Fix options: (a) move the limiter to consume-on-success only (DELETE the consume on error paths via the limiter middleware's `skipFailedRequests` option or equivalent); (b) reset the limiter on 503 specifically; (c) raise the limiter to 3/hour. Architect recommendation: (a). The 1/hr limit existed when the operation was idempotent and one-shot; under the new shape it still IS one-shot on success, but 503-then-retry should not count.

**3. (P2, conf 80, adversarial) Symmetric 60s window accepts future-dated `signed_at`, doubling the captured-proof replay race window from 60s to 120s.** `backend/src/routes/custody.ts:862` — `Math.abs(Date.now() - tsMs) > 60_000`. The symmetric form accepts `signed_at = now + 60s` (valid for the next 120s). Tighten to one-sided: `tsMs > Date.now() || Date.now() - tsMs > 60_000`. Future timestamps reject (clock-skew tolerance is not load-bearing for an upgrade proof; the user signs in the same second they submit).

**4. (P2, conf 75, kieran-typescript) `timingSafePubkeyEqual` utf-8 Buffer encoding is correct but the fixed-length invariant is load-bearing and undocumented.** `backend/src/routes/custody.ts:824-827` — `Buffer.from(str)` defaults to utf-8. Hive pubkeys are STM-prefixed base58check, always 53 ASCII chars = 53 utf-8 bytes, so byte-equality is character-equality and the length guard on line 827 never short-circuits a mismatch. The implicit fixed-length invariant is load-bearing: if a future refactor accepts non-STM keys (e.g., uncompressed/compressed format swap), the utf-8 byte path silently breaks. Fix: one-line comment above the helper noting that both inputs are expected to be fixed-length STM-prefixed base58check strings (53 chars), so utf-8 bytes correctly represent the full key. Pure documentation; no behavior change.

**5. (P3, conf 85, adversarial) Stolen-JWT attacker can lock the legitimate user out of `/upgrade` for 1 hour via a single 400-VALIDATION_ERROR request.** `backend/src/routes/custody.ts:42` — the limiter runs BEFORE body validation. An attacker with a stolen JWT sends an empty body (or any malformed shape) → limiter consumes the 1/hr slot → user's legitimate upgrade attempt that same hour hits 429. Asymmetric (1 attacker request = 1 hour of user DoS) and repeatable indefinitely until the JWT expires. Same root cause as item 2 (limiter-before-validation). Fix: validate the body shape first, then consume the limiter only on broadcast-attempted requests; OR scope the limiter to the success-path increment only.

**6. (P3, conf 80, testing) `rows.length === 0` path (401) untested.** `backend/tests/routes/custody-upgrade.test.ts` — the new SELECT narrows to just `upgraded_at` (previous SELECT included `password_hash`). If `rows.length === 0` (no DB row for the username), the handler returns 401 "Session is no longer valid". A mutation dropping that guard would TypeError on `rows[0]` and the outer catch returns 500 — silent shift from 401 to 500. Add a test: state with no row for the JWT subject's username → expect 401.

### Items dismissed during architect triage

- **(P3, conf 75, reliability) 30s worst-case Hive RPC hang (3 nodes × 10s sequential failover).** One-shot ceremony, single-instance, tolerable UX. Documented residual; if SLA tightening is desired later, wrap `getAccounts` in `Promise.race` with a 12s AbortController. Not blocking.
- Past-solutions surfaced precedents for: routing the proof through `verifyHiveSignature` middleware, applying a Redis advisory lock around the read-verify-write sequence, equalizing the 409/401 timing oracle. All evaluated; current design choices (custom challenge format due to non-HTTP shape, single-shot state-D gate makes lock redundant, status code already discloses state) are defensible. Surfaced as documented design notes, not blocking findings.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit.

**Frontend-coordination follow-up**: `ui-custody-upgrade-seed-phrase-derive-flow.md` (filed in `tasks/pending/`) implements the SPA side of the wire-shape change. This backend task is INDEPENDENT of the UI task's completion — backend can archive once items 1-6 land regardless of UI progress, though the deploy of the combined contract change requires both.

---

## Backend re-review signal (2026-05-16, round-2 fix commit)

Round-1 hold items 1-6 landed.

- Item 1 (P2) — added 503-path test (`getAccountsMock.mockRejectedValueOnce` → expect 503 SERVICE_UNAVAILABLE) at `backend/tests/routes/custody-upgrade.test.ts:478`.
- Item 2 (P2) — limiter consume-on-success-only via new `skipFailedRequests` option on the `rateLimit` primitive (`backend/src/middleware/rateLimit.ts`); upgrade limiter opts in at `backend/src/routes/custody.ts:49`. Rationale: option (a) per architect recommendation; cleanest fit for the existing primitive — defers `INCR`/`memStore.push` to `res.on('finish')` and only consumes when `res.statusCode < 400`. Backward-compatible (default `false`); no behavior change for the other 19 callsites.
- Item 3 (P2) — tightened `signed_at` window to past-only at `backend/src/routes/custody.ts:884-888` (`!Number.isFinite(tsMs) || tsMs > Date.now() || Date.now() - tsMs > UPGRADE_PROOF_TIMESTAMP_WINDOW_MS`). Future timestamps now reject deterministically; replay race window stays bounded at 60s rather than the 120s the symmetric form permitted. Doc comment at `:803-810` updated to match.
- Item 4 (P2) — documented STM-prefixed fixed-length invariant on `timingSafePubkeyEqual` at `backend/src/routes/custody.ts:836-842`. Pure documentation; no behavior change.
- Item 5 (P3) — automatically fixed by item 2's consume-on-success-only path: a stolen-JWT attacker's 400 VALIDATION_ERROR responses (status >= 400) no longer consume the limiter slot, so the legitimate user retains their 1/hr allowance. No additional validation-before-limiter move required.
- Item 6 (P3) — added `rows.length === 0` 401 canary test at `backend/tests/routes/custody-upgrade.test.ts:498`. A mutation dropping the guard would TypeError on `rows[0]` → outer catch → 500; this test pins the 401 path so the silent 401-to-500 shift fails CI.

`npm run lint` and `npx tsc --noEmit` not run in worktree (no local `node_modules` — backend deps live in the parent checkout only); parent will verify after cherry-pick. Vitest not run in worktree (parent serializes).
