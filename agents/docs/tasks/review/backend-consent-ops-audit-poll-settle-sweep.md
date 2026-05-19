# BACKEND-CONSENT-OPS-AUDIT-POLL-SETTLE-SWEEP — extract `fetchSettledAuditRows` to `tests/support/` and migrate 5 sibling inline poll-loops

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, cluster review of `backend-recover-test-retry-self-poisoning-fix` round-1 surfaced 5 unrepaired sibling sites)
**Priority:** P3
**Blocked-until:** any in-flight worktree work on `backend/tests/routes/custody-consent-ops.test.ts` is merged to main (per `worker-fanout-helper-name-divergence-2026-05-15.md` convergence-sweep timing rule)

## Context

`backend-recover-test-retry-self-poisoning-fix` round-1 introduced a module-local `fetchSettledAuditRows(pool, username, operationType)` helper in `backend/tests/routes/recover.test.ts`. Shape: poll up to 1.5s @ 25ms intervals for `rows.length >= 1`, then 100ms settle, then re-SELECT and return the settled count. The 100ms settle window catches an in-flight retry-poisoned second INSERT before the count assertion runs — mutation-kill on the over-log production change class.

The implementer kept the helper module-local because `backend/tests/routes/custody-consent-ops.test.ts` was concurrently edited in a parallel worktree at the time; extracting to `backend/tests/support/` would have collided with that worktree's edits. Per `worker-fanout-helper-name-divergence-2026-05-15.md`, the convergence sweep is the prescribed post-fan-out action.

The `/ce-code-review` reliability persona on commit `96dab9d` (RLB-004, conf 75) identified 5 inline poll-loop sites in `custody-consent-ops.test.ts` (around lines 479, 527, 563, 615, 667 at the time of the review — anchor on the surrounding `it` block names rather than line numbers, since those will drift). All 5 use the same poll-until-`>= 1`-row shape as the new helper, but NONE have the 100ms settle window. The `beforeEach` reset at consent-ops describe-block level already neutralizes the three-condition retry-poisoning trigger documented in `vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md`, so this is coverage-asymmetry rather than active bug — a future double-INSERT mutation on a consent-ops audit path would silently slip past the missing settle.

## Goal

1. **Extract `fetchSettledAuditRows` to `backend/tests/support/`.** Choose a descriptive filename (e.g., `audit-log-poll-settle.ts` or whatever fits the existing `support/` naming style; check `argon2-error-mocks.ts`, `redis-helpers.ts`, `timing-constants.ts` for the convention). The exported function signature stays the same as the current module-local form.
2. **Update `backend/tests/routes/recover.test.ts` to import from the shared location.** Remove the module-local declaration. The two existing call sites in `recover.test.ts` continue to work unchanged.
3. **Migrate the 5 inline poll-loop sites in `backend/tests/routes/custody-consent-ops.test.ts`** to use the shared helper. Each migration replaces a hand-rolled `while (...)` poll with a single `fetchSettledAuditRows(pool, username, operationType)` call. The existing `beforeEach` reset at the consent-ops describe-block stays in place — it's still load-bearing for the three-condition trigger.
4. **Verify mutation-kill at each migrated site.** For each of the 5 migrated specs, the assertion that follows the helper call MUST still kill the over-log mutation class (a hypothetical production change that INSERTs the audit row twice). The 100ms settle window is what makes this work — without it, the count assertion fires on the first INSERT and the second slips past unseen.
5. **Run the convergence-sweep grep** prescribed by `worker-fanout-helper-name-divergence-2026-05-15.md` after extraction lands:

   ```
   rg -n "fetchSettledAuditRows|poll.*audit|audit.*settle|custody_audit_log.*poll" backend/tests/
   ```

   Confirm zero divergent helpers remain — any sibling test file that independently created a structurally identical helper under a different name converges to the shared form before the task archives.

## Acceptance

1. `backend/tests/support/<descriptive-name>.ts` exports `fetchSettledAuditRows` with the canonical signature.
2. `backend/tests/routes/recover.test.ts` imports from the shared location; module-local declaration removed.
3. `backend/tests/routes/custody-consent-ops.test.ts` migrates all 5 sibling poll-loop sites to the shared helper. Each migration preserves the per-call `username` and `operationType` discriminators.
4. `npx tsc --noEmit -p backend/tests/tsconfig.json` clean.
5. `npm run lint` clean.
6. `npx vitest run tests/routes/recover.test.ts tests/routes/custody-consent-ops.test.ts` passes against real Postgres + Redis (per root CLAUDE.md "Running Tests" Docker-network override).
7. Convergence-sweep grep returns zero unmigrated sites for the patterns above (exempt: the shared helper file itself, and any test fixture that genuinely needs a different poll shape with documented reasoning).

## Out of scope

- Other test files (not `recover.test.ts` or `custody-consent-ops.test.ts`) — file separately if/when a future review surfaces them.
- Changing the 1500ms poll budget or 100ms settle window — those are the convention's prescribed parameters at this point in time. If CI flakes emerge on slow shared-CI hosts, raise as a separate task.
- Migrating `afterAll` teardown sweeps to the shared helper — those are teardown, not retry-poisoning defense; not in scope.
- Adding `await` to the production fire-and-forget audit-log call sites in `backend/src/routes/auth.ts` or sibling production code — explicitly rejected by `auth-structured-log-shape-2026-04-29.md` and the convention's "Rejected fix shapes" section.

## Dependencies

