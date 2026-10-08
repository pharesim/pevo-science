## Light accounts can vouch and retract a vouch on the profile page (archived 2026-10-08): clean review; one P3 filed as a follow-up, stale contract prose fixed, route comment folded, composer task unblocked

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `f3cc369e` and `c064b5ea` (branch-remote, base `e5eec2ff`): correctness, security, adversarial (in-process, no cross-model peer), project-standards, testing, julik-frontend-races, learnings. Verdict "Ready to merge"; every scope item and AC met. Account-state defense review clean: states A, B and C reach the custody route under a session-kind proof, state D and a stale light JWT fail closed, and the voucher is bound server-side. Testing re-ran the signal's seven per-site mutants, all killed (the orchestrator checked each planted mutant against the brief); baseline 24/24.
- **Triage (user: "approved" as recommended):**
  - Filed: a 403-refused vouch notify shows success-pending copy (P3, validator-confirmed, incidence not measured; unaccredited Keychain viewers already reached it), plus the ignored `accreditation_outcome` timeout and chain-error copy -> `ui-vouch-notify-refusal-shows-success-copy` (normal). Narrowed at filing to the vouch handler: the vouch status read lists only accredited vouchers, so `canRetract` is false for a voucher outside the accredited set, and the retract twin is out of scope.
  - Fixed in place: `api-contracts/common.md` "What Still Requires Keychain" now names both signing paths, and `accreditation.md`'s two notify sentences drop "via Hive Keychain" (`443e06dd`).
  - Folded: the `POST /vouch` route comment in `routes/wot.ts` ("via Hive Keychain") -> `backend-wot-comments-cite-deleted-retract-suite`.
  - Unblocked: `ui-composer-surfaces-navigate-over-undrafted-work` moved to `pending/`, as its 2026-10-01 sequencing note prescribed.
  - Dismissed: no spec runs the handlers under light custody and none mounts the profile template (speculative: the handlers read no custody and the template binds the tested getters directly). The lost-notify auto-accreditation gap is covered by `backend-wot-enrollment-has-a-single-trigger`. The global re-auth modal outliving an SPA navigation is shared with votes and comments, user-started and password-gated.
- **Learnings checkpoint:** no `solutions/` entry names `isLightAccount` or `wot.keychainRequiredToVouch` or claims light accounts cannot vouch (learnings reviewer grep), so none is contradicted. No new entry: the one finding is a plain bug, filed as a task.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

## Why

Light accounts are meant to vouch (user decision, 2026-10-01). The profile page hides both
forms from them: `canVouch` and `canRetract` in `frontend/src/components/vouch-section.js` carry
`!this.isLightAccount`, and `frontend/src/pages/profile.js` renders `wot.keychainRequiredToVouch`
in their place. That block only mirrored the custody broadcast's refusal, which
`backend-custody-admits-vouch-and-retract` lifts.

The handlers need no new broadcast path. `handleVouch` and `handleRetract` already go through
`broadcastWithFreshAuth`, which takes a light account through the session window and the custody
route (`ARCHITECTURE.md` § 6.4, the non-consent broadcast row, which now names vouches).

## Scope

1. Drop `!this.isLightAccount` from `canVouch` and `canRetract`. Remove the `isLightAccount`
   getter if nothing else reads it.
2. Remove the light-account message branch in `profile.js` and the `wot.keychainRequiredToVouch`
   key from all 16 locale files under `frontend/public/messages/` (`STUBS.md` has no line for
   it).
3. Flip the two specs in `frontend/tests/unit/components-vouch-section.test.js` that pin the
   light-account refusal: a light account now passes `canVouch` and `canRetract` under the same
   other conditions as a Keychain account.

## Out of scope

- Keeping the relationship choice and the retraction reason across a passwordless account's
  ORCID round-trip. `ui-composer-surfaces-navigate-over-undrafted-work` covers that, after this
  task.
- The retract handler's branches on `revocation_outcome` values the backend no longer returns.

## Acceptance criteria

1. A light account sees the vouch form on an unaccredited profile it has not vouched for, and the
   retract control on one it has, and both handlers broadcast through the custody route.
2. The self, already-vouched and accredited-target conditions still hide the vouch form for a
   light account.
3. No locale file carries `wot.keychainRequiredToVouch`.
4. Each assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## [BLOCKED by Architect] (2026-10-01) — sequenced behind the backend task

Until `backend-custody-admits-vouch-and-retract` lands, a light account that submits a vouch gets
403 from the custody route and sees "Vouch failed". The architect moves this file to `pending/`
once that task is archived.

## Architect note (2026-10-06): unblocked

`backend-custody-admits-vouch-and-retract` was archived on 2026-10-01 (commit 269297e9). Moved to
`pending/`.

