import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { PrivateKey } from '@hiveio/dhive';
import { getPool } from '../db.js';
import { broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import {
  parseMeta,
  isPevoAnyPaper,
  isPevoBridgePaper,
  parsePageLimit,
  parseSort,
  parseOrder,
  extractAbstract,
  extractAuthorizedContinuationAuthors,
  pevoString,
  pevoStringArray,
  type SortField,
} from '../helpers.js';
import { getAccreditedSet, getAllAccreditedAccounts, getAccreditedOrcidsByAccount } from '../accreditation.js';
import { getReputationScores } from '../reputation.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { validatedCid } from '../lib/ipfs-validation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { paperDisciplineField } from '../types/disciplines.js';
import {
  T,
  accreditedVoteCount,
  activeAccreditationsCteBody,
  authorshipClaimsCteBody,
  retractedPapersCteBody,
  buildWith,
  getCachedGenesisBlock,
  validPevoPaperWhere,
} from '../hafsql.js';
import { validateDisciplineFilter } from '../types/disciplines.js';

const router = Router();

// ─── Vote strength tiers ────────────────────────────────────────
function voteStrengthTier(avgWeight: number): string {
  if (avgWeight > 6000) return 'strong_endorsement';
  if (avgWeight > 2500) return 'endorsement';
  if (avgWeight > 0) return 'mild_endorsement';
  if (avgWeight === 0) return 'neutral';
  if (avgWeight >= -2500) return 'mild_concerns';
  if (avgWeight >= -6000) return 'reject';
  return 'strong_reject';
}

interface ResolvedVotes {
  net_votes: number;
  vote_strength: string | null;
}

/**
 * Compute resolved vote counts for a set of papers using parallel native + revote queries.
 * Returns a Map keyed by "author/permlink" with net_votes and vote_strength.
 */
async function batchResolveVotes(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  papers: Array<{ author: string; permlink: string }>,
  accreditedArr: string[],
): Promise<Map<string, ResolvedVotes>> {
  if (papers.length === 0) return new Map();

  // Build (author, permlink) pairs for the batch native vote query
  const pairValues: string[] = [];
  const pairParams: unknown[] = [];
  let pIdx = 1;
  for (const p of papers) {
    pairValues.push(`($${pIdx++}, $${pIdx++})`);
    pairParams.push(p.author, p.permlink);
  }
  const accreditedParam = `$${pIdx++}`;
  pairParams.push(accreditedArr);

  const [nativeResult, revoteResult] = await Promise.all([
    // Batch native votes: latest per voter per paper, accredited only, excluding self-votes
    pool.query(
      `SELECT DISTINCT ON (v.author, v.permlink, v.voter)
              v.author, v.permlink, v.voter, v.weight, v.block_num
       FROM ${T.voteOps} v
       WHERE (v.author, v.permlink) IN (${pairValues.join(', ')})
         AND v.voter = ANY(${accreditedParam}::text[])
         AND v.voter != v.author
       ORDER BY v.author, v.permlink, v.voter, v.block_num DESC`,
      pairParams,
    ),
    // All revotes for APP_TAG
    pool.query(
      `SELECT cj.json::jsonb ->> 'author' AS author,
              cj.json::jsonb ->> 'permlink' AS permlink,
              cj.required_posting_auths ->> 0 AS voter,
              (cj.json::jsonb ->> 'weight')::int AS weight,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.block_num >= $2`,
      [config.appTag, getCachedGenesisBlock()],
    ),
  ]);

  // Index native votes: paper_key -> voter -> { weight, block_num }
  const accreditedSet = new Set(accreditedArr);
  type VoteSignal = { weight: number; block_num: number };
  const nativeByPaper = new Map<string, Map<string, VoteSignal>>();
  for (const r of nativeResult.rows) {
    const key = `${r.author}/${r.permlink}`;
    if (!nativeByPaper.has(key)) nativeByPaper.set(key, new Map());
    nativeByPaper.get(key)!.set(r.voter as string, {
      weight: Number(r.weight),
      block_num: Number(r.block_num),
    });
  }

  // Index revotes: paper_key -> voter -> { weight, block_num } (latest per voter per paper)
  const revoteByPaper = new Map<string, Map<string, VoteSignal>>();
  // Revote rows are not ordered, so we track latest block_num manually
  for (const r of revoteResult.rows) {
    const voter = r.voter as string;
    const weight = Number(r.weight);
    if (!voter || isNaN(weight) || weight < -10000 || weight > 10000) continue;
    const rAuthor = r.author as string;
    if (!rAuthor || !accreditedSet.has(voter) || voter === rAuthor) continue;
    const key = `${rAuthor}/${r.permlink}`;
    if (!revoteByPaper.has(key)) revoteByPaper.set(key, new Map());
    const existing = revoteByPaper.get(key)!.get(voter);
    const blockNum = Number(r.block_num);
    if (!existing || blockNum > existing.block_num) {
      revoteByPaper.get(key)!.set(voter, { weight, block_num: blockNum });
    }
  }

  // Merge: for each paper, resolve votes
  const results = new Map<string, ResolvedVotes>();
  for (const p of papers) {
    const key = `${p.author}/${p.permlink}`;
    const nativeVotes = nativeByPaper.get(key) || new Map<string, VoteSignal>();
    const revotes = revoteByPaper.get(key) || new Map<string, VoteSignal>();

    // Collect all voters across both sources
    const allVoters = new Set([...nativeVotes.keys(), ...revotes.keys()]);
    let upvotes = 0;
    let downvotes = 0;
    let weightSum = 0;
    let voterCount = 0;

    for (const voter of allVoters) {
      const native = nativeVotes.get(voter);
      const revote = revotes.get(voter);

      let effectiveWeight: number;
      if (native && revote) {
        effectiveWeight = revote.block_num > native.block_num ? revote.weight : native.weight;
      } else if (revote) {
        effectiveWeight = revote.weight;
      } else {
        effectiveWeight = native!.weight;
      }

      if (effectiveWeight === 0) continue; // retracted
      if (effectiveWeight > 0) upvotes++;
      else downvotes++;
      weightSum += effectiveWeight;
      voterCount++;
    }

    const net_votes = upvotes - downvotes;
    const vote_strength = voterCount > 0 ? voteStrengthTier(weightSum / voterCount) : null;
    results.set(key, { net_votes, vote_strength });
  }

  return results;
}

/** Safely extract the pevo metadata sub-object with runtime validation. */
function safePevoMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const pevo = meta[config.appTag];
  if (pevo != null && typeof pevo === 'object' && !Array.isArray(pevo)) {
    return pevo as Record<string, unknown>;
  }
  return {};
}

/**
 * Build the cumulative-union authors[] for a multi-link continuation chain
 * per `backend-multi-author-cumulative-union.md`. The displayed `authors[]`
 * is the union of `pevo.authors[].hive` (lowercased, trimmed,
 * non-empty-string only) across all chain posts; per-hive sub-fields
 * (`name`, `affiliation`, etc.) resolve to the most-recent self-claim
 * (a chain post whose `chain-author === hive` claiming itself) or, absent
 * a self-claim, the most-recent claim across the chain. ORCID is
 * server-overridden for accredited hives whose claimed ORCID disagrees
 * with the on-chain accredited ORCID; mismatch emits a structured
 * `orcid_claim_mismatch` audit warn for post-incident triage.
 *
 * Drops are forbidden by construction: the union map only grows, so a
 * later chain post cannot remove a hive that an earlier post added. This
 * supersedes the round-3 no-shrink check (`headAuthorsCoverRoot`); a
 * mathematical invariant replaces a check that could be inverted or get
 * out of sync with the spec.
 *
 * Bridge papers' `hive: null` carrier entries (original-preprint authors
 * who lack on-chain identity) are filtered out at extract time. Bridge
 * papers are immutable post-publish so they reach this helper only with
 * `chain.length === 1` — and the caller skips this helper for
 * `chain.length === 1`. Defense-in-depth: even if a bridge chain extended
 * to multiple links, the union strips `hive: null` entries; the existing
 * bridge metadata path (`buildPaperDetail`'s `pevo.authors || []` for
 * single-link papers) preserves the full carrier list.
 *
 * @param chainPosts - chain links with their latest reconstructed pevo
 *   metadata, in chain order (root first, head last).
 * @param rootAuthor / rootPermlink - the canonical paper coordinates,
 *   used as audit-event payload anchors.
 * @param accreditedAccounts - membership set of accredited Hive accounts
 *   (loaded once per request via `getAllAccreditedAccounts`).
 * @param accreditedOrcids - per-accredited-account ORCID map (loaded once
 *   per request via `getAccreditedOrcidsByAccount`); `null` value means
 *   the account is accredited but the on-chain attestation does not
 *   carry an ORCID — pass-through is the policy in that case.
 */
function buildCumulativeAuthorsForChain(
  chainPosts: Array<{ author: string; permlink: string; pevo: Record<string, unknown> }>,
  rootAuthor: string,
  rootPermlink: string,
  accreditedAccounts: Set<string>,
  accreditedOrcids: Map<string, string | null>,
): Array<Record<string, unknown>> {
  // Per-hive winning claim: latest self-claim wins (most-recent self-claim
  // by the hive's own continuation post about itself); else latest claim
  // across the chain wins (the most-recent broadcaster's claim about that
  // hive). `isSelf` tracks whether the winning claim is a self-claim so
  // a later non-self claim does not overwrite an earlier self-claim.
  const winning = new Map<string, {
    entry: Record<string, unknown>;
    sourceAuthor: string;
    sourcePermlink: string;
    isSelf: boolean;
  }>();
  // First-occurrence index: the index at which this hive first appeared
  // in any chain post. Drives the displayed authors[] order so the chain's
  // monotonic-growth narrative carries through to the API response.
  const firstOccurrence = new Map<string, number>();
  let occurrenceCounter = 0;

  for (const post of chainPosts) {
    const authorsArr = Array.isArray(post.pevo.authors) ? post.pevo.authors : [];
    for (const e of authorsArr) {
      if (!e || typeof e !== 'object') continue;
      const entry = e as Record<string, unknown>;
      if (typeof entry.hive !== 'string') continue;
      const hive = entry.hive.trim().toLowerCase();
      if (hive.length === 0) continue;

      if (!firstOccurrence.has(hive)) {
        firstOccurrence.set(hive, occurrenceCounter++);
      }

      const isSelfClaim = post.author === hive;
      const existing = winning.get(hive);

      if (!existing) {
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: isSelfClaim,
        });
      } else if (isSelfClaim) {
        // Most-recent self-claim wins.
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: true,
        });
      } else if (!existing.isSelf) {
        // No self-claim seen yet; take the most-recent fallback claim.
        winning.set(hive, {
          entry,
          sourceAuthor: post.author,
          sourcePermlink: post.permlink,
          isSelf: false,
        });
      }
      // else: existing winner is a self-claim; current is non-self — keep
      // the self-claim (it outranks any non-self claim regardless of
      // recency).
    }
  }

  const orderedHives = Array.from(winning.keys()).sort(
    (a, b) => (firstOccurrence.get(a) ?? 0) - (firstOccurrence.get(b) ?? 0),
  );

  return orderedHives.map((hive) => {
    const w = winning.get(hive)!;
    // Clone the winning entry so we can override sub-fields (ORCID) without
    // mutating the source `pevo.authors[]` array.
    const out: Record<string, unknown> = { ...w.entry };
    // Normalize the displayed `hive` to the lowercased canonical form.
    out.hive = hive;

    // ORCID server-override (rule #3). For accredited hives, the on-chain
    // accreditation attestation is the authoritative ORCID; broadcaster
    // claims about an accredited account's ORCID are at most a second-best
    // signal. Mismatch emits an audit event so accreditation-revocation
    // triage can correlate spoof attempts; missing-claim prefills from
    // accreditation; matching claim passes through.
    if (accreditedAccounts.has(hive)) {
      const accreditedOrcid = accreditedOrcids.get(hive) ?? null;
      const claimedOrcid = typeof out.orcid === 'string' && (out.orcid as string).length > 0
        ? (out.orcid as string)
        : null;
      if (accreditedOrcid) {
        if (claimedOrcid && claimedOrcid !== accreditedOrcid) {
          logger.warn(
            {
              event: 'orcid_claim_mismatch',
              rootAuthor,
              rootPermlink,
              hive,
              claimedOrcid,
              accreditedOrcid,
              claimSource: `${w.sourceAuthor}/${w.sourcePermlink}`,
            },
            'broadcaster-claimed ORCID for accredited hive differs from accredited ORCID; server-overriding',
          );
          out.orcid = accreditedOrcid;
        } else if (!claimedOrcid) {
          // Prefill: accredited carries an ORCID, the chain-claim doesn't.
          out.orcid = accreditedOrcid;
        }
        // else: claimedOrcid === accreditedOrcid — pass through unchanged.
      }
      // else: accredited account but accreditation attestation has no
      // on-chain ORCID — pass the chain-claim through unchanged.
    }

    return out;
  });
}

