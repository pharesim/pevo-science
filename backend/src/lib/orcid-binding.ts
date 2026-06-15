import crypto from 'node:crypto';
import { type Response } from 'express';
import { config } from '../config.js';
import { getRedis, isRedisAvailable } from '../redis.js';
import { getPool } from '../db.js';
import { T } from '../hafsql.js';
import { sendError } from '../response.js';
import { logger } from '../logger.js';
import { assertNever } from '../util/assertNever.js';
import {
  handleBroadcastErrorAmbiguous,
  type HandleBroadcastErrorAmbiguousOpts,
} from './broadcast-error.js';

// ─────────────────────────────────────────────────────────────
// ORCID binding lock + binding-check, shared by the two on-chain
// accreditation surfaces:
//   - routes/orcid.ts handleAccredit / handleLink (the /api/orcid/callback path)
//   - routes/signup-verify.ts broadcastAccreditationAndSeed (the /api/auth/confirm
//     and /api/auth/link finalize path)
// Both bind an ORCID to an account via an admin-signed `accredit` custom_json;
// this module is the single place that enforces the "one ORCID === one account"
// invariant on the chain layer (durable-binding check) and serializes concurrent
// binds for the same ORCID (the SETNX lock + HAF-indexing-lag cache).
// ─────────────────────────────────────────────────────────────

// Upper-bound HAF indexing-lag window. Source of truth for two adjacent
// concerns that share the same operational bound:
//
//   1. Lock-TTL extension on `BroadcastTimeoutError` inside the lock-acquired
//      branch of withOrcidBindingLock (the lock-TTL-extension remediation from
//      the chain-write-timeout-ambiguous-outcome convention doc) — the lock TTL
//      is extended to this value so a
//      concurrent bind for the same orcid_id cannot acquire a fresh lock
//      during the window in which our broadcast may still be on-chain
//      unindexed. Used only on the timer-fire path; non-timeout throws
//      release immediately as before.
//
//   2. Binding-cache TTL (`ORCID_BINDING_CACHE_KEY` writes via
//      `cacheOrcidBinding`) — covers the same HAF-indexing-lag window after
//      a successful accredit/link broadcast, during which
//      `findAccreditedAccountWithOrcid` would otherwise not see the fresh
//      binding and two concurrent binds could slip through.
//
// Previously declared as `ORCID_BINDING_CACHE_TTL = 120`
// AND `HAF_INDEXING_LAG_CEILING_SECONDS = 120` separately — future tuning
// (e.g. observed lag spikes prompting a 180s ceiling) would have required
// changing both. Single named constant, two consumers reference it.
//
// Derivation chain (per
// `agents/docs/solutions/conventions/verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`):
//   * Source of `120`: empirical upper bound on HAF block-watcher catch-up
//     after a Hive broadcast lands. Hive blocks are 3s; HAF's catch-up plus
//     PG-side index settle observed at <30s in the steady state, with rare
//     spikes during chain reorgs or HAF restarts. 120s is a 4x margin chosen
//     to absorb worst-case observed spikes without unbounded wait.
//   * Why aliasing is correct (not coincidence): both consumers ARE
//     load-bearing on the SAME bound — "during the HAF-indexing window after
//     a successful broadcast, no concurrent bind for the same orcid_id may
//     slip through". Consumer (1) enforces the bound at the lock layer
//     (block fresh acquisitions); consumer (2) enforces it at the read layer
//     (return the just-written binding from cache before HAF sees it). They
//     cover the same window from two angles, so a single value is correct
//     by construction. A divergence (e.g. cache TTL set lower than lock TTL)
//     would re-introduce the duplicate-bind race the lock-TTL extension closes.
//   * What would force re-evaluation: (a) observed HAF-lag p99 exceeding the
//     ceiling (split this constant if cache and lock have different operating
//     bounds — currently they don't); (b) a new consumer with a genuinely
//     different bound (do NOT alias to this constant; declare a new one);
//     (c) a Hive protocol change altering block cadence (the 3s × ~40-block
//     buffer would no longer hold).
//
// See `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`
// for the lock-TTL-extend-on-timeout remediation this constant backs.
export const HAF_INDEXING_LAG_CEILING_SECONDS = 120;
// Alias: the binding-cache TTL tracks the lag ceiling exactly. Kept as a
// named alias so call sites read with semantic intent (`ORCID_BINDING_CACHE_TTL`
// at the cache write site is more readable than the generic ceiling name).
// See the derivation chain above for why aliasing is correct rather than
// coincidence.
const ORCID_BINDING_CACHE_TTL = HAF_INDEXING_LAG_CEILING_SECONDS;
// SETNX lock TTL sits above the 30s wall-clock bound enforced on the admin
// broadcast (broadcastAdminCustomJson delegates to broadcastJsonWithTimeout;
// see backend/src/hive.ts) so a legitimately slow
// broadcast does not lose its lock mid-flight. dhive itself does not enforce
// a per-request broadcast timeout — our helper does. The nonce-owned Lua-CAS
// release (see releaseBindingLock) closes the lock-stomp window even if the
// TTL is exceeded, but keeping the TTL above the helper-enforced bound avoids
// the failure mode entirely for honest traffic.
const ORCID_BINDING_LOCK_TTL_SECONDS = 35;