## UI implementation signal (2026-10-07, commits f3cc369e, c064b5ea)

Both SHAs verified on `main` with `git merge-base --is-ancestor`.

- **f3cc369e** `ui(profile): light accounts can vouch and retract a vouch`. `canVouch` and
  `canRetract` drop the light-account condition and the `isLightAccount` getter goes (no other
  reader). The profile page's light-account message branch is removed, and
  `wot.keychainRequiredToVouch` leaves all 16 locale files, one line each (`STUBS.md` had no line).
  The two refusal specs flip, and AC 2 gets three light-account specs.
- **c064b5ea** `ui(tests): pin canRetract false for an account that has not vouched`. The verification
  sweep found that flipping the light `canRetract` spec removed the file's only `false` assertion
  on `canRetract`, so a getter returning `true` passed every spec. The Keychain `canVouch` title also
  claimed a connected requirement that no spec exercises, so it was narrowed to what the spec asserts.

**Acceptance criteria**

1. Vouch form and retract control for a light account: covered by `canVouch is true for a light
   account on an unaccredited profile it has not vouched for` and `canRetract is true for a light
   account that has vouched`. The handlers are unchanged and custody-agnostic. They reach the custody
   route through `broadcastWithFreshAuth`'s light branch (`lib-fresh-auth-session-window.test.js`) and
   `broadcastOps`'s light-account path (`signer.test.js`, `light account path`). A read-only trace
   found nothing on the path that refuses a light account. `POST /api/custody/broadcast` accepts every
   field of the frontend's `vouch` and `retract_vouch` payloads, and `POST /api/wot/vouch` and
   `/api/wot/retract` accept the session JWT through `verifyHiveSignature`'s Bearer branch.
2. Self, already-vouched and accredited-target conditions for a light account: `canVouch is false
   for a light account vouching for itself`, `... that has already vouched`, `... when the target is
   accredited`. On the base commit these pass only because the light gate already hid the form, so
   each was probed against its own condition after the change (below).
3. `grep -rl keychainRequiredToVouch frontend/public/messages` is empty at f3cc369e.
4. Probes ran in a scratchpad copy (`git archive` of the commit plus a symlinked `node_modules`),
   never in the checkout. Spec file baseline: 23/23 at f3cc369e and 24/24 at c064b5ea.
   - Re-add the light gate and getter to `canVouch`: fails only `canVouch is true for a light account
     on an unaccredited profile it has not vouched for`.
   - Re-add it to `canRetract`: fails only `canRetract is true for a light account that has vouched`.
   - Drop `this.username !== this.targetUsername`: fails `canVouch is false for a light account
     vouching for itself` (and the Keychain self spec).
   - Drop `!this.currentUserHasVouched`: fails `canVouch is false for a light account that has
     already vouched`.
   - Drop `!this.isTargetAccredited`: fails `canVouch is false for a light account when the target
     is accredited` (and the Keychain accredited spec).
   - `canRetract` mutated to `return true;`, and separately to `return this.isConnected;`: each fails
     `canRetract is false for a light account that has not vouched`.
   - AC 3: restoring `de.json` from f3cc369e~1 makes the grep return `de.json`.
   - Profile template branch: no committed spec covers it. The check was a throwaway jsdom DOM with
     real Alpine mounted over the `vouchSection` element sliced from the shipped
     `profilePageTemplate`, with a light-account auth store. Unvouched target: the form renders and
     no `keychainRequiredToVouch` text appears. Vouched: retract renders and broadcasts
     `retract_vouch`. Self and accredited: no form. Clicking Vouch broadcasts `vouch` with
     `voucher: alice`. The same probe against f3cc369e~1 fails: no form, and the Keychain message
     renders. Not a browser check (agent-browser cannot start on this host). The light account now
     gets the markup Keychain accounts already had, so there is no new layout.
5. No comments were added. Test titles carry no slug, line or positional anchor, and the pre-commit
   anchor gate passed on both commits.

**Verification:** full frontend unit suite on the f3cc369e tree, 98 files / 2291 tests, exit 0, no
Errors line. `components-vouch-section.test.js` 24/24 and `tests/unit/eslint` 18/18 at c064b5ea.

**Out of scope, for follow-up filing.** Stale docs outside the ui zone that now contradict the
light-account path. Each was confirmed by an independent refuter at f3cc369e.
- `agents/docs/api-contracts/common.md:164` ("What Still Requires Keychain") lists vouch and retract
  (and publish, vote, review, which were already stale) as Keychain-only, not session-based.
- `agents/docs/api-contracts/accreditation.md:326` and `:360`: "The frontend must first broadcast the
  `vouch` / `retract_vouch` custom_json via Hive Keychain".
- `backend/src/routes/wot.ts:127-128` route comment: "broadcasts the vouch custom_json via Hive
  Keychain" (narrow by dropping "via Hive Keychain").
