# Backend: reputation single source of truth

**Owner:** backend
**Created:** 2026-04-22

## Problem

`/stats` and the profile page disagree on a user's reputation. Observed: `/stats` shows highest reputation `5`, profile `@pevo.science` shows `7`. Same algorithm, same data, different numbers.

Root causes:

1. **Two read paths with different semantics.**
   - Profile (`backend/src/routes/profile.ts:165`) calls `getReputationScore()` → `computeReputationSql()` → `computeReputationBatch([user], prev=batchMap, cycleEndBlock=HEAD)`. A fresh on-demand SQL compute at the head block. Returns whatever the latest head-block recompute produces.
   - Stats (`backend/src/routes/stats.ts:79`) calls `getBatchReputationMap()` which reads `${appTag}:reputation:batch:*` keys written by the periodic batch job. The batch job writes scores computed at each cycle-end block, not head.
   - Because the profile uses head-block and stats uses the last cycle-end block, the two pages produce different numbers whenever any activity lands mid-cycle.

2. **Missed prefix in the commit `41952f5` migration.** `backend/src/reputation.ts:785` in `getBatchReputationScores()` still constructs unprefixed keys (`reputation:batch:${u}`). That creates a third namespace used by paper lists and profile-papers author badges, which disagrees with both stats and profile whenever the test suite's `tests/setup.ts:21` flush wipes the prefixed keys while unprefixed stale keys survive.

## Standard (agreed)

Reputation is cycle-based. A user's reputation is a deterministic function of on-chain data as of the most recent completed cycle boundary, optionally adjusted by accreditation grant or revocation events observed on HAF since that boundary. Every read path (`/stats`, profile, paper lists, comment badges, review details) resolves to the same value within a cycle. Within a cycle, a user's score changes only in response to accreditation grant or revocation; all other reputation inputs (papers, reviews, citations, votes) fold in at the next cycle boundary. Cycle length is configured in `ReputationWeights.cycle_blocks` (currently 1 day for testing; ~7 days in production per `project_reputation_cycle_length` memory).

A freshly-accredited user's score equals `accreditation_bonus` (default `5`) from the moment their accreditation is recognized, even if they have never published and even before the next batch cycle completes. Papers, reviews, citations, and received votes add on top across subsequent cycles.

A user who is not currently accredited has score `0`, regardless of any historical publications, reviews, or received votes. Accreditation is the trust layer; revocation removes a user from the scored population entirely, not merely subtracts the bonus. If accreditation is later restored, historical on-chain activity flows back into their score at the next cycle (per-event "was author accredited at the time" gating is out of scope for this task).

This rules out head-block recomputation from any request handler.

## Scope

### 1. Batch scope = currently-accredited users; rename the conflated helper

Today `backend/src/reputation.ts:19` `loadActiveAccounts()` returns authors of PEvO papers or reviews. It is used for two different purposes that share the same set today but are semantically different:

- **Users to score** (fed into `computeReputationBatch` via `reputation-batch.ts:122`). Per the Standard, non-accredited users have score 0, so there is no reason to compute scores for them. Feed `getAllAccreditedAccounts()` (already exists, see `backend/src/accreditation.ts`) directly.
- **Active authors** (fed into the `active_accounts` CTE inside `computeReputationBatch`, which gates the accredited-active voter-weight bonus). This is the current narrow "published a paper or review" definition. A newly-accredited but non-publishing user should not get the accredited-active voter bonus, so this set stays separate.

Once the two purposes are split, the shared name becomes a trap for the next reader. Rename the author-only helper as part of this task:

- `loadActiveAccounts` → `loadActiveAuthors` (`backend/src/reputation.ts:19`)
- `getActiveAccounts` → `getActiveAuthors` (`backend/src/reputation.ts:53`)
- `startActiveAccountsCache` → `startActiveAuthorsCache` (`backend/src/reputation.ts:59`)
- `hafCache` key `active_pevo_accounts` → `active_pevo_authors` (two call sites in `reputation.ts`; old key self-expires on the next periodic refresh, no migration needed)
- SQL CTE `active_accounts` → `active_authors` (`backend/src/reputation.ts:231`, `:259`, the doc comment at `:165`, and the two copies in `backend/tests/bench-reputation.ts:113,137,359,383`)
- Local variable in `backend/src/reputation-batch.ts:122` becomes `scoredUsers = await getAllAccreditedAccounts()` (feeding `computeReputationBatch`); the author set is still needed inside the SQL CTE but is rebuilt there from HAF, independent of this variable.

