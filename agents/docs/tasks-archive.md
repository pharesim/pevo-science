## Audit the accreditation and Web of Trust code (archived 2026-10-05) — 27 findings triaged: 14 tasks filed, the accreditation contract fixed in place, 2 dismissed

### Architect archive note (2026-10-05)

First audit task run. Nine reviewers on a synthetic whole-file diff of `9d4325fc`; the validator
confirmed findings 1 to 8; finding 27 was measured on the HAF node (gate lookup 19.75 s on a
no-match account, 2.4 ms fenced). Five high-priority defects in the trust layer went to backend
and ui tasks, the mailbox-binding question went to an architect design task, and two tasks sit in
`blocked/` behind the task they are sequenced after. The per-finding dispositions, the dismissals
and the deferred `solutions/` refreshes are in the "Dispositions" section of the task below. No
`/ce-compound`.

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

The trust layer (root `CLAUDE.md` principle 3): the accreditation routes and service, email validation, and the Web of Trust.

## Scope (line counts at filing)

- `backend/src/routes/accreditation.ts` (1331)
- `backend/src/accreditation.ts` (470)
- `backend/src/routes/accreditations.ts` (188)
- `backend/src/email-validator.ts` (123)
- `backend/src/wot.ts` (343)
- `backend/src/routes/wot.ts` (267)

Total: 2722 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.

## Dispositions (2026-10-05)

Audited at `9d4325fc` with `/ce-code-review` on a synthetic whole-file diff, all reviewers on
Fable 5.1 at the user's request: correctness, security, in-process adversarial,
project-standards, reliability, performance, api-contract, maintainability, learnings. 65 raw
findings merged into 26 (5 P1, 4 P2, 17 P3). The validator confirmed findings 1 to 8 from the
code; 9 to 26 were not in its batch. Reviewers ran no tests and no database, Redis or network
access, so no finding has measured incidence. Finding 27 came from an `EXPLAIN ANALYZE` the architect
ran on the HAF node with the user's permission. Triage: user, "as recommended", with decisions on
findings 1, 3, 4 and 27.

| Finding | What | Disposition |
|---|---|---|
| 1 | `/verify` confirms a WoT enrollee below the threshold and broadcasts nothing | `backend-verify-gate-treats-wot-enrollee-as-accredited` (high). Decision: an email verification pins any WoT enrollee |
| 2, 8 | Both limiters refund requests that already did their work | `backend-accreditation-limiters-refund-work-already-done` (high) |
| 3 | One mailbox can accredit any number of accounts | `architect-accreditation-mailbox-binding-design` (high). Decision: design task, not accepted for beta |
| 4 | The verify link accredits the requester's account for whoever opens it | Decision: `/verify` requires the account's session. `backend-accreditation-mail-names-the-account` (high), `ui-accreditation-verify-page-signs-in-first` (high), then `backend-accreditation-verify-requires-the-account-session` (high, in `blocked/` behind the ui task) |
| 5, 20 | WoT auto-accredit reads a stale membership cache; unused pool fetch | `backend-wot-auto-accredit-reads-stale-membership` (high), which also validates `vouchee` as an account name (from the residual list) |
| 6, 25 | The cap keeps a refused claim; comments say otherwise | `backend-verify-cap-keeps-a-refused-claim` (low) |
| 7 | `/request` stores an ORCID and a `created_at` nothing reads | `backend-accreditation-request-stores-unread-fields` (low), `ui-accreditation-email-form-orcid-input` (low) |
| 9 | WoT enrollment has one trigger | `backend-wot-enrollment-has-a-single-trigger` (normal, in `blocked/` behind the stale-membership task) |
| 10, 15, 18 | Contract doc: emdashes, an error code `/verify` cannot emit, a null the route returns | Fixed in place in `api-contracts/accreditation.md`. `architect-api-contracts-emdash-sweep` (low) covers the other contract docs |
| 11, 12, 13, 14, 16, 17, 19, 21, 22, 23 | False or stale comments, one unused export | `backend-accreditation-wot-comment-and-dead-code-pass` (deferred until the other backend tasks from this audit are archived) |
| 24 | The per-token idempotency branch is shadowed by the account gate | Dismissed: harmless redundancy on a chain-write path |
| 26 | `VouchStatus.accreditation_method` has no reader | Dismissed: a documented response field |
| 27 | Three latest-op HAF lookups walk the blocks index on a no-match input (gate lookup measured at 19.75 s, 2.4 ms when fenced) | `backend-latest-op-haf-lookups-walk-the-blocks-index` (high) |

