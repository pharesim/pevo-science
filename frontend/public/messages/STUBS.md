# Pending translation stubs

This file is the single source of truth for i18n keys that ship in non-English
locale files as raw English placeholders, pending a real translation. See
`agents/ui/CLAUDE.md` § Internationalization for the convention.

## Format

One line per locale/key pair, grouped under a dated sub-heading that names
the sweep (task slug) that introduced the key. Each sub-heading is
`### Added <YYYY-MM-DD> (<TASK-SLUG>)`.

```
<locale>: <key>
```

Example: `ar: upgrade.failed`

## How to use this file

Translators: pick a sweep section (freshness is descending top-to-bottom
within the same date; oldest sweeps float to the top). Translate the
English value of each listed key into the target locale in the matching
`public/messages/<locale>.json` file, then delete the matching
`<locale>: <key>` line from the section in the same commit. A section
with no remaining lines can be deleted entirely. Sweeps ship as batches,
so finishing one section at a time is usually the cleanest unit of work.

Sweep authors: when appending new stubs for a new sweep, add a new
`### Added <YYYY-MM-DD> (<TASK-SLUG>)` sub-heading at the bottom of the
`## Pending` section. Do not merge new entries into an existing sweep's
list. A fresh header per sweep is what lets translators prioritize and
lets stale-entry detection be archeological rather than manual.

## Pending

### Added 2026-04-21 (FE-UPGRADE-CREDENTIAL-WIPE)

ar: upgrade.failed
cs: upgrade.failed
da: upgrade.failed
de: upgrade.failed
es: upgrade.failed
fa: upgrade.failed
fr: upgrade.failed
he: upgrade.failed
it: upgrade.failed
nl: upgrade.failed
pl: upgrade.failed
pt: upgrade.failed
sv: upgrade.failed
tr: upgrade.failed
zh: upgrade.failed

### Added 2026-04-21 (FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP)

ar: settings.passwordUpdateFailed
cs: settings.passwordUpdateFailed
da: settings.passwordUpdateFailed
de: settings.passwordUpdateFailed
es: settings.passwordUpdateFailed
fa: settings.passwordUpdateFailed
fr: settings.passwordUpdateFailed
he: settings.passwordUpdateFailed
it: settings.passwordUpdateFailed
nl: settings.passwordUpdateFailed
pl: settings.passwordUpdateFailed
pt: settings.passwordUpdateFailed
sv: settings.passwordUpdateFailed
tr: settings.passwordUpdateFailed
zh: settings.passwordUpdateFailed
ar: settings.emailUpdateFailed
cs: settings.emailUpdateFailed
da: settings.emailUpdateFailed
de: settings.emailUpdateFailed
es: settings.emailUpdateFailed
fa: settings.emailUpdateFailed
fr: settings.emailUpdateFailed
he: settings.emailUpdateFailed
it: settings.emailUpdateFailed
nl: settings.emailUpdateFailed
pl: settings.emailUpdateFailed
pt: settings.emailUpdateFailed
sv: settings.emailUpdateFailed
tr: settings.emailUpdateFailed
zh: settings.emailUpdateFailed
ar: settings.emailDeleteFailed
cs: settings.emailDeleteFailed
da: settings.emailDeleteFailed
de: settings.emailDeleteFailed
es: settings.emailDeleteFailed
fa: settings.emailDeleteFailed
fr: settings.emailDeleteFailed
he: settings.emailDeleteFailed
it: settings.emailDeleteFailed
nl: settings.emailDeleteFailed
pl: settings.emailDeleteFailed
pt: settings.emailDeleteFailed
sv: settings.emailDeleteFailed
tr: settings.emailDeleteFailed
zh: settings.emailDeleteFailed
ar: settings.orcidLinkFailed
cs: settings.orcidLinkFailed
da: settings.orcidLinkFailed
de: settings.orcidLinkFailed
es: settings.orcidLinkFailed
fa: settings.orcidLinkFailed
fr: settings.orcidLinkFailed
he: settings.orcidLinkFailed
it: settings.orcidLinkFailed
nl: settings.orcidLinkFailed
pl: settings.orcidLinkFailed
pt: settings.orcidLinkFailed
sv: settings.orcidLinkFailed
tr: settings.orcidLinkFailed
zh: settings.orcidLinkFailed

### Added 2026-04-22 (FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND)

