/**
 * Reputation computation module.
 *
 * All reputation is computed via the canonical SQL query against HAF.
 * Voter weighting, decay, and vote resolution live entirely in SQL.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { getPool } from './db.js';
import { config } from './config.js';
import { getAllAccreditedAccounts } from './accreditation.js';
import { hafCache } from './cache.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights, type ReputationScore } from './types/index.js';
import { T, validPevoPaperWhere, validReviewWhere, excludeSelfReviewWhere, activeAccreditationsCteBody, authorshipClaimsCteBody, consentChainCteBody, consentedAuthorsCteBody, decayMultiplierSql } from './hafsql.js';

// ─── Batch key helpers ──────────────────────────────────────────

/** Redis key namespace for cycle-computed reputation scores. */
export const BATCH_KEY_PREFIX = `${config.appTag}:reputation:batch:`;

/**
 * Sub-namespace under BATCH_KEY_PREFIX where the batch writer stages the next
 * cycle's values before the atomic Lua swap. Exported so the reader filter
 * in `getBatchReputationMap` and the writer paths in `reputation-batch.ts`
 * reference a single source of truth — a future change to the staging
 * segment cannot leave one side referencing the old prefix while the other
 * uses the new one.
 */
export const STAGING_SEGMENT = 'staging:';
export const REDIS_KEY_STAGING_PREFIX = `${BATCH_KEY_PREFIX}${STAGING_SEGMENT}`;

/**
 * Membership index for the cycle-computed prod batch keys. A Redis Set whose
 * members are the full prod key paths currently in production, maintained by
 * the `CYCLE_SWAP` Lua (SADD per renamed prod key, atomically inside the swap).
 * `getBatchReputationMap` enumerates via `SMEMBERS` + `MGET` instead of the
 * blocking `KEYS ${BATCH_KEY_PREFIX}*` keyspace scan — bounding enumeration by
 * the accredited-user count rather than the whole keyspace.
 *
 * Lives OUTSIDE `BATCH_KEY_PREFIX` (note the `_members` suffix, NOT
 * `:batch:members`) for two reasons: (1) a Hive account literally named
 * `members` would otherwise own the prod key `${BATCH_KEY_PREFIX}members`,
 * colliding String-vs-Set on the same key (WRONGTYPE); (2) it keeps the set out
 * of any residual `${BATCH_KEY_PREFIX}*` glob. Same sibling-key discipline as
 * `reputation:cycle:last` / `reputation:lock` / `reputation:in_progress:`.
 */
export const REDIS_KEY_BATCH_MEMBERS = `${config.appTag}:reputation:batch_members`;

export function batchKey(username: string): string {
  return `${BATCH_KEY_PREFIX}${username}`;
}

/**
 * Resolves the batch-members index key. Production always reads
 * REDIS_KEY_BATCH_MEMBERS; tests repoint it via `__test_seams.setBatchMembersKey`
 * so a deterministic empty-index backfill test does not race a sibling file's
 * SADD to the shared members set under the concurrent (maxWorkers) runner.
 */
let batchMembersKeyOverride: string | null = null;
function batchMembersKey(): string {
  return batchMembersKeyOverride ?? REDIS_KEY_BATCH_MEMBERS;
}

/**
 * @internal Test-only seams. Production imports of `__test_seams` are blocked by
 * eslint `no-restricted-imports` (see eslint.config.mjs).
 */
export const __test_seams = {
  /**
   * Repoint the batch-members index at a test-unique key so a deterministic
   * empty-index backfill test does not race a sibling file's SADD to the shared
   * production members set under the concurrent (maxWorkers) runner. Pass null
   * to restore the production key.
   */
  setBatchMembersKey(key: string | null): void {
    batchMembersKeyOverride = key;
  },
} as const;

/**
 * Non-blocking keyspace enumeration via an iterative `SCAN` cursor loop
 * (COUNT 500), replacing the O(N) blocking `KEYS` command that stalls the
 * single-threaded Redis server for the scan's duration. Returns every key
 * matching `pattern`. Used by the batch staging/sentinel cleanup helpers and
 * by `getBatchReputationMap`'s one-time members-set backfill.
 */
export async function scanAllKeys(
  redis: NonNullable<ReturnType<typeof getRedis>>,
  pattern: string,
  count = 500,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/**
 * Parse a Redis batch value into a ReputationScore. Returns null on missing
 * or malformed data so callers can fall through to a zero-score default.
 *
 * Shared between the batch writer (rehydrating prev-scores at the start of a
 * new run) and the readers in `getBatchReputationMap` / `getReputationScore`,
 * so the two sides cannot drift on shape interpretation.
 *
 * Malformed input (JSON.parse throws OR parsed value lacks numeric `score`)
 * surfaces a rate-limited operator warn so a deploy-flush-skipped state
 * (e.g., legacy numeric-string keys persisting after the JSON-shape
 * migration) is visible on the first request, not after user complaint.
 */
const PARSE_WARN_INTERVAL_MS = 60_000;
const parseWarnState: { count: number; lastLogTime: number; lastSampleRaw: string | null; lastError: unknown } = {
  count: 0,
  lastLogTime: 0,
  lastSampleRaw: null,
  lastError: null,
};

function flagMalformedBatchValue(raw: string, err: unknown): void {
  parseWarnState.count += 1;
  parseWarnState.lastSampleRaw = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  parseWarnState.lastError = err;
  const now = Date.now();
  if (now - parseWarnState.lastLogTime < PARSE_WARN_INTERVAL_MS) return;
  logger.warn(
    {
      event: 'reputation.batch.parse_failed',
      count: parseWarnState.count,
      raw_sample: parseWarnState.lastSampleRaw,
      err: parseWarnState.lastError,
    },
    'Reputation batch value malformed; reader returning ZERO_SCORE',
  );
  parseWarnState.lastLogTime = now;
  parseWarnState.count = 0;
}

export function parseBatchValue(raw: string | null | undefined): ReputationScore | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    flagMalformedBatchValue(raw, err);
    return null;
  }
  if (parsed && typeof parsed === 'object' && typeof (parsed as { score?: unknown }).score === 'number') {
    const obj = parsed as { score: number; breakdown?: Record<string, unknown> };
    const b = obj.breakdown ?? {};
    return {
      score: obj.score,
      breakdown: {
        papers: Number(b.papers ?? 0),
        reviews: Number(b.reviews ?? 0),
        citations: Number(b.citations ?? 0),
        accreditation: Number(b.accreditation ?? 0),
      },
    };
  }
  flagMalformedBatchValue(raw, new TypeError('parsed value lacks numeric score'));
  return null;
}

/**
 * Build a provisional ReputationScore representing a freshly-accredited user
 * with no on-chain activity yet (papers/reviews/citations all zero).
 */
function provisionalScore(bonus: number): ReputationScore {
  return {
    score: bonus,
    breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: bonus },
  };
}

// ─── Accreditation lifecycle helpers ────────────────────────────

/**
 * Seed a provisional batch entry for a freshly-accredited user.
 * Uses Redis `SET NX` so a real cycle-computed score is never clobbered;
 * the seed only wins when no entry exists yet.
 *
 * Call after an `accredit` custom_json broadcast is acknowledged so the
 * user's profile shows `accreditation_bonus` immediately, without waiting
 * for the next cycle boundary.
 *
 * Per the cascade-fn permanent-error rethrow convention: re-throws on
 * permanent (operator-actionable) errors so the orcid post-broadcast cascade
 * wrap surfaces 502 POST_BROADCAST_FAILED with `failed_step:'reputation_seed'`.
 * Transient errors (Redis-side blips, transient HAF query failures) stay
 * swallowed because the next batch cycle re-derives the score from chain
 * state regardless. Permanent errors are programmer-error class
 * which signal a data-shape regression in `getReputationWeights()` output
 * that the next cycle will NOT self-heal — operator must investigate the
 * upstream weights data.
 *
 * Currently only `TypeError` is reachable from the seed try-block in
 * production: there is no `JSON.parse` on input and no array allocation.
 * `SyntaxError` and `RangeError` are pre-wired anticipatorily: tests
 * synthesize them via mocks and the discrimination surface is the canonical
 * "permanent programmer-error class" set so the cascade-fn permanent-error
 * rethrow convention can grow without the next cascade-fn author re-deriving
 * the membership question.
 */
function isPermanentSeedError(err: unknown): boolean {
  return err instanceof TypeError
    || err instanceof SyntaxError
    || err instanceof RangeError;
}

