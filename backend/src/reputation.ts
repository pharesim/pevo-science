/**
 * Reputation computation module.
 *
 * All reputation is computed via the canonical SQL query against HAF.
 * Voter weighting, decay, and vote resolution live entirely in SQL.
 */
import pg from 'pg';
import { getPool } from './db.js';
import { config } from './config.js';
import { getAllAccreditedAccounts } from './accreditation.js';
import { hafCache } from './cache.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';
import { DEFAULT_REPUTATION_WEIGHTS, type ReputationWeights, type ReputationScore } from './types/index.js';
import { T, getCachedGenesisBlock, validPevoPaperWhere, validReviewWhere, excludeSelfReviewWhere } from './hafsql.js';

// ─── Batch key helpers ──────────────────────────────────────────

/** Redis key namespace for cycle-computed reputation scores. */
export const BATCH_KEY_PREFIX = `${config.appTag}:reputation:batch:`;

/**
 * Sub-namespace under BATCH_KEY_PREFIX where the batch writer stages the next
 * cycle's values before the atomic Lua swap. Exported so the reader filter
 * in `getBatchReputationMap` and the writer paths in `reputation-batch.ts`
 * reference a single source of truth — a future change to the staging
 * segment cannot leave one side referencing the old prefix while the other
 * uses the new one (BACKEND-REPUTATION-SSOT round-2 hold #7).
 */
export const STAGING_SEGMENT = 'staging:';
export const REDIS_KEY_STAGING_PREFIX = `${BATCH_KEY_PREFIX}${STAGING_SEGMENT}`;