ar: signIn.resendFailed
cs: signIn.resendFailed
da: signIn.resendFailed
de: signIn.resendFailed
es: signIn.resendFailed
fa: signIn.resendFailed
fr: signIn.resendFailed
he: signIn.resendFailed
it: signIn.resendFailed
nl: signIn.resendFailed
pl: signIn.resendFailed
pt: signIn.resendFailed
sv: signIn.resendFailed
tr: signIn.resendFailed
zh: signIn.resendFailed
ar: login.loginFailed
cs: login.loginFailed
da: login.loginFailed
de: login.loginFailed
es: login.loginFailed
fa: login.loginFailed
fr: login.loginFailed
he: login.loginFailed
it: login.loginFailed
nl: login.loginFailed
pl: login.loginFailed
pt: login.loginFailed
sv: login.loginFailed
tr: login.loginFailed
zh: login.loginFailed
ar: login.resendFailed
cs: login.resendFailed
da: login.resendFailed
de: login.resendFailed
es: login.resendFailed
fa: login.resendFailed
fr: login.resendFailed
he: login.resendFailed
it: login.resendFailed
nl: login.resendFailed
pl: login.resendFailed
pt: login.resendFailed
sv: login.resendFailed
tr: login.resendFailed
zh: login.resendFailed
ar: login.orcidStartFailed
cs: login.orcidStartFailed
da: login.orcidStartFailed
de: login.orcidStartFailed
es: login.orcidStartFailed
fa: login.orcidStartFailed
fr: login.orcidStartFailed
he: login.orcidStartFailed
it: login.orcidStartFailed
nl: login.orcidStartFailed
pl: login.orcidStartFailed
pt: login.orcidStartFailed
sv: login.orcidStartFailed
tr: login.orcidStartFailed
zh: login.orcidStartFailed
ar: signup.orcidStartFailed
cs: signup.orcidStartFailed
da: signup.orcidStartFailed
de: signup.orcidStartFailed
es: signup.orcidStartFailed
fa: signup.orcidStartFailed
fr: signup.orcidStartFailed
he: signup.orcidStartFailed
it: signup.orcidStartFailed
nl: signup.orcidStartFailed
pl: signup.orcidStartFailed
pt: signup.orcidStartFailed
sv: signup.orcidStartFailed
tr: signup.orcidStartFailed
zh: signup.orcidStartFailed
ar: signup.submitFailed
cs: signup.submitFailed
da: signup.submitFailed
de: signup.submitFailed
es: signup.submitFailed
fa: signup.submitFailed
fr: signup.submitFailed
he: signup.submitFailed
it: signup.submitFailed
nl: signup.submitFailed
pl: signup.submitFailed
pt: signup.submitFailed
sv: signup.submitFailed
tr: signup.submitFailed
zh: signup.submitFailed
ar: signup.resendFailed
cs: signup.resendFailed
da: signup.resendFailed
de: signup.resendFailed
es: signup.resendFailed
fa: signup.resendFailed
fr: signup.resendFailed
he: signup.resendFailed
it: signup.resendFailed
nl: signup.resendFailed
pl: signup.resendFailed
pt: signup.resendFailed
sv: signup.resendFailed
tr: signup.resendFailed
zh: signup.resendFailed
ar: seedPhrase.createAccountFailed
cs: seedPhrase.createAccountFailed
da: seedPhrase.createAccountFailed
de: seedPhrase.createAccountFailed
es: seedPhrase.createAccountFailed
fa: seedPhrase.createAccountFailed
fr: seedPhrase.createAccountFailed
he: seedPhrase.createAccountFailed
it: seedPhrase.createAccountFailed
nl: seedPhrase.createAccountFailed
pl: seedPhrase.createAccountFailed
pt: seedPhrase.createAccountFailed
sv: seedPhrase.createAccountFailed
tr: seedPhrase.createAccountFailed
zh: seedPhrase.createAccountFailed
ar: seedPhrase.linkAccountFailed
cs: seedPhrase.linkAccountFailed
da: seedPhrase.linkAccountFailed
de: seedPhrase.linkAccountFailed
es: seedPhrase.linkAccountFailed
fa: seedPhrase.linkAccountFailed
fr: seedPhrase.linkAccountFailed
he: seedPhrase.linkAccountFailed
it: seedPhrase.linkAccountFailed
nl: seedPhrase.linkAccountFailed
pl: seedPhrase.linkAccountFailed
pt: seedPhrase.linkAccountFailed
sv: seedPhrase.linkAccountFailed
tr: seedPhrase.linkAccountFailed
zh: seedPhrase.linkAccountFailed
ar: seedPhrase.resumeFailed
cs: seedPhrase.resumeFailed
da: seedPhrase.resumeFailed
de: seedPhrase.resumeFailed
es: seedPhrase.resumeFailed
fa: seedPhrase.resumeFailed
fr: seedPhrase.resumeFailed
he: seedPhrase.resumeFailed
it: seedPhrase.resumeFailed
nl: seedPhrase.resumeFailed
pl: seedPhrase.resumeFailed
pt: seedPhrase.resumeFailed
sv: seedPhrase.resumeFailed
tr: seedPhrase.resumeFailed
zh: seedPhrase.resumeFailed
ar: resetPassword.requestFailed
cs: resetPassword.requestFailed
da: resetPassword.requestFailed
de: resetPassword.requestFailed
es: resetPassword.requestFailed
fa: resetPassword.requestFailed
fr: resetPassword.requestFailed
he: resetPassword.requestFailed
it: resetPassword.requestFailed
nl: resetPassword.requestFailed
pl: resetPassword.requestFailed
pt: resetPassword.requestFailed
sv: resetPassword.requestFailed
tr: resetPassword.requestFailed
zh: resetPassword.requestFailed
ar: resetPassword.resetFailed
cs: resetPassword.resetFailed
da: resetPassword.resetFailed
de: resetPassword.resetFailed
es: resetPassword.resetFailed
fa: resetPassword.resetFailed
fr: resetPassword.resetFailed
he: resetPassword.resetFailed
it: resetPassword.resetFailed
nl: resetPassword.resetFailed
pl: resetPassword.resetFailed
pt: resetPassword.resetFailed
sv: resetPassword.resetFailed
tr: resetPassword.resetFailed
zh: resetPassword.resetFailed
ar: recover.orcidStartFailed
cs: recover.orcidStartFailed
da: recover.orcidStartFailed
de: recover.orcidStartFailed
es: recover.orcidStartFailed
fa: recover.orcidStartFailed
fr: recover.orcidStartFailed
he: recover.orcidStartFailed
it: recover.orcidStartFailed
nl: recover.orcidStartFailed
pl: recover.orcidStartFailed
pt: recover.orcidStartFailed
sv: recover.orcidStartFailed
tr: recover.orcidStartFailed
zh: recover.orcidStartFailed
ar: recover.seedRecoveryFailed
cs: recover.seedRecoveryFailed
da: recover.seedRecoveryFailed
de: recover.seedRecoveryFailed
es: recover.seedRecoveryFailed
fa: recover.seedRecoveryFailed
fr: recover.seedRecoveryFailed
he: recover.seedRecoveryFailed
it: recover.seedRecoveryFailed
nl: recover.seedRecoveryFailed
pl: recover.seedRecoveryFailed
pt: recover.seedRecoveryFailed
sv: recover.seedRecoveryFailed
tr: recover.seedRecoveryFailed
zh: recover.seedRecoveryFailed
ar: recover.orcidRecoveryFailed
cs: recover.orcidRecoveryFailed
da: recover.orcidRecoveryFailed
de: recover.orcidRecoveryFailed
es: recover.orcidRecoveryFailed
fa: recover.orcidRecoveryFailed
fr: recover.orcidRecoveryFailed
he: recover.orcidRecoveryFailed
it: recover.orcidRecoveryFailed
nl: recover.orcidRecoveryFailed
pl: recover.orcidRecoveryFailed
pt: recover.orcidRecoveryFailed
sv: recover.orcidRecoveryFailed
tr: recover.orcidRecoveryFailed
zh: recover.orcidRecoveryFailed
ar: login.invalidCredentials
cs: login.invalidCredentials
da: login.invalidCredentials
de: login.invalidCredentials
es: login.invalidCredentials
fa: login.invalidCredentials
fr: login.invalidCredentials
he: login.invalidCredentials
it: login.invalidCredentials
nl: login.invalidCredentials
pl: login.invalidCredentials
pt: login.invalidCredentials
sv: login.invalidCredentials
tr: login.invalidCredentials
zh: login.invalidCredentials
ar: login.signupExpired
cs: login.signupExpired
da: login.signupExpired
de: login.signupExpired
es: login.signupExpired
fa: login.signupExpired
fr: login.signupExpired
he: login.signupExpired
it: login.signupExpired
nl: login.signupExpired
pl: login.signupExpired
pt: login.signupExpired
sv: login.signupExpired
tr: login.signupExpired
zh: login.signupExpired

### Added 2026-04-22 (FE-ERR-MESSAGE-SANITIZE-TOAST-AND-HANDLECONNECT-SITES)

