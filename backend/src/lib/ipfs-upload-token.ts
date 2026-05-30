/**
 * Single-use IPFS upload tokens. These bind a declared file to an
 * authenticated pre-flight so the actual multipart upload cannot be replayed
 * with different content and cannot be driven by a stolen JWT alone.
 *
 * Flow: `POST /api/ipfs/upload-token` authenticates (signed request, or JWT +
 * fresh-auth proof), records the declared `{ file_sha256, mimetype, size }`,
 * and mints a token. `POST /api/ipfs/upload` then carries the token in a
 * header; the handler computes `sha256(file.buffer)` after multer parses and
 * consumes the token, rejecting unless the hash matches the declared one. The
 * declared descriptor is itself bound into the signed envelope on the signature
 * path (the canonical message body-hashes the pre-flight JSON), so a captured
 * pre-flight signature is useless for a different file.
 *
 * Storage mirrors the fresh-auth primitive: Redis-primary with an in-memory map
 * backup so a Redis flap between issue and consume does not spuriously reject a
 * legitimate upload. Single-use is enforced by GETDEL on the Redis tier and
 * delete-on-read on the memory tier; PEvO is single-instance so the memory tier
 * is authoritative when Redis is absent. TTL is short (60s) — just enough for
 * the SPA's pre-flight → upload round-trip.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';

const TOKEN_TTL_SECONDS = 60;
const TOKEN_BYTES = 32;
const KEY_PREFIX = `${config.appTag}:ipfs:upload_token:`;

export interface UploadTokenBinding {
  account: string;
  file_sha256: string;
  mimetype: string;
  size: number;
}

interface StoredToken extends UploadTokenBinding {
  expiresAtMs: number;
}

const memStore = new Map<string, StoredToken>();

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of memStore) {
    if (entry.expiresAtMs <= now) memStore.delete(token);
  }
}, 30_000);
cleanupInterval.unref();

/** Mint a single-use upload token bound to the declared file descriptor. */
export async function issueUploadToken(binding: UploadTokenBinding): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAtMs = Date.now() + TOKEN_TTL_SECONDS * 1000;
  // Memory backup written first so a Redis-write failure still leaves a
  // consumable token on a single-instance deployment.
  memStore.set(token, { ...binding, expiresAtMs });

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(KEY_PREFIX + token, JSON.stringify(binding), 'EX', TOKEN_TTL_SECONDS);
    } catch (err) {
      logger.warn(
        { err, event: 'ipfs.upload_token.redis_set_failed' },
        'Falling back to in-memory store for IPFS upload token',
      );
    }
  }
  return token;
}

function isUploadTokenBinding(value: unknown): value is UploadTokenBinding {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.account === 'string' &&
    typeof v.file_sha256 === 'string' &&
    typeof v.mimetype === 'string' &&
    typeof v.size === 'number'
  );
}

/**
 * Single-use consume. Returns the binding exactly once per issued token, and
 * only if it belongs to `account`; subsequent calls (or a mismatched account)
 * return null. The token is deleted from both storage tiers on the first
 * consume regardless of the account-match outcome, so a leaked token cannot be
 * brute-replayed against multiple accounts.
 */
export async function consumeUploadToken(
  token: string | undefined,
  account: string,
): Promise<UploadTokenBinding | null> {
  if (!token || typeof token !== 'string' || token.length === 0) return null;

  let raw: string | null = null;
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      raw = await redis.getdel(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'ipfs.upload_token.redis_getdel_failed' },
        'Falling back to in-memory lookup for IPFS upload token',
      );
    }
  }

  let binding: UploadTokenBinding | null = null;
  if (raw) {
    memStore.delete(token);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isUploadTokenBinding(parsed)) binding = parsed;
    } catch {
      binding = null;
    }
  } else {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token);
      if (cached.expiresAtMs > Date.now()) {
        binding = { account: cached.account, file_sha256: cached.file_sha256, mimetype: cached.mimetype, size: cached.size };
      }
    }
  }

  if (!binding) return null;
  // Account binding: a token minted for one account cannot authorize another's
  // upload. Checked after consume so a mismatched attempt still burns the token.
  if (binding.account !== account) return null;
  return binding;
}

/** Test helper: clear the in-memory tier between cases. */
export function _resetUploadTokenStoreForTests(): void {
  memStore.clear();
}
