/**
 * Per-broadcast idempotency layer for custody + accreditation surfaces.
 *
 * Closes the retry-amplification class documented in
 * `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`
 * Option A.4: dhive constructs a fresh transaction per broadcast call (new
 * expiry), so a /broadcast retry after a 504 timeout does NOT collide at the
 * Hive dedup layer. Without an application-level idempotency check, a network
 * hiccup -> 504 -> blind SPA retry -> both broadcasts land -> silent duplicate.
 *
 * The check is two-step: BEFORE the broadcast, query HAF for an existing op
 * carrying the same `idempotency_key` (scoped per actor). If found, return the
 * existing tx_id with `outcome: 'already_landed'` and skip the broadcast. AFTER
 * the broadcast, the key is already embedded in the op payload (callers embed
 * before signing), so a future retry's HAF lookup will resolve.
 *
 * Per-route, per-op-type shape:
 *   - Custody /broadcast bundles MAY contain `comment` (`json_metadata.<appTag>.idempotency_key`),
 *     `custom_json` (`json.idempotency_key`), or `vote` ops. Vote-only bundles
 *     have no embed surface; the helper embeds in the first comment or
 *     custom_json op encountered and the HAF lookup probes those two op
 *     surfaces. Pure-vote bundles fall through with no idempotency layer
 *     (vote re-cast is low-harm — duplicate VP cost only, no permanent state
 *     change beyond what the chain already records).
 *   - Accreditation /verify always emits a single `accredit` custom_json op;
 *     the helper looks up `accredit` ops by `idempotency_key` filtered by
 *     `accreditationAuthorities` (so a self-broadcast custom_json carrying
 *     a forged key cannot poison the dedup check).
 *
 * Per-request HAF query is sufficient at current scale; cross-route Redis
 * caching is explicitly out of scope per the task spec.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { T, getCachedGenesisBlock } from '../hafsql.js';

/** Minimal pool shape — matches `pg.Pool.query` signature. Keeps this module
 *  unit-testable without pulling the full pg typing into the helper. */
export interface IdempotencyPool {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Result of a successful HAF idempotency hit. `tx_id` is the chain transaction
 *  id of the prior broadcast; callers return it in the 200 envelope with
 *  `outcome: 'already_landed'`. `block_num` is best-effort — HAF rows always
 *  carry it but it surfaces only on the custody response shape (mirrors the
 *  fresh-broadcast `{ tx_id, block_num }` envelope so the SPA's success
 *  handler does not need to branch on the outcome flag). */
export interface IdempotencyHit {
  tx_id: string;
  block_num: number | null;
}

const ALLOWED_OPS_FOR_EMBED = new Set(['comment', 'custom_json']);

/**
 * Embed `idempotency_key` into the first op in `operations` that supports it
 * (`comment` -> `json_metadata.<appTag>.idempotency_key`; `custom_json` ->
 * `json.idempotency_key`). Returns a fresh array; the input is not mutated.
 *
 * Returns `{ embedded: false }` for pure-vote bundles (no embed surface). The
 * caller decides whether to log a structured warn / proceed without the
 * idempotency layer / reject the request — this helper is shape-only.
 *
 * The first-op-wins rule is correct because Hive transactions are atomic: if
 * the embedded op landed, the entire bundle landed. The HAF lookup probes the
 * same op type the embed picked, so the round-trip is consistent without
 * requiring multi-op-type lookup.
 */
export function embedIdempotencyKey(
  operations: unknown[],
  idempotencyKey: string,
): { embedded: true; ops: unknown[]; opType: 'comment' | 'custom_json' } | { embedded: false } {
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!Array.isArray(op) || op.length !== 2) continue;
    const [opType, opParams] = op;
    if (typeof opType !== 'string' || !ALLOWED_OPS_FOR_EMBED.has(opType)) continue;
    if (typeof opParams !== 'object' || opParams === null) continue;

    if (opType === 'comment') {
      const params = opParams as Record<string, unknown>;
      const rawMeta = params.json_metadata;
      let meta: Record<string, unknown>;
      try {
        meta =
          typeof rawMeta === 'string'
            ? (JSON.parse(rawMeta) as Record<string, unknown>)
            : ((rawMeta ?? {}) as Record<string, unknown>);
      } catch {
        // Malformed json_metadata — caller's upstream validator would have
        // already rejected, but be defensive: skip this op and try the next.
        continue;
      }
      const ns = (meta[config.appTag] as Record<string, unknown> | undefined) ?? {};
      const nextMeta = {
        ...meta,
        [config.appTag]: { ...ns, idempotency_key: idempotencyKey },
      };
      const nextOps = operations.slice();
      nextOps[i] = [opType, { ...params, json_metadata: JSON.stringify(nextMeta) }];
      return { embedded: true, ops: nextOps, opType: 'comment' };
    }

    // custom_json
    const params = opParams as Record<string, unknown>;
    const rawJson = params.json;
    let payload: Record<string, unknown>;
    try {
      payload =
        typeof rawJson === 'string'
          ? (JSON.parse(rawJson) as Record<string, unknown>)
          : ((rawJson ?? {}) as Record<string, unknown>);
    } catch {
      continue;
    }
    const nextPayload = { ...payload, idempotency_key: idempotencyKey };
    const nextOps = operations.slice();
    nextOps[i] = [opType, { ...params, json: JSON.stringify(nextPayload) }];
    return { embedded: true, ops: nextOps, opType: 'custom_json' };
  }
  return { embedded: false };
}

