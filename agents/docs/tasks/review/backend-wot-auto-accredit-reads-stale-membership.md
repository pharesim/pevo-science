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

## Backend implementation signal (2026-10-08, commits dc14b5e6, 72e96c3a, e07c3716, 4f47b955; learnings cc3c3498)

Each SHA self-verified with `git merge-base --is-ancestor <sha> main`.

**What landed, per scope item**

1. `vouchStatusSelect` gains `EXISTS (SELECT 1 FROM accred_pinned WHERE account = $N) AS self_pinned`
   in the same read as eligibility. `getVouchStatus`'s cached value is now an internal
   `VouchSnapshot` (the public `VouchStatus` plus `self_pinned`), read by `broadcastWotAccreditation`
   through the private `getVouchSnapshot`. `getVouchStatus` strips the field, so GET
   `/api/wot/:username` and `vouch_status` on `/vouch` and `/retract` keep their six documented
   keys: no API shape change (pinned by the spec "leaves self_pinned off the status it returns").
   The broadcast skips unless `self_pinned === false`. Both the row mapping and the guard fail
   closed: a mocked row without the column, and a `vouch_status` entry cached by an older build
   without the field, both skip (one spec each). `getAccreditedSet` is no longer read here; its
   import is gone.
2. The `hasUnliftedSanction` refusal stays, after the presence check.
3. The dead `getPool()` / `skipped` lines are deleted.
4. `validateVouchee` (body-only, `typeof` plus `HIVE_ACCOUNT_NAME_REGEX`, read through
   `assertBodyRecord`) is mounted `verifyHiveSignature, validateVouchee, wotWriteLimiter` on both
   routes, per `solutions/conventions/account-keyed-limiter-after-auth-validator-before-limiter.md`,
   so a malformed vouchee takes no wot-write slot (pinned on `/retract`). The old in-handler
   type/length checks are gone. A POST with no JSON body now gets this 400 instead of a 500
   TypeError (user-approved in triage, 2026-10-08).
5. The docblock now says the broadcast "is skipped for a vouchee that has an `accred_pinned` row,
   whatever its method". The "FIRST threshold crossing" sentence is gone. Also narrowed, because
   this change made them false: the inline already-accredited and sanction-guard comments, the
   `/vouch` "hits the poll's fresh cache" clause and skipped-arm comment, the `hasUnliftedSanction`
   docblock's "absent from `getAccreditedSet`" sentence, and the `vouchStatusCacheKey` docblock.

**Acceptance evidence**

- AC1: `wot-broadcast-timeout.test.ts` runs the real `getAccreditedSet`: an `importOriginal` partial
  mock replaces only `hasUnliftedSanction`. `accredited_accounts_all` is warmed stable with a set
  lacking the vouchee. With base `9744046d` `src/wot.ts`, the same spec broadcasts (`{ ok: true }`)
  for the authority-pinned (`email`) case and the `wot` case, and for the method-less case too.
  Observed in my red run and again in the verification workflow's base-control run. All skip at head.
- AC2: happy path asserts `toHaveBeenCalledTimes(1)`. The sanctioned spec still returns
  `reason: 'sanctioned'`.
- AC3: `Bob`, `a..b`, `ab`, a 17-character name and `bob-` each answer 400 `BAD_REQUEST` on both
  routes. Old code: `/retract` 403, `/vouch` 500.
- AC4: the pre-commit anchor gate passed on every commit, and `tests/eslint` is 146/146.
- Real-Postgres SQL (`wot-vouch-status-select-real-postgres.test.ts`): `self_pinned` is true for a
  `wot` account with no accredited vouchers and for a method-less op (while `self_method` is null),
  and false for an unaccredited account and for an accredit op followed by a sanction.

**Verification**

- WoT and related specs: 18 files, 218 tests green with `--retry=0` at 4f47b955.
- Typecheck clean. Lint shows 0 errors and 1 pre-existing warning in `lib/author-supersession.ts`.
- Full suite at e07c3716: exit 1, 6 files and 15 specs red, all on the standing red bar
  (`idempotency-real-haf` 2, `accreditation-idempotency` 6, `papers-enrichment-parity-gate` 1,
  `profile-auth-bypass` 3, `reviews` 2, `cast-hardening-author-index-weight` 1). No WoT file is red.
  `accreditation-idempotency` fails identically on a clean HEAD copy.
