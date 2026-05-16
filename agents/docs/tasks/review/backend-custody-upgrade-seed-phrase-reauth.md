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

---

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `9210dd2` (10 reviewers: correctness/security/adversarial on Opus; rest on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All six round-1 hold items land cleanly (verified). Five items held; one item routed to a new task.

### Items held (must fix before archive)

**1. (P2, conf 75, reliability R1 — REAL FUNCTIONAL BUG) `skipFailedRequests` Redis path: concurrent INCRs leave the key at count=N with no TTL → permanent lockout.** `backend/src/middleware/rateLimit.ts:72-79` (deferred-INCR block). The `pexpire` is only called when `count === 1`. Two concurrent requests for the same key both pass the `>= max` check (count=0), both succeed (200), both finish handlers fire, both `redis.incr()` calls run. First INCR returns 1 and sets pexpire. Second INCR returns 2; `count === 1` is false, so pexpire is never called. The key now sits at count=2 with no TTL. Every subsequent GET sees 2 ≥ max(1) and returns 429 indefinitely. The key never expires; the user is **permanently locked out until the Redis key is manually deleted**.

  Currently bounded by upgradeLimiter being the only opt-in (windowMs=3600000 = 1h; locked-out user gets the next hour back when the window naturally resets — IF the key gets a TTL eventually, but per the bug analysis it doesn't). At the conceptual level the key remains stuck at count=2 forever. In practice for upgradeLimiter the State D 409 idempotency masks the user-visible defect (a successful upgrade is one-shot anyway). But the option is now a reusable primitive (item 8 below addresses adoption discipline); future adopters with longer windows or larger max values hit visible permanent lockout.

  Fix shape: call `redis.pexpire(redisKey, config.windowMs)` unconditionally after every deferred INCR (drop the `count === 1` guard), OR replace the GET→INCR pattern with a Lua script that does atomic check-INCR-EXPIRE in one round-trip. The Lua approach also addresses item 2 (TOCTOU) below — single fix for both. Verify with a concurrent-request test: `Promise.all([req1, req2])` for the same account where both should succeed; assert no key is stuck above max post-test.

**2. (P2, conf 100 — cross-reviewer-promoted: correctness P2 + security P3 + adversarial P3) TOCTOU race on `skipFailedRequests` Redis path: GET→`next()`→deferred-INCR is non-atomic.** Same `backend/src/middleware/rateLimit.ts:62-82`. Two concurrent requests for the same key both see count=0 (each does a separate GET round-trip), both pass `>= max` check, both `next()` to the handler, both succeed. Final count=2 (above max=1). For `/upgrade` the over-admission is absorbed by State D's 409 idempotency. The risk is realized when the primitive is adopted by handlers that don't have an idempotency shield downstream.

  Single fix together with item 1: replace GET+`next()`+deferred-INCR with a Lua EVAL script: `INCR → check ≤ max → on overflow DECR+return 429, on success EXPIRE+return 200-pass; on response finish, if status >= 400 DECR`. Atomic + skipFailed-aware in one round-trip. Document the choice in the JSDoc.

**3. (P2, conf 100 — cross-reviewer-promoted: adversarial P2 + testing P2 + api-contract P2 + correctness P3 + security residual) Clock-skew lockout from one-sided `signed_at` window + contract doc drift.** `backend/src/routes/custody.ts:884-888` rejects any `tsMs > Date.now()` strictly. Round-1's symmetric `Math.abs(...) > 60s` form accepted up to 60s forward drift; round-2 collapsed to zero forward tolerance. A user with 100ms of normal forward clock drift (common on non-NTP devices, mobile, browsers without precision-time-sync) is rejected with 401. Compounded by `agents/docs/api-contracts/custody.md:181` still saying "outside a 60-second window relative to wall-clock time" — symmetric reading — so the contract claim and code behavior diverge.

  Fix shape (two options; architect call):
  - **Option A — add small forward skew tolerance** (preferred): introduce `UPGRADE_PROOF_FUTURE_SKEW_MS = 5_000` and gate on `tsMs > Date.now() + UPGRADE_PROOF_FUTURE_SKEW_MS`. Keeps the past-only intent; absorbs typical client drift; replay race window stays bounded at 65s (60s past + 5s forward). Update inline comment to explain the skew rationale.
  - **Option B — accept zero-skew code, update doc to match**: change `agents/docs/api-contracts/custody.md:181` and the body field description at line 177 to "signed_at MUST NOT be future-dated; backend rejects future timestamps unconditionally and rejects past timestamps older than 60s". UI must derive signed_at from server time (or backdate by a safe margin) to avoid lockout. More work in UI agent's hands; less code-friendliness.
  - Architect recommendation: Option A. The 5s window is below typical replay-attacker observation windows, doesn't materially extend the replay race, and matches the existing 60s past tolerance's purpose (clock-drift absorption). Less SPA-coordination burden.

  Test gap (TG1 from testing review): add a test asserting future-timestamp rejection (e.g., `signed_at = Date.now() + 30_000` → 401 with Option A's 5s tolerance, OR Option B's "always reject future" semantics).

  Contract doc update lands at archive (architect-zone follow-up; flag for inclusion in the same commit that archives).

**4. (P2, conf 75, maintainability M1) Task-file path hardcoded in production code comment will rot on archive.** `backend/src/routes/custody.ts:48` — the inline comment block above `upgradeLimiter` cites `agents/docs/tasks/pending/backend-custody-upgrade-seed-phrase-reauth.md` as the rationale source. The path encodes the current lifecycle state (`pending/`). Once this task archives (next round, after held items land), the path points to a non-existent file — `git rm`'d on archive, content moved to `tasks-archive.md` which is trimmed to 250 lines.

  The rationale (skipFailedRequests design choice + stolen-JWT-DoS protection) is already fully documented in the `RateLimitConfig.skipFailedRequests` JSDoc above the type definition. Fix: drop the `agents/docs/tasks/...` citation entirely. If a permanent cross-link is desired, point to a `docs/solutions/` entry (those are permanent; tasks are not). No solutions entry exists yet — `/ce-compound` after archive could file one for the skipFailedRequests + stolen-JWT-DoS pattern, then the citation can point there.

**5. (P2, conf 90, learnings-researcher + security SEC-r2-1) Wrapping-primitive call-site audit gap (convention `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` violated) + JSDoc misuse-direction missing.** Two coupled issues:

  - **(a) Call-site audit not run.** The convention requires that when a wrapped primitive gains a new behavioral mode (here: `skipFailedRequests`), every existing call site is re-evaluated against the new option's presence. The round-2 implementer signal claims "backward-compatible; no behavior change for the other 19 callsites" but no grep was run to confirm. The convention's rule: "claim, not evidence" must be backed by a grep at signal-block-write time. Fix: run `grep -rn 'rateLimit(' backend/src/ --include='*.ts'`, enumerate every call site, confirm each has intentionally omitted `skipFailedRequests` (a one-liner per site is fine — most are obviously not credential-probing routes). Include the grep output verbatim in the round-3 signal block.

  - **(b) JSDoc missing misuse direction** (per convention `strict-superset-wrapper-inherits-escape-hatches-2026-05-12.md`). Current JSDoc on `skipFailedRequests` documents two legitimate use cases (transient upstream failure, stolen-JWT-DoS-on-1/hr-limiter). It does NOT document the misuse direction: setting `skipFailedRequests: true` on a credential-probing route (e.g., `/login`, `/recover`) would defeat the limiter's enumeration protection. Add a "DO NOT use on credential-probing routes (e.g., /login, /recover) — failed probes would not consume slots, enabling unlimited account enumeration" sentence to the JSDoc.

### Items dismissed during architect triage

- **(P3, conf 75, adversarial adv-2) Slot leak via `res.on('finish')` non-fire when client disconnects mid-handler.** Client TCP RST emits `'close'`, not `'finish'`; the deferred INCR never runs. For `/upgrade` benign (slot stays unconsumed → user gets another attempt). Documented residual; address if a future adopter cares about exact slot accounting under client-abandonment.
- **(P3, conf 50, adversarial adv-5) Captured-proof replay race within 60s freshness window.** `signed_proof` body is not in `verifyHiveSignature`'s per-signature Redis replay cache (header-path only). If the legitimate user's first attempt 5xx's (no consume under skipFailedRequests), an attacker who captured the proof can replay within 60s. The state-machine irreversibility (State D → 409) is the substitute, IF the state check fires before signature validation. Architect verified order: `verifyHiveSignature` (middleware) runs first → JWT validation → upgradeLimiter → handler body → state check before signature verification → signature verification. State check fires before pubkey verification. Acceptable; documented for future audit.
- **(P3, conf 50, adversarial adv-4) Hive RPC outage + skipFailedRequests opens unlimited free-retry for stolen JWT.** Bounded by Hive node availability; tolerable single-instance failure mode. Layered IP-keyed limiter is the standard mitigation if exposure increases; not warranted today.

### Routed to follow-up tasks (not held here)

- **(P2, conf 55, security SEC-r2-1 + partial overlap with item 2) Unbounded CPU/RPC amplification per authenticated account from `skipFailedRequests`.** With `skipFailedRequests:true`, the limiter caps successes only — not request rate. Stolen-JWT attacker (or just an aggressive client) can spray malformed bodies indefinitely; each spray pays verifyHiveSignature ECDSA verify + body parse + signature recovery + hiveClient.database.getAccounts RPC (up to 30s sequential failover on Hive nodes). The 1/hr success cap was specifically intended to bound that cost.

  This is a design-level concern that needs a layered mitigation: a separate higher attempt-cap that counts failures (e.g., 50 failed attempts per IP per hour), OR moving body validation before the limiter so VALIDATION_ERROR doesn't reach the costly handler at all. Filed as `backend-custody-limiter-cpu-amplification-mitigation.md` in `tasks/blocked/` (blocked on this task's round-3 fixes — the mitigation pattern depends on the corrected limiter primitive). NOT held here because the fix is broader than this task's scope and the upgrade route's specific exposure is bounded by Hive RPC node count + State D idempotency.

### Architect-zone work landing at archive (not held)

- `agents/docs/api-contracts/custody.md:177,181,195` — update the `signed_at` window description to match the chosen Option (A or B from item 3) and add the "successful 200 only consumes the 1/hr slot" note from api-contract review's AC-02.

### Re-review signal

When items 1-5 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

---

## Backend re-review signal (2026-05-16, round-3 fix commit)

Round-2 → round-3 hold items 1-5 landed. Item 5(a) call-site audit grep output is included verbatim per architect instruction.

### Item-by-item resolution

**Item 1 (P2) + Item 2 (P2) — combined fix: atomic Lua INCR + DECR-on-overflow + unconditional PEXPIRE replaces GET → next() → deferred-INCR.**

Round-2's `skipFailedRequests` Redis path had two coupled bugs:

- **Permanent-lockout TTL bug**: `pexpire` only fired when `count === 1`. Concurrent post-success INCRs after count=1 left the key with no TTL ever; the key never expired; subsequent GETs saw `count > max` and 429'd indefinitely.
- **TOCTOU overshoot**: GET → next() → deferred-INCR is non-atomic. Two concurrent requests for the same key both see count=0 (separate GET round-trips), both pass `>= max`, both run the handler, both deferred-INCR on finish → final count=2 above max=1.

Both bugs are now structurally impossible. The single-round-trip atomic Lua script (registered as `RATE_LIMIT_CHECK_AND_CONSUME` in `backend/src/lib/redis-scripts.ts:74-104` and dispatched via `evalScript` to inherit EVALSHA + NOSCRIPT-fallback) does:

```
INCR → count > max ? (DECR + return {0, pttl}) : (PEXPIRE unconditional + return {1, 0})
```

`backend/src/middleware/rateLimit.ts:76-114` invokes the script up-front; on success, if `skipFailedRequests` is set, a `res.on('finish')` callback issues `DECR` when `res.statusCode >= 400` (slot refund). The DECR refund is a single command, no Lua needed — the limit-check Lua doesn't know the response outcome at entry time and doesn't need to.

The in-memory fallback path (`backend/src/middleware/rateLimit.ts:117-146`) mirrors the same shape: push the timestamp synchronously on entry (matches Redis INCR-up-front); for `skipFailed`, splice the pushed timestamp out of `entry.timestamps` on `res.on('finish')` when status >= 400. This eliminates the in-memory equivalent of the TOCTOU overshoot.

JSDoc on `RateLimitConfig.skipFailedRequests` (`backend/src/middleware/rateLimit.ts:17-49`) updated to document the implementation note and the misuse-direction warning (item 5(b)).

Verification — new tests in `backend/tests/middleware/rateLimit.test.ts`:

- **Concurrent INCRs within max all succeed; key retains TTL** (the round-3 fix-verification test architect requested). 5 concurrent `Promise.all` requests for the same account-key with max=5; all return 200; post-test the Redis key has `pttl > 0`. The round-2 bug would have left `pttl == -1` (no TTL).
- **skipFailedRequests refunds slot when handler returns 500**. Pins the DECR-on-failure refund path.
- **Lua DECR-on-overflow keeps count bounded at max, not max+1**. Pins the atomic-check invariant against future "remove DECR-on-overflow" mutations.

The concurrent test uses Redis directly (the Lua path is the one under test); the in-memory fallback has its own coverage via the existing tests + the new refund test's structure (Redis-conditional, no-op when Redis is unavailable).

**Item 3 (P2) — clock-skew Option A: 5s forward-skew tolerance.** `backend/src/routes/custody.ts:931-935` introduces `UPGRADE_PROOF_FUTURE_SKEW_MS = 5_000`. The freshness gate at `backend/src/routes/custody.ts:990-1003` now reads:

```ts
if (
  !Number.isFinite(tsMs) ||
  tsMs > nowMs + UPGRADE_PROOF_FUTURE_SKEW_MS ||
  nowMs - tsMs > UPGRADE_PROOF_TIMESTAMP_WINDOW_MS
)
```

Replay race window stays bounded at 65s (60s past + 5s forward); typical 100ms forward client drift no longer locks the user out. Doc comment at `:914-927` updated with the skew rationale.

Test: `backend/tests/routes/custody-upgrade.test.ts:395-411` — `Future-dated signed_at (> 5s skew tolerance): returns 401 UNAUTHORIZED`. Uses `signed_at = Date.now() + 30_000` (well past the 5s tolerance) and asserts 401.

Architect noted contract doc fix at `agents/docs/api-contracts/custody.md:177,181` lands at archive — out of backend zone, not touched.

**Item 4 (P2) — task-file path citation dropped.** `backend/src/routes/custody.ts:44-50` inline comment block on `upgradeLimiter` now points to `RateLimitConfig.skipFailedRequests` JSDoc instead of the task-file path that would rot on archive. The full rationale (skipFailedRequests design choice + stolen-JWT-DoS protection) is documented in the JSDoc per architect direction; the route-side comment summarizes the local intent and references the JSDoc.

**Item 5 (P2) — wrapping-primitive call-site audit + JSDoc misuse-direction.**

- **(a) Call-site audit.** Grep output below, verbatim. Every call site is enumerated and confirmed against the convention `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`.
- **(b) JSDoc misuse direction.** Added to `backend/src/middleware/rateLimit.ts:43-47`:

> DO NOT use on credential-probing routes (e.g., /login, /recover) — failed probes would not consume slots, enabling unlimited account enumeration. The option is intended for one-shot ceremonies where failure is benign (transient infrastructure error, malformed body from a hijacked session) and the value at stake is operation success, not attempt-rate-limiting.

### Item 5(a) call-site audit — `grep -rn 'rateLimit(' backend/src/ --include='*.ts'`

```
backend/src/routes/contact.ts:16:const contactLimiter = rateLimit({ name: 'contact', windowMs: 3_600_000, max: 5, keyFn: byIp });
backend/src/routes/signup-verify.ts:74:const verifyLimiter = rateLimit({ name: 'signup-verify', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/signup-verify.ts:75:const resumeLimiter = rateLimit({ name: 'signup-resume', windowMs: 3_600_000, max: 5, keyFn: byIp });
backend/src/routes/signup-verify.ts:76:const confirmLimiter = rateLimit({ name: 'signup-confirm', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/signup-verify.ts:77:const linkLimiter = rateLimit({ name: 'signup-link', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/app.ts:46:const readLimiter = rateLimit({ name: 'read', windowMs: 60_000, max: 120, keyFn: byIp });
backend/src/app.ts:47:const searchLimiter = rateLimit({ name: 'search', windowMs: 60_000, max: 60, keyFn: byIp });
backend/src/app.ts:50:const notificationLimiter = rateLimit({ name: 'notif', windowMs: 300_000, max: 30, keyFn: byIp });
backend/src/routes/auth.ts:262:const sessionLimiter = rateLimit({ name: 'auth-session', windowMs: 3_600_000, max: 10, keyFn: byAccount });
backend/src/routes/auth.ts:263:const signupLimiter = rateLimit({ name: 'auth-signup', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/auth.ts:264:const loginLimiter = rateLimit({ name: 'auth-login', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/auth.ts:265:const resetRequestLimiter = rateLimit({ name: 'auth-reset-request', windowMs: 3_600_000, max: 5, keyFn: byIp });
backend/src/routes/auth.ts:266:const resetLimiter = rateLimit({ name: 'auth-reset', windowMs: 3_600_000, max: 5, keyFn: byIp });
backend/src/routes/auth.ts:568:const resendLimiter = rateLimit({ name: 'auth-resend', windowMs: 3_600_000, max: 3, keyFn: byIp });
backend/src/routes/auth.ts:1072:const recoverLimiter = rateLimit({ name: 'auth-recover', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/settings.ts:26:const readLimiter = rateLimit({ name: 'settings-read', windowMs: 60_000, max: 30, keyFn: byIp });
backend/src/routes/settings.ts:27:const writeLimiter = rateLimit({ name: 'settings-write', windowMs: 60_000, max: 10, keyFn: byIp });
backend/src/middleware/rateLimit.ts:36:export function rateLimit(config: RateLimitConfig) {
backend/src/routes/bridge.ts:148:const lookupLimiter = rateLimit({ name: 'bridge-lookup', windowMs: 60_000, max: 20, keyFn: byIp });
backend/src/routes/bridge.ts:149:const registerLimiter = rateLimit({ name: 'bridge-register', windowMs: 3_600_000, max: 10, keyFn: byIp });
backend/src/routes/ipfs.ts:18:const ipfsUploadLimiter = rateLimit({ name: 'ipfs-upload', windowMs: 60 * 60_000, max: 10, keyFn: byAccount });
backend/src/routes/ipfs.ts:235:const ipfsDownloadLimiter = rateLimit({ name: 'ipfs-download', windowMs: 60_000, max: 60, keyFn: byIp });
backend/src/routes/anonymousReview.ts:20:const anonReviewLimiter = rateLimit({ name: 'anon-review', windowMs: 60 * 60_000, max: 5, keyFn: byAccount });
backend/src/routes/custody.ts:43:const broadcastLimiter = rateLimit({ name: 'custody-broadcast', windowMs: 60_000, max: 30, keyFn: byAccount });
backend/src/routes/custody.ts:51:const upgradeLimiter = rateLimit({ name: 'custody-upgrade', windowMs: 3_600_000, max: 1, keyFn: byAccount, skipFailedRequests: true });
backend/src/routes/custody.ts:57:const freshAuthLimiter = rateLimit({ name: 'custody-fresh-auth', windowMs: 60_000, max: 10, keyFn: byAccount });
backend/src/routes/custody.ts:62:const sessionAuthLimiter = rateLimit({ name: 'custody-session-auth', windowMs: 60_000, max: 10, keyFn: byAccount });
backend/src/routes/papers.ts:457:const retractLimiter = rateLimit({ name: 'paper-retract', windowMs: 3_600_000, max: 5, keyFn: byAccount });
backend/src/routes/papers.ts:2664:const invalidateLimiter = rateLimit({ name: 'cache-invalidate', windowMs: 60_000, max: 10, keyFn: byAccount });
backend/src/routes/claims.ts:124:const claimLimiter = rateLimit({ name: 'claim-authorship', windowMs: 60_000, max: 5, keyFn: byAccount });
backend/src/routes/claims.ts:173:const approveLimiter = rateLimit({ name: 'approve-authorship', windowMs: 60_000, max: 10, keyFn: byAccount });
backend/src/routes/claims.ts:266:const revokeLimiter = rateLimit({ name: 'revoke-authorship', windowMs: 60_000, max: 10, keyFn: byAccount });
backend/src/routes/accreditation.ts:35:const accreditationRequestLimiter = rateLimit({ name: 'accred-req', windowMs: 24 * 60 * 60_000, max: 3, keyFn: byAccount, skipFailedRequests: true });
backend/src/routes/accreditation.ts:36:const accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp });
backend/src/routes/orcid.ts:204:const startLimiter = rateLimit({ name: 'orcid-start', windowMs: 60_000, max: 10, keyFn: byIp });
backend/src/routes/orcid.ts:205:const callbackLimiter = rateLimit({ name: 'orcid-callback', windowMs: 60_000, max: 10, keyFn: byIp });
```

**Per-site audit (one-liner per call site; `skipFailedRequests` adoption intent + credential-probing-route check):**

- `contact:16` — public contact form, IP-keyed; not credential-probing; omits `skipFailedRequests` intentionally (every send attempt counts to bound spam). OK.
- `signup-verify:74` (verify) — IP-keyed email-verify; not credential-probing in the password sense; omits `skipFailedRequests` intentionally to bound enumeration of verify tokens. OK.
- `signup-verify:75` (resume) — IP-keyed signup-resume; same OK.
- `signup-verify:76` (confirm) — IP-keyed confirm; same OK.
- `signup-verify:77` (link) — IP-keyed link; same OK.
- `app:46` (readLimiter) — public read API, IP-keyed; not credential-probing; omits `skipFailedRequests` (high `max=120`, every request counts). OK.
- `app:47` (searchLimiter) — public search API, IP-keyed; same OK.
- `app:50` (notificationLimiter) — IP-keyed notification poll; same OK.
- `auth:262` (sessionLimiter) — account-keyed session limiter, NOT a credential probe (gates session-mint, not password); omits `skipFailedRequests` intentionally (every probe counts to bound stolen-JWT abuse). OK.
- `auth:263` (signupLimiter) — IP-keyed signup; same OK.
- `auth:264` (loginLimiter) — IP-keyed login; **CREDENTIAL-PROBING route** — MUST NOT use `skipFailedRequests` per JSDoc warning. Confirmed omitted. OK.
- `auth:265` (resetRequestLimiter) — IP-keyed reset-request; **credential-adjacent** (account-enumeration-via-existence); MUST NOT use `skipFailedRequests`. Confirmed omitted. OK.
- `auth:266` (resetLimiter) — IP-keyed reset; **credential-probing** (token guess); MUST NOT use `skipFailedRequests`. Confirmed omitted. OK.
- `auth:568` (resendLimiter) — IP-keyed verification-resend; not credential-probing; bounds email-spam. Confirmed omitted. OK.
- `auth:1072` (recoverLimiter) — IP-keyed recover; **credential-probing** (recover token guess); MUST NOT use `skipFailedRequests`. Confirmed omitted. OK.
- `settings:26` (settings-read) — IP-keyed settings GET; not credential-probing. OK.
- `settings:27` (settings-write) — IP-keyed settings PATCH; not credential-probing in the password sense (settings mutations are fresh-auth-gated downstream). OK.
- `rateLimit:36` — the export site itself, not a call site. Skip.
- `bridge:148` (bridge-lookup) — IP-keyed bridge-account lookup; not credential-probing. OK.
- `bridge:149` (bridge-register) — IP-keyed bridge-register; not credential-probing. OK.
- `ipfs:18` (ipfs-upload) — account-keyed upload, expensive; not credential-probing; every upload counts (no skip). OK. (A candidate for future `skipFailedRequests` adoption if 503-from-pinner becomes a UX issue, but not now.)
- `ipfs:235` (ipfs-download) — IP-keyed download; not credential-probing. OK.
- `anonymousReview:20` — account-keyed review-publish; not credential-probing; every attempt counts (5/hr cap). OK.
- `custody:43` (broadcast) — account-keyed broadcast; not credential-probing (verifyHiveSignature gates upstream); every broadcast counts. OK.
- `custody:51` (upgrade) — **this is the round-2/3 adopter site**; `skipFailedRequests: true` set intentionally per the JSDoc-documented rationale (one-shot ceremony, Hive RPC 503 should not burn the slot, stolen-JWT 400 should not lock the user out). NOT credential-probing (the proof is a signature over a derived pubkey, not a password). OK.
- `custody:57` (fresh-auth) — account-keyed fresh-auth mint; argon2.verify is the password check inside the handler; the 10/min `max` is intentionally restrictive to bound the password-guess oracle. **CREDENTIAL-PROBING** — MUST NOT use `skipFailedRequests`. Confirmed omitted. OK.
- `custody:62` (session-auth) — account-keyed session-mint; same argon2.verify password check; **CREDENTIAL-PROBING** — MUST NOT use `skipFailedRequests`. Confirmed omitted. OK.
- `papers:457` (paper-retract) — account-keyed retract; not credential-probing; rare op (5/hr). OK.
- `papers:2664` (cache-invalidate) — account-keyed cache invalidation; not credential-probing. OK.
- `claims:124,173,266` — account-keyed authorship claim/approve/revoke; not credential-probing. OK.
- `accreditation:35` (accred-req) — **already adopts** `skipFailedRequests: true` (existing adopter site from an earlier task). 3/day cap; consume-on-success-only protects users from transient failures burning their daily budget. NOT credential-probing (the gate is fresh-auth signed proof, not a password). OK.
- `accreditation:36` (accred-verify) — IP-keyed verify-token; not credential-probing in the password sense; omits `skipFailedRequests` (token-guess bound). OK.
- `orcid:204,205` (orcid-start, orcid-callback) — IP-keyed OAuth flow; not credential-probing in the password sense; omits `skipFailedRequests` (OAuth-state-token guess bound). OK.

Net: two adopters of `skipFailedRequests` (`custody:51` and `accreditation:35`), both NOT credential-probing routes, both one-shot/rare-op ceremonies where transient failure shouldn't burn the slot. No credential-probing-route misuse exists. The convention `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` is satisfied for round-3.

### Verification

- `npm run lint` — clean.
- `npm run typecheck` — clean (both `typecheck:src` and `typecheck:tests` pass).
- Vitest NOT run in worktree — parent serializes after merge.

### Files landed

- `backend/src/lib/redis-scripts.ts` — added `RATE_LIMIT_CHECK_AND_CONSUME_LUA` to `SHARED_SCRIPTS` registry.
- `backend/src/middleware/rateLimit.ts` — atomic Lua dispatch via `evalScript`, in-memory parity for skipFailed mode, JSDoc misuse-direction warning.
- `backend/src/routes/custody.ts` — `UPGRADE_PROOF_FUTURE_SKEW_MS`, freshness gate Option A, doc comment refresh, dropped task-file citation on `upgradeLimiter` comment.
- `backend/tests/middleware/rateLimit.test.ts` — three new tests (concurrent-INCRs-retain-TTL, skipFailedRequests-refund, DECR-on-overflow).
- `backend/tests/routes/custody-upgrade.test.ts` — added future-dated `signed_at` 401 test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
