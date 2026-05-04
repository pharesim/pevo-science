# BACKEND-ORCID-CUSTODY-DEFAULT-INVARIANT — Close the orcid.ts `||` default vs `/upgrade` custody-gate invariant violation

**Owner:** backend
**Created:** 2026-05-04 (architect, surfaced by cluster-A round-3 review of `backend-password-hash-null-typing-audit.md` round-2 hold-fix; explicitly tracked-separately by the round-2 hold's Item 2 framing)
**Priority:** P2

## Problem

`backend/src/routes/orcid.ts:456` mints the JWT for ORCID-only accounts with:

```ts
{ sub: account.username, custody: account.custody || 'light' }
```

The `||` default coerces null/falsy `account.custody` (the persisted DB state for ORCID-only accounts) to the JWT claim string `'light'`. Then `backend/src/routes/custody.ts /upgrade` gates on `if (custody !== 'light') return ...`, so an ORCID-only account passes the gate and reaches the password-verify branch — where `account.password_hash` is `NULL`. The round-1 fix added a runtime null-guard at `custody.ts:223-227` (with `burnSentinel` for timing-equalization), and the round-2 mutation-fence test at `backend/tests/routes/custody-upgrade-null-hash.test.ts` locks the wall-time/status/audit-log convergence with the wrong-password branch.

But the **underlying invariant violation** is the orcid.ts `||` default: the JWT's `custody` claim does not match the account's persisted `custody` column. The custody-upgrade null-guard is a local fix; the invariant is project-wide. Per the architect's round-2 hold-block (now archived in tasks-archive.md): "the orcid.ts `||` default vs the `/upgrade` gate is the underlying invariant violation tracked separately."

This task closes the underlying invariant.

## Why this matters

1. **Defense-in-depth refactor risk.** The round-2 mutation-fence test seeds `custody='light'` directly in the DB row (per the test's own header comment + adversarial-r4 finding ADV-R4-3). The production-reachable path is `custody=NULL` → orcid.ts `||` default → JWT custody='light'. A future defense-in-depth refactor that adds a DB-level custody recheck on `/upgrade` (e.g., re-fetch the account and reject if persisted `custody !== 'light'`) would silently leave the existing test green while reopening the timing oracle for real ORCID accounts. The local null-guard becomes dead code; the test stops detecting regressions on the actual production path.
2. **JWT-vs-DB drift class.** Any future code path that grants permissions on the basis of the JWT `custody` claim (without re-checking the DB) trusts a value the DB never stored. If the orcid.ts default ever needs to widen (e.g., adds a third custody mode), the existing `'light'` defaults silently misrepresent every ORCID-only account.
3. **Layered guarantee weakens to one layer.** Today the guarantee is "orcid.ts always claims `'light'` for ORCID-only accounts AND custody.ts has a null-guard at the password-verify branch." The invariant is two-layer; the test fences only the second layer. A round-3 architect who archives this task without acting on the orcid.ts side leaves the cluster permanently dependent on one implementer-team-side discipline.

## Goal

Eliminate the JWT-vs-DB drift on the `custody` claim, OR make the drift impossible to misrepresent at the consumer side.

## Approach (suggested — implementer's choice between A and B)

**Option A — Drop the `||` default in orcid.ts, mint the JWT with the actual DB value.**

Change `orcid.ts:456` and `:466` from `custody: account.custody || 'light'` to `custody: account.custody` (the value, possibly null). Adjust the consumer routes:
- `/upgrade` (custody.ts) gates on `custody !== 'light'`. Today a null-custody JWT (post-fix) would fall into the gate's `!== 'light'` branch and 403. That CHANGES current behavior — ORCID-only accounts can no longer reach the password-verify branch. The null-guard at `custody.ts:223-227` becomes unreachable (drop it as dead code).
- Other routes that read the `custody` claim need an audit pass: any site that currently treats the JWT `custody` claim as authoritative needs to handle null.
- The mutation-fence test at `custody-upgrade-null-hash.test.ts` becomes a test of an unreachable branch — either delete it OR re-purpose it to assert the new gate behavior.

**Option B — Add a DB-level custody recheck inside `/upgrade` (defense in depth).**

Keep `orcid.ts:456` as-is (preserves existing route reachability). Add to `custody.ts` `/upgrade` immediately after fetching the account: `if (account.custody !== 'light') return sendError(res, 403, 'FORBIDDEN', '...')`. This makes the JWT claim non-authoritative on this route; the DB row's `custody` column becomes the load-bearing gate. Update the mutation-fence test to seed `custody=NULL` (matching the production-reachable path) and assert the gate fires before the null-hash branch — i.e., the null-guard becomes unreachable through this route, but is preserved as belt-and-suspenders for any future direct caller. This also migrates the test from the symptom (null-hash) to the root-cause (custody-vs-claim).

**Option C — Architect-flavored: make the JWT shape encode the persisted custody state AND have consumers branch on it.**

Mint the JWT with `custody: account.custody ?? null` (explicit null, not coerced to a sentinel). Update ALL consumers to branch on null vs `'light'` vs `'self'` etc. Higher implementation cost; cleanest in principle. Probably out of scope unless other JWT-claim drift exists.

## Acceptance

1. The orcid.ts `||` default is either removed (Option A), neutralized by a DB-level recheck (Option B), or replaced with explicit null encoding (Option C).
2. The cluster of routes that read the JWT `custody` claim is audited end-to-end for the chosen shape. Document the audit grep in the re-review signal block.
3. The mutation-fence test at `backend/tests/routes/custody-upgrade-null-hash.test.ts` is updated to seed the production-reachable shape (custody=NULL in the DB) per the chosen fix path.
4. The corresponding adversarial-r4 finding (test seeds `custody='light'` directly, masking the orcid-coercion path) is closed: re-running the same review pass on the new commit should NOT re-surface it.
5. `tsc --noEmit` clean. `npm run lint` clean. Targeted vitest covering custody.ts + orcid.ts route tests passes.

## Non-goals

- Adding a new authentication mechanism for ORCID-only accounts. The null-hash branch is the architectural choice; this task only closes the JWT-vs-DB drift around it.
- Touching the wider authentication surface (login flow, signup, etc.). Scoped to the orcid → custody bridge.
- Re-architecting `accounts.custody` to be NOT NULL (the current nullable column accommodates ORCID-only accounts intentionally; same justification as `password_hash` in `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT`).

## Coordination

This task is independent of the round-3 hold-fix on `backend-password-hash-null-typing-audit.md` (the local null-guard mutation-fence). Both can land in any order. If THIS task lands first under Option B, the round-3 hold's adversarial-r4 dismissal note ("filed as a separate task") becomes the closing reference. If the round-3 hold lands first, this task's fix will need to update the test that hold ships.

## Files of record

- `backend/src/routes/orcid.ts:456, 466` (the two `||` defaults)
- `backend/src/routes/custody.ts /upgrade` (the consumer route)
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` (the seed shape that may need updating)
- `backend/tests/routes/custody.test.ts` and any other test reading the JWT custody claim
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (the convention parent for "annotation must permit null where null is possible" — this task extends the same audit class to the JWT claim's DB-vs-claim drift dimension)

## Background

Identified during cluster-A `/ce-code-review` of commit `99c6e72` (BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT round-2 hold-fix), adversarial persona finding ADV-R4-3, conf 80. Filed as a separate task per architect triage on 2026-05-04 — the local round-2 mutation-fence is correct on its own scope; closing the underlying invariant is the natural follow-up.

## Backend re-review signal (2026-05-04, Option A landed)

**Option chosen: A** — drop the orcid.ts `||` default and let the middleware's `|| 'self'` fallback close the JWT-vs-DB drift. The null-guard at custody.ts is now unreachable through any documented path; replaced its burnSentinel + audit-log block with a TypeScript-narrowing-only guard plus a `custody_upgrade_null_hash_unreachable` operator log for the hypothetical direct-caller case. Rationale: Option A yields the simpler post-state (one fewer dead-code branch, one fewer mutation fence to maintain) and the consumer audit (below) shows no consumer relies on a non-null JWT custody claim that the middleware fallback wouldn't already handle correctly.

### Consumer audit grep

```
grep -rn "hiveCustody\|req\.hiveCustody\|\.custody" backend/src/ --include="*.ts" | grep -v test | grep -v "\.d\.ts"
```

Sites that read the JWT `custody` claim (via `req.hiveCustody`):

| Site | Purpose | Effect of `custody: null` JWT |
|---|---|---|
| `backend/src/middleware/verifyHiveSignature.ts:84` | Source of truth: extracts `payload.custody` and coerces with `|| 'self'`. | `null` → `'self'`. ORCID-only callers default to self-custody at the request level (correct: they have no encrypted keys). |
| `backend/src/middleware/verifyHiveSignature.ts:182` | Hive-signature path always sets `'self'`. | Unaffected (this branch never reads JWT). |
| `backend/src/routes/auth.ts:277` (`POST /api/auth/session`) | Re-mints JWT from `req.hiveCustody`. | Reads `req.hiveCustody || 'self'` — `null` already coerced to `'self'` by middleware, and double-defaulted here. New JWT carries `'self'`. |
| `backend/src/routes/custody.ts:33` (`POST /api/custody/broadcast`) | Gates `custody !== 'light'` → 403. | ORCID-only (`'self'` post-coerce) fails the gate → 403 FORBIDDEN. Correct: ORCID-only accounts have no encrypted keys to broadcast. |
| `backend/src/routes/custody.ts:228` (`POST /api/custody/upgrade`) | Gates `custody !== 'light'` → 403. | ORCID-only (`'self'` post-coerce) fails the gate → 403 FORBIDDEN before reaching the password-verify branch. **This is the load-bearing change.** The `password_hash=NULL` branch at line 282 is now unreachable through this route. |

Sites that read `account.custody` (DB column, NOT JWT — out of scope for this task but cross-checked):

```
grep -n "account\.custody\|row\.custody" backend/src/routes/auth.ts backend/src/routes/settings.ts
```

| Site | Purpose | Effect |
|---|---|---|
| `backend/src/routes/auth.ts:850` (`POST /api/auth/login`) | Mints JWT after password-verify success: `account.upgraded_at ? 'self' : (account.custody || 'light')`. | Unchanged. The `|| 'light'` fallback here applies to password-verified accounts, which by definition have a non-null `password_hash`; the JWT-vs-DB drift this task closes does not apply (the password-verify branch is already past). |
| `backend/src/routes/auth.ts:1284` (`POST /api/auth/recover`) | Same shape as login post-recovery. | Unchanged for the same reason. |
| `backend/src/routes/settings.ts:90` (`GET /api/settings/email`) | Returns `row.upgraded_at ? 'self' : (row.custody || 'self')`. | Reads DB column directly. ORCID-only accounts now correctly surface as `'self'` here too. |
| `backend/src/routes/settings.ts:301` | Logs warning if `row.custody === 'light'` on email delete. | Unchanged. |

Conclusion: the only consumer that must change behavior under Option A is `custody.ts /upgrade`, which now correctly 403s ORCID-only callers at the gate. No consumer was found that would silently mishandle a `'self'`-coerced ORCID-only request. Two `auth.ts` JWT-mint sites still carry `account.custody || 'light'` defaults, but those mint paths run only after password-verify success, so they do not affect the JWT-vs-DB drift this task closes; widening them to honest null-handling is out of scope for this task.

### Test mutation kills

`backend/tests/routes/custody-upgrade-null-hash.test.ts` was re-purposed (not deleted). The new shape:
1. Seeds `custody=NULL` + `password_hash=NULL` (the production-reachable ORCID-only shape, closing ADV-R4-3).
2. Mints a JWT with `custody: null` (matches what orcid.ts now produces).
3. Asserts 403 FORBIDDEN with `Only custodial accounts can upgrade` and `code: FORBIDDEN`. A regression that re-introduced `custody: account.custody || 'light'` in orcid.ts would let this request pass the gate and return 401 instead of 403 — that is the primary mutation kill.
4. Asserts no audit-log entry (the gate fires before `logCustodyBroadcast(username, 'upgrade_failure')`).
5. Wrong-password baseline preserved as the second test (light-custody + real argon2 hash + wrong password → 401 with audit-log row settled). This locks the wire contract for real light-custody upgrade attempts.

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing warnings in `seed-phrase.ts`).
- Targeted vitest run: `tests/routes/custody-upgrade-null-hash.test.ts` (2/2), `tests/routes/custody.test.ts` (passes), `tests/routes/custody-upgrade-argon-error-translation.test.ts` (passes), `tests/routes/orcid.test.ts` (passes). 78/78 across the four files.

### Files changed

- `backend/src/routes/orcid.ts` — type narrowed to `custody: string | null`; both `|| 'light'` defaults at lines 456, 466 dropped.
- `backend/src/routes/custody.ts` — `burnSentinel` import removed; null-guard block at the password-verify branch reduced to a TypeScript-narrowing-only guard with operator-level `custody_upgrade_null_hash_unreachable` log.
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` — re-purposed to lock the post-fix gate behavior (custody=NULL → JWT custody=null → 403 FORBIDDEN), preserving the wrong-password baseline as the second test.

[TODO Architect] None. The orcid.ts response body still returns `custody: account.custody` (possibly null) to the frontend — `frontend/src/pages/orcid-callback.js:230` already does `auth.custody = data.custody || 'light'`, which is symmetric to the bug just removed but is in the UI agent's zone (out of backend scope). If the architect prefers the response-body shape to default to `'self'` instead of null, that is a one-line follow-up; flagged here for the architect's awareness but not blocking archive of this task.
