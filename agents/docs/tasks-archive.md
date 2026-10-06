## /verify accredits the requester's account for whoever opens the link (archived 2026-10-07): one round, clean code review; one docs finding fixed at archive; four tasks filed, three items folded

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on `8c5ba436` + `ef1cbdbd` (branch-remote over `379bc364..ef1cbdbd`, read from `git show` snapshots because HEAD had moved on), seven reviewers: correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, api-contract, learnings. Verdict "Ready with fixes": no code or test defect; S1-S6 and AC1-AC7 met. Testing killed 7/7 mutants (mismatch check removed, or moved after the admin-key branch; grace comparison reverted; `keyFn: byIp`; `verifyHiveSignature` dropped; mail sentence dropped; 503 removed from the refund set); `tests/eslint` 146/146 at head and base. One P3, validator-confirmed: the `ef1cbdbd` refresh edited a line of the redis-multi entry and kept "round-4 triage".
- **Triage (user, "as recommended", then A for the open row):** no hold; every fix landed at archive.
- **Applied at archive:** `b5c90240`: the `/verify` contract (auth headers, the 401s, 403 `ACCREDITATION_ACCOUNT_MISMATCH`, per-account 429, the grace-period 200 for the record's account only, the gate-unavailable entry no longer says "every invocation"); ARCHITECTURE § 6.4 rows for `/verify` (session or signature plus the mailed token bound to the account; the address is the requester's choice, not a registered factor, so the TODO's "the reset row's shape" was not used) and for `/request` (fresh proof bound to `request_accreditation`, decision A); § 2's rollout sentence that waited on the session gate dropped.
- **Filed** in `36fbf9ea`: `backend-accreditation-request-requires-fresh-auth` (normal; a stolen session alone could request and verify accreditation for an unaccredited account under any name and institution, while the metadata edit of the same fields needs a fresh proof); `ui-accreditation-request-acquires-fresh-auth` (normal, `blocked/` behind it; includes checking a Keychain user's way through, since `withSettingsFreshAuth` sends no proof for a non-light custody while the JWT path requires one); `ui-accreditation-verify-page-rate-limited-state` (normal; a 429 shows "Request New" while the link still works); `backend-retract-limiter-comments-say-url-keyed` (low; widened in `53fd5730` to four comments in two files); items 18-20 folded into `backend-accreditation-wot-comment-and-dead-code-pass` (the INTENTIONAL RED prose, the `fakePipeline` type-safety claim, the missing `misc.test.ts` carve-out header).
- **Signal's "Out of scope, for filing" list:** all five dispositioned. The "identical 200 envelope" comments were already item 6 of the comment pass; the other four are filed above.
- **Dismissed:** unauthenticated `/verify` now reaches no limiter (same posture as `/request` and every account-keyed route; single instance); the shared-password pretext (the user's decision accepts one party controlling both); no switch-account control on the mismatch page (the 403 message names the exit); the cap spec fits the 5/min bucket only while the cap is at most 4 (default 3).
- **Learnings checkpoint:** the implementer's `ef1cbdbd` refreshed three entries. At archive, `adfc91f8` refreshed the redis-multi entry (finding #1, five older round labels and a task slug; its pipeline snippet now matches `recordAccreditationCompletion`); `33d8b3e0` refreshed the evalscript entry (`postVerify(token)`); `32919881` replaced `validator-limiter-ordering-depends-on-key-class-2026-05-21.md` with `account-keyed-limiter-after-auth-validator-before-limiter.md` (user-confirmed: `retractLimiter` was never URL-keyed, the key-class rule was wrong, and a `validate()` validator must follow auth because the signature path hashes `req.body`) and narrowed the skip-failed entry's cross-reference. `CONCEPTS.md` scanned, no qualifying terms.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4). Two reviewers reported it and
the validator confirmed it from the code. Incidence was not measured.

## Why

`POST /api/accreditation/verify` has no auth middleware. The token from the mail is its only
credential, and the handler accredits `pending.hive_username`, the account that made the request.
`POST /api/accreditation/request` accepts any institutional address from any signed-in account.
So a requester can name someone else's mailbox, and the accreditation completes when anyone with
access to that mailbox opens the link: the SPA's verify page posts the token on load. The
accredit op then carries the name and institution the requester typed.

**Decision (user, 2026-10-05):** `/verify` requires the session of the account the link was
requested for. A verification then shows that one party controls both the mailbox and the account.

## Scope

1. `POST /api/accreditation/verify` runs `verifyHiveSignature` first, then
   `validate(accreditationVerifySchema)`, then the limiter: the order `/request` uses.
   `verifyHiveSignature` accepts the session JWT or a request signature and sets
   `req.hiveUsername`.
2. Once the pending row is loaded, refuse with 403 `ACCREDITATION_ACCOUNT_MISMATCH` unless
   `req.hiveUsername === pending.hive_username`. The refusal sits before the admin-key check, the
   HAF reads and the broadcast-attempt claim, and it leaves the token, the counter and any
   completion record as they were. Message (user-facing, no emdash): "This verification link
   belongs to a different account. Sign in as that account and open the link again."
3. The grace-period branch (no pending row, completion record found) answers its cached 200 only
   when the record's `username` equals `req.hiveUsername`. Otherwise it answers the same 400
   `BAD_REQUEST` it gives when there is no record.
4. The mail body gains one sentence: open the link in a browser where you are signed in to PEvO
   as the named account. (Naming the account in the mail is
   `backend-accreditation-mail-names-the-account`.)
5. This change makes some comments in the handler false. Delete or narrow them, do not rewrite
   them longer. Known ones:
   - two logging comments call the token "the SOLE credential at /api/accreditation/verify";
     keep only the part that still holds, that the token must not be logged in plaintext;
   - the soft-block comment says requiring re-auth "was considered" and rejected for the verify
     landing page.

## Out of scope

- The verify page (`ui-accreditation-verify-page-signs-in-first`, which lands first).
- The limiters' refund sets (`backend-accreditation-limiters-refund-work-already-done`). With
  that task's lists, a 403 mismatch consumes a slot.

## Acceptance criteria

1. Without a session or signature the route answers 401 and reads no token.
2. A session for another account gets 403 `ACCREDITATION_ACCOUNT_MISMATCH`; the token still
   verifies afterwards for the right account.
3. A completion-record retry answers 200 for the record's account and 400 for any other.
4. For the right account, every existing `/verify` outcome is unchanged.
5. The specs whose focus is this authentication run the real `verifyHiveSignature` (root
   `CLAUDE.md` "Running Tests", carve-out clause (b)).
6. No emdash in response or mail text. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- `api-contracts/accreditation.md`: `/verify` gains the auth headers, 401 and
  `ACCREDITATION_ACCOUNT_MISMATCH`.

## [BLOCKED by Architect] (2026-10-05) — sequenced behind the ui task

Waits for `ui-accreditation-verify-page-signs-in-first` to be archived. If this landed first, the
SPA's unauthenticated POST would answer 401 and the verify page would show its generic failure
state with a "Request New" button. The architect moves this file to `pending/` when the ui task
is archived.

## Unblocked (architect, 2026-10-06)

`ui-accreditation-verify-page-signs-in-first` is archived. The verify page now sends the session
on `POST /api/accreditation/verify` (`verifyAccreditation` uses `authenticatedRequest`), posts
nothing without one, maps `UNAUTHORIZED`, `SESSION_EXPIRED` and `SESSION_INVALIDATED` to its
sign-in state, and maps 403 `ACCREDITATION_ACCOUNT_MISMATCH` to a different-account state with no
"Request New" button. The page matches on `err.code`, not on the status: the 401s
`verifyHiveSignature` sends carry `UNAUTHORIZED` or `SESSION_INVALIDATED`, and the refusal in
scope item 2 must carry exactly `ACCREDITATION_ACCOUNT_MISMATCH`.

## Architect note (2026-10-06): key the `/verify` limiter by account

From the review of `backend-accreditation-limiters-refund-work-already-done` (user decision, 2026-10-06). `accreditationVerifyLimiter` is keyed by IP (5 per minute) and now counts every outcome except a 503 or 504, including the 400 a junk token gets. A client that shares an IP with the user, such as another machine behind a campus NAT, can keep that IP at 429 by sending junk tokens. Once scope item 1 puts `verifyHiveSignature` ahead of the limiter, `req.hiveUsername` is set when the limiter runs. Two additions:

- Scope 6. Key `accreditationVerifyLimiter` by account (`keyFn: byAccount`) and keep its window, max and refund set. The route-site comment above the `/verify` handler says the limiter is IP-keyed; narrow it. Specs that set `X-Forwarded-For` to get their own `/verify` bucket need their own account instead.
- AC 7. Junk-token 400s from one account do not bring a different account on the same IP to 429.

## Backend implementation signal (2026-10-06, commits 8c5ba436, ef1cbdbd)

Both SHAs verified on `main` with `git merge-base --is-ancestor`.

- `8c5ba436` backend(accreditation): /verify requires the session of the account the link was
  requested for.
  - `backend/src/routes/accreditation.ts`: the `/verify` chain is `verifyHiveSignature` →
    `validate(accreditationVerifySchema)` → `accreditationVerifyLimiter` (scope 1). Right after the
    no-pending-row branch, `pending.hive_username !== req.hiveUsername` answers 403
    `ACCREDITATION_ACCOUNT_MISMATCH` with the scope 2 message, before the admin-key check, the HAF
    reads and the cap claim (scope 2). The grace-period branch answers its cached 200 only when
    `completion.username === req.hiveUsername`, otherwise the existing 400 (scope 3). The mail
    gains "Open the link in a browser where you are signed in to PEvO as @<account>." on its own
    line before the link; the pinned sentences are untouched (scope 4). The limiter is
    `keyFn: byAccount` with window, max and refund set unchanged; the unused `byIp` import is
    gone (scope 6).
  - Comments (scope 5): both "SOLE credential" logging comments narrowed to "must not be logged
    in plaintext"; the soft-block paragraph loses the rotating-XFF sentence and the "hard-block
    and re-auth-required were considered" sentence; the route-site comment loses "IP-keyed",
    "per-IP" and "or chain reads" (a signature-path request now pays a chain read before zod).
    The same sole-credential claim is narrowed in `src/logger.ts`, `src/lib/log-pii.ts`
    (`hashTokenForLogs` docblock) and `tests/lib/logger-redact.test.ts`.
  - `backend/src/types/api.ts`: `ACCREDITATION_ACCOUNT_MISMATCH` added to `ErrorCode`.
  - Tests. `accreditation-idempotency.test.ts` (real `verifyHiveSignature`, session-JWT
    `postVerify(token, username)` on every call) gains the describe "the session must belong to
    the account the token was requested for": AC1 (401 `UNAUTHORIZED`; no Redis read of the
    pending key or the completion key; no HAF read, no broadcast; token kept), AC2 (403 with the
    exact message, sent with the admin key unset so a check placed after the admin-key branch
    would have deleted the token; no HAF read, no counter; then 200 for the owner), AC3 (other
    account 400 and the record survives; owner retry 200 equal to the first envelope; one
    broadcast). The 503-refund spec now drives all six calls from one account (with six accounts
    it passed without a refund). `accreditation.test.ts`: a describe-level banner states the
    clause (b) bypass for its `/verify` specs; the cap describe and the `accred-verify` limiter
    describe use a fresh account per spec instead of a fresh XFF IP; AC7 spec ("one account's
    invalid-token 400s do not bring another account on the same IP to 429"); the mail spec pins
    the new sentence. `accreditation-verify-sanctioned.test.ts` and `misc.test.ts` send the
    account.
- `ef1cbdbd` learnings checkpoint, see below.

**Red before green.** On the pre-change route the five new assertions failed for the expected
reasons: AC1 got 503, AC2 got 500 (the admin-key branch, which deletes the token), AC3 gave the
other account the cached 200, the mail lacked the sentence, AC7 got 429.

**Verification.**
- The seven files that touch `/verify`: 136 pass, 8 fail. The 8 are the same specs with the same
  messages as the clean-tree baseline at 82e1af9c (132 pass, 8 fail): six in
  `accreditation-idempotency.test.ts`
  (`backend-accreditation-idempotency-specs-skip-the-sanction-guard-read`) and the two cap specs in
  `accreditation.test.ts` (`backend-latest-op-haf-lookups-walk-the-blocks-index`). The four
  added passes are AC1, AC2, AC3 and AC7.
- `backend/tests/eslint` alone: 146/146.
- Full backend suite: 7 files / 17 specs fail, 2795 pass, the documented standing red bar
  (idempotency-real-haf 2, accreditation-idempotency 6, accreditation 2, papers-enrichment-parity-gate
  1, profile-auth-bypass 3, reviews 2, cast-hardening 1). Containers did not restart during the run.
- `npm run typecheck` clean; `npm run lint` 0 errors (one pre-existing warning in
  `src/lib/author-supersession.ts`).
- Simplify pass (three reviewers): 6 applied (a leftover `'accred-timeout-user'` literal, two
  restating comments, the false "5th-or-later request" comment, the seed helper's default
  account removed so call sites name it, a pointless pre-delete, the new describe's limiter
  cleanup narrowed to its two accounts); 3 skipped (cross-file bearer helper, refactoring older
  hooks, `clearRateLimitKeys` swap).
- Code review: not run, per `agents/backend/CLAUDE.md`.

**Notes for review.**
- AC5: the real middleware runs on `/verify` through the session-JWT path only, which is what the
  SPA sends. Signed requests through the real middleware are covered on the sibling
  `PATCH /api/accreditation/metadata` (`accreditation-metadata-edit.test.ts`), named in the new
  banner.
- The concurrent cap spec now sends `cap + 1` requests from one account, so it fits the 5/min
  bucket only while the cap is at most 4 (default 3).
- Residual, by design: an unauthenticated or forged `/verify` request now reaches
  `verifyHiveSignature` with no limiter in front, the same posture as `/request` and every
  `byAccount` route.
- Overlaps: item 17 of `backend-accreditation-wot-comment-and-dead-code-pass` (the
  `accreditation.test.ts` file header) is untouched, since the `/verify` bypass statement is a
  describe-level banner. `backend-verify-cap-keeps-a-refused-claim` scope 2 narrows the same
  soft-block comments; this commit only deleted the sentences the session gate makes false.
  `backend-mailbox-binding-registry` places its claim "after the session gate", which now exists.

**Out of scope, for filing.**
- `backend/tests/routes/accreditation.test.ts` header "INTENTIONAL RED" paragraph and the
  matching inline comments: both specs it names pass, so the paragraph is stale.
- `backend/src/routes/accreditation.ts`: the gate-hit and idempotency-hit branch comments say the
  grace replay returns "the identical 200 envelope", but the replay omits the original
  `outcome` field.
- `backend/tests/routes/accreditation-idempotency.test.ts`: the comment above `fakePipeline` says
  a `ChainableCommander` stub makes pipeline growth force the stub to grow. The route's
  `try` absorbs a missing step with either stub (the same claim was deleted from the solutions
  entry in `ef1cbdbd`).
- `agents/docs/solutions/conventions/validator-limiter-ordering-depends-on-key-class-2026-05-21.md`
  and the `papers.ts` retract-route comment call `retractLimiter` URL-keyed, but it is
  `keyFn: byAccount`. The skip-failed entry's ordering paragraph restates that rule; left as it
  was for that entry's own refresh.
- The verify page has no 429 branch and offers "Request New" while the link is still valid
  (ui, from the SPA contract check).

## [TODO Architect] at archive (additions)

- `api-contracts/accreditation.md` `/verify`: besides the auth headers, 401 and
  `ACCREDITATION_ACCOUNT_MISMATCH` (403, exact message above), the grace-period paragraph now
  holds for the record's account only (others get `BAD_REQUEST`), and `RATE_LIMITED` is per
  account.
- `ARCHITECTURE.md` § 2 "Credential Bindings" rollout: the sentence that the `/verify`
  enforcement point lands after `/verify` requires the requester's session is now met.
- `ARCHITECTURE.md` § 6.4 has no `/verify` row. Its proof is the account's session or a request
  signature plus the mailed single-use token bound to that account (the reset row's shape).

**Learnings checkpoint.** `/ce-compound-refresh` scoped to three entries, committed in `ef1cbdbd`:
`skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` (verify-limiter row
now account / JWT-required; `recoverLimiter` snippet path), `post-broadcast-grace-period-record-must-follow-permanent-rethrow-cleanup-2026-05-19.md`
(cached 200 to the same account; sibling-branch section; dead task paths and round labels; wrong
helper-extraction path), `redis-multi-rejection-retry-precondition-isredisavailable-2026-05-19.md`
(example calls; the false stub-growth paragraph; a memory-slug link). `CONCEPTS.md` scanned, no
qualifying terms. No new entry: the non-obvious points (mismatch before the admin-key branch,
one account for the refund spec) are carried by the specs' own comments.

## Guard a whole publish or edit submit against a subject teardown between its legs (archived 2026-10-06) — one round, clean review; three follow-ups filed; one solutions entry refreshed

### Architect archive note (2026-10-06)

- **Review:** `/ce-code-review` full path on `4781efac` (branch-remote, read from a `git archive` snapshot because HEAD had moved to unrelated recover/accreditation commits), seven reviewers: correctness, project-standards, testing, security, adversarial (in-process), julik-frontend-races, learnings. No finding survived synthesis and the validator batch was empty; triage: user, "as recommended". Re-measured at `4781efac`: full frontend unit suite 96 files / 2262 tests, exit 0; build exit 0; red at base, 8 teardown cases fail and 3 controls pass; all 11 claimed mutants killed (9 by the testing reviewer, the two guard-after-entry-gate mutants by the architect). The three user-approved Scope departures hold against the code.
- **Follow-ups filed** in `acbc16ff`: `ui-confirm-dialog-answered-after-subject-teardown` (normal; signal follow-up 1 plus review residual R1, a decline after a teardown unwinds with no message; the signal's reason for not checking after the publish confirmation does not hold, since a `sha256File` stub that awaits a macrotask pins the post-hash check on its own), `ui-keychain-broadcast-subject-teardown` (low; follow-up 3), `ui-teardown-message-and-mapper-mock-wording` (low; follow-ups 2 and 4).
- **Dismissed:** no case for a sign-out-only teardown (the code stops it per probe; preemptive); an upload that fails for an unrelated reason after a teardown shows "Upload failed" instead of the teardown message (rare, no credential spent); the publish suite header's reason for stubbing `sha256File` (a fixture choice, not false).
- **Learnings checkpoint:** `de4deb57` refreshed `guard-report-dedupes-per-event-not-per-holder-2026-09-02.md` (its snippets predated `reportTeardownOnce()` and `tearDownSessionWithMessage`). The other six matched entries are honored by the diff and not contradicted. No new entry: the placement rule is the `subjectTeardownGuard` docblock's own, and the CONCEPTS.md Subject Teardown entry already states the narrate-once rule.

**Owner:** ui
**Created:** 2026-09-02
**Priority:** normal

Routed out of the architect round-2 review of `ui-consent-op-teardown-guard`
(`01347275` + `646c23bb`). Not held there: the round-1 hold marked a batch-level guard
optional, and the gap sits outside that commit's lines. Four reviewers converged on it
independently this round (security, correctness, adversarial, and the frontend-races
lens), which is why it is filed rather than left as a recorded residual.

## Why

`uploadFile` now opens its own teardown guard at entry and threads it through the
pre-flight and both retry legs, so a subject teardown landing anywhere inside ONE call
is caught. A submit is many calls: the publish page uploads the PDF, then each
supplementary file, then broadcasts; the edit page does the same around its
supplementary loop. Each call opens a fresh guard, and a guard opened after a teardown
snapshots the already-bumped generation, so it compares that value against itself and
never fires.

A cross-tab login landing between two legs is therefore invisible to every guard in the
batch. The next leg acquires a window for whoever the tab now represents: the new
subject is prompted with the generic re-auth message, their credential mints an upload
token, and the departed subject's remaining files pin under their account. The submit
