# The WoT auto-accredit decides "already accredited" from a stale cache

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 5, with finding 20 and one item from
its residual list). Five reviewers reported it independently and the validator confirmed it from
the code. It was read from code, not exercised against a chain.

## Why

`broadcastWotAccreditation` (`backend/src/wot.ts`) skips the broadcast when
`getAccreditedSet([vouchee])` contains the vouchee. `getAccreditedSet`
(`backend/src/accreditation.ts`) answers from the `accredited_accounts_all` cache entry whenever
that entry is present. The entry is in the stable tier with a 10-minute TTL: `clearVolatile` does
not flush it, and no `hafCache.invalidate` call in `backend/src` names it. So for up to 10 minutes
after an account's accredit op is indexed, the cached set can still lack that account.

Inside that window, for a vouchee at or above the vouch threshold:

1. Every `POST /api/wot/vouch` that names the vouchee, from any accredited caller, broadcasts
   another admin-signed `method: 'wot'` accredit op. The route calls `broadcastWotAccreditation`
   whether or not the caller's own vouch surfaced in the poll, and `wotWriteLimiter` admits 10
   calls per minute per account.
2. If the vouchee's current accredit op is authority-pinned (`email`, `orcid` or `manual`), the new
   `wot` op becomes the account's latest accredit op. `accred_latest` in
   `activeAccreditationsCteBody` (`backend/src/hafsql.ts`) takes method and metadata from the
   latest accredit op, so the account becomes a WoT member: its name is its username, its
   institution is "Web of Trust", its field is empty, and its membership follows the live vouch
   count. When those vouches are retracted the account is no longer accredited.

## Scope

1. `broadcastWotAccreditation` broadcasts only when the vouchee has no row in `accred_pinned`,
   that is, no current, not-sanctioned accredit op of any method. Take that from HAF in the same
   read that decides eligibility, not from `getAccreditedSet`. `getVouchStatus` already reads
   `accred_pinned` for the vouchee (the `self_method` subquery in `vouchStatusSelect`), and
   `pollForVouch` busts that cache entry before the route calls `broadcastWotAccreditation`.

   Carry row presence, not the method value. `self_method` is the op's `method`, which is SQL
   NULL for an accredit op that carries no method, while `accred_pinned` still holds that account
   (`activeAccreditationsCteBody` treats an absent method as an authority op). A check on
   `accreditation_method !== null` alone would broadcast over such an op.

   Why a row means "do not broadcast": an authority-pinned row is accredited, and a `wot` row is
   already enrolled, with its standing recomputed from the vouch graph on every membership read.
2. Keep the `hasUnliftedSanction` refusal. A sanctioned account has no `accred_pinned` row, so it
   still reaches that guard.
3. Delete the `getPool()` fetch and its `skipped` return that sit between the sanction guard and
   the `try` block. Nothing reads `pool` there.
4. `POST /api/wot/vouch` and `POST /api/wot/retract` check `vouchee` for type and length (at most
   50 characters) only, and their 400 message says it "must be a valid Hive username". Given
   threshold vouches on chain from accredited accounts that name an arbitrary string, the admin
   key signs an accredit op whose `account` is that string. Validate `vouchee` with `HIVE_ACCOUNT_NAME_REGEX`
   (`backend/src/lib/hive-account-name.ts`) in both handlers.
5. The docblock on `broadcastWotAccreditation` says the broadcast "only fires on the FIRST
   threshold crossing". Cut that sentence down to what the new guard does. Delete rather than
   extend.

## Out of scope

- The seconds between a broadcast and HAF indexing it. A second call in that gap can still
  broadcast. Do not add an in-process guard for it, and do not write a comment that says the gap
  is closed.
- `getAccreditedSet` itself and its other callers. The voucher gate on `/vouch` and `/retract`
  keeps its cached read. `handleAccredit` in `routes/orcid.ts` and the resume probe in
  `routes/signup-verify.ts` read the same set for the caller's own account and stay as they are.
- A periodic enrollment sweep. That is `backend-wot-enrollment-has-a-single-trigger`, sequenced
  behind this task.
- `VouchStatus.accreditation_method` stays in the response.

## Acceptance criteria

1. With `accredited_accounts_all` warm and lacking the vouchee, an eligible vouchee that holds
   (a) an authority-pinned accredit op, (b) a `wot` accredit op gets no broadcast. The spec runs
   the real `getAccreditedSet`, not a mock of it. State in the signal block that the same spec
   broadcasts in both cases against the code before this change.
2. An eligible vouchee with no accredit op and no sanction gets exactly one broadcast. A
   sanctioned vouchee still gets `reason: 'sanctioned'`.
3. `/vouch` and `/retract` answer 400 for a `vouchee` that fails `HIVE_ACCOUNT_NAME_REGEX`.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- State in `ARCHITECTURE.md` § 2 that the WoT auto-accreditation never broadcasts over an
  existing accredit op.
- Move `backend-wot-enrollment-has-a-single-trigger` from `blocked/` to `pending/`.
