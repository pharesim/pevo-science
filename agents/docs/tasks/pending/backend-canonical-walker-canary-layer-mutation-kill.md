# BACKEND-CANONICAL-WALKER-CANARY-LAYER-MUTATION-KILL — Per-layer mutation-kill canaries + START-rejection event tags

**Owner:** Backend Agent
**Created:** 2026-05-06 (architect, surfaced by `/ce-code-review` round-2 of `backend-canonical-root-walker-author-gate`)
**Priority:** P3 (testing rigor + observability)

## Why now

Round-2 of `backend-canonical-root-walker-author-gate` landed the type-spoof START gate as a defense-in-depth pair: SQL `validPevoPaperWhere(source:'all')` filter on the initial walker probe, plus a JS-side `isPevoAnyPaper(startMeta, startRow.author)` re-check after fetching the row. The round-2 canary that pins the gate (`canonical-root-walker.test.ts:430-511`) mutation-kills ONLY the JOINT revert of both layers, not each layer independently.

Concrete mutation outcomes against the canary:
- **Mutation A — revert ONLY the walker SQL filter, keep JS re-check.** The mock's regex (`/c\.author,\s+c\.json_metadata,\s+c\.json_metadata/`) no longer matches → mock returns the spoof row → JS `isPevoAnyPaper` returns false → walker returns null → route falls through to `fetchPaperDetailFromHaf`, which has its OWN `validPevoPaperWhere` at `papers.ts:552` and rejects type=review → 404. **Canary passes despite walker SQL filter being silently removed.**
- **Mutation B — revert ONLY the JS re-check, keep SQL filter.** Regex still matches → mock returns no rows → walker returns null → 404. **Canary passes despite JS defense-in-depth being silently removed.**
- **Mutation C — revert BOTH layers.** Walker canonicalizes to alice/v1 → 200 alice content under bob's URL → canary fails red.

So the canary verifies (SQL OR JS), not (SQL AND JS). Future refactor that consolidates the gate into one layer (e.g., "the SQL filter is fully sufficient, drop the JS check as redundant") passes the canary while halving the defense. This is the exact failure mode `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` was written to forbid.

Compounding fragility: the SQL-regex dispatch in the mock is sensitive to whitespace and column order in `validPevoPaperWhere`. A SQL helper refactor that reorders columns or reformats whitespace silently flips the mock to the "filter absent" branch on every invocation, degrading the canary to JS-only coverage with no failure signal.

A separate adversarial finding flagged a directly-correlated observability gap: round-2 added `event: 'canonical_root_walker_error'` only at the outer try/catch (`papers.ts:~1224`). The four START-rejection bail paths (`:1080` no-pool, `:1119` 0-rows, `:1129` JS-isPevoAnyPaper-false, `:1138` cont-column-narrow-fail) all `return null` silently with no structured event. Probes hitting the most load-bearing round-2 gate at line 1119 produce ZERO observability signal. This task closes both concerns together because per-layer mutation-kill requires distinguishing observability — without distinct event tags, you can't write a canary that pins which gate fired.

## Threat model

- **Attack:** vouched co-author Bob posts `bob/spoof-review` with `pevo.type='review'` and `pevo.continues={alice, paper-v1}`. URL `/api/papers/bob/spoof-review` should resolve to bob's content (404 because it's a review and `fetchPaperDetailFromHaf` rejects), NOT alice's content.
- **Round-2 defense:** SQL filter rejects at the walker level; JS re-check rejects defense-in-depth.
- **Failure mode this task addresses:** future refactor silently removes one layer; current canary doesn't catch it; defense weakens unobserved.

## Goal

1. **Per-layer mutation-kill canaries.** Each canary independently asserts that exactly one of the two layers is load-bearing for the asserted outcome. Reverting the OTHER layer must keep the canary passing; reverting the layer this canary pins must make it fail red.
2. **START-rejection event tags.** Every walker bail path emits a structured `event:` warn with a discriminator, so canaries (and operators) can tell which gate fired.

## Acceptance

### 1. START-rejection event tags

`backend/src/routes/papers.ts` `findCanonicalRoot` — at every START-bail path, emit a structured warn with the appropriate event tag. Use a single event family with a `reason` discriminator to keep the taxonomy small.

