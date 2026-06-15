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

## [Architect] (2026-06-15) — UNBLOCKED: A1/A2/B resolved, moving to `pending/`

Reviewed at the architect blocked-task sweep. The gap was re-verified live against
current code: `broadcastAccreditationAndSeed` (`signup-verify.ts`) still broadcasts
`accredit` with `orcid: account.orcid` and its only dedup is the account-keyed
`getAccreditedSet([username])` probe gated on `isResume` — no ORCID-binding check,
no lock — while `handleAccredit`/`handleLink` (`orcid.ts`) still guard via
`findAccreditedAccountWithOrcid` + `withOrcidBindingLock` (both module-private).
The two sibling cluster tasks (`backend-signup-orcid-duplicate-409`,
`backend-orcid-unique-index-boot-assertion`) have landed and archived, so the only
thing keeping this blocked was the two architect decisions. Both are resolved
below; the file moves to `pending/` for backend implementation.

### Decision A2 — NOT a new § 6.1 state (no doc edit required)
§ 6 already states ("Accreditation status is an on-chain dimension orthogonal to
the § 6.1 `accounts`-table state machine ... adds no column to the `accounts`
table"): accreditation is computed from chain ops, not a row dimension. A
finalized-but-unaccredited account is therefore an existing State A/B/C, NOT a new
state — already reachable today via the `if (!config.pevoAdminPostingKey) return
'ok'` finalize branch (finalizes the row, broadcasts nothing). § 6.5 invariant #4's
"update § 6.1 first" gate is already satisfied; no § 6.1 edit is needed. The
refusal outcome adds no row state.

### Decision A1 — refusal UX = 409 ORCID_ALREADY_LINKED, account stays finalized
When `account.orcid` is non-empty and the ORCID-binding check resolves to a
DIFFERENT account, refuse the broadcast with `409 ORCID_ALREADY_LINKED` — same
terminal wire shape as the `/orcid/callback` durable-binding 409 and the `/signup`
DB-index 409 (no `retriable` field, no `Retry-After`). The account stays finalized
and recoverable: the user can log in; they are simply unaccredited until the ORCID
conflict is resolved out of band. Do NOT silently finalize (the admin-key-absent
path) — that hides a real ORCID collision from the user. Do NOT roll the finalize
back — keys/row are already persisted and the user has a usable account.

### Decision B — chain-only binding check is sufficient (document, do not widen)
`findAccreditedAccountWithOrcid` reading chain + Redis binding cache (NOT
`accounts.orcid`) is sufficient here. The `accounts_orcid_unique` index (migration
007, now boot-asserted) forbids two `accounts` rows sharing an ORCID, and a second
same-ORCID `/signup` now 409s. So the only multi-account-same-ORCID path is a
no-`accounts`-row self-custody chain accredit (the repro's account B), which the
chain check DOES see. The pending-ORCID-only-row blind spot (item 3) cannot coexist
with a second same-ORCID row. Keep chain as SSoT; the index is the row-level
backstop. Do not widen the query to `accounts.orcid`. (Item 3 = "document chain-only
as sufficient", not "widen".)

### Lock — finalize broadcast runs under `withOrcidBindingLock` (parity with callback)
This resolves the open "if the architect wants" clause to YES. Factor BOTH
`findAccreditedAccountWithOrcid` AND `withOrcidBindingLock` from `orcid.ts`
(currently module-private) into a shared module both routes import — no behavior
change to the callback path. The finalize binding-check + broadcast MUST run under
the lock, mirroring the callback path: without it the chain check is a TOCTOU (check
passes, a concurrent bind for the same ORCID lands before this broadcast). Apply on
`/confirm`, `/link`, and the resume path (the existing probe only guards the account
key, not the ORCID).

### Contract update — defer to code-landing
The `/api/auth/confirm` and `/api/auth/link` error lists in `api-contracts/auth.md`
gain a chain-binding cause for `409 ORCID_ALREADY_LINKED`, distinct from the
existing `/signup` DB-index cause already documented at the top of `auth.md`. The
architect updates `auth.md` in the same change that lands the code (per § 6.6
same-commit-as-code discipline), NOT now — so the contract never describes
unimplemented behavior. Backend: flag the architect at review intake.

### Implementation (now actionable)
The "Proposed implementation (pending A/B sign-off)" block above stands as written;
the lock decision resolves its open clause to "yes, factor the lock too."

## [Backend] (2026-06-15) — implemented, moving to `review/`

Landed at commit `63ebde27` (branch `main`). Files:
- `backend/src/lib/orcid-binding.ts` (NEW) — extracted the binding-lock + binding-check
  dependency closure from `routes/orcid.ts`: `findAccreditedAccountWithOrcid`,
  `withOrcidBindingLock`, `cacheOrcidBinding`, `getCachedOrcidBinding`,
  `acquireBindingLock`, `releaseBindingLock`, `extendBindingLockOnTimeoutOrLog`, the
  two key builders, `BindingLockState`, and the HAF-lag constants. Moved bodies are
  byte-equivalent (only `export` added where needed).
- `backend/src/routes/orcid.ts` — imports the moved symbols from the lib; `__test_seams`
  (updateAccountOrcid local + extendBindingLockOnTimeoutOrLog/HAF_INDEXING_LAG_CEILING_SECONDS
  imported) and `__test_releaseBindingLock` re-export shapes preserved verbatim. Zero
  behavior change to the callback path.
- `backend/src/routes/signup-verify.ts` — ORCID-binding guard in
  `broadcastAccreditationAndSeed`: pre-lock `findAccreditedAccountWithOrcid` →
  `409 ORCID_ALREADY_LINKED` on a different-account binding, then broadcast + cache under
  `withOrcidBindingLock`. Applies to `/confirm`, `/link`, and the resume path. Email-only
  (orcid null) keeps the prior lock-free behavior.
- `backend/tests/routes/signup-verify-orcid-binding-guard.test.ts` (NEW) — real-path
  coverage: 409 via `/confirm` (pending-signup-row repro) and `/link` (real signed
  request); same-account-allowance.

Decisions implemented: A1 (409 + finalized-but-unaccredited; account stays recoverable),
A2 (no § 6.1 state added), B (chain-only check, no widening to `accounts.orcid`), lock
(both functions factored; check + broadcast under the lock; timeout → extend-TTL +
skipRelease; Redis-down → 504 ambiguous-outcome via the wrapper). The `'unavailable'`
branch re-throws non-timeout broadcast errors to the ambiguous envelope; the success path
sends nothing and `res.headersSent` discriminates `'ok'` vs `'handled'`.

Verification: `typecheck:src`, `typecheck:tests`, `lint` (0 errors) all clean.
`orcid.test.ts` 108/108 (callback path preserved); `signup-verify*` + `auth.test.ts`
group 91/91 (no regressions); new guard tests 3/3. An adversarial multi-lens verification
pass (callback-preservation, signup-integration, concurrency/TOCTOU, test-false-green)
returned zero confirmed defects; one minor test-pinning note was addressed in the same
commit (the same-account test now asserts the binding resolves to the username, not a
cache miss).

**[TODO Architect] (contract):** per the "Contract update — defer to code-landing" note
above, `api-contracts/auth.md` needs a chain-binding cause for `409 ORCID_ALREADY_LINKED`
added to the `/api/auth/confirm` and `/api/auth/link` error lists (distinct from the
existing `/signup` DB-index cause). Backend cannot edit contract files (architect-owned);
flagged here at review intake.

## Architect review (2026-06-15) — HELD PENDING FIXES (commit 63ebde27)

Reviewed via `/ce-code-review` (correctness, security, adversarial, testing,
maintainability, project-standards, api-contract, reliability, performance, learnings).
The implementation is sound on substance: correctness, security, reliability, and
performance returned clean. The `orcid.ts` → `lib/orcid-binding.ts` extraction is
byte-equivalent; the TOCTOU lock is correctly closed (binding check + broadcast + cache
under `withOrcidBindingLock`); the Redis-down path fails CLOSED on the HAF check (only
same-instant serialization is lost, acceptable for single-instance); and the guarded
account-state transition aligns with `ARCHITECTURE.md` § 6. Decisions A1/A2/B and the
lock-parity requirement are all implemented as directed.

Two items must land before archive:

1. **Comment-anchor rot — "decision A1" citation (P2).** The new test file
   `backend/tests/routes/signup-verify-orcid-binding-guard.test.ts` cites "Per
   ARCHITECTURE.md decision A1" and "Finalized-but-unaccredited (A1)" in test comments.
   `ARCHITECTURE.md` has NO "A1" label — "decision A1" is a coordination label coined in
   THIS task file, which becomes a dead pointer when the task archives into
   `tasks-archive.md` (trimmed at 250 lines). This violates root `CLAUDE.md` "Comment
   anchors" (coordination-label citations rot on archive). Fix: replace both citations
   with the stable behavioral anchor — accreditation is an on-chain dimension orthogonal
   to the § 6.1 `accounts`-table state machine, so a finalized-but-unaccredited account is
   an existing State A/B/C and the row stays finalized + recoverable. Anchor on the § 6
   behavioral fact, NOT on the "A1" label and NOT on a task slug or round number (the
   replacement must not itself introduce a rotting anchor).

2. **Test coverage gaps (P2).** The new test file covers the 409 via `/confirm`
   (pending-row repro), the 409 via `/link` (real signed request, real
   `verifyHiveSignature`), and the `/confirm` same-account allowance — good. Add real-path
   coverage for: (a) the resume / stuck-recovery flavor (`isResume`) with a conflicting
   ORCID binding — the guard fires at the same site on resume but no resume-flavor conflict
   is exercised; (b) the `/link` same-account allowance (only `/confirm` is covered today)
   — a regression that 409s the link route on a same-account re-finalize would currently be
   silent.

Dismissed (no action):
- **409-message divergence** (`'held'` branch "currently being linked by another request"
  vs durable "already linked to another account"): pre-existing (the wrapper was moved
  byte-equivalent; the message was already in `orcid.ts`), intentional, and documented as
  wire-indistinguishable-by-design at the durable-binding `sendError` in `routes/orcid.ts`.
  The pinned wire shape (status + code + no-`retriable`) matches; the message is
  server-side cause telemetry only. Not a contract violation.
- **P3 maintainability nits** — the test-seam relay exports (`releaseBindingLock` +
  `HAF_INDEXING_LAG_CEILING_SECONDS` re-exported through `orcid.ts`) and the inline
  `orcidBindingKey` duplicate in the new test — both mirror the established
  `orcid.ts` / `orcid.test.ts` convention; not worth the churn.

Resolved by the architect (no backend action):
- **`api-contracts/auth.md` contract update — DONE** in this same review pass: the
  chain-binding `409 ORCID_ALREADY_LINKED` cause is now documented on `/api/auth/confirm`
  and `/api/auth/link`, distinct from the `/signup` DB-index cause. The `[TODO Architect]`
  note above is discharged.

Spun off (no action on this task):
- The broadcast-timeout extended-lock interaction that turns a legitimate signup retry
  into a misleading terminal 409 (adversarial finding, conf 75) is filed as
  `backend-signup-finalize-timeout-extended-lock-409` in `tasks/pending/`. It needs an
  architect wire-shape decision and is independent of this task's guard.

When items 1-2 land, `git mv` this file back to `tasks/review/` — the move is the
re-review signal; re-review will scope to the commits since this block.

## Backend re-review signal (2026-06-15) — hold items 1-2 landed, moving to `review/`

Both held items landed in `backend/tests/routes/signup-verify-orcid-binding-guard.test.ts`
only (no production code touched, so the substance the architect already cleared —
extraction byte-equivalence, the TOCTOU lock, the Redis-down fail-closed, the guarded
state transition — is unchanged).

- **Item 1 (comment-anchor rot — fixed).** Both `decision A1` / `(A1)` citations are gone.
  Replaced with the stable behavioral anchor the hold prescribed: accreditation is an
  on-chain dimension orthogonal to the `accounts`-table state machine (`ARCHITECTURE.md`
  § 6.1), so a refused-broadcast account is an existing finalized state and stays
  recoverable + unaccredited, not rolled back. No `A1` label, no task slug, no round
  number, no line-number/SHA in the replacement. `grep "A1\|decision A"` on the file is
  clean.

- **Item 2 (test coverage gaps — added).** Two new real-path `describe.skipIf` blocks:
  - (a) `/api/auth/confirm` ORCID-binding guard fires on the **stuck-recovery resume**
    path (`isResume=true`): a post-finalize light-custody row whose ORCID is now bound to
    a different account 409s on a `/confirm`-retry, no duplicate accredit broadcast and no
    chain re-create; the row stays finalized (username, custody=light, verify_token NULL).
    A new `seedStuckLightRowWithOrcid` helper mirrors `seedStuckAccount` in
    `signup-verify-stuck-recovery.test.ts` but carries an ORCID so the guard runs.
  - (b) `/api/auth/link` **same-account allowance** (the `/link` counterpart to the
    already-covered `/confirm` same-account case): when the ORCID resolves to the same
    Hive account being linked, the guard does NOT 409 — the link finalizes (200,
    custody=self) and the accreditation broadcast fires. Asserts the cache resolves to the
    linking account (a real cache hit, not an unbound passthrough that would also 200).

Verification (real Postgres + Redis per project test policy):
- `npm run typecheck` (src + tests) clean; `npm run lint` 0 errors (the one pre-existing
  `author-supersession.ts` warning is unrelated).
- `signup-verify-orcid-binding-guard.test.ts` 5/5 (3 prior + 2 new).
- Siblings `signup-verify.test.ts` + `signup-verify-stuck-recovery.test.ts` 21/21 (no
  regression; the 502/500 lines in the run are the deliberate broadcast-timeout /
  injected-failure scenarios asserting error paths).

The two new ORCID fixtures (`...-0004`, `...-0005`) are unique across the test tree (no
`accounts_orcid_unique` collision on concurrent runs).
