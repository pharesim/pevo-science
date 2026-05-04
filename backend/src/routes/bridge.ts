import { Router, type Request, type Response } from 'express';
import { getPool, isHafAvailable } from '../db.js';
import { hiveClient, broadcastSendOperationsWithTimeout } from '../hive.js';
import { config } from '../config.js';
import { sendOk, sendError } from '../response.js';
import { parseMeta, isPevoBridgePaper } from '../helpers.js';
import { getAccreditedSet } from '../accreditation.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { hafCache } from '../cache.js';
import { logger } from '../logger.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { T, validPevoPaperWhere } from '../hafsql.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { getCachedBridgePostingKey } from '../startup-checks.js';
import {
  parseIdentifier,
  resolveToCanonical,
  bridgePermlink,
  lookupPreprint,
  buildBridgeBody,
  buildBridgeMetadata,
} from '../bridge.js';

const router = Router();

// Shared misconfig surface: when PEVO_BRIDGE_POSTING_KEY is unset, any handler
// that would otherwise broadcast (or authorize a broadcast) under the bridge
// account must return the same distinct 503 SERVICE_UNAVAILABLE so operators
// see one consistent error code+message across /api/bridge/* and /api/papers/*
// claim approve/revoke. Returns true when configured (caller proceeds); returns
// false after sending the 503 (caller returns).
export function assertBridgeKeyConfigured(res: Response): boolean {
  if (!config.pevoBridgePostingKey) {
    sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Bridge posting key not configured');
    return false;
  }
  return true;
}

// Per-endpoint rate limiters (per API contract)
const lookupLimiter = rateLimit({ name: 'bridge-lookup', windowMs: 60_000, max: 20, keyFn: byIp });
const registerLimiter = rateLimit({ name: 'bridge-register', windowMs: 3_600_000, max: 10, keyFn: byIp });
const updateLimiter = rateLimit({ name: 'bridge-update', windowMs: 3_600_000, max: 10, keyFn: byIp });

// ──────────────────────────────────────────────
// GET /api/bridge/lookup?identifier=...
// ──────────────────────────────────────────────

router.get('/lookup', lookupLimiter, async (req: Request, res: Response) => {
  const identifier = req.query.identifier as string;
  if (!identifier || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query parameter "identifier" is required');
  }

  try {
    const result = await lookupPreprint(identifier);
    if (!result) {
      return sendError(res, 404, 'NOT_FOUND', 'No preprint found for the given identifier');
    }
    sendOk(res, result);
  } catch (err) {
    logger.error({ err, identifier }, 'Preprint lookup failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata');
  }
});

// ──────────────────────────────────────────────
// GET /api/bridge/check?identifier=...
// ──────────────────────────────────────────────

async function checkExistingBridge(identifier: string, resolvedParsed?: { type: 'arxiv' | 'doi'; id: string } | null) {
  const parsed = resolvedParsed ?? parseIdentifier(identifier);
  if (!parsed || (parsed.type !== 'arxiv' && parsed.type !== 'doi')) {
    return { exists: false, author: null, permlink: null, title: null, created: null };
  }

  const permlink = bridgePermlink(parsed);

  // Strategy 1: permlink check via Hive API (works without HAF)
  try {
    // Check all possible authors by querying HAF first
    const pool = getPool();
    if (pool && isHafAvailable()) {
      // Metadata check: find by source DOI or arXiv ID. Pin to the bridge
      // account so a spoofer can't preempt a canonical bridge import by
      // posting a comment with the same source DOI under their own account.
      const sourceField = parsed.type === 'doi' ? 'doi' : 'arxiv_id';
      const bridgePaperWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$2', bridgeAccountParam: '$5', source: 'bridge' });
      const result = await pool.query(
        `SELECT c.author, c.permlink, c.title, c.created
         FROM ${T.comments} c
         WHERE c.parent_author = '' AND c.parent_permlink = $2
           AND ${bridgePaperWhere}
           AND c.json_metadata ->> 'app' LIKE $3
           AND (c.json_metadata -> $2 -> 'source' ->> $4) = $1
         LIMIT 1`,
        [parsed.id, config.appTag, `${config.appTag}/%`, sourceField, config.hiveBridgeAccount],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return { exists: true, author: row.author, permlink: row.permlink, title: row.title, created: row.created };
      }

      // Also check by deterministic permlink (also pinned to bridge account).
      const permlinkBridgeWhere = validPevoPaperWhere({ commentAlias: 'c', appTagParam: '$2', bridgeAccountParam: '$4', source: 'bridge' });
      const permlinkResult = await pool.query(
        `SELECT c.author, c.permlink, c.title, c.created
         FROM ${T.comments} c
         WHERE c.parent_author = '' AND c.parent_permlink = $2
           AND c.permlink = $1
           AND ${permlinkBridgeWhere}
           AND c.json_metadata ->> 'app' LIKE $3
         LIMIT 1`,
        [permlink, config.appTag, `${config.appTag}/%`, config.hiveBridgeAccount],
      );
      if (permlinkResult.rows.length > 0) {
        const row = permlinkResult.rows[0];
        return { exists: true, author: row.author, permlink: row.permlink, title: row.title, created: row.created };
      }
    }
  } catch (err) {
    logger.error({ err, identifier, permlink }, 'Bridge check HAF query failed');
  }

  return { exists: false, author: null, permlink: null, title: null, created: null };
}

