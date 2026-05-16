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
 *   argon2-verifies against `accounts.password_hash`, then calls
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

/** Round-5 hold #3: action component of the per-op target binding. The
 *  fresh-auth proof binds to the (action, root_author, root_permlink)
 *  triple of the op being authorized. Without this binding, a
 *  compromised SPA could swap action/target between the user's
 *  authentication ceremony and the route that consumes the proof
 *  ("substitute author_resign on paper Y for the author_accept on paper X
 *  the user thought they authorized").
 *
 *  Round-6 of BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH:
 *  `'set_password'` joins the consent-op actions as a non-broadcast
 *  critical action (transitions state C → state B per ARCHITECTURE.md
 *  § 6.3, requiring fresh ORCID re-auth per § 6.4). For `'set_password'`
 *  there is no paper involved; the binding fields used are
 *  `root_author = <username>` and `root_permlink = ''`. The username
 *  binding via `root_author` plus the action discriminator keeps the
 *  resulting target hash collision-free against any consent-op proof
 *  (consent ops require non-empty `root_permlink` at the route layer).
 *  See `routes/orcid.ts` `/start` and `routes/settings.ts` `/set-password`. */
export type FreshAuthTargetAction = 'author_accept' | 'author_resign' | 'set_password';

/** Round-5 hold #3: shape of the per-op target the fresh-auth proof
 *  binds to. The triple is reduced to a SHA-256 hash at issuance time
 *  via `computeFreshAuthTargetHash`. The hash, not the cleartext fields,
 *  is what's stored in the entry — the hash domain-separates from any
 *  other fields that may share the same underlying string-concat shape. */
export interface FreshAuthTarget {
  action: FreshAuthTargetAction;
  root_author: string;
  root_permlink: string;
}

/** Round-6 of BACKEND-SETTINGS-SET-PASSWORD-FRESH-AUTH: helper that builds
 *  the canonical `FreshAuthTarget` for the `/set-password` flow. The target
 *  binds the proof to the username so a proof minted for user A cannot
 *  authorize a set-password on user B (the `consumeFreshAuthToken` username
 *  check already enforces this; the target binding is a defense-in-depth
 *  fold that also kills swap-of-action substitution attacks at the consume
 *  side). `root_permlink` is intentionally empty: no paper is involved in
 *  set-password, and the route layer for consent ops forbids empty
 *  `root_permlink` strings, so this hash cannot collide with any
 *  consent-op proof. */
export function setPasswordFreshAuthTarget(username: string): FreshAuthTarget {
  return {
    action: 'set_password',
    root_author: username,
    root_permlink: '',
  };
}

/** Round-4 hold #8: type-guard for the storage `mechanism` field. The
 *  membership test diverges from the union if the union grows and the
 *  test isn't updated; consolidating it here means a single point of
 *  maintenance. Used by `consumeFreshAuthToken` to narrow `unknown` from
 *  `JSON.parse` into the typed `FreshAuthMechanism`. */
export function isFreshAuthMechanism(value: unknown): value is FreshAuthMechanism {
  return value === 'password' || value === 'orcid';
}

/** Token TTL in seconds. 5 minutes — bounded enough to limit replay risk
 *  if the token leaks, generous enough for a "re-auth then broadcast" UX
 *  without forcing the user to re-prompt mid-flow.
 *
 *  Round-4 hold #13: kept exported for tests (the in-memory TTL-expiry
 *  fake-timer test in `tests/lib/fresh-auth.test.ts` advances `Date.now()`
 *  past this boundary). */
export const FRESH_AUTH_TTL_SECONDS = 300;

const TOKEN_BYTES = 32;
const KEY_PREFIX = `${config.appTag}:fresh_auth:consent_op:`;

/** Discriminates per-op consent proofs (target-bound) from session-level
 *  broadcast proofs (target-less). Non-consent broadcast surfaces don't
 *  need per-op binding — they just need proof that the user re-authed in
 *  the recent past. See BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH for
 *  the State C / non-consent broadcast path that motivates the variant. */
export type FreshAuthKind = 'consent_op' | 'session';

interface StoredEntry {
  username: string;
  mechanism: FreshAuthMechanism;
  /** Epoch ms. Informational; expiry is enforced by Redis EX / map cleanup. */
  issued_at: number;
  /** Discriminator: `'consent_op'` (default, target-bound) or `'session'`
   *  (target-less session proof for non-consent broadcast). Stored entries
   *  predating this field are treated as `'consent_op'` on consume so the
   *  consume-side bind check still fires (closed-default). */
  kind: FreshAuthKind;
  /** Round-5 hold #3: SHA-256 hex of the target triple under a
   *  length-prefixed encoding (see `computeFreshAuthTargetHash`). The
   *  consume side recomputes the hash from the bundle's consent op fields
   *  and rejects on mismatch. Stored as hex (64 chars) for JSON-safety.
   *
   *  Optional only when `kind === 'session'` — session-kind proofs are not
   *  bound to a per-op target. Consent-op-kind entries MUST carry a
   *  well-shaped hash; absence is malformed-on-consume. */
  target_hash?: string;
}