This task is blocked until any in-flight worktree work on `backend/tests/routes/custody-consent-ops.test.ts` is merged to main. Per the `worker-fanout-helper-name-divergence-2026-05-15` convergence-sweep timing rule, premature extraction creates a cross-worktree staging race. Implementer should verify with `git log --all --oneline -- backend/tests/routes/custody-consent-ops.test.ts | head` that no parallel worktree has unmerged commits before starting.

## References

- `agents/docs/solutions/conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` — the canonical three-condition trigger and the `beforeEach` reset shape. The 100ms settle window is an additive defense layered on top of the `beforeEach`.
- `agents/docs/solutions/conventions/worker-fanout-helper-name-divergence-2026-05-15.md` — the convergence-sweep rule that gates extraction timing.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — fire-and-forget audit-log endorsement; explains why the production code stays unchanged.
- `backend/tests/routes/recover.test.ts` — the canonical implementation of `fetchSettledAuditRows` (module-local at task creation time; will be the import source after extraction).
- `backend/tests/support/argon2-error-mocks.ts`, `backend/tests/support/redis-helpers.ts`, `backend/tests/support/timing-constants.ts` — exemplars of the `tests/support/` convention.

## Priority rationale

P3 because the existing `beforeEach` reset at the consent-ops describe-block already neutralizes the active three-condition retry-poisoning trigger. The 100ms settle gap is defense-in-depth against a hypothetical future double-INSERT mutation — important enough to close (the convention catalog should not carry known unrepaired siblings as a quiet permanent debt), but not urgent against in-flight work. Worth bundling with any future task that touches consent-ops or the shared support/ directory.

## Backend implementation signal (2026-05-19, parent merge of worktree-agent-a5948b9afa8f81f05; commits 7403151 + 89da9c4)

All 7 acceptance items landed, plus a deliberate signature deviation worth surfacing for review.

**Sites landed:**

- `backend/tests/support/audit-log-poll-settle.ts` (new) — exports `fetchSettledAuditRows(pool, username, operationType)` with the canonical signature, AND a flexible companion `fetchSettledAuditRowsWith<TRow>({ pool, username, columns, minRows?, orderBy? })` documented in the file header. Both share the identical 1500ms-poll / 25ms-interval / 100ms-settle invariant — only the row-shape and predicate vary.
- `backend/tests/routes/recover.test.ts` — module-local declaration removed; both call sites now import `fetchSettledAuditRows` from the shared location and continue to pass `(pool, TEST_USER, 'recovery_failure' | 'account_recovery')` unchanged.
- `backend/tests/routes/custody-consent-ops.test.ts` — all 5 inline poll-loop sites migrated to `fetchSettledAuditRowsWith<TRow>(...)`. The 5 sites previously polled by hand: per-call SELECT shapes vary (one selects 5 columns including `operation_type / auth_mechanism / fresh_auth_outcome / session_id / user_agent`; one selects 5 different columns; one selects `user_agent` only; two need `minRows: 2` filtering on two distinct operation types in a single username scope with `ORDER BY created_at ASC`). The `beforeEach` reset at the describe-block stays in place; load-bearing for the three-condition retry-poisoning trigger.

**Signature deviation (architect please flag if not acceptable):**

The task's goal #1 prescribes "the exported function signature stays the same as the current module-local form". Sites 3, 4, and 5 in `custody-consent-ops.test.ts` do not fit `(pool, username, operationType)` — they filter by username only (sites 4 and 5 expect rows from two distinct operation types in one poll), use varied column lists, and 2 of them need `minRows: 2` with `ORDER BY created_at ASC` to assert the second-INSERT settled. The implementer resolved this by:

- Keeping `fetchSettledAuditRows(pool, username, operationType)` unchanged (recover.test.ts uses it as-is — its existing behavior is preserved).
- Exporting `fetchSettledAuditRowsWith<TRow>({ pool, username, columns, minRows?, orderBy? })` in the same file, sharing the identical poll + settle invariant via internal delegation.

The convergence-sweep concern — divergent helpers solving the same problem under different names — is satisfied: both live in one file and share the invariant explicitly. The acceptance #7 exemption clause ("any test fixture that genuinely needs a different poll shape with documented reasoning") covers this, though the exemption was prescribed for unmigrated sites rather than for a co-located companion. If the architect prefers the strict-uniform-signature reading instead, the next round can collapse `fetchSettledAuditRows` into `fetchSettledAuditRowsWith` with a defaulting `columns: ['operation_type', 'user_agent']` and migrate the 2 recover.test.ts call sites to the new shape — happy to do that in a follow-up round if held.

**Convergence-sweep grep (acceptance #7):**

```
rg -n 'fetchSettledAuditRows|poll.*audit|audit.*settle|custody_audit_log.*poll' backend/tests/
```

Returns only: the shared helper file (with its docblocks and exports), 5 `fetchSettledAuditRowsWith` call sites in custody-consent-ops.test.ts, 2 `fetchSettledAuditRows` call sites in recover.test.ts. Zero divergent helpers.

**Verification gates:**

- `cd backend && npx tsc --noEmit -p tests/tsconfig.json` — clean.
- `cd backend && npm run lint` — clean.
- Parent serialized run: `npx vitest run tests/routes/recover.test.ts tests/routes/custody-consent-ops.test.ts tests/routes/citations-lateral-guard-canary.test.ts tests/notification-queries-lateral-guard-canary.test.ts` — **66/66 passed** against real Postgres + Redis (4 test files, includes the sibling jsonb-lateral canaries co-merged in the same fan-out wave).
