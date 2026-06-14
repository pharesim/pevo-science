# Investigate WoT threshold query statement-timeout (cache silently falls back to default)

**Owner:** backend
**Created:** 2026-06-14

## Observed

In the production (toolshed) backend journal on 2026-06-14, at startup:

```
{"level":40,...,"err":{"type":"DatabaseError","message":"canceling statement due to statement timeout",...}}
{"level":30,...,"msg":"WoT threshold cache loaded"}
```

A `level:40` (warn) `DatabaseError: canceling statement due to statement timeout`
fires immediately before "WoT threshold cache loaded" (same millisecond). This
surfaced now because backend logs newly persist to the host journal; the
behavior itself is not new.

## What it is

`loadWotThreshold()` in `backend/src/wot.ts` queries the custom-json view
(`T.customJson` / `operation_custom_json_view`) under `SET LOCAL
statement_timeout = 5000` to find the latest on-chain `update_params`
`custom_json` and read `params.min_accreditations_for_wot`. The query scans the
view filtering `json::jsonb ->> 'action' = 'update_params'`, i.e. a per-row
text->jsonb cast over a very large table. On any error (including the 5s
statement timeout) the `catch` logs `WoT threshold query failed, using default`
and returns `DEFAULT_WOT_THRESHOLD` (3). `getWotThreshold()` memoizes via
`hafCache.getOrSet('wot_threshold', …)`; `startWotThresholdCache()` registers a
periodic refresh and logs the "loaded" line regardless of outcome.

So the timeout is **handled** — but the consequence is that the live WoT
threshold silently uses the default (3) instead of the on-chain configured
value whenever the query times out.

## Why it matters

The WoT threshold gates auto-accreditation (a vouch count). If the platform has
set `min_accreditations_for_wot` on-chain to something other than 3, a timeout
means accounts auto-accredit at the wrong (default) threshold — a correctness
issue, not just log noise. If the configured value IS the default, the impact is
startup log noise plus a slow query only. The investigation must establish which.

## Investigate

1. **Is there real behavioral impact?** Determine whether an on-chain
   `update_params` with `min_accreditations_for_wot` exists for `config.appTag` +
   `config.accreditationAuthorities`, and its value. If it differs from the
   default, the timeout is actively serving the wrong threshold.
2. **Startup-cold only, or persistent?** The cache has a TTL + periodic refresh.
   Confirm whether a warm/subsequent `loadWotThreshold` succeeds (so the default
   is used only briefly at boot) or whether the query times out every time. This
   bounds the blast radius.
3. **Root-cause the 5s timeout.** The `json::jsonb ->> 'action'` predicate forces
   a per-row cast scan of the view. HAF indexes are fixed external infrastructure
   and cannot be changed (see `agents/docs/solutions/` / the HAF-index note), so
   coordinating a HAF-side index is NOT a path. Assess PEvO-side mitigations:
   narrow the scan first by the indexed `custom_id` and a bounded `block_num`
   range, avoid the per-row cast, persist a last-known-good threshold across
   restarts so a cold-start timeout doesn't regress to the default, or
   raise/justify the timeout. Pick based on findings 1–2.

## Acceptance criteria

- Root cause documented: timing out at startup only vs. persistently; live
  threshold correct vs. silently degraded to the default.
- If the configured threshold differs from the default AND the query times out in
  steady state, deliver a fix so the live threshold reflects the on-chain value.
- If impact is bounded (configured == default, or warm refresh recovers quickly),
  document that and decide whether any change is warranted. Do not add log volume
  without cause (PEvO runs logging-minimal); a quieter or smarter startup signal
  is acceptable, broad new logging is not.

## Zone note

Backend: `backend/src/wot.ts` (`loadWotThreshold`, `getWotThreshold`,
`startWotThresholdCache`) and possibly shared query/timeout patterns in
`backend/src/db.ts` / `reputation.ts`. Architect-filed from a production log
observation; no architecture or API-shape change is implied.

## Findings & Resolution (backend, 2026-06-14)

