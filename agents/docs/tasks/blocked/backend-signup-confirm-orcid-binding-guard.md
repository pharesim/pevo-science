# Signup-confirm/link accreditation broadcast has no ORCID-uniqueness guard (backend)

**Owner:** backend
**Created:** 2026-06-14

The on-chain accreditation is the source of truth for "this ORCID belongs to this
scientist", but the signup-finalize path that broadcasts it does **not** check
whether the ORCID is already bound to another account. This lets one ORCID end up
with two on-chain `accredit` ops under two different accounts, violating the
"one ORCID === one user" invariant on the authoritative (chain) layer. The DB
partial unique index (`accounts_orcid_unique`, `migrations/007`) does **not** close
this: it constrains only the denormalized `accounts.orcid` column, never the chain.

From a 2026-06-14 adversarial audit of the ORCID-uniqueness invariant.

## Root cause

`broadcastAccreditationAndSeed` (`backend/src/routes/signup-verify.ts`, shared by
the `/confirm` and `/link` finalize flows) broadcasts `action: 'accredit'` carrying
`orcid: account.orcid`, but its only dedup is an **account-keyed** HAF probe
(`getAccreditedSet([username])`, and only when `isResume`). It never calls the
ORCID-binding check (`findAccreditedAccountWithOrcid`) and takes no binding lock —
unlike `handleAccredit` / `handleLink` in `backend/src/routes/orcid.ts`, which both
do. Two reinforcing asymmetries:

1. **Finalize path is unguarded.** The signup-confirm/link finalize is the primary
   way an ORCID signup gets accredited, yet it has no ORCID-binding guard at all.
2. **The existing guard is chain+cache-only.** `findAccreditedAccountWithOrcid`
   (`orcid.ts`) reads only the HAF chain (authorized `accredit` ops) plus the Redis
   binding cache. It never queries the `accounts` table, so a pending ORCID-only
   signup row (`accounts.orcid` set, `username` NULL, no on-chain op yet) is
   invisible to it.

## Reproduction (raceless)

1. Accredit a self-custody Hive account B via `POST /api/orcid/callback` (mode
   `accredit`) with ORCID X. `findAccreditedAccountWithOrcid(X)` sees nothing on
   chain → passes → broadcasts X→B. B has no `accounts` row, so
   `updateAccountOrcid(B, X)` matches 0 rows and raises no `23505`.
2. Sign up account L via ORCID-only `/signup` with the same ORCID X (no `accounts`
   collision, since B has no row) → `accounts` row `orcid=X`.
3. Finalize L via `/signup/confirm`. `broadcastAccreditationAndSeed` broadcasts
   X→L with no ORCID guard.
4. Chain now carries two `accredit` ops for ORCID X (B and L). No reconciler exists
   to revoke the duplicate. The reverse lookup resolves X to whichever was
   accredited last, but both accounts are accredited and both attest ORCID X.

No race or Redis outage is required; this is a pure logic gap. (A separate
concurrency variant under Redis outage is tracked elsewhere — see
`backend-orcid-bind-redis-outage-fail-open` if filed.)

## Acceptance criteria

1. Before broadcasting the `accredit` op in `broadcastAccreditationAndSeed`
   (`signup-verify.ts`), when `account.orcid` is non-empty, run an ORCID-binding
   check equivalent to `findAccreditedAccountWithOrcid` and refuse to broadcast if
   the ORCID resolves to a **different** account. `findAccreditedAccountWithOrcid`
   and `withOrcidBindingLock` are currently module-private in `orcid.ts`; factor the
   binding check (and ideally the lock) into a shared module both routes import,
   rather than duplicating the HAF query.
2. Decide and implement the refusal behavior at finalize time. The account row /
   keys may already be persisted by the time finalize runs, so this is not a plain
   pre-flight 409. Surface a clear, actionable error (proposed
   `409 ORCID_ALREADY_LINKED`, matching the callback contract) and leave the
   account in a recoverable state. **This UX/state decision should be confirmed
   with the architect** before landing — it touches the account-state machine in
   `ARCHITECTURE.md` § 6 (a finalized-but-not-accredited outcome).
3. Close the pending-signup blind spot: either widen the binding check to also
   consult `accounts.orcid` for rows that hold the ORCID without an on-chain op, or
   document explicitly why chain-only is acceptable. If widened, define precedence
   (chain binding vs. pending `accounts` row) deterministically.
4. Real-path test coverage (real HAF + Hive per project test policy): a second
   account cannot obtain an on-chain accreditation for an ORCID already accredited
   to another account, exercised through the `/signup/confirm` and `/link` finalize
   paths. Include the pending-signup-row case from item 3.

## Context / out of scope

- Chain is SSoT (do not relitigate). The `accounts.orcid` unique index is a
  performance/denormalization backstop, not the authority for this binding.
- `/orcid/callback` accredit/link already guard correctly — the fix is to bring the
  signup-finalize path up to parity and to remove the chain-only blind spot, not to
  rework the callback path.
- The Redis-outage fail-open race on the callback path and the signup-side wrong
  error code (`500` vs `409`) are separate findings, filed as their own tasks.
