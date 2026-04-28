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
