## Align the custody column with upgraded_at at upgrade and login mints (archived 2026-10-05) — five holds; archived at cca00888, one P3 folded into the custody-canary hold

### Architect archive note (2026-10-05)

Round-6 re-review of cca00888 alone with /ce-code-review (full: correctness, adversarial
in-process, testing, project-standards on root CLAUDE.md, learnings) plus an independent
validator. Both round-5 items are met. The handleLogin state-C sentence is true clause by
clause: `/custody/fresh-auth` and `/custody/session-auth` each refuse a NULL `password_hash`,
and `/custody/upgrade` reads only `upgraded_at`. The STATEMENT_JOIN_CAP pair pins the value
in both directions, reproduced independently by two lenses: cap 3 reds the fourth-joined
assertion, caps 5 and 12 red the fifth, deleting the join term reds the fifth; baseline 8/8.

One finding (P3, confirmed by the validator): the JOIN docblock's cost sentence names only
the epoch derivation, but the cap also bounds the column copy and destructure scans (a
one-per-line destructure with three or more members before `custody` escapes at cap 4). User
decision 2026-10-05: folded into the backend-custody-canary-unpinned-surfaces hold as item 4
(c6ce08ce) instead of a sixth hold here. A learnings note on a possible off-by-one in "more
than four joined lines apart" was measured and not admitted.

Items surfaced in earlier backend signals that no hold had taken up were triaged with the
user ("approved", 2026-10-05): section 6.3 gained the state-G transitions here, and the
stale A/B/C/D code comments plus the set-password NULL-hash comment went to
backend-account-state-comments-name-state-g; /reset gating on no account state went to
backend-password-reset-gates-on-account-state; the state-D JWT settings question went to
ui-state-d-session-settings-critical-actions (reproduce first); the registration-watch
state-G webhook item was dismissed as already recorded in the collectCompleted docblock.
All three filed at 94975a70.

[TODO Architect] doc items discharged at 89d896ce. The canonical epoch-ordering statement
lives in section 6.3's new "Option C lookup predicates" note, not 6.7 as the round-4 block
said, because the discriminator moved off the revocation epoch onto
`upgraded_at <= updated_at`; 6.7 got a pointer bullet. Also: 6.1 states the CHECK is
one-directional and the (self, NULL epoch) shape is fictional and refused; 6.4's
set-password and Link ORCID rows match the handlers; auth.md documents the /confirm and
/link cookie-free stuck-recovery branches; orcid.md states the derived login custody for D
and G; custody.md says /upgrade marks the row self-custody. The deploy-tripwire ADD
CONSTRAINT arm, state G in 6.1, and the state-F anchor fix landed during earlier rounds.
No /ce-compound: the finding is an instance of the existing
a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each convention.
Implementation commits: 68fc1e91, c5846d1a, 9fd22a7f, 65ab1c74, f0effeb1, a24aae5a, cca00888.

### Task file

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
