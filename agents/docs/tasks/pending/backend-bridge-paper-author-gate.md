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