const retractLimiter = rateLimit({ name: 'paper-retract', windowMs: 3_600_000, max: 5, keyFn: byAccount });
// ──────────────────────────────────────────────
// HAF SQL implementation for paper listing
// ──────────────────────────────────────────────

async function fetchPapersFromHaf(
  req: Request,
  discipline: string | undefined,
): Promise<{ rows: unknown[]; total: number } | null> {
  const pool = getPool();
  if (!pool) return null;

  const { limit, offset } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // `discipline` is pre-validated + lowercased by the route handler. Bound
  // as-is into `LOWER(column) = $N`; the `if (discipline)` gate below
  // suppresses the WHERE clause when absent.
  const keyword = req.query.keyword as string | undefined;
  const author = req.query.author as string | undefined;
  const language = req.query.language as string | undefined;
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
  const includeRetracted = req.query.include_retracted === 'true'; // default false
  const source = req.query.source as string | undefined; // 'native', 'bridge', or omit for both

  // Build CTEs with parameterized appTag
  const cte = buildWith(1, activeAccreditationsCteBody, retractedPapersCteBody);
  let paramIdx = cte.nextIdx;
  const cteParams: unknown[] = [...cte.params];

  // appTag params for WHERE conditions
  const appTagParam = `$${paramIdx++}`;
  const appLikeParam = `$${paramIdx++}`;
  const bridgeAccountParam = `$${paramIdx++}`;
  cteParams.push(config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount);

  const paperSource: 'native' | 'bridge' | 'all' =
    source === 'native' ? 'native' : source === 'bridge' ? 'bridge' : 'all';
  const typeFilter = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: paperSource });

  const conditions: string[] = [
    `c.parent_permlink = ${appTagParam}`,
    "c.parent_author = ''",
    typeFilter,
    `c.json_metadata ->> 'app' LIKE ${appLikeParam}`,
  ];
  const filterParams: unknown[] = [];

  if (discipline) {
    // LOWER() on both sides so case-variant on-chain values match.
    conditions.push(`LOWER(c.json_metadata -> ${appTagParam} ->> 'discipline') = $${paramIdx++}`);
    filterParams.push(discipline);
  }
  if (keyword) {
    conditions.push(`c.json_metadata -> ${appTagParam} -> 'keywords' ? $${paramIdx++}`);
    filterParams.push(keyword);
  }
  if (author) {
    conditions.push(`c.author = $${paramIdx++}`);
    filterParams.push(author);
  }
  if (language) {
    conditions.push(`(c.json_metadata -> ${appTagParam} ->> 'language') = $${paramIdx++}`);
    filterParams.push(language);
  }
  if (accreditedOnly) {
    // Bridge papers are posted by the system bridge account, not the original author,
    // so they are exempt from the accredited-only filter — but ONLY when authored
    // by config.hiveBridgeAccount. The bridge arm of validPevoPaperWhere() pins
    // the author; we reuse it as the OR-arm here to share the predicate shape.
    const bridgeArm = validPevoPaperWhere({ commentAlias: 'c', appTagParam, bridgeAccountParam, source: 'bridge' });
    conditions.push(`(c.author IN (SELECT account FROM active_accreditations) OR ${bridgeArm})`);
  }
  if (!includeRetracted) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM retracted_papers rp WHERE rp.author = c.author AND rp.permlink = c.permlink)`);
  }
  // E3: Hide continuation posts — they are revisions of existing papers, not separate papers
  conditions.push(`(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL`);

  const where = conditions.join(' AND ');
  const countParams = [...cteParams, ...filterParams];

  // anonParam is only used in SELECT subqueries (review/citation count),
  // not in WHERE, so it must not be in countParams (PostgreSQL rejects extra bind params).
  const anonParam = `$${paramIdx++}`;
  const dataParams = [...cteParams, ...filterParams, config.hiveAnonAccount || ''];

  const sortMap: Record<SortField, string> = {
    date: 'c.created',
    votes: 'net_votes',
    reputation: 'author_reputation',
  };
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortMap[sort]} ${safeOrder}`;

  // Only compute the expensive vote subquery when sorting by votes
  const voteSelect = sort === 'votes'
    ? `${accreditedVoteCount('c.author', 'c.permlink')} AS net_votes`
    : '0 AS net_votes';

  // Review count: accredited reviewers + anonymous posting account
  const reviewCountSelect = `COALESCE((
    SELECT count(*)::int FROM ${T.comments} r
    WHERE r.parent_author = c.author AND r.parent_permlink = c.permlink
      AND (r.json_metadata -> ${appTagParam} ->> 'type') = 'review'
      AND r.json_metadata ->> 'app' LIKE ${appLikeParam}
      AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = r.author) OR r.author = ${anonParam})
  ), 0) AS review_count`;

  // Average review rating: mean of all four rating dimensions across accredited reviews
  const avgRatingSelect = `COALESCE((
    SELECT round(avg(val)::numeric, 1)::float FROM (
      SELECT (
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'methodology')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'novelty')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'clarity')::float +
        (rv.json_metadata -> ${appTagParam} -> 'rating' ->> 'significance')::float
      ) / 4.0 AS val
      FROM ${T.comments} rv
      WHERE rv.parent_author = c.author AND rv.parent_permlink = c.permlink
        AND (rv.json_metadata -> ${appTagParam} ->> 'type') = 'review'
        AND rv.json_metadata ->> 'app' LIKE ${appLikeParam}
        AND (EXISTS (SELECT 1 FROM active_accreditations aa WHERE aa.account = rv.author) OR rv.author = ${anonParam})
        AND rv.json_metadata -> ${appTagParam} -> 'rating' IS NOT NULL
    ) sub
  ), 0) AS avg_rating`;

  // Citation count: accredited papers that cite this one (native papers only; bridge papers use Semantic Scholar)
  const citationCountSelect = `COALESCE((
    SELECT count(*)::int FROM ${T.comments} ci
    JOIN active_accreditations aa ON aa.account = ci.author
    WHERE ci.parent_author = '' AND ci.parent_permlink = ${appTagParam}
      AND (ci.json_metadata -> ${appTagParam} ->> 'type') = 'paper'
      AND ci.json_metadata ->> 'app' LIKE ${appLikeParam}
      AND ci.json_metadata -> ${appTagParam} -> 'citations' @> jsonb_build_array(jsonb_build_object('author', c.author, 'permlink', c.permlink))
  ), 0) AS citation_count`;

  try {
    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `${cte.sql}
         SELECT count(*)::int AS total FROM ${T.comments} c WHERE ${where}`,
        countParams,
      ),
      pool.query(
        `${cte.sql}
         SELECT
          c.author,
          c.permlink,
          c.title,
          LEFT(c.body, 300) AS abstract,
          c.json_metadata,
          c.created,
          ${voteSelect},
          ${reviewCountSelect},
          ${citationCountSelect},
          ${avgRatingSelect},
          0 AS author_reputation
        FROM ${T.comments} c
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...dataParams, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const authors = dataResult.rows.map((r: Record<string, unknown>) => r.author as string);

    // Use batch reputation scores only (no on-demand HAF computation).
    // Returns 0 for users not yet in the batch — profile page has full scores.
    const allAccredited = await getAllAccreditedAccounts();
    const allAccreditedArr = [...allAccredited];
    const paperKeys = dataResult.rows.map((r: Record<string, unknown>) => ({
      author: r.author as string,
      permlink: r.permlink as string,
    }));

    // Parallel: batch reputation + accredited set + resolved votes (native + revotes)
    const [batchScores, accreditedSet, voteData] = await Promise.all([
      getReputationScores(authors),
      getAccreditedSet(authors),
      batchResolveVotes(pool, paperKeys, allAccreditedArr),
    ]);

    const rows = dataResult.rows.map((r: Record<string, unknown>) => {
      const meta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(meta);
      const pevoAuthors: Array<{ hive?: string }> = (pevo.authors || []) as Array<{ hive?: string }>;
      const voteKey = `${r.author}/${r.permlink}`;
      const resolved = voteData.get(voteKey);
      // Bridge identity must be author-pinned. isPevoBridgePaper(meta, author)
      // checks both the metadata type AND author === config.hiveBridgeAccount;
      // the SQL gate already enforces this, so this JS-level check is
      // defense-in-depth for any future call path that bypasses the gate.
      const isBridge = isPevoBridgePaper(meta, r.author as string);
      return {
        author: r.author,
        permlink: r.permlink,
        title: r.title,
        abstract: r.abstract,
        discipline: paperDisciplineField(pevo.discipline),
        keywords: pevoStringArray(pevo, 'keywords'),
        authors: pevoAuthors,
        ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
          author: r.author as string,
          permlink: r.permlink as string,
        }),
        created: r.created,
        net_votes: resolved?.net_votes ?? (r.net_votes as number),
        vote_strength: resolved?.vote_strength ?? null,
        review_count: (r.review_count as number) ?? 0,
        avg_rating: (r.avg_rating as number) ?? 0,
        citation_count: (r.citation_count as number) ?? 0,
        // Symmetric chain pre-check: non-accredited author shows score 0
        // even if a stale batch entry survives in Redis (per BACKEND-REPUTATION-SSOT
        // direction-of-truth: chain is SSoT, batch map is a perf cache).
        is_accredited: accreditedSet.has(r.author as string),
        author_reputation: accreditedSet.has(r.author as string)
          ? (batchScores.get(r.author as string) ?? 0)
          : 0,
        accredited_authors: pevoAuthors
          .filter(a => a.hive && allAccredited.has(a.hive))
          .map(a => a.hive!),
        source_type: isBridge
          ? ((pevo.source as Record<string, unknown>)?.type as 'arxiv' | 'crossref') || 'arxiv'
          : 'native',
        doi: isBridge
          ? ((pevo.source as Record<string, unknown>)?.doi as string) || null
          : null,
      };
    });

    // Re-sort by resolved vote counts when sorting by votes (revotes may change order)
    if (sort === 'votes') {
      const dir = order === 'asc' ? 1 : -1;
      rows.sort((a, b) => (a.net_votes - b.net_votes) * dir);
    }

    // Enrich bridge papers with external citation counts
    const bridgeDois = rows.filter(r => r.doi).map(r => r.doi!);
    if (bridgeDois.length > 0) {
      const extCounts = await fetchExternalCitationCounts(bridgeDois);
      for (const row of rows) {
        if (row.doi && extCounts[row.doi] !== undefined) {
          row.citation_count = extCounts[row.doi];
        }
      }
    }

    return { rows, total };
  } catch (err) {
    logger.error({ err }, 'HAF papers query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// GET /api/papers — list papers
// ──────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageLimit(req);
  const sort = parseSort(req);
  const order = parseOrder(req);
  // Cache key uses `discipline ?? ''` so absent/invalid coalesces to the
  // empty fragment `d=`, while the SQL gate uses `discipline ?? undefined`
  // so the `if (discipline)` predicate suppresses the WHERE clause entirely.
  // Same value, two coalesce shapes, on purpose.
  const filterResult = validateDisciplineFilter(req.query.discipline);
  if (filterResult && !filterResult.ok) {
    return sendError(res, 400, 'BAD_REQUEST', filterResult.message);
  }
  const discipline: string | null = filterResult?.ok ? filterResult.value : null;
  const keyword = req.query.keyword || '';
  const author = req.query.author || '';
  const language = req.query.language || '';
  const accreditedOnly = req.query.accredited_only !== 'false'; // default true
  const includeRetracted = req.query.include_retracted === 'true';
  const source = req.query.source || '';
  // Sibling fields (keyword, author, language, source) flow in unvalidated;
  // a `:` in any of them collides with the delimiter and lets a crafted
  // `?keyword=:a=alice` poison-cache against `?author=:a=alice`. sha256-wrap
  // the raw fragments so the namespace is collision-stable. Mirrors
  // search.ts:320.
  const rawKey = `p=${page}:l=${limit}:s=${sort}:o=${order}:d=${discipline ?? ''}:k=${keyword}:a=${author}:lang=${language}:ao=${accreditedOnly}:ir=${includeRetracted}:src=${source}`;
  const cacheKey = `papers:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
  const result = await hafCache.getOrSetSWR(cacheKey, () => fetchPapersFromHaf(req, discipline ?? undefined));
  if (result) {
    return sendOk(res, result.rows, { page, limit, total: result.total });
  }

  sendOk(res, [], { page, limit, total: 0 });
});