ar: vote.cancelFailed
cs: vote.cancelFailed
da: vote.cancelFailed
de: vote.cancelFailed
es: vote.cancelFailed
fa: vote.cancelFailed
fr: vote.cancelFailed
he: vote.cancelFailed
it: vote.cancelFailed
nl: vote.cancelFailed
pl: vote.cancelFailed
pt: vote.cancelFailed
sv: vote.cancelFailed
tr: vote.cancelFailed
zh: vote.cancelFailed
ar: accreditation.orcidVerifyFailed
cs: accreditation.orcidVerifyFailed
da: accreditation.orcidVerifyFailed
de: accreditation.orcidVerifyFailed
es: accreditation.orcidVerifyFailed
fa: accreditation.orcidVerifyFailed
fr: accreditation.orcidVerifyFailed
he: accreditation.orcidVerifyFailed
it: accreditation.orcidVerifyFailed
nl: accreditation.orcidVerifyFailed
pl: accreditation.orcidVerifyFailed
pt: accreditation.orcidVerifyFailed
sv: accreditation.orcidVerifyFailed
tr: accreditation.orcidVerifyFailed
zh: accreditation.orcidVerifyFailed

### Added 2026-04-22 (UI-ORCID-CALLBACK-RETRIABLE-BRANCH)

ar: orcid.alreadyLinkedDurable
cs: orcid.alreadyLinkedDurable
da: orcid.alreadyLinkedDurable
de: orcid.alreadyLinkedDurable
es: orcid.alreadyLinkedDurable
fa: orcid.alreadyLinkedDurable
fr: orcid.alreadyLinkedDurable
he: orcid.alreadyLinkedDurable
it: orcid.alreadyLinkedDurable
nl: orcid.alreadyLinkedDurable
pl: orcid.alreadyLinkedDurable
pt: orcid.alreadyLinkedDurable
sv: orcid.alreadyLinkedDurable
tr: orcid.alreadyLinkedDurable
zh: orcid.alreadyLinkedDurable
ar: orcid.broadcastPending
cs: orcid.broadcastPending
da: orcid.broadcastPending
de: orcid.broadcastPending
es: orcid.broadcastPending
fa: orcid.broadcastPending
fr: orcid.broadcastPending
he: orcid.broadcastPending
it: orcid.broadcastPending
nl: orcid.broadcastPending
pl: orcid.broadcastPending
pt: orcid.broadcastPending
sv: orcid.broadcastPending
tr: orcid.broadcastPending
zh: orcid.broadcastPending

### Added 2026-04-22 (FE-SEC-004-POLISH)

ar: settings.setPasswordTitle
cs: settings.setPasswordTitle
da: settings.setPasswordTitle
de: settings.setPasswordTitle
es: settings.setPasswordTitle
fa: settings.setPasswordTitle
fr: settings.setPasswordTitle
he: settings.setPasswordTitle
it: settings.setPasswordTitle
nl: settings.setPasswordTitle
pl: settings.setPasswordTitle
pt: settings.setPasswordTitle
sv: settings.setPasswordTitle
tr: settings.setPasswordTitle
zh: settings.setPasswordTitle
ar: settings.setPasswordDescription
cs: settings.setPasswordDescription
da: settings.setPasswordDescription
de: settings.setPasswordDescription
es: settings.setPasswordDescription
fa: settings.setPasswordDescription
fr: settings.setPasswordDescription
he: settings.setPasswordDescription
it: settings.setPasswordDescription
nl: settings.setPasswordDescription
pl: settings.setPasswordDescription
pt: settings.setPasswordDescription
sv: settings.setPasswordDescription
tr: settings.setPasswordDescription
zh: settings.setPasswordDescription
ar: settings.setPasswordLabel
cs: settings.setPasswordLabel
da: settings.setPasswordLabel
de: settings.setPasswordLabel
es: settings.setPasswordLabel
fa: settings.setPasswordLabel
fr: settings.setPasswordLabel
he: settings.setPasswordLabel
it: settings.setPasswordLabel
nl: settings.setPasswordLabel
pl: settings.setPasswordLabel
pt: settings.setPasswordLabel
sv: settings.setPasswordLabel
tr: settings.setPasswordLabel
zh: settings.setPasswordLabel
ar: settings.setPasswordHint
cs: settings.setPasswordHint
da: settings.setPasswordHint
de: settings.setPasswordHint
es: settings.setPasswordHint
fa: settings.setPasswordHint
fr: settings.setPasswordHint
he: settings.setPasswordHint
it: settings.setPasswordHint
nl: settings.setPasswordHint
pl: settings.setPasswordHint
pt: settings.setPasswordHint
sv: settings.setPasswordHint
tr: settings.setPasswordHint
zh: settings.setPasswordHint
ar: settings.setPasswordConfirmLabel
cs: settings.setPasswordConfirmLabel
da: settings.setPasswordConfirmLabel
de: settings.setPasswordConfirmLabel
es: settings.setPasswordConfirmLabel
fa: settings.setPasswordConfirmLabel
fr: settings.setPasswordConfirmLabel
he: settings.setPasswordConfirmLabel
it: settings.setPasswordConfirmLabel
nl: settings.setPasswordConfirmLabel
pl: settings.setPasswordConfirmLabel
pt: settings.setPasswordConfirmLabel
sv: settings.setPasswordConfirmLabel
tr: settings.setPasswordConfirmLabel
zh: settings.setPasswordConfirmLabel
ar: settings.setPasswordMismatch
cs: settings.setPasswordMismatch
da: settings.setPasswordMismatch
de: settings.setPasswordMismatch
es: settings.setPasswordMismatch
fa: settings.setPasswordMismatch
fr: settings.setPasswordMismatch
he: settings.setPasswordMismatch
it: settings.setPasswordMismatch
nl: settings.setPasswordMismatch
pl: settings.setPasswordMismatch
pt: settings.setPasswordMismatch
sv: settings.setPasswordMismatch
tr: settings.setPasswordMismatch
zh: settings.setPasswordMismatch
ar: settings.setPasswordSubmit
cs: settings.setPasswordSubmit
da: settings.setPasswordSubmit
de: settings.setPasswordSubmit
es: settings.setPasswordSubmit
fa: settings.setPasswordSubmit
fr: settings.setPasswordSubmit
he: settings.setPasswordSubmit
it: settings.setPasswordSubmit
nl: settings.setPasswordSubmit
pl: settings.setPasswordSubmit
pt: settings.setPasswordSubmit
sv: settings.setPasswordSubmit
tr: settings.setPasswordSubmit
zh: settings.setPasswordSubmit
ar: settings.setPasswordSaving
cs: settings.setPasswordSaving
da: settings.setPasswordSaving
de: settings.setPasswordSaving
es: settings.setPasswordSaving
fa: settings.setPasswordSaving
fr: settings.setPasswordSaving
he: settings.setPasswordSaving
it: settings.setPasswordSaving
nl: settings.setPasswordSaving
pl: settings.setPasswordSaving
pt: settings.setPasswordSaving
sv: settings.setPasswordSaving
tr: settings.setPasswordSaving
zh: settings.setPasswordSaving
ar: settings.setPasswordSuccess
cs: settings.setPasswordSuccess
da: settings.setPasswordSuccess
de: settings.setPasswordSuccess
es: settings.setPasswordSuccess
fa: settings.setPasswordSuccess
fr: settings.setPasswordSuccess
he: settings.setPasswordSuccess
it: settings.setPasswordSuccess
nl: settings.setPasswordSuccess
pl: settings.setPasswordSuccess
pt: settings.setPasswordSuccess
sv: settings.setPasswordSuccess
tr: settings.setPasswordSuccess
zh: settings.setPasswordSuccess
ar: signup.orcidNoPassword
cs: signup.orcidNoPassword
da: signup.orcidNoPassword
de: signup.orcidNoPassword
es: signup.orcidNoPassword
fa: signup.orcidNoPassword
fr: signup.orcidNoPassword
he: signup.orcidNoPassword
it: signup.orcidNoPassword
nl: signup.orcidNoPassword
pl: signup.orcidNoPassword
pt: signup.orcidNoPassword
sv: signup.orcidNoPassword
tr: signup.orcidNoPassword
zh: signup.orcidNoPassword
ar: recover.orcidNoPassword
cs: recover.orcidNoPassword
da: recover.orcidNoPassword
de: recover.orcidNoPassword
es: recover.orcidNoPassword
fa: recover.orcidNoPassword
fr: recover.orcidNoPassword
he: recover.orcidNoPassword
it: recover.orcidNoPassword
nl: recover.orcidNoPassword
pl: recover.orcidNoPassword
pt: recover.orcidNoPassword
sv: recover.orcidNoPassword
tr: recover.orcidNoPassword
zh: recover.orcidNoPassword

