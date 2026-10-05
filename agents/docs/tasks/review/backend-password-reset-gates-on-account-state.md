# Password reset gates on no account state

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

"Refused" means: reset-request answers exactly as for an unknown email and writes no token; a
token already on the row gets 400 `INVALID_TOKEN` identical to an unknown token's body, and the
row is unchanged. On an accepted row the suite pins `email`, `username`, `orcid`,
`verify_token`, `custody`, `upgraded_at` and `expires_at` unchanged. A row with no email (some C
and ORCID-path F rows) was never reachable through reset-request and still is not.

**AC 2.** Each refused state's reset-request answer is asserted deep-equal to an unknown email's
(status and body) in the same spec, with wall time at or above `TIMING_ORACLE_FLOOR_MS` and no
token on the row. It is the unknown-email code path itself, not an imitation of it. The
verification pass's enumeration lens compared status, body, headers, timing, the drain-window
and argon2-saturation branches, the rate limiter and persistent side effects, and found no
distinguishing axis.

**Decided with the user (2026-10-05): ORCID-path F loses its reset route back.** An ORCID-path F
row with an email that lost its `auth_token` had exactly one pre-cleanup way back: reset adds a
password, then `/resume-signup` answers 200. Every other door is shut (signup again 409 "Email
already verified", ORCID login 404 NO_ACCOUNT, `/resume-signup` refuses passwordless rows by
design, `signup-cleanup` reaps F rows only by `created_at` after 30 days). The default rule closes
that route. Not judged a legitimate flow: it hands an ORCID-verified pending signup to whoever
holds an email the ORCID path never verified. Proposed follow-up for filing: an ORCID-proven
resume path for ORCID-path F rows, which would also help the no-email ORCID-path F rows that
already wait out the 30 days today.

**Out-of-scope findings, for triage.**
- Outstanding reset tokens survive email changes. Only the reset routes ever write
  `reset_token`; ORCID recovery rewrites `email` and the settings change flow swaps it, and
  neither clears a token mailed to the previous address within its hour.
- `RESET_REQUEST_OK_MESSAGE` ("If an account exists with that email, a reset link has been
  sent.") and the UI copy `resetPassword.checkEmailDescription` now overclaim for a passwordless
  account: it exists and no link comes. The task fixed the response as uniform, so not changed.
- Mutant "gate on the token SELECT only, UPDATE unconditional" survives the suite: only a
  password dropped concurrently between the token lookup and the UPDATE tells the placements
  apart. A refuter judged the race theoretical, so no race spec; the comment that claimed a
  placement guarantee was narrowed instead (`bd5d7e28`).

**[TODO Architect] docs now describing the old behaviour** (architect zone, not edited):
- § 6.3 "Forgot password": lists A and B only, and "(C cannot use /reset ...)". The rule now
  covers every row with a password: A, B, D and G with one (G verified or not), E and email-path
  F; it refuses C, D and G without one, and ORCID-path F.
- § 6.3 Option C note: "`POST /api/auth/reset` gates on no account state" (the sentence the
  `signup-verify.ts` comment carried).
- § 6.4 reset row: "A and B (states with email AND password). C: not applicable."
- `api-contracts/auth.md` `POST /api/auth/reset` errors: `INVALID_TOKEN` is also the answer for a
  token whose row has no password.
- The two comments the architect note names (`routes/settings.ts` set-password "Only
  ORCID-verified accounts can opt into password login", and the `ORCID_REQUIRED` test comment)
  are now true as written; not edited.

**Verification.**
- `npm run typecheck` clean; eslint clean on every changed file.
- New suite on the parent code: 10 failed / 7 passed, exactly the refused-state specs (refusals
  answered 200, and reset-request in 7 to 10 ms with no sentinel burn). After `8bf9283a`: 17/17.
- Reset-touching suites: 12 files / 202 tests green after `8bf9283a`; 10 files / 163 tests green
  after `1dd8776a` (the new suite, session-proof-invalidation, settings-email-fresh-auth,
  auth-log-shape, auth-reset-request-shutdown, recover, auth, auth-argon-error-translation,
  signup-verify-stuck-recovery, no-stale-comment-anchors; the first run also had
  settings-set-password, auth-state-g-rows and the `updated_at`-writer canary).
- Full backend suite at `bd5d7e28`: 7 failed files / 17 failed tests, 2730 passed, 10 skipped,
  no Errors line. All seven are the files that fail on clean main per earlier baselines
  (idempotency-real-haf, papers-enrichment-parity-gate, accreditation-idempotency,
  profile-auth-bypass, cast-hardening-author-index-weight, accreditation's two cap specs,
  reviews' two gate specs), with HAF connection timeouts in the log. `1dd8776a` changed one
  message literal into a constant and one comment after that run.
- Adversarial verification workflow (4 lenses, 1 refuter per finding, 14 agents, probes in
  scratchpad copies): no behavioral defect. State-machine lens: no interleaving adds a password
  (the gate is the UPDATE's WHERE), a refused reset leaves no side effect, nothing depended on
  reset adding a password. Mutants on the gate halves, the rowCount refusal, its status and the
  missing burn were all killed. Six distinct comment-truth defects, fixed in `bd5d7e28`.
- `/ce-simplify-code` (reuse, quality, efficiency): 2 applied (the shared invalid-token message,
  an overclaiming header paragraph deleted), 4 skipped (hoisting the per-spec unknown-email
  baseline, the `seedRow` re-read, gating the token SELECT, a redundant table comment).
- Code review: not run by backend; the architect runs `/ce-code-review` at intake.
