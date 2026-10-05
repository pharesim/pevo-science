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