// Redlock CAS release: only DEL the lock key when its value matches the nonce
// the caller acquired with. Prevents lock-stomp when holder A stalls past the
// TTL, the lock auto-expires, holder B acquires the same key, and A's finally
// runs. Without the CAS, A's stalled-then-finally DEL would delete B's lock
// and the double-broadcast this lock exists to prevent becomes possible again.
//
// Encoding contract: the Lua string-equality `KEYS[1] == ARGV[1]` is a byte-
// exact compare. The acquire path MUST keep the nonce as a printable-ASCII
// string (current: 32-char lowercase hex from crypto.randomBytes(16).toString
// ('hex')). A future refactor introducing raw buffers, base64 padding chars,
// or any non-ASCII encoding can silently break the CAS: nonces would never
// match, every release would no-op, and locks would always wait the full TTL
// instead of releasing promptly. The runtime invariant in acquireBindingLock
// enforces this at the source so a drift surfaces as a throw at acquire-time,
// not as a silent latency regression.
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

// Enforced at acquire-time so the Lua byte-equality contract above cannot
// drift silently. Matches the shape of crypto.randomBytes(16).toString('hex').
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;

// ─────────────────────────────────────────────────────────────
// Redis key builders
// ─────────────────────────────────────────────────────────────

function orcidBindingCacheKey(orcidId: string): string {
  return `${config.appTag}:orcid_binding:${orcidId}`;
}

function orcidBindingLockKey(orcidId: string): string {
  return `${config.appTag}:orcid_binding_lock:${orcidId}`;
}

// Discriminator returned by acquireBindingLock. The 'acquired' variant
// carries the per-acquisition nonce that releaseBindingLock compares against
// under the Redlock CAS contract.
type BindingLockState =
  | { state: 'acquired'; nonce: string }
  | { state: 'held' }
  | { state: 'unavailable' };

