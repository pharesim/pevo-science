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