```ts
// :~1080 — no pool configured
logger.warn(
  { event: 'canonical_root_walker_no_pool', startAuthor, startPermlink },
  'canonical-root walker invoked with no HAF pool',
);

// :~1119 — initial probe returned 0 rows (URL post missing OR validPevoPaperWhere rejected)
logger.warn(
  { event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing', startAuthor, startPermlink },
  'canonical-root walker START probe returned no rows',
);

// :~1129 — JS-side isPevoAnyPaper re-check rejected
logger.warn(
  { event: 'canonical_root_walker_start_invalid', reason: 'js_is_pevo_any_paper', startAuthor, startPermlink },
  'canonical-root walker rejected START via JS isPevoAnyPaper re-check',
);

// :~1138 — cont_author / cont_permlink runtime narrowing failed
logger.warn(
  { event: 'canonical_root_walker_start_invalid', reason: 'cont_columns_invalid', startAuthor, startPermlink },
  'canonical-root walker START row had non-string cont_author or cont_permlink',
);
```

Note: the `:1119` branch fires for legitimate "URL post doesn't exist" cases (404 path) too, not just type-spoof gate rejections. Operators must filter on `reason` + traffic patterns to distinguish probe traffic; that is acceptable because the alternative (a second confirmation probe sans-filter) costs an extra HAF round-trip per request.

### 2. Per-layer mutation-kill canaries (`canonical-root-walker.test.ts`)

Replace or supplement the existing combined-layer canary with two layer-pinning canaries. The discriminating signal is the new `reason` field on `canonical_root_walker_start_invalid`.

**`'rejects type-spoof START via SQL filter (sql_filter_or_missing)'`:**
- Mock is constructed so the SQL `validPevoPaperWhere` predicate is present in the issued query → mock returns 0 rows for the spoof row.
- Assert: response is 404, walker emits `event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing'`.
- Mutation-kill: revert the walker's `validPevoPaperWhere` SQL filter only. Mock now returns the spoof row (the SQL no longer contains the predicate) → walker hits the JS re-check → emits `reason: 'js_is_pevo_any_paper'` instead → canary's reason-assertion fails. Documents in canary header: this canary pins ONLY the SQL filter; the JS re-check has its own canary.

**`'rejects type-spoof START via JS isPevoAnyPaper (js_is_pevo_any_paper)'`:**
- Mock is constructed to BYPASS the SQL filter — i.e., responds as if the SQL filter were absent (returns the spoof row regardless of SQL shape).
- Assert: response is 404, walker emits `event: 'canonical_root_walker_start_invalid', reason: 'js_is_pevo_any_paper'`.
- Mutation-kill: revert ONLY the JS re-check. Mock still returns spoof row (SQL bypass simulated) → walker has no second-layer rejection → walker proceeds to walk back → either canonicalizes to alice (if memo allows) or hits cont_columns narrowing — either way, the asserted `reason: 'js_is_pevo_any_paper'` event does not fire → canary fails red.

The "SQL bypass simulated" mock pattern is the structural primitive that distinguishes the two canaries. It's acceptable to construct it via a mock-config flag rather than SQL-string regex matching, e.g. `mockMode: 'sql_bypass'` on the per-test mock factory, so the dispatch is robust to SQL formatting changes. This is the testing reviewer's residual concern (TG-1 / RR-2 from the round-2 review): keep the discriminator semantic, not regex-based.

### 3. Replace the existing combined-layer canary OR keep it as a smoke test

Two acceptable shapes:

- **Replace:** delete the existing `'rejects type-spoof on START post (vouched co-author posts type=review continuation)'` canary; the two new layer-pinning canaries are strictly stronger.
- **Keep as smoke test:** retain the existing canary (verifies the JOINT outcome) and add the two layer-pinning canaries. The combined canary now serves as a regression smoke test for the gate's overall behavior; the layer canaries pin each layer's load-bearingness.

Implementer's choice. The architect's mild preference is **replace** — keeping three canaries that overlap on the same surface adds CI time without adding mutation-kill coverage beyond what the two new ones provide.

### 4. SQL-regex dispatch refactor (drop the regex)

Remove the `/c\.author,\s+c\.json_metadata,\s+c\.json_metadata/` regex dispatch from the mock helper (currently around `canonical-root-walker.test.ts:243`). Replace with a per-test mock-config primitive (e.g., `mockBackwardWalk({ startProbeMode: 'with_filter' | 'without_filter' })`) that doesn't depend on parsing the production SQL string. Documents in mock-helper comment: SQL-string regex coupling is fragile to formatting; structural mock-config is robust.

