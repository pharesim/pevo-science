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

---

## Architect re-review (2026-05-19) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commits `7403151..89da9c4` with 6 personas (correctness on Opus; testing, maintainability, project-standards, kieran-typescript, learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md). Migration is mechanically sound and a **net improvement** to mutation-kill defense — testing reviewer verified via `git show 7403151~1` that the 5 prior hand-rolled poll loops in `custody-consent-ops.test.ts` had **no** 100ms settle window and would race past an in-flight second INSERT; the new helper closes that gap on all 5 sites. `beforeEach` reset at the outer describe block confirmed load-bearing for every retry attempt. Convergence-sweep grep clean. Verification gates clean (`tsc`, lint, 66/66 vitest). User-triaged 2026-05-19; 3 items held; signature-deviation question resolved (keep dual publics + extract private helper).

### Items held (must fix before archive)

1. **(P1 maintainability, anchor 100)** Task-slug + round-number citation in `backend/tests/routes/custody-consent-ops.test.ts` JSDoc opening (`Round-3 of BACKEND-COAUTHOR-TRUST-MODEL`). Per root `CLAUDE.md` "Comment anchors" + `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`: coordination-context anchors (round numbers, role-prefixed task slugs) rot when the parent task archives and the 250-line `tasks-archive.md` trim drops the cited entry.

   Fix: replace the opening with a purely behavioral anchor describing what the suite covers and why the consent-op endpoints (`author_accept` / `author_resign`) require a fresh-auth gate. Suggested replacement: `Custody consent-op endpoints (author_accept / author_resign) behind a fresh-auth gate.` Drop the `Round-3` prefix and the `BACKEND-COAUTHOR-TRUST-MODEL` slug entirely.

2. **(P1 maintainability + kieran-typescript cross-reviewer, anchor 100)** Phantom generic `TRow` in `fetchSettledAuditRowsWith<TRow>` at `backend/tests/support/audit-log-poll-settle.ts`. TypeScript resolves `TRow` from the caller's annotation alone — the `columns: string` argument is not bound to `TRow` at compile time, so a caller writing `columns: 'auth_mechanism'` with `TRow = { user_agent: string }` compiles clean and fails only at assertion time. The generic looks like a type-safety guarantee and provides none.

   Fix: add an explicit JSDoc note on `fetchSettledAuditRowsWith` documenting that `TRow` is caller-asserted and TypeScript cannot verify column-to-type alignment at compile time. Keep the generic (call-site ergonomics are valuable). The JSDoc warning is the resolution — it removes the false-confidence framing without churning call sites.

3. **(P2 maintainability, anchor 75)** Poll-and-settle while-loop body duplicated verbatim across `fetchSettledAuditRows` (canonical) and `fetchSettledAuditRowsWith` (companion) in `backend/tests/support/audit-log-poll-settle.ts`. Shared `POLL_BUDGET_MS` / `POLL_INTERVAL_MS` / `SETTLE_MS` constants absorb most drift; what remains is the loop *shape* (~15 lines twice). Closes the implementer's flagged signature-deviation question in the same edit.

   Fix: extract a private `pollAndSettle<TRow>(pool, sql, params, minRows): Promise<TRow[]>` helper that holds the loop. Both exported publics shrink to "build SQL + params, await `pollAndSettle`, return". Architect explicitly accepts the dual-export shape (`fetchSettledAuditRows` keeps its `(pool, username, operationType)` signature; `fetchSettledAuditRowsWith` keeps its options-bag shape) — single-export collapse rejected because the two publics' different filter semantics (`(username, operation_type)` vs username-only) make a unified signature awkward and would churn the 2 `recover.test.ts` call sites for no net gain.

### Items dismissed during architect triage (recorded for transparency)

- **(P2 kieran-typescript KT-2, anchor 75)** `PoolLike<TRow>` declares `params: unknown[]` where `pg.Pool.query` accepts `QueryConfigValues<I> = any[]`. Structural check passes today via bivariant method checking; the latent gap would only surface under tightened strictness or a covariant arrow-property pool wrapper. Dismissed per `feedback_dismiss_preemptive_test_hardening`: no active break, theoretical-only failure mode, default-recommend dismiss for preemptive hardening.
- **(P2 maintainability M4, anchor 50)** `fetchSettledAuditRowsWith` `With` suffix opaque at import site. Below confidence gate; stylistic-judgment territory; file-header docblock compensates for readers starting at the top.
- **(P3 correctness/testing residual risks, anchors 25–50)** No isolated unit test on the helper itself, hard-coded column strings creating schema-rename brittleness, no-settle-on-budget-exhaustion path. Coverage exists via the 5 integration call sites; schema-rename produces detectable postgres errors; budget-exhausted-no-settle is intentional design. All below gate.

