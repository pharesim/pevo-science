import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { hiveClient } from '../hive.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationRequestSchema, accreditationVerifySchema } from '../validation.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { getPool } from '../db.js';
import { T, getCachedGenesisBlock } from '../hafsql.js';

/** How long a verification token stays valid before it expires. */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How long an ORCID OAuth state parameter stays valid (seconds). */
const ORCID_STATE_TTL_SECONDS = 600; // 10 minutes

const accreditationRequestLimiter = rateLimit({ name: 'accred-req', windowMs: 24 * 60 * 60_000, max: 3, keyFn: byAccount });
const accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp });

const router = Router();

// ──────────────────────────────────────────────
// Token store: app database with in-memory fallback
// ──────────────────────────────────────────────

interface PendingAccreditation {
  hive_username: string;
  full_name: string;
  institution: string;
  field: string;
  email: string;
  orcid: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// In-memory fallback when APP_DATABASE_URL is not configured
const memoryTokens = new Map<string, PendingAccreditation>();

async function storeToken(pending: PendingAccreditation): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const ttl = Math.max(1, Math.ceil((pending.expires_at.getTime() - Date.now()) / 1000));
    await redis.set(`pending_accred:${pending.token}`, JSON.stringify(pending), 'EX', ttl);
  }
  memoryTokens.set(pending.token, pending);
}

async function getToken(token: string): Promise<PendingAccreditation | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`pending_accred:${token}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...parsed, expires_at: new Date(parsed.expires_at), created_at: new Date(parsed.created_at) };
    }
  }
  const pending = memoryTokens.get(token);
  if (!pending) return null;
  if (new Date() > pending.expires_at) {
    memoryTokens.delete(token);
    return null;
  }
  return pending;
}

async function deleteToken(token: string): Promise<void> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.del(`pending_accred:${token}`);
  }
  memoryTokens.delete(token);
}

async function cleanupExpiredTokens(): Promise<void> {
  // Redis handles TTL automatically; just clean in-memory map
  const now = new Date();
  for (const [t, p] of memoryTokens) {
    if (now > p.expires_at) memoryTokens.delete(t);
  }
}

function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '***@***';
  const [local, domain] = parts;
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : domain;
  const maskedLocal = local.length <= 2 ? `${local[0]}***` : `${local[0]}***`;
  return `${maskedLocal}@***${tld}`;
}


// ──────────────────────────────────────────────
// POST /api/accreditation/request
// ──────────────────────────────────────────────

router.post('/request', verifyHiveSignature, accreditationRequestLimiter, validate(accreditationRequestSchema), async (req: Request, res: Response) => {
  const hive_username = req.hiveUsername!;
  const { full_name, institution, field, email, orcid } = req.body;

  if (!isInstitutionalEmail(email)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Only institutional email addresses are accepted');
  }

  // Generate verification token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

  const pending: PendingAccreditation = {
    hive_username,
    full_name,
    institution,
    field,
    email,
    orcid: orcid || '',
    token,
    expires_at: expiresAt,
    created_at: new Date(),
  };
  await storeToken(pending);

  // Send verification email
  if (config.smtpHost) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });

      const verifyUrl = `${config.appUrl}/accreditation/verify?token=${token}`;
      await transporter.sendMail({
        from: config.smtpFrom,
        to: email,
        subject: 'PEvO - Verify your accreditation',
        text: `Hello ${full_name},\n\nPlease verify your email to complete your PEvO accreditation:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nPEvO - Open Scientific Publishing\nhttps://pevo.science`,
      });
    } catch (mailErr) {
      logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
      await deleteToken(token);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
    }
  } else {
    logger.error({ hive_username }, 'SMTP not configured — cannot send verification email');
    await deleteToken(token);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Email service not configured');
  }

  sendOk(res, {
    message: `Verification email sent to ${maskEmail(email)}`,
    expires_at: expiresAt.toISOString(),
  });
});

// ──────────────────────────────────────────────
// POST /api/accreditation/verify
// ──────────────────────────────────────────────

router.post('/verify', accreditationVerifyLimiter, validate(accreditationVerifySchema), async (req: Request, res: Response) => {
  const { token } = req.body;

  const pending = await getToken(token);
  if (!pending) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired token');
  }

  // Broadcast accreditation custom_json to Hive
  if (!config.pevoAdminPostingKey) {
    await deleteToken(token);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
  }

  const evidenceHash = crypto
    .createHash('sha256')
    .update(`${pending.email}:${pending.hive_username}:${pending.token}`)
    .digest('hex');

  const customJsonPayload = {
    action: 'accredit',
    account: pending.hive_username,
    name: pending.full_name,
    institution: pending.institution,
    field: pending.field,
    method: 'email',
    evidence_hash: evidenceHash,
    timestamp: new Date().toISOString(),
  };

  try {
    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await hiveClient.broadcast.json(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    await deleteToken(token);

    sendOk(res, {
      message: 'Accreditation confirmed',
      username: pending.hive_username,
      tx_id: result.id,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to broadcast accreditation');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to broadcast accreditation to Hive');
  }
});

// ──────────────────────────────────────────────
// GET /api/accreditation/orcid/start
// ──────────────────────────────────────────────

router.get('/orcid/start', verifyHiveSignature, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret || !config.orcidRedirectUri) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const username = req.hiveUsername!;

  // Check if already accredited
  const { getAccreditedSet } = await import('../accreditation.js');
  const accreditedSet = await getAccreditedSet([username]);
  if (accreditedSet.has(username)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Account is already accredited');
  }

  // Generate state param for CSRF protection
  const state = crypto.randomBytes(16).toString('hex');
  const stateKey = `orcid_state:${state}`;

  // Store in Redis if available, otherwise in-memory
  const stateData = JSON.stringify({ username, mode: 'accredit' });
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, stateData, 'EX', ORCID_STATE_TTL_SECONDS);
  } else {
    // In-memory fallback
    orcidStates.set(state, { username, mode: 'accredit', expires: Date.now() + ORCID_STATE_TTL_SECONDS * 1000 });
  }

  const redirectUrl = `${config.orcidBaseUrl}/oauth/authorize?` +
    `client_id=${encodeURIComponent(config.orcidClientId)}` +
    `&response_type=code` +
    `&scope=/authenticate` +
    `&redirect_uri=${encodeURIComponent(config.orcidRedirectUri)}` +
    `&state=${state}`;

  sendOk(res, { redirect_url: redirectUrl });
});