// ──────────────────────────────────────────────
// Semantic Scholar external citation counts (cached 24h)
// ──────────────────────────────────────────────

async function fetchExternalCitationCounts(dois: string[]): Promise<Record<string, number>> {
  if (dois.length === 0) return {};

  const results: Record<string, number> = {};
  const uncached: string[] = [];

  for (const doi of dois) {
    const cached = await hafCache.get<number>(`ext-citations:${doi}`);
    if (cached !== undefined) {
      results[doi] = cached;
    } else {
      uncached.push(doi);
    }
  }

  if (uncached.length > 0) {
    try {
      const response = await fetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: uncached.map((d) => `DOI:${d}`) }),
      });

      if (response.ok) {
        const data = await response.json() as Array<{ citationCount?: number } | null>;
        for (let i = 0; i < uncached.length; i++) {
          const count = data[i]?.citationCount ?? 0;
          results[uncached[i]] = count;
          await hafCache.set(`ext-citations:${uncached[i]}`, count, 86_400_000); // 24h
        }
      } else {
        logger.warn({ status: response.status }, 'Semantic Scholar batch request failed');
        for (const doi of uncached) results[doi] = 0;
      }
    } catch (err) {
      logger.warn({ err }, 'Semantic Scholar fetch failed');
      for (const doi of uncached) results[doi] = 0;
    }
  }

  return results;
}

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink — single paper
// ──────────────────────────────────────────────

async function fetchPaperDetailFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
) {
  const pool = getPool();
  if (!pool) return null;

  try {
    // Fast path: fetch paper content + versions + retraction only.
    // Accreditation-dependent data (votes, reviews, citations) is loaded
    // lazily via the /enrichment endpoint.
    //
    // The WHERE clause uses validPevoPaperWhere() so a spoofed bridge paper
    // (an unaccredited author posting type=bridge_paper) cannot reach the
    // post-fetch isPevoAnyPaper(meta, author) check — bridge identity is
    // enforced at the SQL layer for defense in depth.
    const detailWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$3', bridgeAccountParam: '$4', source: 'all' });
    // Resolve the continuation chain ONCE up-front and hand it to
    // reconstructVersionsFromHaf to avoid duplicate
    // `fetchHeadAuthorizedAuthors` + chain-walk queries (one each from this
    // function and reconstructVersionsFromHaf). Per task hold-block item 4d.
    // The optional `memo` parameter lets the caller share the
    // per-`(author, permlink)` metadata cache with the backward
    // canonical-root walker (see `findCanonicalRoot`).
    const chain = await resolveContinuationChain(author, permlink, memo, signal);
    // Hoist the accreditation lookups so the cumulative-union construction
    // (further down) and the `accredited_authors` rebuild share the same
    // request-scoped fetches. Both helpers cache 10 min via hafCache so
    // the parallel call is typically free; parallelizing with paperResult
    // / fullVersions / retraction avoids serial latency on cold cache.
    const [paperResult, fullVersions, retraction, accreditedAccountSet, accreditedOrcidsByAccount] = await Promise.all([
      pool.query(
        `SELECT c.author, c.permlink, c.title, c.body, c.json_metadata,
                c.created, c.last_edited
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3
           AND ${detailWhere}`,
        [author, permlink, config.appTag, config.hiveBridgeAccount],
      ),
      reconstructVersionsFromHaf(author, permlink, chain, memo, signal),
      getRetractionInfo(author, permlink),
      getAllAccreditedAccounts(),
      getAccreditedOrcidsByAccount(),
    ]);

    if (paperResult.rows.length === 0) return null;

    const row = paperResult.rows[0];
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta, row.author as string)) return null;

    const detail = buildPaperDetail(row, meta, []);
    const versions = fullVersions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
    detail.versions = versions.length > 0 ? versions : [{ version_number: 1, block_num: 0, created: detail.created as string, title: detail.title as string, is_content_revision: true }];
    detail.is_retracted = retraction.is_retracted;
    detail.retraction_reason = retraction.retraction_reason ?? null;
    detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

    // E7: Use the (already-resolved) continuation chain to set head
    // author/permlink and use the latest version's content/metadata as
    // the displayed paper. `chain` was hoisted above and reused by
    // reconstructVersionsFromHaf to dedupe HAF queries.
    if (chain.length > 1) {
      const head = chain[chain.length - 1];
      detail.head_author = head.author;
      detail.head_permlink = head.permlink;

      // Replace displayed content with the latest version from the chain
      if (fullVersions.length > 0) {
        const latest = fullVersions[fullVersions.length - 1];
        detail.title = latest.title;
        detail.body = latest.body;
        detail.abstract = extractAbstract(latest.body);
        detail.last_update = latest.created;

        // Cumulative-union display construction
        // (`backend-multi-author-cumulative-union.md`).
        //   - `detail.authors[]` is the cumulative union of
        //     `pevo.authors[].hive` across all chain posts (in
        //     first-occurrence order); per-hive sub-fields resolve to the
        //     most-recent self-claim or, absent a self-claim, the
        //     most-recent claim across the chain. ORCID is server-
        //     overridden for accredited hives whose claim diverges from
        //     the on-chain accredited ORCID. Drops are forbidden by
        //     construction (the union only grows; no chain post can
        //     remove a hive that another chain post added). This
        //     supersedes the round-3 no-shrink check; an inversion-prone
        //     check is replaced by a structural invariant. See
        //     `agents/docs/ARCHITECTURE.md` section 2 "Multi-Author Trust
        //     Model" (architect-rewritten at archive of this task).
        //   - `pevo.ipfs_cid` / `pevo.document_hash` / `pevo.ipfs_filename`
        //     apply per-version: each chain post's pointers describe that
        //     version's PDF (alice's v1 has CID_A, bob's v2 may have
        //     CID_B). The default `/api/papers/:author/:permlink` view
        //     reads from the chain head, falling back to the root when
        //     the head doesn't carry the field. `?version=N` reads the
        //     N-th version's metadata via the dedicated
        //     `reconstructVersionsFromHaf` path. All historical CIDs are
        //     preserved on chain (Hive immutability); the pinner agent
        //     retains them per the "Pinner constraint" subsection of the
        //     ARCH spec.
        //   - The risk of bob spoofing his continuation's `ipfs_cid` to a
        //     different paper is treated identically to body-spoof:
        //     accepted risk under the broadcaster-attributed reputation
        //     model with on-chain audit trail and accreditation
        //     revocation as the deterrent.
        //   - Other fields (title, body, abstract, discipline, keywords,
        //     citations, language, supplementary_files) evolve normally
        //     as part of legitimate version progression and are
        //     head-preferred.
        // Phase 2 of `backend-coauthor-trust-model.md` layers the full
        // accept/resign consent ops on top of the cumulative union; the
        // union is monotonic membership, vouched-status decays under
        // resign — orthogonal dimensions.
        const headMeta = latest.json_metadata;
        if (isPevoAnyPaper(headMeta, latest.post_author)) {
          const rootPevo = safePevoMeta(meta);
          const headPevo = safePevoMeta(headMeta);

          // Build per-link latest pevo metadata for the cumulative-union
          // construction. `fullVersions` carries per-version metadata
          // already (each entry tagged with `post_author` / `post_permlink`);
          // the latest version per chain link is whichever entry came
          // last in the version-ordered scan. Iterating `fullVersions` in
          // its existing block_num-ascending order and overwriting on
          // each post-key collision yields the per-link latest metadata
          // without an extra query.
          const latestMetaByLink = new Map<string, Record<string, unknown>>();
          for (const v of fullVersions) {
            latestMetaByLink.set(
              `${v.post_author}/${v.post_permlink}`,
              v.json_metadata,
            );
          }
          const chainPosts = chain.map((link) => ({
            author: link.author,
            permlink: link.permlink,
            pevo: safePevoMeta(latestMetaByLink.get(`${link.author}/${link.permlink}`) ?? {}),
          }));

          const cumulativeAuthors = buildCumulativeAuthorsForChain(
            chainPosts,
            row.author as string,
            row.permlink as string,
            accreditedAccountSet,
            accreditedOrcidsByAccount,
          );

          detail.json_metadata = headMeta;
          detail.authors = cumulativeAuthors;
          detail.discipline = paperDisciplineField(headPevo.discipline);
          detail.keywords = pevoStringArray(headPevo, 'keywords');
          detail.citations = headPevo.citations || [];
          // Per-version display: the IPFS triple (ipfs_cid /
          // ipfs_filename / document_hash) is treated atomically.
          // Either head expresses a per-version triple (any of the
          // three keys is set on head — even to null, '', or a
          // non-string) and the displayed triple is read entirely
          // from head, OR head expresses no opinion (none of the
          // three keys present on head) and the entire triple falls
          // back to root.
          //
          // Why atomic: per-field fallback creates Frankenstein
          // composition (e.g. head's CID + root's filename + root's
          // hash) where the displayed triple never existed on chain
          // in any single version. The block comment above commits
          // to "each post's pointers describe that version's PDF";
          // an atomic triple preserves that invariant.
          //
          // Why sentinel-aware (`'in'` rather than non-null check):
          // a head explicitly clearing the triple (alice's v2 short
          // correction with no PDF, inline body only) is a supported
          // product shape. Distinguishing "head cleared" (key
          // present, value null) from "head omitted" (key absent)
          // preserves that signal end-to-end so a future per-version
          // display surface can read "no PDF for this version" from
          // the chain truthfully — without that distinction, a head
          // explicitly clearing its triple would be indistinguishable
          // from a head that simply didn't restate root's triple, and
          // the displayed CID would silently fall back to root.
          //
          // Note: no current API consumer relies on the head-cleared
          // vs head-omitted distinction (the response surfaces both
          // as `ipfs_cid: null`); the sentinel-aware shape is
          // preemptive future-proofing aligned with the atomic-triple
          // invariant. See round-6 signal block in
          // `agents/docs/tasks/...continuation-post-author-consent-gate.md`.
          //
          // ipfs_cid is additionally passed through `validatedCid`
          // so attacker-controlled chain values that flow from
          // pevo.ipfs_cid through pevoString to the response are
          // shape-checked at the emit boundary; whitespace, control
          // characters, zero-width spaces, and arbitrary garbage
          // are scrubbed to null with a structured warn.
          const headHasAnyTripleKey =
            'ipfs_cid' in headPevo
            || 'ipfs_filename' in headPevo
            || 'document_hash' in headPevo;
          if (headHasAnyTripleKey) {
            detail.ipfs_cid = validatedCid(pevoString(headPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(headPevo, 'ipfs_filename');
            detail.document_hash = pevoString(headPevo, 'document_hash');
          } else {
            detail.ipfs_cid = validatedCid(pevoString(rootPevo, 'ipfs_cid'), {
              author,
              permlink,
            });
            detail.ipfs_filename = pevoString(rootPevo, 'ipfs_filename');
            detail.document_hash = pevoString(rootPevo, 'document_hash');
          }
          detail.language = pevoString(headPevo, 'language') ?? 'en';
          detail.supplementary_files = headPevo.supplementary_files || [];
        }
      }
    }

    // Accreditation: is_accredited + accredited_authors. Use the
    // already-loaded `accreditedAccountSet` (hoisted into the parallel
    // fetch block above) so this rebuild does not re-issue the
    // `getAllAccreditedAccounts` HAF query. `accredited_authors` reads
    // from `detail.authors` (the cumulative-union'd list for chain.length
    // > 1, or `pevo.authors[]` for single-link papers) rather than from
    // `detail.json_metadata`. Reading the union closes round-3 finding #1
    // by construction: a head post that drops a chain author from its own
    // `pevo.authors[]` cannot leak the shrunken set into accreditation
    // because the union still carries the dropped author.
    detail.is_accredited = accreditedAccountSet.has(author);
    const detailAuthors = (detail.authors as Array<Record<string, unknown>>) || [];
    detail.accredited_authors = detailAuthors
      .filter((a) => typeof a.hive === 'string' && accreditedAccountSet.has(a.hive as string))
      .map((a) => (a.hive as string).trim().toLowerCase());

    // Citation count
    const pevo = safePevoMeta(meta);
    if (isPevoBridgePaper(meta, row.author as string)) {
      // External citation count for bridge papers
      const doi = ((pevo.source as Record<string, unknown>)?.doi as string) || null;
      if (doi) {
        const extCounts = await fetchExternalCitationCounts([doi]);
        if (extCounts[doi] !== undefined) detail.citation_count = extCounts[doi];
      }
    } else {
      // Native paper citation count from accredited authors
      const citCte = buildWith(1, activeAccreditationsCteBody);
      const citAppTag = `$${citCte.nextIdx}`;
      const citAppLike = `$${citCte.nextIdx + 1}`;
      const citJson = `$${citCte.nextIdx + 2}`;
      const citResult = await pool.query(
        `${citCte.sql}
         SELECT count(*)::int AS cnt FROM ${T.comments} ci
         JOIN active_accreditations aa ON aa.account = ci.author
         WHERE ci.parent_author = '' AND ci.parent_permlink = ${citAppTag}
           AND (ci.json_metadata -> ${citAppTag} ->> 'type') = 'paper'
           AND ci.json_metadata ->> 'app' LIKE ${citAppLike}
           AND ci.json_metadata -> ${citAppTag} -> 'citations' @> ${citJson}::jsonb`,
        [...citCte.params, config.appTag, `${config.appTag}/%`, JSON.stringify([{ author, permlink }])],
      );
      detail.citation_count = citResult.rows[0]?.cnt ?? 0;
    }

    return detail;
  } catch (err) {
    logger.error({ err }, 'HAF paper detail query failed');
    return null;
  }
}

