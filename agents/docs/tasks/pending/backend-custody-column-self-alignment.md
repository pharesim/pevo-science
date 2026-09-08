# Align the custody column with upgraded_at at upgrade and login mints

**Owner:** backend
**Created:** 2026-09-01

Routed out of the architect review of the custody-upgrade session-invalidation
work. Pre-existing: the shape predates that task and was not widened by it.

## Why

`POST /api/custody/upgrade` nulls the encrypted keys and sets `upgraded_at`
but never writes `custody = 'self'`, so every upgraded account sits in the row
shape `(custody = 'light', upgraded_at NOT NULL)` — a combination
ARCHITECTURE.md § 6.1 does not enumerate. The two login mints then disagree
about what that row means: `auth.ts` login derives the JWT custody claim from
`upgraded_at` (correct), while the ORCID login mint reads the column raw and
re-mints a stale `custody: 'light'` claim for an account the server can no
longer sign for.

Impact is contained today: the broadcast and session-auth routes refuse on
`upgraded_at` before acting, so the stale claim is a divergence of claim
rather than a live hole. But per the account-state defense rule, an
unenumerated reachable state means the code and § 6.1 must be reconciled, and
two mint sites deriving the same claim differently is exactly the kind of
split that turns into a hole when a third consumer trusts the claim.

## Scope

1. Write `custody = 'self'` in the upgrade UPDATE's SET list (mirroring the
   signup-verify `/link` finalize), so the transition lands atomically with
   the key-nulling and the epoch stamp.
2. Backfill existing rows: `custody = 'self'` where `upgraded_at IS NOT NULL
   AND custody = 'light'` (SQL migration).
3. Unify the login-mint derivation: either both mints derive from
   `upgraded_at` the way `auth.ts` does, or both read the now-correct column —
   pick one shape and state why in the code. The pair must be incapable of
   disagreeing for the same row.
4. Tests: an upgraded account logging in via ORCID receives a `custody:
   'self'` claim; the post-upgrade row shape is pinned; the backfill is
   covered by a migration-level assertion or an equivalent test.

## Acceptance criteria

1. No reachable row shape `(custody = 'light', upgraded_at NOT NULL)` after
   the migration runs.
2. Both login paths mint identical custody claims for the same account row,
   pinned by a test that would fail if either derivation drifts.
3. The upgrade route's own suite still passes, including the
   session-invalidation legs.

## Notes

- **[TODO Architect]** § 6.1's state D row shape (and any state-table text
  that describes the custody column post-upgrade) is architect-owned and will
  be updated at archive to match whichever shape lands.
- Sequencing: CLEARED (2026-09-02, architect). This asked to land after a
  one-line comment fix the custody-upgrade session-invalidation work held in
  the same file area (`verifyHiveSignature.ts` / `routes/custody.ts`). That
  fix landed and its task is archived, so nothing remains to sequence behind
  and the five held items below can be picked up directly.

## Backend completion notes (2026-09-02)

Landed in `68fc1e91` (implementation), `c5846d1a` (review fixes, task to
review/), and `9fd22a7f` (simplification pass on the migration). Per scope
item:

1. The upgrade UPDATE writes `custody = 'self'` in the same statement as the
   key-nulling, `upgraded_at`, and the revocation epoch. `updated_at` is
   deliberately not bumped (it is the `/link` stuck-recovery recency marker
   and that lookup matches `custody = 'self'` rows); the handler comment says
   so.
2. Migration `017_accounts_custody_upgraded_align.sql`: back-fill
   (`custody = 'self' WHERE upgraded_at IS NOT NULL AND custody IS DISTINCT
   FROM 'self'`, so a NULL column with an epoch is repaired too), then a
   one-directional CHECK `accounts_upgraded_implies_self_custody`
   (`upgraded_at IS NULL OR custody IS NOT DISTINCT FROM 'self'`). The
   null-safe spelling is load-bearing: a CHECK that evaluates to NULL passes,
   so plain `custody = 'self'` would admit an epoch on a NULL-column row,
   which is what the `/link` finalize (starting from a pre-finalize row)
   would produce if it dropped its column write. The DO block compares the
   installed constraint's deparsed definition with the wanted one: a match
   is a no-op (the re-validation lock is paid once, not on every
   `deploy.sh migrate`), a mismatch or absence drops and re-adds it, so a
   database that already carries the constraint under an earlier predicate
   converges. Pinned in the migration suite (OID survives a converged
   re-apply; a stale predicate under the same name is replaced).
3. One derivation, `custodyClaimFor` in `src/lib/custody-claim.ts`, used by
   the password login, the ORCID login (its SELECT now carries
   `upgraded_at`), both recovery reissues, and the two settings handlers that
   report or branch on custody. Rule, stated in the module docblock: `'light'`
   only from a row with no epoch AND an explicit `'light'` column; everything
   else is `'self'`. The epoch is what every refusing gate reads, and the
   light claim is the one with authority attached, so the derivation fails
   toward the claim that grants nothing. The writer sites (`/upgrade`,
   `/confirm`, `/link`) keep their literal claims: the literal is the value
   just written.
4. Tests: `tests/migrations/accounts-custody-upgraded-align.test.ts`
   (constraint shape, 23514 refusals for the light+epoch INSERT, the exact
   old UPDATE statement, and the NULL+epoch INSERT, every enumerated shape
   accepted, back-fill against the shipped SQL inside a rolled-back
   transaction with `updated_at` pinned untouched, re-apply convergence);
   `tests/routes/custody-claim-mint-parity.test.ts` (real Postgres/Redis,
   drives the actual upgrade, then password login, ORCID login, and the
   settings read all report `'self'` for the row the route left behind, and
   `'light'` before); a mocked-row pin in `orcid.test.ts` that feeds the ORCID
   mint a column/epoch-divergent row (the only way to show that mint reading
   the epoch, since the CHECK forbids seeding the row); `tests/lib/custody-
   claim.test.ts`; and `tests/eslint/no-custody-claim-derivation-outside-
   helper.test.ts`, a source canary that pins the helper's caller set,
   refuses the inline derivation shapes outside the helper, and classifies
   every `jwt.sign` site's claim source (literal at a writer, variable at a
   helper caller, carry-over at the token refresh). The post-upgrade row
   shape is pinned in `custody-upgrade.test.ts` for states A/B/C; the one
   fixture that seeded the fictional light+epoch shape (`custody-consent-
   ops.test.ts`) now seeds state D.

Acceptance criteria: (1) the back-fill plus the CHECK make the shape
unreachable; verified by the migration suite and by a mutation run that
dropped the column write from the upgrade SET list (the CHECK turned it into
a loud 500 across seven tests). (2) The parity suite pins both logins on one
real row; the canary and the mocked-row pin are what fail if either
derivation drifts (verified by mutation: re-inlining the ternary in the
password login and copying the raw column in the ORCID login each went red).
(3) The upgrade suite, including the session-invalidation legs, passes.

Review findings applied in round 2 (from the read-only lens/refuter pass over
`68fc1e91`): the helper's original NULL-column fallback was `'light'`, which
flipped `GET /api/settings/email` from `'self'` to `'light'` for a Keychain
account that added an email (a reachable row with a username and no custody
value; see the first architect item below); corrected to `'self'` and pinned
at the wire in `settings.test.ts`. The CHECK's plain-equality predicate
admitted a NULL column with an epoch; tightened as described in item 2.

**[TODO Architect]** Doc and ops follow-ups on archive (none blocking):

- `ARCHITECTURE.md` § 6.1: state D's row shape already reads
  `custody = 'self'`, `upgraded_at SET`, so no table change; the field
  rationale for `upgraded_at` names only `/api/custody/upgrade` as its writer
  and should also name the signup-verify `/link` finalize. Worth recording
  that the `accounts_upgraded_implies_self_custody` CHECK now enforces the
  epoch-implies-self half of the state table at the schema layer.