### Added 2026-04-28 (UI-GATING-COHERENCE-PUBLISH-REVIEW-EDIT)

ar: edit.signInToEdit
cs: edit.signInToEdit
da: edit.signInToEdit
de: edit.signInToEdit
es: edit.signInToEdit
fa: edit.signInToEdit
fr: edit.signInToEdit
he: edit.signInToEdit
it: edit.signInToEdit
nl: edit.signInToEdit
pl: edit.signInToEdit
pt: edit.signInToEdit
sv: edit.signInToEdit
tr: edit.signInToEdit
zh: edit.signInToEdit
ar: edit.signInHint
cs: edit.signInHint
da: edit.signInHint
de: edit.signInHint
es: edit.signInHint
fa: edit.signInHint
fr: edit.signInHint
he: edit.signInHint
it: edit.signInHint
nl: edit.signInHint
pl: edit.signInHint
pt: edit.signInHint
sv: edit.signInHint
tr: edit.signInHint
zh: edit.signInHint
ar: edit.howToEditTitle
cs: edit.howToEditTitle
da: edit.howToEditTitle
de: edit.howToEditTitle
es: edit.howToEditTitle
fa: edit.howToEditTitle
fr: edit.howToEditTitle
he: edit.howToEditTitle
it: edit.howToEditTitle
nl: edit.howToEditTitle
pl: edit.howToEditTitle
pt: edit.howToEditTitle
sv: edit.howToEditTitle
tr: edit.howToEditTitle
zh: edit.howToEditTitle
ar: edit.howToEditIntro
cs: edit.howToEditIntro
da: edit.howToEditIntro
de: edit.howToEditIntro
es: edit.howToEditIntro
fa: edit.howToEditIntro
fr: edit.howToEditIntro
he: edit.howToEditIntro
it: edit.howToEditIntro
nl: edit.howToEditIntro
pl: edit.howToEditIntro
pt: edit.howToEditIntro
sv: edit.howToEditIntro
tr: edit.howToEditIntro
zh: edit.howToEditIntro
ar: edit.howToEditOriginalAuthor
cs: edit.howToEditOriginalAuthor
da: edit.howToEditOriginalAuthor
de: edit.howToEditOriginalAuthor
es: edit.howToEditOriginalAuthor
fa: edit.howToEditOriginalAuthor
fr: edit.howToEditOriginalAuthor
he: edit.howToEditOriginalAuthor
it: edit.howToEditOriginalAuthor
nl: edit.howToEditOriginalAuthor
pl: edit.howToEditOriginalAuthor
pt: edit.howToEditOriginalAuthor
sv: edit.howToEditOriginalAuthor
tr: edit.howToEditOriginalAuthor
zh: edit.howToEditOriginalAuthor
ar: edit.howToEditCoAuthor
cs: edit.howToEditCoAuthor
da: edit.howToEditCoAuthor
de: edit.howToEditCoAuthor
es: edit.howToEditCoAuthor
fa: edit.howToEditCoAuthor
fr: edit.howToEditCoAuthor
he: edit.howToEditCoAuthor
it: edit.howToEditCoAuthor
nl: edit.howToEditCoAuthor
pl: edit.howToEditCoAuthor
pt: edit.howToEditCoAuthor
sv: edit.howToEditCoAuthor
tr: edit.howToEditCoAuthor
zh: edit.howToEditCoAuthor
ar: edit.howToEditClaim
cs: edit.howToEditClaim
da: edit.howToEditClaim
de: edit.howToEditClaim
es: edit.howToEditClaim
fa: edit.howToEditClaim
fr: edit.howToEditClaim
he: edit.howToEditClaim
it: edit.howToEditClaim
nl: edit.howToEditClaim
pl: edit.howToEditClaim
pt: edit.howToEditClaim
sv: edit.howToEditClaim
tr: edit.howToEditClaim
zh: edit.howToEditClaim

### Added 2026-04-28 (UI-KEYCHAIN-API-MISUSE)