// ──────────────────────────────────────────────
// Version history resolution (on-chain edits)
// ──────────────────────────────────────────────

import { diff_match_patch as DiffMatchPatch } from 'diff-match-patch';

const dmp = new DiffMatchPatch();

interface PaperVersionEntry {
  version_number: number;
  block_num: number;
  created: string;
  title: string;
  is_content_revision: boolean;
  author?: string;
  permlink?: string;
  addresses_reviews?: Array<{ author: string; permlink: string }>;
}

// ──────────────────────────────────────────────
// E1 — Continuation chain resolution
// ──────────────────────────────────────────────

interface ChainLink {
  author: string;
  permlink: string;
}

/**
 * Per-request memo for `fetchHeadAuthorizedAuthors` results, keyed by
 * `"author/permlink"`. Threaded into the forward (`resolveContinuationChain`)
 * and backward (`findCanonicalRoot`) walkers so the two halves of a single
 * request reuse the same metadata fetches. Bounded by request lifetime
 * (a fresh map per route handler invocation; map drops out of scope when
 * the handler returns) so there is no cross-request leak. Stores `null`
 * for posts that are not valid PEvO papers (negative cache) so a repeat
 * lookup does not re-issue the SQL query.
 */
type HeadAuthorsMemo = Map<string, Set<string> | null>;

function makeHeadAuthorsMemo(): HeadAuthorsMemo {
  return new Map();
}

function memoKey(author: string, permlink: string): string {
  return `${author}/${permlink}`;
}

/**
 * Fetch the head (root) paper's authorized continuation-author set: the
 * `hive` field values from the head paper's `pevo.authors[]`, narrowed to
 * the case where the row at `(author, permlink)` is a valid PEvO paper
 * (native or bridge, identity-pinned via `isPevoAnyPaper`).
 *
 * Returns `null` if the head is not a valid PEvO paper (no chain to admit
 * into) — callers should treat this as "no continuations admitted".
 *
 * Optionally accepts a per-request `HeadAuthorsMemo` so forward + backward
 * walkers within the same request reuse fetched metadata. Both `null` and
 * `Set` results are cached.
 *
 * This is the per-resource vouched-identity set the continuation gate
 * checks against. See
 * `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
 */
async function fetchHeadAuthorizedAuthors(
  pool: NonNullable<ReturnType<typeof getPool>>,
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const key = memoKey(author, permlink);
  if (memo && memo.has(key)) {
    return memo.get(key) ?? null;
  }
  // Defense-in-depth abort check. The walker loops check `signal?.aborted`
  // at iteration boundaries (the primary gate), but a future caller
  // outside a walker loop should still self-protect against an exhausted
  // budget. Fail-closed (return null) matches the existing "head is not a
  // valid PEvO paper" return shape, so callers handle abort identically
  // to a benign no-result.
  if (signal?.aborted) {
    memo?.set(key, null);
    return null;
  }
  try {
    const result = await pool.query(
      `SELECT c.author, c.json_metadata
       FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3`,
      [author, permlink, config.appTag],
    );
    if (result.rows.length === 0) {
      memo?.set(key, null);
      return null;
    }
    const row = result.rows[0] as Record<string, unknown>;
    // Type-narrow row.author: HAF could in principle return NULL; the
    // gate must fail-closed. A bare `as string` would silently coerce
    // undefined/null and let downstream identity checks evaluate against
    // a non-string — better to bail explicitly.
    if (typeof row.author !== 'string') {
      memo?.set(key, null);
      return null;
    }
    const meta = parseMeta(row.json_metadata);
    if (!isPevoAnyPaper(meta, row.author)) {
      memo?.set(key, null);
      return null;
    }
    const pevo = safePevoMeta(meta);
    const set = extractAuthorizedContinuationAuthors(pevo, row.author);
    memo?.set(key, set);
    return set;
  } catch (err) {
    logger.error({ err }, 'Head authorized-authors lookup failed');
    // Memoize the null on failure too. Documented contract on lines
    // 826-827 says "Both null and Set results are cached"; without this
    // set, a single request hitting canonical-walker + a second
    // `fetchPaperDetailFromHaf` + `reconstructVersionsFromHaf` re-fires
    // the failing query 3+ times under degraded HAF, each blocking for
    // the full statement_timeout.
    memo?.set(key, null);
    return null;
  }
}

/**
 * Resolve the continuation chain starting from a canonical (root) post.
 * Follows `json_metadata -> appTag -> 'continues'` pointers iteratively.
 * Returns ordered array starting with the root post, ending at the chain head.
 * Uses block_num to resolve collisions (earliest wins). 50-hop safety cap.
 *
 * **Author-consent gate (cumulative-union under
 * `backend-multi-author-cumulative-union.md`).** A candidate continuation
 * post `C` is admitted at hop N only if BOTH:
 *
 *   1. `C.author` (chain-level) is in the cumulative union of
 *      `pevo.authors[].hive` extracted from chain posts `0..N-1` (i.e., all
 *      predecessors). The cumulative starts at the root's contribution and
 *      grows as each admitted candidate's `pevo.authors[]` contributes new
 *      hives. This encodes the equal-rights authorship policy: any author
 *      currently in the chain's authors[] can broadcast continuations
 *      regardless of when they were added; trust is dynamic and the cost
 *      of a bad invitation falls on the introducer via accreditation
 *      cascade.
 *
 *   2. `C` is itself a valid PEvO paper class — native paper, or the
 *      bridge-paper variant pinned to `config.hiveBridgeAccount` (per
 *      `validPevoPaperWhere` / `isPevoAnyPaper`). Without this
 *      object-identity check, a named co-author could post a review-typed
 *      comment with `pevo.continues={...}` and have the review content
 *      surface as the paper's apparent body via the version walker. The
 *      convention is "every gate enforces author + type identity
 *      together"; see
 *      `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`.
 *
 * Both predicates are enforced SQL-side (the DB never returns disallowed
 * candidates) AND JS-side as defense in depth. The cumulative `$N::text[]`
 * parameter regenerates each iteration with the union built so far. If the
 * root paper is not a valid PEvO paper or has no named authors, the chain
 * degenerates to the root only — no continuations are admitted.
 *
 * **Bridge-paper Option-b** is preserved by construction: the root's
 * contribution for `pevo.type === 'bridge_paper'` is `{bridgeAccount}` (per
 * `extractAuthorizedContinuationAuthors`); each admitted bridge-paper
 * candidate's contribution is also `{bridgeAccount}`, so the cumulative
 * stays locked to `{bridgeAccount}` for bridge chains. Bridge papers are
 * immutable post-publish, which makes `chain.length === 1` for bridge
 * papers in practice; the cumulative-extension path here is defense-in-depth.
 */
async function resolveContinuationChain(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ChainLink[]> {
  const pool = getPool();
  if (!pool) return [{ author, permlink }];

  // Capture entry time so wall-clock-exceeded warns carry the elapsed
  // signal that operators need to distinguish "budget tripped early"
  // from "budget tripped after legitimate slow hops".
  const startedAt = Date.now();

  const chain: ChainLink[] = [{ author, permlink }];

  // Pre-loop abort check. The route-handler-bounded `AbortController`
  // could already have fired before we issued the seed fetch (e.g., a
  // sibling backward-walker call burned the budget); fail-closed to a
  // root-only chain rather than starting a forward walk we can't finish.
  if (signal?.aborted) {
    logger.warn(
      {
        event: 'continuation_chain_wall_clock_exceeded',
        startAuthor: author,
        startPermlink: permlink,
        hopIndex: 0,
        elapsedMs: Date.now() - startedAt,
      },
      'continuation chain walker aborted: wall-clock budget exceeded before seed fetch',
    );
    return chain;
  }

  // Seed the cumulative admit-set from the root's contribution. The root's
  // contribution is the full cumulative for hop 0 (no predecessors beyond
  // the root itself).
  const rootAuthorizedAuthors = await fetchHeadAuthorizedAuthors(pool, author, permlink, memo, signal);
  if (!rootAuthorizedAuthors || rootAuthorizedAuthors.size === 0) {
    // Root is not a valid PEvO paper, or has no named authors. No
    // continuations are admitted; chain is root-only.
    return chain;
  }

  // Cumulative admit-set, seeded from root. Extended in-place after each
  // admitted hop with the candidate's contribution.
  const cumulative = new Set<string>(rootAuthorizedAuthors);

  let currentAuthor = author;
  let currentPermlink = permlink;
  // MAX_HOPS = 50. Per-request worst-case latency under degraded HAF:
  // 50 hops × ≥1 sequential SQL query × 30s statement_timeout (`db.ts:22`)
  // = up to 1500s (~25 min) per request before the depth cap exits.
  // The depth cap is the attacker-amplifier defense; the wall-clock
  // budget threaded via `signal?: AbortSignal` (and the route-handler
  // `config.hafWalkerWallClockMs`-bounded `AbortController`) bounds the
  // degraded-HAF tail independently of hop count. Both signals coexist
  // because a long legitimate chain under fast HAF is depth-bounded but
  // not wall-clock-pressured. See
  // `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
  const MAX_HOPS = 50;

  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      // Wall-clock budget check at each iteration boundary. When BOTH the
      // depth cap and the wall-clock budget would fire on the same
      // request, the wall-clock signal takes priority (operator-actionable
      // degraded-HAF signal vs the depth cap's attacker-amplifier signal)
      // because we check the budget BEFORE the depth-cap exit condition
      // at line `i < MAX_HOPS`. See task acceptance section 3.
      if (signal?.aborted) {
        logger.warn(
          {
            event: 'continuation_chain_wall_clock_exceeded',
            startAuthor: author,
            startPermlink: permlink,
            hopIndex: i,
            elapsedMs: Date.now() - startedAt,
          },
          'continuation chain walker aborted: wall-clock budget exceeded mid-walk',
        );
        return chain;
      }
      const cumulativeArr = Array.from(cumulative);
      // Find any post whose continues field points to the current head AND
      // whose author is in the cumulative authorized-authors set built from
      // the chain so far AND whose pevo.type is a valid PEvO paper class
      // (native paper or the bridge-paper variant pinned to the bridge
      // account, per validPevoPaperWhere). SQL-side filtering via
      // $4::text[] (cumulative author-set) + validPevoPaperWhere
      // (object-identity) is the primary gate; the JS-side re-checks below
      // are defense in depth. The $4 array is rebuilt each iteration to
      // reflect the cumulative grown by prior hops.
      const validPaperPredicate = validPevoPaperWhere({
        commentAlias: 'c',
        appTagParam: '$3',
        bridgeAccountParam: '$5',
        source: 'all',
      });
      const result = await pool.query(
        `SELECT c.author, c.permlink, c.json_metadata, co.block_num
         FROM ${T.comments} c
         JOIN ${T.commentOps} co ON co.author = c.author AND co.permlink = c.permlink
         WHERE c.parent_author = ''
           AND c.parent_permlink = $3
           AND c.json_metadata -> $3 -> 'continues' ->> 'author' = $1
           AND c.json_metadata -> $3 -> 'continues' ->> 'permlink' = $2
           AND c.author = ANY($4::text[])
           AND ${validPaperPredicate}
         ORDER BY co.block_num ASC
         LIMIT 1`,
        [currentAuthor, currentPermlink, config.appTag, cumulativeArr, config.hiveBridgeAccount],
      );

      if (result.rows.length === 0) break;

      const next = result.rows[0];
      const candidateAuthor = next.author;
      // Type-narrow: HAF could in principle return NULL author. Bare
      // `as string` would coerce undefined/null silently. Bail explicitly
      // (fail-closed: chain ends at the previous hop).
      if (typeof candidateAuthor !== 'string') break;

      // Defense in depth: re-verify (a) author in cumulative authorized
      // set, (b) the candidate's pevo.type is a valid paper class. A drift
      // between the JS gate and the SQL gate (e.g. a future SQL refactor
      // that drops one of the predicates) would be caught here.
      if (!cumulative.has(candidateAuthor)) {
        logger.warn(
          { rootAuthor: author, rootPermlink: permlink, candidateAuthor },
          'continuation candidate slipped past SQL cumulative author-set gate; rejecting at JS layer',
        );
        break;
      }
      const candidateMeta = parseMeta(next.json_metadata);
      if (!isPevoAnyPaper(candidateMeta, candidateAuthor)) {
        logger.warn(
          { rootAuthor: author, rootPermlink: permlink, candidateAuthor, candidatePermlink: next.permlink },
          'continuation candidate slipped past SQL pevo-type gate; rejecting at JS layer',
        );
        break;
      }
      currentAuthor = candidateAuthor;
      currentPermlink = next.permlink as string;
      chain.push({ author: currentAuthor, permlink: currentPermlink });

      // Extend cumulative with the admitted candidate's contribution.
      // For bridge-paper candidates, the contribution is `{bridgeAccount}`
      // (no change to cumulative since bridge roots already seed it).
      // For native paper candidates, the contribution is their
      // `pevo.authors[].hive` set — admitting authors invited mid-chain
      // for subsequent hops.
      const candidateContrib = extractAuthorizedContinuationAuthors(
        safePevoMeta(candidateMeta),
        candidateAuthor,
      );
      for (const a of candidateContrib) cumulative.add(a);
    }
  } catch (err) {
    logger.error({ err }, 'Continuation chain resolution failed');
  }

  return chain;
}

