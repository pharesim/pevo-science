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
- Sequencing: the custody-upgrade task currently holds one comment-line fix in
  the same file area (`verifyHiveSignature.ts` / `routes/custody.ts`). Not a
  blocker, but land after that hold's one-liner to avoid churn on the same
  hunks.

## Backend completion notes (2026-09-02)

Landed in `68fc1e91` (implementation) and the round-2 commit that follows it
(review fixes). Per scope item:

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
  about state D. `api-contracts/custody.md` POST /upgrade prose may mention
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
