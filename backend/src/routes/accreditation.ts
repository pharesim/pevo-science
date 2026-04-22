import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import { broadcastJsonWithTimeout } from '../hive.js';
import { handleBroadcastError } from '../lib/broadcast-error.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, accreditationRequestSchema, accreditationVerifySchema } from '../validation.js';
import { rateLimit, byAccount, byIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { isInstitutionalEmail } from '../email-validator.js';
import { hashEmailForLogs } from '../lib/log-pii.js';

/** How long a verification token stays valid before it expires. */
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    await redis.set(`${config.appTag}:pending_accred:${pending.token}`, JSON.stringify(pending), 'EX', ttl);
  }
  memoryTokens.set(pending.token, pending);
}

async function getToken(token: string): Promise<PendingAccreditation | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`${config.appTag}:pending_accred:${token}`);
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
    await redis.del(`${config.appTag}:pending_accred:${token}`);
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
    const result = await broadcastJsonWithTimeout(
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
    const outcome = handleBroadcastError(res, err, {
      timeoutMsg: 'Broadcasting accreditation timed out',
      failMsg: 'Failed to broadcast accreditation to Hive',
      logContext: { username: pending.hive_username, email_hash: hashEmailForLogs(pending.email) },
      routeLabel: 'accreditation.verify',
    });
    // On timeout: do NOT deleteToken — the 504 is retriable-after-verify, so
    // the token must survive its 24h TTL so the caller can retry after
    // verifying chain state (the broadcast outcome is uncertain).
    // On failure: the chain rejected the broadcast (retriable=false per the
    // envelope). The accreditation attempt is terminal for this token — delete
    // it so it cannot be reused. A new token is obtained via
    // /api/accreditation/request.
    if (outcome === 'failure') {
      await deleteToken(token);
    }
  }
});

// Cleanup expired tokens periodically
setInterval(() => {
  cleanupExpiredTokens().catch((err) => {
    logger.error({ err }, 'Failed to cleanup expired accreditation tokens');
  });
}, 60 * 60 * 1000);

export default router;