// SETNX-lock acquisition keyed on orcid_id. Closes the same-event-loop-tick
// TOCTOU race that the orcid_binding cache alone cannot: the cache is written
// only AFTER broadcast returns, so two concurrent bind requests for the same
// orcid_id (different usernames) can both pass the empty-binding check, both
// broadcast, and both write their own cache entries. The lock is claimed
// BEFORE broadcast; the loser gets 409. EX=35s bounds the hold — above the
// 30s wall-clock timeout enforced on the admin broadcast
// (broadcastAdminCustomJson delegates to broadcastJsonWithTimeout; see
// hive.ts) so a legitimately slow broadcast does not lose its lock mid-flight.
//
// Lock value is a per-acquisition random nonce (NOT the username) so the
// nonce-owned Lua-CAS release in releaseBindingLock distinguishes holders.
// Usernames alone cannot: the same user racing two tabs shares a username but
// needs distinct ownership identities for the TTL-expired-then-stomp scenario.
//
// Returns a discriminated union:
//   { state: 'acquired', nonce } — caller holds the lock; must call
//                                  releaseBindingLock(orcidId, nonce) later.
//   { state: 'held' }            — another request holds the lock; caller
//                                  must surface 409.
//   { state: 'unavailable' }     — Redis down or threw; caller degrades to
//                                  the cache-less HAF-only path (accept the
//                                  narrow race in degraded mode rather than
//                                  failing closed). An error has been logged
//                                  on both causes (Redis outage OR nonce-
//                                  shape invariant drift); pino JSON carries
//                                  an `event` discriminator ('redis_outage'
//                                  vs 'nonce_drift') so text-matching alert
//                                  pipelines can tell the two apart.
async function acquireBindingLock(orcidId: string): Promise<BindingLockState> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return { state: 'unavailable' };
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    // Runtime invariant: RELEASE_LOCK_LUA compares the stored value byte-for-
    // byte under Lua string equality. If a future refactor changes the nonce
    // encoding away from printable-ASCII hex, the CAS would silently never
    // match. Surface the drift as a `'unavailable'` state (matching the Redis-
    // outage degradation semantics) rather than a thrown error: throwing out
    // here would propagate to the /callback outer catch as 500 INTERNAL_ERROR,
    // but the state token was already consumed before dispatch, so the user
    // would be hard-blocked and forced to restart the ORCID OAuth flow. The
    // error-tier log preserves operator visibility so the drift is discovered
    // without burning the user's session. (The typeof-string check is omitted
    // because crypto.randomBytes(16).toString('hex') always returns a string;
    // only the hex-shape assertion is load-bearing.)
    if (!LOCK_NONCE_RE.test(nonce)) {
      logger.error(
        {
          event: 'orcid.binding_lock.nonce_drift',
          route: 'orcid.binding-lock',
          orcidId,
        },
        'orcid binding lock nonce shape invariant violated — code defect, degrading to HAF-only path',
      );
      return { state: 'unavailable' };
    }
    const result = await redis.set(
      orcidBindingLockKey(orcidId),
      nonce,
      'EX',
      ORCID_BINDING_LOCK_TTL_SECONDS,
      'NX',
    );
    if (result === 'OK') return { state: 'acquired', nonce };
    return { state: 'held' };
  } catch (err) {
    // Redis outage during lock acquisition silently degrades every binding
    // attempt to the full TOCTOU window; that's a paging-tier event, not a
    // warn-tier one. Behavior unchanged (still returns 'unavailable' so the
    // handler falls back to the HAF-only path). The `event: 'redis_outage'`
    // structured field discriminates this cause from `event: 'nonce_drift'`
    // above so alert pipelines keyed on message text can tell the two apart.
    logger.error(
      {
        event: 'orcid.binding_lock.redis_outage',
        route: 'orcid.binding-lock',
        orcidId,
        err,
      },
      'orcid binding lock acquisition failed — redis outage, degrading to HAF-only path',
    );
    return { state: 'unavailable' };
  }
}

// Release via Lua CAS: only DEL when the current value equals our nonce.
// See RELEASE_LOCK_LUA comment for why the CAS matters (lock-stomp window).
export async function releaseBindingLock(orcidId: string, nonce: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, orcidBindingLockKey(orcidId), nonce);
  } catch (err) {
    // Best-effort release. On failure the lock self-expires after the TTL.
    logger.warn(
      {
        event: 'orcid.binding_lock.release_failed',
        route: 'orcid.binding-lock',
        orcidId,
        err,
      },
      'Failed to release ORCID binding lock',
    );
  }
}

/**
 * Lock-TTL extension on `BroadcastTimeoutError`. Extends the
 * binding-lock TTL to {@link HAF_INDEXING_LAG_CEILING_SECONDS} so a concurrent
 * bind for the same `orcid_id` cannot acquire a fresh lock during the window
 * in which our broadcast may still be on-chain unindexed. The four failure
 * modes fold together here so each emits the structured log operators need:
 *
 *   - **Redis absent** — `getRedis()` returns null or
 *     `isRedisAvailable()` is false. Silent no-op was the prior shape; now
 *     emits `error` so a degraded-during-timeout event is recoverable from
 *     logs. The `expireErr` catch below cannot fire on the absent-Redis path.
 *
 *   - **`expire` returns 0** — lock key was already gone (TTL
 *     expiry, eviction, FLUSHDB, AOF stall between acquire and the catch).
 *     `redis.expire` on a missing key resolves to 0, no exception. Without
 *     this branch the wrapper would skipRelease anyway and the duplicate-bind
 *     protection would be silently violated. We emit `error` and let the wrapper
 *     skipRelease (the `return { skipRelease: true }` is now a no-op — no
 *     lock to skip releasing — but is structurally still correct).
 *
 *   - **`expire` returns 1** — extension landed. Emits `warn`
 *     (not `info`) because the event is operationally abnormal (a real
 *     broadcast timeout is alert-worthy) and dashboards should surface it.
 *
 *   - **`expire` throws** (Redis-flap mid-call) — same shape as the prior
 *     inline catch; a unit test pins this branch.
 *
 * The function returns void; the caller still issues
 * `return { skipRelease: true }` to signal the wrapper. Decoupled because the
 * skipRelease semantics belong to the wrapper contract, not the lock-extend
 * helper. Collapses two duplicated catch blocks
 * (`handleAccredit` and `handleLink`) into one site so a future edit to the
 * extend-or-log shape only happens once.
 */