ar: upgrade.keychainImportWarning.posting
ar: upgrade.keychainImportWarning.active
ar: upgrade.keychainImportWarning.memo
cs: upgrade.keychainImportWarning.posting
cs: upgrade.keychainImportWarning.active
cs: upgrade.keychainImportWarning.memo
da: upgrade.keychainImportWarning.posting
da: upgrade.keychainImportWarning.active
da: upgrade.keychainImportWarning.memo
de: upgrade.keychainImportWarning.posting
de: upgrade.keychainImportWarning.active
de: upgrade.keychainImportWarning.memo
es: upgrade.keychainImportWarning.posting
es: upgrade.keychainImportWarning.active
es: upgrade.keychainImportWarning.memo
fa: upgrade.keychainImportWarning.posting
fa: upgrade.keychainImportWarning.active
fa: upgrade.keychainImportWarning.memo
fr: upgrade.keychainImportWarning.posting
fr: upgrade.keychainImportWarning.active
fr: upgrade.keychainImportWarning.memo
he: upgrade.keychainImportWarning.posting
he: upgrade.keychainImportWarning.active
he: upgrade.keychainImportWarning.memo
it: upgrade.keychainImportWarning.posting
it: upgrade.keychainImportWarning.active
it: upgrade.keychainImportWarning.memo
nl: upgrade.keychainImportWarning.posting
nl: upgrade.keychainImportWarning.active
nl: upgrade.keychainImportWarning.memo
pl: upgrade.keychainImportWarning.posting
pl: upgrade.keychainImportWarning.active
pl: upgrade.keychainImportWarning.memo
pt: upgrade.keychainImportWarning.posting
pt: upgrade.keychainImportWarning.active
pt: upgrade.keychainImportWarning.memo
sv: upgrade.keychainImportWarning.posting
sv: upgrade.keychainImportWarning.active
sv: upgrade.keychainImportWarning.memo
tr: upgrade.keychainImportWarning.posting
tr: upgrade.keychainImportWarning.active
tr: upgrade.keychainImportWarning.memo
zh: upgrade.keychainImportWarning.posting
zh: upgrade.keychainImportWarning.active
zh: upgrade.keychainImportWarning.memo

### Added 2026-04-30 (UI-ORCID-CALLBACK-POST-BROADCAST-FAILED-HANDLER)

ar: orcid.postBroadcastFailedConfirmed
cs: orcid.postBroadcastFailedConfirmed
da: orcid.postBroadcastFailedConfirmed
de: orcid.postBroadcastFailedConfirmed
es: orcid.postBroadcastFailedConfirmed
fa: orcid.postBroadcastFailedConfirmed
fr: orcid.postBroadcastFailedConfirmed
he: orcid.postBroadcastFailedConfirmed
it: orcid.postBroadcastFailedConfirmed
nl: orcid.postBroadcastFailedConfirmed
pl: orcid.postBroadcastFailedConfirmed
pt: orcid.postBroadcastFailedConfirmed
sv: orcid.postBroadcastFailedConfirmed
tr: orcid.postBroadcastFailedConfirmed
zh: orcid.postBroadcastFailedConfirmed

### Added 2026-05-04 (UI-KEYCHAIN-API-MISUSE)

ar: upgrade.keychainImportFailed
cs: upgrade.keychainImportFailed
da: upgrade.keychainImportFailed
de: upgrade.keychainImportFailed
es: upgrade.keychainImportFailed
fa: upgrade.keychainImportFailed
fr: upgrade.keychainImportFailed
he: upgrade.keychainImportFailed
it: upgrade.keychainImportFailed
nl: upgrade.keychainImportFailed
pl: upgrade.keychainImportFailed
pt: upgrade.keychainImportFailed
sv: upgrade.keychainImportFailed
tr: upgrade.keychainImportFailed
zh: upgrade.keychainImportFailed


### Added 2026-05-06 (UI-AUTHOR-INPUT-ACCREDITED-PREFILL)

ar: publish.coAuthorAccreditedHint
cs: publish.coAuthorAccreditedHint
da: publish.coAuthorAccreditedHint
de: publish.coAuthorAccreditedHint
es: publish.coAuthorAccreditedHint
fa: publish.coAuthorAccreditedHint
fr: publish.coAuthorAccreditedHint
he: publish.coAuthorAccreditedHint
it: publish.coAuthorAccreditedHint
nl: publish.coAuthorAccreditedHint
pl: publish.coAuthorAccreditedHint
pt: publish.coAuthorAccreditedHint
sv: publish.coAuthorAccreditedHint
tr: publish.coAuthorAccreditedHint
zh: publish.coAuthorAccreditedHint

### Added 2026-05-11 (UI-BRIDGE-REGISTER-LOCK-HELD-UX)

ar: bridge.lockHeldRetry
cs: bridge.lockHeldRetry
da: bridge.lockHeldRetry
de: bridge.lockHeldRetry
es: bridge.lockHeldRetry
fa: bridge.lockHeldRetry
fr: bridge.lockHeldRetry
he: bridge.lockHeldRetry
it: bridge.lockHeldRetry
nl: bridge.lockHeldRetry
pl: bridge.lockHeldRetry
pt: bridge.lockHeldRetry
sv: bridge.lockHeldRetry
tr: bridge.lockHeldRetry
zh: bridge.lockHeldRetry

### Added 2026-05-15 (UI-ORCID-CALLBACK-POST-BROADCAST-FAILED-HANDLER)

ar: orcid.postBroadcastOperatorRequired
cs: orcid.postBroadcastOperatorRequired
da: orcid.postBroadcastOperatorRequired
de: orcid.postBroadcastOperatorRequired
es: orcid.postBroadcastOperatorRequired
fa: orcid.postBroadcastOperatorRequired
fr: orcid.postBroadcastOperatorRequired
he: orcid.postBroadcastOperatorRequired
it: orcid.postBroadcastOperatorRequired
nl: orcid.postBroadcastOperatorRequired
pl: orcid.postBroadcastOperatorRequired
pt: orcid.postBroadcastOperatorRequired
sv: orcid.postBroadcastOperatorRequired
tr: orcid.postBroadcastOperatorRequired
zh: orcid.postBroadcastOperatorRequired

### Added 2026-05-15 (UI-ORCID-CALLBACK-SETTINGS-CTA-LABEL)

ar: common.verifyInSettings
cs: common.verifyInSettings
da: common.verifyInSettings
de: common.verifyInSettings
es: common.verifyInSettings
fa: common.verifyInSettings
fr: common.verifyInSettings
he: common.verifyInSettings
it: common.verifyInSettings
nl: common.verifyInSettings
pl: common.verifyInSettings
pt: common.verifyInSettings
sv: common.verifyInSettings
tr: common.verifyInSettings
zh: common.verifyInSettings

### Added 2026-05-15 (ui-keychain-api-misuse)

English source text for `upgrade.backendTimeout` was revised after the
initial 2026-05-15 stub. The 15 locale stubs below were re-stubbed with
the current English copy.

ar: upgrade.backendTimeout
cs: upgrade.backendTimeout
da: upgrade.backendTimeout
de: upgrade.backendTimeout
es: upgrade.backendTimeout
fa: upgrade.backendTimeout
fr: upgrade.backendTimeout
he: upgrade.backendTimeout
it: upgrade.backendTimeout
nl: upgrade.backendTimeout
pl: upgrade.backendTimeout
pt: upgrade.backendTimeout
sv: upgrade.backendTimeout
tr: upgrade.backendTimeout
zh: upgrade.backendTimeout

