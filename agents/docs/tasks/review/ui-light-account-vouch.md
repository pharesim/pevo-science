# Light accounts can vouch and retract a vouch on the profile page

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
