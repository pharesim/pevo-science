# Keep the password-action hold and settled-address decisions true as their tasks land

**Owner:** architect
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). The decisions were recorded that day in ARCHITECTURE.md § 6.1,
§ 6.3 and § 6.4, `api-contracts/settings.md`, `auth.md` and `orcid.md`, and CONCEPTS.md, each
with a "decided 2026-10-08" or "lands with" marker. This task is picked at the archive of each
implementer task it names and keeps those texts true of the code.

## Scope

1. At each archive of `backend-email-changed-at-stamp-and-displaced-address-notice`,
   `backend-recovery-dispute-only-for-a-settled-address`,
   `backend-email-change-hold-and-owner-notice`,
   `backend-password-proven-orcid-link-completes-from-current-mailbox`,
   `backend-password-proven-deletion-is-held-and-announced` and
   `backend-reset-link-survives-re-requests-and-refuses-the-current-password`: check every
   "decided 2026-10-08" sentence that task makes live against `settings.ts`, `recover.ts`,
   `auth.ts` and `orcid.ts`, and drop its "lands with" marker. When the last of them is archived,
   delete the landing sentence at the head of the § 6.3 block decided 2026-10-08, and rewrite the
   § 6.3 "Evictions" paragraph so the custody upgrade is listed with the three evictions.
2. While the hold task is archived and the mailbox-confirmed link task is not, § 6.3 records the
   interim residual the hold task's signal names: a password holder on an accredited state A row
   can link an ORCID of their own and change the email with an ORCID proof, which carries no hold.
3. Unblock in order: `ui-settings-shows-held-email-change-with-cancel` and
   `ui-settings-offers-the-orcid-factor-beside-the-password` when the hold task is archived;
   `backend-password-proven-orcid-link-completes-from-current-mailbox` when
   `backend-orcid-link-and-accredit-require-fresh-auth` and the settled-address task are;
   `ui-orcid-link-confirm-page` when the confirm task is; `ui-settings-shows-held-deletion-with-cancel`
   when the held-deletion task is.
4. Learnings checkpoint at each of those archives, as root `CLAUDE.md` requires: run
   `/ce-compound-refresh` on
   `conventions/recovery-defenses-vs-seed-phrase-holder-non-load-bearing-2026-05-25.md` (the
   password-only carve-out governed this design; the settling rule costs the seed-holder class
   during 30 days after an owner's own change) and on
   `conventions/mailed-credential-token-dies-with-its-address-and-credential.md` (the hold
   columns join the triple's kill set; the notices are not tokens; the ORCID confirm token is)
   when the hold task is archived; run `/ce-compound` on the fail-open hold with the existing
   credential reset as the veto, against a mailed cancel token, if the implementation surfaces a
   rationale the ARCHITECTURE text does not carry.
5. Sequence with `architect-password-reset-gate-docs`, `architect-accreditation-docs-drift-sweep`
   and `architect-api-contracts-emdash-sweep`, which edit neighbouring § 6.3 and § 6.4 lines and
   the same contract files; whichever lands second keeps the other's lines.

## Acceptance criteria

1. Every ARCHITECTURE and contract sentence decided 2026-10-08 is true of the code once its task
   is archived, and no "lands with" marker outlives its task.
2. The blocked tasks above are unblocked at the archive that frees them.
3. The two solutions entries are refreshed, or the archive note says why not.