export async function extendBindingLockOnTimeoutOrLog(orcidId: string, routeLabel: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) {
    logger.error(
      {
        event: 'orcid.binding_lock.extend_redis_absent',
        route: 'orcid.binding-lock',
        routeLabel,
        orcidId,
      },
      `${routeLabel} lock-TTL extension skipped — Redis unavailable at BroadcastTimeoutError time, duplicate-bind window may be open`,
    );
    return;
  }
  try {
    // Probe
    // the lock's residual TTL immediately before the extend attempt so the
    // `binding_lock_extend_lock_missing` anchor can carry a `cause:` field
    // that operators can dashboard-filter. Three operational causes
    // collapsed to the same anchor before this probe (self-expire from
    // HAF-lag preamble, sibling DEL, Redis eviction) — `pttl` lets us
    // discriminate the first/third class (key already missing at probe time
    // → `'expired_or_evicted'`) from the rare race where a sibling deletes
    // the key between probe and expire (`'released_during_extend'`). Cases
    // 1 and 3 stay conflated with Redis primitives alone; the dashboard
    // distinguishes them via co-occurrence with eviction-counter / HAF-lag
    // anchors when those land. The probe is best-effort: if it throws, fall
    // through to the existing `binding_lock_extend_threw` anchor.
    const lockKey = orcidBindingLockKey(orcidId);
    const pttlBefore = await redis.pttl(lockKey);
    const extended = await redis.expire(lockKey, HAF_INDEXING_LAG_CEILING_SECONDS);
    if (extended === 0) {
      // Caller's subsequent `return { skipRelease: true }`
      // is decorative on this branch — the lock is already gone, so
      // releaseBindingLock's Lua CAS is a no-op against a missing key
      // either way. Preserved for structural parity with the success branch
      // (a 4-way per-branch skipRelease decision is the wrong abstraction;
      // the wrapper-skipRelease decision is "did the timer fire" and stays
      // true regardless of which sub-state the helper observed).
      const cause: 'expired_or_evicted' | 'released_during_extend' | 'unknown' =
        pttlBefore === -2
          ? 'expired_or_evicted'
          : pttlBefore > 0
            ? 'released_during_extend'
            : 'unknown';
      logger.error(
        {
          event: 'orcid.binding_lock.extend_lock_missing',
          route: 'orcid.binding-lock',
          routeLabel,
          orcidId,
          cause,
          pttlBefore,
        },
        `${routeLabel} binding lock expired between acquire and TTL-extend — duplicate-bind protection degraded for this request`,
      );
      return;
    }
    logger.warn(
      {
        event: 'orcid.binding_lock.extend_ok',
        route: 'orcid.binding-lock',
        routeLabel,
        orcidId,
        newTtl: HAF_INDEXING_LAG_CEILING_SECONDS,
      },
      `${routeLabel} binding lock TTL extended on BroadcastTimeoutError — duplicate-bind window held`,
    );
  } catch (expireErr) {
    // Best-effort: a Redis flap between acquire and expire is not worth
    // hard-failing the request closed (the user is already getting a 504
    // ambiguous-outcome envelope). Log at error level because the
    // duplicate-bind protection is degraded for this request — the lock
    // will fall back to its original ~35s TTL and a concurrent bind
    // arriving after that could slip the duplicate-bind race the lock-TTL
    // extension was designed to close.
    logger.error(
      {
        event: 'orcid.binding_lock.extend_threw',
        route: 'orcid.binding-lock',
        routeLabel,
        orcidId,
        err: expireErr,
      },
      `${routeLabel} orcid binding lock TTL extension failed — duplicate-bind protection degraded for this request`,
    );
  }
}

