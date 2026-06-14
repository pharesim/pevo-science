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