/**
 * Maximum hops the backward canonical-root walker is allowed to take.
 *
 * `findCanonicalRoot` walks attacker-controlled `pevo.continues` pointers,
 * one SQL query per hop. Without a cap, an attacker can post a chain of
 * 51+ continuation posts and induce that many DB queries per request to
 * the deepest one — a per-request DoS amplifier. The PEvO-realistic
 * version-chain depth is in the low single digits; 10 is a generous
 * ceiling that absorbs unusual edit cadences without giving an attacker
 * a 50× amplification factor. Beyond the cap the walker stops at the
 * current node and emits a structured warn so operators can detect
 * attack patterns.
 *
 * Per-request worst-case latency under degraded HAF: 10 hops × 2
 * sequential SQL queries (auth-check + parent-continues) × 30s
 * statement_timeout (`db.ts:22`) = up to 600s (10 min) per request
 * before the depth cap exits. The depth cap is the attacker-amplifier
 * defense; the wall-clock budget threaded via `signal?: AbortSignal`
 * (and the route-handler `config.hafWalkerWallClockMs`-bounded
 * `AbortController`) bounds the degraded-HAF tail independently of hop
 * count. Both signals coexist because a long legitimate chain under
 * fast HAF is depth-bounded but not wall-clock-pressured. See
 * `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`.
 */
const CANONICAL_ROOT_MAX_HOPS = 10;

/**
 * Discriminator for `event: 'canonical_root_walker_start_invalid'` log
 * payloads. Named-literal-union so misspellings fail at compile time and
 * any future bail path is the obvious extension point.
 */
type CanonicalRootBailReason =
  | 'sql_filter_or_missing'
  | 'js_is_pevo_any_paper'
  | 'cont_columns_invalid';

/**
 * Walk backward from a continuation post to find the canonical (root) post.
 * Returns null if the given post is not a continuation.
 *
 * **Author-consent gate (BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE).**
 * At every backward hop, the walker enforces: the post we are walking FROM
 * (the child claiming a `continues` predecessor) must be authored by an
 * account that the predecessor's `pevo.authors[]` (or bridge-paper Option b)
 * authorizes as a continuator. This mirrors the forward gate in
 * `resolveContinuationChain`. Without the gate, an attacker can post
 * `attacker/fake-paper` with `pevo.continues = {alice, paper-v1}` and
 * `/api/papers/attacker/fake-paper` would resolve back to alice's content,
 * giving the attacker URL the appearance of alice's paper — a phishing
 * pretext. The gate breaks the chain at the first unauthorized hop and
 * returns the *child* of that hop as the canonical root, so the URL
 * displays only the attacker's own content.
 *
 * **Depth cap.** Hard-bounded at `CANONICAL_ROOT_MAX_HOPS` (see constant
 * above) to prevent attacker-induced DoS amplification.
 *
 * **Per-request memo.** Optionally accepts a `HeadAuthorsMemo` so the
 * forward and backward walkers in the same request share the per-post
 * `(author, permlink)` metadata fetch.
 */