- `ARCHITECTURE.md` § 6.1, unenumerated reachable state: `POST
  /api/settings/email`'s Keychain add-flow inserts `(username SET,
  password_hash NULL, orcid NULL, custody NULL, upgraded_at NULL)` and the
  verify handler only clears `verify_token`, so a pure self-custody account
  that added an email owns a finalized row with no custody value. The two
  settings readers and, if the user later links an ORCID, the ORCID login
  mint all read it. `custodyClaimFor` reports it as `'self'` (the server
  holds nothing for it). Per the account-state defense rule this needs the
  doc updated first; the code treats it as a self-custody row.
- `ARCHITECTURE.md` "Schema Migrations" plus `deploy.sh`
  `destructive_pending_migrations()`: 017 is the first migration that ADDs a
  CHECK the pre-017 backend's own writer violates (the old `/upgrade` UPDATE
  stamps the epoch without the column). The tripwire greps only DROP/RENAME/
  ALTER TYPE/ADD COLUMN NOT NULL, so `./deploy.sh restart` takes the live
  path and an upgrade landing in the migrate-to-swap seconds fails 500 after
  the client has rotated its chain keys (the SPA treats a post-broadcast 500
  as terminal). Either add an `ADD CONSTRAINT ... CHECK` arm to the tripwire
  (forcing the brief-stop path) or deploy 017 with the backend stopped and
  record constraint-tightening CHECKs in the doc's unsafe-for-live list.
- `api-contracts/orcid.md`, `mode='login'` response: `custody` is now the
  same derived claim the password login mints, so an upgraded (state D)
  account receives `'self'`; the example shows `'light'` with no statement
  about state D. A state-G row reaches the identical response and also
  resolves to `'self'`, so the doc update covers both states, not just D.
  `api-contracts/custody.md` POST /upgrade prose may mention
  the row is marked self-custody. `settings.md` already matches.
- Note for § 6.3's stuck-recovery text: with the column now `'self'` after
  upgrade, a row that upgrades inside its own `/confirm` recovery hour
  matches the `/link` stuck-recovery lookup for the rest of that hour. Reach
  is the key holder only (fresh Keychain signature, which after upgrade is
  the mnemonic holder), the cascade is sanction-guarded and dedup-probed, and
  the minted `'self'` JWT is obtainable via `/api/auth/session` anyway, so no
  code change; recording it keeps the enumeration honest.
- Possibly UI-relevant: state-D sessions minted by the ORCID login now take
  the SPA's `custody === 'self'` branches (correct signer routing), which
  lands them on the pre-existing state-D-over-JWT gap for settings critical
  actions (the SPA sends no fresh-auth proof for `'self'`, the backend JWT
  path requires one, and `/custody/fresh-auth` refuses upgraded rows).
  Password-login state-D sessions were already there; routing that is the
  architect's call.

## Architect re-review (2026-09-02) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` over `68fc1e91`, `c5846d1a`, `9fd22a7f`. The
implementation is sound and the review confirmed the substance independently: the
`wanted_def` deparse string is byte-exact on the deployed PostgreSQL 16.13 (probed
directly, and the migration suite passes 6/6), fail-toward-`'self'` is the
restrictive direction at all four consumers of the claim, both `upgraded_at`
writers satisfy the new CHECK, the migration test executes the shipped SQL rather
than a retyped copy, and the mint-parity test drives both logins against one real
row. Five items below; none of them is a defect in the shipped derivation logic.

1. **The canary's shape-refusal scan misses wrapped and alternate-access
   spellings.** `occurrencesOf` tests each pattern per line and `EPOCH_TERNARY_RE`
   is anchored with `[^;\n]*`, so a ternary split across lines, `account?.custody`,
   and `account['custody']` all pass. The case that matters is a NEW row-reading
   site that derives the claim inline and mints no JWT: it adds no key to the
   caller-set scan and no `jwt.sign` line for the mint-classification scan, so the
   shape scan is its only guard and that guard is line-scoped. This canary is the
   change's only durability mechanism, by its own docblock's reasoning, so the gap
   matters more here than it would elsewhere.
   Requirement: detection must survive ordinary authoring shapes. Mechanism is
   yours to choose. `agents/docs/solutions/conventions/source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md`
   states the rule, and both sibling canaries already solve it — the
   revocation-epoch canary via its value-joining helper plus a planted wrapped-line
   self-test, and the frontend password-factor resolver canary via `joinedStatement`.
   Whatever you pick, add the wrapped and alternate-access spellings to the planted
   self-tests so the fix is itself pinned.
   Also note for the completion write-up: the "verified by mutation" claim does not
   support what it was cited for. Both named mutations also remove the helper call,
   so the caller-set scan fires whether or not the shape scan works.

2. **Upgrade now widens the population matching the `/link` stuck-recovery
   lookup.** Writing `custody = 'self'` makes an upgraded row match
   `custody = 'self' AND verify_token IS NULL AND updated_at > NOW() - INTERVAL '1 hour'`,
   which bypasses the signup session-binding check. Before this change the row
   stayed `'light'` and matched neither stuck lookup. The task notes reach this and
   conclude no code change; the review agrees no escalation is constructible today
   (the bypass needs a fresh on-chain-owner signature and mints only a claim that
   grants nothing), but the diff still re-widens what migration 016 deliberately
   narrowed, and "no escalation today" is the same shape of argument this task
   exists to reject.
   Close the widening. Either tighten the `/link` lookup's own predicate or push the
   row out of the window; if you move `updated_at`, verify the choice against its
   other readers first — `registration-watch`'s completion sweep and the `/confirm`
   stuck lookup both read it, and moving it backward is not obviously free. If the
   investigation shows every available mechanism costs more than the widening, say
   so with the evidence and this item can close as documented-accepted.

3. **`CustodyRow`'s docblock justifies the loose type with a false statement.** It
   says the row types annotate the column as a `Date` in some places and an ISO
   string in others. All six call sites annotate `string | null`; none annotates
   `Date`. The widening is still right, for a better reason: the column is
   `TIMESTAMPTZ` and no `setTypeParser` is registered, so the driver returns a
   `Date` at runtime everywhere despite those annotations. State that instead.

4. **The comment edited in the ORCID login asserts a reachable row is
   unreachable.** It claims the SELECT only matches states A/B/C/D with `custody`
   set, and that the nullable annotation is not a defense against a currently
   reachable null row. The same commit disproves both: `custodyClaimFor`'s docblock
   documents that row, the ORCID-link UPDATE carries no custody predicate, and the
   login SELECT filters only on the ORCID and a non-null username. Drop the
   unreachability claim and state what the helper already says. Section 6.1 now
   enumerates this row as state G, so there is a documented state to name.

5. **Narrow the "cannot disagree" wording** in the helper docblock and the
   migration header. The guarantee holds for one row *read*. `POST /login` reads the
   row, awaits argon2, then derives from that snapshot, so a claim minted from a
   pre-upgrade read is backstopped by the per-route epoch re-reads, not by the claim
   itself. The window predates this change and needs no code fix; only the claim
   written about it is new.

Resolved architect-side, no action needed from you:

- The `[TODO Architect]` deploy item is fixed. `destructive_pending_migrations()`
  now has an `ADD CONSTRAINT` arm, so a constraint-adding migration forces the
  brief-stop carve-out, and the DDL-shape enumeration in `ARCHITECTURE.md` names
  constraint additions with migration 017 as the worked case. Five reviewers found
  this independently; it was the highest-ranked item in the review.
- Section 6.1 now carries the settings-email self-custody row as **state G**, with
  the `custody` and `verify_token` field rationales corrected and `upgraded_at`
  updated to name both writers and the new CHECK.

Not to act on:

- A proposal to add a structural presence guard for the `custody` key in
  `custodyClaimFor` was raised and then dropped under validation: the mint-parity
  suite you added already asserts a genuine light row reports `'light'` from all
  three readers against real Postgres, so a SELECT that drops the column is a red
  bar, not a silent pass. No guard needed.
- The absent-`upgraded_at` leniency is correct as documented. The CHECK's
  contrapositive means a non-`'self'` column implies no epoch, so the column alone
  now yields the right claim.

## Backend re-review signal (2026-09-06, working tree)

Round-2 hold items 1-5 landed. Nothing inside the hold block was edited; the
diff is the evidence. Every claim below was measured, not reasoned about: the
canary probes ran against copies of `backend/src` in a scratchpad (the repo was
never mutated), and the `/link` predicate was probed both at the SQL layer in a
rolled-back transaction and at the route layer through the real signed handler.

