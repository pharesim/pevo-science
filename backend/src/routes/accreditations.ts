import { Router, type Request, type Response } from 'express';
import { getPool, isHafConfigured } from '../db.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { T } from '../hafsql.js';
import { validateOptionalLikeFilter } from '../types/search-filters.js';

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
    // $1 is always appTag.
    //
    // `field` and `institution` arrive here already LIKE-metacharacter-escaped
    // via validateOptionalLikeFilter at route entry. The bound pattern is
    // `${escaped}%` — the trailing `%` is the deliberate prefix-match
    // wildcard; any user-supplied `%` / `_` / `\` appears in `escaped` as
    // `\%` / `\_` / `\\` and is treated as a literal character under the
    // `ESCAPE '\\'` clause on the ILIKE site below. Without that clause,
    // `_%_%_…` would inject N live wildcards and force Postgres to backtrack
    // against every accredited-account row.
    const conditions: string[] = [];
    const params: unknown[] = [config.appTag];
    let paramIdx = 2;

    if (field) {
      conditions.push(`latest.field ILIKE $${paramIdx++} ESCAPE '\\'`);
      params.push(`${field}%`);
    }
    if (institution) {
      conditions.push(`latest.institution ILIKE $${paramIdx++} ESCAPE '\\'`);
      params.push(`${institution}%`);
    }

    const filterConditions = conditions.map((c) => `AND ${c}`).join(' ');

    // $paramIdx for accreditationAuthorities, then limit, offset
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
          -- Same-block tie-breaker: cj.id (operation_custom_json_view has no
          -- trx_in_block; cj.id is the monotonic HAF op id) per
          -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
          ROW_NUMBER() OVER (PARTITION BY cj.json::jsonb ->> 'account' ORDER BY cj.block_num DESC, cj.id DESC) AS rn
        FROM ${T.customJson} cj
        WHERE cj.custom_id = $1
          AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
          AND cj.required_posting_auths ?| $${authIdx}::text[]
      )
      SELECT account AS username, name, institution, field, method, orcid, timestamp,
        count(*) OVER ()::int AS total
      FROM ranked AS latest
      WHERE rn = 1 AND action = 'accredit'
      ${filterConditions}
      ORDER BY timestamp DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const total = dataResult.rows[0]?.total ?? 0;
    const rows = dataResult.rows.map(({ total: _t, ...rest }) => rest);

    return { rows, total };
  } catch (err) {
    // Intentional swallow-to-null: listing contract serves [] on outage;
    // outage indistinguishable from "no accreditations on this filter"
    // is the accepted cost for listings. Route maps null → 200 [] at the
    // envelope layer (GET `/`).
    logger.error({ err }, 'HAF accreditations query failed');
    return null;
  }
}

router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
  const offset = (page - 1) * limit;

  // Length-cap + LIKE-metacharacter escape for the optional `?field=` /
  // `?institution=` filters. See validateOptionalLikeFilter for the contract.
  const fieldResult = validateOptionalLikeFilter(req.query.field, 'field');
  if (!fieldResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', fieldResult.message);
  }
  const institutionResult = validateOptionalLikeFilter(req.query.institution, 'institution');
  if (!institutionResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', institutionResult.message);
  }
  const field = fieldResult.value;
  const institution = institutionResult.value;

  if (isHafConfigured()) {
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
         AND cj.required_posting_auths ?| $3::text[]
         AND cj.json::jsonb ->> 'account' = $1
       -- Same-block tie-breaker: cj.id (operation_custom_json_view has no
       -- trx_in_block; cj.id is the monotonic HAF op id) per
       -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
       ORDER BY cj.block_num DESC, cj.id DESC
       LIMIT 1`,
      [username, config.appTag, config.accreditationAuthorities],
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
    // Intentional swallow-to-null: single-account status cosmetically
    // collapses outage to "not accredited" (route returns
    // `is_accredited: false`). Same accepted-cost pattern as
    // `profile.ts:getAccreditationFromHaf`; translating to 503 retriable
    // would surface an outage banner on every profile load during a HAF
    // blip even for unaccredited browsers.
    logger.error({ err }, 'HAF accreditation status query failed');
    return null;
  }
}

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (isHafConfigured()) {
    const cacheKey = `accreditation-status:${username}`;
    const result = await hafCache.getOrSet(cacheKey, () => fetchAccreditationStatusFromHaf(username), 60_000);
    if (result) return sendOk(res, result);
  }

  // Without HAF, we can't query custom_json history
  sendOk(res, { username, is_accredited: false, accreditation: null });
});

export default router;
