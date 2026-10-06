## The verify, signup and request surfaces explain a mailbox that already backs another account (archived 2026-10-06) — one round; two in-place fixes; release link and refusal exits folded into the release-flow task; two decisions open with the user

### Architect archive note (2026-10-06)

- **Review:** `/ce-code-review` full path on `64bca0fb`, `141840d7`, `8a169708` (synthetic base excluding the unrelated `faffe9f9`), seven reviewers plus the validator. Implementer claims re-measured at `8a169708`: full frontend suite 94 files / 2251 tests, exit 0; 11 of 12 mutants killed, the survivor (handler order) equivalent because the two finalize handlers match disjoint codes; 13 keys in all 16 locales, 195 STUBS.md lines, no emdash.
- **#1 (P1, validator confirmed), OPEN with the user:** `hasUnliftedSanction` fails closed (no HAF pool or a query error answers true), so a HAF failure at finalize answers 403 `ACCREDITATION_SANCTIONED` after the finalize UPDATE; the new `unaccredited` phase shows "not eligible" with no retry, where the old generic path reached the 1-hour stuck-resume branch on re-submit. The ui routing stays (right for a real sanction). Proposed: new backend task `backend-failed-sanction-read-is-not-a-sanction` (high): HTTP routes answer a retriable 503 on a failed read (signup finalize, `/api/accreditation/verify`, ORCID callback, metadata edit), the wot job keeps failing closed, and the accepted-tradeoff comment in `accreditation-metadata.ts` goes. Not filed until the user says yes.
- **#2 (P3):** the `_isNetworkError` docblock and its spec comment said DOMExceptions carry no `.code`; fixed in place in `d3b7e34d`.
- **Implementer follow-ups:** contract "AbortError-after-success" narrowed in `a3d138f7`. The deferred release link (Scope 1) and the missing "not yours" exits in `verify.mailboxBoundMessage(Unnamed)` and `seedPhrase.unaccreditedOrcidLinked` folded into `ui-accreditation-release-flow` (scope item 4, AC5). Finalize sanction fail-closed is #1.
- **OPEN with the user (design):** signup plus login reveals a bound address. Under § 2 a bound address's signup creates no row, so a login with it answers 401, against 409 `PENDING_UNVERIFIED` for an unbound address's pending row. Proposed: amend § 2 and `backend-signup-finalize-claims-mailbox-binding` before it starts so the signup creates the same pending row in both cases and only the mail differs. Not applied until the user says yes.
- **No change:** `common.mailboxPurpose` describes the keyed hash and the one-account rule before `backend-mailbox-binding-registry` implements them; that task makes it true.
- **Dismissed:** timeout copy "Network connection lost" (the retry route is the fix; before this diff a timeout fell to the generic failure); `/link` refusal for an already-accredited Hive account (theoretical); finalize `bound_to` shown to a former mailbox holder (matches the design's notice mail); template-substring tests (11 of 12 mutants killed, AC5 E2E is the planned cover); the verify page's `console.warn` before its semantic branches (predates the diff).
- **Learnings checkpoint:** solutions/ grepped for `hasUnliftedSanction`, `DOMException`, `.code` claims and the 30s timeout name; no entry is contradicted (`reviewer-discovery-error-class-stack` already names `TimeoutError`). No new entry: #1 is the consumer-side shape `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel` already describes, and the DOMException code fact is in `d3b7e34d`'s message.

**Owner:** ui
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings". Backend counterpart:
`backend-mailbox-binding-registry`, `backend-signup-finalize-claims-mailbox-binding`.

## Why

`frontend/src/pages/accreditation-verify.js` renders every non-retriable error as "Verification
Failed" with a "Request New Accreditation" button, has no branch for the existing 403
`ACCREDITATION_SANCTIONED`, and reads only `res.data.username` on success. A refusal because the
mailbox backs another account would show as a generic failure that invites another attempt. The
request form says nothing about what the address is used for, and the binding's legal basis needs
the purpose stated before the address is submitted.

## Scope

1. **Verify page:** a state for 409 `MAILBOX_ALREADY_BOUND`: the mailbox already backs
   `details.bound_to`; the way through is to sign in to that account and release its
   accreditation (link to the release surface once `ui-accreditation-release-flow` lands;
   until then "or contact PEvO"). No "Request New Accreditation" button in this state. While in
   this file: a state for 403 `ACCREDITATION_SANCTIONED` without that button either, and treat
   `AbortSignal.timeout`'s `TimeoutError` as retriable like the other network errors, since the
   backend keeps the token on a timeout.
2. **Signup finalize:** when `/confirm` or `/link` answers 409 `MAILBOX_ALREADY_BOUND` (no
   session), the signup-verify page says the account was created but not accredited because the
   mailbox already backs another account, with the same way through and a sign-in link; it must
   not suggest signing up again.
3. **Request form (`frontend/src/pages/accreditation.js`) and the signup form:** one sentence under
   the e-mail field naming the legitimate interest and the right to object: the address is used to
   verify an institutional affiliation and, to prevent abuse, to keep one accredited account per
   mailbox; a keyed hash of it is stored for that purpose and the holder can object; link to the
   privacy notice route. Nothing in the UI reveals whether an address is bound: the request answer
   is uniform by design and the explanation arrives by mail.
4. New strings in `en.json`, stubbed in all 15 other locales and recorded in `STUBS.md` per the
   convention; no emdash in UI copy.

## Out of scope

- The release action itself and the admin console (`ui-accreditation-release-flow`).
- The settings e-mail flows (they never bind).

## Acceptance criteria

1. A 409 `MAILBOX_ALREADY_BOUND` on `/verify` renders the bound-account state naming
   `details.bound_to`, with no re-request button; the sanction code renders its own state.
2. A `TimeoutError` from the verify POST lands in the retry state.
3. The finalize refusal renders the created-but-unaccredited explanation.
4. The request and signup forms carry the purpose sentence and the privacy link.
5. Unit tests for the new branches; E2E for the verify state against the real backend once the
   backend task is in.

## UI implementation signal (2026-10-06, commits 64bca0fb, 141840d7, 8a169708)

Landed on main, each verified with `git merge-base --is-ancestor <sha> main`:

- `64bca0fb`: the change: both verify pages, the two form sentences, 13 keys in all sixteen
  locales, the STUBS.md sweep `### Added 2026-10-06 (ui-accreditation-binding-refusal-states)`,
  and the unit specs.
- `141840d7`: fixes from the adversarial verification (below): copy narrowed to what holds, the
  second way through, per-state copy and href pins in the specs.
- `8a169708`: `/ce-simplify-code` pass: test tables and two comments the change made false.
- Also: `db703b76` files `ui-request-and-signup-copy-promises-a-link-a-bound-address-never-gets`;
  `aa2da86e` is the learnings refresh (below).

**Decisions taken with the user before submitting:**

1. **Privacy link.** No privacy notice route exists (the privacy task is on hold), so "You can
   object to this." links to `/contact`. Swap in the notice once it ships.
2. **Finalize refusals.** The signup-verify `unaccredited` phase covers 409 `MAILBOX_ALREADY_BOUND`
   and the two finalize refusals that already exist, 409 `ORCID_ALREADY_LINKED` and 403
   `ACCREDITATION_SANCTIONED`. Before this they showed "creation failed" and sent the user back
   to the username step of an account that was already finalized.
3. **Second way through.** The finalize mailbox copy also names the design's route for a holder
   who is someone else: "If {account} is not yours, sign in to this account and request
   accreditation with another institutional address or your ORCID iD."
4. **Link-promising copy.** `accreditation.emailHint`, `accreditation.checkEmail` and
   `signup.checkEmailDescription` promise a verification link that a bound address never gets.
   Filed as a separate ui task (`db703b76`) instead of re-stubbing translated keys here.

**Scope 1 / AC1, AC2.** `accreditation-verify.js`: `MAILBOX_ALREADY_BOUND` sets `boundTo` from
`details.bound_to` (empty when absent) and shows `mailbox_bound`, which names `@<bound_to>` or
uses the unnamed copy. `ACCREDITATION_SANCTIONED` shows `sanctioned`. Neither state has "Request
New"; both link to `/contact`. `_isNetworkError` matches `TimeoutError` (what `AbortSignal.timeout`
in `api.js` rejects with) and it takes the 5s cooldown; the false "AbortError = fetch timed out"
comments in the page and its spec are narrowed.

