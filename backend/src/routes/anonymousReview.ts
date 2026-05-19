import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';
import { config } from '../config.js';
import {
  hiveClient,
  broadcastJsonWithTimeout,
  broadcastSendOperationsWithTimeout,
} from '../hive.js';
import { HIVE_ACCOUNT_NAME_REGEX } from '../lib/hive-account-name.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { sendOk, sendError } from '../response.js';
import { verifyHiveSignature } from '../middleware/verifyHiveSignature.js';
import { validate, anonymousReviewSchema } from '../validation.js';
import { rateLimit, byAccount } from '../middleware/rateLimit.js';
import { getAccreditation } from '../routes/profile.js';
import { logger } from '../logger.js';
import type { AnonReviewAction } from '../types/index.js';

const anonReviewLimiter = rateLimit({ name: 'anon-review', windowMs: 60 * 60_000, max: 5, keyFn: byAccount });

const router = Router();

// ──────────────────────────────────────────────
// Encrypted mapping store: app database with in-memory fallback
// ──────────────────────────────────────────────

const ANON_TTL_DAYS = 180;

// In-memory fallback
const memoryMappings = new Map<string, { encrypted: string; iv: string; authTag: string; keyVersion: number; expiresAt: Date }>();

function getEncryptionKey(version: number): Buffer {
  if (version === config.anonReviewKeyVersion) {
    return Buffer.from(config.anonReviewEncryptionKey, 'hex');
  }
  if (config.anonReviewEncryptionKeyPrev) {
    return Buffer.from(config.anonReviewEncryptionKeyPrev, 'hex');
  }
  throw new Error(`No encryption key available for version ${version}`);
}

function encryptMapping(reviewerAccount: string): { encrypted: string; iv: string; authTag: string; keyVersion: number } {
  const key = Buffer.from(config.anonReviewEncryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(reviewerAccount, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), authTag, keyVersion: config.anonReviewKeyVersion };
}

function decryptMapping(encrypted: string, iv: string, authTag: string, keyVersion = 1): string {
  const key = getEncryptionKey(keyVersion);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function storeAnonMapping(
  permlink: string,
  paperAuthor: string,
  paperPermlink: string,
  encrypted: string,
  iv: string,
  authTag: string,
  keyVersion: number,
  expiresAt: Date,
): Promise<void> {
  const ttl = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  const value = JSON.stringify({ encrypted, iv, authTag, keyVersion, paperAuthor, paperPermlink, expiresAt });
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:anon_mapping:${permlink}`, value, 'EX', ttl);
  }
  memoryMappings.set(permlink, { encrypted, iv, authTag, keyVersion, expiresAt });
}

async function getAnonMapping(permlink: string): Promise<{ encrypted: string; iv: string; authTag: string; keyVersion: number } | null> {
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    const raw = await redis.get(`${config.appTag}:anon_mapping:${permlink}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { encrypted: parsed.encrypted, iv: parsed.iv, authTag: parsed.authTag, keyVersion: parsed.keyVersion };
    }
  }
  const mapping = memoryMappings.get(permlink);
  if (!mapping) return null;
  if (new Date() > mapping.expiresAt) {
    memoryMappings.delete(permlink);
    return null;
  }
  return { encrypted: mapping.encrypted, iv: mapping.iv, authTag: mapping.authTag, keyVersion: mapping.keyVersion };
}

async function cleanupExpiredMappings(): Promise<void> {
  // Redis handles TTL automatically; just clean in-memory map
  const now = new Date();
  for (const [k, v] of memoryMappings) {
    if (now > v.expiresAt) memoryMappings.delete(k);
  }
}

// ──────────────────────────────────────────────
// POST /api/reviews/anonymous
// ──────────────────────────────────────────────