Clarification to prevent a likely implementer mistake: the `active_authors` CTE inside `computeReputationBatch` is self-contained — it re-queries HAF for authors inside the SQL. Do NOT try to pass `activeAuthors` as a new SQL parameter duplicating the TS helper; the split works because TS-side and SQL-side each compute the set they need independently.

Caller audit: grep `getActiveAccounts|active_accounts|active_pevo_accounts` and update every hit. The only non-test callers today are in `reputation.ts` and `reputation-batch.ts`; the tests in `bench-reputation.ts` are standalone SQL copies that need the CTE rename too.

Cost check: at today's scale (5 accredited) the delta vs today is ~2 users. At 1k accredited the batch loop scales linearly with accredited count; shared CTEs dominate and per-user aggregation is cheap. Benchmark once at 100+ accredited users before go-live.

### 2. Accreditation lifecycle: seed on grant, invalidate on revoke

Two symmetric helpers in `backend/src/reputation.ts` keep the batch map in sync with accreditation state between cycle boundaries:

**`seedAccreditationBonus(username)`** — called when accreditation is recognized.
- Reads the current `accreditation_bonus` from weights and writes the provisional entry `{score: accreditation_bonus, breakdown: {papers: 0, reviews: 0, citations: 0, accreditation: accreditation_bonus}}`.
- Implementation MUST use the Redis `SET key value NX` primitive — do not implement check-then-write with separate `GET` and `SET` commands. The boot backfill iterates all accredited users while the scheduled batch starts 10s later, and accreditation events fire while a batch may be running, so the `GET`-then-`SET` race is real: seed reads null → batch writes real score → seed writes provisional → real score clobbered until next cycle.
- Under `SET NX`, the seed never overwrites a real cycle-computed score; it only wins when the key is absent.

**`invalidateOnRevocation(username)`** — called when revocation is recognized.
- Unconditionally `DEL`s the user's batch key. Reader then returns 0 for that user, consistent with the Standard.
- Required for correctness, not just UX: a revoked user with no authored papers drops out of `getAllAccreditedAccounts()`, so the batch will not recompute their entry at the next cycle. Without explicit invalidation, the provisional seed (or any stale prior score) persists in Redis indefinitely until manual `DEL`. A published user whose entry is not invalidated keeps their pre-revocation score — including the `accreditation` breakdown component — for up to one cycle (≤ 7 days in production).

**Call sites** — both helpers must fire for every path through which accreditation state changes on-chain:
- Backend-originated events: `backend/src/routes/accreditation.ts` after the `accredit` or `revoke` attestation is broadcast and acknowledged.
- Externally-originated events: accreditation and revocation custom_json operations can be broadcast by admins via Hive Keychain or by future DAO / WoT paths independent of the backend route. The backend must observe these too. Identify the single block-watcher (or equivalent) that already notices these custom_json ops in HAF and hook both helpers there. If no such watcher exists, the fallback is: the next batch cycle catches grants (seedAccreditationBonus is idempotent) but revocations of never-published users leak until the next cycle's `getAllAccreditedAccounts()` lookup excludes them — then the stale seed persists indefinitely. Confirm the entry points before coding and document them in the implementation notes.

**Boot backfill** — non-blocking, fire-and-forget after `app.listen()`. Add an entry to the existing `Promise.all([...])` background-warmup block at `backend/src/index.ts:51-56` (alongside `startActiveAccountsCache`, `startReputationWeightsCache`, etc.): iterate `getAllAccreditedAccounts()` and call `seedAccreditationBonus()` for each (idempotent under `SET NX`). Covers accredited users whose batch entries don't exist yet because the batch hasn't caught up. During the backfill window (typically 1–3 s, bounded by the HAF query for accredited accounts) a freshly-accredited user with no authored papers may see score 0 on their profile. Accepted — the window is short, the user's profile is still functional, and the existing after-listen warmup pattern is for exactly this kind of best-effort refresh that can self-heal. Revocation invalidation at boot is not necessary for correctness because the batch job itself excludes revoked users from the scored set; only stale entries from the pre-refactor era can exist, and those are cleared by the deploy-time flush in item #8.

