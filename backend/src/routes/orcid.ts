import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient } from '../hive.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { getAppPool } from '../app-db.js';
import { getPool } from '../db.js';
import { T, getCachedGenesisBlock } from '../hafsql.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { rateLimit, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';

const router = Router();

type OrcidMode = 'signup' | 'login' | 'accredit' | 'link';
const VALID_MODES: ReadonlySet<string> = new Set(['signup', 'login', 'accredit', 'link']);
const AUTHENTICATED_MODES: ReadonlySet<string> = new Set(['accredit', 'link']);

const ORCID_STATE_TTL = 600; // 10 minutes
const ORCID_VERIFIED_TTL = 1800; // 30 minutes

// In-memory fallbacks when Redis is unavailable
const orcidStates = new Map<string, { mode: OrcidMode; username?: string; timestamp: number; expires: number }>();
const orcidVerified = new Map<string, { orcid_id: string; works_count: number; name: string; expires: number }>();

// Periodic cleanup of expired in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of orcidStates) {
    if (v.expires <= now) orcidStates.delete(k);
  }
  for (const [k, v] of orcidVerified) {
    if (v.expires <= now) orcidVerified.delete(k);
  }
}, 5 * 60_000);

const startLimiter = rateLimit({ name: 'orcid-start', windowMs: 60_000, max: 10, keyFn: byIp });
const callbackLimiter = rateLimit({ name: 'orcid-callback', windowMs: 60_000, max: 10, keyFn: byIp });

// Derive redirect URI at runtime (no env var needed)
function getRedirectUri(): string {
  return `${config.appUrl}/orcid/callback`;
}

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/start — Initiate ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/start', startLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const { mode } = req.body as { mode?: string };
  if (!mode || !VALID_MODES.has(mode)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'mode must be one of: signup, login, accredit, link');
  }

  // Authenticated modes require a valid session
  let username: string | undefined;
  if (AUTHENTICATED_MODES.has(mode)) {
    // Run verifyHiveSignature inline
    await new Promise<void>((resolve, reject) => {
      verifyHiveSignature(req, res, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
    if (res.headersSent) return; // verifyHiveSignature already sent error
    username = req.hiveUsername;
    if (!username) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for this mode');
    }
  }

  const state = crypto.randomBytes(16).toString('hex');
  const stateKey = `${config.appTag}:orcid_state:${state}`;
  const stateData: Record<string, unknown> = { mode, timestamp: Date.now() };
  if (username) stateData.username = username;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, JSON.stringify(stateData), 'EX', ORCID_STATE_TTL);
  } else {
    orcidStates.set(state, {
      mode: mode as OrcidMode,
      username,
      timestamp: Date.now(),
      expires: Date.now() + ORCID_STATE_TTL * 1000,
    });
  }

  const redirectUrl = `${config.orcidBaseUrl}/oauth/authorize?` +
    `client_id=${encodeURIComponent(config.orcidClientId)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('/authenticate')}` +
    `&redirect_uri=${encodeURIComponent(getRedirectUri())}` +
    `&state=${state}`;

  sendOk(res, { redirect_url: redirectUrl });
});

// ─────────────────────────────────────────────────────────────
// POST /api/orcid/callback — Complete ORCID OAuth for any mode
// ─────────────────────────────────────────────────────────────

