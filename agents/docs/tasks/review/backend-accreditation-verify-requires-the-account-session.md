# /verify accredits the requester's account for whoever opens the link

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