**Scope 2 / AC3.** `signup-verify.js`: `_handleFinalizeRefusal` runs after
`_handleAmbiguousBroadcastOutcome` on `/confirm` and `/link` and moves to `unaccredited`: title
"Account set up, but not accredited" ("created" was untrue on `/link`), the reason per code, sign-in
(`/login`) and contact links, no session, no `/signup` link. `_clearUsernameTimer` replaces three
inline copies. `details.bound_to` is unspecified for finalize, so the name shows only when present.

**Scope 3 / AC4.** Under the e-mail field of `accreditation.js` and `signup.js`: the purpose,
the legitimate interest, the keyed hash, and the objection link (decision 1). Hidden on the
signup ORCID branch (`x-show="!orcidToken"`), which binds no address. Nothing reveals a binding.

**Scope 4.** Keys `verify.{mailboxBoundTitle,mailboxBoundMessage,mailboxBoundMessageUnnamed,
sanctionedTitle,sanctionedMessage}`, `seedPhrase.{unaccreditedTitle,unaccreditedMailboxBound,
unaccreditedMailboxBoundUnnamed,unaccreditedOrcidLinked,unaccreditedSanctioned,unaccreditedSignIn}`,
`common.{mailboxPurpose,mailboxPurposeObject}`: 195 STUBS.md lines, one heading. The rewording in
`141840d7` stayed in place under that heading (every locale still held the English stub). No emdash.

