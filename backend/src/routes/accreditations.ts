import { Router, type Request, type Response } from 'express';
import { getPool, isHafConfigured } from '../db.js';
import { sendOk, sendError } from '../response.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { buildWith, activeAccreditationsCteBody, firstAccreditedAnchorCteBody } from '../hafsql.js';
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
    // The accredited directory is the membership set: composes the shared
    // `activeAccreditationsCteBody` so a sanctioned, below-threshold-WoT, or
    // legacy-revoked account is excluded/included per the live membership rule
    // (not the old "latest op is an accredit" approximation).
    //
    // `field` and `institution` arrive here already LIKE-metacharacter-escaped
    // via validateOptionalLikeFilter at route entry. The bound pattern is
    // `${escaped}%` — the trailing `%` is the deliberate prefix-match
    // wildcard; any user-supplied `%` / `_` / `\` appears in `escaped` as
    // `\%` / `\_` / `\\` and is treated as a literal character under the
    // `ESCAPE '\\'` clause on the ILIKE site below. Without that clause,
    // `_%_%_…` would inject N live wildcards and force Postgres to backtrack
    // against every accredited-account row.
    const cte = buildWith(1, activeAccreditationsCteBody, firstAccreditedAnchorCteBody);
    const conditions: string[] = [];
    const params: unknown[] = [...cte.params];
    let paramIdx = cte.nextIdx;

    if (field) {
      conditions.push(`aa.field ILIKE $${paramIdx++} ESCAPE '\\'`);
      params.push(`${field}%`);
    }
    if (institution) {
      conditions.push(`aa.institution ILIKE $${paramIdx++} ESCAPE '\\'`);
      params.push(`${institution}%`);
    }

    const filterConditions = conditions.map((c) => `AND ${c}`).join(' ');

    const dataResult = await pool.query(`
      ${cte.sql}
      SELECT aa.account AS username, aa.researcher_name AS name, aa.institution, aa.field, aa.method, aa.orcid,
        aa.event_timestamp AS timestamp,
        fa.accredited_since,
        count(*) OVER ()::int AS total
      FROM active_accreditations AS aa
      LEFT JOIN first_accredited_at fa ON fa.account = aa.account
      WHERE TRUE
      ${filterConditions}
      -- Sort stays on the latest-op payload timestamp (event_timestamp); the
      -- tenure anchor "accredited_since" is additive and does NOT drive the sort.
      ORDER BY aa.event_timestamp DESC
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
    // is_accredited is the live membership decision: composing
    // `activeAccreditationsCteBody` means a sanctioned, below-threshold-WoT, or
    // legacy-revoked account resolves to NOT accredited / accredited per the
    // membership rule, not the old "latest op is a revoke" check. The row, when
    // present, carries the latest accredit op's metadata.
    // Single-account read: scope the anchor CTE to this account (avoids the
    // all-accounts MIN(block_num) GROUP BY on a hot per-account read path).
    const cte = buildWith(1, activeAccreditationsCteBody, (idx) => firstAccreditedAnchorCteBody(idx, username));
    const userParam = `$${cte.nextIdx}`;
    const result = await pool.query(
      `${cte.sql}
       SELECT aa.researcher_name, aa.institution, aa.field, aa.method, aa.orcid, aa.event_timestamp, aa.event_id,
              fa.accredited_since
       FROM active_accreditations aa
       LEFT JOIN first_accredited_at fa ON fa.account = aa.account
       WHERE aa.account = ${userParam}`,
      [...cte.params, username],
    );

    if (result.rows.length === 0) {
      return { username, is_accredited: false, accreditation: null };
    }

    const row = result.rows[0];
    return {
      username,
      is_accredited: true,
      accreditation: {
        name: row.researcher_name,
        institution: row.institution,
        field: row.field,
        method: row.method,
        orcid: row.orcid ?? null,
        // Latest-op payload timestamp (moves on a metadata-edit re-broadcast).
        timestamp: row.event_timestamp,
        // Tenure anchor: chain block time of the EARLIEST accredit op, spanning
        // sanction gaps and stable across edits. Clients render this for "since".
        accredited_since: row.accredited_since ?? null,
        tx_id: row.event_id?.toString() ?? null,
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