/**
 * Acquire → run → release wrapper for the ORCID binding lock. Encapsulates
 * the acquire/try/finally scaffolding that handleAccredit and handleLink
 * otherwise duplicate, and makes the nonce flow internal so callers can't
 * accidentally call releaseBindingLock with the wrong nonce.
 *
 * Behavior per lock state:
 *   'held'        — wrapper sends 409 ORCID_ALREADY_LINKED (terminal: no
 *                   `retriable` flag, no `Retry-After` header — the OAuth
 *                   state token was consumed at /callback entry, so the
 *                   client must restart the ORCID flow); callback is NOT run.
 *                   Rationale: the OAuth state token is consumed before the
 *                   lock check, so the 409 is terminal rather than retriable.
 *   'acquired'    — callback runs inside try/catch/finally; release happens
 *                   under nonce CAS in finally on both success and caught
 *                   throw paths. The wrapper catches every throw escaping fn
 *                   and routes it through handleBroadcastErrorAmbiguous (504
 *                   ambiguous-outcome envelope) — symmetric with the
 *                   'unavailable' branch. Inside fn, callers may still catch
 *                   known throw classes earlier to surface a different
 *                   envelope (e.g. BroadcastTimeoutError → 504 with
 *                   timeout_ms + redis.expire side effect for the lock-TTL
 *                   extension; non-timeout broadcast errors on 'acquired' →
 *                   502 BROADCAST_FAILED; PostBroadcastWriteError → 502
 *                   POST_BROADCAST_FAILED with tx_id). Anything that escapes
 *                   fn lands on the wrapper's outer catch.
 *   'unavailable' — callback runs WITHOUT a lock (Redis-optional degrade to
 *                   cache-less HAF-only path); no release needed. On this path
 *                   the wrapper catches throws from fn and, using the required
 *                   `ambiguousOutcomeOpts`, emits the 504
 *                   BROADCAST_TIMEOUT ambiguous-outcome envelope via
 *                   handleBroadcastErrorAmbiguous. Rationale: with Redis down, there is
 *                   no lock-TTL margin or binding-cache to guarantee the
 *                   broadcast hasn't landed. Every throw in this branch is
 *                   outcome-ambiguous (the broadcast may be on-chain already);
 *                   surfacing 500 would license a user retry that duplicates
 *                   the custom_json. The `ambiguousOutcomeOpts` argument is
 *                   required (not optional) precisely so a future caller
 *                   cannot silently re-introduce the consumed-state-token
 *                   hard-block class by omitting the safety envelope. See
 *                   agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md.
 *
 * IMPORTANT — response-sending contract: on the 'held' state the wrapper sends
 * the 409 response itself. Callers MUST NOT send another response after the
 * await returns, regardless of lock state. Today both orcid.ts callers
 * (handleAccredit, handleLink) have no code after `await withOrcidBindingLock(...)`;
 * the signup-verify caller (broadcastAccreditationAndSeed) discriminates on
 * `res.headersSent` after the await (every non-success path has already sent a
 * response) and sends no further response itself. A future caller that appends
 * post-await `sendOk`/`sendError` logic risks a double-send / "Cannot set
 * headers after they are sent" crash. If post-await work that writes a response
 * is ever needed, move it INSIDE the `fn` callback, or refactor the wrapper to
 * return a discriminator instead of sending the 409 directly.
 */