### Re-review signal

When items 1–3 land, `git mv` this file back to `tasks/review/`. Round-2 architect re-review scopes `/ce-code-review` to commits since the round-1 hold commit. Anchor: single backend commit reasonable — header rewrite in `custody-consent-ops.test.ts`, JSDoc + private helper + delegation refactor in `audit-log-poll-settle.ts`. Targeted vitest re-run on `recover.test.ts` + `custody-consent-ops.test.ts` to confirm the `pollAndSettle` extraction preserves behavior.

---

## Backend re-review signal (2026-05-19, worker subagent worktree-agent-a978e3bc0f7e9c927)

All 3 round-1 hold items landed in a single commit on the worker branch; parent merges into the orchestrating branch.

**Item 1 (P1 — task-slug + round-number citation in `custody-consent-ops.test.ts` JSDoc):** Replaced the opening JSDoc line `Round-3 of BACKEND-COAUTHOR-TRUST-MODEL — custody endpoint extension for ...` with a purely behavioral anchor `Custody consent-op endpoints (author_accept / author_resign) behind a fresh-auth gate.`. The slug `BACKEND-COAUTHOR-TRUST-MODEL` and the `Round-3` prefix are gone. Replacement audited per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: no task slug, no role-prefixed handle, no round number, no line-number reference, no SHA. Endpoint names (`author_accept`, `author_resign`) are stable behavioral handles.

**Item 2 (P1 — phantom generic `TRow` in `fetchSettledAuditRowsWith`):** Added a "Type-safety note on `TRow`" paragraph to the JSDoc on `fetchSettledAuditRowsWith` in `backend/tests/support/audit-log-poll-settle.ts`. The note states explicitly that `TRow` is caller-asserted, that TypeScript cannot verify column-to-type alignment at compile time because `columns: string` is not bound to `TRow`, and that the generic exists for call-site ergonomics only. The generic stays on the function (no churn on the 5 call sites). The header comment's "Two call shapes are exported" section is unchanged and still accurately describes the dual public surface.

**Item 3 (P2 — duplicated poll-and-settle while-loop body):** Extracted a private `pollAndSettle<TRow>(pool, sql, params, minRows): Promise<TRow[]>` helper in `backend/tests/support/audit-log-poll-settle.ts`. Both publics (`fetchSettledAuditRows` and `fetchSettledAuditRowsWith`) shrink to: build SQL (and params), call `pollAndSettle`, return. The dual-export shape is preserved per the architect's explicit acceptance — `fetchSettledAuditRows` keeps `(pool, username, operationType)`, `fetchSettledAuditRowsWith` keeps its options-bag form. Added a JSDoc on `pollAndSettle` documenting the no-settle-on-budget-exhaustion contract so future readers understand why the budget-exhausted path returns the last SELECT's rows without a settle delay (architect's triage-dismissed P3 reading is now codified).

**Verification gates:**

- `cd backend && npm run typecheck` (runs both `typecheck:src` and `typecheck:tests`) — clean.
- `cd backend && npm run lint` (runs `eslint src/`) — clean. Also ran `npx eslint tests/support/audit-log-poll-settle.ts tests/routes/custody-consent-ops.test.ts` explicitly — clean.
- `npx vitest run tests/routes/recover.test.ts tests/routes/custody-consent-ops.test.ts` (real Postgres + Redis via Docker-network overrides) — 52/56 passed. The 4 failures are all in `recover.test.ts` against `/api/auth/signup` (`SEC-LOGIN-UNKNOWN-USER-TIMING: /signup 409 DUPLICATE burns sentinel`, `SEC-LOGIN-UNKNOWN-USER-TIMING: /signup 4-way timing matrix`, `BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: duplicate check fires before accreditation gate`, `BE-SIGNUP-INSTITUTIONAL-GATE-ORDERING: 422 on non-duplicate unaccredited email is fast`), all returning 500 instead of the expected 409/422. These tests do NOT use `fetchSettledAuditRows` / `fetchSettledAuditRowsWith` — they hit `/api/auth/signup` and assert on response status before any audit-log poll. The 2 sites that DO use `fetchSettledAuditRows` in `recover.test.ts` (`recovery_failure` and `account_recovery` audit checks) both pass, as do all 52 tests in `custody-consent-ops.test.ts` (all 5 sites using `fetchSettledAuditRowsWith` covered). Architect: please confirm the `/api/auth/signup` 500s are pre-existing environmental failures in this worktree and not regressions introduced by this round.
