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
