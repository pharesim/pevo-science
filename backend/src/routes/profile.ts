import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool, HafQueryError, isRetriableHafError } from '../db.js';
import { hiveClient } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, parsePageLimit, parseOrder, toPaperSummary } from '../helpers.js';
import { normalizeHiveAccount } from '../lib/author-supersession.js';
import { getAccreditedSet, getAllAccreditedAccounts, getAccreditedOrcidsByAccount, getAccreditedNamesByAccount, getAllEverAccreditedOrcidsWithStatus } from '../accreditation.js';
import { resolveChainCumulativeAuthors, type ChainCumulativeAuthorsResult } from './papers.js';
import { getReputationScore, getReputationScores } from '../reputation.js';
import { logger } from '../logger.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate } from '../validation.js';
import { getLastBlock } from '../block-watcher.js';
import { getAppPool } from '../app-db.js';
import { hafCache } from '../cache.js';
import { T, validReviewWhere, validPevoPaperWhere, excludeSelfReviewWhere, excludeClaimedSelfWhere, excludeConsentedSelfWhere, buildRecursiveWith, activeAccreditationsCteBody, authorshipClaimsCteBody, consentSeedCteBody, consentChainCteBody, consentedAuthorsCteBody } from '../hafsql.js';

const router = Router();

// ──────────────────────────────────────────────
// Helpers — accreditation lookup
// ──────────────────────────────────────────────

async function getAccreditationFromHaf(username: string) {
  const pool = getPool();
  if (!pool) return undefined; // no HAF available

  try {
    // Filter by accreditationAuthorities so a self-broadcast custom_json (signed
    // by the target account's own posting key) cannot masquerade as a real
    // accreditation and paint attacker-chosen metadata onto someone's profile.
    // See SEC-AUTH-BYPASS. Mirrors the same filter in accreditations.ts and
    // orcid.ts's getExistingAccreditation.
    // `cj.id DESC` is the same-block deterministic tie-breaker (monotonic HAF op
    // id) per the custom-json hive-primitive design-rules convention, so a
    // same-block accredit/revoke resolves to the later op.
    const result = await pool.query(
      `SELECT cj.json, cj.id AS event_id FROM ${T.customJson} cj
       WHERE cj.custom_id = $2
         AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
         AND cj.required_posting_auths ?| $3::text[]
         AND cj.json::jsonb ->> 'account' = $1
       ORDER BY cj.block_num DESC, cj.id DESC
       LIMIT 1`,
      [username, config.appTag, config.accreditationAuthorities],
    );
    if (result.rows.length === 0) return null;

    const payload = typeof result.rows[0].json === 'string'
      ? JSON.parse(result.rows[0].json)
      : result.rows[0].json;

    if (payload.action === 'revoke') return null;
    return {
      name: payload.name,
      institution: payload.institution,
      field: payload.field,
      method: payload.method,
      orcid: payload.orcid || null,
      timestamp: payload.timestamp,
      tx_id: result.rows[0].event_id?.toString() ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'HAF accreditation query failed');
    return undefined;
  }
}

async function getAccreditation(username: string) {
  const result = await getAccreditationFromHaf(username);
  if (result !== undefined) return result;
  return null;
}

// ──────────────────────────────────────────────
// Helpers — profile stats (lightweight counts)
// ──────────────────────────────────────────────