**1. Canary detection.** The shape scans now run against the STATEMENT a line
opens, not the line. New in
`tests/eslint/no-custody-claim-derivation-outside-helper.test.ts`:
`statementFrom` (joins downward to a terminator, stopping at a blank line, a
block opener, or a small cap, stepping over comment lines),
`statementOccurrences`, and `inlineDerivations` — the last is what both the
tree scan and the planted probes call, so a mangled pattern cannot leave the
probes passing vacuously. `EPOCH_TERNARY_RE` is bounded by the terminator
rather than the line ending; `COLUMN_COPY_RE` reaches the property through an
optional chain, a non-null assertion, a cast, an index, or a wrapped accessor,
with commas/colons/semicolons/quotes excluded so it cannot pair one object's
`custody:` key with a neighbour's `.custody`; `COLUMN_DESTRUCTURE_RE` refuses a
declaration destructure naming the column.

Proven gaps, each planted as a new non-minting reader in a copy of the tree and
each GREEN before the fix, RED after: wrapped ternary, `account?.custody`,
`account['custody']`, wrapped `custody:` / `account.custody`, `const { custody }
= rows[0]`, `account!.custody`, `(account as { custody: string }).custody`, and
a wrapped accessor (`custody: row` / `.custody,`). Whole-tree false positives
after the widening: zero.

Two false positives the widening created were caught and closed before landing,
both on real shapes rather than contrived ones. `if (account.upgraded_at) {`
followed by a body containing any `?` — a ternary error message, or a
`?? 'self'` nullish default in a log payload — reported the gate line as an
inline derivation. Those refusal gates are the most common `upgraded_at`
spelling in the tree (four in `routes/custody.ts`, three in `routes/recover.ts`),
and every one of them is one line away from tripping it. `BLOCK_OPENER_RE` stops
the join at a block opener, which is the one place the over-match direction is
deliberately reversed: there the false positive lands on a whole class of
legitimate gates rather than on a single odd line. The planted control now
carries a `??` in its body so it pins that boundary instead of passing because
no `?` was in reach. Note that the canary's pattern-level planted negative for
this shape stays green either way — a unit assertion on a single line cannot see
a gap that lives between lines, which is why the probes go through
`inlineDerivations` against synthetic files.

Residuals are pinned in the docblock rather than closed: derivation through an
intermediate binding, derivation as control flow, a differently-named
destination, an assignment destructure, a column named through a constant, the
join's blank-line stop and its line cap, and the over-match to expect first
(a multi-line call mentioning `upgraded_at` whose later lines carry a custody
ternary). A cast whose inline type lists more than one member is also not
matched; buying it would need a pattern that reads across property boundaries.

The mechanism is itself pinned: reverting the two patterns and the statement
join, keeping the new tests, turns exactly the two extended tests red.

**Correction to the earlier completion notes.** The architect is right that
"verified by mutation: re-inlining the ternary in the password login and copying
the raw column in the ORCID login each went red" does not support the shape
scan. Re-measured: each of those two mutations produces TWO failures, the
caller-set scan and the shape scan, because both also delete the helper call.
The mutations that isolate the shape scan produce exactly one failure and keep
the helper call in place: echoing the raw column into the ORCID login's response
alongside the derived claim, adding a second epoch ternary beside the password
login's helper call, and adding a new non-minting reader that derives the claim
inline. The last is the closest to the threat the scan exists for.

**2. `/link` stuck-recovery widening.** Closed in code, not documented-accepted.
The lookup gains
`AND (sessions_invalidated_at IS NULL OR sessions_invalidated_at < updated_at)`.

The discriminator is ORDER, not presence. The `/link` finalize stamps
`updated_at` and the upgrade epoch in one statement and revokes nothing; an
upgrade necessarily runs after the `/confirm` finalize that set `updated_at` and
stamps `sessions_invalidated_at` as it goes, so an upgraded row always carries a
revocation newer than its recency marker.

The bare `sessions_invalidated_at IS NULL` form was written first and rejected
under probing: `POST /api/auth/reset-request` selects by email alone and
`POST /api/auth/reset` by reset token alone, neither gating on `username`,
`verify_token`, or `upgraded_at`, and nothing ever writes the epoch back to
NULL. So a password reset at ANY point in a row's life — including during an
abandoned signup later resumed — permanently refuses that row's `/link`
recovery. The consolation does not exist: `/resume-signup` needs a `confirmed:`
verify_token, which a finalized row does not have, so the user would be left
with a finalized, permanently unaccredited account needing operator
reconciliation. The ordering form admits that row and still refuses the upgraded
one.

The timestamp-comparison family was also probed rather than dismissed. An exact
ordering on `upgraded_at` vs `updated_at` is not viable: they are written by the
SAME statement from two clocks (a Node `Date` and `NOW()`), measured at 0.5-2 ms
apart with the sign flipping inside an explicit transaction. The pair used here
is separated by a whole HTTP round trip plus a fresh-auth re-proof, so no clock
skew can invert it.

Measured at the SQL layer against real Postgres in a rolled-back transaction,
four seeded rows: shipped predicate admits all four including the upgraded one;
bare `IS NULL` admits only the never-revoked row; the ordering form admits the
never-revoked row and the reset-before-finalize row and refuses the upgraded one
and the revoked-after-finalize one.

Three specs in `tests/routes/signup-verify-stuck-recovery.test.ts`, all driving
the real `verifyHiveSignature` with a real signature: (e) upgraded-inside-window
refused, (f) genuinely-stuck row still resumes, (g) reset-before-finalize row
still resumes. Mutation-verified: removing the term reds (e); the bare `IS NULL`
form reds (g), which is the spec that separates the two candidate predicates.
Spec (f) is the over-tightening guard — the `/link` stuck path previously had
rejection coverage only, so a predicate that refused every row would have passed.

The invariant the predicate leans on is now pinned against the real route rather
than a fixture: `custody-upgrade.test.ts` already asserted the epoch write twice
(including the `reissuedAt` identity), so what was missing was the other half.
The State A row-shape block now captures `updated_at` before the upgrade and
asserts the handler left it byte-identical. `/confirm`'s lookup is deliberately
NOT given the same term: it already excludes an upgraded row via
`custody = 'light' AND posting_key_enc IS NOT NULL`, and adding the term there
would newly fail-close a real `/confirm` user who reset their password.

Comments corrected at all four sites that carried the "leaving `updated_at`
alone is what keeps the row out" half-truth: the `/link` query, the `/upgrade`
UPDATE, migration 017's header, and `STUCK_RECOVERY_WINDOW`'s own docblock.

Severity note for the record, since it prices the trade: the widening bought a
caller who already holds the account's posting key a bearer JWT they can mint
anyway through `POST /api/auth/session`, and the re-broadcast is HAF-dedup-probed
and sanction-gated. The fix is one SQL term with no false negative, which is
cheaper than the acceptance note would have been.

**3. `CustodyRow` docblock.** The false statement is gone. Verified
independently: all six calling sites annotate `upgraded_at` as `string | null`
and none annotates `Date` (a `Date | null` mutation errors TS2345 at exactly
those six); `001_schema.sql` declares the column `TIMESTAMPTZ` and no
`ALTER COLUMN` touches it; no `setTypeParser` is registered anywhere; a
read-only probe against the running database confirms field OID 1184,
`pg.types.getTypeParser(1184).name === 'parseDate'`, and `value instanceof Date`.
The docblock now says that: declared shape and runtime shape differ, the union
spans both so no caller needs a cast asserting something the value does not
satisfy, and only nullness is read.

**4. The ORCID login comments.** Both blocks rewritten. The unreachability
claim is gone and state G is named with its § 6.1 anchor, along with the route
that creates the row. The "finalized (states A/B/C/D)" sentence is not replaced
with a new closed enumeration — that shape is what went stale in the first
place; the comment states the invariant (a finalized row's `custody` can be
NULL, G is that row, the helper resolves it to `'self'`) and leaves the
population to § 6.1. The second over-claim inside "finalized" is closed too:
the SELECT reads neither `verify_token` nor `expires_at`, so a state-G row
matches whether or not its settings-registered email is verified.