Investigated empirically against the live HAF (Mahdi's `haf_block_log`) with
the exact production query, `config.appTag = pevotest`,
`config.accreditationAuthorities = [pevotest.admin]`.

**1. Behavioral impact today: NONE (correct-by-coincidence).** The exact
production query, given a generous 120s cap, returns **0 rows** — there is no
on-chain `update_params` op for `pevotest` signed by `pevotest.admin`, so
`min_accreditations_for_wot` has never been set. The live threshold *should* be
the default (3), which is exactly what the timeout fallback returns. So today
the timeout and the correct answer coincide: this is a **latent** correctness
bug (it would serve the wrong threshold the moment an operator broadcasts an
`update_params` override, since the query times out before finding it) plus a
**present** ~18s query and recurring log noise.

**2. Cadence: persistent, not startup-cold.** The query takes ~11-18s every run
(measured cold and on a re-run). The cache has a 30-min TTL + periodic refresh,
so `loadWotThreshold` re-runs every 30 minutes, times out at the 5s cap each
time, and re-logs `WoT threshold query failed, using default`. Not a one-time
boot blip — recurring every 30 min.

**3. Root cause: NOT the per-row jsonb cast.** `EXPLAIN (ANALYZE, BUFFERS)`
shows the `custom_id = 'pevotest'` predicate already hits a good index
(`hafsql_id_opid_idx`), narrowing to ~15 rows in ~12ms. The killer is
`ORDER BY block_num DESC LIMIT 1`: because `block_num` is a *function*
(`hafd.operation_id_to_block_num(o.id)`), not a stored column, the planner
satisfies the DESC+LIMIT by walking the **107M-row `blocks` index backward** in
a nested loop, probing each block against the near-empty `update_params` set.
With zero matches it must scan all 107M blocks to confirm none — an 8.6s
index-only scan inside an 18s query. This is the empty-match worst case; it is
specific to a *sparse-match* `ORDER BY block_num DESC LIMIT n` over the
custom_json view without a materialization fence.

**Fix (delivered):** Wrap the row match in a `WITH candidates AS MATERIALIZED
(...)` CTE so the planner resolves the small `custom_id`-indexed candidate set
first, then sorts/limits the tiny result. Verified against live HAF: ~15ms
execution (vs ~18s), with the blocks index scan reported `(never executed)`.
Match-independent — robust even once an override is broadcast. Semantics
unchanged (precise `action = 'update_params'` check, latest-op-wins via
`ORDER BY block_num DESC LIMIT 1` over the materialized set, same
`required_posting_auths ?|` signer gate, same positive-integer validation). No
`block_num >=` floor added (that would flip the planner to a BitmapAnd — see the
`no-custom-id-block-num-floor` lint rule). **No new logging** (PEvO
logging-minimal): the existing warn now fires only on genuine HAF degradation
rather than every refresh. No `db.ts`/`reputation.ts` change needed — the fix is
local to the one query. No last-known-good persistence or raised timeout needed;
the rewrite makes the query fast and reliable, so the 5s cap is now a comfortable
defensive margin.

**Tests:** existing `wot-threshold-signer-gate.test.ts` signer-gate + value
derivation stay green under the rewrite; added a `planner-fence canary` asserting
the SQL carries `AS MATERIALIZED`, so a future "simplification" back to the bare
`ORDER BY ... LIMIT 1` fails red here instead of silently regressing the live
threshold (real HAF cannot cheaply demonstrate the 18s-vs-15ms gap
deterministically in CI, hence the SQL-shape canary, matching this file's
existing signer-gate canary pattern).

**Possible follow-up (architect triage, NOT actioned here — out of scope):** a
handful of other `ORDER BY block_num DESC` reads over `operation_custom_json_view`
exist (`lib/idempotency.ts`, `routes/profile.ts`, `reputation.ts`). Most are
either account-filtered (selective, usually non-empty, so the backward-scan
finds its row quickly) or window-function shapes (`ROW_NUMBER() OVER (... ORDER
BY block_num DESC)`, computed after the set is gathered) and are not obviously
exposed to the empty-match worst case. Only the wot.ts case was verified
empirically. If a broader audit is wanted, the same `AS MATERIALIZED` fence is
the remediation; filing that as its own task is the architect's call.

## Architect re-review (2026-06-14) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `ca18ee81` (correctness, security, performance,
reliability, project-standards, testing, maintainability, adversarial,
learnings). The perf fix is sound and verified clean: the `required_posting_auths`
signer gate is preserved inside the materialized CTE (forged ops filtered before
the sort), the rewrite is result-set-equivalent, and the new query is lint-clean
(it correctly omits the `block_num >=` floor — the `no-custom-id-block-num-floor`
rule names this exact `loadWotThreshold` shape as the allowed one). Archive is
held on one substantive item:

1. **Add the missing same-block tie-breaker (Rule 2).** The `candidates` CTE
   currently projects only `json, block_num` and the outer query sorts on
   `ORDER BY block_num DESC LIMIT 1` alone. That implements "latest `update_params`
   op wins," which is exactly the semantic governed by Rule 2 in
   `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md`:
   latest-op-wins reads over `operation_custom_json_view` MUST order by
   `(block_num, id)`, not `block_num` alone, because the deployed HAF views omit
   `trx_in_block` and `id` is the global op-id tiebreaker. Every sibling
   latest-op read already complies (`routes/accreditations.ts`, `routes/papers.ts`,
   `reputation.ts` all carry `block_num DESC, id DESC`); `loadWotThreshold` is the
   lone divergence, and this fix rewrote that exact `ORDER BY` while choosing a CTE
   that structurally precludes the tiebreaker. The practical blast radius is small
   (two authority-signed `update_params` ops in one 3s block), so this is low
   severity — but it is a documented-convention divergence on the precise line the
   fix touched, and leaving it makes the resolution's "latest-op-wins" claim
   overstated.

   Fix: project `id` in the `candidates` CTE and add `, id DESC` as the secondary
   outer sort key (`ORDER BY block_num DESC, id DESC LIMIT 1`). Adding `id` to the
   CTE projection does NOT weaken the `AS MATERIALIZED` fence — there is no
   `ORDER BY`/`LIMIT` inside the CTE, so the inner plan is unchanged. Anchor any
   new inline comment on "Rule 2" by name (the convention doc), not a line number
   or SHA, per the comment-anchor conventions.

2. **Extend the planner-fence canary to also pin the tiebreaker.** The added
   canary asserts the SQL carries `AS MATERIALIZED`; extend the same captured-SQL
   assertion to require the outer `ORDER BY` carries the `id` secondary key (e.g.
   match `block_num DESC, id DESC`), so a future edit that drops the tiebreaker
   fails red here the same way a dropped fence would. This mirrors the file's
   existing SQL-shape canary pattern and stays within the documented carve-out.

3. **(Cosmetic, optional — do while you're here.)** The inline comment naming the
   `no-custom-id-block-num-floor` lint rule omits the canonical `pevo/` ESLint
   prefix used everywhere else. If you touch that comment, prefer
   `pevo/no-custom-id-block-num-floor`. Not blocking on its own.

The duplicated-rationale comment between `wot.ts` and the test canary is
**dismissed** — the two comments serve distinct audiences (implementation
rationale vs regression-guard rationale) and the overlap is acceptable.

When fixed, `git mv` this file back to `tasks/review/`; the move is the
re-review signal. The re-review will scope `/ce-code-review` to the commits since
this hold block. Do NOT edit this hold block — the commit diff is the evidence.
