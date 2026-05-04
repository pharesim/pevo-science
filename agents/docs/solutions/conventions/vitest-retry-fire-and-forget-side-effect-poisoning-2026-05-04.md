---
title: Vitest retry + fire-and-forget side effect + strict-equality count = self-poisoning test
date: 2026-05-04
category: conventions
module: vitest-retry-fire-and-forget-side-effects
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Vitest config sets `retry: > 0` (PEvO default: `retry: 1`)"
  - "Production code under test emits a fire-and-forget side effect (no `await`; `.catch(() => {})` swallows errors)"
  - "Test asserts the side-effect count via strict equality (`toBe(N)`, `toHaveLength(N)`)"
  - "Cleanup is scoped to `beforeAll` / `afterAll` only, not `beforeEach`"
related_components:
  - authentication
  - database
tags:
  - vitest
  - retry
  - fire-and-forget
  - test-isolation
  - mutation-fence
  - audit-log
  - false-pass
---

# Vitest retry + fire-and-forget side effect + strict-equality count = self-poisoning test

## Context

Integration tests in PEvO use a class-level setup pattern (`beforeAll` / `afterAll`) to seed and tear down test users — the right shape for expensive HAF-seeded state. The failure mode in this convention surfaces when a test additionally asserts the count of a **fire-and-forget side effect** (an audit row written via `logCustodyBroadcast(...).catch(() => {})` or similar non-awaited call), while `vitest.config.ts` carries `retry: 1`.

This combination is invisible in normal CI runs — the retry-poisoning only manifests when attempt #1 fails for *any* reason (a timing hiccup, an unrelated flake, a slow CI runner). At that point the retry runs the route a second time, the fire-and-forget side effect fires again, and the strict-equality assertion fails in a way that masks the original failure cause entirely.

The copy-paste vector is real: `backend/tests/routes/recover.test.ts:602-633` uses the same shape (fire-and-forget audit write + strict-equality count assertion + class-level cleanup). It does not visibly trip today because the race window is narrow and retries are rare in practice. Any future agent reading `recover.test.ts` as a template for a new test family will replicate the structure without seeing the failure mode.

## Guidance

**Trigger conditions — all three must hold simultaneously:**

1. Production code emits a fire-and-forget side effect (no `await`; microtask completes after response is sent). Example: `logCustodyBroadcast(username, 'upgrade_failure').catch(() => {})`.
2. The test asserts the side-effect count via strict equality: `expect(auditRows.length).toBe(1)`.
3. `vitest.config.ts` has `retry: > 0` (PEvO default: `retry: 1`).

**Prescribed remedy: add a `beforeEach` reset that `DELETE`s the fire-and-forget rows for the seeded entities.** Scope the delete to the seeded usernames only — never wipe the whole table.

**Before** (bug-prone shape — class-level cleanup only, retry attempts share state):

```typescript
beforeAll(async () => {
  await seedTestUsers(pool);
});

afterAll(async () => {
  await cleanupTestUsers(pool);
});

it('logs upgrade_failure on null hash', async () => {
  const res = await request(app).post('/api/custody/upgrade').send({ username, password });
  expect(res.status).toBe(401);

  // DANGER: strict equality + fire-and-forget + retry: 1 = self-poisoning
  const { rows: auditRows } = await pool.query(
    `SELECT * FROM custody_audit_log WHERE username = $1 AND operation_type = 'upgrade_failure'`,
    [username]
  );
  expect(auditRows.length).toBe(1);
});
```

**After** (corrected shape — `beforeEach` resets the fire-and-forget rows):

```typescript
beforeAll(async () => {
  await seedTestUsers(pool);
});

afterAll(async () => {
  await cleanupTestUsers(pool);
});

// Reset fire-and-forget side-effect rows before each test so a retried
// attempt starts from a clean count. Required when retry > 0 and the
// assertion uses strict equality on a non-awaited write.
beforeEach(async () => {
  await pool.query(
    `DELETE FROM custody_audit_log WHERE username = ANY($1::text[])`,
    [[username, otherUsername]],  // scope to seeded entities only
  );
});

it('logs upgrade_failure on null hash', async () => {
  const res = await request(app).post('/api/custody/upgrade').send({ username, password });
  expect(res.status).toBe(401);

  const { rows: auditRows } = await pool.query(
    `SELECT * FROM custody_audit_log WHERE username = $1 AND operation_type = 'upgrade_failure'`,
    [username]
  );
  expect(auditRows.length).toBe(1);  // safe: beforeEach guarantees zero rows on entry
});
```

**Rejected fix shapes:**

- **Loosen the assertion to `>= 1`.** False-passes on retry by itself (any number of rows passes); harmless when paired with the `beforeEach` reset above but redundant. Skip unless the `beforeEach` shape isn't applicable.
- **`await` the fire-and-forget call in production.** Eliminates the race AND the retry-poisoning, but converts audit-log semantics from non-blocking to blocking. The PEvO convention `auth-structured-log-shape-2026-04-29.md` endorses fire-and-forget on production code; one test's reliability needs must not drive a production-shape change.
- **Disable `retry` per-file in vitest.** Heavy-handed; surfaces the underlying flakiness instead of masking it via retry, but loses the genuine flake mitigation retry was added for. Use only as a last resort when the `beforeEach` shape genuinely cannot be applied.

