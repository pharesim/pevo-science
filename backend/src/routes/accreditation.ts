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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Extended free email domain blocklist
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'protonmail.com', 'aol.com',
  'mail.com', 'zoho.com', 'yandex.com', 'icloud.com', 'live.com', 'msn.com',
  'gmx.com', 'gmx.net', 'tutanota.com', 'fastmail.com', 'hushmail.com',
  'guerrillamail.com', 'mailinator.com', 'tempmail.com', 'throwaway.email',
  'sharklasers.com', 'guerrillamailblock.com', 'grr.la', 'dispostable.com',
  'yopmail.com', '10minutemail.com', 'trashmail.com', 'maildrop.cc',
]);

// ──────────────────────────────────────────────
// POST /api/accreditation/request
// ──────────────────────────────────────────────

router.post('/request', verifyHiveSignature, accreditationRequestLimiter, validate(accreditationRequestSchema), async (req: Request, res: Response) => {
  const hive_username = req.hiveUsername!;
  const { full_name, institution, field, email, orcid } = req.body;

  // Email format is already validated by Zod's z.string().email() in the
  // validation middleware. This check ensures the domain is institutional.
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) {
    // Defensive: should never reach here after Zod validation
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid email address');
  }
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    return sendError(res, 422, 'VALIDATION_ERROR', 'Please use an institutional email address');
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

      const safeName = escapeHtml(full_name);
      const verifyUrl = `${config.appUrl}/accreditation/verify?token=${token}`;
      const safeUrl = escapeHtml(verifyUrl);
      await transporter.sendMail({
        from: config.smtpFrom,
        to: email,
        subject: 'PEvO Accreditation — Verify Your Email',
        text: `Hello ${full_name},\n\nPlease verify your email to complete your PEvO accreditation:\n\n${verifyUrl}\n\nThis link expires in 24 hours.\n\n— PEvO`,
        html: `<p>Hello ${safeName},</p><p>Please verify your email to complete your PEvO accreditation:</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>This link expires in 24 hours.</p><p>— PEvO</p>`,
      });
    } catch (mailErr) {
      logger.error({ err: (mailErr as Error).message }, 'Failed to send verification email');
      await deleteToken(token);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to send verification email');
    }
  } else if (process.env.NODE_ENV !== 'production') {
    logger.info({ hive_username }, 'Accreditation verification email skipped (SMTP not configured)');
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
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(stateKey, username, 'EX', ORCID_STATE_TTL_SECONDS);
  } else {
    // In-memory fallback
    orcidStates.set(state, { username, expires: Date.now() + ORCID_STATE_TTL_SECONDS * 1000 });
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
const orcidStates = new Map<string, { username: string; expires: number }>();

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
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    storedUsername = await redis.get(`orcid_state:${state}`);
    if (storedUsername) await redis.del(`orcid_state:${state}`);
  } else {
    const entry = orcidStates.get(state);
    if (entry && entry.expires > Date.now()) {
      storedUsername = entry.username;
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

    const customJsonPayload = {
      action: 'accredit',
      account: username,
      name: tokenData.name || username,
      institution: '',
      field: '',
      method: 'orcid',
      evidence_hash: crypto.createHash('sha256').update(`orcid:${orcidId}:${username}`).digest('hex'),
      timestamp: new Date().toISOString(),
    };

    const key = PrivateKey.fromString(config.pevoAdminPostingKey);
    const result = await hiveClient.broadcast.json(
      { id: config.appTag, json: JSON.stringify(customJsonPayload), required_auths: [], required_posting_auths: [config.hiveAdminAccount] },
      key,
    );

    sendOk(res, {
      message: 'Accreditation via ORCID confirmed',
      username,
      orcid: orcidId,
      tx_id: result.id,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'ORCID callback processing failed');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to process ORCID callback');
  }
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error({ err }, 'Failed to cleanup expired accreditation tokens');
  });
}, 60 * 60 * 1000);

export default router;