- Account-state-defense review (`CLAUDE.md`): this defends an account-state
  transition; the reviewer must check the guarded combination against
  `ARCHITECTURE.md` § 6.1 and the re-auth contract in § 6.4/§ 6.5.

## [BLOCKED by Architect] (2026-06-14, backend) — UX/state decision required before landing

Acceptance item 2 mandates architect confirmation of the finalize-time refusal
UX/state, and § 6.5 invariant #4 requires § 6.1 to be updated *before* any code
that could produce a new account state lands. Tasks 1 and 3 of the cluster
(`backend-signup-orcid-duplicate-409`, `backend-orcid-unique-index-boot-assertion`)
landed independently and are in `review/`; this one needs two decisions first.

### Gap confirmed in code

`broadcastAccreditationAndSeed` (`signup-verify.ts`) broadcasts `action:'accredit'`
with `orcid: account.orcid` and its only dedup is the account-keyed
`getAccreditedSet([username])` probe, run only when `isResume`. It never calls
`findAccreditedAccountWithOrcid(account.orcid)` and takes no binding lock, unlike
`handleAccredit`/`handleLink` in `orcid.ts`. The `/confirm` and `/link` call sites
invoke it AFTER the row is finalized (keys persisted, `verify_token` cleared,
activation lock released) — so by broadcast time the account is already in a
steady State A/B/C; only the on-chain accredit op is outstanding.

### Decision A — finalize-time refusal UX + § 6.1 status (architect owns)

Because finalize already completed, refusing the broadcast leaves a
finalized-but-not-accredited account. Backend analysis for the architect's call:

- This is very likely NOT a new § 6.1 accounts-row state. The six dimensions
  (`verify_token, username, password_hash, orcid, custody, upgraded_at`) do not
  include "accredited" — accreditation lives on chain, orthogonal to the row. A
  finalized account with no chain accredit op is already reachable TODAY via the
  `if (!config.pevoAdminPostingKey) return 'ok'` branch (finalizes the session,
  broadcasts nothing). So the refusal outcome maps to existing State A/B/C.
- Proposed behavior: when `account.orcid` is non-empty and
  `findAccreditedAccountWithOrcid(account.orcid)` resolves to a DIFFERENT account,
  refuse with `409 ORCID_ALREADY_LINKED` (matching the `/orcid/callback` contract),
  no `retriable`/`Retry-After`. The account stays finalized (recoverable: the user
  can log in; they are simply unaccredited until the ORCID conflict is resolved out
  of band). The alternative — silently finalize like the admin-key-absent path —
  is worse here because it hides a real ORCID collision from the user.

  **Architect please confirm:** (A1) 409 + finalized-but-unaccredited is the
  intended UX (vs. silent finalize, vs. rolling the finalize back); (A2) whether
  § 6.1 needs a clarifying note that "accredited" is an on-chain/orthogonal status,
  not a row dimension, so this outcome is documented as an existing state rather
  than a new one. Per the backend boundary rule, the architect makes any § 6.1 /
  contract edits; backend lands only the code once A1/A2 are fixed.

### Decision B — chain-only blind spot vs. widen to `accounts.orcid` (item 3)

`findAccreditedAccountWithOrcid` reads chain + Redis binding cache only, never
`accounts.orcid`. Backend analysis: for THIS guard the chain-only check is
sufficient, because the `accounts_orcid_unique` index (007) already forbids two
`accounts` rows sharing an ORCID — so the only way an ORCID reaches two accounts is
when one holder is a self-custody on-chain accredit with no `accounts` row (the
repro's account B), which the chain check DOES see. The pending-ORCID-only-row case
item 3 worries about cannot coexist with a second same-ORCID row (the index blocks
it; a second signup now 409s via task 1). Recommendation: **document chain-only as
sufficient** here (with the index as the row-level backstop) rather than widening
the query, keeping chain as SSoT. **Architect please confirm** chain-only +
document, or direct the widening with a precedence rule (chain binding vs. pending
`accounts` row) if a scenario I missed needs it.

### Proposed implementation (pending A/B sign-off)

1. Factor `findAccreditedAccountWithOrcid` (and `withOrcidBindingLock` if the
   architect wants the finalize broadcast under the same lock as the callback
   path) from `orcid.ts` module-private into a shared module both routes import —
   no behavior change to the callback path.
2. In `broadcastAccreditationAndSeed`, before the broadcast, when `account.orcid`
   is non-empty, call the shared binding check; refuse with `409 ORCID_ALREADY_LINKED`
   if it resolves to a different account. Apply on both `/confirm` and `/link`
   finalize flavors and on the resume path (the probe currently only guards the
   account key, not the ORCID).
3. Real-path tests (real HAF + Hive): a second account cannot obtain an on-chain
   accreditation for an ORCID already accredited to another account, via
   `/signup/confirm` and `/link`; include the self-custody-B / pending-L repro.

Unblock by resolving A1/A2 + B (and making any § 6.1 / contract edits); then move
back to `pending/` for backend to implement.
