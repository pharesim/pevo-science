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

---

## Backend re-review signal (2026-05-17, commit 9ceb65e)

All four round-2 hold items landed at commit `9ceb65e` (clean `backend(change-email-mint-path-and-followups)` prefix). The originally-staged version of this work briefly landed inside the architect's concurrent compound-learnings commit at `30ce45a` due to a shared-index race; the architect then rebased that SHA to `db2d289` (solution docs only) and my backend code was re-staged + re-committed as `9ceb65e`. Scope `/ce-code-review` to `backend/src/routes/settings.ts`, `backend/tests/routes/settings-email-fresh-auth.test.ts`, and `backend/tests/routes/settings.test.ts` at `9ceb65e`.

**Item 1 (hoist):** `backend/src/routes/settings.ts:129-258`. Handler order is now `(1) body validate → (2) SELECT existing → (3) Change-branch+JWT fresh-auth + mechanism check → (4) Add-branch JWT-rejection guard → (5) duplicate-email SELECTs → (6) INSERT/UPDATE → (7) sendMail`. A JWT-only attacker without a proof now gets 401 regardless of whether the candidate email is registered to another account. The body-validation 400 still runs before consume per architect call ("they don't disclose registration state"). Updated block comment at `:101-148` documents the load-bearing ordering.

**Item 2 (snapshot-restore scoping):** `backend/src/routes/settings.ts:295-302`. Restore UPDATE now carries `AND pending_email_token = $5` where `$5` is the just-written token. If a concurrent change-email request already overwrote the row, the restore no-ops rather than clobbering its in-flight state. No transaction overhead.

**Item 4 (SMTP-fail → 200 + warn):** `backend/src/routes/settings.ts:267-307`. Catch sendMail error, log `warn` with `{event, route, email_hash, username, err}`, rollback DB state (DELETE on Add; restore-with-token-scope on Change), fall through to uniform 200. Matches Option A from `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` and the canonical shape in `auth.ts:667-678`. The level moved from `error` to `warn` per the convention ("delivery-gap metric, not availability incident").

**Item 3 (test):** `backend/tests/routes/settings-email-fresh-auth.test.ts:790-901`. New describe block "Change-flow SMTP fail restores prior pending_email" seeds a prior pending change to NEW_EMAIL_A, queues `smtpMock.sendMail.mockRejectedValueOnce(...)`, submits a second change to NEW_EMAIL_B, asserts status 200 + DB row's `pending_email` and `pending_email_token` still equal the prior values (not NEW_EMAIL_B, not NULL). Requires the SMTP mock refactor to vi.hoisted (lines 73-83) so per-test rejection can be queued; default behavior still resolves successfully so the other 17 tests in the file are unaffected.

**Companion test update:** `backend/tests/routes/settings.test.ts:376-432` (Add-flow smtp_send_failed log shape) updated to assert status 200 + `logger.warn` instead of status 500 + `logger.error`, matching item 4's behavior change.

### Verification

- `npm run typecheck` (src + tests): clean.
- `npx vitest run` against `settings.test.ts` (24) + `settings-email-fresh-auth.test.ts` (17) + `settings-set-password.test.ts` (8) + `auth-log-shape.test.ts` (9) = 58 tests, all pass. The new SMTP-fail Change-flow test triggers the `settings.email_post.smtp_send_failed` warn emission and asserts the restored prior values.

### Items left untouched

- The architect's P2/P3 dismissals during round-1 triage (JWT-guard message distinguishability, test-slug citation, `existing[0]` re-aliasing, route-level kind_mismatch separate pin, cross-kind acceptance) — all dismissed by architect, no action.
- The `auth-gate-revives-pre-existing-read-side-oracle-2026-05-17.md` learning (one of the two architect solution-docs that landed in the same SHA) captures the round-2 item-1 pattern for future reuse — referenced for context, not part of this task's deliverable.

---

## Architect re-review (2026-05-18, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` on the round-2 hold-fix commit (10 reviewers — correctness + security + adversarial on Opus; testing/reliability/maintainability/api-contract/project-standards/kieran-typescript/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The four round-1 hold items all landed in intent — handler reorder closes the JWT-without-proof account-existence oracle correctly (verified across all four return points), snapshot-restore WHERE-scope correctly references the just-written token, the new Change-flow SMTP-fail test asserts both `pending_email` and `pending_email_token` restoration, and SMTP-fail status moves to uniform 200 + `warn` per the Option A canonical shape.

Four items held — three are mutation-kill / observability gaps on the load-bearing round-2 fixes, one is a self-violation audit miss from the round-2 commit's own comment edits. Plus comment-anchor cleanup across modified test files.

