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

---

## Architect re-review (2026-05-17, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on commit ac7fd31 (6 reviewers: correctness/security/adversarial on Opus; testing, maintainability, learnings-researcher on Sonnet; project-standards skipped — convention sweep established across cluster; reliability/kieran-typescript skipped — no new error-handling or type definitions in this round-1).

All 9 task-scoped items land per the task spec (mint widening, kind_mismatch in 403, snapshot-restore on SMTP fail, no-row JWT guard, helper adoption, slug strip, test additions). Four P1 findings surface in the implementation details + a pre-existing composition issue the gate-completing work failed to address.

### Items held (must fix before archive)

**1. (P1, conf 75 — cross-reviewer-promoted: security + adversarial) Pre-existing duplicate-email enumeration oracle at `backend/src/routes/settings.ts:147-162`.** The `SELECT WHERE primary_email = $1 OR pending_email = $1` runs BEFORE the fresh-auth gate at line ~205-243. A JWT-only attacker (no fresh-auth proof) probes any email and gets 409 DUPLICATE (registered) vs 401 FRESH_AUTH_REQUIRED (not registered). Pre-existing from b27bcdf (the original email-reauth landing), but newly enumerable because the fresh-auth gate now provides the contrasting 401. Task 6's gate-completing work was the natural place to fix the composition; round-1 did not.

Suggested fix: hoist the fresh-auth consume above the duplicate-email SELECTs on the Change branch. Order: (1) parse body, (2) consume fresh-auth proof, (3) only on valid proof, run the duplicate-email SELECT + UPDATE + SMTP. This closes the 401-vs-409 oracle. Architect call: keep the body-validation 400 BAD_REQUEST gates before consume (they don't disclose registration state).

**2. (P1, conf 75 — cross-reviewer-promoted: correctness + adversarial + security) Snapshot-restore concurrency race at `backend/src/routes/settings.ts:172-321`.** The SELECT-snapshot-UPDATE-SMTP-restore sequence is non-transactional. Concurrent change-email requests can interleave such that request 2 snapshots request 1's intermediate values, and an SMTP-fail on request 2 restores those values clobbering request 1's successful change.

Suggested fix (one-line scoping): scope the restore UPDATE with `WHERE username = $4 AND pending_email_token = <just-written-token>`. The just-written token is unique per request; the restore only fires if THIS request's UPDATE is still the current row state. If a concurrent request already overwrote, the restore no-ops (intended). Closes the race without adding transaction overhead.

Alternative: wrap snapshot+UPDATE+SMTP+restore in a single DB transaction with SELECT FOR UPDATE. Heavier; the WHERE-scoping is the minimal fix.

**3. (P1, conf 100, testing T1) SMTP-fail Change-flow snapshot-restore has NO test.** Production behavior change (round-1 item 7: restore `prior.pending_email` instead of NULL on SMTP fail). The only SMTP-fail test in the codebase (`settings.test.ts:376`) exercises the Add-flow branch (no existing row), not the Change-flow snapshot-restore branch. Reverting `settings.ts:315` from `prior.pending_email` to `NULL` passes all tests silently. Real regression escape, not theoretical.

Suggested fix: add a Change-flow test in `settings-email-fresh-auth.test.ts`:
1. Seed STATE_A_USER with pending_email = NEW_EMAIL_A via a prior successful change request
2. Mint a fresh proof for a second change to NEW_EMAIL_B
3. Stub `sendMail` via `vi.mocked(sendMail).mockRejectedValueOnce(...)` to fail
4. POST /api/settings/email with the new proof
5. Assert: status reflects the chosen SMTP-fail status (per finding #4 below — 500 or 200), AND DB query shows `pending_email === NEW_EMAIL_A` (restored, not nulled)

**4. (P1?, conf 75, learnings-researcher) Verify SMTP-fail status-code matches the established convention.** Per `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`, the team's established shape for SMTP failure on routes that have already written DB state is Option A (catch `sendMail`, log warn, return 200 anyway) to avoid the status-code oracle ("email known vs unknown"). If round-1's snapshot-restore branch returns 500 on SMTP fail, that creates the enumeration oracle the convention guards against.

Action: read `backend/src/routes/settings.ts` SMTP-fail branch at HEAD and verify the status code returned. If 500, either:
- (a) Move to catch+warn+200 per Option A (the documented preferred shape)
- (b) Document why this route diverges from the convention (a route that's already pre-gated by fresh-auth has different threat exposure than `/signup`'s pre-gate enumeration concern)

Architect lean: Option (a). The fresh-auth gate doesn't change the convention's logic — once DB state is written + secondary effect fails, the user-facing semantic should be "the change was queued; we'll retry mail; visit settings to see status" rather than a 500.

### Items dismissed during architect triage

- **P2 (adversarial)**: JWT-guard message distinguishability at settings.ts:196. Defense-in-depth; the JWT-mint-invariant is the load-bearing protection. Conf 50; below actionable bar.
- **P3 (adversarial)**: New task-slug citation in test file `settings-email-fresh-auth.test.ts:594` (describe-block header). Test-file slug citations are lower operational risk; consistent with the test-file-slug acceptance pattern in earlier cluster reviews.
- **P3 (correctness residual)**: `existing[0]` re-aliased as `prior = existing[0]` for the rollback block. Style consideration; below gate.
- **P3 (testing RR1)**: kind_mismatch 403 branch at /api/settings/email route-level not separately pinned. Lib-level coverage at `fresh-auth.test.ts:543` exists; cross-target test exercises the same ternary branch.
- **Cross-surface concern (adversarial)**: `consumeSessionFreshAuthToken` cross-kind accept is a documented design choice (task 3's cross-kind acceptance). Out of scope for this task.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Recommendation: items 1+2 cluster on `settings.ts` (hoist + scope-WHERE) and can land in one commit. Item 3 is a test addition. Item 4 is a verify-then-fix that may not require a code change depending on what HEAD shows.