export async function withOrcidBindingLock(
  res: Response,
  orcidId: string,
  // `fn` may signal `{ skipRelease: true }` to opt out of the wrapper's
  // CAS-release in finally — used by the BroadcastTimeoutError catch inside
  // handleAccredit/handleLink, which extends the lock TTL to
  // HAF_INDEXING_LAG_CEILING_SECONDS so a concurrent bind for the same
  // orcid_id cannot acquire a fresh lock while our broadcast may still be
  // on-chain unindexed. Throws from fn still flow through the
  // finally and release as before — only an explicit `{ skipRelease: true }`
  // return short-circuits the release. Returning void preserves the legacy
  // success-path release.
  // `fn` receives the resolved lock state ('acquired' | 'unavailable') so
  // it can discriminate envelope handling on the inner-catch path: on the
  // 'unavailable' branch, ANY throw is outcome-ambiguous (no lock-TTL
  // margin, no binding-cache to dedup against), so non-timeout broadcast
  // errors must be re-thrown to let this wrapper's outer catch emit the
  // ambiguous-outcome envelope. On the 'acquired'
  // branch, fn keeps its existing 502 BROADCAST_FAILED response for
  // non-timeout broadcast errors. ('held' is handled by the wrapper before
  // fn runs; fn never observes that state.)
  fn: (lockState: 'acquired' | 'unavailable') => Promise<void | { skipRelease: true }>,
  // REQUIRED at the type level: the unavailable-branch ambiguous-outcome
  // envelope is the only thing keeping a Redis-flap throw from propagating
  // to the outer /callback catch as 500 INTERNAL_ERROR (consumed-state-token
  // hard-block). Optional + missing arg silently re-introduces that class;
  // both current callers (handleAccredit, handleLink) pass opts, so requiring
  // it costs nothing and forecloses the silent regression. Future callers
  // that genuinely have no broadcast-write to recover (e.g. a read-only
  // probe) MUST justify the addition by extending this signature, not by
  // omitting the safety envelope. Takes the narrowed
  // ambiguous variant directly so the wrapper does not spread-and-override
  // `forceAmbiguousOutcome:true` into the helper opts (i.e. doesn't leak the
  // helper's internal flag name); calls handleBroadcastErrorAmbiguous, which
  // accepts only this narrowed shape.
  ambiguousOutcomeOpts: HandleBroadcastErrorAmbiguousOpts,
): Promise<void> {
  const lock = await acquireBindingLock(orcidId);
  if (lock.state === 'held') {
    // Same-tick lock contention: state token has already been consumed at the
    // /callback entry, so the wire shape here is terminal from the user's
    // perspective. Restart the ORCID flow rather than retry. Matches the
    // durable on-chain binding 409 envelope (no `retriable`, no `Retry-After`).
    // Rationale: the OAuth state token is consumed before this lock check, so
    // the 409 is terminal rather than retriable.
    //
    // Operator-alert anchor: structured `event:'lock_contention_held'` so
    // contention frequency is dashboard-keyable. Sibling lock-helper anchors
    // already follow this convention (`event:'binding_lock_extend_*'`, `event:'redis_outage'`,
    // `event:'nonce_drift'`); silent emission here would leave oncall without
    // a forensic trail when triaging 409s on /orcid/callback.
    logger.warn(
      {
        event: 'orcid.binding_lock.contention_held',
        route: 'orcid.binding-lock',
        routeLabel: ambiguousOutcomeOpts.routeLabel,
        orcidId,
      },
      `${ambiguousOutcomeOpts.routeLabel} ORCID binding lock contended; client must restart OAuth (state token consumed)`,
    );
    sendError(
      res,
      409,
      'ORCID_ALREADY_LINKED',
      'This ORCID is currently being linked by another request',
    );
    return;
  } else if (lock.state === 'acquired') {
    // skipRelease toggles to true ONLY when fn returns `{ skipRelease: true }`
    // explicitly (e.g. the BroadcastTimeoutError catch in handleAccredit /
    // handleLink, which extends the lock TTL to
    // HAF_INDEXING_LAG_CEILING_SECONDS and signals the wrapper not to delete
    // the extended lock). The `let` declared above the try is load-bearing:
    // `finally` cannot read `result` from `try` scope, and a throw from fn
    // must still release (otherwise a non-timeout throw would orphan the
    // lock for 35s — failure mode the original try/finally already
    // prevented). Throws skip the `if (result?.skipRelease)` line entirely,
    // leaving skipRelease=false, so finally releases as before.
    //
    // Symmetric ambiguous-outcome catch:
    // closes the same hard-block class on the 'acquired' branch that the
    // 'unavailable' branch already closes. Throw classes escape fn's inner try/catch even
    // on the lock-acquired branch and would otherwise consume the OAuth
    // state token + produce 500 INTERNAL_ERROR. The catch below routes them
    // through handleBroadcastErrorAmbiguous, which in turn discriminates
    // PostBroadcastWriteError (502 POST_BROADCAST_FAILED + tx_id +
    // failed_step + outcome:'confirmed') from everything else (504
    // BROADCAST_TIMEOUT + outcome:'uncertain' + verify_before_retry:true).
    //
    // Surviving throw classes after the PostBroadcastWriteError swap:
    //   1. Pre-broadcast SYNC throw — e.g. PrivateKey.fromString on a
    //      malformed admin key. Routed as 504 ambiguous-outcome.
    //      A startup-time admin-key validation check fails boot on a
    //      malformed key, so this class should not reach the catch in
    //      production.
    //   2. Post-broadcast cascade throw — fn wraps the cascade in a
    //      PostBroadcastWriteError before re-throwing, and handleBroadcastError
    //      checks the discrimination BEFORE the forceAmbiguousOutcome branch.
    //      Wire shape: 502 POST_BROADCAST_FAILED.
    //
    // Lock release semantics: throws release the lock (skipRelease stays
    // false); successful skipRelease (the BroadcastTimeoutError + lock-TTL
    // extend-helper path inside fn) still skips. Caught throws don't set
    // skipRelease so the finally releases — a subsequent retry can acquire
    // a fresh lock.
    let skipRelease = false;
    try {
      const result = await fn('acquired');
      if (result?.skipRelease) skipRelease = true;
    } catch (err) {
      handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
      // Do NOT set skipRelease — release the lock so a subsequent retry
      // (after the user verifies state at /settings) can acquire it.
    } finally {
      if (!skipRelease) {
        await releaseBindingLock(orcidId, lock.nonce);
      }
    }
  } else if (lock.state === 'unavailable') {
    // Redis outage or nonce-shape invariant drift: degrade to cache-less
    // HAF-only dedup. No lock to release. Wrap fn() so that a throw on this
    // branch is routed to the 504 ambiguous-outcome envelope rather than the
    // outer /callback catch's 500 INTERNAL_ERROR — the OAuth state token is
    // already consumed, so a 500 hard-blocks the user on a retry path that
    // may also duplicate-broadcast. handleBroadcastErrorAmbiguous (the
    // dedicated entry point) collapses
    // BroadcastTimeoutError AND any other throw into the same 504
    // BROADCAST_TIMEOUT shape (retriable:false, verify_before_retry:true,
    // outcome:'uncertain'). The discriminated-union opts type
    // (HandleBroadcastErrorAmbiguousOpts) requires `ambiguousMsg` so the
    // earlier `ambiguousMsg ?? failMsg` silent-regression class cannot
    // reappear. See convention doc
    // agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md.
    //
    // NB: lock-TTL extension is a NO-OP on this branch. There is no lock
    // to extend (acquireBindingLock returned 'unavailable'). The duplicate-
    // bind window in the degraded-Redis regime is a separate axis tracked
    // outside this function; the wrapper's outer catch below routes throws
    // through handleBroadcastErrorAmbiguous, which steers the user to
    // /settings rather than a fresh broadcast retry. A future fn that
    // returns `{ skipRelease: true }` on this branch is silently ignored —
    // there is nothing to skip releasing.
    try {
      await fn('unavailable');
    } catch (err) {
      // Dedicated ambiguous entry point — wrapper does
      // not know the helper's internal `forceAmbiguousOutcome` flag name. The
      // narrowed `HandleBroadcastErrorAmbiguousOpts` type guarantees
      // `ambiguousMsg` is set (the discriminated union closes the
      // earlier `ambiguousMsg ?? failMsg` silent-regression class).
      handleBroadcastErrorAmbiguous(res, err, ambiguousOutcomeOpts);
    }
  } else {
    // Exhaustiveness guard: adding a new BindingLockState variant without
    // handling it here becomes a compile error. Belt-and-suspenders alongside
    // the docblock "no double response" contract above — a future fourth
    // variant must be routed explicitly rather than silently falling through.
    // `assertNever` also enforces this at runtime: if a value with an unknown
    // discriminant ever reaches this branch (JSON.parse round-trip, unsafe
    // cast, test mock bypassing types), the throw surfaces as a 500 via the
    // outer /callback catch instead of a silent hang with no response sent.
    assertNever(lock);
  }
}

