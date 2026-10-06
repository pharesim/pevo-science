## The signup upsert can overwrite a finalized account row (archived 2026-10-06) — clean re-review of the comment-only hold fix; one wording advisory dismissed

### Architect archive note (2026-10-06)

Clean focused `/ce-code-review` of 342f2820, the hold fix: an orchestrator correctness read plus one
adversarial reviewer, no actionable findings. Both held items are fixed. The `writeSignupRow` and
canary docblocks now say only that a row other than an E row is left alone or declined, which holds:
in § 6.1 only state E has `username` NULL with a token that is not `confirmed:`. The stale
catch-comment sentence is gone. The extra site the implementer narrowed, canary "Neither reaches state
E", also holds: the add-flow clearer requires a username and the change branch selects by
`pending_email_token`. `tests/eslint` on a copy of 342f2820: 9 files, 146 passed, exit 0.
Dismissed by the user: advisory A1 (P3, confidence 50). It said "a row other than an E row written
for the address" can be misread with "written" attached to "an E row", and suggested "a non-E row
written". The clause before it settles the meaning. The hold's open item, the account takeover through
the signup verify link, is filed as `backend-signup-verify-requires-the-signup-password` and
`ui-signup-verify-asks-for-the-signup-password`. No `/ce-compound`.

**Owner:** backend
**Created:** 2026-09-08
**Priority:** high

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

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed d33792ce, scoped to `writeSignupRow` and the `POST /signup` handler in `routes/auth.ts`,
the canary docblock in `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`,
and the six signup specs in `tests/routes/auth-state-g-rows.test.ts`. Scope 1 to 3 and AC1 to AC3
are met. AC3 was re-run on copies: the factor-carrying spec fails at d33792ce~1 (200, row
rewritten) and the file passes at d33792ce (12/12). Both held items are comment fixes. No new spec
is required.

1. **Narrow the two docblocks that say a row written after the duplicate pre-check is left
   alone.** Both upserts run `DO UPDATE` only `WHERE accounts.username IS NULL AND
   accounts.verify_token NOT LIKE 'confirmed:%'`, and a pending signup row E satisfies that. If
   another signup for the same address writes its E row inside the window, this signup's upsert
   rewrites that row and answers 200. Measured on a copy of d33792ce, with the interleave forced
   through a `pool.query` spy: an interleaved E row gave 200 with its token replaced, and an
   interleaved G row gave 409 with the row unchanged. The behavior is intended. The comments claim
   more than the code does.
   - `writeSignupRow` docblock: "a row written for the address after that check ... is left as it
     is". Narrow it to a row other than a pending signup row E. The same sentence calls E "the one
     row the duplicate pre-check lets through", but the pre-check also lets a factor-less
     unverified G row through, to the eviction. Narrow that to the one row the `DO UPDATE` branch
     rewrites.
   - Canary docblock: "a row written for the address between the check and the upsert is declined
     rather than rewritten". Narrow it the same way.

2. **Delete one stale sentence from the outer catch's ORCID_ALREADY_LINKED comment:** "The
   email-duplicate path returns 409 DUPLICATE before the INSERT, so it never reaches this branch."
   The `claim_changed` 409s return after the upsert ran. The rest of the comment needs no
   replacement text.

Decided at this review (user, 2026-10-05):

- **The ORCID+email path keeps the eviction.** This corrects the residual in
  `backend-state-g-unverified-row-lifecycle` that an evictor "cannot verify it without the
  mailbox". That holds on the email path only. On the ORCID+email path the signup writes a
  `confirmed:` row and sends no mail, so whoever evicts a factor-less unverified G claim there holds
  the address at once. Measured on a copy of d33792ce: 200, and the response carries the new row's
  `confirmed:` auth_token and the binding cookie. Kept for three reasons. The evicted claim carries
  no mailbox proof either. The ORCID path already attaches an unregistered address without one
  (`api-contracts/auth.md`, signup). And refusing there would let an unverified G claim, kept alive
  by re-issuing, block ORCID+email signups indefinitely for an address on a non-accredited domain.
  The spec "evicts a factor-less G row on the ORCID path" pins the eviction.

Dismissed at this review (recorded so the archive keeps them):

- The ARCHITECTURE.md § 6.3 edge for the eviction. It is already a `[TODO Architect]` in
  `backend-state-g-unverified-row-lifecycle` and lands with that task's § 6 edits, under the
  decision above.
- Specs pinning four guards: the ORCID+email upsert's `DO UPDATE` WHERE, the eviction DELETE's
  `verify_token = $2` term, its `rowCount !== 1` rollback, and the `NOT LIKE 'confirmed:%'` term in
  both upserts. Removing any one of them left every signup spec green. Also dismissed: a spec that
  tells the pre-check's factor-carrying 409 apart from the `claim_changed` 409, which the upsert
  WHERE produces when that branch is removed. All of this is preemptive test hardening: the code is
  correct, and each window lies between the pre-check and the write.
