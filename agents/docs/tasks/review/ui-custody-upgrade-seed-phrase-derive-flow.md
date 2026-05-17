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

## Architect re-review (2026-05-16) — HELD PENDING FIXES [BLOCKED by Backend]:

Reviewed via `/ce-code-review` against commit `8a373e7` with 10 personas (correctness/security/adversarial Opus; testing/maintainability/project-standards/api-contract/reliability/julik-frontend-races/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Implementation is high quality on the happy path: api-contract verified the wire shape is bit-identical between UI and backend, including the canonical challenge format `${appTag}-custody-upgrade|v1|${username}|${signed_at}` against `backend/src/routes/custody.ts:821` `buildCustodyUpgradeChallenge`; security confirmed no key material escapes `_signUpgradeProof`'s frame, the proof is signed with the post-rotation active key (correct), the disconnect+toast path on 403 username_mismatch is structurally sound, and the canonical challenge is not injectable via Hive username regex. Correctness verified the discriminator key list `NON_RETRYABLE_KEYS` matches all `upgradeErrorKey` assignment sites with no typos.

**Why blocked-by-backend:** the most severe finding is a coordination defect that the UI cannot fix in its own zone — backend's upgrade rate limiter at `backend/src/routes/custody.ts:42` makes the new 503-retry contract mechanically dead. See **[BLOCKED by Backend]** below. Other UI-zone items can land in parallel with the backend fix.

### Blocking item

**B1. [BLOCKED by Backend] P0 — 503-retry path mechanically dead.** adversarial adv-1 (P0/95) + correctness #1 (P0/75) → cross-reviewer **promoted to confidence 100**. Backend's `upgradeLimiter` (`max:1/hour`) increments unconditionally before the handler runs. First 503 → counter=1. Retry → counter=2 → 429. UI classifies 429 as terminal `rateLimited` and wipes `newSeedPhrase`. Catastrophic data loss: chain rotated, backend keys stale, user locked out for the hour.

Backend task filed: `agents/docs/tasks/pending/backend-custody-upgrade-limiter-skip-failed.md`. When that lands, this task unblocks for archive (modulo the UI-zone items below).

### UI-zone items to address (in parallel with B1)

**1. P0 — Client clock skew >60s catastrophic (`frontend/src/pages/settings.js:1034`).** adversarial adv-2 (P0/90). Broadcast lands first (dhive's ~30s expiration tolerance), proof 401s for `signed_at` outside backend's 60s window, wipe terminal, no recovery. Mobile-clock pause / dead RTC / VM-resumed clocks put real users >60s out.

   **Fix direction:** before signing the proof, fetch a backend time reference (e.g., a lightweight `GET /api/time` endpoint that returns server-now as ISO-8601) and validate `|client_now - server_now| < 30_000` before proceeding. If skew exceeds 30s, show a "Your clock appears to be off by N seconds. Please correct your system clock before upgrading." error and abort BEFORE the broadcast. If no time endpoint exists, file a coordinating backend task; in the meantime fall back to advisory: log a `console.warn` on `signed_at`-generation time and accept the risk.

**2. P0 — Mid-broadcast navigation bricks the account (`frontend/src/pages/settings.js:755`).** adversarial adv-3 (P0/85). No `beforeunload` guard during `upgradePhase==='upgrading'`. Tab close after broadcast lands but before backend cleanup POST → server keeps stale keys, chain has new keys, next sign-in lands in broken state with no auto-recovery.

   **Fix direction:** register a `beforeunload` listener in `init()` that returns a non-empty string when `upgradePhase==='upgrading'` (browsers honor it as "you have unsaved changes" warning). Deregister on terminal (`done` or `error`) phases and in `destroy()`. The warning is a UX affordance, not a hard block — browsers may suppress repeated dialogs — but it surfaces the data-loss risk before the user commits.

**3. P1 (cross-reviewer, conf 100) — `retryUpgradeBackend` missing `_mounted` post-await guard (`frontend/src/pages/settings.js:933`).** adversarial adv-4 + reliability R4 + julik F1. Mirror the guard at `executeUpgrade:783`. Fix: add `if (!this._mounted) return;` immediately after `await this._postUpgradeBackend(proof)` and BEFORE `Alpine.store('auth').loginFromResponse(...)`.

**4. P1 (cross-reviewer, conf 100) — `retryUpgradeBackend` no concurrency gate (`frontend/src/pages/settings.js:914-928`).** reliability R1 + adversarial adv-5. `upgradePhase = 'upgrading'` is written AFTER the guard checks. Two concurrent invocations both pass the guard before either writes 'upgrading'. Fix: move `this.upgradePhase = 'upgrading';` to the first synchronous statement of `retryUpgradeBackend` (after the gate check), mirroring `executeUpgrade`'s pattern.

**5. P1 — 401 wipes mnemonic without security justification (`frontend/src/pages/settings.js:877`).** adversarial adv-11 (P1/85). The 401 sub-case (proof rejection: signature recovery fails, derived_pubkey mismatch, chain key not in key_auths) currently routes to `partialApplyFailed` (terminal, wipes `newSeedPhrase`). For a clock-skew-induced 401 (the most common 401 cause under finding #1's scenario), wiping the seed closes the only retry surface. Fix: distinguish clock-skew 401 from cryptographic-failure 401. Backend already returns 401 uniformly to avoid disclosure, so the UI cannot distinguish on response shape alone. Acceptable shape: on first 401 post-broadcast, KEEP `newSeedPhrase`, classify as retryable (`upgrade.proofRejected`), surface "Could not verify upgrade proof. If your clock is off, correct it and try again." with Retry button. Only wipe on the SECOND 401 (after one retry attempt). Coordinate with finding #1's time-skew detection — once that lands, the retry budget can shrink.

**6. P1 — 20s AbortSignal timeout terminal but server-side commit may have succeeded (`frontend/src/pages/settings.js:825`).** adversarial adv-7 (P1/75). The terminal `backendTimeout` sub-case is reached when the fetch aborts at 20s. The backend may have committed `upgraded_at` before the abort fired. UI's session is still light JWT with no seed remaining (wiped on terminal). User must re-login to discover whether the upgrade landed. Fix: on `backendTimeout`, copy "Your upgrade may have succeeded but we couldn't confirm. Please sign out and sign back in to check your account state." Do NOT wipe `newSeedPhrase` until the user has had a chance to copy it. Alternatively, add a one-shot `GET /api/custody/upgrade-status` probe in this catch branch.

**7. P1 (maintainability) — Three-site synchronization burden (`frontend/src/pages/settings.js:17-22, 469-475, 825-895`).** M1 (P1/75). `upgradeErrorKey` assignments (20 sites grep-verified), `NON_RETRYABLE_KEYS` list, and `handleRetry` switch must stay synchronized. Fix: hoist the key set into a typed `UPGRADE_ERROR_KEYS` const map (`const UPGRADE_ERROR_KEYS = { backendTimeout: 'upgrade.backendTimeout', partialApplyFailed: ..., backendUnavailable: ..., ... }`) and a `RETRYABILITY` annotation per key (`{ backendUnavailable: 'retryable-backend-only', generationFailed: 'retryable-reset', alreadyUpgraded: 'terminal', ... }`). Catch blocks reference the const; `canRetryUpgrade` and `handleRetry` consume the annotation. Drift becomes a TypeScript / lint failure rather than a silent classification bug.

**8. P1 (maintainability) — `retryUpgradeBackend` duplicates catch-case ladder from `executeUpgrade` (`frontend/src/pages/settings.js:914-982`).** M2 (P1/75). 4-case ladder verbatim copied with only the `broadcastLanded` guard omitted. Future error-copy edits hit one block and miss the other. Fix: extract `_handlePostBroadcastError(err, { wipe })` helper consuming the UPGRADE_ERROR_KEYS const from #7. Both call sites reduce to a single call.

### P2 / advisory items (land in this hold round if convenient; otherwise carry)

- **P2 (adversarial adv-9, conf 90):** Canonical challenge format duplicated frontend literal + backend builder, no shared SoT / byte-equality test. Add a `frontend/tests/unit/custody-upgrade-challenge-equivalence.test.js` mirroring `sec-001-equivalence.test.js`'s shape, asserting the UI's challenge string is byte-identical to the backend's `buildCustodyUpgradeChallenge` output for a fixed `(appTag, username, signed_at)` fixture. Cross-ref `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md`.
- **P2 (adversarial adv-8, conf 95):** E2E stubs route, never exercises real limiter / freshness / signature / chain. This is the test-gap that hid finding B1. Add at least one integration test that drives a real signed proof through a non-stubbed `/api/custody/upgrade` against a test backend instance.
- **P2 (testing T1, conf 75):** Proof-body `derived_pubkey` cross-check against `deriveAllKeys` is inside `if (postRotationSeed && postRotationSeed.length > 0)` → silently skipped on fast machines after `_clearSensitiveUpgradeState()` runs. Fix: capture `newSeedPhrase` INSIDE the route intercept handler (where it's guaranteed in state) and move the cross-check out of the conditional.
- **P2 (reliability R2, conf 85):** No upper bound on 503 retry count — infinite Try Again clicks accepted. After a retry budget (e.g., 5 consecutive 503s) flip to terminal with copy directing to support. Coordinated with finding B1's limiter fix; revisit after.
- **P2 (reliability R3, conf 70):** Same-class as finding #6; coordinate copy improvement.

### Advisory (P3) — track but not blocking

- **adversarial adv-6 (signed_at 58-60s cliff):** related to finding #1's time-skew detection.
- **adversarial adv-10 (backend 503 has two sources, SPA can't distinguish):** wire-contract evolution risk; not actionable today.

### Path to archive

This task archives when:
1. Backend `backend-custody-upgrade-limiter-skip-failed.md` lands (clears finding B1).
2. UI-zone items #1-#8 land.
3. The P2 byte-equality test (adv-9) and the real-path integration test (adv-8) land in this round OR are filed as separate follow-up tasks.

Once finding B1 resolves and the UI items land, `git mv` this file back to `tasks/review/`. The next architect re-review will cover the full re-fan-out diff against `8a373e7..HEAD`.

Cross-references:
- `agents/docs/tasks/pending/backend-custody-upgrade-limiter-skip-failed.md` — the blocking backend task.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — convention for the byte-equality test (P2 adv-9).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the retriable-discriminator architecture pattern this flow's `handleRetry` follows.
- `agents/docs/tasks/pending/backend-custody-session-auth-password-mint.md` — State A's eventual landing point (not blocking this task, but the upgrade flow's "current State A unreachable" assumption depends on it staying true until that lands).

## UI re-review signal (2026-05-17, commit 0f23539)

Round-2 hold-block fixes landed. Backend B1 (`backend-custody-upgrade-limiter-skip-failed`) archived 2026-05-16 (verified: `skipFailedRequests: true` at `backend/src/routes/custody.ts:52`); blocker cleared.

**P0/P1 items landed (all 8):**
1. Clock-skew advisory — `console.warn` fallback in `_signUpgradeProof` per architect guidance. **Backend follow-up:** `GET /api/time` endpoint not present in `backend/src/routes/`. Inline comment in `_signUpgradeProof` flags the swap-to-hard-abort plan when an endpoint lands. Architect: please decide whether to file a backend task.
2. `beforeunload` guard registered in `init()`, deregistered in `destroy()` and on terminal phases.
3. `_mounted` guard after `await this._postUpgradeBackend(proof)` in `retryUpgradeBackend`.
4. Concurrency gate: `this.upgradePhase = 'upgrading'` is now the first synchronous statement of `retryUpgradeBackend`.
5. First-401 keeps mnemonic, second-401 wipes. `UPGRADE_PROOF_RETRY_BUDGET = 2`. Counter resets in `startUpgrade` / `resetUpgrade`.
6. `backendTimeout` copy reframed to "sign out and back in" + no-wipe; mnemonic preserved.
7. `UPGRADE_ERROR_KEYS` + `RETRYABILITY` map hoisted; `canRetryUpgrade` and `handleRetry` consume the annotation.
8. `_handlePostBroadcastError(err, { wipe })` extracted; both `executeUpgrade` and `retryUpgradeBackend` reduce to a single call.

**P2 items carried (file as separate follow-up tasks):**
- adv-9 byte-equality test: needs backend to export `buildCustodyUpgradeChallenge` for cross-source guarantee (vendoring the template gives weaker drift coverage than `sec-001-equivalence.test.js`).
- adv-8 real-path integration test: requires backend test-instance wiring.
- T1, R2, R3: lower priority post-B1; architect can re-triage.

**Tests:** `pages-settings.test.js` 63/63, new `pages-settings-custody-upgrade-round2.test.js` 22/22, full unit suite 1153/1153.

**i18n:** new key `upgrade.proofRejected`, updated `upgrade.backendTimeout` copy; 15 non-English stubs added; STUBS.md sweep entry `### Added 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)`.