async function findCanonicalRoot(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ChainLink | null> {
  const pool = getPool();
  if (!pool) {
    // Level discipline for canonical_root_walker_* events:
    //   - logger.warn — rare attack-signal or data-integrity paths worth
    //     operator alerting at default LOG_LEVEL=info.
    //   - logger.debug — high-frequency benign paths where warn would
    //     drown signal in noise; production must opt in via LOG_LEVEL=debug
    //     (see pino-spy-level-filter-ordering-trap-2026-05-07.md).
    // The CanonicalRootBailReason type alias is the single source of truth
    // for which reasons exist; pick the level per-reason against this rule.
    // Peer walker events (unauthorized_hop, depth_exceeded, walker_error)
    // follow the same rule, similarly graduated by frequency vs severity.
    logger.warn(
      {
        event: 'canonical_root_walker_no_pool',
        startAuthor: author,
        startPermlink: permlink,
      },
      'canonical-root walker bailed: HAF pool unavailable',
    );
    return null;
  }

  // Capture entry time so wall-clock-exceeded warns carry the elapsed
  // signal that operators need to distinguish "budget tripped early"
  // from "budget tripped after legitimate slow hops".
  const startedAt = Date.now();

  // Pre-initial-probe abort check. The route handler's `AbortController`
  // could already have fired before we issued any SQL (e.g., a sibling
  // forward-walker call burned the budget); fail-closed to "no canonical
  // root" rather than issuing a probe we can't honor. Returning null
  // matches the existing "not a continuation post" return shape, so
  // callers handle abort identically to a benign no-result. Walker-level
  // wall-clock warn is emitted at the abort site so operators see a
  // discriminating event tag rather than just a silent return.
  if (signal?.aborted) {
    logger.warn(
      {
        event: 'canonical_root_walker_wall_clock_exceeded',
        startAuthor: author,
        startPermlink: permlink,
        hopIndex: 0,
        elapsedMs: Date.now() - startedAt,
      },
      'canonical-root walker aborted: wall-clock budget exceeded before initial probe',
    );
    return null;
  }

  try {
    // Check if this post has a 'continues' field. We also need the post's
    // own author + metadata so the next-hop gate can verify "child author
    // is in predecessor's authorized-authors set" AND so we can re-check
    // the START's `pevo.type` is a valid paper class JS-side.
    //
    // Type-spoof on START gate: a vouched co-author Bob (in alice/v1's
    // pevo.authors[]) could otherwise post `bob/spoof-review` with
    // `pevo.type = 'review'` AND `pevo.continues = {alice, v1}`. Without
    // a type filter on this initial probe, the URL `/api/papers/bob/spoof-review`
    // would walk back through the gate (alice's authorized set includes
    // bob → admits) and surface alice/v1 as canonical, rendering alice's
    // paper content under bob's URL. The convention is "every gate
    // enforces author + type identity together" (see
    // `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`).
    // SQL-side filter via `validPevoPaperWhere(source: 'all')` is the
    // primary gate; the JS-side `isPevoAnyPaper` re-check below is
    // defense in depth.
    const startTypeFilter = validPevoPaperWhere({
      commentAlias: 'c',
      appTagParam: '$3',
      bridgeAccountParam: '$4',
      source: 'all',
    });
    const result = await pool.query(
      `SELECT c.author, c.json_metadata,
              c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
              c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
       FROM ${T.comments} c
       WHERE c.author = $1 AND c.permlink = $2
         AND c.parent_author = '' AND c.parent_permlink = $3
         AND c.json_metadata -> $3 -> 'continues' IS NOT NULL
         AND ${startTypeFilter}`,
      [author, permlink, config.appTag, config.hiveBridgeAccount],
    );

    if (result.rows.length === 0) {
      // Either the post does not exist, has no `continues` pointer, or the
      // SQL-side `validPevoPaperWhere` filter rejected it (e.g. type-spoof:
      // pevo.type='review' on a post claiming to continue a paper). Tagged
      // `sql_filter_or_missing` so a layer-pinning canary can pin the SQL
      // filter as the kill mechanism.
      //
      // Emitted at debug because this fires on every 404 lookup of a
      // non-PEvO post. Production observability requires `LOG_LEVEL=debug`.
      // The canary spy in `canonical-root-walker.test.ts` intercepts at
      // the logger-object boundary, BEFORE pino's level filter, so canary
      // green does NOT imply this event is visible at `LOG_LEVEL=info`.
      // See `agents/docs/solutions/conventions/pino-spy-level-filter-ordering-trap-2026-05-07.md`.
      const reason: CanonicalRootBailReason = 'sql_filter_or_missing';
      logger.debug(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: SQL filter rejected or no row',
      );
      return null;
    }

    // JS-side defense-in-depth re-check that the START is itself a valid
    // PEvO paper (native or bridge, identity-pinned). A drift between the
    // SQL `validPevoPaperWhere` filter and the JS `isPevoAnyPaper` check
    // (e.g. a future SQL refactor that drops the type predicate, or a
    // future HAF column-shape change) would be caught here.
    const startRow = result.rows[0] as Record<string, unknown>;
    const startMeta = parseMeta(startRow.json_metadata);
    if (typeof startRow.author !== 'string' || !isPevoAnyPaper(startMeta, startRow.author)) {
      // SQL filter let this row through but the JS-side identity-pinned
      // re-check rejected it. Tagged `js_is_pevo_any_paper` so a layer-
      // pinning canary can pin the JS check as the kill mechanism.
      // Level: warn (per discipline comment at the no_pool branch above).
      const reason: CanonicalRootBailReason = 'js_is_pevo_any_paper';
      logger.warn(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: JS isPevoAnyPaper re-check failed',
      );
      return null;
    }

    // Type-narrow the cont_author / cont_permlink columns. HAF could in
    // principle return NULL columns; bare `as string` would silently
    // coerce undefined/null and let downstream identity checks evaluate
    // against a non-string. Round-2 hold item 3 of the FORWARD walker
    // task explicitly forbade `as` casts on the security path; mirror
    // the migrated pattern at `fetchHeadAuthorizedAuthors`.
    if (typeof startRow.cont_author !== 'string' || typeof startRow.cont_permlink !== 'string') {
      // Level: warn (per discipline comment at the no_pool branch above).
      // The IS NOT NULL SQL guard should prevent reaching this branch in
      // practice; if we do, it's a HAF data-integrity surprise worth alerting.
      const reason: CanonicalRootBailReason = 'cont_columns_invalid';
      logger.warn(
        {
          event: 'canonical_root_walker_start_invalid',
          reason,
          startAuthor: author,
          startPermlink: permlink,
        },
        'canonical-root walker rejected START: cont_author/cont_permlink not string',
      );
      return null;
    }

    // The hop being considered is FROM `(childAuthor, childPermlink)` TO
    // `(currentAuthor, currentPermlink)` (the predecessor). To accept the
    // hop, `childAuthor` must be in the predecessor's authorized-authors
    // set (per `extractAuthorizedContinuationAuthors`).
    let childAuthor: string = author;
    let childPermlink: string = permlink;
    let currentAuthor: string = startRow.cont_author;
    let currentPermlink: string = startRow.cont_permlink;

    for (let i = 0; i < CANONICAL_ROOT_MAX_HOPS; i++) {
      // Wall-clock budget check at each iteration boundary. When BOTH the
      // depth cap and the wall-clock budget would fire on the same
      // request, the wall-clock signal takes priority (operator-actionable
      // degraded-HAF signal vs the depth cap's attacker-amplifier signal)
      // because we check the budget BEFORE the depth-cap exit condition
      // at line `i < CANONICAL_ROOT_MAX_HOPS`. See task acceptance section 3.
      if (signal?.aborted) {
        logger.warn(
          {
            event: 'canonical_root_walker_wall_clock_exceeded',
            startAuthor: author,
            startPermlink: permlink,
            hopIndex: i,
            elapsedMs: Date.now() - startedAt,
          },
          'canonical-root walker aborted: wall-clock budget exceeded mid-walk',
        );
        return { author: currentAuthor, permlink: currentPermlink };
      }

      // Author-consent gate on the current hop: fetch the predecessor's
      // (current's) authorized-authors set. If `childAuthor` is not in it,
      // the chain is broken at this hop — return the CHILD as canonical
      // (the unauthorized predecessor pointer is rejected).
      const authorizedAuthors = await fetchHeadAuthorizedAuthors(
        pool,
        currentAuthor,
        currentPermlink,
        memo,
        signal,
      );
      if (!authorizedAuthors || !authorizedAuthors.has(childAuthor)) {
        logger.warn(
          {
            event: 'canonical_root_walker_unauthorized_hop',
            hopNumber: i + 1,
            childAuthor,
            childPermlink,
            predecessorAuthor: currentAuthor,
            predecessorPermlink: currentPermlink,
          },
          'canonical-root walker rejected hop: child author not in predecessor\'s authorized-authors set',
        );
        return { author: childAuthor, permlink: childPermlink };
      }

      // Hop accepted. Look up the predecessor's own continues pointer to
      // see if the walk continues another step.
      //
      // SQL-side `'continues' IS NOT NULL` filter mirrors the initial
      // probe's discipline: the SQL is the SSoT for "this post has a
      // continues pointer", not the JS-side `!cont_author` post-check.
      // Without this predicate, the loop-continuation probe and the
      // initial probe drift on the same semantic property — the kind of
      // asymmetry adversarial review flagged at the canonical-walker
      // round-2 triage (2026-05-06). Loop semantics are safe: the
      // `(currentAuthor, currentPermlink)` state is tracked OUTSIDE the
      // SQL result (advanced at the END of each iteration from
      // `parentRow.cont_author`/`cont_permlink`), so the 0-row case here
      // correctly returns the predecessor accumulated so far, identical
      // to the previous `!parentRow.cont_author` JS bail.
      const parentResult = await pool.query(
        `SELECT c.json_metadata -> $3 -> 'continues' ->> 'author' AS cont_author,
                c.json_metadata -> $3 -> 'continues' ->> 'permlink' AS cont_permlink
         FROM ${T.comments} c
         WHERE c.author = $1 AND c.permlink = $2
           AND c.parent_author = '' AND c.parent_permlink = $3
           AND c.json_metadata -> $3 -> 'continues' IS NOT NULL`,
        [currentAuthor, currentPermlink, config.appTag],
      );

      if (parentResult.rows.length === 0 || !parentResult.rows[0].cont_author) {
        // currentAuthor/currentPermlink is the root.
        return { author: currentAuthor, permlink: currentPermlink };
      }

      // Type-narrow: HAF could in principle return NULL cont_author /
      // cont_permlink. Bare `as string` would silently coerce; bail
      // explicitly (fail-closed: return current as the deepest verified
      // root rather than walking with an undefined identity).
      const parentRow = parentResult.rows[0] as Record<string, unknown>;
      if (typeof parentRow.cont_author !== 'string' || typeof parentRow.cont_permlink !== 'string') {
        return { author: currentAuthor, permlink: currentPermlink };
      }

      childAuthor = currentAuthor;
      childPermlink = currentPermlink;
      currentAuthor = parentRow.cont_author;
      currentPermlink = parentRow.cont_permlink;
    }

    // Depth cap exceeded: stop walking and return the deepest verified
    // node as canonical. Emit a structured warn so operators can detect
    // attacker-induced amplification patterns.
    logger.warn(
      {
        // Note: `hopNumber` is intentionally omitted on this event because it
        // would always equal `maxHops` by construction (the cap is what
        // triggered the warn). `hopNumber` retains its meaningful
        // varying-value role on `canonical_root_walker_unauthorized_hop`.
        event: 'canonical_root_walker_depth_exceeded',
        startAuthor: author,
        startPermlink: permlink,
        stopAuthor: currentAuthor,
        stopPermlink: currentPermlink,
        maxHops: CANONICAL_ROOT_MAX_HOPS,
      },
      'canonical-root walker exceeded depth cap; stopping walk',
    );
    return { author: currentAuthor, permlink: currentPermlink };
  } catch (err) {
    logger.error(
      {
        event: 'canonical_root_walker_error',
        err,
        startAuthor: author,
        startPermlink: permlink,
      },
      'Canonical root lookup failed',
    );
    return null;
  }
}

/** A fully reconstructed version with body content. */
interface ReconstructedVersion extends PaperVersionEntry {
  body: string;
  json_metadata: Record<string, unknown>;
  /** Author of the post this version came from (for continuation chains). */
  post_author: string;
  /** Permlink of the post this version came from (for continuation chains). */
  post_permlink: string;
}

/**
 * Apply a Hive `@@`-format diff patch to a base string.
 * If the body does NOT start with `@@`, it's treated as a full replacement.
 */
function applyHivePatch(base: string, raw: string): string {
  if (!raw.startsWith('@@')) return raw;
  const patches = dmp.patch_fromText(raw);
  const [result] = dmp.patch_apply(patches, base);
  return result;
}

/**
 * Fetch all comment operations and reconstruct full body at each version
 * by replaying `@@` diff patches. Resolves continuation chains: fetches
 * operations for all posts in the chain, ordered by block_num.
 * Continuation post first operations are always full body (not diffs of
 * the previous chain link). Returns versions in chronological order.
 *
 * @param prefetchedChain - optionally pass the already-resolved continuation
 *   chain to avoid duplicate `resolveContinuationChain`/`fetchHeadAuthorizedAuthors`
 *   queries. `fetchPaperDetailFromHaf` resolves the chain itself; passing it
 *   in here halves the HAF query count for an uncached paper-detail request.
 * @param memo - optional per-request `HeadAuthorsMemo` so the internal
 *   `resolveContinuationChain` call shares cached metadata fetches with the
 *   request's other walkers (the backward `findCanonicalRoot` and the
 *   primary `fetchPaperDetailFromHaf` forward walk). Without this, the
 *   `?version=N` cache-miss branch and the metadata-restored fallback both
 *   re-fire the head-authors lookup, defeating the per-request memo.
 */
async function reconstructVersionsFromHaf(
  author: string,
  permlink: string,
  prefetchedChain?: ChainLink[],
  memo?: HeadAuthorsMemo,
  signal?: AbortSignal,
): Promise<ReconstructedVersion[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Resolve continuation chain to get all (author, permlink) pairs.
    // Caller may pass it in to avoid the duplicate fetch.
    const chain = prefetchedChain ?? await resolveContinuationChain(author, permlink, memo, signal);

    // Defense-in-depth abort check before the per-chain version replay
    // query. The forward walker (`resolveContinuationChain`) emits its
    // own wall-clock warn on abort; if budget tripped during that walk
    // the chain is partial — proceed with the partial chain rather than
    // throwing, mirroring how the function handles other no-result paths.
    if (signal?.aborted) return [];

    // Build a query that fetches operations for ALL posts in the chain
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;
    for (const link of chain) {
      conditions.push(`(co.author = $${paramIdx++} AND co.permlink = $${paramIdx++})`);
      params.push(link.author, link.permlink);
    }

    const result = await pool.query(
      `SELECT
         ROW_NUMBER() OVER (ORDER BY co.block_num)::int AS version_number,
         co.block_num,
         co.author,
         co.permlink,
         co.title,
         co.body,
         co.timestamp AS created,
         co.json_metadata
       FROM ${T.commentOps} co
       WHERE ${conditions.join(' OR ')}
       ORDER BY co.block_num ASC`,
      params,
    );

    const rows = result.rows as Array<Record<string, unknown>>;
    const versions: ReconstructedVersion[] = [];
    // Track per-post body state for diff application (diffs are per-post, not cross-post)
    const bodyByPost = new Map<string, string>();
    let prevTitle = '';
    let lastGoodMeta: Record<string, unknown> | null = null;
    // Track which posts we've seen their first operation for
    const seenFirstOp = new Set<string>();
    // Track per-post pevo.authors[] state for the audit-log: emit a warn
    // event whenever a paper edit mutates pevo.authors[] (TOCTOU residual
    // mitigation per task hold-block item 4b — operators correlate
    // post-incident).
    const authorsByPost = new Map<string, string>();

    for (const r of rows) {
      const postKey = `${r.author}/${r.permlink}`;
      const rawBody = (r.body as string) || '';
      const rawTitle = (r.title as string) || '';

      const isFirstOpForPost = !seenFirstOp.has(postKey);
      seenFirstOp.add(postKey);

      const prevBodyForPost = bodyByPost.get(postKey) || '';
      let body: string;

      if (isFirstOpForPost && chain.length > 1 && postKey !== `${chain[0].author}/${chain[0].permlink}`) {
        // Continuation post first operation: always full body (not diff of previous chain link)
        body = rawBody;
      } else {
        // Same-post edit: apply diff against previous body of THIS post
        body = applyHivePatch(prevBodyForPost, rawBody);
      }
      bodyByPost.set(postKey, body);

      const title = rawTitle || prevTitle;

      const isContentRevision =
        versions.length === 0 || body !== prevBodyForPost || title !== prevTitle || isFirstOpForPost;

      let meta = parseMeta(r.json_metadata);

      if (isPevoAnyPaper(meta, r.author as string)) {
        lastGoodMeta = meta;
      } else if (lastGoodMeta) {
        meta = { ...meta, app: lastGoodMeta.app, [config.appTag]: lastGoodMeta[config.appTag] };
      }

      // Extract addresses_reviews from version metadata
      const pevo = safePevoMeta(meta);
      const addressesReviews = (pevo.addresses_reviews as Array<{ author: string; permlink: string }>) || undefined;

      // Audit log: emit a structured warn whenever a paper edit mutates
      // `pevo.authors[]`. Pairs with the head-meta override subset-check
      // above to provide post-incident operator correlation for the
      // TOCTOU author-set-expansion concern (task hold-block item 4b).
      // Compare structurally (JSON stringify) so any change to the array
      // shape — add, remove, reorder, hive-rename — surfaces an event.
      const authorsRaw = Array.isArray(pevo.authors) ? pevo.authors : [];
      const authorsKey = JSON.stringify(authorsRaw);
      const prevAuthorsKey = authorsByPost.get(postKey);
      if (prevAuthorsKey !== undefined && prevAuthorsKey !== authorsKey) {
        logger.warn(
          {
            event: 'paper_authors_metadata_edit',
            postAuthor: r.author as string,
            postPermlink: r.permlink as string,
            blockNum: Number(r.block_num),
            prevAuthors: prevAuthorsKey,
            newAuthors: authorsKey,
          },
          'paper edit mutated pevo.authors[]',
        );
      }
      authorsByPost.set(postKey, authorsKey);

      versions.push({
        version_number: r.version_number as number,
        block_num: Number(r.block_num),
        created: r.created as string,
        title,
        body,
        is_content_revision: isContentRevision,
        json_metadata: meta,
        post_author: r.author as string,
        post_permlink: r.permlink as string,
        author: r.author as string,
        permlink: r.permlink as string,
        addresses_reviews: addressesReviews,
      });

      prevTitle = title;
    }

    return versions;
  } catch (err) {
    logger.error({ err }, 'HAF version reconstruction failed');
    return [];
  }
}

/** Return version metadata only (no bodies). */
async function resolveVersionsFromHaf(
  author: string,
  permlink: string,
  memo?: HeadAuthorsMemo,
): Promise<PaperVersionEntry[]> {
  const versions = await reconstructVersionsFromHaf(author, permlink, undefined, memo);
  return versions.map(({ body: _body, json_metadata: _meta, post_author: _pa, post_permlink: _pp, ...entry }) => entry);
}

