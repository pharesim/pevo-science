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

### Deploy-time Redis flush

Per scope #8, two distinct sets of keys must be deleted on the deploy that ships this task. Run these `redis-cli` commands BEFORE the new backend starts accepting traffic on each environment (dev, staging, prod). The batch job recomputes from cycle 0 to current cycle on first run.

```bash
# 1. Legacy unprefixed keys (dead data from before commit 41952f5's prefix
#    migration — no current reader, but cleaning up for hygiene).
redis-cli DEL \
  reputation:batch:pevo.science \
  reputation:batch:pevotest.anon \
  reputation:batch:pevotest.bridge \
  reputation:cycle:last \
  cache:retracted-papers

# 2. Current prefixed batch keys (alive but in the old numeric-string shape;
#    readers of the new JSON shape would see them as malformed for one cycle).
#    Replace ${APP_TAG} with the deployment's actual tag (`pevo` or `pevotest`).
redis-cli --scan --pattern "${APP_TAG}:reputation:batch:*" | xargs -r redis-cli DEL
redis-cli DEL "${APP_TAG}:reputation:cycle:last"
```

After flush, the batch job's first run starts from `lastComputedCycle = -1` and catches up to the current cycle. The boot backfill (`backfillAccreditationSeeds`) seeds every accredited user's provisional entry in parallel, so profiles render `accreditation_bonus` immediately while the catch-up runs.

### Externally-broadcast accreditation events

The current `block-watcher.ts` is a polling cache invalidator (clears volatile hafCache entries on each new HAF block); there is no event-level processor that reads custom_json operations. Backend-originated accredit/revoke broadcasts call `seedAccreditationBonus` / `invalidateOnRevocation` synchronously after the broadcast acks. Externally-originated broadcasts (admin Hive Keychain, future DAO/WoT paths independent of backend routes) hit the documented fallback:

- **Grants**: caught at the next batch cycle when the user enters `getAllAccreditedAccounts()`. The boot backfill handles them on restart. `seedAccreditationBonus` is idempotent under SET NX, so duplicate seeding from external + backend-originated paths is safe.
- **Revocations of users with no authored papers**: leak indefinitely. The next cycle's `getAllAccreditedAccounts()` excludes them, so the batch never recomputes their slot, and no event-level processor exists to DEL the stale seed. Acceptable trade-off per the task spec; revisit if/when an event-level custom_json processor is added.
- **Revocations of users with authored papers**: persist for up to one cycle (the user remains in the previous cycle's batch output). The next cycle's `getAllAccreditedAccounts()` excludes them and the new cycle's `RENAME` overwrite never fires for their slot, so their old prod key persists. The deploy-time flush above is the cleanup for any pre-refactor stale entries; ongoing operational hygiene relies on backend-originated revocations calling `invalidateOnRevocation` directly.

---

## Architect re-review (2026-05-05, round-1) — HELD PENDING FIXES

`/ce-code-review` ran on commits `3d86e97..a370ee2` (8 commits, 1646-line diff, 15 files). 10-persona pass: correctness, testing, maintainability, project-standards, learnings, security, performance, adversarial, reliability, kieran-typescript. `ce-agent-native-reviewer` skipped per project CLAUDE.md.

The work that landed cleanly stays: helper extraction (`parseBatchValue`), atomic Lua swap shape, idempotency test framework, parity test framework, prefix invariant test, helper rename `active_accounts → active_authors` across all 15+ sites including bench-reputation.ts. These do not need rework.

**The hold is structural.** Findings 2-10 below cross-corroborate (correctness + adversarial + security + reliability all flag the same class) and demonstrate the SSoT goal — *"every reader resolves to the same value within a cycle"* — is broken in 4+ ways introduced or unrepaired by this work. Stats vs profile divergence, the very thing the task was filed to fix, returns through different mechanisms.

### Items to address

### Direction-of-truth — settled 2026-05-05

The chain is the SSoT for accreditation. The Redis batch map is a performance cache of computed scores; it is not authoritative. Every reader that surfaces a reputation value MUST gate on chain accreditation (`getAccreditation(username)` or set membership in `getAllAccreditedAccounts()`) before displaying a score. `backend/src/routes/profile.ts:142-161` already encodes this pattern; stats, papers list, comments enrichment, and any future reader extend it symmetrically. This rule is downstream of the root `CLAUDE.md` design principles "Hive-native, not Hive-wrapped" and "Reputation is computed, not tokenized" and was confirmed explicitly by the user during this re-review.

This settles the architectural cluster the original anchor flagged. The findings below are reframed in light of this direction:

- **Item #2 is downgraded to P3 hygiene.** Stale prod entries for chain-revoked users become a Redis memory leak, not user-visible divergence — the reader gate short-circuits revoked users to 0 regardless of cache state. Optional fix: post-Lua DEL pass for orphan prod keys (prod keys with no matching staging key in the latest cycle), OR accept as residual. Defer unless implementing it is cheap as part of the Lua script change.
- **Items #3 and #4 take a specific shape.** Add the chain pre-check pattern from `backend/src/routes/profile.ts:142-161` to:
  - `backend/src/routes/stats.ts:79-85` (item #3) — before picking max `.score`, intersect the batch map with `getAllAccreditedAccounts()` (already hafCache-backed; cheap Set membership). Users not in the accredited set are excluded from the max calculation.
  - `backend/src/routes/papers.ts:372-376` and `backend/src/routes/comments.ts:147-159` (item #4) — for each author/commenter, gate the displayed `author_reputation` / `reviewer_reputation` on chain accreditation; non-accredited users render score 0.
  - Use the existing hafCache-backed accreditation lookup; do NOT add a new HAF roundtrip per request.
- **Items #5, #7, #9, #10 stay at P1**, reframed as **batch-quality** correctness rather than SSoT divergence. The reader gate is defense-in-depth against stale cache, not a license to let the cache drift. The batch must compute correct values, advance `cycle:last` only on real cycles, resist multi-instance races, and keep its own state honest about what's been processed.
- **Items #6, #8, #11–#21, #22–#29 are unchanged.** They cover parse-error visibility, broadcast-failure discrimination, helper reuse, missing test coverage, and polish — all independent of the SSoT direction.

Items 3, 4, 5, 6, 7, 8, 9, 10, 11 are independent enough to fan out into parallel commits. Each commit MUST use the bare `backend:` or `backend(<scope>):` prefix per item #1 so the zone-audit hook fires.

#### P0 — commit hygiene

**1. (P0) Use bare `backend:` / `backend(<scope>):` prefix on all future commits for this task.** All 8 commits in this task used conventional-commit wrappers (`feat(backend):`, `refactor(backend):`, `test(backend):`, `docs(backend):`, `chore(tasks):`) which fall through to the unrecognized-prefix path in `.githooks/commit-msg` and silently skip the zone-audit hook (per root CLAUDE.md "Subject-prefix style for agent commits"). Already-landed commits cannot be retroactively re-audited; the next round's commits MUST use the bare form so the audit fires. Verify with `bash .githooks/tests/test-commit-msg.sh` if the hook itself is touched.

#### P1 — SSoT goal not achieved (the central architectural cluster)

**2. (P1) External revocation leaves stale prod entries indefinitely.** `backend/src/reputation-batch.ts` (`CYCLE_SWAP_LUA` + `runBatchComputation`). When a user is dropped from `getAllAccreditedAccounts()` (admin Hive Keychain revoke, future DAO/WoT path, or HAF blip caching `[]` for 10 min), the next cycle's `scoredUsers` doesn't include them, no staging key is produced for them, and the Lua RENAME never touches their prod slot. Their pre-revocation score persists across all future cycles forever. The current implementation-notes claim "Revocations of users with authored papers persist for up to one cycle" — **mechanically wrong**. The leak is permanent. Fix shape options: (a) post-Lua DEL-pass for prod keys not in the new staging set, (b) every reader pre-checks chain accreditation symmetrically with `/api/profile/`, (c) explicitly accept-as-residual and rewrite the implementation notes to be honest. Decide with architect before implementing — the right fix depends on the readers-vs-cycle ownership question.

**3. (P1) Stats vs profile divergence restored via different mechanism.** `backend/src/routes/stats.ts:88` reads `getBatchReputationMap()` and picks max `.score` with no accreditation cross-check. `backend/src/routes/profile.ts:142-161` pre-checks chain accreditation via `getAccreditation(username)` and short-circuits to score 0 for any user the chain says is not accredited. Once any stale entry exists (per finding #2, #5, or #6), `/api/stats` reports a `highest_reputation_user` whose own profile shows `is_accredited:false, score:0`. This is the exact two-reader divergence the task Standard prohibits, restored through a different mechanism. Choose: pre-check chain accreditation in stats too (symmetric reader gating), OR drop the chain pre-check from profile (single source = batch map, leaks become user-visible), OR make the batch map itself self-consistent with chain (finding #2 fix). The three options are mutually exclusive; pick one with architect.

**4. (P1) Papers list enrichment shows `is_accredited:false` next to non-zero `author_reputation`.** Same divergence at `backend/src/routes/profile.ts:265-278`, `backend/src/routes/papers.ts:372-376`, `backend/src/routes/comments.ts:147-159`. Each does parallel chain-accreditation + Redis-score reads with no cross-check. User-visible incarnation of finding #3 — list views render `author_reputation: 50` next to a "not accredited" badge for revoked-but-stale users. Same fix-shape decision as #3.

**5. (P1) Empty-`scoredUsers` early return advances `cycle:last` without clearing prior prod entries.** `backend/src/reputation-batch.ts:142-147`. On HAF blip or transient empty set, the early return logs "skipping cycle" and bumps `cycle:last` unconditionally. Combined with finding #2, a transient HAF failure during a revocation creates permanent stale entries that no future cycle can clean up. Fix: either DEL existing prod entries on empty cycle, or refuse to advance `cycle:last` when the empty-set is the cached-on-error sentinel rather than a legitimate empty population.

**6. (P1) Missed deploy-time flush silently degrades every reader to 0 for one full cycle.** `backend/src/reputation.ts:34-54` (`parseBatchValue`). Operator forgets the runbook flush. Pre-existing keys hold numeric-string `'42'`. Boot backfill uses `SET NX`, finds keys present, skips. `parseBatchValue('42')` parses to a number (not an object), the `typeof parsed === 'object'` guard rejects, returns `null`. Every reader returns `ZERO_SCORE`. Stats `highest_reputation_user` is null, frontend hides the card. **No error log. No alert. No metric counter for parse failures.** Fix: `parseBatchValue` should `logger.warn({ raw, error })` on shape-mismatch (rate-limited) so a deploy-flush-skipped state surfaces on the first request, not after a user complaint. Optionally a Prometheus-style counter for the parse-failure rate, gated by whether PEvO has metrics infra.

**7. (P1) WoT `cascadeRevocation` broadcast-timeout path skips `invalidateOnRevocation`.** `backend/src/wot.ts:354-407`. The invalidate fires only on the broadcast-success branch (line 365). On `BroadcastTimeoutError` the catch (line 388-407) logs and continues without DEL'ing the user's batch entry. Timeout outcome is ambiguous — the op may have landed on chain. Result: user is revoked per chain but their batch entry persists, feeding finding #3. Fix: invalidate before the broadcast on the timeout-ambiguous path (cost of an erroneous DEL is one cycle of zero score for a still-accredited user, recovered next cycle; cost of NOT DEL'ing is permanent leak per #2).

**8. (P1) signup-verify and `/link` return 200 OK after broadcast failure with no seed.** `backend/src/routes/signup-verify.ts:298-336, 427-466`. When `broadcastJsonWithTimeout` throws on `/confirm` or `/link`, the catch logs error and falls through to JWT issuance. User gets a session for an account activated in pg but NOT accredited on chain, with no Redis seed. Per task fallback ("next batch cycle catches grants") this should self-heal — but the chain op never landed, so it doesn't. The `orcid.ts` path correctly handles this via `PostBroadcastWriteError → 502 POST_BROADCAST_FAILED` (per the archived `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` convention). Fix: adopt the same `PostBroadcastWriteError` discrimination at both signup paths so broadcast failure produces 502, not 200 + dangling JWT.

**9. (P1) HAF transient failure causes silent permanent cycle skip.** Sibling to #5. `backend/src/accreditation.ts:62-81` — `getAllAccreditedAccounts()` catches HAF query errors and returns `[]`. `hafCache.getOrSet` caches the empty result for 10 min. The batch advances `cycle:last` over those empty cycles. On HAF recovery the skipped cycles are NEVER recomputed; subsequent cycles compute `prev_scores` from empty state, defaulting voter weights to 1.0 (the SQL `WHEN ps.rep IS NULL THEN 1.0` branch). NEW exposure introduced by scope #1's switch to feeding `getAllAccreditedAccounts()` directly into `scoredUsers`. Fix: distinguish "HAF returned 0 accredited" (legitimate, advance) from "HAF query failed, cached empty" (re-throw or sentinel; do not advance). Cleanest is to have `getAllAccreditedAccounts` re-throw on HAF error so the batch's outer catch logs and bails without bumping cycle.

**10. (P1) Multi-instance batch race corrupts cycle state.** `backend/src/reputation-batch.ts:46-47, 84-90`. `batchRunning` is a module-local boolean — no Redis-distributed lock. PEvO supports horizontal scaling per `startup-checks.ts` ORCID safety preamble. Two backend instances both fire `runBatchComputation`. Both stage to the same `${appTag}:reputation:batch:staging:${user}` keys. First instance's Lua RENAMEs them; second instance's Lua hits "ERR no such key" and aborts. Worse: with cycle-catchup, instance B could RENAME a staging value instance A wrote for cycle N+2 into B's cycle N+1 prod slot. Fix: `SET ${appTag}:reputation:batch:lock NX EX 1800` gating the body of `runBatchComputation`; release with EVAL compare-token DEL on finally. The `DEFAULT_MAX_DURATION_MS` (30 min) is the natural EX value.

#### P2 — moderate

**11. (P2) `prev_scores` rehydration bypasses the extracted helper the spec called out.** `backend/src/reputation-batch.ts:145-157` writes a hand-rolled keys/filter/mget/parse loop that exactly reproduces what `batchMapToScoreRecord(await getBatchReputationMap())` already does. Three copies of the staging-filter-and-parse pattern still exist (`reputation.ts:168-189`, `reputation.ts:311`, this one). Scope #4 explicitly required: *"Lift it into a helper (batchMapToScoreRecord) so every score-only caller shares one code path."* Replace the loop with the two-line helper invocation.

**12. (P2) [Architect carry-forward] `agents/docs/reputation-algorithm.md` lines 218-219, 296, 374, 407 contradict the new code.** Doc still describes unprefixed Redis keys (`reputation:batch:{username}`), numeric-string values, and CTE name `active_accounts`. Architect-owned; will land in the architect commit at archive. Implementer: do not touch this file.

**13. (P2) [Architect carry-forward] `agents/docs/ARCHITECTURE.md` lines 466-468 describe pre-task state.** Says *"Scores stored in Redis (`reputation:batch:{username}`). On-demand queries read voter weights from the latest batch."* and *"Keys are not namespaced by APP_TAG"* — both wrong post-task and the second is the load-bearing invariant of this work. Architect-owned. Implementer: do not touch.

**14. (P2) `clearStagingKeys()` crash-recovery path has no test.** `backend/src/reputation-batch.ts:73-79`. The new helper plus its `await clearStagingKeys(redis)` at the start of `runBatchComputation` IS the crash-recovery contract for the atomic Lua swap. Add a test that pre-seeds `${appTag}:reputation:batch:staging:foo` directly, runs the next batch, and asserts the staging key was DEL'd.

**15. (P2) Atomic Lua RENAME swap has no direct test.** `backend/src/reputation-batch.ts:51-59` (`CYCLE_SWAP_LUA`). The script is the load-bearing atomicity primitive. No test seeds staging keys, invokes `redis.eval` directly, and asserts (a) staging keys gone, (b) prod keys present with correct values, (c) `cycle:last` bumped. Add the direct test.

**16. (P2) `backfillAccreditationSeeds()` boot path has no test.** `backend/src/reputation.ts:142-161`. Acceptance criterion in this task explicitly cites: *"Redis flush recovery: delete every reputation key, restart, confirm /api/profile/:username shows accreditation_bonus immediately (from boot backfill)."* Zero tests invoke this function. Add coverage for the redis-null branch, accredited-empty branch, and the normal pipeline-SET-NX path. Use `vi.resetModules()` + dynamic-import per the `vitest-fake-timers-module-private-state-isolation-2026-04-29.md` convention.

**17. (P2) Crash mid-Lua leaves prod keys mixed-cycle with no detection.** TCP-reset or Redis-side crash mid-script splits the work. Persisted RENAMEs survive; `cycle:last` may or may not have advanced. On restart, `clearStagingKeys` finds nothing (RENAME consumed them); `prev_scores` rehydration reads inconsistent state with no operator signal. Fix: write `${appTag}:reputation:batch:in_progress:${cycle}` before staging; DEL inside the Lua after `cycle:last` is set. On startup, presence of an `in_progress` sentinel means the prior run crashed mid-swap; either auto-flush-and-recompute or surface a loud operator alert.

**18. (P2) `parseBatchValue` malformed-shape branches not exercised.** `backend/src/reputation.ts:34-54`. Three failure branches: null/undefined, JSON.parse throws, parsed lacks numeric `score`. Branches (b) and (c) are critical for the deploy-flush-skipped state per #6. Add a test seeding `redis.set(batchKey('legacy'), '42')` and asserting `getReputationScore` returns `ZERO_SCORE`.

**19. (P2) `getBatchReputationMap` staging-key filter has no regression test.** `backend/src/reputation.ts:566-569`. The new `prodKeys = allKeys.filter((k) => !k.startsWith(stagingPrefix))` is the safety net preventing readers from observing in-flight staging values. Add a test seeding both a prod key AND a staging key for the same user, assert the map contains only the prod value.

**20. (P2) Stats route "no positive score" branch is unverified.** `backend/src/routes/stats.ts:1126-1138`. Parity test seeds only positive scores; a regression flipping `>` to `>=` or initializing `highest_reputation_score` to `-1` would still pass. Add a test where the only seeded user has score 0 (or all-zero map) and assert `highest_reputation_user` is null.

**21. (P2) Paper-list `author_reputation` parity not verified despite explicit acceptance criterion.** Acceptance criteria states: *"Every reputation value displayed in the UI (...paper-list author badges, review detail reviewer_reputation) is derived from the same `${appTag}:reputation:batch:${user}` value."* Parity test covers stats↔profile only. Add a third arm: seed a user, hit `/api/papers`, assert `row.author_reputation` equals the seeded score.

#### P3 — polish

**22. (P3) Idempotency canary silently no-ops in HAF-empty environments.** `backend/tests/routes/reputation-lifecycle.test.ts:1440-1462`. Bails on `!isHafAvailable() || accredited.size === 0 || genesis === 0` early returns. CI without HAF passes vacuously. Either fixture-seeded fallback or `it.skip` so the absence is visible in test output.

**23. (P3) Idempotency canary depends on PG row order.** `backend/src/reputation.ts:762-769` final SELECT lacks `ORDER BY`. `Map` insertion order = PG row order = non-deterministic. `JSON.stringify(Object.fromEntries(map))` byte-equality could flake. Either add `ORDER BY username` to the final SELECT or sort entries before serialization in the test.

**24. (P3) Magic-string staging-key prefix encoded three times.** `${BATCH_KEY_PREFIX}staging:` in `reputation.ts:174` (local), `REDIS_KEY_STAGING_PREFIX` in `reputation-batch.ts:37`, Lua literals `:batch:staging:` / `:batch:` in `reputation-batch.ts:54`. Derive `REDIS_KEY_STAGING_PREFIX` from `BATCH_KEY_PREFIX`; pass both prefixes as ARGV to the Lua so it does substring math against the same values the TS layer constructs.

**25. (P3) `redis.keys()` is O(N) blocking; called in 3 places.** `getBatchReputationMap` (reputation.ts:175), `clearStagingKeys` (reputation.ts:??), `runBatchComputation` prev-scores (reputation-batch.ts:147). Acceptable at projected scale (1k users). Revisit at 10k. No fix needed now — just flag for a future scale-aware refactor task.

**26. (P3) `cycle_blocks = 0` triggers infinite loop bounded by 30min time cap.** `backend/src/reputation-batch.ts:110-123`. `Math.floor((head - genesis) / 0) = Infinity`, the for-loop iterates forever bounded only by the time cap. Add a `cycle_blocks > 0` validation either in the weights merge (reputation.ts:253) or at the top of `runBatchComputation`. Pre-existing pattern but worth hardening alongside the new Lua infrastructure.

**27. (P3) `isPermanentSeedError` discriminates against unreachable error classes.** `backend/src/reputation.ts:78-92`. SyntaxError/RangeError can't fire from the seed try-block today (no JSON.parse on input, no array allocation). Tests synthesize them via mocks but no production path produces them. Either remove the anticipatory branches or update the docstring to plainly say "currently only TypeError is reachable; SyntaxError/RangeError are pre-wired anticipatorily."

**28. (P3) Boot backfill missing "starting" timestamp log.** `backend/src/reputation.ts:142-161`. Add a `logger.info({ count: accredited.size }, 'Accreditation seed backfill starting')` before the pipeline so the duration is visible in operator logs. Pairs with the existing completion log.

**29. (P3) `invalidateOnRevocation` cascadeRevocation call is untested.** `backend/src/wot.ts:1204` — wiring coverage. The lifecycle test exercises `invalidateOnRevocation` directly but no test verifies the wot.ts call site actually invokes it under cascade conditions. Add a test that drives `cascadeRevocation` and asserts the helper fires for each vouchee.

### Items dismissed during architect triage

- **Lua gsub admin-controlled-account desync** (security, conf 60) — Hive accounts cannot contain colons; the chain is the implicit validator. Filed as residual risk only; no action this round.
- **`parsed: any` vs `unknown` in `parseBatchValue`** (kieran-typescript residual, conf 70) — hand-rolled type guards work. Consistent with codebase house style. Skip unless Kieran-strict mode is adopted globally.
- **`/api/profile/:username` exposes `breakdown.accreditation`** (security residual) — not a leak; `is_accredited` already public alongside.
- **Boot backfill DoS amplification** (security residual) — single-pipeline write at 1k users, not amplification-prone.

### Carry-forwards for architect at archive

The two architect-owned doc updates (#12 `reputation-algorithm.md`, #13 `ARCHITECTURE.md`) land in the architect commit when this task archives, NOT in this round's implementer commits. Implementer: do not edit those files. Architect: pick them up at re-review intake.

### Re-review signal

When items 1, 2-10, 11, 14-21, 22-29 land (items 12-13 are architect-owned; defer), `git mv` this file from `tasks/pending/` back to `tasks/review/`. Use **bare `backend:` or `backend(<scope>):`** commit prefixes so the zone-audit hook fires (item #1). The architect's next review pass scopes `/ce-code-review` to commits since `a370ee2` (the most recent reviewed-and-held SHA) and either archives on clean or appends a new hold block.

**Anchor:** items 2-7 formed one architectural decision cluster — the ownership question of "who is the SSoT, the chain or the batch map." Settled 2026-05-05 in favor of chain-as-SSoT with symmetric reader gating; see "Direction-of-truth" section above the P0 block. Items can fan out in parallel commits.
