# The email-change link answers 500 when another row has taken the address

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed at the user's request from the pre-existing findings in the signal block of
`backend-settings-verify-clears-any-row-token` (its item 4, from code reading there). A scoping
pass measured it on 02c66d99. It is wider than filed: the defect is at the swap, and signup is
one of several triggers.

## Why

The change branch of `GET /api/settings/email/verify/:token` swaps `email = pending_email` with
no re-check and no mapping for a unique violation. If another row has taken the address since the
change was queued, the swap trips the `accounts.email` UNIQUE constraint (`accounts_email_key`,
23505). The catch-all then answers 500 INTERNAL_ERROR 'Verification failed' on every click. The
row keeps its email and pending triple, and the row holding the address is unchanged (measured).
The SPA's `settingsVerifyEmailPage` shows any error as "Verification link has expired. Please
request a new one."

None of the triggers reads `pending_email`:

1. **Signup, email path (measured).** `POST /api/auth/signup`'s duplicate pre-check reads
   `accounts.email` only. A signup with X answers 200 and writes a state E row. The signup mail
   goes to X, so the caller needs no access to X's mailbox. X must be an institutional address.
2. **Signup, ORCID path (measured).** X on any domain. It writes a state F row and sends no mail.
   The row lives 30 days.
3. **ORCID recovery (measured).** The ORCID branch of `POST /api/auth/recover` checks the new
   address with `SELECT id FROM accounts WHERE email = $1 AND id != $2`, which ignores
   `pending_email`. It writes the new email at once and sends no mail. A light B or C account with
   its ORCID takes X permanently: the row is finalized and never reaped.
4. **Seed-phrase recovery (code reading).** `POST /api/auth/recover/verify` runs the same re-check
   before its swap. It needs the link mailed to X, so only X's mailbox holder can fire it.

After the conflict, the owner R cannot request X again: the duplicate check in
`POST /api/settings/email` counts the holder and answers 409. An E holder always outlives R's
link. Both expire 24h after their own write, the E row is written later, and a signup retry by
any caller refreshes it. So the old link never works again, and signup cleanup reaps the E row
only after R's link has expired. Meanwhile `GET /api/settings/email` keeps reporting
`pendingChange: true`.

Impact: the availability of one pending change. Triggering it needs the target address, or
happens when the owner signs up with the target address themselves. Nothing leaks and nothing is
corrupted (measured).

## Scope (option (b); see Open decisions)

1. Around the swap: on 23505 with `err.constraint === 'accounts_email_key'`, clear the row's
   pending triple and answer 409 DUPLICATE 'This email is already associated with another
   account', which is the existing body of `POST /api/settings/email`'s 409. Clear with
   `UPDATE accounts SET pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL WHERE id = $1 AND pending_email_token = $2`,
   the same key as the swap. Leave the holder row untouched. Gate on the constraint the way
   `POST /api/auth/signup`'s catch gates ORCID_ALREADY_LINKED on `accounts_orcid_unique`. The
   constraint name on this path was measured.
2. Add no new error code, no new log call and no emdash.
3. Add one route spec, email path, in the settings-verify spec family. Copy the SMTP mock,
   `smtpHost` stub and `MOCK_VERIFY_SIGNATURE` header from
   `tests/routes/settings-state-g-unverified-email.test.ts`, and drive the real
   `POST /api/settings/email`, `POST /api/auth/signup` and `GET /api/settings/email/verify/:token`.
   Specs for the other triggers would be preemptive, because the fix is at the swap.

## Acceptance criteria

1. R queues a change to X, a signup with X answers 200 (E row), and R's link answers 409
   deep-equal to `POST /api/settings/email`'s 409. The spec fails at 02c66d99 (500).
2. After that click: R's email is unchanged, its triple is NULL, and `GET /api/settings/email`
   reports `pendingChange: false`. The E row is unchanged. A second click answers the
   unknown-token 400 'Invalid or expired verification link'.