export async function seedAccreditationBonus(username: string): Promise<void> {
  const redis = getRedis();
  // Redis genuinely unavailable is transient at the per-request layer —
  // the next batch cycle re-derives provisional scores anyway. NOT
  // re-thrown so a Redis outage during accreditation doesn't surface 502
  // POST_BROADCAST_FAILED for a chain-confirmed accredit op.
  if (!redis) return;
  try {
    const weights = await getReputationWeights();
    const provisional = provisionalScore(weights.accreditation_bonus);
    // Write the provisional score if no real cycle value exists yet (NX), then
    // SADD the key into the members index UNCONDITIONALLY. The prod key exists
    // after this NX SET regardless of whether this call wrote it (a no-op means a
    // real cycle value already exists). SADD is idempotent, so re-indexing an
    // already-present member costs one round-trip — and that is the point: gating
    // the SADD on the NX result reopened an orphan window where a crash between a
    // prior SET and its separate SADD leaves the key unindexed, and a later retry
    // reads the NX no-op and would skip the SADD on a false "already a member"
    // assumption, leaving the user invisible to getBatchReputationMap's SMEMBERS
    // read until the next cycle swap or a restart's backfill. Unconditional SADD
    // closes that window. Without index maintenance at all, the freshly seeded
    // provisional key would be invisible to the SMEMBERS read — the regression the
    // members-index migration would otherwise introduce vs the old KEYS-glob read.
    await redis.set(batchKey(username), JSON.stringify(provisional), 'NX');
    await redis.sadd(batchMembersKey(), batchKey(username));
  } catch (err) {
    if (isPermanentSeedError(err)) {
      // Permanent (data-shape regression in weights or provisionalScore):
      // re-thrown so the post-broadcast cascade wrap lifts this into
      // PostBroadcastWriteError → 502 POST_BROADCAST_FAILED with
      // `failed_step:'reputation_seed'`. The structured operator-alert
      // anchor (`event:'post_broadcast_write_failed'`) fires at error
      // level; per-step user message says reputation will update at the
      // next scheduled cycle.
      throw err;
    }
    logger.warn({ err, username }, 'Failed to seed accreditation bonus');
  }
}

/**
 * Drop a user's batch entry on revocation. Without this, a revoked user with
 * no authored papers would keep their stale entry indefinitely (the next
 * cycle's `getAllAccreditedAccounts()` lookup excludes them, so the batch
 * never recomputes their slot). After deletion, readers fall through to 0.
 */
export async function invalidateOnRevocation(username: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(batchKey(username));
    // Drop the member too, so a revoked user's stale prod-key path does not
    // accumulate in the index (it would otherwise be MGET-null-skipped on read,
    // but pruning keeps the index bounded by the live accredited set).
    await redis.srem(batchMembersKey(), batchKey(username));
  } catch (err) {
    logger.warn({ err, username }, 'Failed to invalidate batch entry on revocation');
  }
}

/**
 * Boot-time seed sweep: ensure every currently-accredited user has at least
 * a provisional batch entry. Idempotent under SET NX, so users with real
 * cycle-computed scores are untouched. Fires from index.ts inside the
 * non-blocking after-listen Promise.all warmup.
 */
export async function backfillAccreditationSeeds(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const [accredited, weights] = await Promise.all([
      getAllAccreditedAccounts(),
      getReputationWeights(),
    ]);
    if (accredited.size === 0) return;
    logger.info({ count: accredited.size }, 'Accreditation seed backfill starting');
    const value = JSON.stringify(provisionalScore(weights.accreditation_bonus));
    const membersKey = batchMembersKey();
    const pipeline = redis.pipeline();
    for (const username of accredited) {
      pipeline.set(batchKey(username), value, 'NX');
      // Maintain the members index alongside each seed. SADD is idempotent, so a
      // user whose NX SET no-ops (a real cycle value already exists) is already a
      // member and unaffected; a user whose provisional SET lands becomes visible
      // to getBatchReputationMap's SMEMBERS read this cycle.
      pipeline.sadd(membersKey, batchKey(username));
    }
    const results = await pipeline.exec();
    // ioredis pipeline.exec() does not throw on a per-command error; inspect the
    // tuples and log-and-skip (best-effort backfill) so a partial failure is
    // visible rather than silently leaving the seed or index incomplete.
    const failed = results?.find(([err]) => err !== null);
    if (failed) {
      logger.warn({ err: failed[0]?.message }, 'Accreditation seed backfill pipeline had a per-command error; some seeds or index entries may be incomplete');
    }
    logger.info({ count: accredited.size }, 'Accreditation seed backfill complete');
  } catch (err) {
    logger.warn({ err }, 'Accreditation seed backfill failed');
  }
}

/**
 * Read every cycle-computed ReputationScore from Redis. Returns an empty map
 * if Redis is unavailable or no batch scores exist. Filters out staging keys
 * (intermediates owned by the batch writer's atomic-swap path).
 */
export async function getBatchReputationMap(): Promise<Map<string, ReputationScore>> {
  const map = new Map<string, ReputationScore>();
  const redis = getRedis();
  if (!redis) return map;

  try {
    // Fast path: the membership index (maintained by the CYCLE_SWAP Lua) bounds
    // enumeration by accredited-user count instead of the whole keyspace.
    let prodKeys = await redis.smembers(batchMembersKey());
    if (prodKeys.length === 0) {
      // Members-set miss. Either a genuinely empty batch (no cycle has run) or a
      // pre-members-set deployment whose prod keys predate the index. Enumerate
      // once via the non-blocking SCAN (not the blocking KEYS) and backfill the
      // set so subsequent reads take the SMEMBERS fast path. SADD is a no-op for
      // members a concurrent cycle already wrote.
      const scanned = (await scanAllKeys(redis, `${BATCH_KEY_PREFIX}*`))
        .filter((k) => !k.startsWith(REDIS_KEY_STAGING_PREFIX));
      if (scanned.length > 0) {
        await redis.sadd(batchMembersKey(), ...scanned);
        prodKeys = scanned;
      }
    }
    if (prodKeys.length === 0) return map;

    const values = await redis.mget(prodKeys);
    for (let i = 0; i < prodKeys.length; i++) {
      // Defensive: the set is populated with prod keys only (the Lua SADDs the
      // post-RENAME path), but skip any staging key that somehow landed in it
      // rather than surfacing it as a user named `staging:<name>`.
      if (prodKeys[i].startsWith(REDIS_KEY_STAGING_PREFIX)) continue;
      const username = prodKeys[i].replace(BATCH_KEY_PREFIX, '');
      const parsed = parseBatchValue(values[i]);
      if (parsed) map.set(username, parsed);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read batch reputation scores from Redis');
  }
  return map;
}

/**
 * Flatten a batch map to the score-only `{username: score}` shape consumed by
 * the SQL `prev_scores` jsonb parameter (`value::numeric` cast). Centralized
 * here so every score-only caller takes the same path; forgetting the
 * `.score` extraction silently collapses every voter weight to 1.0.
 */
export function batchMapToScoreRecord(map: Map<string, ReputationScore>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [username, rep] of map) {
    out[username] = rep.score;
  }
  return out;
}

// ─── Weights ────────────────────────────────────────────────────

const WEIGHTS_TTL = 30 * 60_000;

/**
 * Validate and clamp an on-chain `update_weights` payload before it overrides
 * the defaults. Only admin-signed ops reach this (the SQL signer gate in
 * `loadReputationWeights`), but the values themselves are still untrusted
 * operator input: a fat-fingered or malformed payload must not poison
 * reputation scoring. Each known weight is accepted only if it is a finite
 * number; non-numeric, NaN, Infinity, missing, and unknown-shaped fields are
 * dropped so the caller's spread falls back to DEFAULT_REPUTATION_WEIGHTS.
 * Domain-bounded fields are clamped to their valid range so a downstream SQL
 * consumer cannot receive an out-of-range multiplier:
 *   - decay_floor            -> [0, 1]  (a multiplier; >1 would amplify, not decay)
 *   - self_citation_discount -> [0, 1]  (a credit fraction)
 *   - decay_rate             -> >= 0    (negative would grow weight with age)
 *   - decay_grace_months     -> >= 0
 * `cycle_blocks` is accepted here if finite and clamped to > 0 downstream in
 * `reputation-batch.ts` (the catch-up-loop guard), so it stays unbounded here.
 */