interface RetractionEntry {
  author: string;
  permlink: string;
  reason: string | null;
  timestamp: string | null;
}

async function loadRetractedPapers(): Promise<RetractionEntry[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT
       cj.json::jsonb ->> 'author' AS author,
       cj.json::jsonb ->> 'permlink' AS permlink,
       cj.json::jsonb ->> 'reason' AS reason,
       cj.json::jsonb ->> 'timestamp' AS ts
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'retract_paper'
       AND cj.block_num >= $2`,
    [config.appTag, getCachedGenesisBlock()],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    author: r.author as string,
    permlink: r.permlink as string,
    reason: (r.reason as string) || null,
    timestamp: (r.ts as string) || null,
  }));
}

async function getRetractionInfo(author: string, permlink: string): Promise<{ is_retracted: boolean; retraction_reason?: string | null; retraction_timestamp?: string | null }> {
  try {
    const allRetracted = await hafCache.get<RetractionEntry[]>('retracted-papers') ?? [];
    const entry = allRetracted.find((r) => r.author === author && r.permlink === permlink);
    if (entry) {
      return { is_retracted: true, retraction_reason: entry.reason, retraction_timestamp: entry.timestamp };
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load retracted papers');
  }
  return { is_retracted: false, retraction_reason: null, retraction_timestamp: null };
}

/** Register periodic refresh for retracted papers cache. */
export async function startRetractionCache(): Promise<void> {
  await hafCache.registerPeriodicRefresh('retracted-papers', loadRetractedPapers, 24 * 60 * 60_000);
  logger.info('Retracted papers cache loaded');
}

function buildPaperDetail(
  post: Record<string, unknown>,
  meta: Record<string, unknown>,
  reviews: unknown[],
) {
  const pevo = safePevoMeta(meta);
  return {
    author: post.author,
    permlink: post.permlink,
    title: post.title,
    body: post.body,
    abstract: extractAbstract(post.body as string),
    json_metadata: meta,
    created: post.created,
    last_update: post.last_edited || post.last_update || post.created,
    net_votes: post.net_votes ?? 0,
    discipline: paperDisciplineField(pevo.discipline),
    keywords: pevoStringArray(pevo, 'keywords'),
    authors: pevo.authors || [],
    ipfs_cid: validatedCid(pevoString(pevo, 'ipfs_cid'), {
      author: post.author as string,
      permlink: post.permlink as string,
    }),
    ipfs_filename: pevoString(pevo, 'ipfs_filename'),
    document_hash: pevoString(pevo, 'document_hash'),
    language: pevoString(pevo, 'language') ?? 'en',
    citations: pevo.citations || [],
    citation_count: 0,
    author_reputation: 0,
    is_accredited: false,
    accredited_authors: [] as string[],
    reviews,
    versions: [] as PaperVersionEntry[],
    is_retracted: false,
    retraction_reason: null as string | null,
    retraction_timestamp: null as string | null,
    supplementary_files: pevo.supplementary_files || [],
    metadata_restored: false,
    // E7: For non-continuation papers, canonical = head = self
    canonical_author: post.author as string,
    canonical_permlink: post.permlink as string,
    head_author: post.author as string,
    head_permlink: post.permlink as string,
  };
}

router.get('/:author/:permlink', async (req: Request, res: Response) => {
  let author = req.params.author as string;
  let permlink = req.params.permlink as string;
  const requestedVersion = req.query.version ? parseInt(req.query.version as string, 10) : null;

  if (requestedVersion !== null && isNaN(requestedVersion)) {
    return sendError(res, 400, 'BAD_REQUEST', 'version must be an integer');
  }

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Shared between the
  // backward walker (`findCanonicalRoot`) and the forward walker
  // (`resolveContinuationChain` via `fetchPaperDetailFromHaf`) so they do
  // not re-fetch metadata for the same `(author, permlink)`.
  const headAuthorsMemo = makeHeadAuthorsMemo();

  // Per-request wall-clock budget for the chain walkers. Bounds
  // worker-thread starvation under degraded HAF (each per-query
  // statement_timeout=30s × walker hop cap = up to 10/25-minute tail
  // before the depth cap exits). The signal threads through both
  // walkers (`findCanonicalRoot` backward, `resolveContinuationChain`
  // forward via `fetchPaperDetailFromHaf`/`reconstructVersionsFromHaf`)
  // so the budget covers the full per-request walker-chain
  // (cascading helper calls included). On abort the walkers emit
  // `canonical_root_walker_wall_clock_exceeded` or
  // `continuation_chain_wall_clock_exceeded` and stop at the deepest
  // verified node / return the chain so far.
  //
  // Knob: `config.hafWalkerWallClockMs` (`HAF_WALKER_WALL_CLOCK_MS` env).
  // Default 3000ms (typical HAF response 50-200ms × 10-15-query depth).
  const walkerAbort = new AbortController();
  const walkerBudget = setTimeout(() => walkerAbort.abort(), config.hafWalkerWallClockMs);
  try {
    // E4: If this is a continuation post, redirect to the canonical root paper
    const canonicalRoot = await findCanonicalRoot(author, permlink, headAuthorsMemo, walkerAbort.signal);
    if (canonicalRoot) {
      author = canonicalRoot.author;
      permlink = canonicalRoot.permlink;
    }

    if (requestedVersion !== null) {
      const cacheKey = `paper-detail:${author}:${permlink}:v${requestedVersion}`;
      const cached = await hafCache.getOrSet(cacheKey, async () => {
        const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
        if (versions.length === 0) return null;

        // Paper identity is established by the first version (original publication).
        // External edits may overwrite json_metadata, so don't check later versions.
        if (!isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) return null;

        const target = versions.find((v) => v.version_number === requestedVersion);
        if (!target) return null;

        // Use this version's metadata (IPFS CID, authors, etc.) but fall back to
        // the original publication's PEvO metadata for fields external edits may strip.
        const meta = target.json_metadata;
        const post = { author, permlink, title: target.title, body: target.body, json_metadata: meta, created: target.created, last_edited: target.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }, 30 * 60_000, true);

      if (cached) return sendOk(res, cached);
      return sendError(res, 404, 'NOT_FOUND', 'Version not found');
    }

    const cacheKey = `paper-detail:${author}:${permlink}`;
    const cached = await hafCache.getOrSet(cacheKey, async () => {
      const hafResult = await fetchPaperDetailFromHaf(author, permlink, headAuthorsMemo, walkerAbort.signal);
      if (hafResult) return hafResult;

      // If current metadata was stripped by an external edit, reconstruct from
      // version history. The first version establishes paper identity; later
      // versions inherit PEvO metadata when the editing frontend dropped it.
      const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo, walkerAbort.signal);
      if (versions.length > 0 && isPevoAnyPaper(versions[0].json_metadata, versions[0].post_author)) {
        const latest = versions[versions.length - 1];
        const meta = latest.json_metadata;
        const post = { author, permlink, title: latest.title, body: latest.body, json_metadata: meta, created: versions[0].created, last_edited: latest.created };
        const detail = buildPaperDetail(post, meta, []);
        detail.versions = versions.map(({ body: _b, json_metadata: _m, ...entry }) => entry);
        detail.metadata_restored = true;

        const retraction = await getRetractionInfo(author, permlink);
        detail.is_retracted = retraction.is_retracted;
        detail.retraction_reason = retraction.retraction_reason ?? null;
        detail.retraction_timestamp = retraction.retraction_timestamp ?? null;

        return detail;
      }

      return null;
    }, 30 * 60_000, true);

    if (cached) return sendOk(res, cached);
    sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  } finally {
    clearTimeout(walkerBudget);
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/enrichment
// ──────────────────────────────────────────────

async function fetchEnrichmentFromHaf(author: string, permlink: string) {
  const pool = getPool();
  if (!pool) return null;

  // Per-request memo for `fetchHeadAuthorizedAuthors`. Threaded into
  // `resolveVersionsFromHaf` so that within a single enrichment request, the
  // forward-walker lookups initiated by `reconstructVersionsFromHaf` share the
  // catch-block negative-cache benefit (round-3 hold item 1: third call site
  // for memo threading, paralleling the `?version=N` branch and the
  // metadata-restored fallback in the GET /:author/:permlink handler).
  const headAuthorsMemo = makeHeadAuthorsMemo();

  try {
    const accreditedAccounts = await getAllAccreditedAccounts();
    const accreditedArr = [...accreditedAccounts];
    // Include anonymous posting account so anonymous reviews appear
    const reviewAuthors = config.hiveAnonAccount
      ? [...accreditedArr, config.hiveAnonAccount]
      : accreditedArr;

    const [voteResult, reviewsResult, versions, claimsResult] = await Promise.all([
      // Accredited voters (excluding self-votes) — use vote operations to survive payout
      pool.query(
        `SELECT DISTINCT ON (v.voter) v.voter, v.weight, v.timestamp, v.block_num FROM ${T.voteOps} v
         WHERE v.author = $1 AND v.permlink = $2
           AND v.voter = ANY($3::text[])
           AND v.voter != v.author
         ORDER BY v.voter, v.block_num DESC`,
        [author, permlink, accreditedArr],
      ),
      // Reviews from accredited reviewers (+ anon account) with accredited vote count
      pool.query(
        `SELECT c.author, c.permlink, c.body, c.json_metadata, c.created,
                (SELECT COALESCE(SUM(CASE WHEN lv.weight > 0 THEN 1 WHEN lv.weight < 0 THEN -1 ELSE 0 END), 0)::int FROM (
                   SELECT DISTINCT ON (v.voter) v.weight FROM ${T.voteOps} v
                   WHERE v.author = c.author AND v.permlink = c.permlink
                     AND v.voter = ANY($5::text[]) AND v.voter != v.author
                   ORDER BY v.voter, v.block_num DESC
                 ) lv WHERE lv.weight != 0) AS net_votes
         FROM ${T.comments} c
         WHERE c.parent_author = $1 AND c.parent_permlink = $2
           AND c.author = ANY($6::text[])
           AND (c.json_metadata -> $3 ->> 'type') = 'review'
           AND c.json_metadata ->> 'app' LIKE $4
         ORDER BY c.created DESC`,
        [author, permlink, config.appTag, `${config.appTag}/%`, accreditedArr, reviewAuthors],
      ),
      // Version history (needed for review outdated computation)
      resolveVersionsFromHaf(author, permlink, headAuthorsMemo),
      // Authorship claims
      (async () => {
        const cte = buildWith(1, activeAccreditationsCteBody, (idx) => authorshipClaimsCteBody(idx, { paperAuthor: author, paperPermlink: permlink }));
        return pool.query(
          `${cte.sql}
           SELECT claimer, paper_author, paper_permlink, author_index, status, claimed_at
           FROM authorship_claims
           WHERE paper_author = $${cte.nextIdx}
             AND paper_permlink = $${cte.nextIdx + 1}
             AND status != 'revoked'`,
          [...cte.params, author, permlink],
        );
      })(),
    ]);

    const latestVersion = versions.length > 0 ? versions[versions.length - 1].version_number : 1;

    // Always query revote custom_json ops for this paper
    const revoteResult = await pool.query(
      `SELECT cj.required_posting_auths ->> 0 AS voter,
              (cj.json::jsonb ->> 'weight')::int AS weight,
              cj.json::jsonb ->> 'version' AS version,
              cj.timestamp AS revote_ts,
              cj.block_num
       FROM ${T.customJson} cj
       WHERE cj.custom_id = $1
         AND cj.json::jsonb ->> 'action' = 'revote'
         AND cj.json::jsonb ->> 'author' = $2
         AND cj.json::jsonb ->> 'permlink' = $3
         AND cj.block_num >= $4
       ORDER BY cj.block_num DESC`,
      [config.appTag, author, permlink, getCachedGenesisBlock()],
    );
    const revoteMap = new Map<string, { weight: number; timestamp: Date; block_num: number; version: number }>();
    for (const r of revoteResult.rows) {
      const voter = r.voter as string;
      const weight = Number(r.weight);
      const version = r.version;
      // Validation: required fields (author/permlink/version) and weight range
      if (!voter || version == null || isNaN(weight) || weight < -10000 || weight > 10000) {
        logger.debug({ voter, weight, author, permlink }, 'Ignoring invalid revote custom_json');
        continue;
      }
      // Only include accredited voters (excluding self-votes)
      if (!accreditedAccounts.has(voter) || voter === author) continue;
      // Keep only the latest revote per voter (already ordered by block_num DESC)
      if (!revoteMap.has(voter)) {
        revoteMap.set(voter, { weight, timestamp: new Date(r.revote_ts as string), block_num: Number(r.block_num), version: Number(version) });
      }
    }

    const reviews = reviewsResult.rows.map((r: Record<string, unknown>) => {
      const rMeta = parseMeta(r.json_metadata);
      const pevo = safePevoMeta(rMeta);
      const rating = pevo.rating as Record<string, number> | undefined;
      // Compute reviewed_version from timestamps: latest version created before this review
      const reviewCreated = new Date(r.created as string);
      let reviewedVersion = 1;
      for (const v of versions) {
        if (new Date(v.created) <= reviewCreated) {
          reviewedVersion = v.version_number;
        }
      }

      // E5: Review outdated — if paper has been updated since review
      const outdated = reviewedVersion < latestVersion;

      // E5: Find if any version explicitly addresses this review
      const reviewAuthor = r.author as string;
      const reviewPermlink = r.permlink as string;
      let addressedByVersion: number | undefined;
      for (const v of versions) {
        if (v.addresses_reviews) {
          const found = v.addresses_reviews.some(
            (ar) => ar.author === reviewAuthor && ar.permlink === reviewPermlink,
          );
          if (found) {
            addressedByVersion = v.version_number;
            break;
          }
        }
      }

      return {
        author: reviewAuthor,
        permlink: reviewPermlink,
        body: r.body as string,
        rating: rating || { methodology: 0, novelty: 0, clarity: 0, significance: 0 },
        is_anonymous: pevo.is_anonymous ?? false,
        created: r.created as string,
        net_votes: r.net_votes as number,
        reviewer_reputation: 0,
        is_accredited: accreditedAccounts.has(reviewAuthor) || (pevo.is_anonymous === true),
        reviewed_version: reviewedVersion,
        outdated,
        addressed_by_version: addressedByVersion,
      };
    });

    // Vote resolution: for each voter, pick the signal with the highest block_num
    // across native votes and revote custom_json. Handle weight=0 as retraction.
    const processedVoters = new Set<string>();
    const voters: Array<{ voter: string; weight: number; effective_weight: number; voted_version: number }> = [];

    // Build sorted version block_nums for voted_version inference
    const versionBlocks = versions
      .map(v => ({ version_number: v.version_number, block_num: v.block_num }))
      .sort((a, b) => a.block_num - b.block_num);

    // Infer voted version from a vote's block_num: latest version where version_block <= vote_block
    function inferVotedVersion(voteBlockNum: number): number {
      let result = 1;
      for (const vb of versionBlocks) {
        if (vb.block_num <= voteBlockNum) result = vb.version_number;
        else break;
      }
      return result;
    }

    // Process voters with native votes
    for (const r of voteResult.rows) {
      const voter = r.voter as string;
      const nativeWeight = Number(r.weight);
      const nativeBlock = Number(r.block_num);
      processedVoters.add(voter);

      const revote = revoteMap.get(voter);
      // Pick latest signal by block_num
      const useRevote = revote && revote.block_num > nativeBlock;
      const effectiveSignalWeight = useRevote ? revote.weight : nativeWeight;

      // weight=0 means retracted
      if (effectiveSignalWeight === 0) continue;

      // Determine voted_version: revote has explicit version, native uses block_num inference
      const votedVersion = useRevote ? revote.version : inferVotedVersion(nativeBlock);

      voters.push({
        voter,
        weight: effectiveSignalWeight,
        effective_weight: effectiveSignalWeight,
        voted_version: votedVersion,
      });
    }

    // Process revote-only voters (no native Hive vote)
    for (const [voter, revote] of revoteMap) {
      if (processedVoters.has(voter)) continue;
      if (revote.weight === 0) continue;

      voters.push({
        voter,
        weight: revote.weight,
        effective_weight: revote.weight,
        voted_version: revote.version,
      });
    }

    const net_votes = voters.reduce((sum, v) => sum + (v.effective_weight > 0 ? 1 : v.effective_weight < 0 ? -1 : 0), 0);
    const effectiveVoters = voters.filter(v => v.effective_weight !== 0);
    const avgWeight = effectiveVoters.length > 0
      ? effectiveVoters.reduce((sum, v) => sum + v.effective_weight, 0) / effectiveVoters.length
      : 0;
    const vote_strength = effectiveVoters.length > 0 ? voteStrengthTier(avgWeight) : null;

    const authorship_claims = claimsResult.rows.map((r: Record<string, unknown>) => ({
      claimer: r.claimer as string,
      author_index: r.author_index as number | null,
      status: r.status as string,
      claimed_at: r.claimed_at as string,
    }));

    return {
      net_votes,
      vote_strength,
      voters,
      reviews,
      authorship_claims,
    };
  } catch (err) {
    logger.error({ err }, 'HAF enrichment query failed');
    return null;
  }
}

router.get('/:author/:permlink/enrichment', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  const cacheKey = `paper-enrichment:${author}:${permlink}`;
  const cached = await hafCache.getOrSet(cacheKey, () =>
    fetchEnrichmentFromHaf(author, permlink),
  5 * 60_000, true);

  if (!cached) return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  sendOk(res, cached);
});

// ──────────────────────────────────────────────
// E6: POST /api/papers/:author/:permlink/invalidate
// ──────────────────────────────────────────────

const invalidateLimiter = rateLimit({ name: 'cache-invalidate', windowMs: 60_000, max: 10, keyFn: byAccount });

router.post('/:author/:permlink/invalidate', verifyHiveSignature, invalidateLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;

  // Invalidate all cache keys for this paper, including versioned-view
  // keys `paper-detail:{author}:{permlink}:v{N}`. Without the prefix
  // sweep, an edit to `pevo.authors[]` (which gates continuation admit)
  // would serve stale results from versioned views for up to 30 min.
  await Promise.all([
    hafCache.invalidate(`paper-detail:${author}:${permlink}`),
    hafCache.invalidate(`paper-enrichment:${author}:${permlink}`),
    // Versioned keys live under `paper-detail:{author}:{permlink}:v*`.
    // The unversioned key was already handled above; this prefix sweep
    // catches the v1, v2, ... variants.
    hafCache.invalidatePrefix(`paper-detail:${author}:${permlink}:v`),
  ]);

  sendOk(res, { message: 'Cache invalidated' });
});

// ──────────────────────────────────────────────
// POST /api/papers/:author/:permlink/retract
// ──────────────────────────────────────────────

async function isRetracted(author: string, permlink: string): Promise<boolean> {
  const pool = getPool();
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT 1 FROM ${T.customJson} cj
         WHERE cj.custom_id = $3
           AND cj.json::jsonb ->> 'action' = 'retract_paper'
           AND cj.json::jsonb ->> 'author' = $1
           AND cj.json::jsonb ->> 'permlink' = $2
         LIMIT 1`,
        [author, permlink, config.appTag],
      );
      return result.rows.length > 0;
    } catch (err) {
      logger.error({ err }, 'HAF retraction check failed');
    }
  }
  return false;
}

