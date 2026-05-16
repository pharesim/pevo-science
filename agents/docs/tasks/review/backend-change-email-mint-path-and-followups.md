# BACKEND-CHANGE-EMAIL-MINT-PATH-AND-FOLLOWUPS — Wire SPA-reachable mint for change_email + bundle email-reauth review-cycle follow-ups

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by /ce-code-review on commit `b27bcdf` BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH)
**Priority:** P0 (gate landed without mint path — change-email JWT flow is structurally unreachable in production until this lands)

## Problem

Commit `b27bcdf` landed the consume side of the `change_email` fresh-auth gate on `POST /api/settings/email` (JWT path). The mint side does NOT yet exist:

- `POST /api/orcid/start` (`backend/src/routes/orcid.ts:333-360`) rejects `action: 'change_email'` with 400 `VALIDATION_ERROR` ("action must be one of: author_accept, author_resign, set_password").
- `POST /api/custody/fresh-auth` (`backend/src/routes/custody.ts:726-733`) rejects the same with 400 ("action must be one of: author_accept, author_resign").

Consequence: every State A/B/C/D JWT-path attempt to change email returns 401 `FRESH_AUTH_REQUIRED` with `details.reason: 'missing'` because the SPA cannot mint the proof through any live endpoint. The security gap is closed by the gate (closed-default), but the feature is too — JWT-path email change is non-functional until the mint widening lands.

This task widens both mint paths and bundles the in-scope follow-up items from the email-reauth review-cycle triage so they land together as one coherent commit on the email-change surface.

## Goal

Make the JWT-path change-email flow end-to-end reachable from the SPA, with the per-state mechanism matrix and the contract-doc behavior matching `agents/docs/api-contracts/settings.md` / `orcid.md` (updated at the audit-task archive in commit `492d8e9`).

## Acceptance

1. **`POST /api/orcid/start` widens.** `action` enum on `mode === 'fresh_auth'` accepts `change_email`. When `action === 'change_email'`, the handler does NOT require `root_author` / `root_permlink` in the request body — the backend synthesizes the target from the authenticated username (`root_author = <JWT subject>`, `root_permlink = ''`) using the existing `changeEmailFreshAuthTarget(username)` helper. Validation error message for malformed `action` widens to enumerate all four values. Pattern mirrors the `set_password` branch already in the same handler — use `changeEmailFreshAuthTarget(username)` and `setPasswordFreshAuthTarget(username)` directly; do NOT copy-paste the inline literal pattern (issuer-side helper adoption is item 8 of this task).

2. **`POST /api/custody/fresh-auth` widens.** Body `action` enum accepts `change_email`. Issuance binds to `(change_email, <authenticated username>, '')` via `changeEmailFreshAuthTarget`. The password-mechanism proof issued by this route is admissible at the change-email consume side for state A/B accounts (states with `password_hash IS NOT NULL`). State C accounts have no password to base a password fresh-auth on so this route is structurally unreachable for them on the `change_email` action; that path is intentionally limited to ORCID mint via `orcid /start`.

3. **`kind_mismatch` lands in the 403 branch on the email-reauth handler.** At `backend/src/routes/settings.ts:207-210`, add `|| result.reason === 'kind_mismatch'` to the 403 status-code branch so the sibling `custody.ts:371-376` mapping is mirrored. SPA error-routing that branches on status code (401 → re-login, 403 → wrong-account/wrong-proof) gets consistent signals across all three routes that consume the fresh-auth primitive.

4. **Issuer-side helper adoption.** When adding the `change_email` branch in `orcid.ts /start`, use `changeEmailFreshAuthTarget(username)` directly instead of constructing the literal `{ action: 'change_email', root_author: username!, root_permlink: '' }` inline. (The existing `set_password` branch in the same handler currently has this anti-pattern — also fixed by the parallel set-password hold-block; do not re-introduce it here.)

5. **State-B orcid happy-path test DB assertion.** In `backend/tests/routes/settings-email-fresh-auth.test.ts:578-590` (the state-B orcid-mechanism happy-path test), add the follow-up `pool.query` that asserts `pending_email === NEW_EMAIL_B`. Mirrors the other three happy-path tests (state-A password, state-B password, state-C orcid) which all include this DB-write check. Closes the asymmetry that lets a silent UPDATE regression on this branch escape.

6. **Cross-target test for set_password proof at /email.** Add one test in `settings-email-fresh-auth.test.ts`: issue a proof via `issueFreshAuthToken` with `setPasswordFreshAuthTarget(STATE_A_USER)`, submit to `POST /api/settings/email` as `STATE_A_USER`, assert 403 `FRESH_AUTH_REQUIRED` with `details.reason: 'target_mismatch'`. Defense-in-depth pin: both `set_password` and `change_email` bind to `(action, username, '')`, so collision-freedom hinges entirely on the `action` field in `computeFreshAuthTargetHash`. A future refactor consolidating both into a single `nonBroadcastFreshAuthTarget(username)` helper would silently break collision-freedom; this test catches it at the route boundary.

