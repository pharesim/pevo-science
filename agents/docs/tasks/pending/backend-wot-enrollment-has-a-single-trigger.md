# WoT enrollment has a single trigger and nothing repairs a missed one

**Owner:** backend
**Created:** 2026-10-05
**Priority:** normal

Filed from the accreditation and Web of Trust audit (finding 9). One reviewer reported it as a
finding and two more as a residual risk. It was read from code; the validator batch did not
include it and incidence was not measured.

## Why

`broadcastWotAccreditation` (`backend/src/wot.ts`) has one caller: the `POST /api/wot/vouch`
handler, which the voucher's client calls after it has broadcast the vouch. A vouchee who reaches
the threshold is enrolled only if that one call gets through each of these:

- the voucher gate, which reads the cached membership set, so a voucher accredited within the
  last 10 minutes can get 403 after their vouch is already on chain;
- the HAF poll: `pollForVouch` reads at most four times, 1.5 s apart, so its last read starts
  about 4.5 s after its first;
- the admin broadcast: a timeout or a chain error is answered with 200 and is not retried.

When the call does not get through, the vouchee has enough vouches (`eligible: true` on
`GET /api/wot/:username`) and no accredit op, and nothing enrolls them until some accredited
account posts another `/vouch` for them. The vouch form is hidden from an account that has already
vouched (`canVouch` in `frontend/src/components/vouch-section.js`).

## Scope

1. Add a periodic in-process job (the deployment is one instance) that enrolls every vouchee who
   meets the vouch threshold and holds no current, not-sanctioned accredit op. Start and stop it
   with the other background jobs in `backend/src/index.ts`; `backend/src/jobs/` holds the
   existing ones.
2. One HAF query per cycle lists the candidates. It decides eligibility by the rule
   `getVouchStatus` uses (vouchers counted from `accred_pinned` over `active_vouches`) and
   excludes any vouchee that has an `accred_pinned` row.
3. Each candidate goes through `broadcastWotAccreditation`, so its guards stay the only path to
   the admin key. A sanctioned vouchee has no `accred_pinned` row, so the query lists it on every
   cycle and `hasUnliftedSanction` refuses it each time. That is accepted.
4. A cycle that fails, or a candidate whose broadcast ends in `timeout` or `chain_error`, is left
   for the next cycle. No retry inside a cycle.
5. The interval is a few minutes and comes from config.

## Out of scope

- The `/vouch` route's own trigger. It stays.
- New log lines beyond what the existing jobs emit for a failed cycle.

## Acceptance criteria

1. Real-Postgres synthetic-CTE coverage for the candidate query, following the redirect pattern
   `tests/active-vouches-signer-gate.test.ts` uses: a vouchee at the threshold with no accredit
   op is listed; one below the threshold is not; one that holds a `wot` or an authority-pinned
   accredit op is not.
2. A cycle calls `broadcastWotAccreditation` once per listed candidate, and a candidate whose
   broadcast fails is listed again on the next cycle.
3. Comments follow root `CLAUDE.md` "Comment anchors".

## [BLOCKED by Architect] (2026-10-05) — sequenced behind the stale-membership task

Waits for `backend-wot-auto-accredit-reads-stale-membership` to be archived. Both tasks change
`backend/src/wot.ts`, and that task replaces the already-accredited check inside
`broadcastWotAccreditation`, which this job calls for every candidate. The architect moves this
file to `pending/` when that task is archived.

## Architect note (2026-10-08): unblocked

`backend-wot-auto-accredit-reads-stale-membership` is archived. `broadcastWotAccreditation` now
reads eligibility and `self_pinned` (whether the vouchee has an `accred_pinned` row) from one
cached snapshot (`getVouchSnapshot`, key `vouchStatusCacheKey(vouchee)`), and broadcasts only when
`self_pinned` is `false`. The sweep needs two things the `POST /vouch` route already does:

1. **A name check.** The route's `validateVouchee` checks `HIVE_ACCOUNT_NAME_REGEX`
   (`backend/src/lib/hive-account-name.ts`); `broadcastWotAccreditation` does not, and the admin
   key signs an accredit op whose `account` is the vouchee. A vouch on chain can name any string,
   so check each candidate with that regex before the call.
2. **A fresh read.** `pollForVouch` busts `vouchStatusCacheKey(vouchee)` before it reads. Bust it
   before each candidate's call too, so the guard reads HAF rather than a snapshot cached up to
   60 s earlier.

Acceptance, added: a candidate that fails `HIVE_ACCOUNT_NAME_REGEX` is not passed to
`broadcastWotAccreditation`.
