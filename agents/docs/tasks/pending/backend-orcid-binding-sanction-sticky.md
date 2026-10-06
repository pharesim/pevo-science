# A sanctioned account's ORCID stays bound; a release frees it

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decision with the user, 2026-10-06:
each credential binds one account and a sanction keeps every credential of the account bound).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings", "Where the ORCID binding lives".

## Why

`findAccreditedAccountWithOrcid` (`backend/src/lib/orcid-binding.ts`) takes the latest
authority-signed accredit-or-revoke op of the account carrying the ORCID and returns null when
that op is a revoke, whatever its `type`. A sanction therefore frees the ORCID at the chain read,
and `handleAccredit` (`backend/src/routes/orcid.ts`) checks the sanction only on the new account,
so a sanctioned researcher can accredit a fresh account with the same ORCID. The same read also
follows only the single latest op carrying the ORCID, so an admin grant, whose payload has no
`orcid` field, drops the binding as well. `handleLink` broadcasts an authority accredit op without
calling `hasUnliftedSanction`.

## Scope

1. `findAccreditedAccountWithOrcid`: when the holding account's latest revoke is `type:
   "sanction"`, the ORCID stays bound to that account (return it, with the sanctioned state so
   the caller can word the refusal); `type: "release"` frees it (today's behaviour); a revoke
   lacking `type` is ignored, as membership ignores it (today it frees the ORCID). Keep the
   fenced-read shape required by `haf-custom-json-latest-op-materialized-fence-2026-06-14.md`.
   Its comment "a subsequent 'revoke' clears it" becomes false; delete or narrow it.
2. `handleAccredit` and the signup finalize ORCID check: an ORCID bound to a sanctioned account
   answers 409 `ORCID_ALREADY_LINKED` with the existing message; no account name in the response.
   `POST /api/orcid/callback` also checks `accounts.orcid` for the ORCID before the broadcast
   (today the row UPDATE runs after it and a conflict lands the op, then answers 502
   `POST_BROADCAST_OPERATOR_REQUIRED`); a released account keeps its row's ORCID as a login
   factor, so the row check is what blocks a second row-holding account until that row is deleted.
3. `POST /api/admin/accreditation/grant`: carry the target's attested ORCID forward (read from its
   latest accredit op carrying one), so a grant does not unbind it. `PATCH
   /api/accreditation/metadata` already carries `orcid` forward; mirror that.
4. `handleLink`: refuse a sanctioned account with 403 `ACCREDITATION_SANCTIONED` before
   broadcasting, as every other accredit-broadcasting route does.
5. Comments follow root `CLAUDE.md` "Comment anchors"; the signup-verify comment calling the
   pre-lock check plus broadcast "not a TOCTOU" overclaims and is narrowed or deleted.

## Out of scope

- Re-running the chain check inside the binding lock (a separate finding; file if wanted).
- The `accounts.orcid` unique index and its post-broadcast conflict path.

## Acceptance criteria

1. Sanction account A (holder of ORCID X); account B's ORCID callback for X answers 409 and
   broadcasts nothing; after an admin grant lifts A, X is still bound to A.
2. Release A; B's callback for X succeeds.
3. An admin grant on an ORCID-accredited account leaves `active_accreditations.orcid` and the
   binding read unchanged.
4. `handleLink` on a sanctioned account answers 403 and broadcasts nothing.
5. Specs on real HAF; no emdash in response text.

## [TODO Architect] at archive

- `api-contracts/orcid.md`: the sanctioned-holder 409 and the `handleLink` 403.