- The eviction predicate not testing `custody` or `upgraded_at`. The § 6.2 row shape that would
  reach it, an unverified G row moved to custody 'self' by `/upgrade` under a leftover light JWT,
  is the subject of the pending `backend-custody-routes-gate-on-row-claim`.

Open, outside this hold: an account takeover through the signup verify link. A signup for someone
else's address leaves the signup's password on the row, `POST /api/auth/verify` asks for no
password, and `/confirm` and `/link` keep it. If the address owner finishes that signup, the
signer can log in with that password. This predates the change, but the eviction lets an attacker
time it, since settings and signup both mail the subject "PEvO - Verify your email". It is awaiting
the user's decision on filing a task, and nothing here depends on it.

When both items are in, `git mv` this file back to `tasks/review/`.

## Backend hold-fix signal (2026-10-06)

Landed in the commit that moves this file to `review/`. Comment-only; no code or spec changed.

- **Item 1, `writeSignupRow` docblock.** The sentence now says a row *other than an E row*
  written for the address after the check is left as it is. The appositive "the one row the
  duplicate pre-check lets through" is deleted rather than rewritten: with the preceding clause
  already confining `DO UPDATE` to E, "the one row the `DO UPDATE` branch rewrites" would only
  restate it.
- **Item 1, canary docblock.** "a row other than an E row written for the address between the
  check and the upsert is declined rather than rewritten".
- **Item 2.** The stale sentence is deleted from the outer catch's ORCID_ALREADY_LINKED comment;
  nothing replaces it.
- **One more site, same claim class, outside the quoted sentences.** The canary docblock's
  "That second one is a delay" paragraph said "Neither reaches the row the pre-check lets through,
  state E". The pre-check also lets a factor-less unverified G row through to the eviction, and
  the settings add-flow clearer does reach that row, so the appositive is deleted: "Neither
  reaches state E, whose username is NULL ...". Found by a verification pass over this fix (two
  independent lenses converged on it, four skeptics upheld it). The same pass judged the three
  edited sites accurate and found no other residue in `routes/auth.ts`,
  `tests/routes/auth-state-g-rows.test.ts` or `tests/routes/recover.test.ts`.
- **Verification.** `tests/eslint/` (all nine source scans) plus
  `tests/routes/auth-state-g-rows.test.ts`: 10 files, 158 tests passed, exit 0. Canary file
  re-run after the last edit: 31/31, exit 0.

## Rows the old settings verify handler locked out of signup are never repaired (archived 2026-10-06) — clean first review; the operator procedure now lives in ARCHITECTURE.md

### Architect archive note (2026-10-06)

Clean `/ce-code-review` of 2fd1c633, b238605c and 5e9510a4: seven reviewers (correctness, adversarial,
project-standards, testing, data-migration, deployment verification, learnings), zero findings. Six of
them independently enumerated every `accounts` writer at 5e9510a4 and found none that leaves
`verify_token` and `username` both NULL, even transiently. The testing reviewer reproduced every
mutation-kill claim in the signal. The `[TODO Architect]` is done: ARCHITECTURE.md § Schema Migrations
gains "Post-deploy cleanup: rows the old settings verify handler locked", with the operator commands
plus the pre-delete backup step (a COPY of the matched rows) that the deployment reviewer asked for.
§ 6.1's "No transition produces a row that doesn't match one of the rows above" stays as is: it is true
of the current code, and the new section records the history. The production run is the user's, after
a backend whose settings verify add flow requires a username is deployed. No `/ce-compound`.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

## Why

Before d33792ce, `GET /api/settings/email/verify/:token` looked a row up by the token alone and
cleared `verify_token` and `expires_at` on it. A pending signup row's token (state E's hex
token, or state F's `confirmed:` token) presented there was accepted. That left the row with
`verify_token` NULL and `username` NULL. No state in ARCHITECTURE.md section 6.1 has that
combination: E and F carry a token, and every state with a NULL token has a username.

d33792ce stops producing these rows but does not repair any that already exist. Such a row is
terminal:

- `POST /api/auth/signup` answers 409 for its email, so the address cannot sign up again.
- `ABANDONED_ACCOUNT_ROWS` in `signup-cleanup.ts` requires `verify_token IS NOT NULL`, so the
  signup cleanup never reaps it.
- A password login on it mints a JWT whose `sub` is null. `verifyHiveSignature` accepts only
  a non-empty string `sub`, so the session authorizes nothing. The row only holds the address.

Had the token not been cleared, the cleanup would have deleted the row: an E row once its
link expired, an F row 30 days after creation. Deleting a locked row therefore reaches the
end state the cleanup would have reached, and the person can sign up again from the start.