/**
 * Round-5 hold #3: compute the per-op target hash. The bind is over a
 * length-prefixed encoding of the triple:
 *
 *   `<len(action)>|<action>|<len(root_author)>|<root_author>|<len(root_permlink)>|<root_permlink>`
 *
 * Length-prefixing is collision-free for arbitrary string content: any
 * two distinct triples produce distinct encodings even if individual
 * field values share substrings or contain the '|' separator. A naive
 * pipe-only delimiter (`a|b|c`) collides for `(a='x|y', b='c')` vs
 * `(a='x', b='y|c')`. Hive permlinks today are restricted to lowercase
 * alphanumerics and hyphens so '|' cannot appear in practice, but the
 * encoder defends against that constraint relaxing in the future and
 * makes the binding contract self-evidently correct under any string
 * input rather than relying on an external invariant.
 */
export function computeFreshAuthTargetHash(target: FreshAuthTarget): string {
  const concat =
    `${target.action.length}|${target.action}|` +
    `${target.root_author.length}|${target.root_author}|` +
    `${target.root_permlink.length}|${target.root_permlink}`;
  return crypto.createHash('sha256').update(concat).digest('hex');
}

/** Round-5 hold #3: type-guard for the `target_hash` field on the stored
 *  entry. A stored entry written by the round-4 path (no `target_hash`
 *  field) MUST be rejected on consume — closed-default policy. The
 *  membership check is structural: hex-string of length 64. */
function isValidTargetHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Type guard for the storage `kind` field. Legacy entries (written before
 *  the kind discriminator landed) do not carry the field — those are
 *  treated as `'consent_op'` on consume so the target-bind check still
 *  fires (closed-default for the original security property). */
function isFreshAuthKind(value: unknown): value is FreshAuthKind {
  return value === 'consent_op' || value === 'session';
}

/** In-memory fallback. Intentionally module-scoped — fresh-auth tokens are
 *  short-lived and process-local fallback is acceptable when Redis is
 *  unavailable (matches the convention in `routes/orcid.ts:151`). */
const memStore = new Map<string, { entry: StoredEntry; expiresAt: number }>();

/** Periodic cleanup so the map doesn't grow unbounded under no-Redis ops.
 *  Same shape as the orcid_state cleaner in orcid.ts. Wrapped in a
 *  start/stop pair so tests can deterministically pause the cleaner during
 *  fake-timer scenarios (round-4 hold #15). */
const CLEANUP_INTERVAL_MS = 60_000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupInterval !== null) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, { expiresAt }] of memStore) {
      if (expiresAt <= now) memStore.delete(token);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();
}

startCleanup();

interface IssuedFreshAuth {
  token: string;
  /** Epoch seconds at which the token expires. */
  expires_at: number;
  mechanism: FreshAuthMechanism;
}

/**
 * Mint a fresh-auth token for `username` with the given mechanism, bound to
 * the per-op target (action + root_author + root_permlink). The caller
 * (route handler) is responsible for verifying the user actually proved
 * control via that mechanism BEFORE calling this function. The caller is
 * also responsible for sourcing the target from the actual op the user
 * intends to authorize — see the SPA wire-shape note in the `[TODO UI]`
 * paragraph of the round-5 signal block in
 * `agents/docs/tasks/pending/backend-coauthor-trust-model.md`.
 *
 * Round-5 hold #3: the proof is bound to the consent op via a SHA-256 of
 * the target triple. Without this bind the proof was 1-fold-amplifiable: a
 * compromised SPA could authenticate the user for `author_accept` on
 * paper X then use the proof to broadcast `author_resign` on paper Y under
 * the same TTL.
 *
 * Storage path: Redis preferred; falls back to the module-local map on
 * unavailable Redis or write failure. Both paths are TTL-bounded.
 */