Two more comments in the same file asserted the same falsehood and are fixed
with it: the `// Update orcid column in accounts (if light account row exists)`
pair sits on the predicate-free `UPDATE accounts SET orcid = $1 WHERE username =
$2` that is the link in the chain making a state-G row reachable from the login
SELECT, and a state-G row is precisely not a light account row. Its sibling warn
message ("row may not exist for self-custody user") is corrected the same way.

**5. "Cannot disagree" wording.** Narrowed at the helper docblock, the ORCID
login comment, migration 017's header, and the canary docblock — the guarantee
is now stated as per-read, not per-account, everywhere it appears. The
read/derive window was traced per handler: the password login awaits
`argon2.verify` between its SELECT and the derive and both recovery reissues
await a factor proof and their own UPDATE, so those three have a window; the
ORCID login and the two settings handlers derive in the same tick as their read.

One thing the drafted wording got wrong and that is NOT in the diff: an earlier
version claimed a stale token "is minted after the upgrade's revocation epoch
and so survives" the check. The middleware compares
`payload.iat <= invalidatedAtSec && payload.reissuedAt !== invalidatedAtMs` with
`iat` at second granularity, and a login mint carries no `reissuedAt`, so a
stale token minted in the same integer second as the upgrade IS revoked; only
one landing in a later second survives, and it is refused at the acting route
instead. The shipped text says that. Landing the original would have put two
files in this repo asserting contradictory revocation semantics, since
`verifyHiveSignature` documents the same mechanism in the opposite direction.

The related question the architect's framing raises was checked and found clean:
no route trusts the light claim alone. The five consumers of `req.hiveCustody`
are the four `routes/custody.ts` gates, each of which re-reads `upgraded_at`,
and `POST /api/auth/session`, whose refresh runs `verifyHiveSignature` and so
cannot launder a token the epoch already revoked. No § 6.5 invariant #1
violation.

### Verification

`npm run typecheck` (both projects) and `npm run lint` clean; the one lint
warning is a pre-existing unused-disable in `lib/author-supersession.ts`, an
untouched file. Targeted suites, `--retry=0` against real Postgres/Redis:
`tests/eslint/` + `tests/lib/custody-claim.test.ts` + `tests/migrations/` +
`custody-upgrade.test.ts` = 12 files / 146 tests green;
`custody-claim-mint-parity`, `signup-verify`, `signup-verify-session-binding`,
`signup-verify-stuck-recovery`, `settings`, `orcid`, `recover` = 7 files / 201
tests green. `signup-verify-stuck-recovery.test.ts` ran three consecutive times
with `--retry=0` to confirm the three new specs are not order- or
limiter-sensitive.

### Surfaced, not acted on (needs triage)

Found while establishing item 4's facts; each is the same stale-model class but
outside what the hold items ask for, so nothing was changed:

- `jobs/registration-watch.ts` has a BEHAVIOR consequence, not just a comment
  one: `collectSignupStarted` has no state predicate and `collectCompleted`
  filters on `verify_token IS NULL AND username IS NOT NULL`, so a Keychain
  user who registers an email through settings fires "Signup started" and
  "Registration completed" operator webhooks for an account that never signed
  up. Its module docblock's event table and `collectCompleted`'s docblock both
  assert the A/B/C/D enumeration.
- The same docblock claims `accounts.updated_at` is "bumped by later password,
  ORCID, and custody writes too". False today: the only writers are the two
  signup-verify finalizes plus the column DEFAULT. This is also exactly why
  moving `updated_at` at upgrade was rejected as a mechanism for item 2 — the
  cursor only moves forward, so a row shoved behind it loses its completion
  event permanently.
- `routes/settings.ts` `POST /set-password`: "today only the ORCID-path
  signup/recover leaves password_hash = NULL" is falsified by state G, whose
  row is created with no password. This is the comment governing whether a G
  row can acquire one.
- `routes/orcid.ts` `/start` and `lib/fresh-auth.ts` (x2) and
  `routes/settings.ts` restate § 6.3's `A/B/C/D → [no row]` deletion exit.
  § 6.3 is architect-owned and has no state-G transitions at all — no entry
  edge for it and no `G → G` ORCID link — so the doc moves first.
- `POST /api/auth/reset` can set a `password_hash` on a pre-finalize row with
  no state gate at all. Out of scope here, but it is the mechanism behind the
  false negative that killed the bare `IS NULL` predicate.

**[TODO Architect]** § 6.1's state-F "Reached by" cell cites `auth.ts:460-490`,
a source line-number anchor of the kind the repo's comment-anchor convention
forbids. The `.githooks/pre-commit` gate does not cover `agents/docs/`, so
nothing catches it mechanically.

## Architect re-review (2026-09-06, round 3) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` over `65ab1c74` only (the round-2 commits were
reviewed in their own pass). Ten reviewers plus a validation batch. All five
round-2 items are substantively addressed and the review found no defect in the
shipped derivation logic, the migration, or the security posture: security,
testing and data-migration each returned clean, testing ran the changed suites
against real Postgres/Redis (10/10 stuck-recovery, 7/7 canary), and both the
adversarial reviewer and the validator executed the canary against synthetic
sources in scratch copies rather than reading it. The measured claims in the
signal block held up under independent re-checking, including the whole-tree
zero-false-positive result and the corrected mutation attribution.

Six items below. Item 1 is a behaviour change; the rest are corrections to
prose or to one loop bound.

1. **The new `/link` term also refuses a genuinely stuck row.** The predicate
   excludes any row whose revocation postdates its recency marker, and a
   password reset is such a revocation: `POST /api/auth/reset` selects by reset
   token alone, with no `custody` / `verify_token` / `upgraded_at` / `username`
   gate, and stamps `sessions_invalidated_at = NOW()` without touching
   `updated_at`. A user whose `/link` finalize landed and whose accreditation
   broadcast failed, who then resets their password inside the hour, loses the
   only self-service path they have: `/resume-signup` needs a `confirmed:`
   verify_token that a finalized row no longer carries, so what remains is
   operator reconciliation. Three reviewers found this independently and a
   fourth corroborated it. It is a narrower instance of the strand the bare
   `IS NULL` form was rejected for, and "resets their password while locked
   out" is close to the first thing a confused user tries.
   Requirement: close it by discriminating on the epoch the finalize itself
   writes. Change the `/link` finalize's `upgraded_at = $2` to
   `upgraded_at = NOW()` (the `const now = new Date()` above it feeds only that
   parameter and becomes dead), then replace the revocation term with
   `AND upgraded_at <= updated_at`. An upgrade stamps its epoch a whole HTTP
   round trip plus a fresh-auth re-proof after the `/confirm` finalize that set
   `updated_at`, so the upgraded row is still refused; a `/link` finalize writes
   both stamps from one clock in one statement, so a stuck row is admitted
   whatever its revocation history. Note this also retires a cross-clock
   comparison that two reviewers filed as a residual risk: today the predicate
   compares a Node `Date` against a Postgres `NOW()` and is safe only because a
   round trip separates them, whereas both sides of the new comparison are
   `NOW()`. Do NOT ship the bare `upgraded_at <= updated_at` without the
   finalize change: that is the two-clock comparison your own round-2 probe
   measured flipping sign at 0.5-2 ms, and it would refuse stuck rows
   non-deterministically. Re-pin specs (e)/(f)/(g) against the new predicate and
   add the missing quadrant: a stuck `/link` row revoked AFTER its finalize,
   asserted to still resume. That spec is what separates the shipped rule from
   the one being replaced.

2. **`custody-claim.ts`'s new enumeration is universal and incomplete.** It says
   every route that acts on a light claim re-reads `upgraded_at` and names four.
   `POST /api/auth/session` is a fifth consumer: `verifyHiveSignature` sets
   `req.hiveCustody` from the token and that handler re-mints the claim into a
   fresh 24h JWT with a new `iat`, reading `sessions_invalidated_at` and never
   `upgraded_at`. Not exploitable, and the reviewers who raised it agree: the
   four acting routes re-read, and the keys such a claim would unlock were
   nulled in the statement that stamped the epoch. The defect is that a sentence
   written to satisfy round-2 item 5 states a universal that is false, in the
   file where three rounds have gone into making claims exact. Name the
   claim-carrying site and say why it grants nothing.