**Authority handoff** — the next cycle overwrites the seeded entry with the full computation and never writes for revoked users. From that cycle on, the batch job is authoritative for everyone still accredited.

### 3. Batch writer persists full `ReputationScore` (score + breakdown), atomic cycle swap

Two changes to `backend/src/reputation-batch.ts:140-155`:

**Value shape.** The batch job currently stores only the numeric score (`pipeline.set(key, String(score))`). Store the full `ReputationScore` (`{score, breakdown}`) as JSON. The profile UI consumes `breakdown` for the component bar chart (`frontend/src/pages/profile.js:103-117`), so dropping it is not acceptable.

Compatible shape: `JSON.stringify({score: number, breakdown: {papers, reviews, citations, accreditation}})`.

**Atomic cycle swap.** The current writer pipelines `SET` commands directly to the production keys (`${appTag}:reputation:batch:${user}`) and finally `SET`s `cycle:last`. If the job crashes between per-user writes and `cycle:last` update, or is OOM-killed mid-pipeline, readers see a temporally inconsistent mix: some users on cycle N, some on cycle N-1. That violates the "everyone sees the same value within a cycle" invariant.

Fix: stage the new cycle's values under `${appTag}:reputation:batch:staging:${user}` during the cycle compute, then execute a single Lua script at the end that atomically `RENAME`s every staging key into its production name and sets `cycle:last`. Readers see either the whole new cycle or none of it.

Script shape (~10 lines):

```lua
-- KEYS[1..N] = staging key paths
-- ARGV[1] = new cycle number
-- ARGV[2] = cycle:last key path
for i = 1, #KEYS do
  local staging = KEYS[i]
  local prod = string.gsub(staging, ':batch:staging:', ':batch:')
  redis.call('RENAME', staging, prod)
end
redis.call('SET', ARGV[2], ARGV[1])
return #KEYS
```

Invoke via `redis.eval(script, stagingKeys, [cycle, cycleLastKey])`. Redis Lua is atomic (single-threaded server, no interleaving), so the script's runtime doubles as the "blocking gap" for other clients: <1 ms at today's 3 accredited users, ~10 ms at 1k users (RENAME is O(1) per key, Redis handles ~100k–1M ops/sec). Acceptable at all projected scales; revisit if accredited count crosses ~10k.

Crash-recovery: if the batch job crashes mid-cycle before the Lua swap, the staging keys linger. On restart, treat any leftover `:batch:staging:*` keys as abandoned — DEL them before starting the next cycle. Document this cleanup step in the batch-job entry point.

### 4. Unify every reputation read through the batch map

All four request-handler callers read from `${appTag}:reputation:batch:*` only. No on-demand SQL from any request path.

- `backend/src/reputation.ts:68` `getBatchReputationMap()` — change return type from `Map<string, number>` to `Map<string, ReputationScore>`; parse JSON values.
- `backend/src/reputation.ts:743` `getReputationScore(username)` — collapse to a single Redis GET via `batchKey(u)`; parse; return `{score: 0, breakdown: {...}}` when user has no batch entry. Remove the 1h `hafCache.getOrSet('reputation:${username}', ...)` wrapper and the `computeReputationSql` fallback — they are redundant when the batch map is the source of truth.
- `backend/src/reputation.ts:761` `getReputationScores(usernames)` — MGET over prefixed keys; parse; return score-only map. **Delete the `missing.map(...)` fallback loop at `reputation.ts:756-766` entirely.** After this task, `getReputationScore` is a thin Redis lookup that already returns zero on miss, so the loop is dead code — pure overhead calling a function that returns zero for users not in the map. Missing users simply get `0` (or are absent from the returned map; existing callers already handle `undefined`).
- `backend/src/reputation.ts:808` `getBatchReputationScores(usernames)` — this is the prefix-drift bug. After unifying, it is behaviorally identical to the simplified `getReputationScores`. Delete it and point callers (`backend/src/routes/profile.ts:269`, `backend/src/routes/papers.ts:375`) at `getReputationScores`.

