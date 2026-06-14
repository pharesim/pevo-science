/**
 * Chain-derived admin roster + tier-authorization resolver and middleware.
 *
 * This is the human-authorization layer in front of the single on-chain signer
 * (`config.hiveAdminAccount` / `pevo.admin`). It does NOT widen the signer:
 * every authority op stays signed by the one admin key. What it adds is a
 * record of WHICH human is authorized to trigger that key, and at what tier.
 *
 * Tiers (ascending authority): `admin` < `super_admin` < `root`.
 *  - `admin` / `super_admin` are chain-derived: the latest non-revoked
 *    `admin_grant` per account (read via `activeAdminsCteBody`), Redis-cached
 *    exactly like accreditation membership (`getAllAccreditedAccounts`). There
 *    is no persistent roster table — the chain is the SSoT.
 *  - `root` is bootstrap config (`config.rootAdminAccount`, the operator /
 *    on-chain key-holder) — never a chain grant, un-demotable, and resolvable
 *    even when HAF is down.
 *
 * Fail-closed: if the chain roster cannot be read (transient HAF error), the
 * resolver denies chain-derived tiers rather than guessing. Root still resolves
 * from config, so the operator is never locked out.
 *
 * `requireAdminLevel` resolves the tier of the verified caller and is
 * necessary-but-not-sufficient for a critical action: per ARCHITECTURE.md §6.4 /
 * §6.5 invariant #1, an authority endpoint must ALSO carry a fresh re-auth proof
 * appropriate to the caller's auth mechanism (a per-request Hive signature for
 * self-custody, a fresh-auth token for light accounts) — never a bare JWT. The
 * tier middleware is composed with that proof check at the route, not folded
 * into it here, so the same resolver serves both auth mechanisms.
 */
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { hafCache } from './cache.js';
import { buildWith, activeAdminsCteBody } from './hafsql.js';
import { sendError } from './response.js';
import {
  consumeFreshAuthToken,
  computeFreshAuthTargetHash,
  adminActionFreshAuthTarget,
  type AdminFreshAuthTargetAction,
} from './lib/fresh-auth.js';

export type AdminLevel = 'admin' | 'super_admin' | 'root';

/** Chain-grantable tiers (root is config-only, never a chain row). */
export type ChainAdminLevel = 'admin' | 'super_admin';

/** Ascending authority rank; higher outranks lower. */
const LEVEL_RANK: Record<AdminLevel, number> = {
  admin: 1,
  super_admin: 2,
  root: 3,
};

