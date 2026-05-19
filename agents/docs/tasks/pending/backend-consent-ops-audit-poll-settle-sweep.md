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