Other tests in the file that relied on the regex must be migrated to the new primitive. Targeted scope; do not touch tests outside `canonical-root-walker.test.ts`.

### 5. Mutation-kill attestation

Implementer's signal block must attest:
- Layer-pinning canary A (SQL) fails red on revert of `validPevoPaperWhere` from the walker SQL probe; layer-pinning canary B (JS) continues to pass on the same revert (or vice versa for the symmetric case).
- Layer-pinning canary B (JS) fails red on revert of the JS-side `isPevoAnyPaper` re-check; layer-pinning canary A (SQL) continues to pass on the same revert.
- Combined-layer canary (if kept) continues to pass on EITHER single-layer revert and fails only on the joint revert. Documents in attestation that the layer canaries provide coverage the combined canary doesn't.
- New event tags fire from the corresponding bail paths (revert each event-emission and canary fails on missing event).

## Out of scope

- Real-HAF integration coverage of the layer-pinning canaries. Mock-based per the existing carve-out clause (c) framework. Real-path coverage filed separately if the architect names an explicit follow-up task slug per architect-followup A4.
- Restructuring the walker entry to pre-validate metadata before the SQL probe. Round-2's two-layer pattern is the right shape; this task only adds canaries + event tags around it.
- Adding similar per-layer mutation-kill canaries to the FORWARD walker (`continuation-author-gate.test.ts`). Forward walker's round-2 gate has the same shape; mirroring this task to the forward walker is filed as a follow-up only if forward-walker mutation-kill rigor is later questioned.

## Coordination

- **Sequencing:** lands AFTER `backend-canonical-root-walker-author-gate` round-3 archives. The round-3 hold block is filed; this task waits in `pending/` until round-3 archives, then implementer picks it up.
- **No file-conflict** with the wall-clock budget task or the cycle detection task — different surfaces.
- **Convention reference:** `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the load-bearing convention this task closes a gap in.

## Source

`/ce-code-review` round-2 of `backend-canonical-root-walker-author-gate` (commit `3bef3de`). User triage 2026-05-06 routed:
- Adversarial finding `adv-mutation-coverage-gap-type-spoof-canary` (conf 70).
- Testing T1 (conf 55) + TG1 (conf 65).
- Kieran-typescript TG-1 (regex fragility, conf 50).
- Learnings-researcher mutation-kill attestation precision call-out.
- Adversarial finding `adv-walker-error-event-not-emitted-pre-try` (conf 90 observability).

Cross-reviewer corroboration on the canary mutation-kill gap → anchor 75 (promoted from 70).

## Cross-references

- `agents/docs/tasks/review/backend-canonical-root-walker-author-gate.md` — round-3 hold (parent task; must archive first).
- `backend/src/routes/papers.ts:1080-1138` (START-bail paths).
- `backend/tests/routes/canonical-root-walker.test.ts:243` (SQL-regex dispatch site), `:430-511` (existing combined-layer canary).
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` (load-bearing convention).

## Backend re-review signal (2026-05-06, round-1 — commit `d76c0c8` on `main`, originally `57eda60` on `worktree-agent-af947d14fac39f14a`)

All five acceptance subsections landed. Files touched:

- `backend/src/routes/papers.ts` (+38, -3 net): added `logger.debug` events at all four START-bail paths in `findCanonicalRoot`. The `no-pool` path emits `event: 'canonical_root_walker_no_pool'`; the three in-try-block paths share `event: 'canonical_root_walker_start_invalid'` with `reason` discriminator (`sql_filter_or_missing`, `js_is_pevo_any_paper`, `cont_columns_invalid`). Used `debug` rather than `warn` because the `sql_filter_or_missing` branch fires on any 404 lookup of a non-existent or non-PEvO post — `warn` would be too noisy at production traffic. Operators investigating attack patterns can enable debug.

