import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { config } from '../config.js';
import { sendOk } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T, getCachedGenesisBlock } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/accreditations — list accredited researchers
// ──────────────────────────────────────────────

async function fetchAccreditationsFromHaf(
  limit: number,
  offset: number,
  field?: string,
  institution?: string,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // $1 is always appTag
    const conditions: string[] = [];
    const params: unknown[] = [config.appTag];
    let paramIdx = 2;

    if (field) {
      conditions.push(`latest.field ILIKE $${paramIdx++}`);
      params.push(`${field}%`);
    }
    if (institution) {
      conditions.push(`latest.institution ILIKE $${paramIdx++}`);
      params.push(`${institution}%`);
    }

    const filterConditions = conditions.map((c) => `AND ${c}`).join(' ');

    // $paramIdx for accreditationAuthorities, then genesis block, limit, offset
    const authIdx = paramIdx++;
    params.push(config.accreditationAuthorities);

    const dataResult = await pool.query(`
      WITH ranked AS (
        SELECT
          cj.json::jsonb ->> 'action' AS action,
          cj.json::jsonb ->> 'account' AS account,
          cj.json::jsonb ->> 'name' AS name,
          cj.json::jsonb ->> 'institution' AS institution,
          cj.json::jsonb ->> 'field' AS field,
          cj.json::jsonb ->> 'method' AS method,
          cj.json::jsonb ->> 'orcid' AS orcid,
          cj.json::jsonb ->> 'timestamp' AS timestamp,
          ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC) AS rn
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $1
          AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
          AND cj.required_posting_auths ?| $${authIdx}::text[]
          AND cj.block_num >= $${paramIdx++}
      )
      SELECT account AS username, name, institution, field, method, orcid, timestamp,
        count(*) OVER ()::int AS total
      FROM ranked AS latest
      WHERE rn = 1 AND action = 'accredit'
      ${filterConditions}
      ORDER BY timestamp DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, getCachedGenesisBlock(), limit, offset],
    );

    const total = dataResult.rows[0]?.total ?? 0;
    const rows = dataResult.rows.map(({ total: _t, ...rest }) => rest);

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF accreditations query failed');
    return null;
  }
}

router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const offset = (page - 1) * limit;
  const field = req.query.field as string | undefined;
  const institution = req.query.institution as string | undefined;

  if (isHafAvailable()) {
    const cacheKey = `accreditations:${JSON.stringify({ field, institution, page, limit })}`;
    const result = await hafCache.getOrSet(cacheKey, () => fetchAccreditationsFromHaf(limit, offset, field, institution), 60_000);
    if (result) return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  // HAF unavailable — return empty
  sendOk(res, [], { page, limit, total: 0 });
});

// ──────────────────────────────────────────────
// GET /api/accreditations/:username
// ──────────────────────────────────────────────

async function fetchAccreditationStatusFromHaf(username: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      `SELECT cj.json, cj.id AS event_id FROM ${T.customJson} cj
       WHERE cj.custom_id = $2
         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
         AND cj.required_posting_auths ?| $4::text[]
         AND cj.json::jsonb ->> 'account' = $1
         AND cj.block_num >= $3
       ORDER BY cj.block_num DESC
       LIMIT 1`,
      [username, config.appTag, getCachedGenesisBlock(), config.accreditationAuthorities],
    );

    if (result.rows.length === 0) {
      return { username, is_accredited: false, accreditation: null };
    }

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    if (payload.action === 'revoke') {
      return { username, is_accredited: false, accreditation: null };
    }

    return {
      username,
      is_accredited: true,
      accreditation: {
        name: payload.name,
        institution: payload.institution,
        field: payload.field,
        method: payload.method,
        orcid: payload.orcid ?? null,
        timestamp: payload.timestamp,
        tx_id: result.rows[0].event_id?.toString() ?? null,
      },
    };
  } catch (err) {
    logger.error({ err }, 'HAF accreditation status query failed');
    return null;
  }
}

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (isHafAvailable()) {
    const cacheKey = `accreditation-status:${username}`;
    const result = await hafCache.getOrSet(cacheKey, () => fetchAccreditationStatusFromHaf(username), 60_000);
    if (result) return sendOk(res, result);
  }

  // Without HAF, we can't query custom_json history
  sendOk(res, { username, is_accredited: false, accreditation: null });
});

export default router;
