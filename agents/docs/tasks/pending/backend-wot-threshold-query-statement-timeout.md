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
