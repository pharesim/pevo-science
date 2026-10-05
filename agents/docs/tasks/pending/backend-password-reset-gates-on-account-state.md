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
