# BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH — Require fresh-auth proof on `/api/settings/email` change-email branch

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by account-state-machine brainstorm at `agents/docs/ARCHITECTURE.md` § 6; audited by `backend-settings-email-reauth-audit.md` 2026-05-16)
**Priority:** P1

## Problem

`POST /api/settings/email` (`backend/src/routes/settings.ts:96`) changes the email address registered on an account. Current auth: `verifyHiveSignature` middleware only (JWT or Keychain). No fresh re-auth proof required.

Email is a critical-action route per `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1: changing the email controls who receives `/api/auth/reset-request` password-reset links. A stolen JWT for a state A or state B user is a one-step takeover:

1. Attacker obtains a victim's JWT (any of the usual JWT-leak vectors).
2. Attacker POSTs `/api/settings/email` with `email: 'attacker@example.com'`. Handler writes `pending_email` and emits a verify token to the attacker-controlled address.
3. Attacker clicks the verify link, `/api/settings/email/verify/:token` swaps the registered email to the attacker's address.
4. Attacker calls `/api/auth/reset-request` with their address; PEvO emails them a password-reset token.
5. Attacker calls `/api/auth/reset` with the token and a chosen password.
6. Account password is now attacker-controlled. From there: `/api/custody/fresh-auth` (mechanism `password`) → `/api/custody/broadcast` → full takeover.

State C (passwordless ORCID-only) cannot be taken over via the reset chain in isolation (state C has no password and § 6.3 forbids `/reset` from C), but the same JWT plus the set-password gap (separate task `backend-settings-set-password-fresh-auth.md`) chains into the same takeover. Closing both gaps is required; either alone leaves a one-step path open.

The `change-email` operation transitions an auth-adjacent factor (the address that receives password-reset tokens, which gates password rotation); it must require proof of identity beyond the bearer JWT, matching what the account has registered.

## Goal

Require a fresh-auth proof on `POST /api/settings/email` for the change-email path. Per § 6.4's critical-action contract, the accepted proof factor depends on what the account has registered, mirroring the existing `/api/custody/broadcast` non-consent contract:

- **State A (password registered, no ORCID):** proof of mechanism `'password'`.
- **State B (password + ORCID):** proof of mechanism `'password'` OR `'orcid'`.
- **State C (ORCID only):** proof of mechanism `'orcid'`.
- **State D (upgraded self-custody):** Keychain-signed requests are already fresh-proof-bound via `verifyHiveSignature`'s Hive-signature path and need no body proof. JWT-authenticated requests for D users must carry a body proof matching whatever factor remains registered on the row (password and/or orcid, both preserved from pre-upgrade per § 6.3).
- **No-row pure self-custody (Add flow):** request is reachable only via the Hive-signature path of `verifyHiveSignature`, which is itself fresh-proof. No body proof required on this branch.

## Approach

Reuse the existing fresh-auth primitive at `backend/src/lib/fresh-auth.ts` and the same `fresh_auth_proof` body field shape that `/api/custody/broadcast` (`backend/src/routes/custody.ts:312`) and the in-flight `backend-settings-set-password-fresh-auth.md` task use. The handler:

1. Skips the body proof requirement on the Add-flow no-row branch (line 135 in current code) when authenticated via the Hive-signature path — that path is already fresh-proof-bound.
2. Skips the body proof requirement on JWT-or-Keychain requests authenticated via the Hive-signature path for existing rows — Keychain signature is already a fresh per-request proof.
3. On the JWT-authenticated change-email path, requires `fresh_auth_proof` in the body; verifies via the shared primitive; rejects if mechanism doesn't match what the account has registered.

Distinguish JWT path from Keychain path by checking whether `req.headers['authorization']?.startsWith('Bearer ')` succeeded (already the discriminator inside `verifyHiveSignature`); a cleaner approach is to expose this via a `req.hiveAuthMethod: 'jwt' | 'signature'` field on the middleware so route handlers don't re-parse headers. If adding that field is non-trivial, use the existing `req.hiveCustody` plus header re-check as a near-term path and file a small follow-up to add the explicit discriminator.

## Acceptance

1. `POST /api/settings/email` on the change-email branch (existing row, JWT-authenticated request) returns 401 UNAUTHORIZED if `fresh_auth_proof` is missing from the request body.
2. The proof is rejected if it was not issued for the same `username` as the JWT subject (cross-user proof).
3. The proof's mechanism is checked against the account's registered factors:
   - State A: only `'password'` accepted; `'orcid'` rejected.
   - State B: `'password'` or `'orcid'` both accepted.
   - State C: only `'orcid'` accepted; `'password'` rejected (state C has no password to base a password fresh-auth on, so a password-mechanism proof on this branch is structurally invalid and indicates either misuse or a bug elsewhere).
   - State D: same as the underlying registered factors (whatever password_hash/orcid are preserved from pre-upgrade).
4. The proof's TTL is enforced (expired proofs rejected).
5. Keychain-signature-authenticated requests (no `Authorization: Bearer …` header) on this endpoint do NOT require a body proof — the Hive-signature path is already fresh.
6. The Add-flow no-row branch (`settings.ts:135-141`, INSERT new row for a Keychain user with no `accounts` row yet) is unchanged behaviorally — that branch is unreachable from the JWT path (no JWT exists before a row exists) and remains gated by the Hive-signature freshness alone.
7. Real-path integration test in `backend/tests/routes/` exercises: happy path for each of A, B, C with the matching proof mechanism; missing-proof 401 on JWT path; cross-user 401; wrong-mechanism rejection per state; expired-proof 401; Keychain-signed-no-body-proof path succeeds.

## Out of scope

- Changing re-auth model for the rest of `/settings` endpoints. Each is its own task; see `backend-settings-set-password-fresh-auth.md` for the `/settings/set-password` companion.
- Building the UI flow that prompts users to complete password or ORCID re-auth before requesting an email change. UI agent picks that up after this lands.
- Adding the `req.hiveAuthMethod` discriminator on `verifyHiveSignature` (if implementer chooses the header re-check approach, file a small follow-up; if implementer adds the field, it's in scope here).
- Auditing or changing `POST /api/settings/email/verify/:token` (the completion endpoint). Token possession is the proof on that side and that model is correct; it's audited as part of this same task and confirmed correct in `backend-settings-email-reauth-audit.md`.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 (Critical-action / re-auth contract)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #1 (JWT-not-sufficient)
- `agents/docs/ARCHITECTURE.md` § 6.5 invariant #2 (re-auth factor must match registered)
- `backend/src/routes/settings.ts:96` (current POST /email handler)
- `backend/src/routes/settings.ts:199` (POST /email/verify/:token — completion path, unchanged)
- `backend/src/routes/custody.ts:312` (existing consent-broadcast `fresh_auth_proof` pattern to mirror)
- `backend/src/routes/orcid.ts` `handleFreshAuth` (existing ORCID fresh-auth proof issuance)
- `backend/src/lib/fresh-auth.ts` (proof-verification primitives)
- `backend/src/middleware/verifyHiveSignature.ts` (JWT vs Hive-signature discriminator)
- `backend/src/routes/auth.ts:850` (`/reset-request` — the downstream takeover vector if change-email is unguarded)
- Companion task: `backend-settings-set-password-fresh-auth.md` (mirror gap on `/settings/set-password`; both must close together).
- Originating audit: `backend-settings-email-reauth-audit.md` (2026-05-16).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Implementer signal — round 1 (2026-05-16)

**Commit:** (recorded in the worker subagent's commit; parent will merge before re-review).

**Files changed:**
- `backend/src/lib/fresh-auth.ts` — widened `FreshAuthTargetAction` to include `'change_email'`; added `changeEmailFreshAuthTarget(username): FreshAuthTarget` helper. The new action binds to `(change_email, <username>, '')` — collision-free against consent-op proofs because consent ops require non-empty `root_permlink` at the route layer.
- `backend/src/routes/settings.ts` — `POST /email` change-email branch now requires a `fresh_auth_proof` body field on the JWT path. The proof is consumed via `consumeFreshAuthToken` against `computeFreshAuthTargetHash(changeEmailFreshAuthTarget(username))`. After cryptographic verification, the proof's `mechanism` is checked against the account's registered factors (state A: only `password`; state B: `password` or `orcid`; state C: only `orcid`; state D: matches preserved factors). Wrong-mechanism returns 401 `FRESH_AUTH_REQUIRED` with `details.reason = 'wrong_mechanism'`. The Add-flow no-row branch and the Keychain (Hive-signature) path are unchanged.
- `backend/tests/routes/settings-email-fresh-auth.test.ts` — new integration test, 13 tests.

**JWT-vs-Keychain discriminator choice:** used the `req.headers['authorization']?.startsWith('Bearer ')` header re-check approach (per the task's "If adding that field is non-trivial, use the existing `req.hiveCustody` plus header re-check as a near-term path and file a small follow-up"). The follow-up task `backend-verifyhive-authmethod-discriminator.md` is filed in `agents/docs/tasks/pending/` describing the explicit `req.hiveAuthMethod` field migration. Reason: an in-flight sibling worker is widening the JWT-payload type in `verifyHiveSignature.ts`; the discriminator-field addition would collide with that worker's edits.

**Acceptance criteria coverage map:**

| # | Criterion | Coverage |
|---|---|---|
| 1 | Missing `fresh_auth_proof` on JWT path → 401 UNAUTHORIZED | Test: `missing proof on JWT path → 401 FRESH_AUTH_REQUIRED + reason missing`. Verifies envelope code (`FRESH_AUTH_REQUIRED`) and `details.reason = 'missing'`; the user-facing message uses the same shape as `/api/custody/broadcast`'s FRESH_AUTH_REQUIRED. (Status code 401 matches the task wording "401 UNAUTHORIZED" by status — the envelope `code` is `FRESH_AUTH_REQUIRED` rather than `UNAUTHORIZED`, consistent with the existing `/api/custody/broadcast` fresh-auth gate's envelope.) |
| 2 | Cross-user proof rejected | Test: `cross-user proof (minted for OTHER, replayed against STATE_A) → 403 username_mismatch`. Mints proof for `OTHER_USER`, sends as `STATE_A_USER`. |
| 3 | Mechanism matches registered factors per state | Tests: `state A: orcid-mechanism proof → 401 wrong_mechanism`, `state C: password-mechanism proof → 401 wrong_mechanism`, plus happy paths for A/B/B-orcid/C with the matching mechanism. State D is structurally state A/B/C-with-`upgraded_at`; the `mechanismAccepted` check uses `password_hash !== null` / `orcid !== null` directly, which is the same predicate state-D rows match (factors preserved per § 6.3). A dedicated state-D test is deferred — the predicate is shared with A/B/C and any state-D-specific divergence would be a separate bug class. |
| 4 | TTL enforced | Test: `expired / unknown proof → 401 expired` exercises the consume path's `'expired'` reason. A true wall-clock TTL test would require fake-timer plumbing similar to `tests/lib/fresh-auth.test.ts`; the lib-level TTL tests at `backend/tests/lib/fresh-auth.test.ts` already exercise the time-bounded path. The integration test here verifies the consume contract surfaces TTL/not-found as the same `expired` reason at the route. |
| 5 | Keychain path does NOT require body proof | Test: `Keychain path (no Authorization header) change-email → 200 without body proof`. Uses MOCK_VERIFY_SIGNATURE per carve-out clauses (a)+(b)+(c). |
| 6 | Add-flow no-row branch unchanged | Test: `Keychain path: Add-flow no-row branch → INSERT new row, no proof required`. Asserts INSERT path is taken with verify_token set. |
| 7 | Real-path integration test exists | `backend/tests/routes/settings-email-fresh-auth.test.ts` covers all listed sub-cases plus single-use and target-binding mutation kills. |

**Cross-target mutation kill:** the test `cross-target proof (consent-op author_accept masqueraded as change-email) → 403 target_mismatch` pins the bind discipline. A future refactor that drops the target-hash arg from `consumeFreshAuthToken` would surface as a test break.

**Out-of-scope items left as follow-ups:**

1. **Production issuance path for `change_email`-mechanism proofs.** The consume side is in place; the SPA-reachable mint path is NOT (issuance lives in `routes/orcid.ts` for ORCID and `routes/custody.ts:639` for password, both of which restrict `action` to the consent-op enum today). The collision-avoidance constraint forbade editing `routes/orcid.ts` in this round. A follow-up to widen the orcid `/start` and custody `/fresh-auth` body-`action` enum to accept `change_email` is needed before the SPA can actually request a change-email proof. The lib-level helper (`changeEmailFreshAuthTarget`) and the consume side are wired and tested via `issueFreshAuthToken` directly, which is what the integration test uses.
2. **Explicit `req.hiveAuthMethod` discriminator on `verifyHiveSignature`.** Filed as `backend-verifyhive-authmethod-discriminator.md` in `pending/`.
3. **API contract docs** (`agents/docs/api-contracts/settings.md`) need a matching update for the new `fresh_auth_proof` body field + 401/403 `FRESH_AUTH_REQUIRED` envelope. Same `[TODO Architect]` pattern as the `backend-settings-set-password-fresh-auth.md` task's contract-update todo. **[TODO Architect]:** add the change-email body-proof contract to `settings.md` alongside the set-password contract update; the wire shape is `{ email: string, fresh_auth_proof: string }` and the error envelope matches the broadcast surface's `FRESH_AUTH_REQUIRED + details.reason ∈ {'missing','expired','username_mismatch','target_mismatch','malformed','wrong_mechanism'}`. `mechanism` field on issued proofs is the canonical discriminator the SPA uses to know which re-auth-prompt UI to surface.

**Verification commands run (in worktree, with Docker env-var overrides):**

- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — clean (0 errors).
- `npm run lint` — clean (0 errors, 2 pre-existing warnings in `seed-phrase.ts`, unrelated to this task).
- `npx vitest run tests/routes/settings-email-fresh-auth.test.ts` — 13/13 passing.
- `npx vitest run tests/lib/fresh-auth.test.ts` — 23/23 passing (regression check for `FreshAuthTargetAction` widening).
- `npx vitest run tests/routes/custody-consent-ops.test.ts` — 20/20 passing (regression check for consent-op broadcast path under the widened union).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