/**
 * HAF lookup for a prior custody /broadcast carrying `idempotencyKey` for
 * `username`. Probes both `comment` and `custom_json` op surfaces because the
 * embed picks whichever op type comes first in the bundle.
 *
 * The HAF views (`operation_custom_json_view`, `operation_comment_view`) do
 * not carry the Hive transaction id directly — `trx_id` lives on
 * `hafsql.haf_operations.included_trx_id` and is reachable via
 * `haf_operations.id = <op_view>.id`. The schema convention is documented in
 * `agents/docs/hive-schemas.md`; the JOIN cost is negligible at LIMIT 1
 * because both sides have indexes on `id`.
 *
 * Comments use `operation_comment_view` (not `comments`) — the `comments`
 * roll-up view has no surrogate matching `haf_operations.id`, so the
 * straightforward JOIN there returns zero rows. The op-view path is also
 * stable across re-org / cashout-time changes that mutate the rolled-up
 * `comments.created`.
 *
 * Custom_jsons: `custom_id = appTag` AND `required_posting_auths ?| [username]`
 * AND `json::jsonb ->> 'idempotency_key' = key`.
 *
 * Genesis-block floor matches the rest of the HAF queries in the codebase —
 * scans before the appTag's first op are skipped. The query is two-statement
 * to keep each plan simple; an OR'd UNION across two views is harder for the
 * planner and the comment surface is the more common case (consent ops are a
 * minority of custody traffic).
 */
export async function findCustodyBroadcastByIdempotencyKey(
  pool: IdempotencyPool,
  username: string,
  idempotencyKey: string,
): Promise<IdempotencyHit | null> {
  const genesis = getCachedGenesisBlock();

  const commentHit = await pool.query<{ trx_id: string; block_num: number | null }>(
    `SELECT op.included_trx_id AS trx_id, ocv.block_num
     FROM ${T.commentOps} ocv
     JOIN hafsql.haf_operations op ON op.id = ocv.id
     WHERE ocv.author = $1
       AND (ocv.json_metadata -> $2 ->> 'idempotency_key') = $3
       AND ocv.block_num >= $4
     ORDER BY ocv.block_num DESC
     LIMIT 1`,
    [username, config.appTag, idempotencyKey, genesis],
  );
  if (commentHit.rows.length > 0) {
    const row = commentHit.rows[0];
    return { tx_id: row.trx_id, block_num: row.block_num };
  }

  const customJsonHit = await pool.query<{ trx_id: string; block_num: number | null }>(
    `SELECT op.included_trx_id AS trx_id, cj.block_num
     FROM ${T.customJson} cj
     JOIN hafsql.haf_operations op ON op.id = cj.id
     WHERE cj.custom_id = $1
       AND cj.required_posting_auths ?| $2::text[]
       AND (cj.json::jsonb ->> 'idempotency_key') = $3
       AND cj.block_num >= $4
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [config.appTag, [username], idempotencyKey, genesis],
  );
  if (customJsonHit.rows.length > 0) {
    const row = customJsonHit.rows[0];
    return { tx_id: row.trx_id, block_num: row.block_num };
  }

  return null;
}

/**
 * HAF lookup for a prior `accredit` custom_json carrying `idempotencyKey`,
 * scoped to `accreditationAuthorities` so a self-broadcast custom_json
 * carrying a forged key cannot poison the check (mirrors the existing
 * `getOrcidAccount` / `getExistingAccreditation` filter in routes/orcid.ts).
 *
 * `trx_id` lives on `haf_operations.included_trx_id`; the JOIN reaches it
 * via the shared op id (see `findCustodyBroadcastByIdempotencyKey` for the
 * schema rationale).
 */
export async function findAccreditByIdempotencyKey(
  pool: IdempotencyPool,
  idempotencyKey: string,
): Promise<IdempotencyHit | null> {
  const result = await pool.query<{ trx_id: string; block_num: number | null }>(
    `SELECT op.included_trx_id AS trx_id, cj.block_num
     FROM ${T.customJson} cj
     JOIN hafsql.haf_operations op ON op.id = cj.id
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'accredit'
       AND (cj.json::jsonb ->> 'idempotency_key') = $2
       AND cj.required_posting_auths ?| $3::text[]
       AND cj.block_num >= $4
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [config.appTag, idempotencyKey, config.accreditationAuthorities, getCachedGenesisBlock()],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { tx_id: row.trx_id, block_num: row.block_num };
}

/**
 * Validation guard for the `idempotency_key` body field. UUIDs are the
 * intended client shape (per task spec), but the helper accepts any
 * non-empty string up to 128 chars to avoid coupling the wire shape to a
 * specific format — the field's job is to be a deterministic-per-attempt
 * value the SPA can regenerate on retry. Returns `null` when valid; an error
 * message string when invalid.
 */
export function validateIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return 'idempotency_key must be a string';
  if (value.length === 0) return 'idempotency_key must not be empty';
  if (value.length > 128) return 'idempotency_key exceeds 128 characters';
  return null;
}

/**
 * Structured-log helper for the "idempotency layer skipped" branches. Callers
 * pass a stable `event:` discriminator and contextual fields; the helper
 * routes through `logger.warn` so dashboards can key on the event without
 * suffix-matching a free-text message.
 */
export function logIdempotencySkip(
  event: string,
  fields: Record<string, unknown>,
  msg: string,
): void {
  logger.warn({ ...fields, event }, msg);
}
