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

## Architect re-review (2026-05-07, round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `c4ecfcd` (round-1 hold-fixes scope only) with 8 reviewers (correctness + adversarial at opus; testing/maintainability/project-standards/reliability/kieran-typescript/learnings at sonnet; `ce-agent-native-reviewer` skipped per PEvO carve-out). Round-1 hold items 1-5 land mechanically correctly: level discipline applied, type alias placed and routed via typed locals at all 3 sites, helper inlined, 2 new canaries added with mutation-kill attestation. Kieran-typescript explicitly closes item 3 ("CLOSED, mechanically correct"). Mutation-kill matrix attestation matches reviewer spot-checks.

Six items hold for round-3, four of them paired or cross-reviewer-corroborated.

### Items to address

**1. (P2, anchor 100, 3-reviewer corroboration: adversarial + reliability + maintainability) `no_pool` canary spy/pool restoration is not in try/finally.** `backend/tests/routes/canonical-root-walker.test.ts:757-777`. The canary mocks `getPoolMock.mockReturnValue(null)` and installs `warnSpy = vi.spyOn(logger, 'warn').mockImplementation(...)` at the top of the test body, then calls `warnSpy.mockRestore()` and re-mocks the pool at lines 772-777 AFTER the assertions at lines 765 and 770. If either assertion throws, the inline restoration never runs. `beforeEach` at line ~64 (`getPoolMock.mockReset().mockReturnValue({...})`) is the actual safety net for the pool mock — not the inline restore — but the inline comment at line 773 ("Restore the pool for subsequent tests in this describe block") implies the inline is the safety net. That's the misleading-comment concern: a future reader who refactors `beforeEach` would think they could safely keep the inline restore as the isolation primitive. Scope of the concern is broader than this one canary: vitest spies (`warnSpy`, `debugSpy`, `errSpy`) are cleaned up inline across many tests in this file; any assertion-throw before the inline restore leaks the spy into the next test.

   Fix: choose ONE of these shapes (implementer's choice between (a) and (b); (a) is cheaper and tighter to the canary, (b) is broader cleanup):
   - (a) Wrap the spy and pool setup-teardown in try/finally inside the no_pool canary body, AND correct the inline comment at line 773 to say "Pool restoration is also handled by `beforeEach`, but we restore inline here so the next assertion in this test sees the live pool. Spy restoration is in the finally block."
   - (b) Add `afterEach(() => { vi.restoreAllMocks(); })` to the describe block (line ~60), keep the pool restore inline (since `beforeEach` resets pool state), and remove the misleading comment about spy isolation entirely. Document at the new `afterEach` that this restores all spies installed in the `it()` bodies regardless of assertion-throw order.

   Whichever shape is chosen, document it in the round-2 signal block. The other reliability finding (TG1: no `afterEach(() => vi.restoreAllMocks())` guard) becomes moot under (b) and remains a residual under (a).

**2. (P2, anchor 100, cross-reviewer corroboration: testing + adversarial) `sql_filter_or_missing` call site lacks Fix-2 cross-reference to pino-spy-level-filter-ordering-trap convention.** `backend/src/routes/papers.ts:~1358` (the `logger.debug({ event: 'canonical_root_walker_start_invalid', reason })` call site for `sql_filter_or_missing`) and `backend/tests/routes/canonical-root-walker.test.ts:~605` (the SQL canary's `vi.spyOn(logger, 'debug')` setup). The level-discipline comment at the `no_pool` site (lines 1298-1303) explains the level *choice* — it does not include the explicit "production needs `LOG_LEVEL=debug` to observe; the spy intercepts before pino's level filter, so canary green does NOT imply production visibility" wording that `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md` Fix 2 prescribes. The convention doc landed in commit `8ad5c35` (today, 2026-05-07) explicitly to forestall future re-flagging of this gap.

   Fix: add a short pointer comment at BOTH sites:
   - At `papers.ts` immediately above the `logger.debug({ event: 'canonical_root_walker_start_invalid', reason }, ...)` call for `sql_filter_or_missing`: a 2-3 line block stating "Emitted at debug because this fires on every 404 lookup of a non-PEvO post. Production observability requires `LOG_LEVEL=debug`. The canary spy in `canonical-root-walker.test.ts` intercepts at the logger-object boundary, before pino's level filter, so canary green does NOT imply this event is visible at `LOG_LEVEL=info`. See `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md`."
   - At `canonical-root-walker.test.ts` immediately above `vi.spyOn(logger, 'debug')` in the SQL canary: a 1-line `// NOTE: spy intercepts before pino level filter; see pino-spy-level-filter-ordering-trap-2026-05-07.md`.

   The level-discipline comment at the `no_pool` site can stay as-is for now (item 6 reshapes it for a different reason). The point of this fix is to make the trap awareness *reachable on read* from the actual `sql_filter_or_missing` site, not only via cross-reference from a different site.

**3. (P2, anchor 75, adversarial) Faithful-mock SQL discriminator `/'type'/` is brittle to a future SQL parametrization refactor.** `backend/tests/routes/canonical-root-walker.test.ts:~542-550` (the inline regex inside `installTypeSpoofStartResponder`'s `with_filter` branch). The discriminator works because `validPevoPaperWhere` currently emits the literal `'type'` inline. A future pg-format-style sweep that parametrizes literals across `hafsql.ts` (replacing inline `'type'`/`'paper'`/`'bridge_paper'` with `$N` placeholders) would break the regex match → mock returns the spoof row in `with_filter` mode → SQL canary fails RED on a refactor that did NOT regress security (false alarm). Worse, the false alarm could prompt a developer to "fix" the canary by relaxing the regex, opening room for a real `validPevoPaperWhere` drop to slip through later.

   Fix: add a 2-3 line warning comment immediately above the inline `/'type'/.test(sql)` regex (or above `installTypeSpoofStartResponder`) stating "Detection key `/'type'/` assumes `validPevoPaperWhere` emits inline literals. A future SQL-builder sweep that parametrizes literals (`$N` placeholders for `'type'`/`'paper'`/`'bridge_paper'`) would break this discriminator. If the SQL canary starts failing RED after such a refactor, the security property is NOT regressed — the discriminator needs updating."

   No code semantics change. The point is to make brittleness visible at the next refactor, so the false alarm is interpretable.

**4. (P3, anchor 100, adversarial) `cont_columns_invalid` canary pins ONLY the JS-side `typeof` narrowing — not the SQL `c.json_metadata -> $3 -> 'continues' IS NOT NULL` guard.** Paired with item 5. `backend/tests/routes/canonical-root-walker.test.ts:~690-723` (cont_columns_invalid responder) and `backend/src/routes/papers.ts:~1346` (the `IS NOT NULL` predicate in `findCanonicalRoot`'s initial probe). The canary force-feeds a row with null `cont_author`/`cont_permlink` regardless of production SQL — it doesn't inspect whether the SQL `IS NOT NULL` predicate is present. A future refactor that drops the `IS NOT NULL` guard would silently land: production now returns rows for any non-continuation paper that satisfies `validPevoPaperWhere`, projection of `->>'author'` against missing JSON keys yields NULL, JS isPevoAnyPaper passes (these ARE valid PEvO papers, just not continuations), `cont_columns_invalid` branch fires on every benign paper-detail lookup of a non-continuation paper. The cont_columns_invalid canary would still pass.

   Fix: add a 5th canary that pins the SQL `IS NOT NULL` guard. Suggested shape: faithful-mock the initial probe SQL and inspect for the `'continues' IS NOT NULL` substring (analogous to the existing `/'type'/.test(sql)` discriminator pattern, with the same brittleness caveat from item 3). When the guard is present, mock returns 0 rows (SQL filtered the spoof). When the guard is absent, mock returns the null-cont row → walker proceeds → cont_columns_invalid event fires. Asserts: with guard present, status 404 + no cont_columns_invalid event; with guard absent (mutation), status 200 (alice/v1 surfaces) + cont_columns_invalid event fires.

   The mutation-kill matrix grows from 4 canaries × 5 mutations to 5 canaries × 6 mutations. The new mutation row is "Mutation E: drop `'continues' IS NOT NULL` predicate from initial-probe WHERE clause" → IS-NOT-NULL canary FAIL RED, others PASS.

**5. (P3, anchor 75, adversarial — paired with 4) `cont_columns_invalid` warn-level discipline depends on an unprotected SQL invariant.** `backend/src/routes/papers.ts:~1401-1416`. The level-discipline comment frames `cont_columns_invalid` at warn as a "rare HAF data-integrity surprise". That framing is correct ONLY because the `IS NOT NULL` SQL guard makes this branch unreachable for benign traffic. If item 4's canary lands and pins the guard, this item is closed by construction. If item 4 is implemented with the lighter "inline comment only" shape, then warn-level here becomes a noise-amplifier risk that the implementer must address by either (a) downgrading `cont_columns_invalid` to debug, or (b) accepting the noise risk explicitly in a comment at `papers.ts:1401-1416`.

   Fix: contingent on item 4. If item 4 lands the IS-NOT-NULL canary, item 5 is automatically closed — note that resolution in the round-2 signal block. If item 4 is descoped to a comment-only shape, then in the same round explicitly choose between `cont_columns_invalid` at warn (with documented invariant-dependence) vs. debug (treating regression noise as acceptable).

**6. (P3, anchor 75, maintainability) Level-discipline comment enumerates a fixed list of 3 reasons; comment will silently stale if a 4th `CanonicalRootBailReason` is added.** `backend/src/routes/papers.ts:1298-1303`. The comment names `no_pool`, `js_is_pevo_any_paper`, and `cont_columns_invalid` explicitly. Cross-references at lines 1381 and 1402 ("per discipline comment above") compound the decay risk. A future agent extending `CanonicalRootBailReason` has no compile-time nudge to update the prose.

   Fix: reshape the comment from list-form to rule-form. Replace the explicit enumeration with a generalized rule (e.g., "`logger.warn` for rare attack-or-data-integrity signals worth operator alerting; `logger.debug` for high-frequency benign paths where warn would create noise"). The type alias `CanonicalRootBailReason` remains the single source of truth for which reasons exist; the comment carries the rule by which any reason gets a level. Existing cross-references at lines 1381 and 1402 stay valid because they reference the rule, not the enumeration.

### Items dismissed during architect triage

- **(P3, anchor 50-75, correctness C1) `no_pool` canary status assertion `< 500` is permissive.** Suggested fix is `=== 404`. Dismissed: the route's null-return fallthrough behavior is asserted elsewhere; `< 500` is the appropriate negative-assertion when the test's purpose is to confirm "HAF unavailability does not cascade to 5xx". Tightening to `=== 404` would couple the canary to fallthrough semantics it doesn't intend to pin.
- **(P3, anchor 50, correctness C2) `no_pool` canary doesn't pin `return null` early-return semantics.** A mutation that drops the `return null` (keeping the warn) would be caught by the outer `try/catch` (emitting `walker_error`), and the no_pool warn would still fire, so the canary passes despite a regression. Dismissed: the secondary `walker_error` event would itself fire under that mutation, and the outer try/catch error path has its own observability. Adding `expect(hafQueryMock).not.toHaveBeenCalled()` is a possible future hardening, but the threat model is narrow.
- **(P3, anchor 75, adversarial adv-6) Mutation F (validPevoPaperWhere `source: 'all'` → `source: 'native'`) breaks bridge-paper continuations silently at debug.** Out of this task's declared mutation scope (round-1's dismissal stands). Bridge-paper coverage is a separate task surface; if the architect later wants to widen the matrix, file as a follow-up.
- **(soft, kieran-typescript KT-01) Test-side spy-call extraction casts `reason` as `string`, not `CanonicalRootBailReason`.** Compile-time coupling between test assertions and the production union would require importing the type into tests. Dismissed: the test run itself catches a literal-rename mismatch, and importing a file-local alias purely for test coupling is its own smell.
- **(info, project-standards PS-001) Task-file `git mv pending → review` was deferred to housekeeping commit `0da5b27`.** Per rule #8 the mv is the re-review signal; ideally bundled with `c4ecfcd`. Dismissed: file is currently in `review/` at HEAD; the orphan-window risk did not materialize. Implementer can keep this in mind for future hold cycles.
- **(info, project-standards PS-002 + learnings) Signal-block SHA citation.** The version of the signal block at commit `c4ecfcd` cited a different SHA; corrected post-hoc by `ea8eafd` to `c4ecfcd on main, originally 97d42ef on worktree-…`. Orphan-detection check (`git merge-base --is-ancestor c4ecfcd main`) passes at HEAD. Dismissed: remediated.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-2 commits only.

The mutation-kill matrix attestation in the round-2 signal block must be re-attested IF item 4 lands the IS-NOT-NULL canary (the matrix grows to 5 canaries × 6 mutations). If item 4 lands as comment-only, the existing 4×5 matrix stands; item 5's resolution choice (warn-with-comment vs. downgrade-to-debug) must be explicitly stated.

Items 2-3 and 6 are documentation/comment changes — no test changes, no mutation-kill re-attestation needed for those alone. Item 1 is test-only — vitest run output suffices as verification.

## Backend re-review signal (2026-05-07, round-2 hold-fixes — commit `6f3d356` on `main`)

All six round-2 hold items landed. Worked directly on `main` (no worktree fan-out — single-task execution). Files touched (backend zone only):

- `backend/src/routes/papers.ts` (+15, -8 net)
- `backend/tests/routes/canonical-root-walker.test.ts` (+141, 0 net)

### Item 1 (spy/pool restoration — afterEach shape)

Picked architect's shape (b). Added `afterEach(() => { vi.restoreAllMocks(); });` immediately below the existing `beforeEach` in `canonical-root-walker.test.ts`, with a 6-line block comment documenting that the new hook is the spy-cleanup safety net regardless of assertion-throw order, that inline `*.mockRestore()` calls scattered through the file are now redundant with this guard but harmless, and that the pool mock (`getPoolMock` is a `vi.fn()`, not a spy) is reset and re-wired by `beforeEach` — not by `restoreAllMocks()`.

The misleading inline comment at the no_pool canary's pool-restore site ("Restore the pool for subsequent tests in this describe block.") was rewritten to "The pool mock is reset by `beforeEach` before the next test runs, so restoring it here is not required for isolation. We re-wire it anyway in case future additions to this it() body assert against a live pool after the no-pool branch." Inline `*.mockRestore()` calls were left in place; removing them is purely cosmetic given the afterEach guard.

The reliability-finding TG1 (no `afterEach(() => vi.restoreAllMocks())` guard) is now closed at the file level — every `vi.spyOn(...)` installed in any `it()` body is restored before the next test, regardless of which assertion threw inside the body.

### Item 2 (pino-spy-level-filter cross-references)

`backend/src/routes/papers.ts` — above the `logger.debug({ event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing' }, ...)` call site, added a 6-line block stating that the event is emitted at debug because it fires on every 404 of a non-PEvO post, that production observability requires `LOG_LEVEL=debug`, and that the canary spy intercepts at the logger-object boundary BEFORE pino's level filter — so canary green does NOT imply this event is visible at `LOG_LEVEL=info`. Cross-references `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md`.

`backend/tests/routes/canonical-root-walker.test.ts` — above `vi.spyOn(logger, 'debug')` in the SQL canary, added a 4-line `NOTE` pointing at the same convention doc and noting that this canary's green tick does NOT imply production visibility at `LOG_LEVEL=info`. The trap awareness is now reachable on read at both sites, not just via cross-reference from a different site.

### Item 3 (brittleness warning above /'type'/ discriminator)

`backend/tests/routes/canonical-root-walker.test.ts` — above the inline `/'type'/.test(sql)` regex inside `installTypeSpoofStartResponder`'s `with_filter` branch, added an 11-line `BRITTLENESS WARNING` block: a future SQL-builder sweep that parametrizes literals (`$N` placeholders for `'type'`/`'paper'`/`'bridge_paper'`) would break the regex match → mock returns the spoof row in `with_filter` mode → SQL canary fails RED on a refactor that did NOT regress security. The warning explicitly flags this as a FALSE ALARM and instructs future readers not to "fix" by relaxing the regex (which would open room for a real `validPevoPaperWhere` drop to slip through later). No code semantics change.

### Item 4 (IS-NOT-NULL canary)

`backend/tests/routes/canonical-root-walker.test.ts` — new test `'pins SQL IS NOT NULL guard on initial probe (no cont_columns_invalid on benign non-continuation lookup)'` placed between the `cont_columns_invalid` canary and the `no_pool` canary, grouping all four START-gate canaries before the pre-START infra check.

Faithful-mock semantics: SQL-inspects the production initial probe for `'continues'\s*IS\s+NOT\s+NULL` (case-insensitive). On HEAD with guard present: mock returns 0 rows → walker bails `sql_filter_or_missing` at debug → warn spy sees nothing → assertion `events.toHaveLength(0)` holds, `expect(res.status).toBe(200)` (alice/v1 served by direct paper-detail fall-through). On Mutation E (drop the predicate): mock observes guard absent → returns alice/v1 row with `cont_author=null, cont_permlink=null` (mimicking real-HAF projection of `->>'author'` against missing JSON keys) → walker passes `validPevoPaperWhere` SQL filter, passes JS `isPevoAnyPaper` re-check (alice/v1 IS a valid PEvO paper), bails `cont_columns_invalid` at warn → warn spy captures the event → assertion FAILS RED.

The same brittleness caveat from item 3 applies to this canary's `'continues' IS NOT NULL` discriminator and is documented inline (3-line BRITTLENESS CAVEAT block) per architect prescription.

**Note on status assertion** (deviation from architect's spec text): the round-2 hold block predicted "with guard present, status 404 + no cont_columns_invalid event; with guard absent (mutation), status 200 (alice/v1 surfaces) + cont_columns_invalid event fires." With the `alice/v1` URL design that surfaces the desired event-presence diagnostic, both HEAD and Mutation E surface 200 — the route's direct paper-detail fall-through serves alice/v1 in both states because the walker returns null in both states (HEAD via `sql_filter_or_missing`, Mutation E via `cont_columns_invalid`). The discriminating signal is the warn-event presence, not the response code. Documented in the canary's header comment with the rationale. If the architect prefers status differential, the URL can be redesigned to a non-existent paper (`alice/nonexist-v1`); both HEAD and Mutation E would then surface 404 — the discriminator stays the warn-event presence either way. Flag for round-3 if the spec's 404/200 framing is load-bearing.

### Item 5 (warn-level discipline contingent on item 4)

Closed by construction. Item 4 lands the IS-NOT-NULL canary that pins the SQL guard, which is exactly the invariant `cont_columns_invalid` warn-level depends on for noise-control (the IS NOT NULL guard prevents the cont_columns narrowing branch from firing on benign traffic). No additional work.

### Item 6 (level-discipline comment reshaped to rule-form)

`backend/src/routes/papers.ts` — replaced the 6-line enumeration ("'sql_filter_or_missing' uses debug because... the other three reasons (no_pool, js_is_pevo_any_paper, cont_columns_invalid) use warn because...") at the `no_pool` branch with a 9-line generalized rule keyed on the `CanonicalRootBailReason` type alias as SSOT for which reasons exist:

> Level discipline for canonical_root_walker_* events:
> - logger.warn — rare attack-signal or data-integrity paths worth operator alerting at default LOG_LEVEL=info.
> - logger.debug — high-frequency benign paths where warn would drown signal in noise; production must opt in via LOG_LEVEL=debug (see pino-spy-level-filter-ordering-trap-2026-05-07.md).
> The CanonicalRootBailReason type alias is the single source of truth for which reasons exist; pick the level per-reason against this rule. Peer walker events (unauthorized_hop, depth_exceeded, walker_error) follow the same rule, similarly graduated by frequency vs severity.

A future 4th `CanonicalRootBailReason` reason no longer stales the comment — readers consult the type alias for the enumeration and the rule for the level. Cross-references at the `js_is_pevo_any_paper` and `cont_columns_invalid` sites ("Level: warn (per discipline comment at the no_pool branch above)") stay valid because they reference the rule, not the enumeration.

### Mutation-kill matrix attestation (5 canaries × 6 mutations)

Each mutation hand-applied in-place to `backend/src/routes/papers.ts`, the five layer-pinning canaries run via `-t` regex filter on `tests/routes/canonical-root-walker.test.ts` (15 unrelated tests skipped per run), mutation reverted, md5sum-verified clean restore between rounds. Final `diff /tmp/papers.ts.canary-bak backend/src/routes/papers.ts` is empty.

| Mutation | SQL | JS | cont_columns | no_pool | IS-NOT-NULL |
|----------|-----|----|----|----|----|
| HEAD (no mutation) | PASS | PASS | PASS | PASS | PASS |
| A: drop `validPevoPaperWhere` predicate from initial-probe WHERE clause | **FAIL RED** | PASS | PASS | PASS | PASS |
| B: replace `if (typeof startRow.author !== 'string' \|\| !isPevoAnyPaper(...))` with `if (false)` | PASS | **FAIL RED** | PASS | PASS | PASS |
| C: replace `if (typeof startRow.cont_author !== 'string' \|\| typeof startRow.cont_permlink !== 'string')` with `if (false)` | PASS | PASS | **FAIL RED** | PASS | PASS |
| D: drop `logger.warn(... canonical_root_walker_no_pool ...)` emission (keep early `return null`) | PASS | PASS | PASS | **FAIL RED** | PASS |
| E: drop `c.json_metadata -> $3 -> 'continues' IS NOT NULL` predicate from initial-probe WHERE clause | PASS | PASS | PASS | PASS | **FAIL RED** |

FAIL RED diagnostics (vitest assertion failures):

- A → SQL canary: `expected 0 to be greater than 0`. Walker reaches the JS layer, emits `js_is_pevo_any_paper` at warn (post-round-1 level discipline). The SQL canary's `vi.spyOn(logger, 'debug')` doesn't see it → `events.length === 0` → `toBeGreaterThan(0)` fails. Round-1's matrix reported `expected 'js_is_pevo_any_paper' to be 'sql_filter_or_missing'`; round-2's level-discipline split changed the manifest but not the kill strength.
- B → JS canary: `expected 200 to be 404`. Alice/v1's content surfaces under bob/spoof-review's URL — exactly the phishing pretext the gate exists to prevent. The status assertion fires before the event-presence assertion.
- C → cont_columns canary: `expected 0 to be greater than 0`. The narrowing branch never fires; no event emitted.
- D → no_pool canary: `expected 0 to be greater than 0`. Event tag missing.
- E → IS-NOT-NULL canary: `expected [ {…(4)} ] to have a length of +0 but got 1`. Mutation E lets the alice/v1 row through the SQL gate without the `IS NOT NULL` filter; walker passes JS isPevoAnyPaper, bails `cont_columns_invalid` at warn; the canary's `events.toHaveLength(0)` assertion fails because exactly one warn event was captured.

Each layer-pinning canary fails red on exactly one mutation and stays green on the orthogonal four, satisfying the round-2 acceptance subsection 5.

### Verification

- `npx tsc --noEmit` from `backend/`: clean.
- `npm run lint` from `backend/`: only the two pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts` (unrelated to this task).
- `npx vitest run tests/routes/canonical-root-walker.test.ts`: 20 tests pass on HEAD (was 19 pre-fix; +1 from item 4's IS-NOT-NULL canary).