/**
 * Cache the ORCID → username binding for the HAF-indexing-lag window.
 * Best-effort: swallow Redis errors (availability over consistency; the HAF
 * path remains the source of truth once the chain op is indexed).
 */
export async function cacheOrcidBinding(orcidId: string, username: string): Promise<void> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return;
  try {
    await redis.set(orcidBindingCacheKey(orcidId), username, 'EX', ORCID_BINDING_CACHE_TTL);
  } catch (err) {
    // Keep the swallow (availability over consistency; HAF is authoritative)
    // but emit at error-level so persistent failures surface on the pager. A
    // sustained Redis cache-write outage silently degrades the 120s HAF-lag
    // TOCTOU protection: a concurrent bind arriving before HAF indexes the op
    // will see neither cache nor HAF and can slip past the 409 guard. warn
    // level typically isn't paged; error is the right tier for "mitigation is
    // degraded, investigate the Redis path." Behavior unchanged (still swallows
    // per availability-over-consistency contract).
    logger.error(
      {
        event: 'orcid.binding_cache.write_failed',
        route: 'orcid.binding-cache',
        orcidId,
        username,
        err,
      },
      'orcid binding cache write failed — HAF-lag TOCTOU window may be longer than expected',
    );
  }
}

/**
 * Look up the recent-binding cache for an ORCID.
 * Returns the cached username, or null when no entry exists or Redis is
 * unavailable. Caller falls back to HAF on null. On a transient Redis read
 * error the service degrades gracefully: HAF remains authoritative and the
 * 409 guard still fires once the op is indexed.
 */