### Items held (must fix before archive)

**1. (P1, conf 100, 3 reviewers — maintainability + project-standards + kieran-typescript) Comment-anchor cluster in production and test source.** Multiple rot classes co-occur in the round-2 diff:

  - `backend/src/routes/settings.ts` Change-branch comment block: contains a line-number anchor `custody.ts:372-377` that drifted (the cited mapping in `custody.ts` has moved during prior reorders). Replace with a stable-symbol anchor — e.g., "Mirror the sibling mapping in the `consumeFreshAuthToken` result handler in `custody.ts`."
  - `backend/src/routes/settings.ts` Add-branch JWT-rejection guard: uses raw `req.hiveAuthMethod === 'jwt'` instead of the local `isJwtPath` alias declared two lines above. The Change-branch correctly uses `isJwtPath`. One-token harmonization — replace the raw expression with `isJwtPath`.
  - `backend/tests/routes/settings-email-fresh-auth.test.ts` new describe-block header: contains a task-slug citation (`BACKEND-CHANGE-EMAIL-MINT-PATH-AND-FOLLOWUPS`), four round/item qualifiers (`round-2 item 3`, `round-1 item 7`, `round-2 item 4`, `round-2 item 2`), and a line-number anchor (`settings.test.ts:376`). Rewrite to a behavioral describe header — e.g., "Change-flow SMTP-fail: prior pending_email triple is restored, not nulled; status is 200 not 500. Differential test contrasts with the Add-flow SMTP-fail spec in `settings.test.ts`."
  - Same test file, inline `it()` comments under the new describe: contain `Round-2 item 4` and `Round-1 item 7 + round-2 item 2` qualifiers. Strip the `Round-N item N:` prefixes; keep the behavioral rationale.
  - `backend/tests/routes/settings.test.ts` modified test comments at the Add-flow SMTP-fail spec: add `Round-2 item 4: ...` prefixes and retain a `Round-1 hold-fix item 1` qualifier. Strip the round/item prefixes; keep the behavioral rationale (log level is `warn`, status is 200, `err` field is an Error instance).

  Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the rewrite prose must not introduce new task-slug citations, round-N markers, line-number anchors, or SHA references.

**2. (P2, conf 75, testing + security) No regression test for the JWT-without-proof + registered-other-email 401-uniformity invariant (item 1's load-bearing oracle closure).** The round-1 item-1 fix reordered the handler so the JWT-path fresh-auth consume runs BEFORE the duplicate-email SELECTs — closing the 401-vs-409 enumeration oracle. The new test added for round-2 covers the SMTP-fail Change-flow path (item 3) but NO test exercises the item-1 invariant: a JWT-bearing request with NO `fresh_auth_proof` and a `new_email` value that IS registered to ANOTHER account must return uniform 401 `FRESH_AUTH_REQUIRED`, not 409. A regression reverting the hoist would return 409 for a registered-email probe; the existing tests would not fail.

  Suggested fix: add one spec in `backend/tests/routes/settings-email-fresh-auth.test.ts`:
  1. Seed `OTHER_USER` with email `OTHER_EMAIL`.
  2. POST `/api/settings/email` with `STATE_A_USER`'s JWT (no `fresh_auth_proof` in body), `new_email: OTHER_EMAIL`.
  3. Assert status `401`, `code: 'FRESH_AUTH_REQUIRED'`.
  4. Optional companion: same request with `new_email: UNREGISTERED_EMAIL` also returns 401 with identical envelope shape (uniformity assertion).

**3. (P2, conf 75, 3 reviewers — testing + reliability + correctness) Concurrent-overwrite WHERE-scope no-op not directly tested.** The round-1 item-2 fix scoped the SMTP-fail Change-flow restore UPDATE with `WHERE username = $4 AND pending_email_token = $5` (the just-written token). The new round-2 SMTP-fail test exercises a SINGLE-request scenario where the just-written token IS the current row state — the restore fires identically whether the `AND pending_email_token = $5` clause is present or absent. A mutation dropping the scope clause passes the test silently.

  Suggested fix: add one spec that simulates the concurrent-overwrite race. Use the SMTP mock's rejection callback to mutate the DB row mid-flight:
  ```
  vi.mocked(sendMail).mockImplementationOnce(async () => {
    await pool.query(
      'UPDATE users SET pending_email=$1, pending_email_token=$2 WHERE username=$3',
      [NEW_EMAIL_C, TOKEN_C, STATE_A_USER],
    );
    throw new Error('SMTP fail');
  });
  ```
  Then POST `/api/settings/email` with `new_email: NEW_EMAIL_B`. Assert status 200 + DB row's `pending_email === NEW_EMAIL_C` and `pending_email_token === TOKEN_C` (the concurrent winner's state survives; the restore no-ops because its WHERE clause's token no longer matches).

**4. (low, conf 90, reliability + adversarial) Restore UPDATE `rowCount` discarded — operator log cannot distinguish "rolled back" vs "raced and skipped".** The round-2 SMTP-fail Change-flow restore UPDATE silently no-ops when a concurrent change-email request has already overwritten the row. The single `logger.warn` emission with `event: 'settings.email_post.smtp_send_failed'` fires before the restore attempt and carries no information about whether the restore actually wrote anything back. An operator responding to an SMTP outage incident cannot tell from the log stream whether "rolled back successfully" or "raced — prior write already in-flight, restore skipped." The `rowCount` from the restore query is available but discarded.

  Suggested fix: capture the result of the restore UPDATE; when `result.rowCount === 0`, emit an additional `logger.warn` with a distinct event discriminator (e.g., `event: 'settings.email_post.smtp_fail_restore_raced'`, carrying `username` and `email_hash`) so the operator can tell the difference. Minimal additional log volume — fires only on the race path, not the normal SMTP-fail path.

### Items dismissed during architect triage

- **(P2, conf 80, api-contract AC-02) Frontend `frontend/src/pages/settings.js` shows success toast on SMTP-fail 200 (user believes email was dispatched when none was).** UI-zone follow-up; filed as a new pending task `ui-settings-email-smtp-fail-copy-soft-hint.md` for the UI agent to soften the existing success copy with a "if nothing arrives, try again" hint. Non-breaking, doesn't disclose SMTP state. Not held against this task.
- **(medium, adversarial) Double-SMTP-fail same-user cascade — B's snapshot captures A's transient pending_email; B's restore writes A's never-delivered token back.** Bounded blast radius: same authenticated owner; the user is restoring their own prior state. Below the actionable bar.
- **(P1, conf 90, api-contract AC-01) `agents/docs/api-contracts/settings.md` doesn't document the 500→200 SMTP-fail status change.** Architect-zone — landed at cluster archive time as part of the api-contracts sweep.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Items 1-4 touch a mix of `backend/src/routes/settings.ts`, `backend/tests/routes/settings-email-fresh-auth.test.ts`, and `backend/tests/routes/settings.test.ts`. Implementer's call whether one bundled commit or two (`comment-anchor + alias` first, then `tests + observability`); either works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-19, commit SHA `e22273c`)