3. **Five bare positional anchors added by this commit.** The convention makes
   an `above`/`below` citation durable only when a stable name rides along in
   the same container, and the `.githooks/pre-commit` positional arm misses all
   five because its noun list has no "finalize", "scan", "join", "negative" or
   "probe". In `routes/signup-verify.ts`, "The finalize below" points about 53
   lines forward in a file with two finalizes, in a sentence that names its
   `/confirm` sibling explicitly. In the canary test, "the scan below", "The
   join below", "the planted negatives below" and "the planted probes below"
   each cross a container boundary, the furthest by roughly 150 lines. Every
   target already has a name in the file: the `/link` finalize, `statementFrom`,
   `inlineDerivations`, and the `it()` block titled "a derivation wrapped,
   optional-chained, bracketed, or destructured is still refused". Note item 1
   rewrites the first of these paragraphs anyway.

4. **`COLUMN_COPY_RE`'s docblock presents its residual list as complete and it
   is not.** The paragraph explains the run is bounded by property-separator
   punctuation and names a multi-member inline cast as the accepted residual.
   Executed against the shipped pattern, `const custody = helper(row).custody;`
   matches while `custody: someHelper(row, options).custody,`,
   `const custody = pickAccount(rows, username).custody;` and
   `(row as Record<string, string>).custody` do not: any comma nested inside
   call arguments or generic type arguments stops the run. Name that class.
   Do NOT widen the pattern to buy it. The comma exclusion is what stops the
   scan pairing one object's `custody:` key with a neighbour's `.custody`, and
   you already closed two real false positives on this scan this round.

5. **A superseded docblock was left stacked above its replacement.**
   `seedStaleSelfCustodyAccount` now carries two consecutive blocks; only the
   second is the JSDoc. The surviving first one says the fixture seeds a row
   outside the recovery window that the lookup "must reject", which is false for
   the majority of its current call sites: specs (f) and (g) call it with
   `staleInterval: '0 seconds'` precisely to seed rows that must be admitted.
   Delete it; the block below already documents the default and all three
   orderings.

6. **`statementFrom`'s comment skip spends the line cap.** The loop is bounded
   by `j <= lineIndex + 4` and `continue`s past a comment line without joining
   it, but `j` is the cap variable, so prose between two halves of an expression
   costs budget. Executed: a wrapped ternary with four comment lines inside it
   returns only the opening line and escapes `EPOCH_TERNARY_RE`, while the same
   shape without comments matches. The docblock's "neither breaks the join nor
   contributes text to it" is half true and reads as fully true. Count joined
   lines rather than scanned lines, and plant the comment-interleaved shape so
   the fix is pinned. Fixing this is smaller than the caveat documenting it
   would be.

Raised and rejected, no action needed from you:

- A finding that `statementFrom` is a third line-wrap joiner that should be
  hoisted into `tests/support/enclosing-symbol.ts` was dropped at validation.
  That module exports no join helper, `valueTextAfterKey` is not a joiner (it
  slices after a key and returns the next non-blank line, with no accumulation
  or stop rules), and the frontend's `joinedStatement` sits in a tree that
  cannot import a backend helper and terminates differently. Three local
  joiners with three termination rules is the established pattern here, not a
  bypassed abstraction. The learnings pass reached the same verdict
  independently.
- The six-way restatement of the revocation-ordering invariant was raised as a
  drift risk. Not actioned: item 1 rewrites most of those sites anyway, so a
  consolidation pass now would collide with it. Revisit at re-review if it
  still reads badly.

Architect-side, already done or deferred:

- § 6.1's state-F "Reached by" cell no longer cites `auth.ts:460-490`; it names
  the signup handler's `verifiedOrcid` branch. Fixed at `ff4ea5b9`.
- The `orcid.md` `[TODO Architect]` bullet above now names state G alongside
  state D, since both reach that response and both resolve to `'self'`.
- **[TODO Architect]** § 6.1/§ 6.7 must record that the `/link` Option C lookup
  conjoins a timestamp ordering with the recency guard, and that the invariant
  depends on the upgrade never bumping `updated_at`. Deliberately deferred to
  archive rather than written now: item 1 replaces the discriminator, so writing
  it today would document a predicate with a one-round shelf life.
- **[TODO Architect]** `api-contracts/auth.md` does not describe the `/link`
  username-keyed stuck-recovery branch at all, though it bypasses the signup
  session-binding check and its predicate is now four terms. Deferred to archive
  for the same reason as the item above.

## Backend re-review signal (2026-09-06, working tree)

Round-3 hold items 1-6 landed. Nothing inside the hold block was edited. Every
claim below was measured: predicates were executed against real Postgres in
rolled-back transactions, regexes were executed in node against literal strings,
and each behavioural change was mutation-probed by editing the shipped code and
re-running the suite rather than by reasoning about it.

**1. The `/link` term refusing a genuinely stuck row.** Implemented exactly as
ordered. The finalize writes `upgraded_at = NOW()` (bind renumbered, `WHERE id =
$2`, `const now` deleted) and the lookup term is `AND upgraded_at <= updated_at`.

Four-quadrant measurement against real Postgres, rows shaped like the seed
helper. Old predicate admits {f, g}; new admits {f, g, h}. (e) refused by both.
Quadrant (h), a stuck row revoked after its finalize, is the discriminator: old
refuses, new admits.

Three mutation probes on the shipped route, each producing exactly the intended
red set: deleting the term reds (e) alone; restoring the revocation-ordering
form reds (h) alone; the bare `sessions_invalidated_at IS NULL` form reds (g)
and (h). So (e) guards deletion, (g) guards the first rejected candidate, (h)
guards the second, and (f) remains the over-tightening guard.

The `NOW()` half is load-bearing rather than cosmetic, and it now has its own
pin. Spec (h) and its siblings all drive the STUCK path, which skips the
finalize entirely (`if (!resumeStuck)`), so nothing in the stuck-recovery file
could have caught a regression to a Node-clock epoch. The `/link`
broadcast-failure spec in `signup-verify.test.ts` does run the finalize, so it
now asserts the row it leaves: `custody = 'self'`, epoch set, and
`upgraded_at.getTime() === updated_at.getTime()`. Mutation-verified: restoring
`upgraded_at = $2` with a Node `Date` reds it (1788713011979 vs ...980) and reds
nothing else.

One correction to the hold item's supporting argument, since the comment states
the mechanism. `NOW()` is `transaction_timestamp()`, not statement time; the
current Node-`Date` form holds only because this UPDATE runs in autocommit, so
the transaction starts after the timestamp is taken. The comments say that
rather than the statement-time version. A first probe reported the Node form
inverting "10/10 at -5.7 to -44.7 ms" under a transaction; that number was an
artifact of running N trials inside one `BEGIN` and is not quoted anywhere in
the diff. The structural point survives: open a transaction before the Node
timestamp and the comparison inverts.

`/confirm` deliberately did NOT get the term, and the reason is stronger than
the task recorded: `custody = 'light'` already implies `upgraded_at IS NULL` at
the SCHEMA layer via the CHECK, so the term there would evaluate NULL for every
candidate row and refuse all of them.

**2. The false universal in `custody-claim.ts`.** Named `POST /api/auth/session`
and said why it grants nothing. Two things the item did not ask for and the
review should know about:

The identical false universal was duplicated verbatim in `routes/orcid.ts`'s
`handleLogin` comment. Fixing only `custody-claim.ts` would have left the same
wrong sentence standing one file away, which is the failure mode the item exists
to close, so both landed.

The first drafted replacement said `/session` re-mints "reading no `accounts`
row at all". Measured false at the ROUTE level: `verifyHiveSignature` reads
`sessions_invalidated_at` on every JWT request. Only the HANDLER reads nothing.
Shipping that would have reproduced the exact handler-versus-route conflation
this item raises. The shipped text scopes it to the handler and names what the
middleware does read. "Grants nothing" is likewise qualified to SERVER-SIDE,
because the response returns the copied value to the client.