router.get('/check', lookupLimiter, async (req: Request, res: Response) => {
  const identifier = req.query.identifier as string;
  if (!identifier || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Query parameter "identifier" is required');
  }

  try {
    const parsed = await resolveToCanonical(identifier);
    if (!parsed) {
      return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier — try pasting a DOI or arXiv ID directly');
    }

    const cacheKey = `bridge-check:${parsed.type}:${parsed.id}`;
    const result = await hafCache.getOrSet(cacheKey, () => checkExistingBridge(identifier, parsed), 30_000);
    sendOk(res, result);
  } catch (err) {
    logger.error({ err, identifier }, 'Bridge check failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to check bridge paper status');
  }
});

// ──────────────────────────────────────────────
// POST /api/bridge/register
// ──────────────────────────────────────────────

router.post('/register', registerLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const { identifier, discipline, keywords, language } = req.body as {
    identifier?: string;
    discipline?: string;
    keywords?: string[];
    language?: string;
  };

  if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "identifier" is required');
  }

  if (!discipline || typeof discipline !== 'string' || discipline.trim().length === 0) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "discipline" is required');
  }

  // Verify accreditation
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can register bridge papers');
  }

  if (!assertBridgeKeyConfigured(res)) return;

  // Resolve identifier to canonical DOI or arXiv ID
  let parsed;
  try {
    parsed = await resolveToCanonical(identifier);
  } catch (err) {
    logger.error({ err, identifier, username }, 'Identifier resolution failed');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to resolve identifier');
  }
  if (!parsed) {
    return sendError(res, 400, 'BAD_REQUEST', 'Could not resolve identifier — try pasting a DOI or arXiv ID directly');
  }

  // Check for duplicates
  const existing = await checkExistingBridge(identifier, parsed);
  if (existing.exists) {
    return res.status(409).json({
      status: 'error',
      error: {
        code: 'DUPLICATE',
        message: 'This preprint is already registered on PEvO',
        existing_author: existing.author,
        existing_permlink: existing.permlink,
      },
    });
  }

  // Fetch metadata from source
  let meta;
  try {
    meta = await lookupPreprint(identifier);
  } catch (err) {
    logger.error({ err, identifier, username }, 'Preprint metadata fetch failed during registration');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch preprint metadata from source');
  }
  if (!meta) {
    return sendError(res, 400, 'BAD_REQUEST', 'No preprint found for the given identifier');
  }

  // Build and broadcast the Hive post under the bridge account
  const permlink = bridgePermlink(parsed);
  const body = buildBridgeBody(meta, username);
  const jsonMetadata = buildBridgeMetadata(
    meta,
    username,
    discipline || '',
    keywords || [],
    language || 'en',
    1,
    meta.title,
    body,
    config.hiveBridgeAccount,
    permlink,
  );

  try {
    // Use the boot-cached parsed key. `assertBridgeKeyConfigured` above
    // already returned 503 if the WIF env var is unset, so the cache is
    // guaranteed populated when we reach here. The non-null assertion
    // documents that invariant.
    const key = getCachedBridgePostingKey()!;
    const result = await broadcastSendOperationsWithTimeout(
      [
        ['comment', {
          parent_author: '',
          parent_permlink: config.appTag,
          author: config.hiveBridgeAccount,
          permlink,
          title: meta.title.length > 256 ? meta.title.slice(0, 253) + '...' : meta.title,
          body,
          json_metadata: JSON.stringify(jsonMetadata),
        }],
        ['comment_options', {
          author: config.hiveBridgeAccount,
          permlink,
          max_accepted_payout: '1000000.000 HBD',
          percent_hbd: 0,
          allow_votes: true,
          allow_curation_rewards: true,
          extensions: [],
        }],
      ],
      key,
    );

    sendOk(res, {
      author: config.hiveBridgeAccount,
      permlink,
      tx_id: result.id,
      source: {
        type: meta.source_type,
        doi: meta.doi,
        arxiv_id: meta.arxiv_id,
        url: meta.source_url,
      },
    });
  } catch (err) {
    return handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting bridge paper registration timed out',
      failMsg: 'Failed to broadcast bridge paper registration to Hive',
      logContext: { author: config.hiveBridgeAccount, permlink, username },
      routeLabel: 'bridge.register',
    });
  }
});