All four round-3 hold items addressed in one bundled commit:

**Item 1 (P3, maintainability+project-standards) — Comment-anchor cleanup across production and test source.** Replaced line-number anchors at the `custody.ts` consent-path handler / `settings.ts` change-email handler with stable-symbol anchors (e.g. "the consent-path `consumeFreshAuthToken` result handler in `custody.ts`", "the sibling change-email handler at `POST /api/settings/email`"). Harmonized the Add-flow JWT-rejection guard to use the local `isJwtPath` alias (one-token consistency with the Change-branch). Stripped Round-N / item-N qualifiers from inline `it()` comments in `settings-email-fresh-auth.test.ts` and `settings.test.ts`. Rewrote the new describe-block header behaviorally (contrasting Change-flow restore against Add-flow DELETE). Audit-own-replacement clear — no new task slugs, SHAs, or line-number anchors introduced. One additional adjacent line-number anchor in the set-password status-mapping comment was fixed under the audit-own-replacement rule.

**Item 2 (P2, security+adversarial) — JWT-without-proof account-existence oracle closure regression test.** Two new specs in `settings-email-fresh-auth.test.ts` assert that a JWT-bearing request with no `fresh_auth_proof` returns uniform 401 `FRESH_AUTH_REQUIRED` whether `new_email` IS or IS NOT registered to another account. Mutation kill: a regression reverting the handler ordering (consume BEFORE duplicate-email SELECT) would surface as a 409 leak on one of the two specs.

**Item 3 (P1, correctness+adversarial) — Concurrent-overwrite WHERE-scope direct test.** New spec simulates a concurrent change-email request landing mid-flight by mutating the row inside the sendMail rejection callback. Asserts the restore UPDATE's `AND pending_email_token = <just-written>` clause no-ops, preserving the concurrent winner's state. A mutation that drops the scope clause would surface as the winner's state being clobbered. A companion spec asserts the new `settings.email_post.smtp_fail_restore_raced` warn fires on the race path only.

**Item 4 (low, reliability+adversarial) — Restore-UPDATE rowCount observability.** SMTP-fail Change-flow restore now captures `result.rowCount` and emits a distinct `settings.email_post.smtp_fail_restore_raced` warn when the restore no-ops (race path). Operators responding to SMTP-outage incidents can distinguish "rolled back successfully" from "raced — prior write already in-flight, restore skipped" via log discriminator. Fires on race path only; no added volume to the normal SMTP-fail path.