export async function issueFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
  target: FreshAuthTarget,
): Promise<IssuedFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const targetHash = computeFreshAuthTargetHash(target);
  const entry: StoredEntry = {
    username,
    mechanism,
    issued_at: issuedAt,
    kind: 'consent_op',
    target_hash: targetHash,
  };
  const expiresAt = Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS;
  const memExpiresAtMs = issuedAt + FRESH_AUTH_TTL_SECONDS * 1000;

  // Round-4 hold #3: write to memStore as a backup whenever Redis-issuance
  // succeeds. The pre-fix path stored the token only in Redis on the happy
  // path; if Redis flapped between issue and consume, the consume side
  // fell through to memStore.get(token) → empty → spurious 'expired' 401
  // (the user just authenticated). With the backup write, a Redis-down
  // consume can recover the entry from memStore. Single-use semantics are
  // preserved: a successful Redis GETDEL deletes the canonical entry; the
  // mem-store fallback path also calls memStore.delete() so the entry is
  // consumed exactly once across the storage tiers.
  memStore.set(token, { entry, expiresAt: memExpiresAtMs });

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
      // memStore was already populated above — the token survives the
      // Redis-write failure.
      return { token, expires_at: expiresAt, mechanism };
    }
  }

  return { token, expires_at: expiresAt, mechanism };
}

/**
 * Mint a session-kind fresh-auth token (no per-op target binding) for
 * `username` with the given mechanism. Mirrors the storage primitives of
 * `issueFreshAuthToken` but produces a `kind: 'session'` entry consumed by
 * `consumeSessionFreshAuthToken` on the non-consent `/api/custody/broadcast`
 * path.
 *
 * Rationale: non-consent ops (vote, comment, non-consent custom_json) do
 * not have the action/paper substitution-attack surface that motivated
 * round-5 hold #3's target binding. Forcing State C users (ORCID-only,
 * passwordless) to fabricate a target triple to mint an ORCID proof would
 * be UX friction without security benefit. Session-kind proofs encode "the
 * user re-authed via this mechanism in the last 5 minutes" — enough to
 * close the JWT-only-takeover gap on the non-consent path per ARCH.md
 * § 6.5 invariant #1.
 *
 * The caller (route handler) is responsible for verifying the user
 * actually proved control via that mechanism BEFORE calling this function,
 * same contract as `issueFreshAuthToken`. Single-use semantics, TTL, and
 * Redis-fallback shape are identical.
 */
export async function issueSessionFreshAuthToken(
  username: string,
  mechanism: FreshAuthMechanism,
): Promise<IssuedFreshAuth> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const issuedAt = Date.now();
  const entry: StoredEntry = {
    username,
    mechanism,
    issued_at: issuedAt,
    kind: 'session',
  };
  const expiresAt = Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS;
  const memExpiresAtMs = issuedAt + FRESH_AUTH_TTL_SECONDS * 1000;

  memStore.set(token, { entry, expiresAt: memExpiresAtMs });

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
        'Falling back to in-memory store for session fresh-auth token',
      );
      return { token, expires_at: expiresAt, mechanism };
    }
  }

  return { token, expires_at: expiresAt, mechanism };
}

type FreshAuthVerifyResult =
  | { valid: true; mechanism: FreshAuthMechanism }
  | {
      valid: false;
      reason:
        | 'missing'
        | 'expired'
        | 'username_mismatch'
        | 'target_mismatch'
        | 'malformed'
        | 'kind_mismatch';
    };

/**
 * Single-use consume of a fresh-auth token. Returns `{ valid: true,
 * mechanism }` exactly once per issued token; subsequent calls return
 * `{ valid: false, reason: 'expired' }` (already consumed by the GETDEL /
 * map.delete()).
 *
 * Round-5 hold #1: dual-tier deletion is now SYMMETRIC across both legs.
 * The Redis-success leg deletes the memStore backup (so a sibling consume
 * can't replay the token via the fallback path). The memStore-fallback
 * leg issues a best-effort `redis.del` of the canonical entry (so a
 * Redis flap mid-call that consumed the memStore copy doesn't leave the
 * canonical entry behind for a replay once Redis recovers within the
 * TTL window). The pre-fix asymmetric variant — only the Redis-success
 * leg cleared the other tier — admitted a same-process double-consume
 * under a Redis blip mid-`getdel` even though the docstring claimed
 * symmetry.
 *
 * Round-4 hold #3 carry-over: the Redis-flap fallback recovery path
 * (memStore backup written at issuance) makes the consume side resilient
 * to mid-call Redis failures without sacrificing single-use semantics.
 *
 * Round-5 hold #3: consume requires `expectedTargetHash` (computed by the
 * caller from the actual consent op being authorized). A token that was
 * minted for one (action, paper) target cannot authorize a different
 * target. Closed-default: a missing or non-hex `expectedTargetHash`
 * rejects with `target_mismatch` rather than skipping the check (the
 * caller MUST be on the new wire shape for the proof to be honored).
 *
 * The route layer rejects the broadcast on any non-valid outcome.
 */