export function batchKey(username: string): string {
  return `${BATCH_KEY_PREFIX}${username}`;
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
 * Per BACKEND-REPUTATION-SSOT round-1 hold #6.
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
 * BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS: re-throws on permanent
 * (operator-actionable) errors so the orcid post-broadcast cascade wrap
 * surfaces 502 POST_BROADCAST_FAILED with `failed_step:'reputation_seed'`.
 * Transient errors (Redis-side blips, transient HAF query failures) stay
 * swallowed because the next batch cycle re-derives the score from chain
 * state regardless. Permanent errors are programmer-error class
 * which signal a data-shape regression in `getReputationWeights()` output
 * that the next cycle will NOT self-heal — operator must investigate the
 * upstream weights data.
 *
 * Currently only `TypeError` is reachable from the seed try-block in
 * production: there is no `JSON.parse` on input and no array allocation.
 * `SyntaxError` and `RangeError` are pre-wired anticipatorily (round-1
 * hold #27 — tests synthesize them via mocks and the discrimination
 * surface is the canonical "permanent programmer-error class" set so the
 * BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS convention can grow
 * without the next cascade-fn author re-deriving the membership question).
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
    await redis.set(batchKey(username), JSON.stringify(provisional), 'NX');
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
    const pipeline = redis.pipeline();
    for (const username of accredited) {
      pipeline.set(batchKey(username), value, 'NX');
    }
    await pipeline.exec();
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
    const allKeys = await redis.keys(`${BATCH_KEY_PREFIX}*`);
    const prodKeys = allKeys.filter((k) => !k.startsWith(REDIS_KEY_STAGING_PREFIX));
    if (prodKeys.length === 0) return map;

    const values = await redis.mget(prodKeys);
    for (let i = 0; i < prodKeys.length; i++) {
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

async function loadReputationWeights(): Promise<ReputationWeights> {
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
         AND cj.block_num >= $2
       LIMIT 1`,
      [config.appTag, getCachedGenesisBlock()],
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
         AND cj.block_num >= $2
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [config.appTag, getCachedGenesisBlock()],
    );
    await client.query('COMMIT');
    client.release();

    if (result.rows.length === 0) return DEFAULT_REPUTATION_WEIGHTS;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    return { ...DEFAULT_REPUTATION_WEIGHTS, ...payload.weights };
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

// ─── SQL Reputation Computation ───────────────────────────────

/**
 * Compute reputation for multiple users in a single SQL query.
 * Shared CTEs (voter_weights, active_authors, etc.) run once.
 *
 * Parameters: $1 = target usernames, $2 = accredited, $3 = app_tag,
 * $4 = app_like, $5 = prev scores jsonb, $6 = cycle_end_block,
 * $7 = genesis block, $8-$17 = weights (cast once in `w` CTE),
 * $18 = config.hiveBridgeAccount (for validPevoPaperWhere bridge-author pin),
 * $19 = config.hiveAnonAccount (for review-class anon-proxy OR-arm at
 *       the FOUR review CTEs that compose `validReviewWhere` —
 *       `active_authors` review arm, `paper_reviews`, `user_reviews`,
 *       and `citing_paper_quality`'s inner subquery; mirrors the
 *       display-side accreditation-or-anon shape composed at
 *       profile.ts / reviews.ts).
 *
 * The same FOUR review CTEs also compose `excludeSelfReviewWhere` so
 * paper-authors and named co-authors reviewing their own paper are
 * filtered before contributing to active_authors (voter_weight curve),
 * paper_reviews.quality (paper_scores multiplier), user_reviews
 * (reviewer's own breakdown), and citing_paper_quality (citation
 * discount). Per-site rationale lives at the CTEs.
 */
export async function computeReputationBatch(
  usernames: string[],
  prevScores?: Record<string, number>,
  cycleEndBlock?: number,
): Promise<Map<string, ReputationScore>> {
  const results = new Map<string, ReputationScore>();
  if (usernames.length === 0) return results;

  const pool = getPool();
  if (!pool) return results;

  try {
    const [accreditedAccounts, weights] = await Promise.all([
      getAllAccreditedAccounts(),
      getReputationWeights(),
    ]);

    const accreditedArr = [...accreditedAccounts];

    let endBlock = cycleEndBlock;
    if (!endBlock) {
      const headResult = await pool.query(`SELECT MAX(block_num) AS head FROM ${T.blocks}`, []);
      endBlock = Number(headResult.rows[0]?.head ?? 0);
      if (endBlock === 0) return results;
    }

    const prevJson = prevScores ?? batchMapToScoreRecord(await getBatchReputationMap());

    const result = await pool.query(
      `WITH

      -- Cast weight parameters once
      w AS (SELECT
        $8::numeric  AS paper,
        $9::numeric  AS review,
        $10::numeric AS downvote,
        $11::numeric AS citation,
        $12::numeric AS citation_max,
        $13::numeric AS accreditation_bonus,
        $14::numeric AS self_citation_discount,
        $15::numeric AS decay_rate,
        $16::numeric AS decay_floor,
        $17::numeric AS decay_grace_months
      ),

      target_users AS (
        SELECT unnest AS username FROM unnest($1::text[])
      ),

      cycle_ref AS (
        SELECT b.timestamp AS ref_ts
        FROM ${T.blocks} b
        WHERE b.block_num = $6 - 1
      ),

      prev_scores AS (
        SELECT key AS username, value::numeric AS rep
        FROM jsonb_each_text($5)
      ),

      active_authors AS (
        SELECT DISTINCT author FROM (
          SELECT c.author FROM ${T.comments} c
          WHERE c.parent_author = '' AND c.parent_permlink = $3
            AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$18', source: 'all' })}
            AND c.json_metadata ->> 'app' LIKE $4
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
            AND ${validPevoPaperWhere({ commentAlias: 'p', appTagParam: '$3', bridgeAccountParam: '$18', source: 'all' })}
            AND p.json_metadata ->> 'app' LIKE $4
            AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
            AND ${excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: '$3' })}
            AND (c.author = ANY($2::text[]) OR c.author = $19)
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

      -- ═══ AUTHORSHIP CLAIMS (for co-author credit) ═══
      claim_events AS (
        SELECT
          cj.json::jsonb ->> 'action' AS action,
          COALESCE(cj.json::jsonb ->> 'claimer', cj.required_posting_auths ->> 0) AS claimer,
          cj.json::jsonb ->> 'paper_author' AS paper_author,
          cj.json::jsonb ->> 'paper_permlink' AS paper_permlink,
          (cj.json::jsonb ->> 'author_index')::int AS author_index,
          cj.block_num
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $3
          AND cj.json::jsonb ->> 'action' IN ('claim_authorship', 'approve_authorship', 'revoke_authorship')
          AND cj.block_num >= $7
      ),
      -- Accredited user ORCIDs for auto-accept
      claimer_orcids AS (
        SELECT
          cj.json::jsonb ->> 'account' AS account,
          cj.json::jsonb ->> 'orcid' AS orcid,
          ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $3
          AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
          AND cj.block_num >= $7
      ),
      accepted_claims AS (
        SELECT DISTINCT ce.claimer, ce.paper_author, ce.paper_permlink
        FROM claim_events ce
        WHERE ce.action = 'claim_authorship'
          AND ce.claimer IN (SELECT username FROM target_users)
          AND NOT EXISTS (
            SELECT 1 FROM claim_events rv
            WHERE rv.action = 'revoke_authorship'
              AND rv.claimer = ce.claimer
              AND rv.paper_author = ce.paper_author
              AND rv.paper_permlink = ce.paper_permlink
              AND rv.block_num > ce.block_num
              AND rv.block_num > COALESCE((
                SELECT MAX(ap.block_num) FROM claim_events ap
                WHERE ap.action = 'approve_authorship'
                  AND ap.claimer = ce.claimer
                  AND ap.paper_author = ce.paper_author
                  AND ap.paper_permlink = ce.paper_permlink
              ), 0)
          )
          AND (
            -- Explicitly approved
            EXISTS (
              SELECT 1 FROM claim_events ap
              WHERE ap.action = 'approve_authorship'
                AND ap.claimer = ce.claimer
                AND ap.paper_author = ce.paper_author
                AND ap.paper_permlink = ce.paper_permlink
                AND ap.block_num > ce.block_num
            )
            -- Auto-accept: ORCID match
            OR (ce.author_index IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${T.comments} c
              JOIN claimer_orcids co ON co.account = ce.claimer AND co.rn = 1
                AND co.orcid IS NOT NULL AND co.orcid != ''
              WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
                AND c.parent_author = ''
                AND (c.json_metadata -> $3 -> 'authors' -> ce.author_index ->> 'orcid') = co.orcid
            ))
            -- Auto-accept: hive username match. Canonicalize the
            -- broadcaster-controlled authors[i].hive via LOWER(TRIM(...))
            -- plus the Hive-account charset regex (mirrors
            -- normalizeHiveAccount and the SQL-side guard in
            -- authorsWithSupersessionSelect) before byte-equality against
            -- the chain-validated lowercase ce.claimer. An uppercase
            -- mid-case entry would otherwise leave a legitimate co-author's
            -- claim unaccepted in the reputation cycle.
            OR (ce.author_index IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${T.comments} c
              WHERE c.author = ce.paper_author AND c.permlink = ce.paper_permlink
                AND c.parent_author = ''
                AND LOWER(TRIM(c.json_metadata -> $3 -> 'authors' -> ce.author_index ->> 'hive')) ~ '^[a-z0-9.-]+$'
                AND LOWER(TRIM(c.json_metadata -> $3 -> 'authors' -> ce.author_index ->> 'hive')) = ce.claimer
            ))
          )
      ),

      -- ═══ PAPERS ═══
      user_papers AS (
        -- Papers authored by user (native only — see validPevoPaperWhere 'native' arm)
        SELECT c.author, c.permlink, c.created, c.json_metadata
        FROM ${T.comments} c
        WHERE c.author IN (SELECT username FROM target_users)
          AND c.parent_author = '' AND c.parent_permlink = $3
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$18', source: 'native' })}
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
        UNION ALL
        -- Papers claimed by user (co-author credit) — bridge_paper claims allowed
        -- but only when authored by config.hiveBridgeAccount; spoofed bridge_paper
        -- can't grant unearned co-author credit.
        SELECT ac.claimer AS author, c.permlink, c.created, c.json_metadata
        FROM accepted_claims ac
        JOIN ${T.comments} c ON c.author = ac.paper_author AND c.permlink = ac.paper_permlink
        WHERE c.parent_author = '' AND c.parent_permlink = $3
          AND ${validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$18', source: 'all' })}
          AND c.json_metadata ->> 'app' LIKE $4
          AND (c.json_metadata -> $3 -> 'continues') IS NULL
          AND ac.claimer != c.author  -- avoid double-counting
      ),

      paper_vote_signals AS (
        SELECT voter, author, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author IN (SELECT username FROM target_users)
            AND EXISTS (SELECT 1 FROM user_papers up WHERE up.author = vo.author AND up.permlink = vo.permlink)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      paper_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
        FROM paper_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
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
        -- every voter -- falling back to the plv.voter != up.author first
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
        SELECT plv.voter, plv.author, plv.permlink, plv.weight, plv.block_num
        FROM paper_latest_votes plv
        JOIN user_papers up ON up.author = plv.author AND up.permlink = plv.permlink
        WHERE plv.voter != up.author
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
              CASE WHEN jsonb_typeof(up.json_metadata -> $3 -> 'authors') = 'array'
                THEN up.json_metadata -> $3 -> 'authors'
                ELSE '[]'::jsonb
              END
            ) a
            WHERE jsonb_typeof(a) = 'object'
              AND LOWER(TRIM(a ->> 'hive')) ~ '^[a-z0-9.-]+$'
              AND LOWER(TRIM(a ->> 'hive')) = plv.voter
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
        -- the paper's vote-derived score in paper_scores at line 591.
        -- Mirrors the paper_resolved_votes self-exclusion at lines 555-560.
        -- Accreditation gate ($2 = accredited, $19 = anon) — without it,
        -- any unaccredited Hive account broadcasting a valid-shape review
        -- to a target user paper would inflate pr.quality (5/5/5/5 ->
        -- AVG/4.0/5.0 = 1.0x max multiplier on the paper vote-derived
        -- score). The helper docstring documents that callers must
        -- compose accreditation; this CTE is one of three review-class
        -- composition sites flagged by the round-1 review.
        SELECT up.author, up.permlink,
          AVG(
            ((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
             (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
          ) / 5.0 AS quality
        FROM user_papers up
        JOIN ${T.comments} c
          ON c.parent_author = up.author AND c.parent_permlink = up.permlink
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ paperRowAlias: 'up', appTagParam: '$3' })}
          AND (c.author = ANY($2::text[]) OR c.author = $19)
        GROUP BY up.author, up.permlink
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
          )) * GREATEST(w.decay_floor,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
              ELSE GREATEST(w.decay_floor,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
              )
            END
          ) AS score
        FROM user_papers up
        CROSS JOIN cycle_ref cr
        CROSS JOIN w
        LEFT JOIN paper_reviews pr ON pr.author = up.author AND pr.permlink = up.permlink
        LEFT JOIN paper_vote_agg pva ON pva.author = up.author AND pva.permlink = up.permlink
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
      --   - Accreditation gate (c.author = ANY($2::text[]) OR c.author = $19):
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
          AND ${validPevoPaperWhere({ commentAlias: 'up_for_self', appTagParam: '$3', bridgeAccountParam: '$18', source: 'all' })}
        WHERE c.author IN (SELECT username FROM target_users)
          AND ${validReviewWhere({ commentAlias: 'c', appTagParam: '$3' })}
          AND ${excludeSelfReviewWhere({ paperRowAlias: 'up_for_self', appTagParam: '$3' })}
          AND (c.author = ANY($2::text[]) OR c.author = $19)
          AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
      ),

      review_vote_signals AS (
        SELECT voter, author, permlink, weight, block_num FROM (
          SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND vo.author IN (SELECT username FROM target_users)
            AND EXISTS (SELECT 1 FROM user_reviews ur WHERE ur.author = vo.author AND ur.permlink = vo.permlink)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'author' AS author,
            cj.json::jsonb ->> 'permlink' AS permlink,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
        ) all_signals
      ),

      review_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM review_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
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
          )) * GREATEST(w.decay_floor,
            CASE
              WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
              ELSE GREATEST(w.decay_floor,
                1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
              )
            END
          ) AS score
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
          cit ->> 'author' AS cited_author,
          COALESCE((cit ->> 'reputation_relevant')::boolean, true) AS reputation_relevant
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
        SELECT voter, permlink, author, weight, block_num FROM (
          SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num
          FROM ${T.voteOps} vo
          WHERE vo.voter = ANY($2::text[])
            AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
            AND vo.block_num >= $7 AND vo.block_num < $6
          UNION ALL
          SELECT
            cj.required_posting_auths ->> 0 AS voter,
            cj.json::jsonb ->> 'permlink' AS permlink,
            cj.json::jsonb ->> 'author' AS author,
            (cj.json::jsonb ->> 'weight')::int AS weight,
            cj.block_num
          FROM ${T.customJson} cj
          WHERE cj.custom_id = $3
            AND cj.json::jsonb ->> 'action' = 'revote'
            AND cj.block_num >= $7 AND cj.block_num < $6
            AND cj.required_posting_auths ->> 0 = ANY($2::text[])
            AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
              IN (SELECT citing_author, citing_permlink FROM citing_papers)
        ) all_signals
      ),

      citing_latest_votes AS (
        SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
        FROM citing_vote_signals
        ORDER BY voter, author, permlink, block_num DESC
      ),

      citing_paper_quality AS (
        SELECT
          cp.cited_author,
          cp.citing_author,
          cp.citing_permlink,
          cp.citing_created,
          cp.citing_author = cp.cited_author AS is_self,
          COALESCE(cpr.quality, 1.0) AS review_quality,
          COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
            FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0), 0
          ) AS weighted_upvotes
        FROM citing_papers cp
        LEFT JOIN (
          -- Citing-paper review quality: mirror of paper_reviews CTE for the
          -- citation arm. validReviewWhere protects the ::numeric casts from
          -- malformed ratings at the gate (same load-bearing reason).
          -- excludeSelfReviewWhere matches paper_reviews — a self-review on
          -- a citing paper inflates that paper's citation-discount weight
          -- via cpq.review_quality at line 743, ultimately boosting the
          -- cited author's reputation through a self-vouched citation.
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
            -- Accreditation gate ($2 = accredited, $19 = anon). Without
            -- it, an unaccredited reviewer on a citing paper inflates
            -- cpr.quality -> cpq.review_quality -> multiplies into
            -- citation_scores weighted_upvotes term -> boosts the cited
            -- author reputation for free.
            AND (c2.author = ANY($2::text[]) OR c2.author = $19)
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
            * GREATEST(w.decay_floor,
                CASE
                  WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
                  ELSE GREATEST(w.decay_floor,
                    1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
                  )
                END
              )
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
        getCachedGenesisBlock(),          // $7
        weights.paper,                    // $8
        weights.review,                   // $9
        weights.downvote,                 // $10
        weights.citation,                 // $11
        weights.citation_max,             // $12
        weights.accreditation_bonus,      // $13
        weights.self_citation_discount,   // $14
        weights.decay_rate,               // $15
        weights.decay_floor,              // $16
        weights.decay_grace_months,       // $17
        config.hiveBridgeAccount,         // $18
        config.hiveAnonAccount || '',     // $19 (anon-proxy OR-arm; empty
                                          //  string is a safe sentinel —
                                          //  Hive prohibits empty author
                                          //  names so `c.author = ''`
                                          //  never matches)
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
    logger.error({ err }, 'Batch SQL reputation computation failed');
    return results;
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
