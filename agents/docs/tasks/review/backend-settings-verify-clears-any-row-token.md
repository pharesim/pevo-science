# The settings email-verify handler clears verify_token on whatever row carries it

**Owner:** backend
**Created:** 2026-09-14
**Priority:** high

Surfaced by the security lens during the round-4 review of the
`accounts.updated_at` writer canary, and confirmed by an independent validation
pass. Pre-existing and unrelated to that canary's own change, so it is filed
here rather than held there.

## Why

`GET /api/settings/email/verify/:token` looks the row up by the token alone:

```
SELECT id, expires_at FROM accounts WHERE verify_token = $1
```

and then clears it:

```
UPDATE accounts SET verify_token = NULL, expires_at = NULL WHERE id = $1
```

Neither statement scopes the row to the flow that issued the token. The
settings add flow is the intended issuer, and it writes `verify_token` only on a
row it INSERTs for a username that had none, which is state G per
ARCHITECTURE.md section 6.1. But the signup INSERTs in `routes/auth.ts` write
the same column on a pending row, and the signup verify-link step writes the
`confirmed:` form. Either of those tokens presented to this handler is accepted.

The row that results is `verify_token` NULL with `username` NULL, which section
6.1 does not enumerate, and it is terminal:

- `POST /api/auth/signup` answers 409 for an existing row whose `verify_token`
  is NULL, so the address cannot be signed up again.
- The resend route returns before its UPDATE when the token is already NULL, so
  no new link can be issued.
- Signup cleanup deletes only rows whose `verify_token` is NOT NULL, so the row
  is never reaped.

So anyone holding a leaked verification link, or the `confirmed:` auth_token,
can permanently lock that email address out of signup. That is the capability
the signup session binding exists to deny a leaked token, reached through a
different route. Worth tracing on the way in: the login handler's pending-state
branch keys on the token too, so a bricked row falls through to the active
branch, and what a session minted from a row with a NULL `username` does is part
of the blast radius rather than a separate question.

The two stuck-recovery lookups are NOT reachable from this row: both conjoin a
`custody` value no INSERT writes. The marker is not moved either. This is an
availability and account-state defect, not a binding bypass.

## Scope

1. Scope the add-flow lookup and its UPDATE to rows the add flow could have
   created, so a signup token presented here is not accepted. The add flow's
   rows always carry a `username` (the INSERT names it); the signup INSERTs
   leave it NULL. Verify that separation from the code before relying on it
   rather than from this description, and say what you verified.
2. A token that does not match after the narrowing must answer the same generic
   400 the not-found path already answers. Do not add a distinguishing message:
   the difference between "no such token" and "that token is not for this flow"
   is a signup-state oracle.
3. Decide, and state, what happens to the change flow's branch in the same
   handler. It keys on `pending_email_token`, a column no signup path writes, so
   it is not exposed the same way; say so in the commit rather than leaving the
   asymmetry unexplained.

## Acceptance criteria

1. A state E row's own hex token presented to the settings verify handler
   answers the generic 400 and leaves that row's `verify_token` intact, pinned
   by a route test.
2. A state F row's `confirmed:` token does the same, pinned by a route test.
3. The settings add flow's own token still verifies, pinned by a route test that
   exercises the real path rather than asserting the narrowing in isolation.
4. No response distinguishes a wrong-flow token from an unknown one.

## Notes

- Sibling defect, same family, already filed:
  `backend-signup-upsert-overwrites-finalized-row.md`. That one is the signup
  upsert reaching a settings-created row; this one is the settings handler
  reaching a signup-created row. They are opposite directions through the same
  shared column and should read as a pair, but they are separate fixes in
  separate routes.
- The `accounts.updated_at` canary's docblock names this clearer as the third
  statement that clears the token. That sentence stays true whichever way this
  task lands; do not edit the canary from here.

## Backend implementation signal (2026-10-05, commit d33792ce)

d33792ce verified as an ancestor of HEAD with `git merge-base --is-ancestor`. It landed in the
same pass as `backend-state-g-unverified-row-lifecycle`, at the user's request. That task's
signal block holds the shared verification run.

