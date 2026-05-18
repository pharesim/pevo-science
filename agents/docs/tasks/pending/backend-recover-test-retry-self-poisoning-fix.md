# BACKEND-RECOVER-TEST-RETRY-SELF-POISONING-FIX — apply the beforeEach reset + bounded poll pattern to recover.test.ts:602-633

**Owner:** Backend Agent
**Created:** 2026-05-18 (architect, cluster-D follow-up from `backend-password-hash-null-typing-audit` round-4 review)
**Priority:** P3

## Problem

`agents/docs/solutions/conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` explicitly names `backend/tests/routes/recover.test.ts:602-633` as a **latent unrepaired sibling** of the test-retry self-poisoning class that the password-hash-null-typing-audit round-3 fix closed for `custody-upgrade-null-hash.test.ts`. Same three-condition trigger:

1. Fire-and-forget audit-log write in the production code path under test (e.g., `logCustodyBroadcast(...).catch(() => {})` or equivalent).
2. `expect(auditRows.length).toBe(1)` strict-equality assertion.
3. `vitest.config.ts` `retry: 3` — if attempt #1 fails for any reason, attempt #2 sees the audit-log row from attempt #1 still in the table (`afterAll` cleanup, not `beforeEach`), and the count assertion fails as `expected 2 to be 1` regardless of whether the actual mutation-fence claim is correct.

The risk is latent — attempt #1 usually passes, retry rarely fires. Surfaces only on infrastructure noise or a real production mutation. When it surfaces, the test's mutation-fence ground truth is poisoned.

## Goal

Apply the same `beforeEach` reset + bounded-poll pattern from `custody-upgrade-null-hash.test.ts` to `recover.test.ts:602-633`:

1. **`beforeEach` reset.** DELETE both the audit-log rows AND any seeded account/state rows the test depends on for both seeded usernames; re-INSERT the seed rows. Reset must run on every `it` attempt including retries.
2. **Bounded poll.** Adopt (or share) a `fetchSettledAuditRows()` helper that polls up to ~1.5s for `>= 1` row at ~25ms intervals, then waits ~100ms for any imminent double-log mutation to commit, then SELECTs once more and returns the settled count.
3. **Production code unchanged.** Do NOT add `await` to the fire-and-forget production audit-log write. The fire-and-forget convention is endorsed by `auth-structured-log-shape-2026-04-29.md`; one test's reliability needs shouldn't drive the convention.

Optionally, if `fetchSettledAuditRows` would naturally extract into a shared test util at this point (two callers across two files), promote it to `backend/tests/support/` and have both files import it. Implementer's judgment.

## Acceptance

1. The `beforeEach` reset DELETEs the right rows for the seeded usernames and re-INSERTs the seed state.
2. The bounded-poll helper is used for the audit-log SELECT in the cited test block.
3. `npx vitest run tests/routes/recover.test.ts` passes against real Postgres + Redis (per root CLAUDE.md "Running Tests" Docker-network override).
4. Production code at the corresponding `logCustodyBroadcast(...).catch(() => {})` (or equivalent fire-and-forget site that the recover.test.ts block exercises) is unchanged.

## Out of scope

- Refactoring the broader `recover.test.ts` file structure beyond the cited block.
- Migrating other unrepaired siblings from the convention's catalog (file separately if/when surfaced).

## References

- `agents/docs/solutions/conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` (the convention; explicitly names this file).
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` (fire-and-forget endorsement; do NOT add `await` to production).
- `agents/docs/tasks-archive.md` BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT round-3 + round-4 entries (when archived) — the canonical fix shape.
- `backend/tests/routes/custody-upgrade-null-hash.test.ts` — the reference implementation at HEAD.

## Priority rationale

P3 because the failure mode is latent (compound condition: attempt #1 fails + retry fires + double-row visible to retry's assertion). The mutation-fence ground truth is still trustworthy on a green CI; the risk surfaces only when the test would have caught something real. Worth closing now while the pattern is fresh, but not urgent against in-flight work.

## Backend re-review signal (2026-05-18, worktree-agent-ace4af48d2d2211ea)

Round-1 implementation landed on `backend/tests/routes/recover.test.ts` only — production code untouched.

**Citation drift discovered:** the task body cites `recover.test.ts:602-633` as the target block, but that block is the `/resend-verification` null-hash timing test with no audit-log assertion. The real sibling sites matching the convention's three trigger conditions (fire-and-forget audit write + strict-equality count + retry > 0) at HEAD are line 170 (`rejects wrong memo key`, `recovery_failure`) and line 243 (`succeeds with correct memo key`, `account_recovery`). Both fixed in this commit. The reference implementation file (`custody-upgrade-null-hash.test.ts`) was deleted by commit 1f1be4e; helper signature pulled from `git show 009b4a2:backend/tests/routes/custody-upgrade-null-hash.test.ts` and adapted.

**Changes landed:**

- Added `beforeEach` in the `POST /api/auth/recover — with DB` describe block that DELETEs `custody_audit_log` rows for `TEST_USER` (the only seeded username the block depends on; `otherUser` in `rejects duplicate email` is created/deleted within that test alone and needs no beforeEach scoping).
- Added a module-local `fetchSettledAuditRows(pool, username, operationType)` bounded-poll helper (1.5s poll at 25ms intervals + 100ms settle window + final SELECT). Kept local per task's out-of-scope guidance.
- Replaced direct SELECT + `expect(...).toBe(1)` at the two cited sites with helper calls; `beforeEach` reset guarantees the count is exactly 1, so `.toBe(1)` still mutation-kills an over-log production change.
- Production code in `backend/src/routes/recover.ts` unchanged — fire-and-forget audit-log writes preserved per `auth-structured-log-shape-2026-04-29.md`.
- Added `beforeEach` to the vitest import.

**Verification:**

- `cd backend && npx tsc --noEmit` — clean.
- `cd backend && npm run lint` — clean (no warnings reported).
- Targeted vitest deferred to the parent's serialized post-fan-out run.