7. **Snapshot-and-restore `pending_email` on SMTP failure.** At `backend/src/routes/settings.ts:254-286` (email-reauth handler), before the UPDATE that writes new `pending_email` / `pending_email_token` / `pending_email_expires_at`, snapshot the row's current values into transaction-local variables. On SMTP failure (line 282-286), restore the snapshot instead of nulling. Closes the concurrent-overwrite + SMTP-fail bug where a user's first valid 24h verify link is destroyed by a second SMTP-failed change request.

8. **Add-flow no-row branch defense-in-depth guard.** At the top of the Add-flow no-row branch (`backend/src/routes/settings.ts:178-187`), add:
   ```ts
   if (req.hiveAuthMethod === 'jwt') {
     return sendError(res, 401, 'UNAUTHORIZED', 'Session is no longer valid');
   }
   ```
   The branch is currently safe by the JWT-mint-invariant (no JWT is minted before an `accounts` row exists), but the invariant is implicit across every `jwt.sign` site. The local guard makes the defense explicit at the consume point so a future feature that mints a transient JWT before INSERT cannot silently bypass the gate on this branch. Free-cost hardening (the invariant says this combo cannot legitimately occur today; the guard is dead code on every reachable path).

9. **Strip task-slug prefix from block comment.** At `backend/src/routes/settings.ts:103-127` (block comment above `POST /email`), remove only the `BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH:` prefix on the opening line. Keep the substantive WHY content (state matrix, Keychain exemption, no-row branch reasoning, ARCHITECTURE.md § 6.5 invariant #1 reference) — those are the durable citations. Strip the rotting task-slug citation per root CLAUDE.md "Don't reference the current task" rule.

## Out of scope

- Status-code split fix on the set-password handler (`settings.ts:208-230` for set-password). That's part of the parallel set-password hold-block (`backend-settings-set-password-fresh-auth.md` in `tasks/pending/`).
- `FreshAuthVerifyResult.reason` union widening to include `'wrong_mechanism'` — also in the set-password hold-block (one cleanup, two consumers).
- Custody.ts:343-344 stale `CONSENT_OP_ACTIONS` comment update — set-password hold-block.
- UI flow for prompting users to complete password or ORCID re-auth before requesting an email change. UI agent picks that up after this lands (the contract docs in `settings.md` / `orcid.md` are the spec).
- Auditing or changing `POST /api/settings/email/verify/:token` (token possession is the proof on that side; model is correct, unchanged).
- Address-format hardening (Punycode, lookalike domains). Pre-existing surface, separate task class if pursued.

## Approach

Single commit, in order:
1. Widen `orcid.ts /start` body validation + branch for `change_email` (uses `changeEmailFreshAuthTarget`).
2. Widen `custody.ts /fresh-auth` body validation + branch for `change_email` (uses `changeEmailFreshAuthTarget`).
3. Apply orcid.ts issuer-side helper adoption for `set_password` branch (item 4).
4. Add `kind_mismatch` to email-reauth handler 403 branch (item 3).
5. Add Add-flow no-row JWT guard (item 8).
6. Add SMTP-fail snapshot-and-restore (item 7).
7. Strip block-comment task-slug prefix (item 9).
8. Tests: add state-B orcid DB assertion (item 5), cross-target set_password→/email test (item 6), and one happy-path test per new mint surface (`orcid /start action='change_email'` round-trip + `custody /fresh-auth action='change_email'` round-trip) consumed at `/api/settings/email` end-to-end.

## References

- `agents/docs/ARCHITECTURE.md` § 6.4 row "Change email" (per-state matrix — updated at audit-task archive commit `492d8e9`)
- `agents/docs/api-contracts/settings.md` POST /email section (path-dependent body shape, error envelope — updated at `492d8e9`)
- `agents/docs/api-contracts/orcid.md` /start fresh_auth section (non-broadcast action semantics, `change_email` documented-pending — updated at `492d8e9`)
- `backend/src/routes/orcid.ts:333-360` (existing fresh_auth /start dispatch — widen here)
- `backend/src/routes/custody.ts:691-798` (existing password fresh-auth mint — widen here)
- `backend/src/routes/settings.ts:128-305` (email-reauth handler — items 3/7/8/9 touch this)
- `backend/src/routes/settings.ts:178-187` (Add-flow no-row branch — item 8)
- `backend/src/routes/settings.ts:254-286` (Change-flow UPDATE + SMTP-fail rollback — item 7)
- `backend/src/lib/fresh-auth.ts` `changeEmailFreshAuthTarget` (helper introduced by `b27bcdf`)
- `backend/tests/routes/settings-email-fresh-auth.test.ts` (extend tests for items 5/6 + happy-path round-trips)
- Originating review: /ce-code-review of `b27bcdf` (architect session 2026-05-16, 10-persona fan-out)
- Companion task: `backend-settings-set-password-fresh-auth.md` (held back to pending/ with HELD-PENDING-FIXES — sibling cleanup on the same fresh-auth primitive)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