## Why This Matters

**The retry-poisoning cascade:**

1. Attempt #1 fails — for *any* reason. The route ran, the fire-and-forget side effect queued a write, and by the time `SELECT` runs the microtask may or may not have committed (race). Attempt #1 reports one failure cause (status code mismatch, timing, anything).
2. Vitest retries the same `it` block. The route runs again. The fire-and-forget write fires again. Because cleanup is `afterAll`, the first attempt's row is still in the table. A SECOND row lands.
3. Attempt #2's `expect(auditRows.length).toBe(1)` sees `2`. Fails. The assertion that was supposed to be the mutation fence now reports `expected 2 to be 1` — which is *not* the original failure cause.
4. The test suite reports the wrong failure. The developer investigates the audit log count, not the actual bug. Ground truth is gone.

**"Looks fine in CI today" is not evidence of safety.** The failure mode requires attempt #1 to fail first. In a healthy CI run attempt #1 passes, retry never fires, and the poisoning is latent. The first time a slow runner or an unrelated flake causes attempt #1 to fail, the retry-poisoning activates and the diagnostic signal inverts — silently. This compounds with mutation-fence tests specifically: a test that was supposed to detect a regression stops detecting it, and instead surfaces a count-mismatch that points the investigator at the wrong code.

This convention extends rather than replaces `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. The mutation-fence convention is about test *design* (make sure the test can fail when the production code is broken). This convention is about test *environment* (make sure retry doesn't corrupt the DB state the test depends on, masking the failure even if the test design is sound). Both axes have to hold.

## When to Apply

Add a `beforeEach` side-effect row reset when **all three** of the following are true:

- The production code path under test writes a row via a fire-and-forget call (no `await`, `.catch(() => {})` or `.catch(noop)` swallows errors).
- The test asserts the row count with strict equality (`toBe(N)` or `toHaveLength(N)`).
- `vitest.config.ts` has `retry: 1` or higher (the PEvO project default).

The pattern is safe to omit when **any one** condition is absent:

- If the production write is `await`ed, there is no race and the count is deterministic from a single attempt.
- If the assertion uses `>= 1` (or just checks existence, not exact count), a doubled row does not flip the assertion.
- If the file overrides `retry: 0` (vitest supports per-file retry config), there is no second attempt to poison. Not a recommended escape hatch — `retry: 0` loses flake mitigation across the whole file.

**Boundary: `beforeEach` vs narrower scopes.** If only one `it` in a suite asserts side-effect counts, a file-level `beforeEach` that `DELETE`s rows is still correct and simpler than a per-test setup. Always scope the `DELETE` to the seeded usernames (`WHERE username = ANY($1::text[])`) to avoid cross-test contamination — never wipe the whole table.

## Examples

**Originating instance** (the bug as landed): `backend/tests/routes/custody-upgrade-null-hash.test.ts:147-152` (null-hash case) and `:191-196` (wrong-password baseline). Production fire-and-forget: `backend/src/routes/custody.ts:228`. Retry config: `backend/vitest.config.ts` (`retry: 1`). Filed as round-3 hold-block item 1 (P1) on `agents/docs/tasks/pending/backend-password-hash-null-typing-audit.md`.

**Latent sibling** (not yet tripping, but structurally identical): `backend/tests/routes/recover.test.ts:602-633`. Same shape — fire-and-forget audit write + strict-equality count assertion + class-level `beforeAll` / `afterAll` cleanup, no `beforeEach` row reset. Safe only because attempt #1 has not failed under retry in practice; any future CI instability will activate the same poisoning cascade.

**Minimal `beforeEach` fix** (PEvO style — raw parameterized SQL via `pool.query`):

```typescript
// Place immediately after the afterAll block.
// Scoped delete: only rows for usernames seeded in this test file's beforeAll.
beforeEach(async () => {
  await pool.query(
    `DELETE FROM custody_audit_log
     WHERE username = ANY($1::text[])`,
    [[seededUsername, secondSeededUsername]],
  );
});
```

If the audit table is in a non-default schema, qualify it: `DELETE FROM pevo_app.custody_audit_log WHERE ...`.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — mutation-fence design discipline. This convention captures the orthogonal failure mode: the fence is correctly designed, but retry-poisoning erodes its signal.
- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the test family (argon2 sub-branch oracles) where this retry-poisoning failure mode surfaced.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — endorses the fire-and-forget `logCustodyBroadcast(...).catch(() => {})` shape on production code; documents why the "add `await` in production" fix shape is rejected.
- `agents/docs/solutions/conventions/js-coercion-mutation-kill-vector-2026-05-04.md` — sibling test-design convention; both address false-pass / ground-truth erosion in differential and mutation tests, but via different mechanisms.
- `agents/docs/solutions/conventions/vitest-fake-timers-module-private-state-isolation-2026-04-29.md` — sibling vitest isolation pattern for module-private state. Complementary: that convention handles in-memory module state reset; this one handles DB side-effect row reset. Both lean on test-lifecycle hooks for isolation.