export function sanitizeReputationWeights(raw: unknown): Partial<ReputationWeights> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<ReputationWeights> = {};
  for (const key of Object.keys(DEFAULT_REPUTATION_WEIGHTS) as (keyof ReputationWeights)[]) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
  }
  if (out.decay_floor !== undefined) out.decay_floor = Math.min(1, Math.max(0, out.decay_floor));
  if (out.self_citation_discount !== undefined) {
    out.self_citation_discount = Math.min(1, Math.max(0, out.self_citation_discount));
  }
  if (out.decay_rate !== undefined) out.decay_rate = Math.max(0, out.decay_rate);
  if (out.decay_grace_months !== undefined) out.decay_grace_months = Math.max(0, out.decay_grace_months);
  return out;
}

/**
 * Load the latest on-chain reputation weights. Gated on the SIGNER: an
 * `update_weights` custom_json is honored only when its `required_posting_auths`
 * carries `config.hiveAdminAccount` (the same authority the write side signs
 * with). Without this gate any Hive account could broadcast a custom_json under
 * the app's `custom_id` and seize every reputation parameter — custom_id +
 * action alone is unauthenticated, since any account can broadcast any custom_id.
 * Mirrors the `required_posting_auths` gate the accreditation / WoT / consent-op
 * readers already apply. Accepted payloads are value-sanitized via
 * `sanitizeReputationWeights` before overriding defaults.
 */