router.post('/anonymous', verifyHiveSignature, anonReviewLimiter, validate(anonymousReviewSchema), async (
  req: Request<Record<string, string>, unknown, z.infer<typeof anonymousReviewSchema>>,
  res: Response,
) => {
  const username = req.hiveUsername!;
  const { paper_author, paper_permlink, body, rating } = req.body;

  // Verify the reviewer is accredited
  const accreditation = await getAccreditation(username);
  if (!accreditation) {
    return sendError(res, 403, 'FORBIDDEN', 'Only accredited researchers can post anonymous reviews');
  }

  // Prevent authors (including co-authors) from reviewing their own papers
  if (username === paper_author) {
    return sendError(res, 403, 'FORBIDDEN', 'Authors cannot review their own papers');
  }
  try {
    const post = await hiveClient.call('condenser_api', 'get_content', [paper_author, paper_permlink]);
    if (post && post.json_metadata) {
      const meta = typeof post.json_metadata === 'string' ? JSON.parse(post.json_metadata) : post.json_metadata;
      const pevoMeta = meta[config.appTag] || meta.pevo;
      const authors: Array<{ hive?: string }> = pevoMeta?.authors || [];
      if (authors.some(a => a.hive === username)) {
        return sendError(res, 403, 'FORBIDDEN', 'Authors cannot review their own papers');
      }
    }
  } catch {
    // Non-critical — if we can't fetch the paper, the primary author check above still applies
  }

  if (!config.pevoAnonPostingKey) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Anonymous review posting key not configured');
  }

  if (!config.anonReviewEncryptionKey) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Anonymous review encryption key not configured');
  }

  // Validate Hive-compatible format for author/permlink inputs
  const permlinkRegex = /^[a-z0-9-]+$/;
  if (!HIVE_ACCOUNT_NAME_REGEX.test(paper_author)) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid paper_author format');
  }
  if (!permlinkRegex.test(paper_permlink) || paper_permlink.length > 256) {
    return sendError(res, 400, 'BAD_REQUEST', 'Invalid paper_permlink format');
  }

  // Generate unique permlink
  const timestamp = Date.now();
  const safeAuthor = paper_author.replace(/[^a-z0-9-]/g, '-');
  const permlink = `re-${safeAuthor}-${paper_permlink}-anon-${timestamp}`;

  const jsonMetadata = {
    app: config.appId,
    tags: [config.appTag, 'review'],
    [config.appTag]: {
      type: 'review',
      version: 1,
      rating,
      is_anonymous: true,
      reviewer_attestation_id: null,
    },
  };

  try {
    const key = PrivateKey.fromString(config.pevoAnonPostingKey);
    const result = await broadcastSendOperationsWithTimeout(
      [
        ['comment', {
          parent_author: paper_author,
          parent_permlink: paper_permlink,
          author: config.hiveAnonAccount,
          permlink,
          title: '',
          body,
          json_metadata: JSON.stringify(jsonMetadata),
        }],
        ['comment_options', {
          author: config.hiveAnonAccount,
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

    // Store encrypted mapping
    const { encrypted, iv, authTag, keyVersion } = encryptMapping(username);
    const expiresAt = new Date(Date.now() + ANON_TTL_DAYS * 24 * 60 * 60 * 1000);
    await storeAnonMapping(permlink, paper_author, paper_permlink, encrypted, iv, authTag, keyVersion, expiresAt);

    // Broadcast on-chain attestation (best-effort, don't fail the request)
    const attestationId = crypto.createHash('sha256').update(`${permlink}:${encrypted}`).digest('hex');
    const attestation: AnonReviewAction = {
      action: 'anon_review',
      review_permlink: permlink,
      paper_author,
      paper_permlink,
      attestation_id: attestationId,
      expires: expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    };
    try {
      await broadcastJsonWithTimeout(
        { id: config.appTag, json: JSON.stringify(attestation), required_auths: [], required_posting_auths: [config.hiveAnonAccount] },
        key,
      );
    } catch (attestErr) {
      logger.error({
        err: attestErr,
        permlink,
        paper_author,
        paper_permlink,
        attestation_id: attestationId,
      }, 'Failed to broadcast anon review attestation — reviewer identity mapping stored but on-chain attestation missing');
    }

    sendOk(res, {
      author: config.hiveAnonAccount,
      permlink,
      tx_id: result.id,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to post anonymous review');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to post anonymous review to Hive');
  }
});

// Cleanup expired mappings periodically
setInterval(() => {
  cleanupExpiredMappings().catch((err) => {
    logger.error({ err }, 'Failed to cleanup expired anonymous review mappings');
  });
}, 60 * 60 * 1000);

export { decryptMapping, getAnonMapping };
export default router;