async function getCachedOrcidBinding(orcidId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis || !isRedisAvailable()) return null;
  try {
    return await redis.get(orcidBindingCacheKey(orcidId));
  } catch (err) {
    logger.warn(
      {
        event: 'orcid.binding_cache.read_failed',
        route: 'orcid.binding-cache',
        orcidId,
        err,
      },
      'Failed to read ORCID binding cache',
    );
    return null;
  }
}

/**
 * Resolve the account an ORCID is currently accredited to, or null if unbound.
 *
 * Cache-first: check the recent-binding cache before HAF. Closes the
 * 3-30s HAF-indexing-lag TOCTOU window where two concurrent bind requests
 * for the same ORCID could both pass findAccreditedAccountWithOrcid() before
 * either had been indexed. The cache is written by handleAccredit / handleLink
 * (and the signup-verify finalize path) right after broadcast. On Redis outage
 * we fall through to the HAF path so the service stays available (Redis is
 * optional by design).
 *
 * Fails closed (throws) when HAF is unavailable: returning null would silently
 * bypass the 409 duplicate-bind guard in every caller and let the admin key
 * sign two accreditations for the same ORCID.
 */
export async function findAccreditedAccountWithOrcid(orcidId: string): Promise<string | null> {
  const cached = await getCachedOrcidBinding(orcidId);
  if (cached) return cached;

  const pool = getPool();
  // Fail closed when HAF is unavailable: returning null would silently bypass
  // the 409 duplicate-bind guard in the callers and let the admin
  // key sign two accreditations for the same ORCID. The outer try/catch in
  // /callback maps the throw to a 500; the signup-verify caller surfaces it
  // through the activation-lock onError path.
  if (!pool) throw new Error('HAF unavailable — cannot verify ORCID binding');

  // Latest authorized on-chain accredit op carrying this ORCID. Filter by
  // accreditationAuthorities so a self-broadcast custom_json can't poison the check.
  // `cj.id DESC` is the same-block deterministic tie-breaker (the monotonic HAF
  // op id) per the custom-json hive-primitive design-rules convention; without
  // it, two ops affecting this ORCID in the same 3s block resolve
  // non-deterministically.
  const recent = await pool.query<{ account: string | null }>(
    `SELECT cj.json::jsonb ->> 'account' AS account
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' = 'accredit'
       AND cj.json::jsonb ->> 'orcid' = $1
       AND cj.required_posting_auths ?| $3::text[]
     ORDER BY cj.block_num DESC, cj.id DESC
     LIMIT 1`,
    [orcidId, config.appTag, config.accreditationAuthorities],
  );
  if (recent.rows.length === 0) return null;
  const account = recent.rows[0].account;
  if (!account) return null;

  // Re-check the account's latest authorized action. The binding is live only
  // if that action is still an 'accredit' carrying THIS orcid; a subsequent
  // 'revoke' clears it, and a subsequent 'accredit' with a different orcid
  // means the account rebound to another identity (freeing this orcid).
  // `cj.id DESC` is the same-block deterministic tie-breaker (monotonic HAF op
  // id) per the custom-json hive-primitive design-rules convention, so a
  // same-block accredit/revoke for this account resolves to the later op.
  const status = await pool.query<{ action: string | null; orcid: string | null }>(
    `SELECT cj.json::jsonb ->> 'action' AS action,
            cj.json::jsonb ->> 'orcid' AS orcid
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $2
       AND cj.json::jsonb ->> 'action' IN ('accredit', 'revoke')
       AND cj.json::jsonb ->> 'account' = $1
       AND cj.required_posting_auths ?| $3::text[]
     ORDER BY cj.block_num DESC, cj.id DESC
     LIMIT 1`,
    [account, config.appTag, config.accreditationAuthorities],
  );
  if (status.rows.length === 0) return null;
  const latest = status.rows[0];
  if (latest.action !== 'accredit' || latest.orcid !== orcidId) return null;
  return account;
}
