# /verify tells a WoT enrollee below the threshold that they are accredited

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 1). Seven reviewers reported it and
the validator confirmed it from the code. Incidence was not measured.

**Sequencing:** `backend-latest-op-haf-lookups-walk-the-blocks-index` rewrites the same query.
Take that task first. If it is not archived when you pick this one up, stop and say so.

## Why

`POST /api/accreditation/verify` calls `findExistingAccreditation`
(`backend/src/lib/idempotency.ts`) before anything else that reads the chain. That helper returns
a hit whenever the account's latest authority-signed op among `accredit` and `revoke` is an
`accredit`, whatever its `method`. On a hit the route writes the completion record, which deletes
the pending token, and answers 200 "Accreditation confirmed" with `outcome: 'already_accredited'`.
It broadcasts nothing.

For an account in the "Below-threshold (WoT)" state of `ARCHITECTURE.md` § 2, the latest op is a
`method: 'wot'` accredit and the account is not accredited: `active_accreditations` drops a `wot`
row that does not meet the live vouch threshold. A user in that state who verifies an
institutional email is told they are accredited, loses the token, and stays unaccredited.
`POST /api/wot/retract` broadcasts no revoke, so ordinary retractions lead there.

**Decision (user, 2026-10-05):** an email verification makes any WoT enrollee authority-pinned,
whether or not the account currently meets the threshold.

## Scope

1. The gate short-circuits only when the latest op is an `accredit` whose method is not `wot`.
   Use `IS DISTINCT FROM 'wot'`, the test `auth_accredit` applies in `activeAccreditationsCteBody`
   (`backend/src/hafsql.ts`). When the latest op is a `wot` accredit, `/verify` goes on to the
   sanction guard, the per-token lookup and the broadcast, so the `method: 'email'` op becomes the
   account's latest accredit op.

   What stays as it is: a latest `revoke` is still a miss, and `hasUnliftedSanction` still refuses
   a sanctioned account after the gate. Once the email op is indexed, a second pending token for
   the same account sees an `email` accredit as the latest op and hits the gate.
2. Two comments in the `/verify` handler equate a gate hit with "currently accredited": the one
   at the gate ("is this account already accredited?") and the opening of the "Ever-sanctioned
   guard" comment ("reaching here means the account is NOT currently accredited (latest op is a
   revoke or there is no accredit)"). Cut each to what the gate checks.
3. The `findExistingAccreditation` docblock says "The WoT cleanup path in routes/wot.ts is a live
   producer of revoke ops" and "Scope per the filing task". No WoT path broadcasts a revoke, and
   the second is a task redirect. Delete both while you are in that docblock.

## Out of scope

- The per-token idempotency branch (`already_landed`). It stays.
- The limiters, the session requirement and the mail text. Each has its own task.

## Acceptance criteria

1. A `/verify` spec for an account whose latest op is a `wot` accredit below the live threshold:
   the route broadcasts an accredit op with `method: 'email'` and answers 200 with no `outcome`.
2. An account whose latest op is an `email`, `orcid` or `manual` accredit still answers
   `already_accredited` and broadcasts nothing.
3. A sanctioned account whose latest op is a `wot` accredit is refused with 403
   `ACCREDITATION_SANCTIONED`.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Update the `already_accredited` paragraph of `api-contracts/accreditation.md`, and say in
  `ARCHITECTURE.md` § 2 that an email verification pins a WoT enrollee.
- `/ce-compound-refresh` on `accreditation-state-read-latest-action-wins-2026-05-15.md`.
  The same refresh deletes the entry's claim that `backend/src/wot.ts:347` produces revoke ops,
  in its sibling-site list and in "The bug is reachable, not theoretical". `wot.ts` broadcasts no
  revoke op; the admin sanction route (`/accreditation/sanction` in `routes/admin.ts`) does.
  (Added 2026-10-07 from the review of `backend-latest-op-haf-lookups-walk-the-blocks-index`.)