3. `tests/routes/settings-state-g-unverified-email.test.ts`, `tests/routes/settings.test.ts` and
   `tests/routes/auth-state-g-rows.test.ts` are green by exit code and the Errors line.
4. No new error code, no new logger call, no emdash.

A scoping probe planted exactly this scope. Click 1 answered the 409, the triple was cleared,
click 2 answered the 400, and the two settings spec files passed 38/38. On base, the same probe
got the 500.

## Open decisions (user / architect)

1. **Fix shape.** Recommendation: (b), with (d) only if the change should win against an E
   holder.
   - (b), the scope above. It is local, and it does not restore availability: R gets X only once
     the holder is gone.
   - (a) Signup treats another row's live `pending_email` as taken. Not recommended:
     - Any account with a verified email could hold any address against signup by re-queueing
       every 24h, with no mailbox proof. The 2026-10-05 state G decision rejected that kind of
       hold.
     - It tells callers without a Hive account that X is a pending target.
     - It must filter out expired triples.
     - It leaves the recovery triggers, so it could only ever be an add-on to (b).
   - (d) Mailbox proof wins. At the swap, evict a state E holder in one transaction, like
     `writeSignupRow`'s eviction of a factor-less G claim, and fall back to (b) for any other
     holder. It restores availability against E holders. It costs a new ARCHITECTURE.md § 6.3
     transition (E to no row) and a transaction.
2. **The answer.** Recommendation: reuse the 409, which is accurate. The alternative is the
   generic 400. Only the holder of the token mailed to X reaches this branch, so neither is a
   third-party oracle. The SPA shows the expired message either way, so a UI task is needed only
   if the user should see the real reason.
3. **Clearing the triple on conflict.** Recommended. The cost: if a finalized holder lets go of X
   within R's 24h window (account deletion, or another ORCID recovery), the old link would
   otherwise have worked again. With the clear, R requests the change again.

## Notes

- Overlap: the same swap UPDATE is edited by `backend-reset-tokens-outlive-email-changes-and-recovery`
  (Scope item 2) and by `backend-email-change-moves-other-users-digest-address`. This task builds
  on the token-keyed swap from 02c66d99, which is in review.
- Already recorded, so not filed again:
  - The E-row retry squat is a residual in `backend-state-g-unverified-row-lifecycle`.
  - ORCID-path binding of an address without mailbox proof is the 2026-10-05 user decision
    recorded in `backend-signup-upsert-overwrites-finalized-row`.
- `backend-signup-verify-requires-the-signup-password`: the settings change mail and the signup
  mail share the subject "PEvO - Verify your email". A user waiting for their change link may
  click the attacker's signup link instead, which confirms the E row into F and turns a 24h hold
  into a 30-day one. That task closes this.
- New residual for triage, not in scope: expired pending triples are never cleared.
  `GET /api/settings/email` keeps reporting `pendingChange: true`. The stale triple also blocks
  other accounts' settings add or change to X (409, measured) until R changes again. Signup is
  unaffected.

## Architect note (2026-10-08): the clear moves into the apply function; signup refuses a confirmed pending address

User decisions 2026-10-08 (from `architect-email-change-owner-notice-and-dispute-race`):

1. Open decision 1 stays (b). `backend-email-change-hold-and-owner-notice` (high) moves the swap
   into an exported apply function that handles the 23505 on `accounts_email_key` by clearing the
   pending columns with the same key and returning a collided outcome; the verify route maps it to
   this task's 409, and the sweep that applies held changes treats it as done and never retries.
   Whichever task lands second merges. Acceptance 1 here holds for changes that carry no hold; a
   sweep spec in the hold task covers the held case.
2. New scope item, after the hold task lands: `POST /api/auth/signup`'s duplicate check also
   counts an address another row holds as `pending_email` with `pending_email_confirmed_at` set.
   A confirmed pending address has mailbox proof (its holder opened the link), so the 2026-10-05
   decision against holding an address without mailbox proof does not apply; without this check a
   held change can be pre-empted during its 72 hours and is then cleared silently. The signup
   answer is the existing `DUPLICATE` 409.