- Verification workflow (mutation prober, correctness adversary, comment auditor, one refuter per
  finding): 11 planted mutants, 10 killed. The survivor swaps the presence and sanction guards and
  has no observable output change. No path leaks `self_pinned` or broadcasts over an op HAF has
  already indexed. EXPLAIN on the EXISTS column showed one extra InitPlan over the
  already-materialized `accred_pinned`.
- Simplify: `/ce-simplify-code` ran with 3 reviewers. Applied 5: `assertBodyRecord`, a shared
  `ELIGIBLE_VOUCHES` fixture, a cached-status spec that a cache miss would fail, a dead mock, and a
  stale comment. Skipped 3: an exported row type, a `pushRow` closure over pre-existing helper
  lines, and deleting the docblock skip sentence that Scope 5 asks for.
- Code review: deferred to the architect's `/ce-code-review` at intake (backend role rule).

**User triage (2026-10-08) of verified findings**

- Fixed: the real-Postgres companion's header no longer says `wot-broadcast-timeout` uses its
  FROM-redirect technique. The body-less POST now gets a 400.
- Declined, as hardening against a future edit: non-string vouchee specs, a `/vouch` twin of the
  limiter-slot spec, and pinning the guard order.

**Learnings checkpoint:** `/ce-compound-refresh` Updated
`conventions/test-haf-sql-selection-redirect-cte-from-synthetic-values-2026-06-09.md` and
`conventions/vouch-three-senses-consented-not-vouched-2026-06-06.md`, and narrowed the auto-grant
sentence in CONCEPTS.md "Vouch" and "Vouch Threshold" (cc3c3498, `[skip-zone-audit]`).

The first entry's examples named the deleted `cascadeDiscoverySelect` and a `runDiscovery` helper.
The second claimed three vouches always trigger a `wot` accredit. `/ce-compound` wrote nothing,
because both candidates fall below the bar:
- `RegExp.test` coerces `undefined` to the valid name "undefined". With `assertBodyRecord`'s
  `unknown`, tsc now rejects any unguarded `.test(vouchee)`.
- The cached-membership gate lesson is carried by the guard and `VouchSnapshot` comments, plus
  item 11 of `backend-accreditation-wot-comment-and-dead-code-pass`.

**[TODO Architect] additions**

1. The first bullet of the archive TODO ("never broadcasts over an existing accredit op")
   overclaims. An accredit op broadcast but not yet indexed has no `accred_pinned` row, so a
   `/vouch` in that gap still broadcasts, which Out of scope accepts. Suggested § 2 wording: "the WoT
   auto-accreditation skips any vouchee that HAF shows holding a current, not-sanctioned `accredit`
   op of any method, and refuses a vouchee with an un-lifted sanction". CONCEPTS.md "Accreditation
   Method" ("granted automatically once the vouch threshold is crossed") may want the same
   precondition.
2. `api-contracts/accreditation.md`: the `/vouch` and `/retract` `BAD_REQUEST` lines should read
   "`vouchee` missing or not a valid Hive account name". That also covers a request with no JSON body.
3. Pre-existing doc drift: `ARCHITECTURE.md` § 2 and CONCEPTS.md "Vouch", "Accreditation Authority
   Whitelist" and "Active Accreditations" say vouches are validated against the live membership
   view. The code counts them against `accred_pinned` holders (`aa_wot_counts`, `vouchStatusSelect`),
   which include below-threshold WoT members. The `vouchStatusSelect` docblock says this is
   deliberate.
4. For `backend-wot-enrollment-has-a-single-trigger` when it is unblocked: `HIVE_ACCOUNT_NAME_REGEX`
   is checked only in the route validator. A sweep that feeds HAF-sourced vouchee strings into
   `broadcastWotAccreditation` needs its own name check.
5. For `backend-accreditation-release-op`: this guard broadcasts only when `accred_pinned` has no
   row. If the release exclusion lands in `active_accreditations` only, a released account with
   threshold vouches keeps its row and is never re-enrolled, contrary to ARCHITECTURE § 2 ("the WoT
   path re-enrols it"). It must exclude released accounts from `accred_pinned` for that sentence to
   hold.
6. Clause (c) gap: no real-path test exercises `hasUnliftedSanction`. Every suite that touches it
   mocks it.

**Out of scope, for follow-up filing:** `wot-broadcast-timeout.test.ts` still carries two
pre-existing inaccurate comments ("PrivateKey.fromString(...) runs first", and "Threshold params
query (update_params): no rows => default 3", where the default actually comes from the rejected
`pool.connect`).
