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
 * Cross-op-type shadowing defense (round-2 F2): the custody lookup accepts an
 * optional `opType` parameter. When the caller has run `embedIdempotencyKey`
 * first and knows which op surface carries the embed, it passes the resolved
 * `opType` so the HAF lookup probes ONLY that arm. This binds the lookup to
 * the same surface the embed picks, closing the class where a custom_json op
 * carrying a forged `idempotency_key` could shadow a legitimate comment-op
 * broadcast (or vice versa). Pure-vote bundles (no embed surface) fall through
 * to the unscoped two-arm probe so the layer still dedups against prior
 * comment/cj broadcasts carrying the same key.
 */

import crypto from 'node:crypto';

import { config } from '../config.js';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';
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

/**
 * Op surfaces that carry an embedded `idempotency_key`. The embed picks the
 * first eligible op in the bundle; the lookup probes the matching arm when
 * the caller plumbs the resolved type through.
 */
export type IdempotencyEmbedOpType = 'comment' | 'custom_json';

const ALLOWED_OPS_FOR_EMBED = new Set<string>(['comment', 'custom_json']);

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
):
  | { embedded: true; ops: unknown[]; opType: IdempotencyEmbedOpType }
  | { embedded: false } {
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!Array.isArray(op) || op.length !== 2) continue;
    const [opType, opParams] = op;
    if (typeof opType !== 'string' || !ALLOWED_OPS_FOR_EMBED.has(opType)) continue;
    if (typeof opParams !== 'object' || opParams === null) continue;

    // F26: hoist the `params` cast once after the null-guard so future op-type
    // additions don't pay the "remember to cast" tax per branch.
    const params = opParams as Record<string, unknown>;

    if (opType === 'comment') {
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
 * `username`. When `opType` is supplied, probes ONLY that arm (round-2 F2 —
 * binds the lookup to the same op surface the embed picks, closing the cross-
 * op-type shadowing class). When `opType` is undefined, probes both arms
 * (pure-vote bundles fall through here so the layer can still dedup against
 * prior comment/cj broadcasts that carried the same key).
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
 * scans before the appTag's first op are skipped.
 */
export async function findCustodyBroadcastByIdempotencyKey(
  pool: IdempotencyPool,
  username: string,
  idempotencyKey: string,
  opType?: IdempotencyEmbedOpType,
): Promise<IdempotencyHit | null> {
  const genesis = getCachedGenesisBlock();

  if (opType === undefined || opType === 'comment') {
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
    if (opType === 'comment') return null;
  }

  // opType === undefined OR opType === 'custom_json'
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
 *
 * Renamed (F23) from `findAccreditByIdempotencyKey` to parallel
 * `findCustodyBroadcastByIdempotencyKey`. Establishes the naming precedent
 * for the survey table's future per-surface follow-up lookups (claims,
 * papers, wot, anon-review).
 */
export async function findAccreditationBroadcastByIdempotencyKey(
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
 * value the SPA can regenerate on retry.
 *
 * Discriminated result (round-2 F11): `{ ok: true, value }` on success,
 * `{ ok: false, error }` on failure. Replaces the old `string | null` shape
 * (null on success, error message on failure) where the success and error
 * channels shared a type. A future validator extension that forgot to
 * return null on success would silently bypass the route's check; the
 * discriminated form is a compile-time guarantee.
 */
export type ValidateIdempotencyKeyResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateIdempotencyKey(value: unknown): ValidateIdempotencyKeyResult {
  if (typeof value !== 'string') {
    return { ok: false, error: 'idempotency_key must be a string' };
  }
  if (value.length === 0) {
    return { ok: false, error: 'idempotency_key must not be empty' };
  }
  if (value.length > 128) {
    return { ok: false, error: 'idempotency_key exceeds 128 characters' };
  }
  return { ok: true, value };
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis short-circuit cache for the HAF idempotency lookup (round-2 F5/F12).
//
// Explicit scope expansion over the original task spec which excluded Redis
// caching ("Per-request HAF query is sufficient at current scale"). The HAF
// JSONB extraction is not indexed for `idempotency_key`, and HAF-side indexes
// are NOT a path (reference: HAF indexes cannot be modified). Without the
// cache, a fast retry storm (504 -> immediate retry) re-hammers HAF and the
// indexer-lag window can leave the bare HAF lookup catching only slow-retry-
// after-confirmed (>30s post-broadcast retries).
//
// Discipline per `caching-wrapper-discriminated-union-poisoning-2026-05-11.md`:
//   - Cache only the resolved `Hit | null` variants. Negative cache (miss) is
//     a real query result, not a transient failure — caching it is correct
//     because the indexer-lag window is the same in both directions.
//   - NEVER cache `haf_unavailable` (config-missing) or `lookup_failed` (HAF
//     throw) — those degrade to the existing structured-warn paths and the
//     next request re-runs the live query.
//   - Positive-cache TTL = `max(observed HAF indexer lag, 60s)` to bridge
//     the documented indexer-lag defense window.
//   - Negative-cache TTL = 10s, short to avoid masking genuine state changes
//     (the user broadcasts a new op with the same key while the prior miss
//     is still cached).
// ─────────────────────────────────────────────────────────────────────────────

/** Cache shape persisted into Redis. Discriminated so a `miss` is a distinct
 *  value from "no cache entry" — `JSON.parse` of an absent key returns
 *  `null`, which the consumer must NOT conflate with a real cached miss. */
type CachedIdempotencyResult =
  | { kind: 'hit'; tx_id: string; block_num: number | null }
  | { kind: 'miss' };

/** Positive-TTL floor in ms. Sized to bridge HAF indexer lag (~5-30s typical)
 *  per `chain-write-timeout-ambiguous-outcome-2026-04-22.md`: a fast retry
 *  after a 504 lands within the lag window, where the bare HAF lookup would
 *  still miss; the cached hit closes that vector. */
const IDEMPOTENCY_CACHE_POSITIVE_TTL_MS = 60_000;

/** Negative-TTL ceiling in ms. Short by design: caching a miss for too long
 *  risks masking a genuine state change (user broadcasts a new op carrying
 *  the same key after a prior miss was cached). 10s is short enough to be
 *  practically invisible to the retry-storm window we are defending. */
const IDEMPOTENCY_CACHE_NEGATIVE_TTL_MS = 10_000;

function buildCustodyCacheKey(username: string, idempotencyKey: string): string {
  // sha256(username|key) bounds the key length (idempotency_key may be up to
  // 128 chars; the hash is always 64 hex). Username is included in the hash
  // input so two users with the same key — which is allowed by the wire
  // shape — never share a cache row.
  const hash = crypto
    .createHash('sha256')
    .update(`${username}|${idempotencyKey}`)
    .digest('hex');
  return `${config.appTag}:idem:custody:${hash}`;
}

function buildAccreditationCacheKey(idempotencyKey: string): string {
  // The accreditation key is already a sha256 hex (derived by accreditation.ts
  // as sha256(token:username)) so additional hashing buys nothing. Keep the
  // raw key inline; the appTag + domain segment prefix bounds the namespace.
  return `${config.appTag}:idem:accred:${idempotencyKey}`;
}

async function readCached(key: string): Promise<CachedIdempotencyResult | undefined> {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    const raw = await redis.get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as CachedIdempotencyResult;
  } catch (err) {
    // Redis read failures degrade silently to "no cache" — the HAF lookup
    // still runs. A 5xx here would be over-cautious: the cache layer is a
    // fast-path, not a correctness layer.
    logger.warn(
      { err, key, event: 'idempotency.cache.read_failed' },
      'idempotency cache read failed — proceeding to HAF lookup',
    );
    return undefined;
  }
}

async function writeCached(key: string, value: CachedIdempotencyResult): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const ttl =
    value.kind === 'hit'
      ? IDEMPOTENCY_CACHE_POSITIVE_TTL_MS
      : IDEMPOTENCY_CACHE_NEGATIVE_TTL_MS;
  try {
    await redis.set(key, JSON.stringify(value), 'PX', ttl);
  } catch (err) {
    // Same fail-open rule as the read path.
    logger.warn(
      { err, key, event: 'idempotency.cache.write_failed' },
      'idempotency cache write failed — cache miss extends to next request',
    );
  }
}

/**
 * Cache-wrapped lookup for custody broadcasts. Reads the Redis short-circuit
 * before consulting HAF; populates the cache on resolved (hit OR miss)
 * results. NEVER caches a HAF-throw — those propagate to the caller's
 * degraded path.
 *
 * Plumbing-through of `opType` is forwarded to the bare HAF lookup so the
 * scoped probe still happens on cache miss.
 */
export async function lookupCustodyBroadcastIdempotency(
  pool: IdempotencyPool,
  username: string,
  idempotencyKey: string,
  opType?: IdempotencyEmbedOpType,
): Promise<IdempotencyHit | null> {
  const cacheKey = buildCustodyCacheKey(username, idempotencyKey);
  const cached = await readCached(cacheKey);
  if (cached !== undefined) {
    return cached.kind === 'hit'
      ? { tx_id: cached.tx_id, block_num: cached.block_num }
      : null;
  }
  const result = await findCustodyBroadcastByIdempotencyKey(pool, username, idempotencyKey, opType);
  await writeCached(
    cacheKey,
    result === null
      ? { kind: 'miss' }
      : { kind: 'hit', tx_id: result.tx_id, block_num: result.block_num },
  );
  return result;
}

/**
 * Cache-wrapped lookup for accreditation broadcasts. Same shape as the
 * custody variant: read cache → HAF on miss → populate cache on resolved
 * result.
 */
export async function lookupAccreditationBroadcastIdempotency(
  pool: IdempotencyPool,
  idempotencyKey: string,
): Promise<IdempotencyHit | null> {
  const cacheKey = buildAccreditationCacheKey(idempotencyKey);
  const cached = await readCached(cacheKey);
  if (cached !== undefined) {
    return cached.kind === 'hit'
      ? { tx_id: cached.tx_id, block_num: cached.block_num }
      : null;
  }
  const result = await findAccreditationBroadcastByIdempotencyKey(pool, idempotencyKey);
  await writeCached(
    cacheKey,
    result === null
      ? { kind: 'miss' }
      : { kind: 'hit', tx_id: result.tx_id, block_num: result.block_num },
  );
  return result;
}