Verified not exploitable rather than assumed: the five readers of
`req.hiveCustody` are the four custody-route gates, each re-reading
`upgraded_at`, plus `/session`, which reaches no signing path. No § 6.5
invariant #1 violation.

**3. Positional anchors.** All five named anchors replaced with the stable names
their targets already carry: the `/link` finalize, `statementOccurrences`,
`statementFrom`, the block-opener negative controls, and the wrapped-derivation
probes. A SIXTH the item did not name was found in the same commit's diff and
fixed with them: "the exclusion above" in spec (f), pointing 26 lines up at the
(e) block, now "the upgraded-inside-window exclusion". The two `above` mentions
remaining in the diff are not location citations (one describes the algorithm's
spatial relationship to a docblock, one is prose inside a synthetic fixture
string). Confirmed by executing the hook's own arm: it matches none of the
twelve above/below citations the round-2 commit added, so reading is the only
check here and the gate proves nothing either way.

**4. `COLUMN_COPY_RE`'s residual class.** Named, and it is wider than the item's
phrasing on two axes. It is not commas: the run is a WHITELIST of word
characters, whitespace and `$ ? ! . [ ] { } < > ( )`, so nineteen characters
break it identically, including a quote, a colon, an `=` and every arithmetic
operator. `helper('x').custody` and `rows[i + 1].custody` miss with no comma
present. And it is not "in call arguments or generic type arguments": position
in the span is irrelevant, `rows.map((r) => r)[0].custody` misses too. The four
strings the item cites all behave exactly as it says; the sentence was
incomplete rather than wrong, and naming the true class is what was ordered.

Two further corrections, both to text drafted for this fix rather than to the
item. A first draft said the whitelist costs "every column read reached through
an expression carrying one of those characters" -- itself a false universal, in
a paragraph being rewritten for stating one, because the run RESTARTS at each
destination and a nearer `custody:` can still reach the read. And the shipped
docblock's own residual, which round 2 described as a cast of more than one
member, is bounded by POSITION not count: `as { a: string; b: string; custody:
string }` matches, `as { custody: string; email: string }` does not. Both are
now stated that way and pinned by new planted probes.

The pattern was NOT widened. The exclusion's value is confirmed on a constructed
shape rather than on the tree (every widened variant reports zero sites across
`src`, so the tree demonstrates nothing): `logger.info({ custody: claim },
row.custody)` is a non-match today and matches the moment a comma is admitted.
That probe is now planted so the next reader does not conclude the exclusion is
dead weight.

**5. The stacked docblock.** The superseded block is deleted. The survivor was
also re-pinned, since the item's discriminator changed under item 1: it now
documents that both stamps come from one `NOW()`, that `upgradedAt` overrides
the epoch alone, and that `sessionsInvalidatedAt` seeds a column the shipped
lookup does not read, kept so the specs can pin that against the two rejected
predicates.

**6. `statementFrom`'s comment budget.** Fixed by counting joined lines. The bug
was worse than the item states: because neither half of a split derivation
carries the whole pattern, four interleaved comment lines removed the offender
from EVERY scan, not just from the line it opened. Measured on two shapes,
including the wrapped-accessor spelling the file already plants a probe for.
The new probe is mutation-verified: reverting the loop bound to the old form
reds it and nothing else.

One deviation from the literal order, flagged rather than buried. Counting
joined lines alone leaves the WALK unbounded, and this tree has comment runs
long enough for that to matter: `try {` in `routes/profile.ts` reaches 48 lines
to gather 4 joined ones, stepping over a 43-line comment block to swallow an
unrelated statement, and `hafsql.ts` holds a 160-line run. So a second cap
bounds the walk at the number `mintPayload` already uses. It is not free and the
docblock says so: it costs the far tail of the same shape, letting a derivation
split by twelve or more comment lines escape where the old cap escaped at four.
Both variants report zero sites across `src`, so the choice is between two
residuals rather than between a cost and none. If the architect prefers no
residual over no runaway, dropping `STATEMENT_SCAN_CAP` is a one-line change and
was measured clean on the current tree.

A second control was drafted for this item and then dropped: prose between a
refusal gate and its body changes no verdict, because the gate line matches
`BLOCK_OPENER_RE` and `statementFrom` returns before any join loop runs. It
would have been a duplicate of the control already there.

### Also landed, not asked for

- `signup-verify-session-binding.test.ts`'s JWT-replay seed produced `(custody =
  'self', upgraded_at IS NULL)`, a pairing no writer in `src` or `migrations`
  creates. Under the new term that row is refused even with a signature, so the
  fixture's comment ("exactly the row the stuck-recovery fallback is designed to
  recover") would have become false. The seed now carries both stamps.
- A fifth and later sixth old-rationale comment site beyond the four the round-2
  signal named: `custody-upgrade.test.ts`'s State A row-shape block, and the
  stuck-recovery file's header bullets, describe comment and describe TITLE
  (test output, not a comment). All re-pinned to the epoch ordering.

### Needs architect triage

The new term is strictly tighter on `(custody = 'self', upgraded_at IS NULL)`:
the old predicate admitted it, the new one evaluates NULL and refuses it. No
writer in `src` or `migrations` produces that pairing, § 6.1 does not enumerate
it, and both live databases hold zero such rows, so it ships as a documented
tightening stated in the `/link` comment rather than as a defended shape. It is
NOT covered by a spec. The one-directional CHECK permits it, so a future writer
setting `custody = 'self'` without an epoch would silently break `/link` stuck
recovery. Whether that warrants a second CHECK is an architect call; a
defensive `(upgraded_at IS NULL OR ...)` in the lookup would be the wrong fix,
since it re-admits a shape the state machine does not define.

### Verification

`npm run typecheck` (both projects) and `npm run lint` clean; the one lint
warning is the pre-existing unused-disable in `lib/author-supersession.ts`, an
untouched file.

Targeted suites, `--retry=0` against real Postgres/Redis: `tests/eslint/` +
`tests/lib/custody-claim.test.ts` + `tests/migrations/` + `custody-upgrade` +
`custody-claim-mint-parity` + `signup-verify` + `signup-verify-stuck-recovery` =
15 files / 173 tests green. `signup-verify-session-binding`, `settings`,
`orcid`, `recover` = 4 files / 175 tests green. `signup-verify-stuck-recovery`
ran three consecutive times to confirm spec (h) is not order- or
limiter-sensitive.

Two failures appeared only when nine signup/settings/orcid/recover files ran in
ONE invocation (a rate-limit bucket and an ORCID binding-guard spec). Confirmed
pre-existing, not regressions: the same nine-file batch executed in a detached
worktree at untouched HEAD `a358bb16` failed ELEVEN tests across four files, and
`signup-verify-orcid-binding-guard` alone fails three there against one in this
tree. These are the known shared-fixture and limiter collisions; every file
passes in isolation.

## Architect re-review (2026-09-06, round 4) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` over `f0effeb1` only (the round-3 commits were
reviewed in their own pass). Nine reviewers plus a seven-finding validation
batch. No cross-model pass: no different-family CLI is installed on this host,
so the in-process adversarial reviewer took that lens.

**The round-3 item-1 behaviour change is clean and stays.** Five reviewers
attacked it independently and none broke it. The upgraded-account exclusion
holds, and two reviewers showed the alternative routes to a post-upgrade
`updated_at` bump are structurally closed rather than merely absent: a
`/confirm` finalize on an epoch-carrying row is refused by the
`accounts_upgraded_implies_self_custody` CHECK, and the `/link` finalize is
unreachable for a row that already carries a username because the duplicate
check returns 409 first. The four-quadrant claims reproduce against real
Postgres exactly as the signal reported them, including which mutation reds
which quadrant. The migration's back-fill ordering claim holds, and the CHECK's
deparsed definition was verified live against the running database. One
correction in your favour: the `NOW()` equality is stronger than the comment
claims, because `transaction_timestamp()` is frozen per transaction, so both
stamps match inside an explicit transaction too, not only under autocommit.

Three items below. All are comment or probe work; none touches the predicate,
the finalize, or the migration.