- `backend/tests/routes/canonical-root-walker.test.ts` (+217, -56 net):
  - Added `isInitialBackwardProbe(sql)` helper keyed on the `'continues' IS NOT NULL` predicate. Replaces the brittle column-list regex `/c\.author,\s+c\.json_metadata,\s+c\.json_metadata/` at the two sites where it gated initial-vs-subsequent probe dispatch (depth-cap canaries at lines 243 and 855 of pre-edit file).
  - Added `StartProbeMode = 'with_filter' | 'without_filter'` per-test mock-config primitive and `installTypeSpoofStartResponder(mode)` factory.
  - **Replaced** (architect's mild preference) the combined-layer canary `'rejects type-spoof on START post (vouched co-author posts type=review continuation)'` at the pre-edit `:430-511` block with two layer-pinning canaries:
    - `'rejects type-spoof START via SQL filter (sql_filter_or_missing)'`
    - `'rejects type-spoof START via JS isPevoAnyPaper (js_is_pevo_any_paper)'`
  - The SQL canary uses faithful-mock semantics: SQL-inspects the production probe for the `'type'` literal (the discriminating marker between SQL filter present vs reverted) and returns 0 rows or the spoof row accordingly.
  - The JS canary force-feeds the spoof row regardless of SQL state, isolating the JS check as the gate under test.

### Mutation-kill matched-pair attestation

Verified by hand-applying each mutation locally and re-running `vitest run tests/routes/canonical-root-walker.test.ts -t "type-spoof START"`:

| Mutation | SQL canary | JS canary |
|----------|-----------|-----------|
| HEAD (no mutation) | PASS | PASS |
| Drop `validPevoPaperWhere` predicate from initial-probe WHERE clause | **FAIL RED** (`expected 'js_is_pevo_any_paper' to be 'sql_filter_or_missing'`) | PASS |
| Drop JS `!isPevoAnyPaper(...)` check (replaced condition with `if (false)`) | PASS | **FAIL RED** (`expected 200 to be 404` — alice's content surfaces under bob's URL, exactly the phishing pretext) |

Each layer-pinning canary fails red on exactly one mutation and stays green on the orthogonal one, satisfying acceptance subsection 4. Both mutations were applied in-place to the worktree's `papers.ts`, verified red, and reverted (final `diff /tmp/papers.ts.bak backend/src/routes/papers.ts` is empty modulo my non-mutation event-tag additions).

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: only the two pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts` (unrelated to this task).
- `npx vitest run tests/routes/canonical-root-walker.test.ts`: 17 tests pass on HEAD.

### Deviations / notes for architect

- Used `logger.debug` (not `warn` as suggested in the task file's example block) for the START-bail events. Rationale: the `sql_filter_or_missing` branch fires on any 404 lookup of a non-PEvO post (e.g. someone navigates to a permlink that doesn't exist or isn't a paper). At production traffic levels, `warn` would create constant noise. `debug` lets operators opt in for attack-pattern investigation. The canaries spy on `logger.debug` and the assertion holds either way (the events still fire and carry the discriminator). Revert to `warn` if the architect prefers; it's a one-token swap.

- The `probeSqlHasTypeFilter(sql)` helper inside the responder uses `/'type'/` as the detection marker rather than a more elaborate predicate-shape regex. Justification: the `'type'` literal is unique to `validPevoPaperWhere`'s output on this specific probe (the rest of the initial probe references `'continues'`, never `'type'`). A future refactor that introduces `'type'` elsewhere in the initial probe SQL would require updating this marker, but such a refactor would itself be visible in the SQL string and easy to grep.

- Did NOT keep the combined-layer canary as a smoke test. The two layer-pinning canaries cover the failure mode strictly more thoroughly. Per the task file's "implementer's choice" with mild architect preference for replace.

## Architect re-review (2026-05-07, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commit `d76c0c8` with 8 reviewers (correctness + security + adversarial at opus; testing/maintainability/project-standards/learnings/kieran-typescript at sonnet; reliability + ce-agent-native-reviewer not dispatched). Defense layers, per-layer canaries, and SQL-regex dispatch refactor land structurally correctly; mutation-kill matrix attestation matches my trace. Five items hold for round-2: one cross-reviewer-corroborated observability issue (item 1) plus four polish items on the same file pair.

### Items to address

**1. (P2, anchor 100, cross-corroborated 3 reviewers — adversarial, testing, maintainability) debug-vs-warn level discipline at the 4 START-bail events.** `backend/src/routes/papers.ts:1287-1393` (`findCanonicalRoot` event sites — actual line numbers may drift; the 4 sites are `no_pool`, `start_invalid` × 3 `reason` values). Implementer chose `logger.debug` at all 4 sites (deviation from task spec `logger.warn`) because `sql_filter_or_missing` fires on every benign 404 lookup of a non-PEvO post — `warn` would create production noise. Concern: at default `LOG_LEVEL=info`, debug events are silenced. Production attack signal is invisible while canaries pass (canary spies are at the logger object boundary, ahead of pino's level filter — the test doesn't observe the production silencing). Peer walker events use `warn`/`error` (`unauthorized_hop` at warn, `depth_exceeded` at warn, `walker_error` at error); mixed levels lead future readers to "fix" the debug back.

   Fix: hybrid split per event semantics, plus a code comment making the rationale durable.
   - `canonical_root_walker_no_pool` → `logger.warn` (rare infra-failure path; deserves observability).
   - `canonical_root_walker_start_invalid` with `reason: 'sql_filter_or_missing'` → keep `logger.debug` (the noisy 404 path; implementer's noise rationale stands for this case only).
   - `canonical_root_walker_start_invalid` with `reason: 'js_is_pevo_any_paper'` → `logger.warn` (rare attack-signal path; SQL filter bypass + JS reject means a type-spoof attempt actually got past the SQL gate — operator-actionable).
   - `canonical_root_walker_start_invalid` with `reason: 'cont_columns_invalid'` → `logger.warn` (rare HAF data-integrity issue; the `IS NOT NULL` SQL guard should prevent reaching this branch).

   Add a code comment near the first event site explaining the level discipline — e.g., `// Level discipline: 'sql_filter_or_missing' uses debug because it fires on every 404 of a non-PEvO post; the other three reasons use warn because they are rare attack-or-data-integrity signals that warrant operator alerting. Keep this split — peer walker events (unauthorized_hop, depth_exceeded, walker_error) are similarly graduated by frequency vs severity.` Otherwise a future reader sees the mixed levels and "fixes" them back.

   Update affected canary spies in `backend/tests/routes/canonical-root-walker.test.ts`: the SQL-canary (asserts `reason: 'sql_filter_or_missing'`) keeps `vi.spyOn(logger, 'debug')`. The JS-canary (asserts `reason: 'js_is_pevo_any_paper'`) and the new canaries from items 4-5 below use `vi.spyOn(logger, 'warn')`.

   Re-attest the mutation-kill matrix after the level changes: each layer-pinning canary must still fail RED on its mutation, stay green on the orthogonal mutation. Drop-the-event-emission mutation must still fail RED (`events.length > 0` assertion remains the discriminator for event-tag presence). The matrix attestation in the round-2 signal block must include all 4 canaries (SQL, JS, cont_columns_invalid, no_pool).

**2. (P2, anchor 90, maintainability) Inline `probeSqlHasTypeFilter` — single call site.** `backend/tests/routes/canonical-root-walker.test.ts` — `probeSqlHasTypeFilter(sql)` is defined and called exactly once (inside `installTypeSpoofStartResponder`'s `with_filter` branch). Per project convention (helpers earn their keep at 3+ call sites), single-site extraction has no reuse benefit. The doc comment on `installTypeSpoofStartResponder` already explains the detection-key reasoning; the helper's name adds nothing.

   Fix: delete the function definition; replace the single call site with the inline regex `/'type'/.test(sql)` plus a one-line comment if extra clarity is wanted.

**3. (P2, anchor 75, kieran-typescript) `reason` discriminator is untyped string.** `backend/src/routes/papers.ts` — the 3 `start_invalid` event payloads pass `reason` as inline string literals (`'sql_filter_or_missing'`, `'js_is_pevo_any_paper'`, `'cont_columns_invalid'`). No named literal-union type; misspellings compile silently. The canaries catch drift at test time only.

   Fix: add a type alias near the walker definition:
   ```ts
   type CanonicalRootBailReason =
     | 'sql_filter_or_missing'
     | 'js_is_pevo_any_paper'
     | 'cont_columns_invalid';
   ```
   Use it on the event payload type so misspellings fail compile. (Bonus: any future bail path becomes the obvious extension point for a 4th reason.)

**4. (P3, anchor 95, testing) `cont_columns_invalid` bail path has no canary.** `backend/src/routes/papers.ts` — the `cont_columns_invalid` event site exists; no test exercises it. Dropping the `logger.debug` (or `logger.warn` post-item-1) at that site fails no test. Task acceptance section 1 explicitly listed this event as part of the deliverable; the mutation-kill story is incomplete without it.

   Fix: add a canary that installs a responder returning `{ author: 'alice', json_metadata: <valid pevo paper meta>, cont_author: null, cont_permlink: null }` for the initial probe (force-feeds the row past the SQL guard so the JS-side narrowing fires), asserts response status `404`, and spies on `logger.warn` (per item 1) to confirm `{ event: 'canonical_root_walker_start_invalid', reason: 'cont_columns_invalid' }` was emitted.

**5. (P3, anchor 90, testing) `canonical_root_walker_no_pool` event has no test.** `backend/src/routes/papers.ts` — the no-pool event site exists; `beforeEach` always sets `getPoolMock` to return a valid pool, so no test exercises the null-pool branch.

   Fix: add a canary that calls `getPoolMock.mockReturnValue(null)` before the request, asserts a non-5xx response (HAF unavailability falls through to other paths), and spies on `logger.warn` (per item 1) to confirm `{ event: 'canonical_root_walker_no_pool' }` was emitted. Restore the mock after.

### Items dismissed during architect triage

- **(P3, anchor 75, adversarial) Source-narrowing mutation gap in `probeSqlHasTypeFilter`.** Detection regex `/'type'/` catches "filter dropped" mutations but is permissive against subtler mutations like `validPevoPaperWhere(source:'all')` → `validPevoPaperWhere(source:'paper-only')` that retain the literal `'type'` substring. Dismissed: explicitly outside this task's declared mutation scope (the task targets complete filter removal; subtler mutations are a separate concern). Implementer documented this as a residual risk. If a follow-up wants to widen mutation coverage, file then.

### Re-review signal

When items 1-5 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. The mutation-kill attestation matrix must be re-attested in the round-2 signal block: all 4 canaries (SQL, JS, cont_columns_invalid, no_pool) × HEAD / SQL-revert / JS-revert / cont_columns-revert / no_pool-revert as applicable, since (a) item 1 changes spy levels, and (b) items 4-5 add two new canaries that need their own mutation-kill rows.

## Backend re-review signal (2026-05-07, round-1 hold-fixes — commit `c4ecfcd` on `main`, originally `97d42ef` on `worktree-agent-ab5bd3bf035988078`)

All five hold items landed. Worker subagent rebased onto main `f73a362` before editing. Files touched:

### Item 1 (level discipline + comment)

`backend/src/routes/papers.ts` — `findCanonicalRoot`:

- `canonical_root_walker_no_pool` → `logger.warn` (was `logger.debug`). Added a multi-line "Level discipline" comment at this site (the first event site in the function) explaining the split: `sql_filter_or_missing` stays at `debug` because it fires on every 404 of a non-PEvO post; the other three reasons (`no_pool`, `js_is_pevo_any_paper`, `cont_columns_invalid`) use `warn` because they are rare attack-or-data-integrity signals worth operator alerting. Comment cross-references the peer walker events (`unauthorized_hop`, `depth_exceeded`, `walker_error`) which are similarly graduated by frequency vs severity.
- `canonical_root_walker_start_invalid` reason `'sql_filter_or_missing'` → kept at `logger.debug`. SQL canary spy still uses `vi.spyOn(logger, 'debug')` (unchanged).
- `canonical_root_walker_start_invalid` reason `'js_is_pevo_any_paper'` → `logger.warn` (was `logger.debug`). One-line "Level: warn (per discipline comment ...)" anchor at the site.
- `canonical_root_walker_start_invalid` reason `'cont_columns_invalid'` → `logger.warn` (was `logger.debug`). One-line anchor + note that the IS NOT NULL guard normally prevents reaching this branch.

JS canary in `canonical-root-walker.test.ts` migrated from `vi.spyOn(logger, 'debug')` → `vi.spyOn(logger, 'warn')`. New canaries from items 4-5 use `vi.spyOn(logger, 'warn')`.

### Item 2 (inline `probeSqlHasTypeFilter`)

`backend/tests/routes/canonical-root-walker.test.ts` — deleted the standalone `probeSqlHasTypeFilter(sql)` function definition. Its single call site inside `installTypeSpoofStartResponder`'s `with_filter` branch now uses the inline regex `/'type'/.test(sql)` with a 6-line block comment explaining the detection key (the `'type'` literal is unique to `validPevoPaperWhere`'s output on this specific probe). Net -23 lines.

### Item 3 (`CanonicalRootBailReason` type alias)

`backend/src/routes/papers.ts` — added type alias just below `CANONICAL_ROOT_MAX_HOPS`:

```ts
type CanonicalRootBailReason =
  | 'sql_filter_or_missing'
  | 'js_is_pevo_any_paper'
  | 'cont_columns_invalid';
```

The three `start_invalid` event sites now declare a `const reason: CanonicalRootBailReason = '<literal>';` local before the `logger.*` call and pass it as the `reason` field. A misspelling at any of those three sites is now a compile error. `npx tsc --noEmit` clean.

### Item 4 (`cont_columns_invalid` canary)

`backend/tests/routes/canonical-root-walker.test.ts` — new test `'rejects START with invalid cont_author/cont_permlink columns (cont_columns_invalid)'`. Force-feeds `{ author: 'alice', json_metadata: <valid pevo paper meta>, cont_author: null, cont_permlink: null }` for the initial probe (passes both SQL and JS gates, fires the JS-side narrowing branch). Asserts `res.status === 200` (alice/v1 still resolves via direct paper-detail fetch after the walker bails returning null) and that `logger.warn` received `{ event: 'canonical_root_walker_start_invalid', reason: 'cont_columns_invalid' }`.

### Item 5 (`canonical_root_walker_no_pool` canary)

`backend/tests/routes/canonical-root-walker.test.ts` — new test `'emits canonical_root_walker_no_pool when HAF pool is unavailable'`. Calls `getPoolMock.mockReturnValue(null)` before the request, asserts `res.status < 500` (HAF unavailability falls through to other lookup paths, surfaces as 404 not 5xx), and that `logger.warn` received `{ event: 'canonical_root_walker_no_pool' }`. Restores the pool mock at the end of the test for any successor tests in the describe block.

### Mutation-kill matrix attestation (4 canaries × HEAD + 4 mutations)

Each mutation hand-applied in-place to `backend/src/routes/papers.ts`, the four targeted vitest invocations run, mutation reverted, md5sum-verified clean restore between rounds. Final `diff /tmp/papers.ts.canary-bak backend/src/routes/papers.ts` is empty.

| Mutation | SQL canary | JS canary | cont_columns canary | no_pool canary |
|----------|-----------|-----------|---------------------|----------------|
| HEAD (no mutation) | PASS | PASS | PASS | PASS |
| A: drop `validPevoPaperWhere` predicate from initial-probe WHERE clause | **FAIL RED** (`expected 'js_is_pevo_any_paper' to be 'sql_filter_or_missing'`) | PASS | PASS | PASS |
| B: replace `if (typeof startRow.author !== 'string' \|\| !isPevoAnyPaper(...))` with `if (false)` | PASS | **FAIL RED** (`expected 200 to be 404` — alice/v1 surfaces under bob/spoof-review) | PASS | PASS |
| C: replace `if (typeof startRow.cont_author !== 'string' \|\| typeof startRow.cont_permlink !== 'string')` with `if (false)` | PASS | PASS | **FAIL RED** (`expect(events.length).toBeGreaterThan(0)` — narrowing branch never fires, no event) | PASS |
| D: drop `logger.warn(... canonical_root_walker_no_pool ...)` emission (keep early `return null`) | PASS | PASS | PASS | **FAIL RED** (`expect(events.length).toBeGreaterThan(0)` — event tag missing) |

Each layer-pinning canary fails red on its targeted mutation and stays green on the orthogonal three. Mutation A also exhibits the documented secondary effect (walker proceeds to JS layer, emits `js_is_pevo_any_paper` instead of `sql_filter_or_missing`); the SQL canary's `reason`-field assertion is what fails, exactly as specified in the round-1 signal-block predictions. Mutation B exhibits the high-severity failure mode the gate exists to prevent: alice's content surfaces under bob's spoof URL (status 200 instead of 404), which the JS canary catches via the status assertion before the event-presence assertion.

### Verification

- `npx tsc --noEmit` from `backend/`: clean.
- `npm run lint` from `backend/`: only the two pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts` (unrelated).
- `npx vitest run tests/routes/canonical-root-walker.test.ts`: 19 tests pass on HEAD (was 17 pre-fix; +2 from items 4-5).