// In-memory ORCID state store fallback
const orcidStates = new Map<string, { username: string; mode: 'accredit' | 'link'; expires: number }>();

// ──────────────────────────────────────────────
// POST /api/accreditation/orcid/callback
// ──────────────────────────────────────────────

router.post('/orcid/callback', verifyHiveSignature, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret || !config.orcidRedirectUri) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const username = req.hiveUsername!;
  const { code, state } = req.body as { code?: string; state?: string };

  if (!code || !state) {
    return sendError(res, 400, 'BAD_REQUEST', 'code and state are required');
  }

  // Verify state
  let storedUsername: string | null = null;
  let stateMode: 'accredit' | 'link' = 'accredit';
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`orcid_state:${state}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        storedUsername = parsed.username;
        stateMode = parsed.mode || 'accredit';
      } catch {
        storedUsername = raw; // backwards compat with plain username strings
      }
      await redis.del(`orcid_state:${state}`);
    }
  } else {
    const entry = orcidStates.get(state);
    if (entry && entry.expires > Date.now()) {
      storedUsername = entry.username;
      stateMode = entry.mode || 'accredit';
    }
    orcidStates.delete(state);
  }

  if (!storedUsername || storedUsername !== username) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter');
  }

  // Exchange code for access token
  try {
    const tokenRes = await fetch(`${config.orcidBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        client_id: config.orcidClientId,
        client_secret: config.orcidClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.orcidRedirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ status: tokenRes.status, body: errText }, 'ORCID token exchange failed');
      return sendError(res, 400, 'BAD_REQUEST', 'Failed to exchange ORCID authorization code');
    }

    const tokenData = await tokenRes.json() as { orcid: string; name?: string; access_token?: string };
    const orcidId = tokenData.orcid;
    if (!orcidId) {
      return sendError(res, 400, 'BAD_REQUEST', 'ORCID response missing orcid field');
    }

    // Broadcast accreditation custom_json
    if (!config.pevoAdminPostingKey) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Admin posting key not configured');
    }

    let customJsonPayload;
    if (stateMode === 'link') {
      // Link mode: fetch existing accreditation data and preserve it
      const existing = await getExistingAccreditation(username);
      if (!existing) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Account is not accredited');
      }
      customJsonPayload = {
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
    } else {
      customJsonPayload = {
        action: 'accredit',
        account: username,
        name: tokenData.name || username,
        institution: '',
        field: '',
        method: 'orcid',
        orcid: orcidId,
        evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
        timestamp: new Date().toISOString(),
      };
    }

    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await hiveClient.broadcast.json(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    sendOk(res, {
      message: stateMode === 'link' ? 'ORCID linked successfully' : 'Accreditation via ORCID confirmed',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'ORCID callback processing failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to process ORCID callback');
  }
});

// ──────────────────────────────────────────────
// Helper — fetch existing accreditation from HAF
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// GET /api/accreditation/orcid/link-start
// ──────────────────────────────────────────────

router.get('/orcid/link-start', verifyHiveSignature, async (req: Request, res: Response) => {
  if (!config.orcidClientId || !config.orcidClientSecret || !config.orcidRedirectUri) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'ORCID integration is not configured');
  }

  const username = req.hiveUsername!;

  // Require accredited
  const { getAccreditedSet } = await import('../accreditation.js');
  const accreditedSet = await getAccreditedSet([username]);
  if (!accreditedSet.has(username)) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited users can link ORCID');
  }

  // Generate state param for CSRF protection
  const state = crypto.randomBytes(16).toString('hex');
  const stateKey = `orcid_state:${state}`;
  const stateData = JSON.stringify({ username, mode: 'link' });

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, stateData, 'EX', ORCID_STATE_TTL_SECONDS);
  } else {
    orcidStates.set(state, { username, mode: 'link', expires: Date.now() + ORCID_STATE_TTL_SECONDS * 1000 });
  }

  const redirectUrl = `${config.orcidBaseUrl}/oauth/authorize?` +
    `client_id=${encodeURIComponent(config.orcidClientId)}` +
    `&response_type=code` +
    `&scope=/authenticate` +
    `&redirect_uri=${encodeURIComponent(config.orcidRedirectUri)}` +
    `&state=${state}`;

  sendOk(res, { redirect_url: redirectUrl });
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error({ err }, 'Failed to cleanup expired accreditation tokens');
  });
}, 60 * 60 * 1000);

export default router;