1. **`orcid.ts` never got the scoping fix its sibling did.** Round-3 item 2 was
   about a sentence stating a false universal. You correctly widened the fix to
   both files, then hardened only one of them. `custody-claim.ts` says the
   handler reads no `accounts` row and names the row `verifyHiveSignature` reads
   for `sessions_invalidated_at`. The `orcid.ts` copy still says `POST
   /api/auth/session` "copies a claim forward without reading a row", full stop,
   and that route runs `verifyHiveSignature`, which selects
   `sessions_invalidated_at` on the JWT path. Your own signal block records
   catching this exact handler-versus-route conflation in the first draft and
   scoping it; the scoping did not reach the second file.
   Requirement: scope the `orcid.ts` clause to the handler and name the
   middleware's read, matching the wording you already wrote in
   `custody-claim.ts`. The conclusion it supports (reaches no signing path) is
   correct and independently verified; only the "without reading a row" clause
   is false.

2. **A negative-control comment counts to its target instead of naming it.** In
   the derivation canary, "The third of these is the shape that shows the
   exclusion earning its keep" lands on a SQL-fragment control that carries no
   `.custody` read at all. The shape the sentence describes is the
   `logger.info({ custody: claim }, row.custody)` control. Two defects: the
   pointer is wrong today, and an ordinal into a list is the positional-anchor
   rot the convention forbids, introduced by the same commit that removed six
   other instances. The `.githooks/pre-commit` positional arm does not catch it
   because "these" is not in its structural-noun list, so reading is the only
   check here.
   Requirement: name the control instead of counting to it. Do not substitute a
   different positional form, and do not add an ordinal anywhere else in the
   probe blocks this commit touched.

3. **`STATEMENT_SCAN_CAP` is unpinned at every value it could hold.** You
   flagged the cap as a deviation from the literal order and asked for an
   architect call. The call is: keep it. The runaway you measured is real, and
   the 48-line reach in `routes/profile.ts` is the kind of thing that produces a
   false positive nobody can explain later. But the constant currently has no
   observable effect: replaying the tree scan over every file in `backend/src`
   yields zero offender sites at every cap from 4 to unbounded, and the deepest
   planted probe needs a walk of only 6, so the cap can be set to any value at
   or above 6, or deleted outright, with the whole file still green. Both the
   documented cost and the documented benefit are prose-only. That is the same
   shape round-3 item 6 held on: a budget whose behaviour nothing pinned.
   Requirement: plant the boundary in both directions. Eleven interleaved
   comment lines in the split-derivation shape asserted CAUGHT, twelve asserted
   MISSED. While you are there, extract the literal `12` that
   `STATEMENT_SCAN_CAP` and `mintPayload`'s loop bound now duplicate, so the
   docblock's claim that they are the same runaway bound is enforced rather than
   maintained by hand.

Raised and rejected, no action needed from you:

- A finding that `COLUMN_COPY_RE`'s docblock presents its residual list as
  complete was dropped at validation. The two shapes it cited do miss
  (`const custody: CustodyClaim = row.custody` and
  `(row as AccountRow | null)?.custody`, both executed rather than reasoned
  about), but the docblock states the governing character rule that predicts
  them and closes by saying the spellings are illustrative and the rule, not the
  list, is what bounds the residual. The paragraph is accurate as written. The
  two misses are recorded as a known residual; neither occurs in `backend/src`,
  and closing them was measured to cost nothing and to admit no comma, so it
  stays available if the guard is ever tightened.
- The restatement of the epoch-ordering invariant across nine-plus sites was
  raised again as a drift risk. Not actioned, and the round-3 deferral is now
  closed rather than rolled forward: the sites are not verbatim duplicates, each
  explains the invariant from its own writer's side, and trimming audited prose
  in these particular files is the highest-risk edit available on a task whose
  last three rounds all found false statements in exactly that prose. The
  canonical statement goes in the architecture doc instead. Do not consolidate.
- The trade-off paragraph's justification is weaker than the true one: a
  posting-key holder can already mint an equivalent self-custody session at
  `POST /api/auth/session`, whose signature path applies no revocation check, so
  admitting the revoked row grants no session they could not already obtain, and
  the residual the widening genuinely adds is the accreditation broadcast and
  reputation seed this branch fires. Left alone deliberately: the paragraph is
  not false, and rewriting it would reopen a passage three rounds have settled.
- A sub-second dead-token window is newly reachable through quadrant (h): a
  reset-then-retry inside one integer second returns 200 with a token that 401s
  on first use. The middleware already documents this class as an accepted
  self-healing residual and the cure is identical, so it is noted, not filed.

Architect-side, already done or deferred:

- **[TODO Architect]** The two deferred § 6.1 / § 6.7 doc items carry forward to
  archive, and their round-3 blocking reason is now spent: they were held
  because item 1 was about to replace the discriminator, and it has. At archive
  they must record that the `/link` lookup conjoins an epoch ordering with the
  recency guard, that the invariant depends on the upgrade never bumping
  `updated_at`, and that `(custody = 'self', upgraded_at IS NULL)` is
  CHECK-permitted, produced by no writer, and treated as refused. Doc-only: no
  symmetric CHECK, and no defensive `OR` in the lookup, which would re-admit a
  shape the state machine does not define. § 6.7 also carries the canonical
  statement of the epoch-ordering invariant that closes the consolidation
  question above.
- **[TODO Architect]** `api-contracts/auth.md` still does not describe the
  `/link` username-keyed stuck-recovery branch. Also deferred to archive.
- The dependency on `accounts.updated_at` having exactly two writers is real,
  currently true, and mechanically unguarded. Filed as its own task
  (`backend-accounts-updated-at-writer-canary`) rather than held here, since a
  new tree-wide guard is separate work from this diff. Nothing for you to do on
  this task.

## Backend re-review signal (2026-09-08, `a24aae5a`)

Round-4 hold items 1-3 landed. Nothing inside the hold block was edited.
Every claim below was executed rather than reasoned: regex variants ran in
node against the literal strings, the walk boundary ran against the shipped
`statementFrom` and `mintPayload` inside the real test file, and each
mutation was applied to the shipped file and re-run, with the file restored
from a scratchpad copy and hash-checked afterwards (no git restore touched
the tree). A four-lens refuter pass over the staged diff (read-only, with
every executable claim re-run in scratch copies) ran before the commit; what
it changed is called out where it applies.

**1. `orcid.ts` scoping.** The clause now says: its handler reads no
`accounts` row, and the row its request does read is the one
`verifyHiveSignature` reads for `sessions_invalidated_at`, a revocation check
that never looks at `upgraded_at`. Verified against the code before writing
it: `POST /session` is `verifyHiveSignature, sessionLimiter, handler`; the
handler copies `req.hiveCustody` and issues no query; the middleware's JWT
branch runs `SELECT sessions_invalidated_at FROM accounts WHERE username =
$1` and nothing on that path reads `upgraded_at`. The wording mirrors the
`custody-claim.ts` paragraph.