- **Scope 1.** The add-flow lookup is now `WHERE verify_token = $1 AND username IS NOT NULL`. I
  verified the separation from the code: the settings add-flow INSERT always names the
  username, both signup INSERTs in `routes/auth.ts` leave it NULL, and both finalizes clear the
  token in the same UPDATE that sets the username. The clear is also keyed on the presented
  token (`WHERE id = $1 AND verify_token = $2 AND username IS NOT NULL`). The new re-issue
  branch can replace a G row's token between the lookup and the clear, and a link for the
  earlier address must not verify the later one. A clear that matches no row gets the same
  generic 400.
- **Scope 2.** Wrong-flow tokens (E hex, expired E, F `confirmed:`) get the not-found 400
  'Invalid or expired verification link', identical to an unknown token. That includes an
  expired E token, which used to draw the distinct "has expired" message.
- **Scope 3, the change branch.** Not narrowed. A non-NULL `pending_email_token` is written
  only by the settings `POST /email` handler, on a row it found by username, so no signup
  token can match. A code comment says so. Separately, under the lifecycle task's item 8b, the
  change branch now also clears `verify_token` and `expires_at` with the swap.
- **AC1-AC4.** Specs in `tests/routes/settings-state-g-unverified-email.test.ts`:
  - "answers a state E row's hex token with the unknown-token 400 and keeps the row's token"
  - "answers an expired state E row's token with the same unknown-token 400"
  - "answers a state F row's confirmed: token with the unknown-token 400 and keeps the row's
    token"
  - "verifies the settings add flow's own token through the mailed link", which drives the
    real path.

  The first three each failed against the base code. The responses are asserted identical to
  the unknown-token answer.
- **The `updated_at` canary.** The Notes said not to edit it from here. The lifecycle task's
  changes made several of its sentences false: the re-issue writes `verify_token` on an
  existing row, and the change branch now clears the token. So it was rewritten in d33792ce
  under that task, and the clearer it names is described with its new scope.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed d33792ce, scoped to `GET /api/settings/email/verify/:token` and its specs in
`tests/routes/settings-state-g-unverified-email.test.ts`. Scope 1, Scope 2 and AC1 to AC4 are
met. Both held items are in that handler.

1. **Key the change-branch swap on the presented token.** The swap UPDATE matches
   `WHERE id = $1` only. A `POST /email` that writes between the handler's
   `pending_email_token` SELECT and the swap therefore has its address swapped in by the
   earlier link. Measured on a copy of d33792ce, with the interleave forced through a
   `pool.query` wrapper:
   - A row with a verified email A0 and pending A under token T1. A second change request
     writes pending B under T2 inside the window. The T1 link answers 200 and
     `accounts.email` becomes B, an address nobody proved. Signup then answers 409 for B.
   - A legacy unverified state G row that carries a pending triple. A re-issue to B lands
     inside the window. The T1 link answers 200 and the swap writes `email = NULL` (the
     column is nullable) and `verify_token = NULL`, discarding the re-issued link.

   Fix: add `AND pending_email_token = $2` (bound to the presented token) to the swap's
   WHERE. When it matches no row, answer the same generic 400 'Invalid or expired
   verification link' and skip the `notification_preferences` UPDATE. Plant-tested in that
   form, with `RETURNING email` feeding the `notification_preferences` UPDATE:
   - Both interleaves answer the generic 400.
   - Each row keeps what the interleaving write left: pending B under T2 on the verified
     row, the re-issued email and token on the legacy row.
   - The in-scope spec file plus `tests/routes/settings.test.ts` stay green (37/37).

   If `RETURNING` replaces it, the `newEmail` local goes unused. Either source is correct,
   because once the swap is keyed on the token the two are equal.

   The comment above the swap says clicking the link "proves control of the new address,
   which is now the row's email". That is false under the interleave today. Reword it to
   say why it holds once the swap is keyed. Every write of `pending_email` in `settings.ts`
   writes `pending_email_token` in the same UPDATE: the change branch sets both, the
   re-issue branch clears both, and both SMTP-fail restores put both back. So a swap
   matched on the token installs the address that token was mailed to.

   No new spec is required for this item. An interleave spec was considered and dismissed
   as preemptive hardening, as for the add-flow clear below.