const ADMIN_ROSTER_CACHE_KEY = 'admin_roster_all';
// Backstop TTL only — promote/demote busts the key so a grant/revoke is visible
// immediately; this refresh just bounds staleness if a bust is ever missed.
const ADMIN_ROSTER_TTL_MS = 5 * 60_000;

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAdminLevel` after a successful tier check. */
      adminLevel?: AdminLevel;
    }
  }
}

function isChainAdminLevel(v: unknown): v is ChainAdminLevel {
  return v === 'admin' || v === 'super_admin';
}

/**
 * Load the live chain-derived roster as an `account -> tier` map.
 *
 * `pool === null` (HAF not configured, e.g. dev) yields an empty roster — a
 * persistent startup condition, not a transient outage, so caching it is fine
 * (root still resolves from config). A genuine query error re-throws so the
 * empty result is NOT cached as a false "no admins" for the TTL (that would
 * deny real admins until the cache expired); the resolver catches the throw and
 * fails closed per-call instead.
 */
async function loadAdminRoster(): Promise<Record<string, ChainAdminLevel>> {
  const pool = getPool();
  if (!pool) return {};

  try {
    const cte = buildWith(1, activeAdminsCteBody);
    const result = await pool.query(
      `${cte.sql}
       SELECT account, level FROM active_admins`,
      cte.params,
    );
    const roster: Record<string, ChainAdminLevel> = {};
    for (const row of result.rows as Array<{ account: string; level: string }>) {
      // Drop forged/malformed levels defensively: only the two valid tiers are
      // honored, anything else confers nothing.
      if (isChainAdminLevel(row.level)) {
        roster[row.account] = row.level;
      }
    }
    return roster;
  } catch (err) {
    logger.error({ err }, 'admin roster HAF read failed');
    throw err;
  }
}

/** Live `account -> tier` roster (chain-derived tiers only), Redis-cached. */
export async function getAdminRoster(): Promise<Record<string, ChainAdminLevel>> {
  return hafCache.getOrSet<Record<string, ChainAdminLevel>>(
    ADMIN_ROSTER_CACHE_KEY,
    loadAdminRoster,
    ADMIN_ROSTER_TTL_MS,
    true,
  );
}

/** Force the next `getAdminRoster` to re-derive from chain (call after a grant/revoke broadcast). */
export async function bustAdminRosterCache(): Promise<void> {
  await hafCache.invalidate(ADMIN_ROSTER_CACHE_KEY);
}

/** One chain-derived roster member with attribution metadata for display. */
export interface AdminRosterEntry {
  account: string;
  level: ChainAdminLevel;
  /** Acting super_admin/root that signed the grant (op `issued_by`); null on legacy/forged. */
  granted_by: string | null;
  /** Grant op payload timestamp (display only; chain order is by block_num). */
  granted_at: string | null;
}

/**
 * Read the live chain-derived roster as a detailed list (for `GET
 * /api/admin/roster`). Direct (uncached) HAF read — the admin console is
 * low-volume and wants attribution columns the account->tier cache omits. Root
 * is bootstrap config, not a chain row, so it is NOT in this list; the caller
 * surfaces the viewer's own resolved tier separately. Returns [] when HAF is
 * unconfigured; re-throws a genuine query error to the handler.
 */
export async function getAdminRosterDetailed(): Promise<AdminRosterEntry[]> {
  const pool = getPool();
  if (!pool) return [];
  const cte = buildWith(1, activeAdminsCteBody);
  const result = await pool.query(
    `${cte.sql}
     SELECT account, level, granted_by, granted_at
     FROM active_admins
     ORDER BY level DESC, account ASC`,
    cte.params,
  );
  const entries: AdminRosterEntry[] = [];
  for (const row of result.rows as Array<{ account: string; level: string; granted_by: string | null; granted_at: string | null }>) {
    if (isChainAdminLevel(row.level)) {
      entries.push({
        account: row.account,
        level: row.level,
        granted_by: row.granted_by ?? null,
        granted_at: row.granted_at ?? null,
      });
    }
  }
  return entries;
}

/**
 * Resolve the live admin tier of `username`, or `null` for no authority.
 * Resolution order: root (bootstrap config) -> latest non-revoked chain grant
 * -> none. Fails closed (returns `null`) if the chain roster cannot be read.
 */
export async function getAdminLevel(username: string): Promise<AdminLevel | null> {
  if (!username) return null;
  if (username === config.rootAdminAccount) return 'root';
  try {
    const roster = await getAdminRoster();
    return roster[username] ?? null;
  } catch (err) {
    logger.warn({ err, username }, 'admin level resolution failed; denying (fail-closed)');
    return null;
  }
}

/** True if `level` meets or exceeds `min` in the tier hierarchy. */
export function levelMeets(level: AdminLevel | null, min: AdminLevel): boolean {
  return level !== null && LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/**
 * Express middleware: require the verified caller to hold at least `min` tier.
 * Must run AFTER `verifyHiveSignature` (it keys off `req.hiveUsername`, the
 * cryptographically verified account, never a JWT claim). On success it stashes
 * `req.adminLevel` for the handler (issued_by attribution, audit). See the
 * module docstring: this gates WHO may act; the route must separately require a
 * fresh re-auth proof per §6.4.
 */
export function requireAdminLevel(min: AdminLevel) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const username = req.hiveUsername;
    if (!username) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for this action');
      return;
    }
    const level = await getAdminLevel(username);
    if (!levelMeets(level, min)) {
      sendError(res, 403, 'FORBIDDEN', 'Insufficient admin privileges for this action');
      return;
    }
    req.adminLevel = level ?? undefined;
    next();
  };
}

/**
 * Express middleware: enforce the §6.4 fresh re-auth proof for an admin
 * authority `action`, the second independent gate that `requireAdminLevel` is
 * explicitly NOT (see module docstring). Compose it AFTER `verifyHiveSignature`
 * and `requireAdminLevel`, and AFTER `validate(...)` so a malformed body 400s
 * without burning the caller's single-use proof.
 *
 * - Self-custody / Keychain caller (`hiveAuthMethod === 'signature'`): the
 *   per-request Hive signature verified upstream IS the fresh proof; pass.
 * - Light-account caller (`hiveAuthMethod === 'jwt'`): a replayable bearer JWT
 *   is never sufficient for a critical action (§6.5 invariant #1). Demand a
 *   single-use, target-bound `fresh_auth_proof` in the body, consumed against
 *   `(action, <caller-username>, '')`. The distinct `action` in the target hash
 *   stops a proof minted for one admin action being redirected to another, and
 *   the username binding stops a proof minted by admin A authorizing admin B.
 *
 * The 403-vs-401 split mirrors the `ipfs.ts` / custody consent-op consume:
 * binding violations (`username_mismatch` / `target_mismatch` / `kind_mismatch`)
 * are "forbidden" (a proof was presented but for the wrong user/action/kind);
 * `missing` / `expired` / `malformed` are "no valid proof present".
 */
export function requireFreshAdminAuth(action: AdminFreshAuthTargetAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const username = req.hiveUsername;
    if (!username) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required for this action');
      return;
    }
    if (req.hiveAuthMethod === 'jwt') {
      const proofRaw = (req.body as { fresh_auth_proof?: unknown })?.fresh_auth_proof;
      const proofToken = typeof proofRaw === 'string' ? proofRaw : undefined;
      const expectedTargetHash = computeFreshAuthTargetHash(adminActionFreshAuthTarget(action, username));
      const result = await consumeFreshAuthToken(proofToken, username, expectedTargetHash);
      if (!result.valid) {
        const status =
          result.reason === 'username_mismatch' ||
          result.reason === 'target_mismatch' ||
          result.reason === 'kind_mismatch'
            ? 403
            : 401;
        sendError(
          res,
          status,
          'FRESH_AUTH_REQUIRED',
          'Re-authentication required for this admin action. Please complete the fresh-auth challenge and retry.',
          { reason: result.reason },
        );
        return;
      }
    }
    next();
  };
}