**Verification gates (run from `backend/`):**
- `npm run typecheck` (`:src` + `:tests`): clean.
- `npm run lint`: clean.
- `npx vitest run tests/routes/settings-email-fresh-auth.test.ts`: 23/23 pass.
- `npx vitest run tests/routes/settings.test.ts`: 22/22 pass.

**Deviations:** None. Pre-existing rot patterns elsewhere in the test files (`BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH` header, `orcid.test.ts` line-number citations) were out of round-3 scope and left untouched; they belong to separate audit-passes if surfaced.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-21, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` on the round-3 commit ran with always-on personas + security/adversarial/reliability/kieran-typescript. All four round-3 items land correctly: comment-anchor cleanup is exhaustive (no slugs/round-N markers/line-number anchors/SHAs reintroduced); the two oracle-closure regression specs mutation-kill a reorder revert; the concurrent-overwrite WHERE-scope spec mutation-kills a drop of the `AND pending_email_token = $5` clause; the new `settings.email_post.smtp_fail_restore_raced` warn fires only on the race path and mirrors the sibling event's PII shape (`email_hash`, not raw email). One item held — error-propagation gap that re-opens the status-code oracle round-2 closed.

### Item held (must fix before archive)

**1. (P1, conf 75, reliability) SMTP-fail catch block's rollback queries lack inner try/catch, allowing a rollback throw to escape to the outer 500 handler and reopen the 401-vs-409-vs-500 enumeration oracle.** The Change-flow restore UPDATE (round-2 item 7's snapshot-restore + round-2 hold item 2's WHERE-scope) and the Add-flow DELETE (pre-existing) both run inside the SMTP-fail catch with no inner try/catch. If the rollback query itself throws (Postgres deadlock, statement timeout, transient pool connection blip), the error propagates out of the SMTP-fail catch.

The round-2/round-3 oracle closure rests on uniform 200 + `warn` on SMTP failure (Option A canonical shape from `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`). When the rollback throws unguarded, the route's outer error handler converts it to 500, and the envelope shape varies:

- Happy path SMTP fail → 200 (Option A)
- SMTP fail + rollback throw → 500 (escapes the catch)

An attacker who can deliberately induce rollback contention (e.g., burst-rate-limited concurrent change-email requests targeting the same row) can drive the 500 branch for SOME inputs and not others, re-opening a differential-error oracle.

Fix shape:
- Wrap the Change-flow restore UPDATE and the Add-flow DELETE in their own try/catch inside the SMTP-fail handler.
- On rollback failure: emit a distinct discriminator warn event (e.g., `settings.email_post.smtp_fail_rollback_failed`) carrying the same field shape as the sibling `smtp_send_failed` warn (`{event, route, email_hash, username, err}`), then fall through to the uniform 200 return.
- Mirror the round-3 pattern: the new event fires only on the rollback-failure path (`catch` of the inner try/catch), preserving the logging-minimal posture on the normal SMTP-fail path.

Test addition (mutation-kill the inner try/catch):
- Stub the restore UPDATE / Add-flow DELETE to reject (mock `pool.query` for the specific rollback statement to throw a Postgres-like error, or wrap with `mockRejectedValueOnce` on the right call), trigger an SMTP failure on the same request, assert status 200 (NOT 500), assert the new `smtp_fail_rollback_failed` warn fires. A regression that removes the inner try/catch flips the assertion red.

### Items dismissed at architect triage

- **(advisory, learnings) Race-path warn field shape `{event, route, email_hash, username}` deviates from the `timing-equalization-smtp-failure-mode-oracle` convention's prescribed `{err, route, emailKnown}`.** Documented as reasonable: no Error exists at the rowCount-check point; the new shape mirrors the sibling `smtp_send_failed` and preserves CNPD PII posture. Convention doc may benefit from a clarifying note at next refresh.
- **(advisory, learnings) Semantic-siblings sweep — `orcid.ts /fresh-auth` and `custody.ts /fresh-auth` may carry residual line-number anchors from the round-1 mint widening that were not audited.** Filed-by-reference to a future convention sweep if anchor rot is observed during a later review pass; not held against this task.
- Pre-existing comment-anchor rot in `settings.test.ts` (BE-LOG-SHAPE-CONVERGENCE-SIBLING-FILES slug, settings.ts:315 line anchor) is outside the round-3 diff hunks — pre_existing, deferred to a future sweep if surfaced.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-4 architect review scopes `/ce-code-review` to the round-4 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