**2. The negative-control comment.** "The third of these" is replaced by the
control's own text, `logger.info({ custody: claim }, row.custody)`. No
ordinal or positional form was substituted; the remaining first/second
mentions in the file are ordinary prose ("a second derivation", "the first
closing paren"), none an index into a list.

Measuring the four controls to write the replacement surfaced a wrong count
one paragraph up, in the `COLUMN_COPY_RE` docblock: "the two planted
negatives that pin this boundary need a comma, a colon AND a quote admitted
together before either fires". Executed against the shipped pattern and the
widened variants (comma; comma+colon; comma+quote; colon+quote; all three):
only the `hasPassword: row.custody` control fires, and only under all three.
The `custodyClaimFor(row)` and `custody = $1` controls carry no `.custody`
read for the pattern's mandatory tail, so no widening of the run can fire
them. The docblock now names the one control; the test comment states that
the other two carry no column read. Flagged as a fix outside the item's
letter: a false count in the paragraph adjacent to the one the item names,
of the class this task keeps producing.

**3. `STATEMENT_SCAN_CAP` pinned, literal extracted.** Both caps are hoisted
above `mintPayload`, whose loop bound now reads `STATEMENT_SCAN_CAP`. The
split-derivation shape with eleven interleaved comment lines is asserted
caught and with twelve missed, as literals, so the pin is on the VALUE.

Mutations on the shipped file, each red set exactly as listed and nothing
else:

- cap 11: the eleven-line probe alone.
- cap 13: the twelve-line probe alone.
- cap term deleted from `statementFrom`: the twelve-line probe alone. Two
  sites are reported for the one planted derivation, from its `const
  custody` line and from the synthetic `router.get(...) => {` line above it,
  which is not a block opener under `BLOCK_OPENER_RE` because `=>` sits
  between the `)` and the `{`; that is the multi-line reporting
  `statementOccurrences` documents, not a second offender.
- `mintPayload` bound re-inlined as literal 12, constant unchanged: nothing.

That last result is the gap the extraction alone leaves: nothing detected a
re-inlined literal, so "one constant" was unenforced on its second user.
Also landed, not asked for: a `classifyMint` pair asserting that a claim key
exactly `STATEMENT_SCAN_CAP` lines below the mint is read and one line
further is not, written relative to the constant rather than as a count.
The split probes pin the value; this pair pins that `mintPayload` still reads
it. Measured: with the literal re-inlined AND the constant moved to 13 AND
the split probes shifted to 12/13, the mint pair goes red alone. A first
draft of that pair used literals 12/13 and its comment claimed it would red
"the moment the constant moves"; measured false (the pair pinned the count,
not the constant, and the drift case stayed green), rewritten before commit.

One deviation from the hold's framing, in prose only. The hold calls the two
bounds "the same runaway bound", and my first draft of the hoisted docblock
said both walks face a walk across a long comment run. The refuter pass
falsified that for `mintPayload` and I confirmed it: `statementFrom` steps
over comment lines for free, so its unbounded walk crosses a long comment
run; `mintPayload` never skips comment lines and counts every line's parens,
so a balanced comment run of any length never carries it past its own
closing paren, and its runaway is a counted paren that stays unclosed (a `(`
in a comment or a string). Executed: 40 balanced comment lines inside an
argument list, unbounded walk stops at `);`; a single `// see foo(` line,
cap 12 and unbounded both swallow the next handler. Across `backend/src`,
none of the eight `jwt.sign` sites change their payload between cap 12 and
unbounded. What the two walks share is the BOUND, and the shipped docblock
states each walk's runaway on its own.

The refuter pass also raised the split-derivation probe comment opening with
"The far tail of that shape", a cross-block anaphor. It was refuted as
restated within its own paragraph, and reworded anyway so the sentence names
the shape it opens with.

### Verification

`npm run typecheck` (both projects) and `npm run lint` clean; the one lint
warning is the pre-existing unused-disable in `lib/author-supersession.ts`.
`tests/eslint/` = 9 files / 118 tests green, `--retry=0`, real
Postgres/Redis. `.githooks/pre-commit` exit 0 on the staged diff. No
behaviour changed in `src` (one comment in `orcid.ts`), so no route suite
was re-run; the `no-stale-comment-anchors` canary covered that edit.

## Architect re-review (2026-09-08, round 5) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` over `a24aae5a` only (the round-4 commits were
reviewed in their own pass). Six reviewers plus a three-finding validation
batch. No cross-model pass: no different-family CLI is installed on this host,
so the in-process adversarial reviewer took that lens.

**All three round-4 hold items landed and are verified.** Item 1's four
security assertions about `POST /api/auth/session` were independently
confirmed three times over: the route is `verifyHiveSignature, sessionLimiter,
handler`, the handler reads no `accounts` row, the JWT branch issues exactly
`SELECT sessions_invalidated_at FROM accounts WHERE username = $1`, and
nothing on that path reads `upgraded_at`. Item 2's replacement names its
control and introduces no positional form; a regex matrix confirmed the
rewritten sentence is literally true, including the adjacent `COLUMN_COPY_RE`
count you corrected on your own initiative. Item 3's six claimed mutations
were reproduced by two reviewers working separately, each red set exactly as
your signal block reported, and `mintWithClaimAt(CAP + 1)`'s `'none'` was
confirmed to come from the cap rather than from paren depth or the classifier.
Three findings were raised against this diff and all three were dropped at
validation. Two corrections in your favour: the deviation you flagged in
prose only (the two walks share the BOUND, not the runaway mechanism) is
right, and the sentence a reviewer read as overclaiming the mint pair is
self-qualifying as written — its trailing clause states exactly the condition
that was measured, so it stays.

Two items below. Both are one-sentence or one-probe-pair work; neither
touches a predicate, a finalize, or a migration.

1. **The state-C sentence names a route that does not defend state C.** In the
   `handleLogin` comment: "The state-C passwordless shape (password_hash NULL)
   is defended at /upgrade per the § 6.4 re-auth contract, not here."
   `POST /api/custody/upgrade` never reads `password_hash`. Its gate is
   `verifyHiveSignature`, then a `custody !== 'light'` refusal, then the epoch
   re-read. The routes that actually branch on the passwordless shape are
   `/fresh-auth` and `/session-auth`, each with an explicit
   `if (!account.password_hash)` refusal, and `routes/custody.ts` states the
   real contract in its own words: state C has no password to base a
   password-mechanism proof on and must mint via
   `/api/orcid/start { mode: 'fresh_auth' }` instead. This sentence is your
   own round-3 authorship, not inherited: it passed the round-3 pass and was
   outside round 4's scope.
   Requirement: repoint the citation at the routes that hold the defense, or
   say plainly what `/upgrade` does require of a state-C row. Do not widen the
   sentence beyond what you verify; the surrounding clauses are settled and
   must not be reopened.

2. **`STATEMENT_JOIN_CAP` is unpinned at every value it could hold.** The
   commit hoisted both caps into one docblock and pinned `SCAN` in both
   directions. Its sibling was left where it was: the cap was mutated to 1, 2,
   3, 5, 8 and 40 and the file stays green at every one, while a lowered value
   demonstrably stops a real wrapped derivation from being reported. That is
   the silent-pass direction on a merge-blocking guard, and it is the same
   shape round-3 item 6 and round-4 item 3 both held on, one constant over.
   Scoped honestly: this is pre-existing, it is equally green on the base
   commit, and no sentence the commit added is made false by it — the "pinned
   in both directions" claim is scoped to `SCAN` and to the twelve it states.
   It is held here because the implementer is already in this docblock for
   item 1 and the standard was set one round ago, not because the diff
   regressed anything.
   Requirement: a joined-count boundary pair beside the split-derivation pair,
   through the same `reader` / `offenders` path so it cannot pass vacuously,
   with hard-coded literals mirroring the existing convention so the pair pins
   the VALUE rather than tracking the symbol. Assert the boundary in both
   directions and state the residual the cap buys, the way the `SCAN` docblock
   already does.

Raised and routed elsewhere, nothing for you on this task:

- `JWT_MINT_RE` carries no planted probe, unlike every other scanner in the
  file and unlike the sibling canary that pins its identical copy; the two
  claim allow-lists are read only through `.includes`, with no set-equality
  assertion of the kind `ALLOWED_HELPER_CALL_SITES` already gets; and the mint
  classification is a key-set membership test, so a second mint inside an
  already-allowed symbol adds no member and is never named. All three are
  pre-existing, on surfaces this diff never touched. Filed as
  `backend-custody-canary-unpinned-surfaces`.
- `mintPayload` walks one line past a mint whose parens close on its own line,
  because the `depth <= 0` break is gated on a positional term and evaluated
  after the line is appended. Reproduced, but unreachable today (all eight
  `jwt.sign` sites open multi-line) and fails loud rather than silent. Folded
  into the same filed task, together with the missing probe for the walk's
  start line.

Raised and dismissed, no action needed from you:

- "so the copy only re-mints a session and reaches no signing path" was read
  as ambiguous next to the handler's own `jwt.sign` six lines below. The claim
  is verified true in the sense it intends: the copied claim reaches no
  server-side chain-signing capability and mints no proof window. The reviewer
  anchored it as a preference, and round 4 already declined to rewrite prose
  in this block that is not false. It stays as written.

Architect-side, carried forward:

- **[TODO Architect]** The two deferred § 6.1 / § 6.7 doc items and the
  `api-contracts/auth.md` `/link` stuck-recovery branch still carry to
  archive, unchanged from the round-4 block. They were not discharged this
  round because the task did not archive.
