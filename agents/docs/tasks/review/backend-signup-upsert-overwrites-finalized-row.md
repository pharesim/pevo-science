# The signup upsert can overwrite a finalized account row

**Owner:** backend
**Created:** 2026-09-08

Surfaced by the security pass during the round-2 review of the
`accounts.updated_at` writer canary, and confirmed by an independent
validation pass. Pre-existing, unrelated to that canary's own change, so it is
filed here rather than held there.

## Why

`POST /signup` guards its upsert with a duplicate-email pre-check that answers
409 when the existing row's `verify_token` is NULL or carries a `confirmed:`
prefix. Those two shapes do not cover every finalized row. A state G row per
ARCHITECTURE.md section 6.1, an email registered through the settings flow and
not yet verified, has `username` set, a random hex `verify_token`, and
`custody` NULL. It passes the pre-check.

The request therefore reaches the `ON CONFLICT (email) DO UPDATE` branch, which
overwrites `password_hash`, `orcid`, `verify_token`, `signup_binding_hash` and
`created_at` from the incoming values. Anyone who knows that email address can
rewrite those fields on an account they do not control, and the new
`verify_token` is theirs.

What limits the blast radius today is that the branch does not touch
`updated_at`, and both stuck-recovery lookups additionally filter on `custody`,
which a state G row does not satisfy. That is defence in depth behind a check
that is supposed to be the barrier, not the barrier itself. The canary's
docblock is being corrected separately to stop crediting the pre-check with
work it does not do.

## Scope

1. Widen the `POST /signup` duplicate-email pre-check so it answers 409 for
   every finalized row, not just the two token shapes it recognises today.
   Selecting `username` alongside `verify_token` and refusing when `username IS
   NOT NULL` is the straightforward form; confirm against section 6.1 that it
   admits exactly the states the upsert's `DO UPDATE` branch is meant for and
   no others.
2. Preserve the timing equalisation the surrounding code documents. The argon2
   burn must run on the new refusal branch too, or the widened check becomes an
   email-enumeration oracle and trades one defect for another.
3. Add a route test that creates a state G row through the settings
   registration path and then posts `/api/auth/signup` with that email,
   asserting 409 and asserting the stored row is unchanged. No such test
   exists; that is why the gap survived.

## Acceptance criteria

1. A state G row cannot be reached by the upsert's `DO UPDATE` branch.
2. The refusal is indistinguishable in timing from the existing 409 paths.
3. The new route test fails against the current code and passes after the fix.

## Notes

- Check the states in ARCHITECTURE.md section 6.1 one at a time rather than
  reasoning from the two token shapes; the whole defect is that those two do
  not enumerate "finalized".
- Do not reach for `updated_at` as part of the fix. That column carries a
  separate invariant with its own standing guard, and adding a writer to this
  path is exactly what that guard refuses.

## Backend implementation signal (2026-10-05, commit d33792ce)

d33792ce verified as an ancestor of HEAD with `git merge-base --is-ancestor`. It landed in the
same pass as `backend-state-g-unverified-row-lifecycle`, at the user's request. That task's
signal block holds the shared verification run and the contract TODOs.

- **Scope 1, the pre-check.** It now also reads `username` and whether the row carries a
  password or an ORCID. I checked § 6.1 state by state:
  - A NULL token answers 409. That covers A, B, C, D and a verified G row.
  - A `confirmed:` token answers 409. That covers F.
  - A row with `username` set that carries a password or an ORCID answers 409, with the same
    argon2.hash burn as the sibling branches. That covers a legacy G row with a factor.
  - E is the one row left for the upsert's `DO UPDATE`.
- **User decision (2026-10-05).** For one row the 409 gives way to an eviction. A factor-less
  unverified G row holds nothing but the email claim, and holding it with a 409 let its owner
  block signup for that address indefinitely (re-adding restarts the expiry). So a signup that
  gets past the accreditation gate deletes that row and writes its own. The DELETE is
  conditional, keyed on the state the pre-check read, and runs in one transaction with the
  upsert. The G row's fields are never rewritten, so AC1 holds.
- **AC1, made structural.** Both upserts' `DO UPDATE` carry `WHERE accounts.username IS NULL AND
  accounts.verify_token NOT LIKE 'confirmed:%'`, and an upsert that writes no row answers 409
  DUPLICATE. A row written for the address after the pre-check is left untouched. The realistic
  case is the caller's own settings add-flow INSERT landing while argon2.hash runs, which would
  otherwise turn a claim that can be evicted into one that is permanent.
- **AC2, timing.** The new 409 burns argon2.hash like the existing ones. The eviction path and
  the post-gate 409 both come after the happy path's argon2.hash, so they cost the same.
- **AC3, tests.** In `tests/routes/auth-state-g-rows.test.ts`; every G row is created through
  the real settings registration path:
  - "answers 409 DUPLICATE for a G row carrying a factor, pays the argon2.hash burn, and leaves
    the row unchanged". Against the base code: 200, and the upsert overwrote the row.
  - "leaves a G row that appears after the duplicate pre-check untouched and answers 409
    DUPLICATE". Before the `DO UPDATE` guard: 200, and the row overwritten.
  - The eviction specs: email path, ORCID path, the 422 gate keeping the row, and
    ORCID_ALREADY_LINKED rolling the DELETE back.
- **`updated_at`.** Not touched. The canary docblock now describes both guards and the eviction.
  It says the guards bound which rows reach the branch and say nothing about what the branch
  writes.
- **Considered, not built.** A deterministic test for the eviction DELETE matching 0 rows.