export async function loadReputationWeights(): Promise<ReputationWeights> {
  const pool = getPool();
  if (!pool) return DEFAULT_REPUTATION_WEIGHTS;

  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 2000');

    const exists = await client.query(
      `SELECT 1 FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json LIKE '%update_weights%'
         AND cj.required_posting_auths ? $2
       LIMIT 1`,
      [config.appTag, config.hiveAdminAccount],
    );

    if (exists.rows.length === 0) {
      await client.query('COMMIT');
      client.release();
      return DEFAULT_REPUTATION_WEIGHTS;
    }

    await client.query('SET LOCAL statement_timeout = 5000');
    const result = await client.query(
      `SELECT cj.json FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'update_weights'
         AND cj.required_posting_auths ? $2
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [config.appTag, config.hiveAdminAccount],
    );
    await client.query('COMMIT');
    client.release();

    if (result.rows.length === 0) return DEFAULT_REPUTATION_WEIGHTS;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    return { ...DEFAULT_REPUTATION_WEIGHTS, ...sanitizeReputationWeights(payload?.weights) };
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    logger.warn({ err }, 'Reputation weights query failed, using defaults');
    return DEFAULT_REPUTATION_WEIGHTS;
  }
}

export async function getReputationWeights(): Promise<ReputationWeights> {
  return hafCache.getOrSet<ReputationWeights>('reputation_weights', loadReputationWeights, WEIGHTS_TTL, true);
}

/** Warm the reputation weights cache at startup via periodic refresh. */
export async function startReputationWeightsCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('reputation_weights', loadReputationWeights, WEIGHTS_TTL);
  logger.info('Reputation weights cache loaded');
}

// ─── Calc version (auto-recompute trigger) ───────────────────────

/**
 * Explicit reputation calc-version. BUMP THIS WHENEVER THE SCORING BEHAVIOR
 * CHANGES — any edit to `computeReputationBatch`'s SQL that alters the scores it
 * produces, OR to the JS batch orchestration that feeds it (how `prev_scores`
 * thread into voter weights, how the active-author set is gated, the cycle
 * boundary math). On the next batch run a changed version forces a full
 * recompute of all finalized cycles (`runBatchComputation`), so a corrected calc
 * never leaves stale scores frozen until an operator manually clears
 * `reputation:cycle:last`.
 *
 * You do NOT need to bump this for an on-chain `update_weights` change: the
 * active weight set is folded into the version automatically by
 * `computeCalcVersion`'s weights hash. This constant is the manual lever for the
 * parts of scoring that live in code rather than in the weights row.
 */
export const CALC_VERSION = 1;

/**
 * The recompute-trigger fingerprint stored beside `reputation:cycle:last`: the
 * explicit `CALC_VERSION` (covers code changes a content hash could not see)
 * joined with a stable hash of the sanitized active weights (so an on-chain
 * `update_weights` auto-triggers a backfill). When this string differs from the
 * value persisted in Redis, the batch loop replays every cycle from 0.
 *
 * The weights are serialized key-sorted so JS property-insertion order can never
 * change the hash for an identical weight set (which would spuriously force a
 * full recompute on a no-op deploy).
 */
export function computeCalcVersion(weights: ReputationWeights): string {
  const canonical = JSON.stringify(
    Object.entries(weights).sort(([a], [b]) => a.localeCompare(b)),
  );
  const weightsHash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${CALC_VERSION}:${weightsHash}`;
}

// ─── SQL Reputation Computation ───────────────────────────────

/**
 * Compute reputation for multiple users in a single SQL query.
 * Shared CTEs (voter_weights, active_authors, etc.) run once.
 *
 * Parameters: $1 = target usernames, $2 = accredited, $3 = app_tag,
 * $4 = app_like, $5 = prev scores jsonb, $6 = cycle_end_block,
 * $7-$16 = weights (cast once in `w` CTE),
 * $17 = config.hiveBridgeAccount (for validPevoPaperWhere bridge-author pin),
 * $18 = config.hiveAnonAccount (for review-class anon-proxy OR-arm at
 *       the FOUR review CTEs that compose `validReviewWhere` —
 *       `active_authors` review arm, `paper_reviews`, `user_reviews`,
 *       and `citing_paper_quality`'s inner subquery; mirrors the
 *       display-side accreditation-or-anon shape composed at
 *       profile.ts / reviews.ts).
 * $19 = config.appTag, $20 = config.accreditationAuthorities — the
 *       authority-gated active_accreditations CTE (composed via
 *       activeAccreditationsCteBody) backing the Route-2 attested-ORCID
 *       anchor in the shared consented-set resolution; only authority-signed
 *       accredit/revoke ops are trusted.
 * $21+ = the shared `authorshipClaimsCteBody` allocation (appTag, bridge,
 *       claimers[] scope, admin, then the builder's internal claims_-prefixed
 *       chain backbone binds appTag + bridge), composed after
 *       active_accreditations. The cycle's accepted_claims is the
 *       `status = 'accepted'` projection of that builder's authorship_claims
 *       CTE instead of an inline copy, so the revoke/approve signer gates and
 *       the chain-aware name-only list-final gate live in one place shared
 *       with the read surfaces. There is NO metadata auto-accept arm:
 *       anchored slots earn credit only through Route-2 `author_accept`
 *       (the consented-set), name-only slots only through claim + approve.
 *
 * The same FOUR review CTEs also compose `excludeSelfReviewWhere` so
 * paper-authors and named co-authors reviewing their own paper are
 * filtered before contributing to active_authors (voter_weight curve),
 * paper_reviews.quality (paper_scores multiplier), user_reviews
 * (reviewer's own breakdown), and citing_paper_quality (citation
 * discount). Per-site rationale lives at the CTEs.
 */
export const HEAD_QUERY_TIMEOUT_MS = 5000;
const BATCH_QUERY_TIMEOUT_MS = 25000;

/**
 * Run a single read under a per-query `statement_timeout`, scoped via a short
 * transaction + `SET LOCAL` (the only way to bound one query without leaking the
 * GUC to the pooled connection) — the same connect + BEGIN + SET LOCAL scoping
 * technique loadReputationWeights uses. A hung HAF replica then fails the
 * wrapped query at `timeoutMs` instead of stranding the cycle on the coarse
 * pool-level 30s default. Always releases.
 *
 * Residual bound: only the wrapped `sql` runs under `timeoutMs`. The BEGIN,
 * COMMIT, and ROLLBACK statements themselves fall under the pool-level 30s
 * `statement_timeout` (db.ts), so the true worst case against a hung replica is
 * up to 30s at BEGIN + `timeoutMs` for the query + up to 30s at COMMIT, not
 * `timeoutMs` flat. The narrower per-query bound is still the dominant guard for
 * the read that actually hits HAF.
 */
export async function queryWithStatementTimeout<R extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  timeoutMs: number,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const result = await client.query<R>(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function computeReputationBatch(
  usernames: string[],
  prevScores?: Record<string, number>,
  cycleEndBlock?: number,
  // Optional weights snapshot. The batch orchestrator reads the weights ONCE
  // per run (to compute the calc-version fingerprint) and threads that same
  // object through every cycle so the persisted fingerprint always matches the
  // weights actually applied to scoring — the WEIGHTS_TTL periodic refresh
  // cannot swap them mid-run. Standalone callers omit it and fetch the live set.
  weightsArg?: ReputationWeights,
): Promise<Map<string, ReputationScore>> {
  const results = new Map<string, ReputationScore>();
  if (usernames.length === 0) return results;

  const pool = getPool();
  if (!pool) return results;

  try {
    const [accreditedAccounts, weights] = await Promise.all([
      getAllAccreditedAccounts(),
      weightsArg ? Promise.resolve(weightsArg) : getReputationWeights(),
    ]);

    const accreditedArr = [...accreditedAccounts];

    let endBlock = cycleEndBlock;
    if (!endBlock) {
      const headResult = await queryWithStatementTimeout<{ head: string | number | null }>(pool, HEAD_QUERY_TIMEOUT_MS, `SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
      endBlock = Number(headResult.rows[0]?.head ?? 0);
      if (endBlock === 0) return results;
    }

    const prevJson = prevScores ?? batchMapToScoreRecord(await getBatchReputationMap());

    // Shared authorship-claims resolution: the cycle consumes the SAME builder as
    // the read surfaces instead of an inline copy. Scoped to the target users
    // ({claimers}); allocates $21+ (appTag, bridge, claimers, admin, then the
    // builder's internal claims_-prefixed chain backbone binds appTag + bridge)
    // in the slots after the cycle's hand-numbered $1-$20 block; no existing
    // $1-$20 placeholder shifts. The builder's authorship_claims CTE is
    // projected to accepted_claims (status='accepted') in the WITH chain below.
    // The builder embeds recursive CTEs, so the outer query MUST say
    // WITH RECURSIVE.
    const claimsCte = authorshipClaimsCteBody(21, { claimers: usernames });
    // Route-2 consented-set resolution (the shared consentChainCteBody /
    // consentedAuthorsCteBody stack the read surfaces also consume). The
    // chain walk is seeded from `consent_seed` — the papers referenced by
    // consent-relevant ops involving the target users (accept/resign signed
    // by them, revokes naming them) — so the recursive walk is bounded by
    // the batch's consent activity, not corpus size. The {signers} scope
    // narrows the resolved accounts to the batch, mirroring the {claimers}
    // scope on the claims builder.
    const chainCte = consentChainCteBody(claimsCte.nextIdx, { rootsFromCte: 'consent_seed' });
    const consentedCte = consentedAuthorsCteBody(chainCte.nextIdx, { signers: usernames });

    const result = await queryWithStatementTimeout<{
      username: string;
      score: string | number;
      papers: string | number;
      reviews: string | number;
      citations: string | number;
      accreditation: string | number;
    }>(
      pool,
      BATCH_QUERY_TIMEOUT_MS,
      `WITH RECURSIVE

      -- Cast weight parameters once
      w AS (SELECT
        $7::numeric  AS paper,
        $8::numeric  AS review,
        $9::numeric AS downvote,
        $10::numeric AS citation,
        $11::numeric AS citation_max,
        $12::numeric AS accreditation_bonus,
        $13::numeric AS self_citation_discount,
        $14::numeric AS decay_rate,
        $15::numeric AS decay_floor,
        $16::numeric AS decay_grace_months
      ),

      target_users AS (
        SELECT unnest AS username FROM unnest($1::text[])
      ),

      -- Reference timestamp for the cycle's decay age. Resolve the most
      -- recent block at or before the cycle's last block rather than an exact
      -- equality on the end block: an exact match returns zero rows whenever
      -- the cycle's end block has not been produced yet (a caller passing an
      -- in-progress cycleEndBlock), and the CROSS JOINs below would then
      -- collapse every score arm to NULL. The bounded order-by-descending
      -- single-row form always yields the latest existing block, so a stray
      -- in-progress end block degrades to scoring against head instead of
      -- zeroing out.
      cycle_ref AS (
        SELECT b.timestamp AS ref_ts
        FROM ${T.blocks} b
        WHERE b.block_num <= $6 - 1
        ORDER BY b.block_num DESC
        LIMIT 1
      ),

      prev_scores AS (
        SELECT key AS username, value::numeric AS rep
        FROM jsonb_each_text($5)
      ),

      active_authors AS (
        SELECT DISTINCT author FROM (
          SELECT c.author FROM ${T.comments} c
          WHERE c.parent_author = '' AND c.parent_permlink = $3
            AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$17', source: 'all' })}
            AND c.json_metadata ->> 'app' LIKE $4
            -- Bound the paper arm to accredited authors. The only consumer,
            -- voter_weights, joins active_authors aa ON aa.author = a.voter
            -- where a.voter iterates accreditedArr, so any non-accredited
            -- paper author materialized here is discarded by that join.
            -- Filtering on accreditedArr up front keeps active_authors from
            -- materializing PEvO authors the consumer can never use. The
            -- bridge and anon-proxy accounts (hiveBridgeAccount /
            -- hiveAnonAccount) are intentionally NOT OR'd in: neither is ever
            -- a voter, so adding them would re-widen the set with zero
            -- consumer benefit.
            AND c.author = ANY($2::text[])
          UNION ALL
          -- Review arm: gate on accreditation (or the anon proxy), AND
          -- exclude self-reviews. The shared validReviewWhere helper
          -- documents that callers must compose accreditation; without it,
          -- an unaccredited Hive account broadcasting a review-shaped reply
          -- would inflate active_authors -> flow into voter_weights ->
          -- game scoring. The excludeSelfReviewWhere predicate rejects
          -- paper-authors and named co-authors reviewing their own paper:
          -- a named co-author who has never published nor reviewed others'
          -- work could otherwise bootstrap into the accredited voter_weight
          -- curve (LEAST(1.0, GREATEST(0.4, ...)) — floor 0.4 at rep=0) by
          -- broadcasting one self-review. Sibling 3 review-class CTEs
          -- (paper_reviews, user_reviews, citing_paper_quality) already
          -- compose this helper; this is the 4th composition site.
          SELECT c.author FROM ${T.comments} c
          JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
          WHERE p.parent_author = '' AND p.parent_permlink = $3
            AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: '$3', bridgeAccountParam: '$17', source: 'all' })}
            AND p.json_metadata ->> 'app' LIKE $4
            AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
            AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$3' })}
            AND (c.author = ANY($2::text[]) OR c.author = $18)
        ) t
      ),

      voter_weights AS (
        SELECT
          a.voter,
          CASE
            WHEN ps.rep IS NULL THEN 1.0
            WHEN aa.author IS NOT NULL THEN
              LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
            ELSE
              LEAST(1.0, sqrt(ps.rep / 100.0))
          END AS vw
        FROM unnest($2::text[]) AS a(voter)
        LEFT JOIN prev_scores ps ON ps.username = a.voter
        LEFT JOIN active_authors aa ON aa.author = a.voter
      ),

      -- ═══ AUTHORSHIP CONSENT (for co-author credit) ═══
      -- Authority-gated accreditation source for the Route-2 attested-ORCID
      -- anchor below. accred_ranked applies the
      -- required_posting_auths ?| accreditationAuthorities gate, so only an
      -- accredit/revoke op signed by an accreditation authority is trusted; a
      -- self-signed op (the broadcaster's own posting auth) never enters
      -- active_accreditations. This is the same gated source the shared
      -- consentedAuthorsCteBody eligibility join reads, so the cycle and the
      -- read surfaces agree on which ORCID attestations are valid; a revoke
      -- clears the account from active_accreditations so a prior attestation
      -- stops anchoring.
      ${activeAccreditationsCteBody(19).sql},
      -- Shared Route-3 claims resolution: the cycle composes the SAME builder
      -- the read surfaces use (papers/profile/search/stats) instead of an
      -- inline copy. The builder emits claim_events / claims_base / its
      -- claims_-prefixed chain backbone / approvals / revocations /
      -- authorship_claims, scoped to the target-user claimers via the
      -- {claimers} variant. The revoke / approve signer gates and the
      -- chain-aware name-only list-final gate live in the builder — pinned by
      -- the read-surface tests (authorship-*-signer-gate, hafsql.test.ts) so
      -- the cycle and read surfaces cannot drift. There is NO metadata
      -- auto-accept arm: anchored slots earn credit only through the Route-2
      -- consented-set below.
      ${claimsCte.sql},
      -- accepted_claims is the thin status='accepted' projection of the
      -- builder's authorship_claims CTE: status='accepted' ⟺ NOT revoked AND
      -- explicit approval AND author_index resolves to a name-only slot in
      -- the cumulative-chain union. SELECT DISTINCT collapses to the
      -- (claimer, paper_author, paper_permlink) key user_papers and the
      -- self-dealing NOT EXISTS gates join on.
      accepted_claims AS (
        SELECT DISTINCT claimer, paper_author, paper_permlink
        FROM authorship_claims
        WHERE status = 'accepted'
      ),
      -- Seed for the Route-2 chain walk: every paper cited by a consent op
      -- involving a target user (accept/resign they signed, or a revoke
      -- naming them). Papers with no batch-relevant consent activity never
      -- enter the walk, so its cost tracks consent-op volume, not corpus
      -- size. Native root credit does NOT depend on this seed (the native
      -- user_papers arm below credits the broadcaster directly); the seed
      -- only needs to cover papers where a Route-2 accept or a demotion
      -- could change the credited set.
      consent_seed AS (
        SELECT DISTINCT cj.json::jsonb ->> 'root_author' AS paper_author,
               cj.json::jsonb ->> 'root_permlink' AS paper_permlink
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $3
          AND cj.json::jsonb ->> 'action' IN ('author_accept', 'author_resign')
          AND cj.required_posting_auths ->> 0 = ANY($1::text[])
        UNION
        SELECT DISTINCT cj.json::jsonb ->> 'paper_author',
               cj.json::jsonb ->> 'paper_permlink'
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $3
          AND cj.json::jsonb ->> 'action' = 'revoke_authorship'
          AND cj.json::jsonb ->> 'claimer' = ANY($1::text[])
      ),
      -- Route-2 consented-set: the unprefixed shared chain backbone over the
      -- seeded papers, then consented_authors (root broadcaster + anchored
      -- author_accept, resign/revoke demotions, latest-op-wins). Composed
      -- after active_accreditations (the orcid-anchor eligibility joins it).
      ${chainCte.sql},
      ${consentedCte.sql},

      -- ═══ PAPERS ═══
      -- Each row carries two identities: author is the credit recipient (the
      -- claimer for claim rows, the post author for native rows) and the final
      -- SUM in totals attributes the paper score to it; (chain_author,
      -- chain_permlink) is the on-chain post identity that votes and reviews
      -- are signed against. Downstream vote/review CTEs MUST match on the chain
      -- identity — votes/reviews target the original post author, never the
      -- claimer — while credit accrues to author. Keying those joins on
      -- author (as the pre-fix code did) silently scored every claimed paper
      -- at 0: no vote or review is ever signed against the claimer's name, so
      -- the joins found nothing and the documented co-author credit delivered
      -- zero. permlink always equals chain_permlink (both arms take the
      -- chain post's permlink); only the author identity diverges, but both
      -- chain columns are projected for symmetric, self-evident joins.
      user_papers AS (
        -- Papers authored by user (native only — see validPevoPaperWhere 'native'
        -- arm). Route 1 of the consent model: the root broadcaster is implicitly
        -- consented by the post signature. The NOT EXISTS demotion guard honors
        -- a later author_resign / revoke naming the broadcaster themself
        -- (route2_latest only carries rows for batch-seeded papers, so papers
        -- with no consent activity pass the guard without touching the walk).
        SELECT c.author, c.permlink, c.created, c.json_metadata,
               c.author AS chain_author, c.permlink AS chain_permlink
        FROM ${T.comments} c
        WHERE c.author IN (SELECT username FROM target_users)
          AND c.parent_author = '' AND c.parent_permlink = $3
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$17', source: 'native' })}
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM route2_latest rl
            WHERE rl.root_author = c.author AND rl.root_permlink = c.permlink
              AND rl.account = c.author AND rl.rn = 1 AND rl.action != 'author_accept'
          )
        UNION ALL
        -- Papers claimed by user (Route 3 — name-only claim + approve) —
        -- bridge_paper claims allowed but only when authored by
        -- config.hiveBridgeAccount; spoofed bridge_paper can't grant unearned
        -- co-author credit. Credit recipient is the claimer; the chain identity
        -- stays the original post (ac.paper_author/permlink = c.author/permlink
        -- via the join).
        SELECT ac.claimer AS author, c.permlink, c.created, c.json_metadata,
               c.author AS chain_author, c.permlink AS chain_permlink
        FROM accepted_claims ac
        JOIN ${T.comments} c ON c.author = ac.paper_author AND c.permlink = ac.paper_permlink
        WHERE c.parent_author = '' AND c.parent_permlink = $3
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$17', source: 'all' })}
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
          AND ac.claimer != c.author  -- avoid double-counting
        UNION ALL
        -- Papers consented by user (Route 2 — author_accept on a slot anchored
        -- by their hive handle or attested ORCID; demotions already resolved
        -- inside consented_authors). Same shape as the claims arm: credit
        -- recipient is the consented account, chain identity stays the
        -- original post. The root broadcaster's own row is excluded — their
        -- credit flows through the native arm (avoid double-counting).
        SELECT ca.account AS author, c.permlink, c.created, c.json_metadata,
               c.author AS chain_author, c.permlink AS chain_permlink
        FROM consented_authors ca
        JOIN ${T.comments} c ON c.author = ca.root_author AND c.permlink = ca.root_permlink
        WHERE c.parent_author = '' AND c.parent_permlink = $3
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$17', source: 'all' })}
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
          AND ca.account != c.author  -- avoid double-counting vs the native arm
          AND NOT EXISTS (
            -- avoid double-counting vs the claims arm: an account credited via
            -- BOTH routes on one paper must contribute exactly one
            -- user_papers row (totals SUMs per row; two rows would double the
            -- paper's score for that recipient)
            SELECT 1 FROM accepted_claims ac2
            WHERE ac2.paper_author = ca.root_author
              AND ac2.paper_permlink = ca.root_permlink
              AND ac2.claimer = ca.account
          )
      ),

      -- Distinct on-chain papers credited to at least one target user (via the
      -- native or claim arm of user_papers). Dedup is load-bearing: when both
      -- the post author and a claimer are target users for the same chain post,
      -- user_papers holds two rows sharing one (chain_author, chain_permlink)
      -- but crediting different recipients. The vote/review CTEs match against
      -- THIS set so a chain post contributes one review-quality row and one
      -- vote-aggregate row regardless of how many recipients it credits — no
      -- per-recipient fan-out that would multiply a vote's weight. json_metadata
      -- is identical across the two arms (same comments row), so DISTINCT
      -- collapses cleanly and the co-author/self-vote exclusions below read the
      -- one true authors[] for the post.
      chain_papers AS (
        SELECT DISTINCT chain_author AS author, chain_permlink AS permlink, json_metadata
        FROM user_papers
      ),

      paper_vote_signals AS (
        -- Vote membership is scoped by chain_papers (the post being voted on must
        -- be authored-or-claimed by a target user), NOT by vo.author IN
        -- target_users. A claimed paper's votes are signed against the chain
        -- author, who may not be a target user (e.g. the bridge account or an
        -- unaccredited poster) — the prior target-user restriction dropped them
        -- and starved the claimer's credit. chain_papers membership admits
        -- exactly the votes on papers some target user is credited for.
        SELECT voter, author, permlink, weight, block_num, op_id FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num, vo.id AS op_id
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND EXISTS (SELECT 1 FROM chain_papers cp WHERE cp.author = vo.author AND cp.permlink = vo.permlink)
            AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
            CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
            cj.block_num,
            cj.id AS op_id
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND EXISTS (SELECT 1 FROM chain_papers cp WHERE cp.author = cj.json::jsonb ->> 'author' AND cp.permlink = cj.json::jsonb ->> 'permlink')
            AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      paper_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
        FROM paper_vote_signals
        -- Same-block tie-breaker: op_id is the GLOBAL haf_operations PK (vo.id for
        -- native votes, cj.id for revotes), one monotonic sequence shared across
        -- operation_vote_view and operation_custom_json_view (the views have no
        -- trx_in_block), so op_id DESC across the union arms is genuine cross-arm
        -- latest-wins, not merely per-stream-deterministic. Do NOT namespace op_id
        -- per arm (that would break the cross-arm latest-wins). Per
        -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
        ORDER BY voter, author, permlink, block_num DESC, op_id DESC
      ),

      paper_resolved_votes AS (
        -- The CASE WHEN jsonb_typeof = array guard on the authors argument
        -- defends against a chain post broadcasting a non-array
        -- pevo.authors (null, string, integer, object). Without it,
        -- jsonb_array_elements raises "cannot extract elements from a scalar"
        -- at runtime and the entire daily reputation cycle cascade-fails for
        -- every user. Symmetric with the helper-level guard in
        -- excludeSelfReviewWhere's EXISTS predicate (per
        -- agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md).
        --
        -- The inner jsonb_typeof(a) = object guard is also a cascade-fail
        -- defense -- NOT a co-author admission tightening. It prevents
        -- jsonb_array_elements yields (which can be JSONB scalars when the
        -- outer guard's []::jsonb fallback path is NOT taken; i.e., authors
        -- IS an array but contains bare strings, null, or integers) from
        -- reaching a ->> hive. The ->> operator on a JSONB scalar returns
        -- NULL silently; NULL = plv.voter evaluates to NULL (not TRUE), the
        -- EXISTS subquery yields 0 rows, and NOT EXISTS evaluates TRUE for
        -- every voter -- falling back to the plv.voter != cp.author first
        -- conjunct (which still excludes the paper author).
        --
        -- What this guard does NOT do: it does NOT exclude bare-string
        -- author entries from being admitted as non-self voters. A paper
        -- broadcast with authors: [alice, bob] (strings, not objects with a
        -- hive key) admits bob as a non-self voter -- bob's row falls
        -- through to the second conjunct, the object filter rejects the
        -- strings, EXISTS yields 0 rows, NOT EXISTS evaluates TRUE.
        -- This is INTENTIONAL: per
        -- agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md,
        -- a PEvO authors[] entry is a well-formed object with a hive key,
        -- not a free-text identity claim. Treating bare strings as
        -- co-author identity would enable a denial-of-vote attack -- anyone
        -- could broadcast authors: [target] to lock target out of voting
        -- on the paper.
        --
        -- The JOIN is on chain_papers (the on-chain post identity), NOT
        -- user_papers (the credit recipient). plv.author/plv.permlink are the
        -- voted post's chain coords, so this keys votes to the post they were
        -- signed against; chain_papers is deduped so a post credited to several
        -- recipients still contributes each vote exactly once. cp.author IS the
        -- chain post author, so plv.voter != cp.author excludes the actual
        -- POSTER's self-vote. That gate alone does NOT cover a credited
        -- claimer's self-vote: a claimer's name differs from the poster, so it
        -- passes plv.voter != cp.author. The accepted_claims NOT EXISTS below is
        -- the complementary gate that closes the claimer self-dealing path.
        SELECT plv.voter, plv.author, plv.permlink, plv.weight, plv.block_num
        FROM paper_latest_votes plv
        JOIN chain_papers cp ON cp.author = plv.author AND cp.permlink = plv.permlink
        WHERE plv.voter != cp.author
          AND plv.weight != 0
          AND NOT EXISTS (
            -- Co-author voter exclusion: canonicalize the broadcaster-
            -- controlled authors[i].hive via LOWER(TRIM(...)) plus the
            -- Hive-account charset regex (mirrors normalizeHiveAccount and
            -- excludeSelfReviewWhere) before byte-equality against the
            -- chain-validated lowercase plv.voter. An uppercase mid-case
            -- pevo.authors entry would otherwise admit a co-author's vote
            -- into the paper_resolved_votes set, inflating the paper-
            -- author's reputation score.
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(cp.json_metadata -> $3 -> 'authors') = 'array'
                THEN cp.json_metadata -> $3 -> 'authors'
                ELSE '[]'::jsonb
              END
            ) a
            WHERE jsonb_typeof(a) = 'object'
              AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
              AND LOWER(TRIM(a ->> 'hive')) = plv.voter
          )
          AND NOT EXISTS (
            -- Credited self-vote exclusion (self-dealing close): a credited
            -- co-author of THIS chain post — Route-3 claimer OR Route-2
            -- consented — must not upvote it to inflate their own co-author
            -- reputation. The authors[].hive exclusion above misses accounts
            -- connected via ORCID match or a name-only slot — their hive is
            -- absent from the raw on-chain authors[] — so without this gate
            -- such a credited account self-votes into their own credit.
            -- accepted_claims ∪ consented_authors is the credited set for the
            -- post (plv.author/plv.permlink are the chain post coords).
            SELECT 1 FROM accepted_claims ac
            WHERE ac.paper_author = plv.author
              AND ac.paper_permlink = plv.permlink
              AND ac.claimer = plv.voter
          )
          AND NOT EXISTS (
            SELECT 1 FROM consented_authors ca
            WHERE ca.root_author = plv.author
              AND ca.root_permlink = plv.permlink
              AND ca.account = plv.voter
          )
      ),

      paper_reviews AS (
        -- validReviewWhere is load-bearing here: the AVG below casts each
        -- rating dimension to numeric unconditionally. Before this gate, a
        -- malformed rating (string, partial object, missing key) would
        -- crash the cycle compute. The regex inside validReviewWhere
        -- guarantees each dimension is an integer-shaped string the cast
        -- can consume. excludeSelfReviewWhere is also load-bearing: a
        -- self-5/5/5/5 would push pr.quality toward 1.0 (max), inflating
        -- the paper's vote-derived score in the paper_scores CTE.
        -- Mirrors the paper_resolved_votes self-exclusion above.
        -- Accreditation gate ($2 = accredited, $18 = anon) — without it,
        -- any unaccredited Hive account broadcasting a valid-shape review
        -- to a target user paper would inflate pr.quality (5/5/5/5 ->
        -- AVG/4.0/5.0 = 1.0x max multiplier on the paper vote-derived
        -- score). The helper docstring documents that callers must
        -- compose accreditation; this CTE is one of the review-class
        -- composition sites that compose the accreditation gate.
        --
        -- Keyed on chain_papers, NOT user_papers: reviews target the on-chain
        -- post (parent_author = the chain author), and the self-exclusion's
        -- paperRowAlias must be the chain author so a self-review by the actual
        -- poster of a claimed paper is still excluded. paper_scores LEFT JOINs
        -- this on the chain identity; credit then attributes to up.author.
        SELECT cp.author, cp.permlink,
          AVG(
            ((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
          ) / 5.0 AS quality
        FROM chain_papers cp
        JOIN ${T.comments} c
          ON c.parent_author = cp.author AND c.parent_permlink = cp.permlink
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ paperRowAlias: 'cp', appTagParam: '$3' })}
          AND NOT EXISTS (
            -- Credited self-review exclusion (self-dealing close): mirror of
            -- the paper_resolved_votes credited gate. excludeSelfReviewWhere
            -- above rejects the chain poster + authors[].hive members; an
            -- account credited via an ORCID-anchored accept or a name-only
            -- claim is in neither set, so without this a credited co-author
            -- could 5/5/5/5 self-review the paper they are credited for and
            -- drive pr.quality toward the max multiplier on their own score.
            SELECT 1 FROM accepted_claims ac
            WHERE ac.paper_author = cp.author
              AND ac.paper_permlink = cp.permlink
              AND ac.claimer = c.author
          )
          AND NOT EXISTS (
            SELECT 1 FROM consented_authors ca
            WHERE ca.root_author = cp.author
              AND ca.root_permlink = cp.permlink
              AND ca.account = c.author
          )
          AND (c.author = ANY($2::text[]) OR c.author = $18)
        GROUP BY cp.author, cp.permlink
      ),

      paper_vote_agg AS (
        SELECT prv.author, prv.permlink,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
        FROM paper_resolved_votes prv
        JOIN voter_weights vw ON vw.voter = prv.voter
        GROUP BY prv.author, prv.permlink
      ),

      paper_scores AS (
        SELECT up.author, up.permlink,
          GREATEST(-w.paper, LEAST(w.paper,
            COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), w.paper)
            - COALESCE(pva.weighted_down, 0) * w.downvote
          )) * ${decayMultiplierSql('up.created')} AS score
        FROM user_papers up
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        -- Reviews and votes are keyed on the on-chain post identity (the
        -- claimer's name never appears on a vote or review), so match on
        -- up.chain_author/up.chain_permlink. The selected up.author is the
        -- credit recipient (claimer or native author); totals SUM(score) GROUP
        -- BY author then routes the paper's score to it. For a chain post
        -- credited to both its author and a claimer, each gets one paper_scores
        -- row carrying the same vote/review-derived score — the shared
        -- co-author credit the algorithm documents.
        LEFT JOIN paper_reviews pr ON pr.author = up.chain_author AND pr.permlink = up.chain_permlink
        LEFT JOIN paper_vote_agg pva ON pva.author = up.chain_author AND pva.permlink = up.chain_permlink
      ),

      -- ═══ REVIEWS ═══
      -- user_reviews materializes each target_user's universe of reviews
      -- for the cycle. Composed predicates:
      --   - validReviewWhere: rating-shape + review-type-tag identity.
      --   - excludeSelfReviewWhere: rejects paper-author + named-co-author
      --     self-reviews (consistent with paper_resolved_votes vote treatment).
      --   - validPevoPaperWhere on the parent paper: ensures the JOIN
      --     materializes a real PEvO paper (native or bridge) so a review-
      --     typed reply to a non-paper Hive post doesn't inflate the cycle.
      --     source='all' admits both arms; the bridge-author pin narrows
      --     the bridge arm. Per the pevo-object-identity-is-author-vouching
      --     convention.
      --   - Accreditation gate (c.author = ANY($2::text[]) OR c.author = $18):
      --     structurally required per the helper contract (callers compose
      --     accreditation), mirroring the sibling review-class CTEs and
      --     the display-side composition at profile.ts. In the current call-
      --     graph $1 and $2 derive from the same getAllAccreditedAccounts
      --     snapshot, so this site's check is functionally subsumed by the
      --     c.author IN target_users filter; the structural rule — every
      --     validReviewWhere caller MUST compose accreditation — is the
      --     load-bearing invariant. A future caller passing a non-accredited
      --     usernames set won't silently bypass.
      -- Mutation kill at each composed site lives in the
      -- defense-in-depth-canary-must-pin-each-layer convention.
      user_reviews AS (
        SELECT c.author, c.permlink, c.created
        FROM ${T.comments} c
        JOIN ${T.comments} up_for_self
          ON up_for_self.author = c.parent_author AND up_for_self.permlink = c.parent_permlink
          AND ${validPevoPaperWhere({ commentAlias: 'up_for_self', appTagParam: '$3', bridgeAccountParam: '$17', source: 'all' })}
        WHERE c.author IN (SELECT username FROM target_users)
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ paperRowAlias: 'up_for_self', appTagParam: '$3' })}
          AND (c.author = ANY($2::text[]) OR c.author = $18)
          AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
      ),

      review_vote_signals AS (
        SELECT voter, author, permlink, weight, block_num, op_id FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num, vo.id AS op_id
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author IN (SELECT username FROM target_users)
            AND EXISTS (SELECT 1 FROM user_reviews ur WHERE ur.author = vo.author AND ur.permlink = vo.permlink)
            AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
            CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
            cj.block_num,
            cj.id AS op_id
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
            AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      review_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM review_vote_signals
        -- Same-block tie-breaker: op_id is the GLOBAL haf_operations PK (vo.id for
        -- native votes, cj.id for revotes), one monotonic sequence shared across
        -- operation_vote_view and operation_custom_json_view (the views have no
        -- trx_in_block), so op_id DESC across the union arms is genuine cross-arm
        -- latest-wins, not merely per-stream-deterministic. Do NOT namespace op_id
        -- per arm (that would break the cross-arm latest-wins). Per
        -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
        ORDER BY voter, author, permlink, block_num DESC, op_id DESC
      ),

      review_resolved_votes AS (
        SELECT rlv.voter, rlv.author, rlv.permlink, rlv.weight
        FROM review_latest_votes rlv
        JOIN user_reviews ur ON ur.author = rlv.author AND ur.permlink = rlv.permlink
        WHERE rlv.voter != rlv.author
          AND rlv.weight != 0
      ),

      review_vote_agg AS (
        SELECT rrv.author, rrv.permlink,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
          COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
        FROM review_resolved_votes rrv
        JOIN voter_weights vw ON vw.voter = rrv.voter
        GROUP BY rrv.author, rrv.permlink
      ),

      review_scores AS (
        SELECT ur.author, ur.permlink,
          GREATEST(-w.review, LEAST(w.review,
            LEAST(COALESCE(rva.weighted_up, 0), w.review)
            - COALESCE(rva.weighted_down, 0) * w.downvote
          )) * ${decayMultiplierSql('ur.created')} AS score
        FROM user_reviews ur
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        LEFT JOIN review_vote_agg rva ON rva.author = ur.author AND rva.permlink = ur.permlink
      ),

      -- ═══ CITATIONS ═══
      citing_papers AS (
        -- CASE-WHEN array guard at the SRF argument position. The prior
        -- WHERE-clause jsonb_typeof on citations was a placebo: Postgres
        -- evaluates CROSS JOIN LATERAL BEFORE the WHERE clause, so the
        -- SRF expands on every input row regardless of the WHERE filter.
        -- A chain post broadcasting pevo.citations as null, string,
        -- integer, or object would raise cannot extract elements from a
        -- scalar and cascade-fail the daily reputation cycle for every
        -- user. See pg-cross-join-lateral-where-guard-fires-after-srf
        -- -2026-05-16 (companion: pg-jsonb-null-vs-sql-null-use-jsonb
        -- -typeof-2026-05-12).
        SELECT
          citing.author AS citing_author,
          citing.permlink AS citing_permlink,
          citing.created AS citing_created,
          citing.json_metadata AS citing_meta,
          cit ->> 'author' AS cited_author
        FROM ${T.comments} citing
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(citing.json_metadata -> $3 -> 'citations') = 'array'
               THEN citing.json_metadata -> $3 -> 'citations'
               ELSE '[]'::jsonb
          END
        ) AS cit
        WHERE citing.parent_author = '' AND citing.parent_permlink = $3
          AND (citing.json_metadata -> $3 ->> 'type') = 'paper'
          AND citing.json_metadata ->> 'app' LIKE $4
          AND citing.author = ANY($2::text[])
          AND (cit ->> 'author') IN (SELECT username FROM target_users)
          AND COALESCE((cit ->> 'reputation_relevant')::boolean, true) = true
      ),

      citing_vote_signals AS (
        SELECT voter, permlink, author, weight, block_num, op_id FROM (
          SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num, vo.id AS op_id
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
            AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'permlink' AS permlink,
            cj.json::jsonb ->> 'author' AS author,
            -- {1,9} bounds the digit count for overflow safety: an unbounded match admits a value that overflows ::int and aborts the whole query (max Hive vote weight is 10000).
            CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
            cj.block_num,
            cj.id AS op_id
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
            AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
              IN (SELECT citing_author, citing_permlink FROM citing_papers)
        ) all_signals
      ),

      citing_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM citing_vote_signals
        -- Same-block tie-breaker: op_id is the GLOBAL haf_operations PK (vo.id for
        -- native votes, cj.id for revotes), one monotonic sequence shared across
        -- operation_vote_view and operation_custom_json_view (the views have no
        -- trx_in_block), so op_id DESC across the union arms is genuine cross-arm
        -- latest-wins, not merely per-stream-deterministic. Do NOT namespace op_id
        -- per arm (that would break the cross-arm latest-wins). Per
        -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
        ORDER BY voter, author, permlink, block_num DESC, op_id DESC
      ),

      citing_paper_quality AS (
        SELECT
          cp.cited_author,
          cp.citing_author,
          cp.citing_permlink,
          cp.citing_created,
          cp.citing_author = cp.cited_author AS is_self,
          COALESCE(cpr.quality, 1.0) AS review_quality,
          -- Co-author voter exclusion on the citing paper, mirroring the
          -- paper_resolved_votes self-exclusion shape exactly. The byte-equality
          -- clv.voter != cp.citing_author is RETAINED, not subsumed: a citing
          -- paper may omit its own author from pevo.authors[] (or broadcast a
          -- malformed/non-array authors field that the inner CASE-WHEN guard
          -- collapses to '[]'), in which case the canonicalizing NOT EXISTS
          -- admits zero rows and the author's own upvote would re-enter the
          -- weighted_upvotes term without the byte-equality conjunct. The
          -- NOT EXISTS adds the co-author dimension: a confederate listed in
          -- citing.pevo.authors[].hive upvoting the citing paper would otherwise
          -- inflate LEAST(weighted_upvotes, 1.0), which multiplies into the
          -- cited author's citation_value. cp.citing_meta is the citing paper's
          -- json_metadata carried from citing_papers; canonicalize the
          -- broadcaster-controlled authors[i].hive via LOWER(TRIM(...)) plus the
          -- Hive-account charset regex before byte-equality against the
          -- chain-validated lowercase clv.voter, identical to
          -- paper_resolved_votes. The jsonb_typeof array guard at the SRF arg
          -- and the inner object guard are the same cascade-fail defenses as in
          -- the sibling CTE (a non-array authors collapses to '[]'; bare-string
          -- entries are rejected, not admitted as co-author identities).
          COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
            FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(cp.citing_meta -> $3 -> 'authors') = 'array'
                    THEN cp.citing_meta -> $3 -> 'authors'
                    ELSE '[]'::jsonb
                  END
                ) a
                WHERE jsonb_typeof(a) = 'object'
                  AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
                  AND LOWER(TRIM(a ->> 'hive')) = clv.voter
              )
            ), 0
          ) AS weighted_upvotes
        FROM citing_papers cp
        LEFT JOIN (
          -- Citing-paper review quality: mirror of paper_reviews CTE for the
          -- citation arm. validReviewWhere protects the ::numeric casts from
          -- malformed ratings at the gate (same load-bearing reason).
          -- excludeSelfReviewWhere matches paper_reviews — a self-review on
          -- a citing paper inflates that paper's citation-discount weight
          -- via cpq.review_quality (consumed in citation_scores), ultimately
          -- boosting the cited author's reputation through a self-vouched
          -- citation.
          SELECT up2.permlink, up2.author,
            AVG(
              ((c2.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
               (c2.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
            ) / 5.0 AS quality
          FROM ${T.comments} up2
          JOIN ${T.comments} c2
            ON c2.parent_author = up2.author AND c2.parent_permlink = up2.permlink
            AND ${validReviewWhere({ commentAlias: 'c2', appTagParam: '$3' })}
            AND ${excludeSelfReviewWhere({ commentAlias: 'c2', paperRowAlias: 'up2', appTagParam: '$3' })}
            -- Accreditation gate ($2 = accredited, $18 = anon). Without
            -- it, an unaccredited reviewer on a citing paper inflates
            -- cpr.quality -> cpq.review_quality -> multiplies into
            -- citation_scores weighted_upvotes term -> boosts the cited
            -- author reputation for free.
            AND (c2.author = ANY($2::text[]) OR c2.author = $18)
          WHERE (up2.author, up2.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
          GROUP BY up2.permlink, up2.author
        ) cpr ON cpr.author = cp.citing_author AND cpr.permlink = cp.citing_permlink
        LEFT JOIN citing_latest_votes clv
          ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
        LEFT JOIN voter_weights vw ON vw.voter = clv.voter
        GROUP BY cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
      ),

      citation_scores AS (
        SELECT cpq.cited_author AS author,
          LEAST(w.citation_max, COALESCE(SUM(
            GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
            * CASE WHEN cpq.is_self THEN w.self_citation_discount ELSE w.citation END
            * ${decayMultiplierSql('cpq.citing_created')}
          ), 0)) AS score
        FROM citing_paper_quality cpq
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        GROUP BY cpq.cited_author, w.citation_max, w.self_citation_discount, w.citation,
                 w.decay_floor, w.decay_grace_months, w.decay_rate
      ),

      -- ═══ FINAL AGGREGATION ═══
      totals AS (
        SELECT
          tu.username,
          COALESCE(ps_agg.papers, 0) AS papers,
          COALESCE(rs_agg.reviews, 0) AS reviews,
          COALESCE(cs.score, 0) AS citations,
          CASE WHEN tu.username = ANY($2::text[]) THEN w.accreditation_bonus ELSE 0 END AS accreditation
        FROM target_users tu
        CROSS JOIN w
        LEFT JOIN (SELECT author, SUM(score) AS papers FROM paper_scores GROUP BY author) ps_agg
          ON ps_agg.author = tu.username
        LEFT JOIN (SELECT author, SUM(score) AS reviews FROM review_scores GROUP BY author) rs_agg
          ON rs_agg.author = tu.username
        LEFT JOIN citation_scores cs ON cs.author = tu.username
      )

      SELECT
        username,
        LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
        ROUND(papers::numeric, 1) AS papers,
        ROUND(reviews::numeric, 1) AS reviews,
        ROUND(citations::numeric, 1) AS citations,
        accreditation::numeric AS accreditation
      FROM totals
      ORDER BY username`,
      [
        usernames,                        // $1
        accreditedArr,                    // $2
        config.appTag,                    // $3
        `${config.appTag}/%`,             // $4
        JSON.stringify(prevJson),         // $5 (jsonb)
        endBlock,                         // $6
        weights.paper,                    // $7
        weights.review,                   // $8
        weights.downvote,                 // $9
        weights.citation,                 // $10
        weights.citation_max,             // $11
        weights.accreditation_bonus,      // $12
        weights.self_citation_discount,   // $13
        weights.decay_rate,               // $14
        weights.decay_floor,              // $15
        weights.decay_grace_months,       // $16
        config.hiveBridgeAccount,         // $17
        config.hiveAnonAccount || '',     // $18 (anon-proxy OR-arm; empty
                                          //  string is a safe sentinel —
                                          //  Hive prohibits empty author
                                          //  names so `c.author = ''`
                                          //  never matches)
        config.appTag,                    // $19 (active_accreditations custom_id)
        config.accreditationAuthorities,  // $20 (required_posting_auths ?| authority gate)
        // $21+: shared authorshipClaimsCteBody allocation (appTag, bridge,
        // claimers[], admin, internal chain backbone appTag + bridge), then
        // the Route-2 consentChainCteBody (appTag, bridge) and
        // consentedAuthorsCteBody (appTag, bridge, admin, signers[])
        // allocations — see the claimsCte / chainCte / consentedCte captures
        // above. Spread order MUST match the capture order since each
        // fragment numbers its placeholders from the previous nextIdx.
        ...claimsCte.params,
        ...chainCte.params,
        ...consentedCte.params,
      ],
    );

    for (const row of result.rows) {
      results.set(row.username, {
        score: Number(row.score),
        breakdown: {
          papers: Number(row.papers),
          reviews: Number(row.reviews),
          citations: Number(row.citations),
          accreditation: Number(row.accreditation),
        },
      });
    }

    return results;
  } catch (err) {
    // Re-throw, do NOT return a partial map. This is a single batch query for
    // every user at once (no per-user loop), so there is no partial success to
    // salvage. Swallowing the error returned an empty map that the batch
    // orchestrator could not distinguish from a legitimately empty cycle: it
    // advanced cycle:last and wiped the next cycle's voter weights on any HAF
    // transient. The outer try/catch in runBatchComputation handles the throw
    // by bailing without advancing the cycle.
    logger.error({ err }, 'Batch SQL reputation computation failed');
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────

const ZERO_SCORE: ReputationScore = {
  score: 0,
  breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 },
};

/**
 * Read a single user's reputation from the batch map. Single Redis GET, no
 * HAF queries, no on-demand SQL — every reader resolves to the same
 * `${appTag}:reputation:batch:${user}` value. Returns the zero score for
 * users with no batch entry (consistent with the Standard: non-accredited
 * users have score 0).
 */
export async function getReputationScore(username: string): Promise<ReputationScore> {
  const redis = getRedis();
  if (!redis) return ZERO_SCORE;
  try {
    const raw = await redis.get(batchKey(username));
    return parseBatchValue(raw) ?? ZERO_SCORE;
  } catch (err) {
    logger.warn({ err, username }, 'Failed to read batch reputation');
    return ZERO_SCORE;
  }
}

/**
 * Read multiple users' reputations from the batch map in a single MGET.
 * Returns a score-only map; users with no batch entry are absent (callers
 * already handle `undefined` via `?? 0`).
 */
export async function getReputationScores(usernames: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(usernames)];
  const result = new Map<string, number>();
  if (unique.length === 0) return result;

  const redis = getRedis();
  if (!redis) return result;

  try {
    const keys = unique.map(batchKey);
    const values = await redis.mget(keys);
    for (let i = 0; i < unique.length; i++) {
      const parsed = parseBatchValue(values[i]);
      if (parsed) result.set(unique[i], parsed.score);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to MGET batch reputation');
  }
  return result;
}