export async function consumeFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
  expectedTargetHash: string,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  let raw: string | null = null;
  let consumedFromMemStore = false;

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

  if (raw) {
    // Redis GETDEL succeeded. Also drop the memStore backup so a sibling
    // consume can't replay the token via the fallback path.
    memStore.delete(token);
  } else {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token); // single-use even on the fallback path
      if (cached.expiresAt > Date.now()) {
        raw = JSON.stringify(cached.entry);
        consumedFromMemStore = true;
      }
    }
  }

  if (!raw) return { valid: false, reason: 'expired' };

  // Round-5 hold #1: when we consumed from the memStore fallback path
  // (Redis was unavailable or threw on getdel), issue a best-effort
  // `redis.del` of the canonical Redis entry. Without this, a transient
  // Redis flap mid-getdel that didn't actually delete the entry would
  // leave the canonical Redis copy alive — and a replay within the TTL
  // window once Redis recovered would hit Redis getdel and return valid
  // a second time (double-consume). The redis.del here is best-effort:
  // we already consumed the memStore copy, so the user's broadcast is
  // good to proceed regardless of whether this paired delete lands.
  // Logging on error correlates the recovery attempt with the flap.
  if (consumedFromMemStore && redis) {
    try {
      await redis.del(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_compensating_del_failed' },
        'Compensating Redis del after memStore-fallback consume failed; replay window remains until TTL',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Stored value parse failure — treat as malformed-but-consumed.
    return { valid: false, reason: 'malformed' };
  }

  // Round-4 hold #8 + round-5 hold #3: structural narrowing replaces the
  // prior unsafe `JSON.parse(raw) as StoredEntry`. Adding a new field to
  // StoredEntry requires extending this guard; a future refactor that
  // relaxes the schema is forced to update the consume path explicitly.
  // The `target_hash` field MUST be present and well-shaped — a stored
  // entry without it is a round-4-shape leak (e.g., a token written
  // before redeploy and consumed after) and is rejected as malformed.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== 'string' ||
    !isFreshAuthMechanism((parsed as { mechanism?: unknown }).mechanism)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  // Legacy entries (predating the `kind` discriminator) do not carry the
  // field — treat them as 'consent_op' so the target-bind check below still
  // fires (closed-default for the original security property). Explicit
  // mismatch on unknown kind shapes (a future variant not understood by
  // this version) → malformed.
  const rawKind = (parsed as { kind?: unknown }).kind;
  let kind: FreshAuthKind;
  if (rawKind === undefined) {
    kind = 'consent_op';
  } else if (isFreshAuthKind(rawKind)) {
    kind = rawKind;
  } else {
    return { valid: false, reason: 'malformed' };
  }

  // A consent-op entry MUST carry a well-shaped target_hash; absence is the
  // round-4-shape leak. A session-kind entry MUST NOT carry one (its
  // target field is forbidden at issuance); presence on a session entry is
  // malformed because someone wrote a kind/target combo this code never
  // mints.
  const rawTargetHash = (parsed as { target_hash?: unknown }).target_hash;
  if (kind === 'consent_op') {
    if (!isValidTargetHash(rawTargetHash)) {
      return { valid: false, reason: 'malformed' };
    }
  } else if (rawTargetHash !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  const entry: {
    username: string;
    mechanism: FreshAuthMechanism;
    kind: FreshAuthKind;
    target_hash?: string;
  } = {
    username: (parsed as { username: string }).username,
    mechanism: (parsed as { mechanism: FreshAuthMechanism }).mechanism,
    kind,
    target_hash: kind === 'consent_op' ? (rawTargetHash as string) : undefined,
  };

  if (entry.username !== expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  // Consent-op consume requires a consent_op-kind entry. A session-kind
  // entry consumed here is a kind mismatch — the caller (consent-op
  // broadcast) expects the per-op binding the session proof does not
  // carry. This is the strict-isolation direction of the consume contract:
  // session proofs do NOT authorize consent ops, only the looser non-
  // consent broadcast surface. (The reverse — consent_op proof on a
  // session-consume call — IS accepted via `consumeSessionFreshAuthToken`
  // because non-consent ops don't need binding; a per-op proof for the
  // same user is strictly more proof, not less.)
  if (entry.kind !== 'consent_op') {
    return { valid: false, reason: 'kind_mismatch' };
  }

  // Round-5 hold #3: closed-default — caller MUST supply a well-formed
  // expected hash. An empty / malformed argument rejects rather than
  // bypasses the bind so legacy callers can't accidentally re-enable the
  // 1-fold substitution attack.
  if (!isValidTargetHash(expectedTargetHash)) {
    return { valid: false, reason: 'target_mismatch' };
  }
  if (entry.target_hash !== expectedTargetHash) {
    return { valid: false, reason: 'target_mismatch' };
  }

  return { valid: true, mechanism: entry.mechanism };
}

/**
 * Session-kind consume: single-use consume of a fresh-auth token for the
 * non-consent `/api/custody/broadcast` path. Accepts EITHER:
 *
 *   - a `kind: 'session'` entry (target-less, minted by
 *     `issueSessionFreshAuthToken`), OR
 *   - a `kind: 'consent_op'` entry (target-bound, minted by
 *     `issueFreshAuthToken`).
 *
 * The cross-kind accept is intentional: a consent-op proof is strictly
 * MORE proof than a session proof for the same user (binds the target +
 * proves recent re-auth). Non-consent ops don't need the per-op binding,
 * so the binding is just informational here. Reusing a single proof for
 * both surfaces during the same session is good UX and does not weaken the
 * security model — the consent-op consume side still enforces the binding
 * on the consent-op surface itself.
 *
 * The strict direction — session proof on a consent-op surface — is NOT
 * accepted (see `consumeFreshAuthToken`'s `kind_mismatch` branch above).
 *
 * Storage + single-use + Redis-flap-recovery semantics mirror
 * `consumeFreshAuthToken` exactly; the only behavioral difference is the
 * absence of target-hash verification.
 */
export async function consumeSessionFreshAuthToken(
  token: string | undefined,
  expectedUsername: string,
): Promise<FreshAuthVerifyResult> {
  if (!token || typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'missing' };
  }

  let raw: string | null = null;
  let consumedFromMemStore = false;

  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    try {
      raw = await redis.getdel(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_getdel_failed' },
        'Falling back to in-memory lookup for session fresh-auth verify',
      );
    }
  }

  if (raw) {
    memStore.delete(token);
  } else {
    const cached = memStore.get(token);
    if (cached) {
      memStore.delete(token);
      if (cached.expiresAt > Date.now()) {
        raw = JSON.stringify(cached.entry);
        consumedFromMemStore = true;
      }
    }
  }

  if (!raw) return { valid: false, reason: 'expired' };

  if (consumedFromMemStore && redis) {
    try {
      await redis.del(KEY_PREFIX + token);
    } catch (err) {
      logger.warn(
        { err, event: 'fresh_auth.redis_compensating_del_failed' },
        'Compensating Redis del after memStore-fallback session consume failed; replay window remains until TTL',
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { username?: unknown }).username !== 'string' ||
    !isFreshAuthMechanism((parsed as { mechanism?: unknown }).mechanism)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  const rawKind = (parsed as { kind?: unknown }).kind;
  let kind: FreshAuthKind;
  if (rawKind === undefined) {
    kind = 'consent_op';
  } else if (isFreshAuthKind(rawKind)) {
    kind = rawKind;
  } else {
    return { valid: false, reason: 'malformed' };
  }

  // Schema consistency: same kind/target-hash invariants as the consent-op
  // consume. A consent-op entry must have a target_hash; a session entry
  // must not.
  const rawTargetHash = (parsed as { target_hash?: unknown }).target_hash;
  if (kind === 'consent_op') {
    if (!isValidTargetHash(rawTargetHash)) {
      return { valid: false, reason: 'malformed' };
    }
  } else if (rawTargetHash !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  const entry = {
    username: (parsed as { username: string }).username,
    mechanism: (parsed as { mechanism: FreshAuthMechanism }).mechanism,
    kind,
  };

  if (entry.username !== expectedUsername) {
    return { valid: false, reason: 'username_mismatch' };
  }

  // Session consume accepts both kinds (see docstring) — no kind check.
  return { valid: true, mechanism: entry.mechanism };
}

/** Test-only hook: clears the in-memory fallback store. Not exposed to
 *  route handlers. */
export function _resetFreshAuthMemStoreForTests(): void {
  memStore.clear();
}

/** Round-4 hold #15: test-only hooks to pause / restart the module-level
 *  cleanup interval. Without these, fake-timer tests that need to advance
 *  past the TTL boundary race the cleaner and observe non-deterministic
 *  results (the cleaner fires under fake timers and pre-deletes the entry
 *  the test was about to assert on). Pair with `_resetFreshAuthMemStoreForTests`
 *  in `beforeEach` so suites have full control over the in-memory state. */
export function _stopCleanupForTests(): void {
  if (cleanupInterval !== null) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function _restartCleanupForTests(): void {
  startCleanup();
}