### Added 2026-05-16 (ui-canretryupgrade-discriminator-key-refactor)

ar: upgrade.partialApplyFailed
cs: upgrade.partialApplyFailed
da: upgrade.partialApplyFailed
de: upgrade.partialApplyFailed
es: upgrade.partialApplyFailed
fa: upgrade.partialApplyFailed
fr: upgrade.partialApplyFailed
he: upgrade.partialApplyFailed
it: upgrade.partialApplyFailed
nl: upgrade.partialApplyFailed
pl: upgrade.partialApplyFailed
pt: upgrade.partialApplyFailed
sv: upgrade.partialApplyFailed
tr: upgrade.partialApplyFailed
zh: upgrade.partialApplyFailed

### Added 2026-05-16 (ui-custody-upgrade-seed-phrase-derive-flow)

ar: upgrade.backendUnavailable
cs: upgrade.backendUnavailable
da: upgrade.backendUnavailable
de: upgrade.backendUnavailable
es: upgrade.backendUnavailable
fa: upgrade.backendUnavailable
fr: upgrade.backendUnavailable
he: upgrade.backendUnavailable
it: upgrade.backendUnavailable
nl: upgrade.backendUnavailable
pl: upgrade.backendUnavailable
pt: upgrade.backendUnavailable
sv: upgrade.backendUnavailable
tr: upgrade.backendUnavailable
zh: upgrade.backendUnavailable
ar: upgrade.alreadyUpgraded
cs: upgrade.alreadyUpgraded
da: upgrade.alreadyUpgraded
de: upgrade.alreadyUpgraded
es: upgrade.alreadyUpgraded
fa: upgrade.alreadyUpgraded
fr: upgrade.alreadyUpgraded
he: upgrade.alreadyUpgraded
it: upgrade.alreadyUpgraded
nl: upgrade.alreadyUpgraded
pl: upgrade.alreadyUpgraded
pt: upgrade.alreadyUpgraded
sv: upgrade.alreadyUpgraded
tr: upgrade.alreadyUpgraded
zh: upgrade.alreadyUpgraded
ar: upgrade.rateLimited
cs: upgrade.rateLimited
da: upgrade.rateLimited
de: upgrade.rateLimited
es: upgrade.rateLimited
fa: upgrade.rateLimited
fr: upgrade.rateLimited
he: upgrade.rateLimited
it: upgrade.rateLimited
nl: upgrade.rateLimited
pl: upgrade.rateLimited
pt: upgrade.rateLimited
sv: upgrade.rateLimited
tr: upgrade.rateLimited
zh: upgrade.rateLimited

### Added 2026-05-16 (UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING)

ar: orcid.reauthSuccess
cs: orcid.reauthSuccess
da: orcid.reauthSuccess
de: orcid.reauthSuccess
es: orcid.reauthSuccess
fa: orcid.reauthSuccess
fr: orcid.reauthSuccess
he: orcid.reauthSuccess
it: orcid.reauthSuccess
nl: orcid.reauthSuccess
pl: orcid.reauthSuccess
pt: orcid.reauthSuccess
sv: orcid.reauthSuccess
tr: orcid.reauthSuccess
zh: orcid.reauthSuccess

### Added 2026-05-16 (UI-KEYCHAIN-WARNING-COPY)

ar: upgrade.keychainImportWarning.posting
cs: upgrade.keychainImportWarning.posting
da: upgrade.keychainImportWarning.posting
de: upgrade.keychainImportWarning.posting
es: upgrade.keychainImportWarning.posting
fa: upgrade.keychainImportWarning.posting
fr: upgrade.keychainImportWarning.posting
he: upgrade.keychainImportWarning.posting
it: upgrade.keychainImportWarning.posting
nl: upgrade.keychainImportWarning.posting
pl: upgrade.keychainImportWarning.posting
pt: upgrade.keychainImportWarning.posting
sv: upgrade.keychainImportWarning.posting
tr: upgrade.keychainImportWarning.posting
zh: upgrade.keychainImportWarning.posting
ar: upgrade.keychainImportWarning.active
cs: upgrade.keychainImportWarning.active
da: upgrade.keychainImportWarning.active
de: upgrade.keychainImportWarning.active
es: upgrade.keychainImportWarning.active
fa: upgrade.keychainImportWarning.active
fr: upgrade.keychainImportWarning.active
he: upgrade.keychainImportWarning.active
it: upgrade.keychainImportWarning.active
nl: upgrade.keychainImportWarning.active
pl: upgrade.keychainImportWarning.active
pt: upgrade.keychainImportWarning.active
sv: upgrade.keychainImportWarning.active
tr: upgrade.keychainImportWarning.active
zh: upgrade.keychainImportWarning.active
ar: upgrade.keychainImportWarning.memo
cs: upgrade.keychainImportWarning.memo
da: upgrade.keychainImportWarning.memo
de: upgrade.keychainImportWarning.memo
es: upgrade.keychainImportWarning.memo
fa: upgrade.keychainImportWarning.memo
fr: upgrade.keychainImportWarning.memo
he: upgrade.keychainImportWarning.memo
it: upgrade.keychainImportWarning.memo
nl: upgrade.keychainImportWarning.memo
pl: upgrade.keychainImportWarning.memo
pt: upgrade.keychainImportWarning.memo
sv: upgrade.keychainImportWarning.memo
tr: upgrade.keychainImportWarning.memo
zh: upgrade.keychainImportWarning.memo
ar: upgrade.keychainImportFailed
cs: upgrade.keychainImportFailed
da: upgrade.keychainImportFailed
de: upgrade.keychainImportFailed
es: upgrade.keychainImportFailed
fa: upgrade.keychainImportFailed
fr: upgrade.keychainImportFailed
he: upgrade.keychainImportFailed
it: upgrade.keychainImportFailed
nl: upgrade.keychainImportFailed
pl: upgrade.keychainImportFailed
pt: upgrade.keychainImportFailed
sv: upgrade.keychainImportFailed
tr: upgrade.keychainImportFailed
zh: upgrade.keychainImportFailed

### Added 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)

ar: upgrade.proofRejected
cs: upgrade.proofRejected
da: upgrade.proofRejected
de: upgrade.proofRejected
es: upgrade.proofRejected
fa: upgrade.proofRejected
fr: upgrade.proofRejected
he: upgrade.proofRejected
it: upgrade.proofRejected
nl: upgrade.proofRejected
pl: upgrade.proofRejected
pt: upgrade.proofRejected
sv: upgrade.proofRejected
tr: upgrade.proofRejected
zh: upgrade.proofRejected
ar: upgrade.backendTimeout
cs: upgrade.backendTimeout
da: upgrade.backendTimeout
de: upgrade.backendTimeout
es: upgrade.backendTimeout
fa: upgrade.backendTimeout
fr: upgrade.backendTimeout
he: upgrade.backendTimeout
it: upgrade.backendTimeout
nl: upgrade.backendTimeout
pl: upgrade.backendTimeout
pt: upgrade.backendTimeout
sv: upgrade.backendTimeout
tr: upgrade.backendTimeout
zh: upgrade.backendTimeout