**AC5.** Unit specs for every branch. E2E deferred: no backend code sends `MAILBOX_ALREADY_BOUND`
yet; add it with the backend task.

**Verification.**
- Unit: full frontend suite, `npx vitest run` exit 0, 94 files, 2251 tests, after each commit.
- Adversarial workflow on `64bca0fb` (19 agents: mutation, real-Alpine render, contract, copy
  lenses, a skeptic per finding): 15 findings, 12 confirmed (all low after the skeptics), 3 refuted.
  The in-scope ones are fixed in `141840d7`. The five mutants that had survived (title swap,
  message swap, form href, signup-verify href, ORCID-branch `x-show`) are killed afterwards.
- Real Chromium (vite dev + repo Playwright): both refusal states, the `unaccredited` phase and
  both forms at 1280 and 390 px and in Arabic; copy and links correct, no console errors.
- `/ce-code-review` not run: architect-owned per `agents/ui/CLAUDE.md`.

**Learnings checkpoint.** `/ce-compound-refresh` on `reviewer-discovery-error-class-stack` and
`post-broadcast-grace-period-record-must-follow-permanent-rethrow-cleanup` (`aa2da86e`): both named
the 30s timeout `AbortError`. No new entry: the `TimeoutError` fact now lives in those entries and
in the page's comments.

**Out of scope, for follow-up filing.**
- **Backend, finalize sanction read fails closed to 403.** `hasUnliftedSanction` returns true with
  no HAF pool or on a query error, and `broadcastAccreditationAndSeed` runs it after the finalize
  UPDATE with no HAF gate before it. A HAF outage at signup finalize therefore answers 403
  `ACCREDITATION_SANCTIONED`, which this page now shows as "not eligible for accreditation" (it
  used to show "creation failed"). Suggest answering a retriable 503 when the read fails.
- **Backend design, login reveals a bound address.** `backend-signup-finalize-claims-mailbox-binding`
  scope 1 creates no row for a bound address. A login with that address and the chosen password
  then answers 401, against 409 `PENDING_UNVERIFIED` for an unbound one, so signup plus login
  reveals the binding. Needs a decision before that task starts.