The internal caller at `reputation.ts:197` (`computeReputationBatch`'s default `prevScores`) should still source from the batch map but flatten to `{username: score}` for the SQL parameter.

Three internal callers of `getBatchReputationMap` must be updated in lockstep with the return-type change. Missing any one of them silently breaks scoring:

- `backend/src/routes/stats.ts:79-85`: iterate the map extracting `.score` before comparison (`for (const [username, rep] of repMap) { if (rep.score > highest ...)`). Without this, the object comparison produces NaN and stats always returns `highest_reputation_score: 0`. Preserve the existing behavior that `highest_reputation_user` stays `null` unless some user has a score strictly greater than 0 — the frontend template conditional at `frontend/src/pages/stats.js:38` hides the card when the field is falsy, which is the correct rendering for the "fresh Redis, no cycle completed yet" state.
- `backend/src/reputation.ts:197`: the flatten-to-`{username: score}` is already required for the `$5::jsonb` SQL parameter (`value::numeric` cast). Lift it into a helper (`batchMapToScoreRecord`) so every score-only caller shares one code path. Forgetting this breaks the SQL cast and silently collapses every `voter_weights` row to 1.0 for the next cycle.
- `backend/src/reputation-batch.ts:96-108`: prev-scores rehydration from Redis currently does `Number(values[i])`. Change to JSON-parse + `.score`. Extract a shared `parseBatchValue(raw): ReputationScore | null` helper in `reputation.ts` so the batch job and the map reader use the same parse.

### 5. `computeReputationSql` retirement

After step 2, `computeReputationSql` has no callers. Delete it. The batch job continues to use `computeReputationBatch` directly.

### 6. Regression test: prefix invariant

Add `backend/tests/routes/reputation-prefix.test.ts` (integration-style, against real Redis — the `CLAUDE.md` "no mocked database pools" policy applies; no carve-out is needed here because real Redis is cheap) asserting every Redis key written by the batch job begins with `${config.appTag}:reputation:`.

Minimum assertions:

- Run `runBatchComputation()` once against a test-fixture HAF state, then assert:
  - `await redis.keys('reputation:batch:*')` is empty (no unprefixed writes — the bare glob catches writes from any future code that skips the prefix).
  - `await redis.keys('reputation:cycle:last')` returns an empty array (same for the cycle marker).
  - `await redis.keys('${config.appTag}:reputation:batch:*')` is non-empty (prefixed writes landed).
- Round-trip: write a known `{score, breakdown}` to a prefixed key directly, then read via `getBatchReputationMap()`, `getReputationScore()`, and `getReputationScores()` and assert all three return the same score value. Ensures the three readers stay consistent.

The `backend/tests/setup.ts:21` global flush under `${config.appTag}:*` does NOT match the bare `reputation:*` pattern, so the regression check above is the ONLY thing that would catch a future unprefixed write: state that explicitly in the test file header so the next maintainer does not "helpfully" rewrite the assertions to use `${appTag}:*` and silently defeat the test.

### 7. Stats/profile parity test

Add `backend/tests/routes/stats-profile-parity.test.ts` asserting that `/api/stats` and `/api/profile/:username` return the same score for the same user. The test is about reader parity, not batch correctness — seed Redis directly with known `{score, breakdown}` values (several users, one clear highest), then hit both endpoints and assert:

- `/api/stats` `highest_reputation_user` equals the username of the seeded highest-score user.
- `/api/stats` `highest_reputation_score` equals that user's seeded `score`.
- `/api/profile/:<highest-user>` `reputation.score` equals the same value.

Do not invoke `runBatchComputation()` in this test — that would duplicate coverage from item #6's prefix regression and make the parity test HAF-state-dependent. The batch job's correctness is validated separately; this test only verifies every reader resolves to the same value once the batch map is populated.

### 8. Stale-key cleanup and deploy-time flush (operational, not code)

Two distinct sets of keys need to be deleted on the deploy that ships this task:

**Legacy unprefixed keys** (dead data from before commit `41952f5`'s prefix migration; no current reader):

```
reputation:batch:pevo.science
reputation:batch:pevotest.anon
reputation:batch:pevotest.bridge
reputation:cycle:last
cache:retracted-papers
```

**Current prefixed batch keys** (alive but in the old numeric-string shape; readers of the new JSON shape would see them as malformed data for one full cycle — up to 7 days in production):

```
${appTag}:reputation:batch:*
${appTag}:reputation:cycle:last
```

On the same deploy that ships the JSON shape change (item #3), `DEL` both sets before the new backend starts accepting traffic. The batch job then recomputes from cycle 0 to current cycle on first run (existing recovery behavior, see work item #2 Redis-flush criterion). No persistent migration needed.

Document the exact `redis-cli` commands in the implementation-notes section below so the implementer runs them against dev before opening for review, and the deploy runbook entry surfaces them for staging and prod.

## Acceptance criteria

- Every reputation value displayed in the UI (stats highest, profile score + breakdown, paper-list author badges, review detail `reviewer_reputation`) is derived from the same `${appTag}:reputation:batch:${user}` value.
- `getBatchReputationScores` and `computeReputationSql` are deleted. No on-demand reputation SQL runs from any request handler.
- Prefix regression test passes and would fail if a future change reintroduces an unprefixed key.
- Stats/profile parity test passes.
- Manual check: `curl /api/stats | jq .highest_reputation_score` matches `curl /api/profile/<that-user> | jq .reputation.score`.
- Deploy sequence documented: both legacy unprefixed keys AND current prefixed batch keys (in old numeric-string shape) are flushed before the new backend starts accepting traffic. Batch job recomputes from cycle 0 on first run.
- A freshly-accredited user with no publications shows `accreditation_bonus` on their profile immediately after the accreditation transaction is acknowledged (not after the next cycle). Covered by an integration test that accredits a fresh account and asserts `/api/profile/:username` returns `reputation.score === accreditation_bonus` without waiting for a cycle boundary.
- A revoked user shows `reputation.score === 0` immediately after the revocation transaction is acknowledged, regardless of any historical publications. Integration test: accredit a fresh account, seed a fake batch entry with a non-zero historical score (or publish one paper to give them a real non-zero score), revoke them, assert `/api/profile/:username` returns 0 on the next request without waiting for a cycle boundary.
- `backend/src/index.ts` fires the boot-time accreditation-bonus backfill as part of the existing non-awaited `Promise.all([...])` block inside the `app.listen()` callback (lines 51-56). The listener binds immediately; the backfill self-heals any missing seeds in the background. During the backfill window (typically 1–3 s after boot) a newly-accredited user with no authored papers may briefly see score 0. Accepted.
- Redis flush recovery: delete every reputation key (`DEL ${appTag}:reputation:batch:*`, `DEL ${appTag}:reputation:cycle:last`) on a running instance, restart, confirm `/api/profile/:username` shows `accreditation_bonus` immediately (from boot backfill) and reaches the correct cycle-computed score after the first scheduled batch run completes.
- Batch idempotency: running `computeReputationBatch(users, prevScores, cycleEndBlock)` twice against the same inputs produces a byte-identical `Map<string, ReputationScore>` result. Covered by a unit test that snapshots the first run's JSON output, re-runs with the same inputs, and asserts equality. Proxy for determinism; catches non-deterministic SQL (missing `ORDER BY`, unstable `DISTINCT`, floating-point reordering).

## Non-goals

- Changing the reputation algorithm, weights, or cycle length. (The cycle-length-for-prod change is tracked separately per the `project_reputation_cycle_length` memory.)
- Handling `accreditation_bonus` weight changes mid-cycle. If the on-chain weight is updated while a user has a provisional entry, the provisional entry is stale (still reflects the old bonus) until the next cycle recomputes. Users accredited BEFORE the weight change and users accredited AFTER the weight change can therefore show different bonus amounts during the same cycle. Accept. `update_weights` events are rare, the divergence is bounded (both users converge to the new weight at the next cycle boundary), and the alternative (re-sweeping every provisional seed on every `update_weights` event) is disproportionate complexity for a low-frequency event.
- UX affordance for the publish-to-visible lag. Papers, reviews, citations, and received votes fold into the displayed score at the next cycle boundary (≤ 7 days in production), not instantly. No "last updated" timestamp or "as of cycle N" label is planned. Reputation is a trailing indicator of scientific standing — a paper needs time to be read, reviewed, cited, and voted on before it should move the author's score. The cycle cadence matches the real-world pace of reputation accrual; an immediate score bump on publish would misrepresent the signal.
- Frontend changes to the profile breakdown bar chart. For a freshly-seeded accredited user, `{papers: 0, reviews: 0, citations: 0, accreditation: 5}` renders three zero-width bars next to one full bar. The existing unconditional iteration in `frontend/src/pages/profile.js:384-398` is acceptable as-is — empty bars communicate what future activity will contribute. No suppression of zero-value entries.
- Schema additions for historical reputation tracking (per-cycle history in SQL).

## Implementation notes