### Added 2026-05-17 (UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING)

ar: auth.sessionInconsistency
cs: auth.sessionInconsistency
da: auth.sessionInconsistency
de: auth.sessionInconsistency
es: auth.sessionInconsistency
fa: auth.sessionInconsistency
fr: auth.sessionInconsistency
he: auth.sessionInconsistency
it: auth.sessionInconsistency
nl: auth.sessionInconsistency
pl: auth.sessionInconsistency
pt: auth.sessionInconsistency
sv: auth.sessionInconsistency
tr: auth.sessionInconsistency
zh: auth.sessionInconsistency

### Added 2026-05-17 (UI-ACCREDITATION-VERIFY-RETRIABLE-HANDLING)

ar: verify.serviceTemporarilyUnavailable
cs: verify.serviceTemporarilyUnavailable
da: verify.serviceTemporarilyUnavailable
de: verify.serviceTemporarilyUnavailable
es: verify.serviceTemporarilyUnavailable
fa: verify.serviceTemporarilyUnavailable
fr: verify.serviceTemporarilyUnavailable
he: verify.serviceTemporarilyUnavailable
it: verify.serviceTemporarilyUnavailable
nl: verify.serviceTemporarilyUnavailable
pl: verify.serviceTemporarilyUnavailable
pt: verify.serviceTemporarilyUnavailable
sv: verify.serviceTemporarilyUnavailable
tr: verify.serviceTemporarilyUnavailable
zh: verify.serviceTemporarilyUnavailable
ar: verify.retry
cs: verify.retry
da: verify.retry
de: verify.retry
es: verify.retry
fa: verify.retry
fr: verify.retry
he: verify.retry
it: verify.retry
nl: verify.retry
pl: verify.retry
pt: verify.retry
sv: verify.retry
tr: verify.retry
zh: verify.retry
ar: verify.retryAvailableIn
cs: verify.retryAvailableIn
da: verify.retryAvailableIn
de: verify.retryAvailableIn
es: verify.retryAvailableIn
fa: verify.retryAvailableIn
fr: verify.retryAvailableIn
he: verify.retryAvailableIn
it: verify.retryAvailableIn
nl: verify.retryAvailableIn
pl: verify.retryAvailableIn
pt: verify.retryAvailableIn
sv: verify.retryAvailableIn
tr: verify.retryAvailableIn
zh: verify.retryAvailableIn

### Updated 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)

English value of `upgrade.backendTimeout` was tightened in place to name the
new (post-rotation) recovery phrase explicitly; the prior copy left users at
risk of retrying with their original phrase. Translators who already started
on the round-2 `Added` entry should retranslate.

ar: upgrade.backendTimeout
cs: upgrade.backendTimeout
da: upgrade.backendTimeout
de: upgrade.backendTimeout
es: upgrade.backendTimeout
fa: upgrade.backendTimeout
fr: upgrade.backendTimeout
he: upgrade.backendTimeout
it: upgrade.backendTimeout
nl: upgrade.backendTimeout
pl: upgrade.backendTimeout
pt: upgrade.backendTimeout
sv: upgrade.backendTimeout
tr: upgrade.backendTimeout
zh: upgrade.backendTimeout

### Added 2026-05-17 (UI-MID-BROADCAST-SPA-NAVIGATION-GUARD)

ar: upgrade.navigationGuardConfirm
cs: upgrade.navigationGuardConfirm
da: upgrade.navigationGuardConfirm
de: upgrade.navigationGuardConfirm
es: upgrade.navigationGuardConfirm
fa: upgrade.navigationGuardConfirm
fr: upgrade.navigationGuardConfirm
he: upgrade.navigationGuardConfirm
it: upgrade.navigationGuardConfirm
nl: upgrade.navigationGuardConfirm
pl: upgrade.navigationGuardConfirm
pt: upgrade.navigationGuardConfirm
sv: upgrade.navigationGuardConfirm
tr: upgrade.navigationGuardConfirm
zh: upgrade.navigationGuardConfirm

### Added 2026-05-17 (UI-ACCREDITATION-VERIFY-NETWORK-ERROR-RETRIABLE)

ar: verify.networkUnavailable
cs: verify.networkUnavailable
da: verify.networkUnavailable
de: verify.networkUnavailable
es: verify.networkUnavailable
fa: verify.networkUnavailable
fr: verify.networkUnavailable
he: verify.networkUnavailable
it: verify.networkUnavailable
nl: verify.networkUnavailable
pl: verify.networkUnavailable
pt: verify.networkUnavailable
sv: verify.networkUnavailable
tr: verify.networkUnavailable
zh: verify.networkUnavailable

### Updated 2026-05-19 (UI-SETTINGS-EMAIL-SMTP-FAIL-COPY-SOFT-HINT)

English value of `settings.emailVerificationSent` was softened to add a retry
hint after the backend's Option-A SMTP-fail 200 path (the success toast now
fires identically for genuine success and SMTP failure, so users need an
in-UI nudge to retry if no email arrives). The prior translations covered
only the first sentence ("Verification email sent. Check your inbox.") and
no longer convey the full message; retranslation is needed.

ar: settings.emailVerificationSent
cs: settings.emailVerificationSent
da: settings.emailVerificationSent
de: settings.emailVerificationSent
es: settings.emailVerificationSent
fa: settings.emailVerificationSent
fr: settings.emailVerificationSent
he: settings.emailVerificationSent
it: settings.emailVerificationSent
nl: settings.emailVerificationSent
pl: settings.emailVerificationSent
pt: settings.emailVerificationSent
sv: settings.emailVerificationSent
tr: settings.emailVerificationSent
zh: settings.emailVerificationSent

### Added 2026-05-20 (UI-HAF-OUTAGE-503-RETRY-AFFORDANCE)

ar: profile.papersUnavailable
cs: profile.papersUnavailable
da: profile.papersUnavailable
de: profile.papersUnavailable
es: profile.papersUnavailable
fa: profile.papersUnavailable
fr: profile.papersUnavailable
he: profile.papersUnavailable
it: profile.papersUnavailable
nl: profile.papersUnavailable
pl: profile.papersUnavailable
pt: profile.papersUnavailable
sv: profile.papersUnavailable
tr: profile.papersUnavailable
zh: profile.papersUnavailable