Also changed in `api-contracts/accreditation.md` while fixing 10, 15 and 18: "WoT-revoke" became
"revoke" in the grace-period paragraph (finding 16's contract part); the
`BROADCAST_ATTEMPT_LIMIT_EXCEEDED` entry lost its "after which the user can retry the same token"
clause (finding 6); the `BROADCAST_TIMEOUT` entry now says a retry normally answers
`already_accredited`, because the account gate runs ahead of the per-token lookup (finding 24).

Dismissed from the residual list: the seconds-wide window between a sanction landing and HAF
indexing it; the abused-domain exclusion and the TLD-suffix arm of `isInstitutionalEmail` (not
measurable without the generated data file's source lists); the WoT threshold default cached
after a failed read; a seed throw after a landed WoT op reported as `chain_error`; the listing
total of 0 past the last page; `req.body` undefined on a non-JSON `/vouch`.

Carried into other pending audits as notes: `architect-audit-frontend-security-surface`,
`architect-audit-broadcast-idempotency-ipfs`, `architect-audit-hafsql-and-chain-walkers`,
`architect-audit-reputation`.

Not plan-checked: the sibling reads with the same `ORDER BY block_num DESC LIMIT 1` shape, listed
in the latest-op task's "Out of scope".

Learnings: no `/ce-compound`. Three `solutions/` entries are stale. Two describe code that tasks
from this audit change, so their refresh is a `[TODO Architect]` on those tasks
(`accreditation-state-read-latest-action-wins` on the gate task, the `skipFailedRequests`
carve-out on the limiter task). The third, a note in
`hive-primitive-aware-design-rules-for-pevo-custom-json-ops` that `getAccreditedSet` and the list
endpoint inline `accred_ranked`, waits for the next `/ce-compound-refresh` pass.

## Password reset gates on no account state (archived 2026-10-05) — clean first review; reset rotates an existing password and never adds one; three follow-ups filed, the test gaps dismissed

### Architect archive note (2026-10-05)

Review of 8bf9283a, bd5d7e28 and 1dd8776a with /ce-code-review (full: correctness, security,
in-process adversarial, testing, project-standards, learnings; the validator batch was empty).
Clean: no findings. Scope items 1 to 4 and AC 1 to 3 are met. The testing reviewer ran the new
suite in a git-archive copy of 1dd8776a: 17 passed, 0 skipped. Five planted mutants (reset-request
gate dropped, UPDATE gate dropped, rowCount refusal deleted, refusal message changed, sentinel
burn skipped) were all killed.

Triage (user: "as recommended"):
- Filed `backend-reset-tokens-outlive-email-changes-and-recovery` (high). It covers the signal's
  "tokens survive email changes" item, the review's residual risk that a refused token works
  again once set-password re-adds a password, the review's residual risk that a legacy
  unverified G row with a password still gets a reset link, and the backend half of the
  `RESET_REQUEST_OK_MESSAGE` overclaim.
- Filed `ui-reset-request-copy-promises-a-link` (low): the UI half of the overclaim.
- Filed `backend-orcid-path-f-resume` (normal): the ORCID-proven resume path the user approved.
- Dismissed: the refused-reset specs do not pin "no audit row, token untouched" (preemptive test
  hardening). No spec covers an expired token on a passwordless row; that case also shows the
  signal's claim that only a concurrent password drop separates a lookup-placed gate from an
  UPDATE-placed one is wrong. No code comment carries the claim. The signal's SELECT-only
  mutant note is dismissed with it.
- The doc updates stay with `architect-password-reset-gate-docs`, which now notes the follow-up.
- Compound: no.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced by the backend while working on the custody-column alignment (since
archived): it was the mechanism behind a rejected stuck-recovery predicate.
Approved for filing at that task's archive. This is an account-state defense
divergence between the documented state machine and the code.

## Why

ARCHITECTURE.md § 6.3 ("Forgot password") documents reset as
`A → A` and `B → B` only, and says "C cannot use /reset". § 6.4 lists reset's
per-state availability as "A and B (states with email AND password)".

The code gates on neither. `POST /api/auth/reset-request` selects the row by
email alone (`SELECT id, username FROM accounts WHERE email = $1`), and
`POST /api/auth/reset` selects by reset token alone and writes the new
`password_hash` unconditionally. So any row carrying an email can be reset,
whatever its state. What that reaches, as far as can be read from the code
(measure it, do not take this list as given):

- A state C row that carries an email gains a password: C → B through an edge
  § 6.3 says does not exist.
- A D or G row with no password gains one; a D or G row with a password has
  it rotated.
- A pre-finalize E or F row has its password rotated, or set on an F row from
  the ORCID path, and gets a `sessions_invalidated_at` stamp.

Reset is also the one route a confused user reaches for while locked out, so
whatever rule lands must not strand a legitimate recovery. In particular, a
user part-way through signup who forgot their password resumes through
`POST /api/auth/resume-signup`, which authenticates by email and password, so
resetting the password on an E or F email-path row is plausibly a flow that
has to keep working.

## Scope

1. Measure first. For every state in § 6.1 (A, B, C, D, G, E, F, and F on the
   ORCID path), drive `reset-request` and `reset` against real Postgres and
   record what each does to the row today. Use route tests, not reasoning.
2. Default rule to implement unless step 1 shows it strands a legitimate flow:
   **reset rotates an existing password and never adds one.** Refuse a row
   whose `password_hash` is NULL, at both ends. `reset-request` keeps its
   uniform response and simply issues no token. `reset` refuses with its
   existing invalid-token shape, so a token issued before the gate landed
   cannot add a password either. This refuses C, a D or G row with no
   password, and the ORCID-path F row, and it keeps A, B, E, the email-path F
   row, and a D or G row that already has a password.
3. If step 1 finds a legitimate flow the default rule would strand, do not
   ship a different rule on your own judgment. Move this file to `blocked/`
   with a `[BLOCKED by Architect]` note giving the per-state measurement and
   your proposed rule. Section 6.3 moves before the code does.
4. Do not touch the stuck-recovery lookups in `routes/signup-verify.ts`. They
   deliberately read no revocation state; § 6.3's Option C note explains why.

## Acceptance criteria

1. A route test per state pins what reset does to it, both the accepted and
   the refused states, against real Postgres.
2. No response distinguishes a refused row from an unknown email:
   `reset-request` returns the same status, body, and timing class either way.
3. The completion signal lists the per-state outcome table, so the architect
   can bring § 6.3's "Forgot password" block and § 6.4's reset row up to date
   at review. Do not edit those sections yourself.

## Architect note (2026-10-05): the set-password comment depends on this rule

`routes/settings.ts`, `POST /set-password`: "Only ORCID-verified accounts can opt into password
login" is false today, because `reset-request` and `reset` let any row with an email gain a
password, a state G row with no ORCID included. The default rule in Scope item 2 (reset never
adds a password) makes that sentence true, and so does the `ORCID_REQUIRED` comment in
`tests/routes/settings-set-password.test.ts` that restates it. If step 1 sends this task to
`blocked/` and a different rule lands, rescope both comments to that rule in the same pass:
either limit them to this route, or name the reset path that also adds a password.

## Architect note (2026-10-05), carried from the state G review

Since d33792ce, `POST /api/auth/login` logs in a state G row whose email is still unverified,
given its password: the pending block is scoped to `username IS NULL`. So a password that
reset adds to such a row is a working login. In step 1, measure the unverified G row, with and
without a password, as a state of its own next to the verified G row.

## Backend implementation signal (2026-10-05, commits 8bf9283a, bd5d7e28, 1dd8776a)

All three are on `main` (`git merge-base --is-ancestor` checked). `8bf9283a` is the gate and the
new suite; `bd5d7e28` narrows comments the gate made false (found by the verification pass
below); `1dd8776a` is the simplify pass. The default rule from Scope item 2 shipped. Step 1
found one flow it closes (ORCID-path F, below); the user decided to ship the default rule and
flag a follow-up rather than block (asked before the move, 2026-10-05).

**Change.**
- `routes/auth.ts`, `POST /reset-request`: the lookup is `WHERE email = $1 AND password_hash IS
  NOT NULL`. A passwordless row takes the unknown-email branch itself: same status and body, the
  same `burnSentinel` call, no token written.
- `routes/auth.ts`, `POST /reset`: the token lookup and the expiry check are unchanged. The
  UPDATE carries `AND password_hash IS NOT NULL`, and a write that matches no row answers 400
  `INVALID_TOKEN` with `RESET_TOKEN_INVALID_MESSAGE`, the same constant the unknown-token branch
  now uses. A refused reset stamps no `sessions_invalidated_at`, writes no audit row and sweeps
  no session-proof window. ORCID recovery without a new password (`routes/recover.ts`) writes
  `password_hash = NULL` and never touches `reset_token`, so such a leftover token is refused
  too. An EXPIRED token on a passwordless row still takes the expiry branch first ("Reset token
  has expired", token cleared, no password written).
- `routes/signup-verify.ts`: the `/link` stuck-recovery rationale said reset "gates on nothing
  about account state"; now "gates on no account state but the password". The lookup SQL is
  byte-identical (Scope item 4). The same stale claim in `tests/routes/signup-verify-stuck-recovery.test.ts`
  ((g) header, (g) and (h) specs) and the "any account row" claims in
  `tests/routes/auth-log-shape.test.ts` are narrowed.
- New suite `tests/routes/auth-reset-account-state.test.ts` (17 specs, real Postgres, no mocks,
  rows seeded directly in their § 6.1 shapes): AC 1.

**Per-state outcome table (AC 3).** Measured with a throwaway route probe against real Postgres
before and after (probe deleted; the new suite pins the "After" column).

| State | Before: reset-request | Before: reset | Before: what the new password then did | After |
|---|---|---|---|---|
| A | token issued | rotates, stamps `sessions_invalidated_at` | login 200 | unchanged: rotates |
| B | token issued | rotates, stamps | login 200 | unchanged: rotates |
| C (with an email) | token issued | ADDS a password, stamps | login 200 (C to B, an edge § 6.3 does not list) | refused |
| D with a password | token issued | rotates, stamps | login 200 | unchanged: rotates |
| D without a password | token issued | ADDS a password, stamps | login 200 | refused |
| G, email verified, with a password | token issued | rotates, stamps | login 200 | unchanged: rotates |
| G, email verified, without a password | token issued | ADDS a password, stamps | login 200, no ORCID needed (set-password requires one) | refused |
| G, email unverified, with a password (legacy shape) | token issued | rotates, stamps | login 200 | unchanged: rotates |
| G, email unverified, without a password | token issued | ADDS a password, stamps | login 200, against § 6.2's "may not acquire a password while unverified" | refused |
| E | token issued | rotates, stamps | login 409 PENDING_UNVERIFIED | unchanged: rotates |
| F, email path | token issued | rotates, stamps | `/resume-signup` 200 (the forgot-password resume flow) | unchanged: rotates, resume still works |
| F, ORCID path (with an email) | token issued | ADDS a password, stamps | `/resume-signup` 200 | refused; login NO_PASSWORD_SET |