async function getProfileStats(username: string) {
  const pool = getPool();
  if (!pool) return { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null };

  try {
    // Cross-surface parity: the user_reviews CTE must compose the same gate
    // set as the reputation cycle's user_reviews CTE (reputation.ts) AND the
    // listing display surface (`fetchUserReviewsFromHaf`). Pre-fix, this
    // stats CTE lacked BOTH the accreditation gate (admitting unaccredited
    // spam) AND validPevoPaperWhere on the parent paper (admitting
    // review-shaped replies to non-paper Hive posts). Reputation already
    // composes both; this site closes the parity gap on the actively-visible
    // `/api/profile/:user` stats surface where `review_count` was diverging
    // from the listing's `meta.total`. See
    // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`.
    //
    // Param-shape: canonical paramIdx++ counter pattern (per
    // `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`).
    // Offset arithmetic silently mis-binds if any bind is added/removed; the
    // counter adapts. Adopted across the sibling `routes/reviews.ts` SQL
    // builders too — the counter-based shape is the project-wide convention
    // for chained `activeAccreditationsCteBody(N)` consumers.
    // authorship_claims scoped to this profile user so excludeClaimedSelfWhere can
    // drop their self-review of a claimed paper from the review_count stat; the
    // consent stack scoped the same way ({signer}-seeded walk + {signers}-narrowed
    // resolution) so excludeConsentedSelfWhere drops a Route-2 consented
    // co-author's self-review too.
    const accredCte = buildRecursiveWith(
      1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { claimer: username }),
      (idx) => consentSeedCteBody(idx, { signer: username }),
      (idx) => consentChainCteBody(idx, { rootsFromCte: 'consent_seed' }),
      (idx) => consentedAuthorsCteBody(idx, { signers: [username] }),
    );
    let paramIdx = accredCte.nextIdx;
    const usernameIdx = paramIdx++;
    const appTagIdx = paramIdx++;
    const appPrefixIdx = paramIdx++;
    const anonIdx = paramIdx++;
    const bridgeIdx = paramIdx++;

    const at = `$${appTagIdx}`;
    const bridgeParam = `$${bridgeIdx}`;
    const reviewWhere = validReviewWhere({ commentAlias: 'c', appTagParam: at });
    const paperGate = validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' });
    const selfExclude = excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: at });
    const claimedExclude = excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' });
    const consentedExclude = excludeConsentedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' });
    const accredGate = `(c.author IN (SELECT account FROM active_accreditations) OR c.author = $${anonIdx})`;

    const result = await pool.query(
      `${accredCte.sql},
       user_papers AS (
         SELECT c.created
         FROM ${T.comments} c
         WHERE c.author = $${usernameIdx}
           AND c.parent_author = '' AND c.parent_permlink = ${at}
           AND (c.json_metadata -> ${at} ->> 'type') = 'paper'
           AND c.json_metadata ->> 'app' LIKE $${appPrefixIdx}
           AND (c.json_metadata -> ${at} -> 'continues') IS NULL
       ),
       user_reviews AS (
         SELECT 1
         FROM ${T.comments} c
         JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
         WHERE c.author = $${usernameIdx}
           AND ${accredGate}
           AND ${reviewWhere}
           AND ${paperGate}
           AND ${selfExclude}
           AND ${claimedExclude}
           AND ${consentedExclude}
           AND COALESCE(c.json_metadata -> ${at} ->> 'is_anonymous', 'false') != 'true'
       ),
       citations AS (
         -- CASE-WHEN array-guard at SRF argument position. The previous shape
         -- had a WHERE-clause jsonb_typeof = array guard AFTER the LATERAL --
         -- that fires too late: Postgres expands the LATERAL SRF BEFORE the
         -- WHERE filter, so a chain post broadcasting non-array pevo.citations
         -- (null, string, integer, object) would have crashed the per-user
         -- profile fetch with cannot extract elements from a scalar. The
         -- CASE-WHEN absorbs the non-array case to []::jsonb at the argument
         -- site so jsonb_array_elements never sees a scalar. See
         -- agents/docs/solutions/conventions/
         -- pg-cross-join-lateral-where-guard-fires-after-srf-2026-05-16.md.
         SELECT 1
         FROM ${T.comments} citing
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(citing.json_metadata -> ${at} -> 'citations') = 'array'
             THEN citing.json_metadata -> ${at} -> 'citations'
             ELSE '[]'::jsonb
           END
         ) AS cit
         WHERE citing.parent_author = '' AND citing.parent_permlink = ${at}
           AND (citing.json_metadata -> ${at} ->> 'type') = 'paper'
           AND citing.json_metadata ->> 'app' LIKE $${appPrefixIdx}
           AND (cit ->> 'author') = $${usernameIdx}
       )
       SELECT
         (SELECT COUNT(*) FROM user_papers) AS paper_count,
         (SELECT MIN(created) FROM user_papers) AS first_pevo_post,
         (SELECT COUNT(*) FROM user_reviews) AS review_count,
         (SELECT COUNT(*) FROM citations) AS citation_count`,
      [
        ...accredCte.params,                  // active_accreditations + authorship_claims CTE params
        username,                             // $usernameIdx
        config.appTag,                        // $appTagIdx
        `${config.appTag}/%`,                 // $appPrefixIdx
        config.hiveAnonAccount || '',         // $anonIdx
        config.hiveBridgeAccount || '',       // $bridgeIdx
      ],
    );

    const row = result.rows[0];
    return {
      paper_count: Number(row?.paper_count ?? 0),
      review_count: Number(row?.review_count ?? 0),
      citation_count: Number(row?.citation_count ?? 0),
      first_pevo_post: row?.first_pevo_post ?? null,
    };
  } catch (err) {
    logger.warn({ err }, 'Profile stats query failed');
    return { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null };
  }
}