router.post('/:author/:permlink/retract', verifyHiveSignature, retractLimiter, async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const username = req.hiveUsername!;
  const reason = (req.body.reason as string) || '';

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.
  // Check paper exists
  const detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  // Authorization: paper author, pevo.admin, or (for bridge papers) registerer or original preprint author
  let authorized = username === author || username === config.hiveAdminAccount;
  if (!authorized) {
    const meta = (detail.json_metadata || {}) as Record<string, unknown>;
    const pevo = (meta[config.appTag] || {}) as Record<string, unknown>;
    if (isPevoBridgePaper(meta, author)) {
      const source = (pevo.source || {}) as Record<string, unknown>;
      const registeredBy = source.registered_by as string | undefined;
      if (registeredBy === username) {
        authorized = true;
      } else {
        const paperAuthors = (pevo.authors || []) as Array<{ hive?: string | null }>;
        authorized = paperAuthors.some((a) => a.hive === username);
      }
    }
  }
  if (!authorized) {
    return sendError(res, 403, 'FORBIDDEN', `Only the paper author, ${config.hiveAdminAccount}, or (for bridge papers) the registerer or an original author can retract`);
  }

  // Check not already retracted
  if (await isRetracted(author, permlink)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Paper is already retracted');
  }

  // Broadcast retract_paper custom_json
  if (!config.pevoAdminPostingKey) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  const payload = {
    action: 'retract_paper',
    author,
    permlink,
    reason,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await broadcastJsonWithTimeout(
      { id: config.appTag, json: JSON.stringify(payload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );
    // Invalidate retraction cache so the change is visible immediately
    void hafCache.invalidate('retracted-papers');
    sendOk(res, { message: 'Paper retracted', tx_id: result.id });
  } catch (err) {
    handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting paper retraction timed out',
      failMsg: 'Failed to broadcast retraction to Hive',
      logContext: { author, permlink },
      routeLabel: 'papers.retract',
    });
  }
});

// ──────────────────────────────────────────────
// GET /api/papers/:author/:permlink/cite
// ──────────────────────────────────────────────

const VALID_CITE_FORMATS = new Set(['bibtex', 'ris', 'apa']);

function generateBibtex(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string; orcid?: string }>;
  const firstWord = title.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'paper';
  const key = `${author}_${firstWord}_${year}`;
  const authorStr = authors.length > 0
    ? authors.map((a) => a.name).join(' and ')
    : author;
  const doi = (detail as Record<string, unknown>).doi as string | undefined;

  let bib = `@article{${key},\n`;
  bib += `  title = {${title}},\n`;
  bib += `  author = {${authorStr}},\n`;
  bib += `  year = {${year}},\n`;
  bib += `  publisher = {PEvO (Publish and Evaluate Onchain)},\n`;
  bib += `  url = {https://pevo.science/papers/${author}/${detail.permlink}}`;
  if (doi) bib += `,\n  doi = {${doi}}`;
  bib += `\n}`;
  return bib;
}

function generateRis(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string }>;
  const doi = (detail as Record<string, unknown>).doi as string | undefined;

  const lines: string[] = [
    'TY  - JOUR',
    `TI  - ${title}`,
  ];
  if (authors.length > 0) {
    for (const a of authors) lines.push(`AU  - ${a.name}`);
  } else {
    lines.push(`AU  - ${author}`);
  }
  lines.push(`PY  - ${year}`);
  lines.push('PB  - PEvO (Publish and Evaluate Onchain)');
  lines.push(`UR  - https://pevo.science/papers/${author}/${detail.permlink}`);
  if (doi) lines.push(`DO  - ${doi}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

function generateApa(detail: Record<string, unknown>): string {
  const author = detail.author as string;
  const title = detail.title as string;
  const created = detail.created as string;
  const year = new Date(created).getFullYear();
  const pevo = ((detail.json_metadata as Record<string, unknown>)?.pevo || {}) as Record<string, unknown>;
  const authors = (pevo.authors || []) as Array<{ name: string }>;

  const authorStr = authors.length > 0
    ? authors.map((a) => a.name).join(', ')
    : author;

  return `${authorStr} (${year}). ${title}. PEvO (Publish and Evaluate Onchain). https://pevo.science/papers/${author}/${detail.permlink}`;
}

router.get('/:author/:permlink/cite', async (req: Request, res: Response) => {
  const author = req.params.author as string;
  const permlink = req.params.permlink as string;
  const format = (req.query.format as string || '').toLowerCase();

  if (!VALID_CITE_FORMATS.has(format)) {
    return sendError(res, 400, 'BAD_REQUEST', 'format must be one of: bibtex, ris, apa');
  }

  // Canonical-root walker is intentionally NOT invoked here. /cite and /retract
  // operate on the URL's own (author, permlink) — citation targets the URL post
  // directly; retraction authorizes username === URL author then broadcasts on
  // the URL's coords. Canonicalization is a display concern handled by the GET
  // handler. New /api/papers/:author/:permlink/<verb> routes that want canonical
  // resolution must call findCanonicalRoot themselves; do not pattern-match this
  // handler without checking.
  // Reuse paper detail fetch logic
  const detail = await fetchPaperDetailFromHaf(author, permlink) as Record<string, unknown> | null;
  if (!detail) {
    return sendError(res, 404, 'NOT_FOUND', 'Paper not found');
  }

  const generators: Record<string, (d: Record<string, unknown>) => string> = {
    bibtex: generateBibtex,
    ris: generateRis,
    apa: generateApa,
  };

  const content = generators[format](detail);
  sendOk(res, { format, content });
});

export default router;