2. **Drop `AND username IS NOT NULL` from the add-flow clear.** The clear matches
   `WHERE id = $1 AND verify_token = $2 AND username IS NOT NULL` on a row the SELECT
   already found with `username IS NOT NULL`. The username conjunct can refuse only if that
   row's username became NULL between the two statements. No writer sets `username` to
   NULL and ARCHITECTURE.md section 6.1 lists no such transition, so under the account-state
   rule it defends a fictional state. It also absorbs the wrong-flow pins.
   - At d33792ce, removing the SELECT's predicate fails only the expired state E spec,
     because the clear's conjunct still refuses live E and F tokens.
   - Measured with the conjunct dropped, removing the SELECT's predicate fails all three
     wrong-flow specs (E, expired E, F).

   Keep `AND verify_token = $2`. That is what refuses a link whose token a re-issue
   replaced.

Dismissed at this review (recorded so the archive keeps them):
- An interleave spec pinning the add-flow clear's token key and its `rowCount === 0`
  refusal. Mutation shows no spec fails when either is removed. But the guard is in place,
  and removing it is not a realistic refactor, so this was dismissed as preemptive hardening.
- Scope 3's "say so in the commit". The decision and its reason are stated in the comment
  above the change branch, which is the more durable home.
- The blast-radius trace the Why asked for. It was traced at review: a row with `username`
  NULL and `verify_token` NULL logs in with a JWT whose `sub` is null. `verifyHiveSignature`
  accepts only a non-empty string `sub`, so that session authorizes nothing.

Filed separately: rows the base handler already left with `verify_token` NULL and
`username` NULL are not repaired by this change. See
`tasks/pending/backend-repair-rows-the-settings-verify-handler-locked.md`.

## Backend hold-fix signal (2026-10-06)

Landed in the commit that moves this file to `review/`. One file: `backend/src/routes/settings.ts`,
in `GET /api/settings/email/verify/:token`. No spec changed.

- **Item 1.** The swap is `WHERE id = $1 AND pending_email_token = $2 RETURNING email`, bound to
  the presented token. When it matches no row it answers the generic 400 'Invalid or expired
  verification link' and skips the `notification_preferences` UPDATE, which now takes its new
  address from `RETURNING email`. The `newEmail` local is gone, and so is `pending_email` from the
  change-branch SELECT, which nothing read any more. The comment states the pairing in both
  directions ("every write of `pending_email` or `pending_email_token` in this file writes both").
  Its last sentence says an interleaving change request or re-issue makes the swap match no row.
  It drops "a moment later": an interleaving request whose mail fails restores the earlier token,
  and the link then verifies again.
- **Item 2.** The add-flow clear is `WHERE id = $1 AND verify_token = $2`. The SELECT keeps
  `AND username IS NOT NULL`.
- **Verification.** In scope: `tests/routes/settings-state-g-unverified-email.test.ts` plus
  `tests/routes/settings.test.ts` 37/37, exit 0. tsc and eslint clean. Full backend suite: 19
  failed in 9 files, exit 1: accreditation-idempotency, accreditation (cap), reviews (gate),
  idempotency-real-haf, papers-enrichment-parity-gate, profile-auth-bypass, stats-profile-parity,
  cast-hardening-author-index-weight, fresh-auth-consent-op-burn-offline-queue. None touches
  `settings.ts` or this route, and several are on the known pre-existing list. They were NOT
  re-checked against clean main in this pass.
- **Probes** (scratchpad copies of base 342f2820 and of the fix, `pool.query` spy interleaves, not
  committed). Both hold interleaves reproduce on base. On the fix both answer 400 deep-equal to an
  unknown-token response, and the rows keep what the interleaving write left. Also closed: two
  overlapping clicks of one change link gave 200/200 and `email` NULL on base, 200/400 on the fix.
  Item 2: removing the SELECT predicate now fails all three wrong-flow specs; on base, only the
  expired E spec. As expected, no committed spec fails with the swap's token key or rowCount guard
  removed.
- **Pre-existing, outside this task, awaiting the user's triage.** (1) The change branch's
  `notification_preferences` UPDATE is keyed on email only. Another user's row holding the old
  address picks up the newly verified address, measured on both base and fix. (2) Both recovery
  UPDATEs in `recover.ts` leave the pending triple. A change link queued before a recovery still
  swaps afterwards. (3) No spec pins the `notification_preferences` move. (4) Signup checks
  `email` only, not `pending_email`, so a signup can make another row's swap hit the UNIQUE
  constraint. Code reading only.