router.post('/callback', callbackLimiter, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const { code, state } = req.body as { code?: string; state?: string };
  if (!code || !state) {
    return sendError(res, 400, 'BAD_REQUEST', 'code and state are required');
  }

  // Retrieve and validate state
  let storedMode: OrcidMode | null = null;
  let storedUsername: string | undefined;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`${config.appTag}:orcid_state:${state}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { mode: OrcidMode; username?: string };
        storedMode = parsed.mode;
        storedUsername = parsed.username;
      } catch {
        // Invalid stored state
      }
      await redis.del(`${config.appTag}:orcid_state:${state}`);
    }
  } else {
    const entry = orcidStates.get(state);
    if (entry && entry.expires > Date.now()) {
      storedMode = entry.mode;
      storedUsername = entry.username;
    }
    orcidStates.delete(state);
  }

  if (!storedMode) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter');
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`${config.orcidBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.orcidClientId,
        client_secret: config.orcidClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRedirectUri(),
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error({ status: tokenRes.status, body: errBody }, 'ORCID token exchange failed');
      return sendError(res, 400, 'BAD_REQUEST', 'Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json() as { orcid: string; name?: string; access_token?: string };
    const orcidId = tokenData.orcid;
    if (!orcidId) {
      return sendError(res, 400, 'BAD_REQUEST', 'ORCID response missing orcid field');
    }

    const orcidName = tokenData.name || '';

    // Dispatch to mode handler
    switch (storedMode) {
      case 'signup':
        return await handleSignup(res, orcidId, orcidName, tokenData.access_token);
      case 'login':
        return await handleLogin(res, orcidId);
      case 'accredit':
        return await handleAccredit(res, orcidId, orcidName, storedUsername!, tokenData.access_token);
      case 'link':
        return await handleLink(res, orcidId, storedUsername!);
    }
  } catch (err) {
    logger.error({ err }, 'ORCID callback failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'ORCID verification failed');
  }
});

// ─────────────────────────────────────────────────────────────
// Mode handlers
// ─────────────────────────────────────────────────────────────

async function handleSignup(
  res: Response,
  orcidId: string,
  orcidName: string,
  accessToken?: string,
): Promise<void> {
  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`);
    return;
  }

  // Store verified ORCID data with nonce
  const nonce = crypto.randomBytes(16).toString('hex');
  const verifiedData = { orcid_id: orcidId, works_count: externalWorksCount, name: orcidName };

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(verifiedData), 'EX', ORCID_VERIFIED_TTL);
  } else {
    orcidVerified.set(nonce, { ...verifiedData, expires: Date.now() + ORCID_VERIFIED_TTL * 1000 });
  }

  sendOk(res, {
    mode: 'signup',
    orcid_token: nonce,
    orcid_id: orcidId,
    works_count: externalWorksCount,
    name: orcidName,
  });
}

async function handleLogin(res: Response, orcidId: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) {
    sendError(res, 503, 'INTERNAL_ERROR', 'Service not available');
    return;
  }

  const result = await pool.query<{ username: string; custody: string }>(
    `SELECT username, custody FROM accounts WHERE orcid = $1 AND username IS NOT NULL LIMIT 1`,
    [orcidId],
  );

  if (result.rows.length === 0) {
    res.status(404).json({
      status: 'error',
      error: { code: 'NO_ACCOUNT', message: 'No account linked to this ORCID. Please sign up first.' },
      orcid_id: orcidId,
    });
    return;
  }

  const account = result.rows[0];
  const token = jwt.sign(
    { sub: account.username, custody: account.custody || 'light' },
    config.sessionSecret,
    { expiresIn: '24h' },
  );
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  sendOk(res, {
    mode: 'login',
    token,
    expires_at: expiresAt,
    custody: account.custody || 'light',
    username: account.username,
  });
}

async function handleAccredit(
  res: Response,
  orcidId: string,
  orcidName: string,
  username: string,
  accessToken?: string,
): Promise<void> {
  // Check if already accredited
  const { getAccreditedSet } = await import('../accreditation.js');
  const accreditedSet = await getAccreditedSet([username]);
  if (accreditedSet.has(username)) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is already accredited');
    return;
  }

  const externalWorksCount = await countExternalWorks(orcidId, accessToken);

  if (externalWorksCount < config.orcidMinWorks) {
    sendError(res, 422, 'VALIDATION_ERROR',
      `ORCID profile has ${externalWorksCount} externally-sourced work(s), but at least ${config.orcidMinWorks} are required`);
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const customJsonPayload = {
    action: 'accredit',
    account: username,
    name: orcidName || username,
    institution: '',
    field: '',
    method: 'orcid',
    orcid: orcidId,
    evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
    timestamp: new Date().toISOString(),
  };

  const key = PrivateKey.fromString(config.pevoAdminPostingKey);
  const result = await hiveClient.broadcast.json(
    { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
    key,
  );

  // Update orcid column in accounts (if light account row exists)
  await updateAccountOrcid(username, orcidId);

  sendOk(res, {
    mode: 'accredit',
    message: 'Accreditation via ORCID confirmed',
    username,
    orcid: orcidId,
    tx_id: result.id,
  });
}

async function handleLink(
  res: Response,
  orcidId: string,
  username: string,
): Promise<void> {
  // Fetch existing accreditation to preserve fields
  const existing = await getExistingAccreditation(username);
  if (!existing) {
    sendError(res, 422, 'VALIDATION_ERROR', 'Account is not accredited');
    return;
  }

  if (!config.pevoAdminPostingKey) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    return;
  }

  const customJsonPayload = {
    action: 'accredit',
    account: username,
    name: existing.name,
    institution: existing.institution,
    field: existing.field,
    method: existing.method,
    orcid: orcidId,
    evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
    timestamp: new Date().toISOString(),
  };

  const key = PrivateKey.fromString(config.pevoAdminPostingKey);
  const result = await hiveClient.broadcast.json(
    { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
    key,
  );

  // Update orcid column in accounts (if light account row exists)
  await updateAccountOrcid(username, orcidId);

  sendOk(res, {
    mode: 'link',
    message: 'ORCID linked successfully',
    username,
    orcid: orcidId,
    tx_id: result.id,
  });
}

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────

async function countExternalWorks(orcidId: string, _accessToken?: string): Promise<number> {
  const worksRes = await fetch(`https://pub.orcid.org/v3.0/${orcidId}/works`, {
    headers: { Accept: 'application/json' },
  });

  if (!worksRes.ok) {
    logger.error({ status: worksRes.status, orcidId }, 'ORCID works fetch failed');
    throw new Error('Failed to fetch ORCID works');
  }

  const worksData = await worksRes.json() as {
    group?: Array<{
      'work-summary'?: Array<{
        source?: { 'source-orcid'?: { path?: string } };
      }>;
    }>;
  };

  // Count works where source ORCID differs from profile owner (externally sourced).
  // Self-asserted works have source-orcid.path === the profile owner's ORCID iD.
  // External sources (Crossref, Scopus, DataCite) have a different source-orcid.path.
  let count = 0;
  if (worksData.group) {
    for (const group of worksData.group) {
      const summaries = group['work-summary'] || [];
      const hasExternalSource = summaries.some((s) => {
        const sourceOrcid = s.source?.['source-orcid']?.path;
        return sourceOrcid && sourceOrcid !== orcidId;
      });
      if (hasExternalSource) count++;
    }
  }
  return count;
}

async function getExistingAccreditation(username: string): Promise<{
  name: string; institution: string; field: string; method: string; orcid?: string;
} | null> {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    `SELECT cj.json FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $1
       AND cj.block_num >= $3
     ORDER BY cj.block_num DESC
     LIMIT 1`,
    [username, config.appTag, getCachedGenesisBlock()],
  );
  if (result.rows.length === 0) return null;

  const payload = typeof result.rows[0].json === 'string'
    ? JSON.parse(result.rows[0].json)
    : result.rows[0].json;

  if (payload.action === 'revoke') return null;
  return {
    name: payload.name || username,
    institution: payload.institution || '',
    field: payload.field || '',
    method: payload.method || 'email',
    orcid: payload.orcid || undefined,
  };
}

async function updateAccountOrcid(username: string, orcidId: string): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE accounts SET orcid = $1 WHERE username = $2`,
      [orcidId, username],
    );
  } catch (err) {
    logger.warn({ err, username }, 'Failed to update accounts.orcid (row may not exist for self-custody user)');
  }
}

// Export the in-memory verified map so auth.ts signup can consume nonces
export { orcidVerified };

export default router;
