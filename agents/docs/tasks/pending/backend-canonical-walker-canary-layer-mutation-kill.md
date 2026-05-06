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
