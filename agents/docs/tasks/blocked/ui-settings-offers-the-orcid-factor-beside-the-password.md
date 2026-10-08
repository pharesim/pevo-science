# Settings offers the ORCID factor beside the password for the email change, the deletion and their cancels

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Design: ARCHITECTURE.md § 6.4 "SPA factor resolution", rule 1's
exception decided 2026-10-08.

## Why

`resolvePasswordFactor` (`frontend/src/lib/fresh-auth.js`) picks the password whenever both
factors are registered, so a state B owner's email change, deletion and their cancels are always
password-proven in the web client and therefore held for 72 hours, although an ORCID-proven
change or deletion is direct. A B owner whose password was rotated by someone else also has no
in-app path to these actions, although ORCID login works.

## Scope

1. For `change_email`, `delete_account` and the two cancels, the settings page offers "Confirm
   with ORCID instead" beside the password prompt when `hasPassword` is true and the account has
   an ORCID, routing the action through the existing ORCID factor. The description says an
   ORCID-confirmed change applies when the new address confirms, without the waiting period.
2. No other action's factor resolution changes.
3. Strings in all sixteen locales per the STUBS.md convention; no emdash.
4. Unit specs: a B session can complete each of the four actions with the ORCID factor without a
   password prompt; an A session sees no ORCID option.

## Acceptance criteria

1. A B session can complete each of the four actions with the ORCID factor without a password
   prompt; an A session sees no ORCID option.
2. Every new string exists in all sixteen locales.

## Notes

- Reads whether the account has an ORCID from the status once
  `backend-settings-email-status-reports-orcid` lands `hasOrcid`; until then say in the signal
  block what the page reads instead.
- `ui-settings-shows-held-email-change-with-cancel` and `ui-settings-shows-held-deletion-with-cancel`
  add the cancel prompts this task extends; whichever lands second merges.

## [BLOCKED by Architect] (2026-10-08): sequenced behind the backend hold task

Waits for `backend-email-change-hold-and-owner-notice` to be archived, so that the "without the
waiting period" description is true when it ships. The architect moves this file to `pending/`
when that task is archived.
