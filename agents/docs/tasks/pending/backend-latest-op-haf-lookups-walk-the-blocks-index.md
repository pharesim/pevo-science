# Three latest-op HAF lookups walk the whole blocks index when nothing matches

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit. The learnings pass flagged the query shape;
the architect then measured it on the HAF node with the user's permission.

## Why

Measured on the HAF node on 2026-10-05 with `EXPLAIN (ANALYZE, BUFFERS)`, appTag `pevotest`: the
query in `findExistingAccreditation` (`backend/src/lib/idempotency.ts`) took 19.75 s for an
account with no accredit or revoke op. The plan drives a nested loop from
`Index Only Scan Backward using pk_hive_blocks` (110,520,295 rows read) and probes the
`custom_id` candidate set, which is empty, once per block. The candidate scan itself took 0.2 ms.
With the candidates in an `AS MATERIALIZED` CTE and the `ORDER BY ... LIMIT 1` outside it, the
same lookup took 2.4 ms.

A plan-only `EXPLAIN` shows the same backward scan of `pk_hive_blocks` for
`findAccreditationBroadcastByIdempotencyKey` (same file) and `getLatestAccreditOp`
(`backend/src/accreditation.ts`). Those two were not executed.

What it costs today:

- `POST /api/accreditation/verify`. A first-time verifier has no accredit or revoke op, and a
  fresh token's idempotency key matches nothing. The route awaits `findExistingAccreditation` and
  then `lookupAccreditationBroadcastIdempotency`, which calls
  `findAccreditationBroadcastByIdempotencyKey` unless a cached hit exists, before it broadcasts.
  The SPA aborts a request after 30 s (`DEFAULT_TIMEOUT_MS` in `frontend/src/api.js`) while the
  handler keeps running, so the page can show a timeout for an accreditation that then lands. The
  HAF pool's `statement_timeout` is also 30 s (`getPool` in `backend/src/db.ts`); a gate lookup
  that runs past it answers 503 `ACCREDITATION_GATE_UNAVAILABLE`.
- `PATCH /api/accreditation/metadata`. `getLatestAccreditOp` is its first HAF read. A caller with
  no accredit op takes the no-match path.
- Each such query holds one of the HAF pool's three connections while it runs.

The fix pattern is the one `loadWotThreshold` (`backend/src/wot.ts`) and `aa_params_latest`
(`backend/src/hafsql.ts`) already use. It is written up in
`agents/docs/solutions/conventions/haf-custom-json-latest-op-materialized-fence-2026-06-14.md`.

## Scope

1. In each of the three lookups, put the row match in an `AS MATERIALIZED` CTE that carries no
   `ORDER BY` and no `LIMIT`, and order and limit outside it. Keep every predicate (`custom_id`,
   the action filter, the subject field, `required_posting_auths ?|`) inside the CTE. Keep the
   `(block_num, id)` descending order. Do not add a `block_num >=` floor.

   The form that was measured for the gate (no-match input only):

   ```sql
   WITH candidates AS MATERIALIZED (
     SELECT cj.id, cj.block_num, cj.json::jsonb ->> 'action' AS action
     FROM hafsql.operation_custom_json_view cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $2
       AND cj.required_posting_auths ?| $3::text[]
   )
   SELECT op.included_trx_id AS trx_id, c.block_num, c.action
   FROM candidates c
   JOIN hafsql.haf_operations op ON op.id = c.id
   ORDER BY c.block_num DESC, c.id DESC
   LIMIT 1
   ```

2. `hafsql.ts` keeps `AS MATERIALIZED` inline in its SQL literals for the
   `pevo/no-custom-id-block-num-floor` lint canary (see the comment on `aa_vouch_ranked`). Check
   whether that rule reads these two files before you move the CTE into a shared fragment.
3. Re-measure each of the three after the change, for a no-match input and for a matching one, and
   put the numbers in the signal block. If you cannot run `EXPLAIN` against the HAF node, say so
   there and the architect measures at review.

## Out of scope

- The gate's semantics. `backend-verify-gate-treats-wot-enrollee-as-accredited` changes which
  rows count as a hit and lands after this task, because both edit the same query.
- Other reads with the same `ORDER BY block_num DESC ... LIMIT 1` shape over
  `operation_custom_json_view`. None of these was plan-checked, and none is to be changed here:
  the custom_json arm of `findCustodyBroadcastByIdempotencyKey` (`lib/idempotency.ts`), the two
  reads near the end of `lib/orcid-binding.ts`, one in `routes/orcid.ts`, and the
  `update_weights` read in `reputation.ts`, which runs under a 5 s `SET LOCAL statement_timeout`.
  The architect plan-checks them separately.

## Acceptance criteria

1. The three lookups return what they returned before, for matching and non-matching inputs. Name
   the specs that cover each in the signal block.
2. The signal block carries the measured timings, or says they could not be taken.
3. A comment that states a timing cites only a number this task or its implementer measured, and
   says for which input. Comments follow root `CLAUDE.md` "Comment anchors".