- `blocked/ui-composer-surfaces-navigate-over-undrafted-work.md` still describes the old gate. It is
  coordination text, so it is left to the architect.

**Learnings checkpoint:** the only `agents/docs/solutions/` entry naming the touched symbols
(`implementer-signal-todo-ui-block-2026-05-16.md`) cites `vouch-section.js` as a historical
fresh-auth call site, which nothing here contradicts. No new entry qualified: the vacuous-on-base
specs were caught by the task's own AC 4 probe rule.

## State G rows: unverified-email lifecycle and token scoping (archived 2026-10-07): two rounds; held on the recover oracle comment and the resend token write, clean re-review; [TODO Architect] docs applied, follow-ups filed, one dismissed

### Architect archive note (2026-10-07)

- **Re-review:** `/ce-code-review` full path on `8f4a8287` and `09e006ed` (branch-remote via a synthetic head holding the four backend files; base `9ca30584`; interleaved task-file commits excluded): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Verdict "Ready to merge", zero findings. Both hold items fixed: the oracle claim deleted in `recover.ts` and the test header, matching the hold's literal forms; the resend UPDATE keyed on the token read, with no mail on no match. A real-path race probe (base vs head, `pool.query` spy plus a held row lock) reproduced the hold's defect at base (a finalized light row left holding a signup hex token) and showed it gone at head for finalize, confirm, delete and a concurrent resend; the uncontended and expiry-bump cases still mail once. Testing re-ran the signal's seven green claims alone (all exit 0); mutants on the happy path were killed (the orchestrator re-ran one), and dropping the token conjunct survives, as the hold accepted.
- **Triage (user: "approved" as recommended):**
  - Filed: the resend comment's "the token read above" (P3 residual) and the anchor rot in `auth-log-shape.test.ts` and `recover.test.ts` -> `backend-test-comment-anchors-and-resend-comment` (low).
  - Filed: the shared custody ORCID, the `recover_%` cleanup wildcard and the `auth.test.ts` notifications timeout (first signal's test-isolation list) -> `backend-route-test-isolation-and-a-notifications-timeout` (low).
  - Folded: the `/login` expired-signup DELETE keyed on `id` alone -> `backend-verify-link-argon-spec-and-expiry-delete-key`.
  - Filed: `[TODO UI]` items 1 and 2 -> `ui-pending-unverified-and-no-password-set-copy` (normal).
  - Folded: `[TODO UI]` item 3 (every settings email call sends the Bearer JWT, so a Keychain user's add flow gets 401) -> `ui-state-d-session-settings-critical-actions`, widened to every `'self'` session and raised to high.
  - Dismissed: the `/resume-signup` UPDATE keyed on `id` alone. It does not fire today: `/confirm` and `/link` select by the `confirmed:` token, the login pending block and the cleanup's signup arms are scoped to `username IS NULL`, and its G arm needs a hex token.
  - Noted only: an unverified G row can be kept alive by re-issuing, blocking another Keychain user's settings add (409). Signup is not blocked, because signup evicts the claim.
- **[TODO Architect]:** applied in `8d27a8f3` (§ 6.3 eviction transition; § 6.4 change-email add-flow 401 and re-issue, ORCID recovery on the derived claim, set-password `PENDING_UNVERIFIED`; `auth.md`, `settings.md` and `orcid.md` per the list). Two oracle claims the code contradicts were deleted on the way (the recover 401 contract and the § 6.4 ORCID-recovery row). Overlap recorded on `architect-accreditation-docs-drift-sweep` (item 4 done, item 3 partly).
- **Learnings checkpoint:** no entry contradicted (learnings reviewer plus a grep for resend-verification, `WHERE id = $3`, custody oracle and token-keyed writes); no hold-time entries to refresh. No new entry: guidance 3 of `mailed-credential-token-dies-with-its-address-and-credential` already states the token-keyed write principle.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced by the state-G sweep on the account-state comments task (its signal block,
"Needs triage", items 1-11). The user triaged every item to "fix" on 2026-10-05 and
made two decisions:

- **Unverified G rows: verify the email first.** A state G row (ARCHITECTURE.md § 6.1)
  whose settings-registered email is still unverified may not acquire auth factors:
  setting a password and linking an ORCID are refused until the email is verified. An
  expired unverified G row then carries nothing but the email claim, so the hourly
  cleanup may keep deleting it (back to the no-row case, email released). Login never
  deletes a G row. Re-adding an email on an unverified G row re-sends its verification
  link instead of going through the change flow.
- **Include the two pending sibling tasks** in the same pass:
  `backend-signup-upsert-overwrites-finalized-row` and
  `backend-settings-verify-clears-any-row-token`. Each keeps its own task file, signal
  block and move to review.

The signup flow itself is unchanged: signup rows (E/F) have `username` NULL and never
reach the G-only branches. The one signup-visible change comes from the upsert task: a
signup for an email an unverified G row holds answers 409 until that claim expires and
is reaped (at most the 24h link expiry plus the hourly cleanup).

## Scope

1. **Login (`POST /api/auth/login`).** The pending-signup branch (PENDING_SIGNUP,
   PENDING_UNVERIFIED, the expiry DELETE and SIGNUP_EXPIRED) applies only to signup rows
   (`username` NULL). A G row with a password and an unverified email logs in normally
   and is never deleted here.
2. **Signup cleanup (`signup-cleanup.ts`).** Signup rows keep today's two expiry arms. A G
   row is deleted only when its email is unverified (hex `verify_token`), its link has
   expired, and it carries no password and no ORCID. A G row carrying a factor (a legacy
   row from before the gates in items 6-7) is never deleted by the job.
3. **Signup verify link (`POST /api/auth/verify`).** The token lookup is scoped to signup
   rows (`username` NULL). A G row's settings token answers exactly what an unknown token
   answers, and the row is untouched.
4. **Resend verification (`POST /api/auth/resend-verification`).** A row with `username`
   set (any finalized row, G included) is treated as not pending: uniform message, no
   token rewrite, no mail. Timing equalisation is preserved.
5. **ORCID recovery (`POST /api/auth/recover`, ORCID method).** Refused for any row whose
   custody claim is not light (`custodyClaimFor`), which excludes G as well as D, with the
   same 401 and generic message the upgraded and no-ORCID branches already return. This
   matches § 6.4 (ORCID recovery: B and C). The seed-phrase method already excludes G and
   D (no `memo_key_enc`).
6. **Set password (`POST /api/settings/set-password`).** Refuses a G row whose email is
   unverified (409 `PENDING_UNVERIFIED`, an existing error code).
7. **ORCID link and accredit (`/api/orcid` callback, `mode='link'` and `mode='accredit'`).**
   Refuse, before any broadcast, a caller whose row is a G row with an unverified email
   (409 `PENDING_UNVERIFIED`). A caller with no row is unaffected. Accredit is included
   because it writes the same `accounts.orcid` factor onto the row.
8. **Settings email.** (a) `POST /api/settings/email` on an existing unverified G row
   re-issues the add-flow verification (new `email`, `verify_token`, `expires_at`)
   instead of writing the pending-change fields; the JWT-path fresh-auth gate and the
   duplicate checks are unchanged. (b) The verify handler's change branch also clears a
   hex `verify_token`, since proving control of the new address verifies the row's email
   (legacy rows that used the change flow while unverified). (c) The add-flow lookup in
   the verify handler is scoped per `backend-settings-verify-clears-any-row-token`.
9. **Signup upsert** per `backend-signup-upsert-overwrites-finalized-row`.
10. **Login `NO_PASSWORD_SET` message.** One uniform message that is true for every
    passwordless row and leaks nothing per row (the branch is unauthenticated).
11. **Comments.** The JWT-path-equals-light-account comments (`admin-roster.ts`,
    `validation.ts`, `accreditation-metadata.ts`) and the "no-row-before-JWT invariant"
    comments (`settings.ts`, `settings-email-fresh-auth.test.ts`), plus every comment the
    code changes above make stale.
12. **Test data.** `settings-email-delete-fresh-auth` seeds a real § 6.1 shape; the
    migration 017 test title names G's NULL column.

## Acceptance criteria

1. Each behaviour in items 1-10 is pinned by a route or job test that fails against the
   pre-change code and passes after it.
2. No new error code: refusals reuse `PENDING_UNVERIFIED`; the recovery refusal reuses the
   existing 401 envelope.
3. Timing equalisation and uniform messages are preserved on every unauthenticated branch
   touched (login, resend, signup, recover).
4. No new writer of `accounts.updated_at`.
5. Comment-anchor conventions hold in everything written.

## Architect note (2026-10-05): item 10 and its comment

The `/login` `NO_PASSWORD_SET` comment in `routes/auth.ts` currently names one row whose
remedies the message misses: a state G row with no ORCID. That list is incomplete. A null-hash D
row (upgraded from C, or an ORCID-path `/link` D) cannot recover by seed phrase either (no
`memo_key_enc`) and is past ORCID recovery once `upgraded_at` is set. A pending ORCID-path F
row also reaches this branch, because the null-hash check runs before the pending checks. When
item 10 makes the message uniform, rewrite that comment so it lists no closed set of
exceptions. The architect updates the 403-versus-401 rationale in `api-contracts/auth.md` at
review. Say in the signal block what the final message is.

## Backend implementation signal (2026-10-05, commit d33792ce)

