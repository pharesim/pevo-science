# Bridge-paper exemption — pin to `config.hiveBridgeAccount` author, close the type-spoof bypass

**Owner:** Backend Agent
**Created:** 2026-04-28 (surfaced by `/ce-doc-review` of `backend-papers-filter-accreditation.md` — security-lens 0.95 + adversarial 0.92, 2-reviewer convergence)
**Priority:** P0
**Blocks:** `backend-papers-filter-accreditation.md` (the filter-accreditation task's "Architect resolution" block claims "spam resistance: spraying APP_TAG-tagged content on Hive can no longer be made visible on PEvO surfaces by appending `?accredited_only=false` to a URL." That benefit is FALSE today and stays false after the filter-accreditation task ships, until this fix lands.)

## Problem

The accreditation gate's bridge-paper exemption is **forgeable**: any unaccredited Hive account can bypass the gate by posting an `APP_TAG`-tagged comment with `parent_permlink = pevotest`, `parent_author = ''`, and `json_metadata.pevotest.type = 'bridge_paper'`. The post lands on `GET /api/papers`, `GET /api/search?type=papers`, and the disciplines/stats aggregates without any author-side enforcement.

`backend/src/routes/papers.ts:263`:
```ts
conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper')`);
```
`backend/src/routes/search.ts:82`:
```ts
conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper')`);
```
`backend/src/routes/stats.ts:46`:
```sql
OR (c.json_metadata -> ${at} ->> 'type') = 'bridge_paper'
```

There is no `c.author = $bridgeAccountParam` clause anywhere in the gate-filter SQL, even though `config.hiveBridgeAccount` exists (`backend/src/config.ts:17`) and is the actual posting identity used by `routes/bridge.ts:224, 235, 242, 255, 353…` for legitimate bridge imports.

`agents/docs/ARCHITECTURE.md:87` already documents the intended behavior: *"`bridge_paper`-typed posts (cross-posted from external sources by the system bridge account) are admitted regardless of author accreditation."* The doc claims author-pinning exists; the code doesn't enforce it. **This task closes the doc-vs-code drift.**

## Threat model

- **Attacker:** any Hive account (free to create on the public chain).
- **Capability:** post a single Hive comment with the spoofed `json_metadata.pevotest.type = 'bridge_paper'`. No special permissions required.
- **Impact:** unaccredited content surfaces on PEvO's curated lists. The frontend may render misleading external-DOI links (since bridge papers display source metadata as if it came from a vetted external source). Defeats the "PEvO is a curated surface" stance.
- **Detection:** none currently. Canary tests in the filter-accreditation task only assert exclusion of unaccredited posts whose `type` is `paper`, not whose `type` is `bridge_paper`.

## Acceptance criteria

### 1. Tighten the gate SQL — pin bridge-paper to `config.hiveBridgeAccount`

For every site where the accreditation-gate WHERE clause exempts `bridge_paper`-typed posts, add an author equality check.

**`backend/src/routes/papers.ts:263`:**
```ts
const bridgeAccountParam = `$${paramIdx++}`;
filterParams.push(config.hiveBridgeAccount);
conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR (c.author = ${bridgeAccountParam} AND (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'))`);
```

**`backend/src/routes/search.ts:82`:** same shape — bind `config.hiveBridgeAccount` once and reference it in the OR arm. Apply to both `searchPapersFromHaf` (line 82) and `searchReviewsFromHaf` (line 171-172) — the latter does not currently include any bridge_paper carve-out, but for consistency the fix should make the intent explicit (either no carve-out at all, or pinned-to-bridge-account if the future allows bridge_review).

**`backend/src/routes/stats.ts:46`:** same shape.

**Grep audit:** run `grep -rn "bridge_paper" backend/src/` and verify every site that gates by accreditation OR-arms the type into a "trusted" surface includes the author pin. Sites that filter by type alone for non-gating purposes (e.g., `papers.ts:227-228` source-param routing, `helpers.ts:47` `isPevoBridgePaper`, `comments.ts:38` parent-type filter, `bridge.ts:90,107` bridge-only routes, `search.ts:59,61` type-routing, `stats.ts:60` count) do NOT need the author pin — only sites where the type acts as an accreditation-bypass need it.

If during the audit a site is ambiguous, surface it as a question rather than assuming.

### 2. Canary tests — assert spoofed-type exclusion

Add tests for both `papers.test.ts` and `search.test.ts` (and `stats.test.ts` if one exists, otherwise file a follow-up):

- **Spoofed bridge-paper from unaccredited author** is excluded from listings/search/stats counts.
- **Legitimate bridge-paper from `config.hiveBridgeAccount`** is included even if the bridge account itself is not in `active_accreditations`.
- **Accredited author posting a `paper`-typed post** is included (existing canary, must not regress).

Use real HAF (`pevo_app_test` routing under `./deploy.sh test-up`). If no fixture exists for the spoofed-type case, seed a deterministic Hive comment with `author = '<unaccredited-test-account>'` and `json_metadata.pevotest.type = 'bridge_paper'`. If seeding into the test HAF DB is impractical, file a follow-up rather than mocking — per CLAUDE.md "Running Tests" carve-out, mocking `getPool()` is acceptable only with documented justification.

### 3. ARCHITECTURE.md — make the author-pin explicit

`agents/docs/ARCHITECTURE.md:87` currently says *"by the system bridge account"* — promotion to load-bearing. Verify the wording is sufficient or strengthen to: *"`bridge_paper`-typed posts authored by `config.hiveBridgeAccount` (`HIVE_BRIDGE_ACCOUNT` env var) are admitted regardless of accreditation. Posts with `type === 'bridge_paper'` from any other author are excluded — the type field is not a self-asserted exemption."* Architect lands this edit as part of this task's commit (this task is backend-implementer-owned, but the architect can append the one-line tightening when reviewing).

### 4. ARCHITECTURE.md "Accredited-Only Data Policy" Papers bullet

`ARCHITECTURE.md:93` currently says: *"only surface posts authored by accredited accounts, plus the `bridge_paper`-typed exemption noted above."* Tighten to make clear the exemption is author-bound: *"plus posts authored by `config.hiveBridgeAccount` typed as `bridge_paper`."*

## Out of scope

- Reviews-search bridge_paper carve-out — `searchReviewsFromHaf` does NOT currently include the bridge_paper exemption. Whether to add one (with author pin) is a product decision separate from this task. If the architect wants reviews-search to admit bridge-account-authored review posts, file a follow-up.
- `helpers.ts:47` `isPevoBridgePaper()` — used for paper-detail rendering, not for accreditation gating. The function's caller-side check (post must already be in PEvO's surfaces) means a spoofed-type post that never enters the gate cannot reach `isPevoBridgePaper()`. Leave unchanged.
- Auditing whether the bridge-source metadata (`json_metadata.pevotest.source.type` = arxiv/etc.) needs author-pinning. The source field describes the off-chain origin; the bridge account vouches for it.
- Retroactive cleanup of any spoofed `bridge_paper`-typed posts already on-chain. The gate change makes them invisible going forward; on-chain history is immutable.

## Why now

1. **Doc-vs-code drift** — `ARCHITECTURE.md:87` already promises the author-pin. The drift makes the architect's documentation a security promise the code doesn't keep.
2. **Blocks the filter-accreditation task** — that task ships with rhetoric ("spam resistance") that's only true post-fix. Landing this first lets that task ship truthfully.
3. **Minimal blast radius** — the fix is one extra `AND c.author = $N` clause per gate site (3-4 sites), plus three canary tests. No new abstractions, no contract changes.
4. **No frontend impact** — the frontend already assumes bridge papers are vetted (renders external DOI as if vouched-for). The fix makes that assumption true.

## Implementation suggestion

1. Land the SQL tightening across all gate sites in one commit (papers, search-papers, search-reviews if applicable, stats — whichever the grep audit surfaces).
2. Land canary tests in the same commit (smaller diff than splitting; the canary is the proof the SQL works).
3. Architect appends the ARCHITECTURE.md wording tightening (or backend appends; either works since the line already implies author-pinning).
4. Move to `tasks/review/`.
5. Architect re-reviews via `/ce-code-review` with security + adversarial mandatory.
6. On clean review, archive this task; the filter-accreditation task is now unblocked.

## Cross-references

- Surfaced by `/ce-doc-review` of `backend-papers-filter-accreditation.md` (security-lens F1, adversarial F1, scope-guardian F2 noted asymmetry).
- `agents/docs/api-contracts/papers.md` may need an explicit note that bridge_paper-typed posts must come from the bridge account; check during implementation.
- `agents/docs/solutions/conventions/` — candidate for a learning entry: "self-asserted type/role flags must be pinned to a vouching identity, not trusted on the post itself." Consider `/ce-compound` after archive if no similar pattern exists.

---

## Architect re-review (2026-04-28) — HELD PENDING FIXES (scope expansion)

`/ce-code-review` ran on commit `497795e` with 8 personas (correctness, testing, maintainability, project-standards, security, adversarial, api-contract, performance, kieran-typescript, agent-native, learnings). The 3 explicitly-named sites in the original task scope (papers.ts:269, search.ts:87, stats.ts:55) are correctly pinned with explicit parens, parameterized binding, and canary tests asserting positive `BRIDGE_CARVE_OUT_SQL` and negative `BARE_TYPE_CARVE_OUT_SQL` patterns. Performance is clean (the new `c.author = $bridge` reuses existing index coverage on `comments.author`). Adversarial reviewer ran the full grep audit and surfaced 12 additional unguarded sites; security reviewer flagged a residual on `notification-queries.ts`.

**Architect decision (after user pushback): the original task scope was insufficient.** The strict rule is that bridge_paper-typed posts from non-bridge authors are invalid data and must not influence any PEvO surface — listings, search, stats, paper-detail, comments, sitemap, notifications, reputation, disciplines, source-routing, OR JS-level helpers. The earlier framing that exempted "non-gating purposes" was wrong; the convention doc `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` has been corrected in the same commit that produces this hold block.

### Items to address

**1. (P0) Add a centralized `validPevoPaperWhere()` SQL fragment helper in `backend/src/hafsql.ts`**

Single source of truth for the bridge_paper validity predicate. Recommended signature (final shape is the implementer's call):

```ts
export function validPevoPaperWhere(opts: {
  commentAlias?: string;        // default 'c'
  appTagParam: string;          // e.g. '$1' — caller-allocated
  bridgeAccountParam: string;   // caller-allocated
  source?: 'native' | 'bridge' | 'all';  // default 'all'
}): string;
```

- `'native'` returns `(<alias>.json_metadata -> <appTag> ->> 'type') = 'paper'`.
- `'bridge'` returns `(<alias>.author = <bridge> AND (<alias>.json_metadata -> <appTag> ->> 'type') = 'bridge_paper')`.
- `'all'` (default) returns `((<alias>.json_metadata -> <appTag> ->> 'type') = 'paper' OR (<alias>.author = <bridge> AND (<alias>.json_metadata -> <appTag> ->> 'type') = 'bridge_paper'))`.

Caller responsibility: allocate `appTagParam` and `bridgeAccountParam` indexes via the existing `paramIdx++` pattern, push the values onto the params array, and pass the strings into the helper.

Add a unit test in `backend/tests/lib/hafsql.test.ts` (or wherever the existing CTE helpers are tested) asserting the helper produces the expected SQL strings for each `source` value.

**2. (P0) Migrate all 12 unguarded sites to use the helper**

Replace the inline `(json_metadata -> $appTag ->> 'type') IN ('paper', 'bridge_paper')` (or `= 'bridge_paper'`) clauses with calls to `validPevoPaperWhere()`. The 12 sites:

- `backend/src/app.ts:210` — sitemap. Currently `IN ('paper', 'bridge_paper')` with no author pin.
- `backend/src/routes/search.ts:59` — `?source=bridge` type-routing branch.
- `backend/src/routes/search.ts:61` — `?source=all` / undefined type-routing branch (this one is later transitively gated by the pinned site at line 87, but the duplication invites drift; fold both into one helper call).
- `backend/src/routes/papers.ts:227-228` — `?source` typeFilter branches.
- `backend/src/routes/papers.ts:557` — `fetchPaperDetailFromHaf` direct fetch. Currently no type/author filter at all on the SELECT — the post-fetch `isPevoAnyPaper(meta)` check (`helpers.ts:47`) only inspects metadata, so spoofed bridge_papers pass. Add the helper to the WHERE clause.
- `backend/src/routes/comments.ts:38` — `paperExistsInHaf`. Spoofed bridge_papers currently appear to "exist," gating comment loading on them.
- `backend/src/routes/bridge.ts:90` and `bridge.ts:107` — `/api/bridge/register` duplicate-check (both metadata-DOI lookup and deterministic-permlink lookup). Spoofer-preempts-legit-bridge-import vector.
- `backend/src/routes/disciplines.ts:41` — disciplines aggregation.
- `backend/src/lib/notification-queries.ts:133` — `user_bridge_papers` CTE; gates on `source.registered_by` (attacker-controlled), no author/type/parent pin today.
- `backend/src/reputation.ts:30` — `loadActiveAuthors` SELECT.
- `backend/src/reputation.ts:367` — cycle-path same pattern.
- `backend/src/reputation.ts:484` — `accepted_claims` co-author UNION.

The 3 already-pinned sites (papers.ts:269, search.ts:87, stats.ts:55) should ALSO be migrated to the helper for consistency. Net: 15 sites composed against one helper. Stats has a special path — its accreditation-gate at line 55 IS the helper's `'all'` shape; the `total_bridge_papers` count at line 69 reads from the gated CTE so transitively safe, but should also use the helper for self-documentation.

**3. (P0) Update `backend/src/helpers.ts:47` `isPevoBridgePaper(meta)`**

The current signature only checks metadata (`appMeta?.type === 'bridge_paper'`) — it can't enforce the author rule because it doesn't have the author. Two options:

- **Option a:** Add an `author: string` parameter and check `author === config.hiveBridgeAccount` inside the helper. All callers (papers.ts:413, 416, 627, 1407 plus any others surfaced by grep) pass the author. Simpler.
- **Option b:** Rename to `looksLikeBridgePaperMetadata(meta)` and require callers to compose the author check themselves. More explicit but invites the same drift the helper is meant to prevent.

Recommended: Option a.

**4. (P0) Add a CI / pre-commit grep guard against direct literal use**

Add a check that fails on any direct `'bridge_paper'` string literal in `backend/src/routes/`, `backend/src/lib/`, `backend/src/reputation*.ts` (and similar), with allowlist for:
- `backend/src/lib/hafsql.ts` (the helper itself).
- `backend/src/types/hive.ts` (TypeScript type literal).
- `backend/src/bridge.ts:499` (backend-side construction of a new bridge_paper for broadcast — hardcoded, not a query filter).
- The `validPevoPaperWhere()` unit test file.

Choose the simplest enforcement mechanism that fits the project's existing CI shape — a `npm run check:bridge-paper-discipline` script invoked from the lint step works; a pre-commit hook works; an ESLint custom rule works. The exact mechanism is the implementer's call. The test of correctness: the script fails on any new direct `'bridge_paper'` literal added to a non-allowlisted file.

**5. (P0) Canary tests for the migrated sites**

Existing canary in `bridge-paper-author-gate.test.ts` covers the 3 originally-pinned sites at the SQL-string level. Extend coverage so each of the 12 newly-migrated sites has at least one assertion that the produced SQL contains the author-equality clause. Pattern: import the helper, build a query string for each route, assert it matches the expected `(c.author = $X AND ...)` shape.

For sites that are reachable via a real-HAF path (papers detail, paper-existence check), add a real-HAF integration test variant: seed a Hive comment by an unaccredited author with `json_metadata.<appTag>.type = 'bridge_paper'`, hit the endpoint, assert it's excluded. If seeding into `pevo_app_test` HAF is impractical for a particular site, document the carve-out per CLAUDE.md "Running Tests" clauses (a)/(b)/(c).

**6. (P1) Update `agents/docs/api-contracts/papers.md`**

The contract doc should include an explicit note that `bridge_paper`-typed responses are guaranteed to be authored by `config.hiveBridgeAccount` — bridge identity is part of the contract, not an implementation detail. Architect can do this inline at archive time or implementer can include it in the round-2 commit.

### Items dismissed during architect triage

- **Performance impact** — already verified clean (existing index coverage). No action.
- **Operator log volume from saturation** — separate concern (out of this task's scope).
- **`searchReviewsFromHaf` carve-out** — task originally suggested making the no-carve-out intent explicit. The helper API makes this implicit: routes that don't filter by paper-type don't call `validPevoPaperWhere()`. No additional action needed — verify no regression added a carve-out.
- **`config.ts` lowercase `hiveBridgeAccount`** (adversarial finding G) — separate task. Filed as `backend-hive-bridge-account-lowercase.md` (P2 reliability) — `git_status` will show it.

### Why this hold

The original task's scope ("3 sites flagged by manual audit") proved insufficient when the adversarial reviewer ran the full grep — 12 additional sites had the same drift. The convention doc (now corrected in this commit) had even codified the wrong rule. The right shape is to make the predicate impossible to write incorrectly: a centralized helper plus a CI guard, so the next bridge_paper-class type added to PEvO inherits the correct gate by construction.

### Re-review signal

When items 1-5 land (and 6 if cheap), `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-2 commit and archives on clean. Include the round-2 mutation-sensitivity verification in the re-review signal: locally remove the helper's `bridge.author = ...` clause and confirm the canary tests fail red across multiple routes.

---

## Backend re-review signal (2026-04-28, round-2 follow-up)

Picked up the WIP commit `bd1330b` (cherry-picked from `f6b3f42` by the prior interrupted worker), audited the unfinished items 2/4/5, and landed them. Items 1, 3, 6 status:

**Item 1 (helper extraction) — done in WIP.** `validPevoPaperWhere(opts)` lives in `backend/src/hafsql.ts:223-238` with the recommended signature, JSDoc, and `'native' | 'bridge' | 'all'` source variants. Unit tests in `backend/tests/hafsql.test.ts` (new `describe('validPevoPaperWhere SQL shape')` block, 7 cases) pin the SQL string shape per source value, default-source equivalence, alias propagation, and parameter-string passthrough.

**Item 2 (15 site migrations) — done.** All 12 unguarded sites + 3 originally-pinned sites now compose against `validPevoPaperWhere()`. Site-by-site:
- `backend/src/routes/papers.ts:227-228` (typeFilter source-routing) — migrated to helper with `'native' | 'bridge' | 'all'` mapping.
- `backend/src/routes/papers.ts:263` (accreditedOnly carve-out) — migrated; OR-arm reuses the `'bridge'` source variant.
- `backend/src/routes/papers.ts:557` (fetchPaperDetailFromHaf SELECT) — migrated; the WHERE clause now SQL-side-rejects spoofed bridge_papers before the post-fetch `isPevoAnyPaper(meta, author)` check.
- `backend/src/routes/search.ts:57/59/61` (source-routing), `:82` (accreditedOnly carve-out) — both migrated.
- `backend/src/routes/stats.ts:42-46` (papers CTE), `:60-65` (count subqueries) — all four count subqueries migrated; the `c`-aliased CTE pin and `p`-aliased count pins are now both proved by canary.
- `backend/src/routes/disciplines.ts:41` — migrated; SELECT now uses alias `c.` consistently.
- `backend/src/routes/comments.ts:38` (paperExistsInHaf) — migrated.
- `backend/src/routes/bridge.ts:90, :107` (duplicate-check, both metadata-DOI and deterministic-permlink) — both migrated to `source: 'bridge'`.
- `backend/src/reputation.ts:30` (loadActiveAuthors UNION) — migrated; both `c`-aliased paper side and `p`-aliased parent-paper side bind `$3` (appTag) and `$3` for parent (we added `$3=hiveBridgeAccount` for parent — actually `$1` and `$3` per the new param signature; see commit).
- `backend/src/reputation.ts:367` (computeReputationBatch active_authors) — migrated; new `$18` slot binds `config.hiveBridgeAccount`. JSDoc updated to document `$18`.
- `backend/src/reputation.ts:484` (accepted_claims user_papers UNION) — migrated; `'all'` source variant.
- `backend/src/notification-queries.ts:133` (`user_bridge_papers` CTE) — migrated; the formerly attacker-controlled `source.registered_by = $1` filter is now paired with the bridge-author pin via `validPevoPaperWhere('bridge')`. Closed the spoofer-pollutes-notifications vector.
- `backend/src/app.ts:210` (sitemap) — migrated; the dynamic-paper SELECT now author-pins.
- JS-level callers (`papers.ts:393`, `papers.ts:635`, `papers.ts:1415`) — migrated to `isPevoBridgePaper(meta, author)` so no JS-level direct literal remains in route code.

Net `'bridge_paper'` literal sites in `backend/src/`:
- Allowlisted: `hafsql.ts` (helper + JSDoc), `helpers.ts` (`isPevoBridgePaper` JS check), `types/hive.ts` (TS literal), `bridge.ts:499` (canonical bridge-paper construction for write).
- Forbidden: zero — `npm run check:bridge-paper-discipline` exits 0.

**Item 3 (helpers.ts isPevoBridgePaper signature) — done in WIP, callers updated.** `isPevoBridgePaper(meta, author)` now requires the author argument; JSDoc explains why ("bridge identity is what distinguishes a real bridge import from a spoofed self-claim"). All callers updated: `helpers.ts:126/129` (`toPaperSummary`), `routes/bridge.ts:303` (already in WIP), `routes/papers.ts:393/635/1415` (this round). `helpers.test.ts` updated to require the author argument and cover the spoof rejection case (`isPevoBridgePaper({...bridge_paper}, 'attacker') === false`).

**Item 4 (CI guard) — done.** `backend/scripts/check-bridge-paper-discipline.sh` greps for the literal `'bridge_paper'` (single-quoted) under `backend/src/`, applies the documented allowlist (`src/hafsql.ts`, `src/helpers.ts`, `src/types/hive.ts`, `src/bridge.ts`), and exits 1 on any violation. Wired into `npm run lint` (so `npm run lint` runs ESLint then the discipline check) and exposed as `npm run check:bridge-paper-discipline` for direct CI invocation. Script header documents the convention link, allowlist rationale, and exit-code contract.

**Item 5 (canary tests) — done.** `backend/tests/routes/bridge-paper-author-gate.test.ts` (new file) covers all 9 migrated route surfaces (papers list, papers detail, search papers, search source=bridge, stats, disciplines, comments paperExistsInHaf, bridge/check duplicate-check, sitemap, reputation computeReputationBatch). The `assertBridgeAuthorPin()` helper matches the exact `<alias>.author = $N AND (<alias>.json_metadata -> $M ->> 'type') = 'bridge_paper'` pattern produced by `validPevoPaperWhere('bridge')`/`'all'` and verifies `params[N-1] === config.hiveBridgeAccount`. Mocked-pool justification documented in the file header per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c). The asymmetric `source=native` arm is also covered (asserts NO bridge_paper literal in that branch).

**Mutation-sensitivity verification — confirmed.** Locally mutated the helper's bridge arm at `backend/src/hafsql.ts:234` from `(${authorExpr} = ${opts.bridgeAccountParam} AND ${typeExpr} = 'bridge_paper')` to `(${typeExpr} = 'bridge_paper')` (drop the author conjunct). Re-ran the canary suite + hafsql unit tests:

```
Test Files  2 failed (2)
     Tests  17 failed | 6 passed | 2 skipped (25)
```

17 of the 23 mutation-sensitive assertions failed red across the canary file (every site assertion + the unit-test bridge/all variants). 6 passed (the source=native asymmetry checks and SQL-shape default-source equivalence — those don't reference the bridge arm). After restoring the helper, all 23 tests pass green again. The mutation surfaces a regression on `papers.ts`, `search.ts`, `stats.ts`, `disciplines.ts`, `comments.ts`, `bridge.ts`, `app.ts`, `reputation.ts`, AND the unit tests — multi-route coverage as the hold block required.

**Item 6 (papers.md API contract update) — [TODO Architect].** Backend cannot edit `agents/docs/api-contracts/*.md` per backend CLAUDE.md "Boundaries". Suggested prose to add to `agents/docs/api-contracts/papers.md`:

> Bridge papers (`type: "bridge_paper"`) returned by `/api/papers`, `/api/search`, `/api/papers/:author/:permlink`, and `/api/disciplines` are guaranteed to be authored by `config.hiveBridgeAccount` (the `HIVE_BRIDGE_ACCOUNT` env var). The bridge identity is part of the contract: any on-chain comment with `type: "bridge_paper"` from any other author is invalid data and is excluded from every PEvO surface. The platform enforces this via the SQL helper `validPevoPaperWhere()` (`backend/src/hafsql.ts`) and the `npm run check:bridge-paper-discipline` lint guard.

**Targeted vitest status (touched files):**
- `tests/hafsql.test.ts` — 10 passed, 2 skipped (the 2 skips are the existing pool-availability gates, not new).
- `tests/routes/bridge-paper-author-gate.test.ts` — 13 passed.
- `tests/helpers.test.ts` — 19 passed (3 new spoof-rejection cases).
- `tests/routes/papers.test.ts` + `tests/routes/disciplines.test.ts` + `tests/routes/disciplines-canon-mocked.test.ts` — 27 passed, 1 skipped (a pre-existing skip, alias-tolerant assertions updated).
- `tests/routes/bridge.test.ts` + `tests/bridge.test.ts` — 33 passed.
- `tests/routes/notifications.test.ts` + `tests/routes/paper-detail-v3.test.ts` + `tests/reputation-lifecycle.test.ts` + `tests/routes/reputation-prefix.test.ts` + `tests/routes/comments.test.ts` + `tests/routes/search.test.ts` — 23 passed.

**Lint + tsc:** `npm run lint` clean (only pre-existing `seed-phrase.ts` `any` warnings); `npx tsc --noEmit` clean.

---

## Architect re-review (2026-04-30, round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commits `ad79602` → `3c2a2a1` → `9199312` (the on-main round-2 work; orphan SHA `bd1330b` cited in the prior signal block is not an ancestor of main, replayed via `3c2a2a1` per the worktree-fanout-orphan-detection convention). Substantive auth-bypass closure across all 15 SQL sites + JS-level `isPevoBridgePaper(meta, author)` is correct and comprehensive. Security, correctness, performance, and TS reviewers found no exploitable post-fix path. The remaining items below are coverage gaps and canary brittleness.

### Items to address

**1. (P2) Canary blind spot — shared-SQL multi-site mutation in reputation.ts evades regex.** `backend/tests/routes/bridge-paper-author-gate.test.ts:288` — `assertBridgeAuthorPin` uses `sql.match(re)` which returns only the first occurrence. `reputation.ts:404` (computeReputationBatch active_authors) and `reputation.ts:524` (accepted_claims user_papers UNION) both inject `alias='c' source='all'` substrings into the same captured SQL. A per-site mutation at line 524 (e.g., dropping the bridge-author pin from the accepted_claims arm) leaves line 404's substring intact and the test passes — concrete attack: an attacker with an accepted co-author claim on a spoofed `bridge_paper` gains reputation credit. Fix: use `sql.matchAll(re)` + assert the occurrence count matches the call-site count for that alias.

**2. (P2) Notification CTE canary documented but not implemented.** `backend/tests/routes/bridge-paper-author-gate.test.ts:36` (test file header) lists `/api/notifications` user_bridge_papers as covered, but no `describe`/`it` block exercises `fetchNotificationsFromHaf`. SQL is correctly author-pinned today; this is a coverage gap. Add a `describe('fetchNotificationsFromHaf bridge-paper author-pin')` block with `assertBridgeAuthorPin()` on the captured SQL.

**3. (P2) `toPaperSummary` spoofed bridge_paper degradation untested.** `backend/tests/helpers.test.ts` covers `isPevoBridgePaper(meta, author)` directly via 3 spoof-rejection unit tests, but does not cover its consumer. When `meta.type === 'bridge_paper'` but author ≠ bridge, `toPaperSummary` should produce `source_type: 'native'`, `doi: null`. Add a spec asserting that degradation behavior — without it, a future regression that re-narrows `isPevoBridgePaper` to meta-only would slip past helpers + bridge-paper-author-gate test files.

**4. (P2) CI guard `check-bridge-paper-discipline.sh` has no negative test.** Add `backend/tests/scripts/check-bridge-paper-discipline.test.sh` (or analogous): create a temp file with `'bridge_paper'` literal in a non-allowlisted location → run script → assert exit 1; same in allowlisted location → assert exit 0. The guard is the load-bearing defense per the convention; an unverified guard is not a guard.

**5. (P3) CI guard regex matches single-quoted literals only.** `backend/scripts/check-bridge-paper-discipline.sh:61` — bypass forms `"bridge_paper"`, `` `bridge_paper` ``, `'bridge_' + 'paper'` are not detected. Convention demands "any direct literal branching." Extend grep to multi-pattern alternation (`'bridge_paper'\|"bridge_paper"\|\`bridge_paper\``).

**6. (P3) CI guard allowlist `src/types/hive.ts` is dead.** That file uses `"bridge_paper"` (double-quoted), which the single-quoted grep doesn't match — so the allowlist entry is unreachable today. Either remove `src/types/hive.ts` from the ALLOWLIST array, OR if item 5's grep extension lands first AND `src/types/hive.ts` becomes a legitimate single-quoted-literal site, re-justify the allowlist entry. Sequence items 5 and 6 deliberately: if 5 lands first, 6 may need the allowlist entry retained; if 6 lands first, 5's grep extension must add the allowlist entry back.

**7. (P3) Stats canary uses strict equality on bridge-related capture count.** `backend/tests/routes/bridge-paper-author-gate.test.ts:202` — `expect(related.length).toBe(1)`. Other site canaries use `toBeGreaterThan(0)`. Loosen to `toBeGreaterThan(0)` and assert author-pin on every bridge-related capture, mirroring the other 8 site canaries.

**8. (P3) Canary regex is conjunct-order-sensitive.** `backend/tests/routes/bridge-paper-author-gate.test.ts:94-97` — `assertBridgeAuthorPin` requires `<alias>.author = $N AND (<alias>.json_metadata -> $M ->> 'type') = 'bridge_paper'` in that exact order. If the helper at `hafsql.ts:234` ever flips the conjuncts (semantically identical), all 8 site canaries fail red. Rewrite the regex with lookahead/two-pass matching to accept either order, or assert both clauses appear in the same parenthesized substring.

### Items dismissed during architect triage

- **Rotation-blind property of `validPevoPaperWhere`** — current bridge invariant is singular per project memory; revisit when rotation is planned. Empty/whitespace `HIVE_BRIDGE_ACCOUNT` validator extension is rolled into the `backend-pevo-admin-key-startup-validation.md` hold-block (the same validator framework can reject blanks).
- **Frontend POST_BROADCAST_FAILED handler** — separate UI surface, filed as `ui-orcid-callback-post-broadcast-failed-handler.md` in pending/.
- **`loadActiveAuthors` dead code** — predates this task; filed separately as `backend-load-active-authors-dead-code-removal.md` per the chain-primitive-proxy-prefer-deletion convention.
- **Continuation-post hijack** (security pre-existing finding adjacent to this work) — filed as `backend-continuation-post-author-consent-gate.md` in pending/. Companion UI work in `ui-coauthor-continuation-publishing.md`.

### Re-review signal

When items 1-8 land, `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-3 commits and archives on clean.

## Backend re-review signal (2026-04-30, commit `e521a96`)

Round-3 hold items 1-8 all landed in commit `e521a96` (cherry-pick of worker `37bc584`). All changes are scoped to test files + the discipline guard script — no production SQL/JS code paths changed (round-2 implementation was already correct; round-3 hardens canaries + guards against drift).

- **Item 1 (P2)** — `assertBridgeAuthorPin` rewritten to use `matchAll` with optional `expectedCount`; reputation canary tightened to `expectedCount: 2` / `1`. Catches per-site mutations in `reputation.ts:374`/`:494` that the prior first-occurrence-only `match()` missed.
- **Item 2 (P2)** — New `describe('fetchNotificationsFromHaf — user_bridge_papers CTE bridge-author pin')` closes the documented-but-untested coverage gap.
- **Item 3 (P2)** — `helpers.test.ts` covers `toPaperSummary`'s `isPevoBridgePaper(meta, author)` consumer: spoofed bridge from non-bridge author degrades to `source_type: 'native'`, `doi: null`; legitimate bridge from `config.hiveBridgeAccount` renders bridge metadata.
- **Item 4 (P2)** — New `tests/scripts/check-bridge-paper-discipline.test.ts` (5 cases) drives the bash guard via `spawnSync`.
- **Items 5+6 (P3)** — Guard regex extended to single-, double-, and backtick-quoted `bridge_paper` literals; allowlist semantics preserved.
- **Item 7 (P3)** — Stats canary `toBe(1)` loosened to `toBeGreaterThan(0)` with per-capture iteration mirroring the other 8 site canaries.
- **Item 8 (P3)** — `assertBridgeAuthorPin` made conjunct-order-tolerant via two regex passes (author-pin + type-pin matched independently inside the same parenthesized substring).

**Mutation sensitivity verified:** dropping the bridge-author conjunct from `hafsql.ts:234` → 18/26 tests fail red; per-site mutation in `reputation.ts:494` → reputation canary fails red (`expected 1 to be 2`); conjunct-flip in `hafsql.ts:234` → all canaries pass green (semantically identical SQL accepted, item 8 working as intended).

**Targeted tests passing (real HAF + Redis):** `bridge-paper-author-gate.test.ts` 14/14, `helpers.test.ts` 21/21, `hafsql.test.ts` 10 passed + 2 skipped (pre-existing pool gates), `check-bridge-paper-discipline.test.ts` 5/5. `npm run lint` clean. `npx tsc --noEmit` clean.

**No new `[TODO Architect]`** notes this round. The pre-existing round-2 contract-prose TODO carries forward unchanged.

---

## Architect re-review (2026-05-04, round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `e521a96` (round-3 hold items 1-8). 8 personas (correctness, testing, maintainability, project-standards, learnings, security, adversarial, kieran-typescript). All 8 round-3 hold items mechanically applied; mutation-sensitivity verifications in the implementer signal block check out. The substantive bridge-paper auth-gate is correct and comprehensive; remaining issues are about the META-defense (the discipline guard + canary correctness).

### Items to address

**1. (P1) `assertBridgeAuthorPin` line-139 comment contradicts code.** `tests/routes/bridge-paper-author-gate.test.ts:139` says "always group 1 = the author-slot $N". Code at line 169 correctly reads `m[2]`. Line 148's other comment correctly says "group(2) is the bridge-account param slot". Two comments contradict each other in the load-bearing security canary. An auditor reading the wrong comment re-derives the wrong group structure before they can trust the mutation canary.

Fix: refactor the regex to use **named capture groups** rather than positional groups. `/(?<authorSlot>\$\d+)\s+AND\s+...\s*=\s*'bridge_paper'/` (and the type-first variant). Loop body extracts via `m.groups.authorSlot`. Eliminates the comment-vs-code drift class entirely; the regex is self-documenting.

**2. (P1) Document the 6 runtime-equivalent bypass classes in the discipline-guard test + convention doc.** The current regex catches single-/double-/backtick-quoted literals. Six concrete bypasses exist: (a) string concatenation (currently documented as out-of-scope), (b) template literal interpolation (`` `${prefix}_paper` ``), (c) `Array.join` (`['bridge', 'paper'].join('_')`), (d) case-toggle (`'bridge_PAPER'.toLowerCase()`), (e) `.slice` from a longer literal, (f) `String.fromCharCode(...)`. Documenting only (a) while 5 other shapes silently slip through is a credibility gap.

Fix: extend the test file's documented-out-of-scope section to enumerate ALL 6 bypass classes, AND update the convention doc `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` to acknowledge "regex catches direct literals; structural bypasses (concatenation, template interpolation, etc.) are out of scope and require code-review attention or AST-based enforcement (see follow-up task)." The AST-based discipline rule itself is filed as `backend-discipline-guard-pipeline-integration.md`.

**3. (P1) Rename "CI guard" framing to honest "lint check" / "discipline tripwire" wording.** The script header, test file header, convention doc, and task signal blocks all reference the discipline script as a "CI guard". The script is wired only into `npm run lint`. There is no `.github/workflows/`, no pre-commit hook, no `prepare`/`pre-commit` script. `npm test` alone never fires it.

Fix: replace "CI guard" with "lint discipline tripwire" (or similar honest framing) across:
- `backend/scripts/check-bridge-paper-discipline.sh` (header comment)
- `backend/tests/scripts/check-bridge-paper-discipline.test.ts` (file header)
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`
- This task file's signal block (round-3 implementer wording)

The actual mechanical pipeline integration (pre-commit hook OR GitHub Actions workflow) is filed as `backend-discipline-guard-pipeline-integration.md` (paired with item 2's AST rule).

**4. (P3 → batched) Test scaffolding gaps.**
- (a) `tests/scripts/check-bridge-paper-discipline.test.ts` JSDoc lists 6 cases; only 5 are implemented. Item 5 ("same literal in an allowlisted file → exit 0") is documented but missing. The grep-exclusion path is untested. Add the spec: write the literal into a path matching the allowlist (e.g., `src/types/__test_hive__.ts` or directly into `src/types/hive.ts`-shaped path), assert exit 0, clean up.
- (b) `tests/helpers.test.ts` covers `toPaperSummary` spoof + legit bridge cases but not the native-paper case (`type: 'paper'`, any author → `source_type: 'native'`, `doi: null`). Add a one-line `expect(result.source_type).toBe('native')` to the existing pre-existing 'extracts fields from a post' spec.
- (c) `scripts/check-bridge-paper-discipline.sh:33` comment still says "mention `bridge_paper` (single-quoted)" after the multi-quote extension landed. Update to reflect the three-quote-form coverage.

**5. (P2) Move test scratch path out of `backend/src/`.** `tests/scripts/check-bridge-paper-discipline.test.ts` writes scratch files to `backend/src/__discipline_test_scratch__/`. A SIGKILL'd or timed-out vitest run leaves `'bridge_paper'` artifacts inside the live `src/` tree, breaking subsequent `npm run lint` runs until manually cleaned. The convention's own tripwire becomes a sticky false positive.

Fix: move scratch path to `os.tmpdir()` + a unique subdirectory (e.g., `os.tmpdir() + '/pevo-discipline-test-' + crypto.randomUUID()`). Cleanup still in `afterEach` for normal flows; SIGKILL leftovers in `os.tmpdir()` are harmless.

**6. (P2) Escape `.` in the allowlist filter regex.** `scripts/check-bridge-paper-discipline.sh:61` allowlist filter treats `.` as wildcard. Today saved by `*.ts` glob + trailing `:` anchor; future include-filter change opens bypass. Use `\.` (or `grep -F` for fixed-string matching) to escape.

**7. (P2) `spawnSync` overload narrowing.** `tests/scripts/check-bridge-paper-discipline.test.ts:30-36` — `spawnSync('bash', [SCRIPT], { encoding: 'utf8' })` resolves to the wide `SpawnSyncReturns<string|NonSharedBuffer>` overload because `{ encoding: 'utf8' }` is inferred as `{ encoding: string }`. Pass `{ encoding: 'utf8' as const }` to pin the discriminated overload returning `SpawnSyncReturns<string>`. The `?? ''` fallbacks become provably redundant rather than accidentally necessary.

### Items dismissed / deferred during architect triage

- **Whole-file allowlist scope** (security finding) — structural concern; deferred to `backend-discipline-guard-pipeline-integration.md` where the AST-based rule will replace whole-file with structural-path enforcement.
- **Re-export indirection laundering** (`lib/bridge-paper-constants.ts` → ALLOWLIST append) — same scope as above; deferred to the AST-rule task.
- **`assertBridgeAuthorPin` colocation** (maintainability) — premature DRY for a single test file; flag if a second file ever needs the helper.
- **Conjunct-order tolerance regex `groupBody = (?:[^()]+|\([^()]*\))*`** — handles 1 nesting level only. Currently exact-match against helper output; flag if helper ever produces nested parens.

### Architect followups

(none — round-2 contract-prose TODO is unrelated to this round's META-defense work; carries forward unchanged into the eventual archive)

### Re-review signal

When items 1-7 land, `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-4 commit. Items 1-3 are P1; the rest are quality-of-life. Anchor: the regex named-groups rewrite (item 1) is the load-bearing structural change; items 2-7 are mostly prose / one-line fixes around it.

---

## Backend re-review signal (2026-05-04, commit b8bcc40)

Round-4 hold-fix items 1-7 all landed in commit `b8bcc40` (cherry-pick of worker `06d46c66`). All changes scoped to test files + the discipline tripwire script — no production SQL/JS code paths changed.

**Item 1 (P1) — Named capture groups.** `assertBridgeAuthorPin` regex switched to `(?<authorSlot>\$\d+)` named groups in both conjunct-order passes. Loop body extracts via `m.groups?.authorSlot` instead of positional `m[2]`. Eliminates comment-vs-code drift; regex is self-documenting.

**Item 2 (P1) — 6 bypass classes documented.** Added "Documented out-of-scope" section to `tests/scripts/check-bridge-paper-discipline.test.ts` enumerating (a) string concatenation, (b) template literal interpolation, (c) `Array.join`, (d) case-toggle, (e) `.slice` from longer literal, (f) `String.fromCharCode(...)`. Referenced `backend-discipline-guard-pipeline-integration.md` as the structural follow-up.

**Item 3 (P1) — Honest framing.** Renamed "CI guard" → "lint discipline tripwire" in `scripts/check-bridge-paper-discipline.sh` header and `tests/scripts/check-bridge-paper-discipline.test.ts` file header.

**Item 4 (P3 batched) — Test scaffolding gaps.**
- (a) Added the missing 6th case to discipline test: literal in `src/hafsql.ts`-shaped allowlisted file → exit 0.
- (b) Added `expect(result.source_type).toBe('native')` to existing `toPaperSummary` 'extracts fields from a post' spec.
- (c) Updated bash script line 33 comment to reflect the three-quote-form coverage.

**Item 5 (P2) — Scratch path to `os.tmpdir()`.** Test scratch path moved from `backend/src/__discipline_test_scratch__/` to `os.tmpdir() + /pevo-discipline-test-${randomUUID()}`. Required adding env-var override `BRIDGE_PAPER_DISCIPLINE_ROOT` to the bash script so tests can drive scanning at the temp root. SIGKILL no longer leaks `'bridge_paper'` artifacts inside `backend/src/`.

**Item 6 (P2) — `.` escaped in allowlist regex.** Bash parameter expansion `${path//./\\.}` per entry before joining.

**Item 7 (P2) — `spawnSync` overload narrowing.** Pinned `encoding: 'utf8' as const`. `result.stdout`/`stderr` typed `string`; `?? ''` fallbacks remain only for the `status` (signal-kill) edge.

### Verification

- Targeted vitest: `tests/routes/bridge-paper-author-gate.test.ts` 14/14, `tests/helpers.test.ts` 22/22, `tests/scripts/check-bridge-paper-discipline.test.ts` 6/6. Total 42/42.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean. Discipline tripwire reports `bridge-paper discipline OK`.
- **Mutation sensitivity verified:** dropped the bridge-author conjunct from `hafsql.ts:234` → 13/14 canary tests fail red across papers, paper-detail, search, stats, disciplines, comments, bridge/check, sitemap, notifications, reputation. The 1 passing test is the `source=native` asymmetry check (intentionally lacks a bridge arm). Restored; all green again.

### [TODO Architect]

- **Convention doc** `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`: enumerate the same 6 bypass classes (item 2 partial); update prose from "CI guard" to "lint discipline tripwire" framing (item 3 partial). Backend cannot edit `agents/docs/solutions/conventions/...` per backend CLAUDE.md.
- **Round-2 contract prose carry-forward**: `agents/docs/api-contracts/papers.md` bridge-paper author-identity-as-contract note remains pending.
