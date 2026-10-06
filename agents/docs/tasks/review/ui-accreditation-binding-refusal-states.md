# The verify, signup and request surfaces explain a mailbox that already backs another account

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
