## The WoT auto-accredit decides "already accredited" from a stale cache (archived 2026-10-08): clean review; one P3 contract-doc line fixed in place, five follow-ups folded into open tasks, three items already covered

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `dc14b5e6`, `72e96c3a`, `e07c3716`, `4f47b955` and the learnings commit `cc3c3498` (branch-remote, base `905a3d7d`): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, api-contract, reliability, learnings. Verdict "Ready with fixes", no code defect; every scope item and AC met. Adversarial reproduced AC1 (base src with the head spec broadcasts for the email, wot and method-less cases; head skips). Testing killed all nine planted mutants; the orchestrator checked the mutation script against the brief. Security found the regex equivalent to hived's account-name rule and linear on a 1M-char input; `self_pinned` never leaves the process.
- **Fixed in place (`545e02e9`):** the `/vouch` and `/retract` `BAD_REQUEST` lines and the `accreditation_method` null clause in `api-contracts/accreditation.md`; ARCHITECTURE § 2 gains "WoT auto-accreditation" in the implementer's narrower wording (the skip misses an op not yet indexed), and the whitelist paragraph plus CONCEPTS "Vouch", "Accreditation Authority Whitelist", "Active Accreditations" and "Accreditation Method" now say vouches count against `accred_pinned` holders, not the live membership view.
- **Folded into open tasks:** the `VouchStatus.accreditation_method` docblock (item 21 of `backend-accreditation-wot-comment-and-dead-code-pass`); line-number anchors in `wot-vouch-broadcast-outcomes.test.ts` and two inaccurate comments in `wot-broadcast-timeout.test.ts` (`backend-wot-comments-cite-deleted-retract-suite`); the clause (c) companion for the `hasUnliftedSanction` mock (note on `backend-failed-sanction-read-is-not-a-sanction`); release must leave `accred_pinned` (note on `backend-accreditation-release-op`). `backend-wot-enrollment-has-a-single-trigger` moved to `pending/` with a name-check and fresh-read note.
- **Dismissed as covered:** the dead `wot-retract-cascaderevocation` citation (`backend-wot-comments-cite-deleted-retract-suite`), the same-block sanction tie in `hasUnliftedSanction` (`backend-accreditation-release-op` Scope 2 and item 14 of the comment pass), the SHA and slug in the vouch-three-senses entry (`architect-solutions-entries-carry-coordination-context`). Dismissed: the "Vouch Threshold" symmetry edit, listing `routes/wot.ts` in the limiter-convention entry, a `/vouch` twin of the limiter-slot spec (declined in the implementer's triage).
- **Learnings checkpoint:** no solutions entry is contradicted by the change; the implementer's `cc3c3498` refresh of two entries holds against the code. Nothing new for `/ce-compound`.

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

## An upload's username mismatch after a cross-tab sign-in signs the new account out (archived 2026-10-08): clean review; Remintable Rejection reason dropped, two pre-existing misreports filed, two items already filed, two dismissed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `ffbfce29` and `083e2577` (branch-remote, base `2401ad5d`): correctness, security, adversarial (in-process, no cross-model peer), julik-frontend-races, testing, project-standards, learnings. Verdict "Ready to merge"; every scope item and AC met, zero findings. Account-state defense review clean: the new branch keys on the client-side subject generation only, every generation bump runs through `_scrubSubjectBoundState`, which clears the session-proof slot first, and no JWT-only path is added. Testing re-measured the signal's six mutants, all killed; m4 killed 4, not the claimed 3 (the extra is the real-window "two uploads" test). The orchestrator checked each planted mutant against the brief, re-ran all six with identical counts, and re-ran the full suite (98 files, 2297 tests, exit 0) and `npm run build` on `083e2577` in an isolated copy.
- **Triage (user: "approved" as recommended):**
  - Fixed in place: `CONCEPTS.md` "Remintable Rejection" drops the corrupt-session because-clause; the mismatch stays terminal (`2a9d3cb8`, signal out-of-scope item 2).
  - Filed: signal out-of-scope items 3 and 4 -> `ui-upload-misreports-a-mid-upload-account-switch` (low). At filing, the self-custody branch was found to rethrow the transfer's 401 raw too, so the task covers both transfer codes there.
  - Already filed: item 1 -> `ui-orcid-callback-caches-a-departed-subjects-proof`; item 5 -> item 2 of `ui-teardown-message-and-mapper-mock-wording`.
  - Dismissed: the broadcast and consent-op mismatch arms read no subject guard (reaching them needs an already-corrupted departed session, the ORCID task closes the main source, and the task ruled out symmetry-only changes). The guard-report learnings entry's "sign in again" sentence (historical, true wherever a teardown fires).
- **Learnings checkpoint:** the learnings reviewer checked `guard-report-dedupes-per-event-not-per-holder-2026-09-02.md`, `await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md` (the `083e2577` narrowing is accurate), `subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md`, `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` and `shared-verifier-primitive-canonical-status-mapping-2026-05-16.md`; none is contradicted. The only contradicted text was the `CONCEPTS.md` sentence, fixed above. No new entry: the rationale lives in `mismatchError`'s docblock.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

Routed out of the architect archive of the fresh-auth count-tally task (archived
2026-10-01). The implementer's last sweep reported it as behaviour outside that
comment-only task; an architect-side check against the code confirmed it, and the
user approved filing it.

## Why

`uploadFile` (`lib/ipfs-upload.js`) opens a subject teardown guard at entry and checks it
before each retry leg re-acquires, so a cross-tab subject change during an upload unwinds
with `UPLOAD_SUBJECT_CHANGED` instead of acting for the new account. The two mismatch
branches do not check it: on `isUsernameMismatch(err)` both the first-attempt catch and
`retryOnce`'s catch throw `tornDownSession()`, which calls `handleSessionInconsistency()`.
That function disconnects whenever the store is connected, and its own docblock says so:
"This gate does not protect a session established after the flight began; a detector
that finds the store connected always disconnects it."

A reachable sequence: account X starts an upload. `uploadFileToIpfs` (`api.js`) hashes the
file (`sha256File`) before `authenticatedRequest` reads the JWT for the pre-flight. While
the file hashes, the user signs in as Y in another tab. The storage event scrubs this tab
and adopts Y. The pre-flight then sends X's window proof with Y's JWT, and the backend