// ──────────────────────────────────────────────
// GET /api/profile/:username
// ──────────────────────────────────────────────

router.get('/:username', async (req: Request, res: Response) => {
  const username = req.params.username as string;

  const data = await hafCache.getOrSet(`profile:${username}`, async () => {
    // Check account existence and accreditation first
    const [accountResult, accreditation] = await Promise.all([
      hiveClient.database.getAccounts([username]),
      getAccreditation(username),
    ]);

    const [account] = accountResult;
    if (!account) return null;

    const isAccredited = !!accreditation;

    // Non-accredited: return immediately with zeroed stats, skip expensive HAF/reputation queries
    if (!isAccredited) {
      return {
        username,
        is_accredited: false,
        accreditation: null,
        reputation: { score: 0, breakdown: { papers: 0, reviews: 0, citations: 0, accreditation: 0 } },
        stats: { paper_count: 0, review_count: 0, citation_count: 0, first_pevo_post: null },
      };
    }

    // Accredited: reputation (SQL, cached) + lightweight stats in parallel
    const [reputation, profileStats] = await Promise.all([
      getReputationScore(username),
      getProfileStats(username),
    ]);

    return {
      username,
      is_accredited: true,
      accreditation: accreditation || null,
      reputation,
      stats: profileStats,
    };
  }, 5 * 60_000, true);

  if (data === null) {
    return sendError(res, 404, 'NOT_FOUND', `Hive account @${username} does not exist`);
  }

  sendOk(res, data);
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/papers
// ──────────────────────────────────────────────

async function fetchUserPapersFromHaf(
  username: string,
  limit: number,
  offset: number,
  sortCol: string,
  order: string,
  orcidMap: Map<string, string | null>,
  nameMap: Map<string, string>,
) {
  const pool = getPool();
  if (!pool) return null;

  // Loud-fail on HAF query failure (mirrors the contract on
  // `fetchPaperDetailFromHaf` in `routes/papers.ts`): the route layer
  // translates `HafQueryError` to 503 SERVICE_UNAVAILABLE with
  // `details.retriable: true`, distinguishing transient outage from the
  // legitimate "no papers for this user" empty-result case. Pre-fix, this
  // helper logged and returned `null`, collapsing the route response to a
  // 200 with empty rows for both shapes — clients had no signal to retry.
  try {
    // Build CTEs for authorship claims to include claimed papers
    const cte = buildRecursiveWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { claimer: username }));

    // Base filter for PEvO papers (non-continuation)
    const paperFilter = `parent_author = '' AND parent_permlink = $${cte.nextIdx}
         AND (json_metadata -> $${cte.nextIdx} ->> 'type') = 'paper'
         AND json_metadata ->> 'app' LIKE $${cte.nextIdx + 1}
         AND (json_metadata -> $${cte.nextIdx} -> 'continues') IS NULL`;

    // UNION: papers authored by user + papers with accepted claims by user
    const unionSql = `${cte.sql},
      user_papers AS (
        SELECT DISTINCT c.author, c.permlink, c.title, LEFT(c.body, 300) AS body,
               c.json_metadata, c.created, c.total_rshares
        FROM ${T.comments} c
        WHERE c.author = $${cte.nextIdx + 2} AND ${paperFilter}
        UNION
        SELECT DISTINCT c.author, c.permlink, c.title, LEFT(c.body, 300) AS body,
               c.json_metadata, c.created, c.total_rshares
        FROM authorship_claims ac
        JOIN ${T.comments} c ON c.author = ac.paper_author AND c.permlink = ac.paper_permlink
        WHERE ac.claimer = $${cte.nextIdx + 2} AND ac.status = 'accepted'
          AND ${paperFilter}
      )`;

    const baseParams = [...cte.params, config.appTag, `${config.appTag}/%`, username];

    const countResult = await pool.query(
      `${unionSql} SELECT count(*)::int AS total FROM user_papers`,
      baseParams,
    );
    const total = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `${unionSql}
       SELECT author, permlink, title, body, json_metadata, created
       FROM user_papers
       ORDER BY ${sortCol === 'net_votes' ? 'total_rshares' : 'created'} ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${cte.nextIdx + 3} OFFSET $${cte.nextIdx + 4}`,
      [...baseParams, limit, offset],
    );

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      return toPaperSummary(
        { author: r.author as string, permlink: r.permlink as string, title: r.title as string, body: r.body as string, created: r.created as string, net_votes: 0 },
        meta,
        orcidMap,
        nameMap,
      );
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF user papers query failed');
    throw new HafQueryError('fetchUserPapersFromHaf', { cause: err });
  }
}