// ──────────────────────────────────────────────
// POST /api/bridge/update
// ──────────────────────────────────────────────

router.post('/update', updateLimiter, verifyHiveSignature, async (req: Request, res: Response) => {
  const username = req.hiveUsername!;
  const { permlink } = req.body as { permlink?: string };

  if (!permlink) {
    return sendError(res, 400, 'BAD_REQUEST', 'Field "permlink" is required');
  }

  // Verify accreditation
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can update bridge papers');
  }

  if (!assertBridgeKeyConfigured(res)) return;

  // Fetch the existing bridge paper (always under bridge account)
  let existingMeta: Record<string, unknown> | null = null;
  let existingPevo: Record<string, unknown> | null = null;

  try {
    const post = await hiveClient.database.call('get_content', [config.hiveBridgeAccount, permlink]);
    if (!post || !post.author || post.parent_permlink !== config.appTag) {
      return sendError(res, 404, 'NOT_FOUND', 'Bridge paper not found');
    }

    existingMeta = parseMeta(post.json_metadata);
    if (!isPevoBridgePaper(existingMeta, post.author)) {
      return sendError(res, 404, 'NOT_FOUND', 'Bridge paper not found');
    }

    existingPevo = (existingMeta[config.appTag] || {}) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, author: config.hiveBridgeAccount, permlink, username }, 'Failed to fetch existing bridge paper');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch existing bridge paper');
  }

  // Only the original registerer can update
  const source = existingPevo.source as Record<string, unknown> | undefined;
  const registeredBy = source?.registered_by as string | undefined;
  if (registeredBy !== username) {
    return sendError(res, 403, 'FORBIDDEN', 'Only the original registerer can update a bridge paper');
  }

  const sourceIdentifier = (source?.doi as string) || (source?.arxiv_id as string);
  if (!sourceIdentifier) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Bridge paper has no source identifier');
  }

  // Re-fetch metadata from source
  let freshMeta;
  try {
    freshMeta = await lookupPreprint(sourceIdentifier);
  } catch (err) {
    logger.error({ err, sourceIdentifier, author: config.hiveBridgeAccount, permlink, username }, 'Failed to re-fetch preprint metadata for update');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to fetch updated metadata from source');
  }
  if (!freshMeta) {
    return sendError(res, 400, 'BAD_REQUEST', 'Source metadata could not be retrieved');
  }

  const previousVersion = (existingPevo.version as number) || 1;
  const newVersion = previousVersion + 1;

  const body = buildBridgeBody(freshMeta, username);
  const jsonMetadata = buildBridgeMetadata(
    freshMeta,
    username,
    (existingPevo.discipline as string) || '',
    (existingPevo.keywords as string[]) || [],
    (existingPevo.language as string) || 'en',
    newVersion,
    freshMeta.title,
    body,
    config.hiveBridgeAccount,
    permlink,
  );

  try {
    // Use the boot-cached parsed key. `assertBridgeKeyConfigured` above
    // already returned 503 if the WIF env var is unset, so the cache is
    // guaranteed populated when we reach here. The non-null assertion
    // documents that invariant.
    const key = getCachedBridgePostingKey()!;
    const result = await broadcastSendOperationsWithTimeout(
      [
        ['comment', {
          parent_author: '',
          parent_permlink: config.appTag,
          author: config.hiveBridgeAccount,
          permlink,
          title: freshMeta.title.length > 256 ? freshMeta.title.slice(0, 253) + '...' : freshMeta.title,
          body,
          json_metadata: JSON.stringify(jsonMetadata),
        }],
        ['comment_options', {
          author: config.hiveBridgeAccount,
          permlink,
          max_accepted_payout: '1000000.000 HBD',
          percent_hbd: 0,
          allow_votes: true,
          allow_curation_rewards: true,
          extensions: [],
        }],
      ],
      key,
    );

    sendOk(res, {
      author: config.hiveBridgeAccount,
      permlink,
      tx_id: result.id,
      previous_version: previousVersion,
      new_version: newVersion,
    });
  } catch (err) {
    return handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting bridge paper update timed out',
      failMsg: 'Failed to broadcast bridge paper update to Hive',
      logContext: { author: config.hiveBridgeAccount, permlink, username, newVersion },
      routeLabel: 'bridge.update',
    });
  }
});

export default router;
