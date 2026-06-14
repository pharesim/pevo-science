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