ar: profile.reviewsUnavailable
cs: profile.reviewsUnavailable
da: profile.reviewsUnavailable
de: profile.reviewsUnavailable
es: profile.reviewsUnavailable
fa: profile.reviewsUnavailable
fr: profile.reviewsUnavailable
he: profile.reviewsUnavailable
it: profile.reviewsUnavailable
nl: profile.reviewsUnavailable
pl: profile.reviewsUnavailable
pt: profile.reviewsUnavailable
sv: profile.reviewsUnavailable
tr: profile.reviewsUnavailable
zh: profile.reviewsUnavailable

ar: comments.serviceUnavailable
cs: comments.serviceUnavailable
da: comments.serviceUnavailable
de: comments.serviceUnavailable
es: comments.serviceUnavailable
fa: comments.serviceUnavailable
fr: comments.serviceUnavailable
he: comments.serviceUnavailable
it: comments.serviceUnavailable
nl: comments.serviceUnavailable
pl: comments.serviceUnavailable
pt: comments.serviceUnavailable
sv: comments.serviceUnavailable
tr: comments.serviceUnavailable
zh: comments.serviceUnavailable

### Added 2026-05-20 (UI-PAPER-DETAIL-RETRIABLE-503-HANDLING)

ar: paperDetail.serviceUnavailableTitle
cs: paperDetail.serviceUnavailableTitle
da: paperDetail.serviceUnavailableTitle
de: paperDetail.serviceUnavailableTitle
es: paperDetail.serviceUnavailableTitle
fa: paperDetail.serviceUnavailableTitle
fr: paperDetail.serviceUnavailableTitle
he: paperDetail.serviceUnavailableTitle
it: paperDetail.serviceUnavailableTitle
nl: paperDetail.serviceUnavailableTitle
pl: paperDetail.serviceUnavailableTitle
pt: paperDetail.serviceUnavailableTitle
sv: paperDetail.serviceUnavailableTitle
tr: paperDetail.serviceUnavailableTitle
zh: paperDetail.serviceUnavailableTitle

ar: paperDetail.serviceUnavailableMessage
cs: paperDetail.serviceUnavailableMessage
da: paperDetail.serviceUnavailableMessage
de: paperDetail.serviceUnavailableMessage
es: paperDetail.serviceUnavailableMessage
fa: paperDetail.serviceUnavailableMessage
fr: paperDetail.serviceUnavailableMessage
he: paperDetail.serviceUnavailableMessage
it: paperDetail.serviceUnavailableMessage
nl: paperDetail.serviceUnavailableMessage
pl: paperDetail.serviceUnavailableMessage
pt: paperDetail.serviceUnavailableMessage
sv: paperDetail.serviceUnavailableMessage
tr: paperDetail.serviceUnavailableMessage
zh: paperDetail.serviceUnavailableMessage

ar: paperDetail.enrichmentUnavailable
cs: paperDetail.enrichmentUnavailable
da: paperDetail.enrichmentUnavailable
de: paperDetail.enrichmentUnavailable
es: paperDetail.enrichmentUnavailable
fa: paperDetail.enrichmentUnavailable
fr: paperDetail.enrichmentUnavailable
he: paperDetail.enrichmentUnavailable
it: paperDetail.enrichmentUnavailable
nl: paperDetail.enrichmentUnavailable
pl: paperDetail.enrichmentUnavailable
pt: paperDetail.enrichmentUnavailable
sv: paperDetail.enrichmentUnavailable
tr: paperDetail.enrichmentUnavailable
zh: paperDetail.enrichmentUnavailable

ar: citation.serviceUnavailable
cs: citation.serviceUnavailable
da: citation.serviceUnavailable
de: citation.serviceUnavailable
es: citation.serviceUnavailable
fa: citation.serviceUnavailable
fr: citation.serviceUnavailable
he: citation.serviceUnavailable
it: citation.serviceUnavailable
nl: citation.serviceUnavailable
pl: citation.serviceUnavailable
pt: citation.serviceUnavailable
sv: citation.serviceUnavailable
tr: citation.serviceUnavailable
zh: citation.serviceUnavailable

ar: retraction.serviceUnavailable
cs: retraction.serviceUnavailable
da: retraction.serviceUnavailable
de: retraction.serviceUnavailable
es: retraction.serviceUnavailable
fa: retraction.serviceUnavailable
fr: retraction.serviceUnavailable
he: retraction.serviceUnavailable
it: retraction.serviceUnavailable
nl: retraction.serviceUnavailable
pl: retraction.serviceUnavailable
pt: retraction.serviceUnavailable
sv: retraction.serviceUnavailable
tr: retraction.serviceUnavailable
zh: retraction.serviceUnavailable

### Added 2026-05-20 (UI-PAPER-DETAIL-ORCID-DISCREPANCY-INDICATOR)

ar: orcid.linkAriaLabel
cs: orcid.linkAriaLabel
da: orcid.linkAriaLabel
de: orcid.linkAriaLabel
es: orcid.linkAriaLabel
fa: orcid.linkAriaLabel
fr: orcid.linkAriaLabel
he: orcid.linkAriaLabel
it: orcid.linkAriaLabel
nl: orcid.linkAriaLabel
pl: orcid.linkAriaLabel
pt: orcid.linkAriaLabel
sv: orcid.linkAriaLabel
tr: orcid.linkAriaLabel
zh: orcid.linkAriaLabel

ar: orcid.discrepancyTitle
cs: orcid.discrepancyTitle
da: orcid.discrepancyTitle
de: orcid.discrepancyTitle
es: orcid.discrepancyTitle
fa: orcid.discrepancyTitle
fr: orcid.discrepancyTitle
he: orcid.discrepancyTitle
it: orcid.discrepancyTitle
nl: orcid.discrepancyTitle
pl: orcid.discrepancyTitle
pt: orcid.discrepancyTitle
sv: orcid.discrepancyTitle
tr: orcid.discrepancyTitle
zh: orcid.discrepancyTitle

ar: orcid.discrepancyAriaLabel
cs: orcid.discrepancyAriaLabel
da: orcid.discrepancyAriaLabel
de: orcid.discrepancyAriaLabel
es: orcid.discrepancyAriaLabel
fa: orcid.discrepancyAriaLabel
fr: orcid.discrepancyAriaLabel
he: orcid.discrepancyAriaLabel
it: orcid.discrepancyAriaLabel
nl: orcid.discrepancyAriaLabel
pl: orcid.discrepancyAriaLabel
pt: orcid.discrepancyAriaLabel
sv: orcid.discrepancyAriaLabel
tr: orcid.discrepancyAriaLabel
zh: orcid.discrepancyAriaLabel
