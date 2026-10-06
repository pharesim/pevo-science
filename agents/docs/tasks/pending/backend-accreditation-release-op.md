# An account can give up its accreditation: the release revoke and its two endpoints

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Revocation (custom_json)", "Accreditation Lifecycle & Sanctions"
("Release is ordinary"), "Credential Bindings"; wire format `hive-schemas.md` § 2.2.

## Why

Today the only op that ends an email-, ORCID- or manual-pinned accreditation is a `revoke` with
`type: "sanction"`, which is sticky and stigmatising. A researcher who moves to another account
has no way to free their mailbox, and an admin has no non-sanction tool for a holder who lost
their keys. The `type: "release"` revoke is that tool.

## Scope

1. **Type.** `RevokeAction.type` in `backend/src/types/hive.ts` becomes `'sanction' | 'release'`.
2. **Membership SQL** (`activeAccreditationsCteBody` in `backend/src/hafsql.ts`): an account whose
   latest `type: "release"` revoke is later, by `(block_num, op id)`, than its latest `accredit` op
   is not accredited. A legacy revoke (no `type`) stays ignored. Keep the sanction predicate as it
   is. `accreditationStatusCteBody` reports such an account as `released`. While in this code: make
   `hasUnliftedSanction` (`backend/src/accreditation.ts`) compare `(block_num, op id)` like
   `accred_pinned` does, not block numbers alone.
3. **Latest-op readers.** `findExistingAccreditation` (`backend/src/lib/idempotency.ts`),
   `getExistingAccreditation` (`backend/src/routes/orcid.ts`) and `findAccreditedAccountWithOrcid`
   (`backend/src/lib/orcid-binding.ts`) already treat a latest revoke as not accredited, which is
   the right answer for a release; confirm with tests and leave their legacy-revoke behaviour to the
   comment pass task.
4. **Holder endpoint** `POST /api/accreditation/release`: `verifyHiveSignature`, then on the JWT
   path a single-use fresh-auth proof bound to action `release_accreditation` and the caller's
   username (consent-op kind, as `PATCH /api/accreditation/metadata` does); the Keychain path is
   fresh at the middleware. Gates: the caller is currently accredited under the membership rule
   and not sanctioned (a sanctioned account answers 403 `ACCREDITATION_SANCTIONED`: its bindings
   stay held). Broadcast the admin-signed `revoke` with `type: "release"`, `reason` fixed
   ("released by the account holder"), `issued_by` = the account itself (as `retract_paper`
   writes for an author self-retract). The rows move only after the broadcast returns: on
   definite success call the registry's release helper (`backend-mailbox-binding-registry`) so
   every live `mailbox_bindings` row of the account becomes `released` with `released_by =
   'holder'`, and invalidate the `accredited_accounts_all` cache key. On a node refusal or a
   timeout the rows stay `bound` (`chain-write-timeout-ambiguous-outcome`). The gate therefore
   also admits a released account that still holds live rows: its retry re-reads HAF, finds its
   own release op and completes the row move without a second broadcast.
5. **Admin endpoint** `POST /api/admin/accreditation/release` next to the sanction route in
   `backend/src/routes/admin.ts`: roster tier `admin` or above, fresh re-auth as for the sanction,
   body `{ account, reason }`. Same broadcast with `issued_by` = the acting admin, same registry
   release with `released_by` = the acting admin, same row-move order. The target must be
   currently accredited and not sanctioned (403 `ACCREDITATION_SANCTIONED`: its bindings stay
   held); the admin console wiring is `ui-accreditation-release-flow`. The sanction route's
   comment "the only `revoke` the backend broadcasts" and the `RevokeAction` comment "no longer
   broadcasts any non-sanction revoke" become false; delete or narrow them.
6. **Consumers of status.** The notification query that emits `accreditation_update` and the
   accreditation status route distinguish `released` from `revoked`; the WoT read side already
   counts vouches only from `accred_pinned`, so a released voucher stops counting with no further
   change.

## Out of scope

- Mailbox registry rows themselves (`backend-mailbox-binding-registry`).
- ORCID stickiness (`backend-orcid-binding-sanction-sticky`).
- UI (`ui-accreditation-release-flow`).

## Sequencing

After `backend-mailbox-binding-registry` (the release helper) and after
`backend-latest-op-haf-lookups-walk-the-blocks-index` and `backend-wot-read-side-drops-self-vouch`,
which edit the same CTE bodies.

## Acceptance criteria

1. After a release, `active_accreditations` omits the account, its vouches no longer count, and the
   write gates refuse it; a later `accredit` op from any path re-admits it.
2. A legacy revoke still has no effect; a sanction still blocks until an admin grant.
3. The holder endpoint refuses a JWT without a bound fresh-auth proof (401), a mismatched proof
   (403), an unaccredited caller (422) and a sanctioned caller (403), and never broadcasts in those
   cases.
4. The admin endpoint refuses below tier `admin`, without a fresh re-auth, and for a sanctioned
   target.
5. On definite success every live `mailbox_bindings` row of the account is `released`; on a
   timeout none is, and a retry from the released account completes the move with no second op.
6. Specs whose focus is authentication run the real `verifyHiveSignature` (root `CLAUDE.md`
   "Running Tests" clause (b)). No emdash in response text. Comments follow "Comment anchors".

## [TODO Architect] at archive

- `api-contracts/accreditation.md`: `POST /api/accreditation/release`; the `released` status value.
- `api-contracts/misc.md` or the admin contract: `POST /api/admin/accreditation/release`.
- `ARCHITECTURE.md` § 6.4 row "Release own accreditation" marked implemented.
- `api-contracts/custody.md`: `release_accreditation` joins the fresh-auth `action` list on both
  issuance paths (password and ORCID).