- **Architect zone.** `api-contracts/accreditation.md` (24h grace-period paragraph) says
  "AbortError-after-success"; the client timeout is a `TimeoutError`.
- **Release link.** When `ui-accreditation-release-flow` lands, link its surface from the verify
  `mailbox_bound` state and the finalize mailbox copy (this task's scope item 1).

## The two accreditation limiters refund requests that already did their work (archived 2026-10-06) — two rounds; three hold fixes landed; one pre-existing test-header finding folded into the comment pass; two solutions entries refreshed

### Architect archive note (2026-10-06, round 2)

- **Re-review:** `/ce-code-review` on `1783194b^..1783194b`, focused path (own correctness, standards and requirements pass plus one in-process adversarial reviewer; no validator). All three held items are fixed as prescribed. The adversarial reviewer ran `tests/eslint/` on a git-archive copy of `1783194b`: 9 files, 146 tests, exit 0; a pin-back-to-2 mutant turned the "exactly its pin" spec red. The `accreditationRequestLimiter` comment is true on every branch of the `/request` handler and against `shouldRefund`.
- **#1 (P3, pre-existing, folded into `backend-accreditation-wot-comment-and-dead-code-pass` as item 17):** the `accreditation.test.ts` "Mocking justification" header says the carve-out covers only broadcast error staging, while the file also mocks `verifyHiveSignature` and `findExistingAccreditation`; no clause-(b) bypass statement covers the first `/request` describe block.
- **Noted, no action:** the `accreditation.ts` "Token store: app database" heading is already item 15 of the same comment-pass task.
- **[TODO Architect] rows:** both `/ce-compound-refresh` runs done in `98b65f12`. `skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md`: both accreditation grid rows now show the `refundStatusCodes` omission, and the triage line no longer calls accreditation-request a non-controversial adoption. `deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md`: a fourth applicability condition limits the abort refund to handlers meant to refund one.
- **Learnings checkpoint:** solutions/ grepped for both limiter names, `accred-req`, `accred-verify` and accreditation refund claims; only the two refreshed entries made a current-state claim. No new entry: the abort-refund lesson now lives in the refreshed deferred-refund entry, and the pin miss is covered by the canary's own failure text.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (findings 2 and 8). The validator confirmed
both from the code. Incidence was not measured.

## Why

Both accreditation limiters in `backend/src/routes/accreditation.ts` set
`skipFailedRequests: true`. `shouldRefund` in `backend/src/middleware/rateLimit.ts` then gives the
slot back for every response that is not a finished success: any status of 400 or above, and a
connection that closed before the response ended.

1. `accreditationRequestLimiter` (`/request`, 3 per 24 h per account). A client that closes the
   connection before the response ends gets its slot back, while the handler keeps running: it
   stores the token and sends the mail. `/api/accreditation` is mounted without another limiter
   (`backend/src/app.ts`). So one signed-in account can send verification mails without limit, to
   any institutional address, each carrying the `full_name` text it chose. Whether this
   deployment's reverse proxy passes a client abort on to the backend socket was not checked.
2. `accreditationVerifyLimiter` (`/verify`, 5 per minute per IP). The 403
   `ACCREDITATION_SANCTIONED` answer comes after two HAF reads (`findExistingAccreditation`,
   `hasUnliftedSanction`), and the 502 `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` answer after the
   per-token lookup as well. Both leave the token alive and both are refunded, so a caller holding
   such a token is not throttled. The limiter's comment says `BAD_REQUEST` is the only
   client-error path and that it returns before the HAF probes. A closed connection is refunded
   here as well, and the handler still runs on to the broadcast.

`refundStatusCodes` on the same limiter refunds only the listed statuses. A request that closes
before any status is set keeps the default 200 and is not refunded.

## Scope

1. `/request`: replace `skipFailedRequests` with `refundStatusCodes: [422, 500]`.
   - 422 is the non-institutional-address refusal, returned before the token is stored.
   - 500 is the answer of the two SMTP branches (send failed, SMTP host not configured), each
     after a best-effort delete of the token.
   - An aborted request consumes its slot.
2. `/verify`: replace `skipFailedRequests` with `refundStatusCodes: [503, 504]`.
   - The two 503 answers (`ACCREDITATION_GATE_UNAVAILABLE`, and `SERVICE_UNAVAILABLE` from the
     counter claim) return before any broadcast.
   - 504 is the broadcast timeout, after which the route keeps the token for a retry.
   - 400, 403, 500 and 502 consume a slot.
3. Cut both limiter comments down to the new refund sets. Delete in particular the `/verify`
   sentence that begins "The 4xx refund is acceptable here because `BAD_REQUEST` is the only
   client-error path", and the `/request` claim that a 400 validation refunds the slot:
   `validate` runs ahead of the limiter in the middleware chain, so a 400 never reaches it.

## Out of scope

- `rateLimit.ts` itself, and other routes that use `skipFailedRequests`.
- Requiring a session on `/verify` (`backend-accreditation-verify-requires-the-account-session`).

## Acceptance criteria

1. A `/request` whose client aborts before the response has consumed a slot: after three such
   requests in the window, the next answers 429.
2. A `/request` that answers 422 or 500 leaves the slot free.
3. On `/verify`, a 400, the sanctioned 403 and the cap 502 each consume a slot; a 503 and a 504
   leave it free.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- `/ce-compound-refresh` on `skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md`:
  its audit grid lists both limiters as correct adoptions.
- `/ce-compound-refresh` on `deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md`:
  it treats a client abort as an outcome to refund, which on `/request` was the abuse hole.

## Backend implementation signal (2026-10-06, commit f748b67c)

Landed in `f748b67c` (`git merge-base --is-ancestor f748b67c main` checked).

**Scope**
1. `/request`: `accreditationRequestLimiter` uses `refundStatusCodes: [422, 500]`.
2. `/verify`: `accreditationVerifyLimiter` uses `refundStatusCodes: [503, 504]`.
3. Both limiter comments are cut down to the new refund sets. The `/verify` "The 4xx refund is acceptable here because `BAD_REQUEST` is the only client-error path" sentence and the `/request` claim that a 400 validation refunds are deleted. The two route-site comments (`POST /api/accreditation/request`, `POST /api/accreditation/verify`) also lost their pointer to the `skipFailedRequests` layered-pattern obligation. That obligation applies to limiters that set `skipFailedRequests`, and these two no longer do.

**Acceptance criteria → specs**
- AC1: `accreditation.test.ts` "a client that disconnects while the mail is being sent consumes its slot; after three such requests the next answers 429". A real `http.request` is destroyed while `sendMail` is pending, so the token is stored and the mail is in flight.
- AC2: the existing "three SMTP-failure 500s ..." and "three 422 non-institutional-email responses ..." specs, now in the describe `accred-req limiter: 422 and 500 refund the slot, a client abort consumes it`.
- AC3, consume: `accreditation.test.ts` "a 400 invalid-token answer consumes a slot ..." and "the cap 502 BROADCAST_ATTEMPT_LIMIT_EXCEEDED consumes a slot", plus `accreditation-verify-sanctioned.test.ts` "the 403 consumes a /verify limiter slot".
- AC3, refund: "a 504 BROADCAST_TIMEOUT refunds its slot" in `accreditation.test.ts`. The 503 refund is pinned by the existing `accreditation-idempotency.test.ts` spec "503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot". A duplicate 503 spec in `accreditation.test.ts` was dropped at the simplify pass, because that file's header hands gate-throw coverage to the idempotency file.
- AC4: comments checked against root `CLAUDE.md` "Comment anchors". The pre-commit anchor gate passed.

**Verification**
- Red before the fix. Against the unchanged limiters, the four consume specs failed for the expected reason:
  - abort: 200, expected 429
  - 400: 400, expected 429
