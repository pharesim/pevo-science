/**
 * Fresh-auth challenge primitive for sensitive custody-endpoint operations.
 *
 * Purpose
 * -------
 * `author_accept` and `author_resign` consent ops are reputationally weighty
 * (the broadcast event is permanently attributed on chain even though
 * vouched state is reversible). ARCH.md "Light-account signing of consent
 * ops" requires the backend to demand a per-op fresh authentication
 * challenge appropriate to the user's auth mechanism: a password re-prompt
 * for password-based accounts, a fresh ORCID OAuth round-trip for
 * ORCID-authed accounts.
 *
 * Wire shape
 * ----------
 * Token: 32-byte hex string, opaque to clients. Stored at
 * `${appTag}:fresh_auth:consent_op:${token}` (Redis when available;
 * in-memory fallback). TTL: `FRESH_AUTH_TTL_SECONDS` (5 min). Stored value:
 * `{ username, mechanism, issued_at }` JSON. Consumption is single-use via
 * Redis `GETDEL` (or `delete()` on the in-memory map).
 *
 * Binding
 * -------
 * - The token is bound to the **issuing username** at mint time. Consume
 *   verifies the JWT subject equals the stored username; cross-account
 *   replay is rejected at the route layer.
 * - `mechanism` is an informational discriminator carried into
 *   `custody_audit_log.auth_mechanism` (round-3 audit-log extension); it is
 *   NOT used as a security predicate. The security primitives are token
 *   secrecy + single-use + username binding + TTL.
 *
 * Issuance paths (route-layer; this module is the storage primitive)
 * ------------------------------------------------------------------
 * - Password mechanism: `POST /api/custody/fresh-auth` accepts a password,
 *   bcrypt-verifies against `accounts.password_hash`, then calls
 *   `issueFreshAuthToken(username, 'password')`.
 * - ORCID mechanism: ORCID callback in `mode: 'fresh_auth'` verifies the
 *   OAuth-returned `orcid_id` equals `account.orcid`, then calls
 *   `issueFreshAuthToken(username, 'orcid')`.
 *
 * Consume path
 * ------------
 * `POST /api/custody/broadcast` for any operation whose payload action is
 * in `CONSENT_OP_ACTIONS` requires `fresh_auth_proof` in the request body.
 * The handler calls `consumeFreshAuthToken(token, jwtSubject)` and rejects
 * the broadcast on any non-`valid` outcome before signing.
 *
 * Spec
 * ----
 * `agents/docs/ARCHITECTURE.md` section 2 "Light-account signing of consent
 * ops". Round-3 implementation of
 * `agents/docs/tasks/pending/backend-coauthor-trust-model.md`.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { logger } from '../logger.js';

/** Set of `custom_json` payload actions that require a fresh-auth proof. */
export const CONSENT_OP_ACTIONS: ReadonlySet<string> = new Set([
  'author_accept',
  'author_resign',
]);

export type FreshAuthMechanism = 'password' | 'orcid';

/** Token TTL in seconds. 5 minutes — bounded enough to limit replay risk
 *  if the token leaks, generous enough for a "re-auth then broadcast" UX
 *  without forcing the user to re-prompt mid-flow. */
export const FRESH_AUTH_TTL_SECONDS = 300;

const TOKEN_BYTES = 32;
const KEY_PREFIX = `${config.appTag}:fresh_auth:consent_op:`;

interface StoredEntry {
  username: string;
  mechanism: FreshAuthMechanism;
  /** Epoch ms. Informational; expiry is enforced by Redis EX / map cleanup. */
  issued_at: number;
}

/** In-memory fallback. Intentionally module-scoped — fresh-auth tokens are
 *  short-lived and process-local fallback is acceptable when Redis is
 *  unavailable (matches the convention in `routes/orcid.ts:151`). */
const memStore = new Map<string, { entry: StoredEntry; expiresAt: number }>();

/** Periodic cleanup so the map doesn't grow unbounded under no-Redis ops.
 *  Same shape as the orcid_state cleaner in orcid.ts. */
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [token, { expiresAt }] of memStore) {
    if (expiresAt <= now) memStore.delete(token);
  }
}, 60_000);
cleanupInterval.unref();

export interface IssuedFreshAuth {
  token: string;
  /** Epoch seconds at which the token expires. */
  expires_at: number;
  mechanism: FreshAuthMechanism;
}

/**
 * Mint a fresh-auth token for `username` with the given mechanism. The
 * caller (route handler) is responsible for verifying the user actually
 * proved control via that mechanism BEFORE calling this function.
 *
 * Storage path: Redis preferred; falls back to the module-local map on
 * unavailable Redis or write failure. Both paths are TTL-bounded.
 */
export async function issueFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
): Promise<IssuedFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const entry: StoredEntry = { username, mechanism, issued_at: issuedAt };
  const expiresAt = Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      await redis.set(
        KEY_PREFIX + token,
        JSON.stringify(entry),
        'EX',
        FRESH_AUTH_TTL_SECONDS,
      );
      return { token, expires_at: expiresAt, mechanism };
    } catch (err) {
      logger.warn(
        { err, username, event: 'fresh_auth.redis_set_failed' },
        'Falling back to in-memory store for fresh-auth token',
      );
      // fall through
    }
  }

  memStore.set(token, { entry, expiresAt: issuedAt + FRESH_AUTH_TTL_SECONDS * 1000 });
  return { token, expires_at: expiresAt, mechanism };
}

export type FreshAuthVerifyResult =
  | { valid: true; mechanism: FreshAuthMechanism }
  | {
      valid: false;
      reason: 'missing' | 'invalid' | 'expired' | 'username_mismatch' | 'malformed';
    };

/**
 * Single-use consume of a fresh-auth token. Returns `{ valid: true,
 * mechanism }` exactly once per issued token; subsequent calls return
 * `{ valid: false, reason: 'expired' }` (already consumed by the GETDEL /
 * map.delete()).
 *
 * The route layer rejects the broadcast on any non-valid outcome.
 */
export async function consumeFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  let raw: string | null = null;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      // GETDEL: atomic single-use semantic. Available since Redis 6.2; ioredis
      // exposes it as `getdel`. Falls through to in-memory on error so a
      // Redis flap mid-session doesn't lock out a legitimate user with a
      // pending mem-store fallback token (issuance race window).
      raw = await redis.getdel(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_getdel_failed' },
        'Falling back to in-memory lookup for fresh-auth verify',
      );
    }
  }

  if (!raw) {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token); // single-use even on the fallback path
      if (cached.expiresAt > Date.now()) {
        raw = JSON.stringify(cached.entry);
      }
    }
  }

  if (!raw) return { valid: false, reason: 'expired' };

  let entry: StoredEntry;
  try {
    entry = JSON.parse(raw) as StoredEntry;
  } catch {
    // Stored value parse failure — treat as malformed-but-consumed.
    return { valid: false, reason: 'malformed' };
  }

  if (typeof entry.username !== 'string' || typeof entry.mechanism !== 'string') {
    return { valid: false, reason: 'malformed' };
  }

  if (entry.username !== expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  if (entry.mechanism !== 'password' && entry.mechanism !== 'orcid') {
    return { valid: false, reason: 'malformed' };
  }

  return { valid: true, mechanism: entry.mechanism };
}

/** Test-only hook: clears the in-memory fallback store. Not exposed to
 *  route handlers. */
export function _resetFreshAuthMemStoreForTests(): void {
  memStore.clear();
}