router.get('/:username/papers', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);
  const sort = (req.query.sort as string) === 'votes' ? 'net_votes' : 'created';

  const cacheKey = `profile-papers:${username}:${JSON.stringify({ sort, order, page, limit })}`;
  try {
    const result = await hafCache.getOrSet(cacheKey, async () => {
      // Fetch the accreditation orcid map inside the cache miss path so the
      // cached PaperSummary rows carry the supersession projection.
      //
      // Cache windows for supersession freshness on this surface:
      //   - `hafCache.getOrSet` here uses the QueryCache default (30s), so
      //     response-level cache hits serve the same projected map for
      //     up to 30 seconds per (username, sort, order, page, limit) key.
      //   - `getAccreditedOrcidsByAccount` is 10-min cached internally, so
      //     cold response-cache misses re-use the accreditation set for
      //     up to ~10 minutes before re-fetching.
      // Net supersession revocation window observed on this endpoint: up
      // to ~10 minutes from the on-chain revoke event. See
      // `agents/docs/api-contracts/profiles.md` cache-staleness note.
      //
      // HAF outage handling: `getAccreditedOrcidsByAccount` throws when
      // HAF is up but the query fails. Wrap in `HafQueryError` so the
      // route's outer catch returns 503 retriable rather than letting
      // the raw pg error propagate to the central 500 handler.
      let orcidMap: Map<string, string | null>;
      let nameMap: Map<string, string>;
      try {
        [orcidMap, nameMap] = await Promise.all([
          getAccreditedOrcidsByAccount(),
          getAccreditedNamesByAccount(),
        ]);
      } catch (err) {
        throw new HafQueryError('getAccreditedOrcidsByAccount', { cause: err });
      }
      const hafResult = await fetchUserPapersFromHaf(username, limit, offset, sort, order, orcidMap, nameMap);
      if (hafResult) return hafResult;
      return { rows: [], total: 0 };
    });

    // Enrich with accreditation and reputation
    if (result.rows.length > 0) {
      const authorNames = result.rows.map((r) => r.author);
      // Translate raw pg failures from any of the loud-fail HAF helpers
      // (`getAllAccreditedAccounts`, `getAccreditedOrcidsByAccount`,
      // `getAllEverAccreditedOrcidsWithStatus`) into `HafQueryError` so the
      // outer route catch returns 503 retriable. `getAccreditedSet` and
      // `getReputationScores` are safe-fail by contract (the former returns
      // an empty set on outage; the latter falls back to last-known cached
      // values), so they don't reach the wrapping branch in practice — but
      // wrapping the whole Promise.all is the simplest shape that doesn't
      // leak a raw pg error if a future helper changes contract.
      let accreditedSet: Set<string>;
      let batchScores: Map<string, number>;
      let allAccredited: Set<string>;
      let accreditedOrcidsByAccount: Map<string, string | null>;
      let accreditationOrcidStatus: Map<string, { orcid: string | null; status: import('../accreditation.js').AccreditationStatus }>;
      let accreditedNamesByAccount: Map<string, string>;
      try {
        [accreditedSet, batchScores, allAccredited, accreditedOrcidsByAccount, accreditationOrcidStatus, accreditedNamesByAccount] = await Promise.all([
          getAccreditedSet(authorNames),
          getReputationScores(authorNames),
          getAllAccreditedAccounts(),
          getAccreditedOrcidsByAccount(),
          getAllEverAccreditedOrcidsWithStatus(),
          getAccreditedNamesByAccount(),
        ]);
      } catch (err) {
        if (err instanceof HafQueryError) throw err;
        throw new HafQueryError('profile-papers-enrichment', { cause: err });
      }

      // Cross-surface cumulative-union enrichment: identical shape to
      // `fetchPapersFromHaf` listing — for each row, fetch the chain-level
      // cumulative `authors` + `accredited_authors` so multi-link papers
      // include co-authors the head broadcaster may have dropped from
      // their own `pevo.authors[]`. Includes papers reached via the
      // `authorship_claims` UNION arm — the helper does not distinguish
      // claim-derived rows from author-derived rows. Per-root Redis cache
      // absorbs warm pages; cold pages walk in parallel.
      //
      // Wall-clock budget: per-row helpers thread the same `AbortSignal`
      // bounded by `config.hafWalkerWallClockMs`. The signal stops NEW
      // queries from being dispatched once the budget fires; it does NOT
      // cancel an in-flight `pool.query` (pg v8.x has no `AbortSignal`
      // integration), so the last query a row issued runs to PostgreSQL's
      // `statement_timeout` (30s). Real per-row worst case =
      // `hafWalkerWallClockMs` + `statement_timeout`. Mirrors the listing
      // enrichment in `fetchPapersFromHaf` and the detail handler's walker
      // budget.
      const enrichmentAbort = new AbortController();
      const enrichmentBudget = setTimeout(() => enrichmentAbort.abort(), config.hafWalkerWallClockMs);
      const chainAuthorsByKey = new Map<string, ChainCumulativeAuthorsResult>();
      try {
        await Promise.all(
          result.rows.map(async (row) => {
            const key = `${row.author}/${row.permlink}`;
            try {
              const chainResult = await resolveChainCumulativeAuthors(
                row.author,
                row.permlink,
                {
                  accreditedAccounts: allAccredited,
                  accreditedOrcids: accreditedOrcidsByAccount,
                  accreditationOrcidStatus,
                  accreditedNames: accreditedNamesByAccount,
                  signal: enrichmentAbort.signal,
                },
              );
              if (chainResult !== null) chainAuthorsByKey.set(key, chainResult);
            } catch (err) {
              logger.warn({ err, author: row.author, permlink: row.permlink }, 'profile chain cumulative authors enrichment failed');
            }
          }),
        );
      } finally {
        clearTimeout(enrichmentBudget);
      }

      for (const row of result.rows) {
        const authorAccredited = accreditedSet.has(row.author);
        row.is_accredited = authorAccredited;
        // Symmetric chain pre-check: a non-accredited author shows score 0
        // even if a stale batch entry survives in Redis (chain is SSoT,
        // batch map is a perf cache).
        row.author_reputation = authorAccredited ? (batchScores.get(row.author) ?? 0) : 0;

        const chainResult = chainAuthorsByKey.get(`${row.author}/${row.permlink}`);
        // Mirror the listing surface's gate: take the cumulative result only
        // when it carries authors, so an empty cumulative array (e.g. a
        // multi-link chain whose posts carry no valid-hive author entries)
        // falls back to the head-meta projection instead of serving an empty
        // authors list. Without the `length > 0` check, profile would diverge
        // from listing + detail (which both fall back to head-meta), reopening
        // the cross-surface parity break this surface exists to close.
        const cumulative =
          chainResult && chainResult.authors.length > 0 ? chainResult : null;
        if (cumulative !== null) {
          // Cumulative-union takeover: helper output replaces the head-meta
          // projection so dropped chain authors stay visible at the profile
          // surface. Strip `affiliation` because PaperSummary's contract
          // excludes that field (it is PaperDetail-only); the head-meta
          // projection above is already affiliation-free via toPaperSummary's
          // strip.
          row.authors = cumulative.authors.map((a) => {
            const { affiliation: _affiliation, ...rest } = a;
            return rest;
          });
          row.accredited_authors = cumulative.accredited_authors;
        } else {
          // No usable cumulative result (helper unreachable: HAF down,
          // single-link fast-path failed; or an empty cumulative array):
          // fall back to the head-meta projection.
          row.accredited_authors = (row.authors || [])
            .map((a) => normalizeHiveAccount(a.hive))
            .filter((hive): hive is string => hive !== null && allAccredited.has(hive));
        }
      }
    }

    sendOk(res, result.rows, { page, limit, total: result.total });
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope (see `isRetriableHafError`
      // in `db.ts`). Deterministic pg failures fall through to the
      // central 500 so SPA retry doesn't loop a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Profile papers temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  }
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/reviews
// ──────────────────────────────────────────────

function buildReviewSummary(
  post: { author: string; permlink: string; body: string; created: string },
  meta: Record<string, unknown>,
  paperAuthor: string,
  paperPermlink: string,
  paperTitle: string,
) {
  const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
  const rating = pevo.rating as Record<string, number> | undefined;
  return {
    author: post.author,
    permlink: post.permlink,
    body: post.body.slice(0, 300),
    rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
    is_anonymous: pevo.is_anonymous ?? false,
    paper: {
      author: paperAuthor,
      permlink: paperPermlink,
      title: paperTitle,
    },
    created: post.created,
  };
}

async function fetchUserReviewsFromHaf(username: string, limit: number, offset: number, order: string, sort: string) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Param shape: the active_accreditations + authorship_claims CTEs consume the
    // leading params; the per-bind counter below (paramIdx++ from
    // accredCte.nextIdx) then resolves $N for username, appTag, hiveAnonAccount,
    // hiveBridgeAccount, limit, offset, and (votes-sort only) accreditedAccounts.
    // The counter is the source of truth; do not hard-cite positions (they shift
    // whenever a CTE is added — authorship_claims was added for the claimer
    // self-review display exclusion).
    //
    // The accreditation OR-anon gate is load-bearing here: without it,
    // `/api/profile/<unaccredited>/reviews` surfaces 300-char body
    // excerpts of review-shaped replies that pass validReviewWhere but
    // fail the per-review accreditation gate at `/api/reviews/...`. The
    // listing and per-review surfaces must agree on what counts as a
    // review (per the pevo-object-identity-is-author-vouching convention).
    //
    // The JOIN against parent paper `p` enforces three things: (a) the
    // title (p.title), (b) self-review exclusion (p.json_metadata ->
    // authors[]), and (c) parent-paper class identity — without
    // validPevoPaperWhere on `p`, a `pevo.review`-shaped reply to a non-
    // paper Hive post (a peakd blog post, a non-paper comment) would
    // surface here with paper_title='' while reputation correctly excludes
    // it (the user_reviews CTE in reputation.ts composes validPevoPaperWhere
    // on its parent JOIN). Display and reputation must agree on which
    // (author, permlink) reviews contribute (see
    // `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`
    // for the parity-audit convention). INNER JOIN — a review whose
    // parent paper isn't present in HAF can't surface meaningfully in a
    // profile reviews list anyway.
    // Canonical $N counter pattern (matches reviews.ts). Offset arithmetic
    // (`nextIdx + N` constants) silently mis-binds if any bind is added or
    // removed between lines, or if activeAccreditationsCteBody returns
    // additional CTE params; the counter pattern adapts. Per
    // `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`,
    // the SQL-shape canary in profile-reviews-accred-gate.test.ts pins
    // the resolved param positions so a positional mis-bind fails red.
    // authorship_claims scoped to the profile user (the only review author here),
    // so excludeClaimedSelfWhere can drop a self-review on a paper this user is a
    // credited claimer of (ORCID / name-only slot — absent from authors[].hive);
    // the consent stack scoped the same way ({signer}-seeded walk +
    // {signers}-narrowed resolution) so excludeConsentedSelfWhere drops a
    // self-review on a paper this user is a Route-2 consented co-author of.
    const accredCte = buildRecursiveWith(
      1,
      activeAccreditationsCteBody,
      (idx) => authorshipClaimsCteBody(idx, { claimer: username }),
      (idx) => consentSeedCteBody(idx, { signer: username }),
      (idx) => consentChainCteBody(idx, { rootsFromCte: 'consent_seed' }),
      (idx) => consentedAuthorsCteBody(idx, { signers: [username] }),
    );
    let paramIdx = accredCte.nextIdx;
    const usernameIdx = paramIdx++;
    const appTagIdx = paramIdx++;
    const anonIdx = paramIdx++;
    const bridgeIdx = paramIdx++;
    const limitIdx = paramIdx++;
    const offsetIdx = paramIdx++;
    const accreditedParamIdx = paramIdx++; // votes-sort only; param appended conditionally below

    const at = `$${appTagIdx}`;
    const bridgeParam = `$${bridgeIdx}`;
    const reviewWhere = validReviewWhere({ commentAlias: 'c', appTagParam: at });
    const paperGate = validPevoPaperWhere({ commentAlias: 'p', appTagParam: at, bridgeAccountParam: bridgeParam, source: 'all' });
    const selfExclude = excludeSelfReviewWhere({ paperRowAlias: 'p', appTagParam: at });
    const claimedExclude = excludeClaimedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' });
    const consentedExclude = excludeConsentedSelfWhere({ authorExpr: 'c.author', paperAuthorExpr: 'p.author', paperPermlinkExpr: 'p.permlink' });
    const accredGate = `(c.author IN (SELECT account FROM active_accreditations) OR c.author = $${anonIdx})`;

    const baseParams: unknown[] = [
      ...accredCte.params,
      username,
      config.appTag,
      config.hiveAnonAccount || '',
      config.hiveBridgeAccount || '',
    ];

    const countResult = await pool.query(
      `${accredCte.sql}
       SELECT count(*)::int AS total FROM ${T.comments} c
       JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE c.author = $${usernameIdx} AND c.parent_author != ''
         AND ${accredGate}
         AND ${reviewWhere}
         AND ${paperGate}
         AND ${selfExclude}
         AND ${claimedExclude}
         AND ${consentedExclude}`,
      baseParams,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // For sort-by-votes, compute accredited net_votes per review.
    const accreditedAccounts = sort === 'votes' ? [...(await getAllAccreditedAccounts())] : [];
    const netVotesSubquery = sort === 'votes'
      ? `(SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int
          FROM (SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                WHERE v.author = c.author AND v.permlink = c.permlink
                  AND v.voter = ANY($${accreditedParamIdx}::text[]) AND v.voter != v.author
                -- Same-block tie-breaker: v.id (operation_vote_view has no trx_in_block;
                -- v.id is the monotonic HAF op id) per
                -- agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2
                ORDER BY v.voter, v.block_num DESC, v.id DESC) lv WHERE lv.weight != 0) AS net_votes`
      : '0 AS net_votes';
    const orderClause = sort === 'votes'
      ? `net_votes ${order === 'asc' ? 'ASC' : 'DESC'}, c.created DESC`
      : `c.created ${order === 'asc' ? 'ASC' : 'DESC'}`;

    const dataParams: unknown[] = [...baseParams, limit, offset];
    if (sort === 'votes') dataParams.push(accreditedAccounts);

    const dataResult = await pool.query(
      `${accredCte.sql}
       SELECT c.author, c.permlink, LEFT(c.body, 300) AS body,
              c.json_metadata, c.created,
              c.parent_author, c.parent_permlink,
              p.title AS paper_title,
              ${netVotesSubquery}
       FROM ${T.comments} c
       JOIN ${T.comments} p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
       WHERE c.author = $${usernameIdx} AND c.parent_author != ''
         AND ${accredGate}
         AND ${reviewWhere}
         AND ${paperGate}
         AND ${selfExclude}
         AND ${claimedExclude}
         AND ${consentedExclude}
       ORDER BY ${orderClause}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      dataParams,
    );

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      return buildReviewSummary(
        { author: r.author as string, permlink: r.permlink as string, body: r.body as string, created: r.created as string },
        meta,
        r.parent_author as string,
        r.parent_permlink as string,
        (r.paper_title as string) || '',
      );
    });

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF user reviews query failed');
    throw new HafQueryError('fetchUserReviewsFromHaf', { cause: err });
  }
}

router.get('/:username/reviews', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const { page, limit, offset } = parsePageLimit(req);
  const order = parseOrder(req);
  const sort = (req.query.sort as string) === 'votes' ? 'votes' : 'date';

  const cacheKey = `profile-reviews:${username}:${JSON.stringify({ sort, order, page, limit })}`;
  try {
    const result = await hafCache.getOrSet(cacheKey, async () => {
      const hafResult = await fetchUserReviewsFromHaf(username, limit, offset, order, sort);
      if (hafResult) return hafResult;
      return { rows: [], total: 0 };
    });

    sendOk(res, result.rows, { page, limit, total: result.total });
  } catch (err) {
    if (err instanceof HafQueryError && isRetriableHafError(err)) {
      // Cause-discriminated retriable envelope (see `isRetriableHafError`
      // in `db.ts`). Deterministic pg failures fall through to the
      // central 500 so SPA retry doesn't loop a dead query.
      return sendError(
        res,
        503,
        'SERVICE_UNAVAILABLE',
        'Profile reviews temporarily unavailable. Please retry shortly.',
        { retriable: true },
      );
    }
    throw err;
  }
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/notification-preferences
// ──────────────────────────────────────────────

router.get('/:username/notification-preferences', verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.params.username as string;

  if (req.hiveUsername !== username) {
    return sendError(res, 403, 'FORBIDDEN', 'Can only view your own notification preferences');
  }

  const pool = getAppPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT username, email_digest, digest_frequency, email, updated_at
         FROM notification_preferences WHERE username = $1`,
        [username],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return sendOk(res, {
          username: row.username,
          email_digest: row.email_digest,
          digest_frequency: row.digest_frequency,
          email: row.email,
          updated_at: row.updated_at?.toISOString() ?? null,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch notification preferences');
    }
  }

  // Return defaults
  sendOk(res, {
    username,
    email_digest: false,
    digest_frequency: 'weekly',
    email: null,
    updated_at: null,
  });
});

// ──────────────────────────────────────────────
// PUT /api/profile/:username/notification-preferences
// ──────────────────────────────────────────────

const notificationPrefsSchema = z.object({
  email_digest: z.boolean(),
  digest_frequency: z.enum(['daily', 'weekly']),
  email: z.string().email().max(254).nullable(),
});

router.put('/:username/notification-preferences', verifyHiveSignature, validate(notificationPrefsSchema), async (
  req: Request<Record<string, string>, unknown, z.infer<typeof notificationPrefsSchema>>,
  res: Response,
) => {
  const username = req.params.username as string;

  if (req.hiveUsername !== username) {
    return sendError(res, 403, 'FORBIDDEN', 'Can only update your own notification preferences');
  }

  const { email_digest, digest_frequency, email } = req.body;

  const pool = getAppPool();
  if (!pool) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'App database not configured');
  }

  try {
    // When enabling digest, set last_digest_block to current head block
    // so the user doesn't receive a backlog email on their first digest
    const baselineBlock = email_digest ? getLastBlock() : 0;

    const result = await pool.query(
      `INSERT INTO notification_preferences (username, email_digest, digest_frequency, email, last_digest_block, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (username) DO UPDATE SET
         email_digest = EXCLUDED.email_digest,
         digest_frequency = EXCLUDED.digest_frequency,
         email = EXCLUDED.email,
         last_digest_block = CASE
           WHEN notification_preferences.email_digest = false AND EXCLUDED.email_digest = true
           THEN EXCLUDED.last_digest_block
           ELSE notification_preferences.last_digest_block
         END,
         updated_at = now()
       RETURNING username, email_digest, digest_frequency, email, updated_at`,
      [username, email_digest, digest_frequency, email, baselineBlock],
    );

    const row = result.rows[0];
    sendOk(res, {
      username: row.username,
      email_digest: row.email_digest,
      digest_frequency: row.digest_frequency,
      email: row.email,
      updated_at: row.updated_at?.toISOString() ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update notification preferences');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update notification preferences');
  }
});

// ──────────────────────────────────────────────
// GET /api/profile/:username/notification-preferences/unsubscribe
// ──────────────────────────────────────────────

router.get('/:username/notification-preferences/unsubscribe', async (req: Request, res: Response) => {
  const username = req.params.username as string;
  const token = req.query.token as string;

  if (!token) {
    return sendError(res, 400, 'BAD_REQUEST', 'Missing unsubscribe token');
  }

  const { verifyUnsubscribeToken } = await import('../digest.js');
  if (!verifyUnsubscribeToken(username, token)) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid unsubscribe token');
  }

  const pool = getAppPool();
  if (pool) {
    await pool.query(
      `UPDATE notification_preferences SET email_digest = false, updated_at = now() WHERE username = $1`,
      [username],
    );
  }

  sendOk(res, { message: 'Email digest unsubscribed' });
});

export { getAccreditation };
export default router;
