/**
 * Library-level unit tests for `lib/fresh-auth.ts`.
 *
 * Round-4 hold of `backend-coauthor-trust-model`:
 *  - Item 17: TTL-expiry path in the in-memory fallback store. Round 3
 *    shipped the guard at line 190 (`cached.expiresAt > Date.now()`) but
 *    no test exercised it; mutating the guard out would not be caught.
 *    A fake-timer test advances `Date.now()` past the TTL and asserts
 *    `consume` returns `'expired'`.
 *  - Item 3: Redis-issuance success + memStore backup write. Round 3's
 *    issuance path stored the token only in Redis on the happy path; if
 *    Redis flapped between issue and consume, the consume side fell
 *    through to memStore.get(token) → empty → spurious 'expired'. The
 *    round-4 fix writes to memStore as a backup whenever Redis-issuance
 *    succeeds. Test pins the recovery semantic by simulating a
 *    Redis.getdel throw on consume after a Redis-issuance success.
 *
 * Carve-out per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - The `redis` module is partial-mocked via `vi.spyOn(getRedis())` to
 *    exercise the Redis-up-on-issue / Redis-down-on-consume race window.
 *    Inducing this race against real Redis would require coordinated
 *    fault injection mid-call (the local dev Redis is reliable; transient
 *    drops mid-call require network-level mocks). The risk class —
 *    "fresh-auth token recovery on Redis flap" — is exercised by the
 *    spy. A real-path companion exercises the no-Redis path end-to-end
 *    via the standard custody-consent-ops broadcast tests where
 *    `_resetFreshAuthMemStoreForTests` is the mode of operation.
 *  - `verifyHiveSignature` is NOT mocked anywhere in this suite (the
 *    library functions don't reach middleware).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONSENT_OP_ACTIONS,
  FRESH_AUTH_TTL_SECONDS,
  consumeFreshAuthToken,
  isFreshAuthMechanism,
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
  _restartCleanupForTests,
  _stopCleanupForTests,
} from '../../src/lib/fresh-auth.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';

beforeEach(() => {
  // Pause the cleanup interval so fake-timer tests don't race the cleaner;
  // each test gets a clean memStore.
  _stopCleanupForTests();
  _resetFreshAuthMemStoreForTests();
});

afterEach(() => {
  // Restart cleanup so module state is consistent for any sibling suite
  // running after this file.
  _restartCleanupForTests();
  vi.useRealTimers();
});

describe('CONSENT_OP_ACTIONS — wire predicate', () => {
  it('contains author_accept and author_resign', () => {
    expect(CONSENT_OP_ACTIONS.has('author_accept')).toBe(true);
    expect(CONSENT_OP_ACTIONS.has('author_resign')).toBe(true);
  });
  it('does NOT contain unrelated actions', () => {
    expect(CONSENT_OP_ACTIONS.has('vote')).toBe(false);
    expect(CONSENT_OP_ACTIONS.has('claim_authorship')).toBe(false);
    expect(CONSENT_OP_ACTIONS.has('approve_authorship')).toBe(false);
  });
});

describe('isFreshAuthMechanism — type guard (round-4 hold #8)', () => {
  it('admits the two declared mechanisms', () => {
    expect(isFreshAuthMechanism('password')).toBe(true);
    expect(isFreshAuthMechanism('orcid')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isFreshAuthMechanism(undefined)).toBe(false);
    expect(isFreshAuthMechanism(null)).toBe(false);
    expect(isFreshAuthMechanism('')).toBe(false);
    expect(isFreshAuthMechanism('PASSWORD')).toBe(false);
    expect(isFreshAuthMechanism('webauthn')).toBe(false);
    expect(isFreshAuthMechanism(42)).toBe(false);
  });
});

describe('TTL-expiry on in-memory fallback (round-4 hold #17)', () => {
  // The TTL-guard test scenario only fires on the in-memory fallback
  // path. When Redis is available, Redis's own server-side EX TTL is
  // authoritative and the in-memory `cached.expiresAt > Date.now()`
  // guard is bypassed. Round-4 hold #17's mutation-kill is specifically
  // about the in-memory guard at consume time, so these tests force the
  // Redis-down-on-consume path via a spy: issuance writes the memStore
  // backup; consume sees Redis unavailable and falls through to memStore
  // where the TTL guard fires.

  it('returns valid before the TTL boundary on the memStore fallback', async () => {
    // Force fake timers BEFORE issuance so the memStore-backup expiresAt
    // is computed against the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);

    const issued = await issueFreshAuthToken('alice', 'password');

    // Force Redis-down on consume so the path exercises the in-memory
    // TTL guard (the round-4 fix writes a memStore backup at issuance,
    // so the entry is recoverable from memStore).
    const redis = getRedis();
    const spy = redis && isRedisAvailable()
      ? vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced flap for TTL test'))
      : null;
    try {
      // Advance just before the TTL boundary (issuance time + TTL - 1s).
      // Token still valid via memStore fallback.
      vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS - 1) * 1000);
      const within = await consumeFreshAuthToken(issued.token, 'alice');
      expect(within.valid).toBe(true);
    } finally {
      spy?.mockRestore();
    }
  });

  it('memStore TTL guard is the only thing distinguishing expired from valid (mutation kill)', async () => {
    // Pin the guard's behaviour: at exactly TTL+1 second, the entry is
    // present in memStore but `expiresAt > Date.now()` returns false.
    // A mutant that removed the guard would return the entry as valid,
    // so this test fails on that mutation. Forces Redis-down-on-consume
    // to exercise the in-memory branch.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const issued = await issueFreshAuthToken('bob', 'orcid');

    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      const spy = vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced flap for TTL test'));
      try {
        vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
        const result = await consumeFreshAuthToken(issued.token, 'bob');
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe('expired');
        }
      } finally {
        spy.mockRestore();
      }
    } else {
      vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
      const result = await consumeFreshAuthToken(issued.token, 'bob');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
      }
    }
  });
});

describe('Redis-flap recovery via memStore backup (round-4 hold #3)', () => {
  it('Redis-issuance success + Redis.getdel throws on consume → memStore backup recovers the token', async () => {
    // Under fake Redis-flap shape: issue against a healthy Redis, then
    // make `redis.getdel` throw on consume. The pre-fix path returned
    // `'expired'`; the round-4 fix writes a backup to memStore on
    // issuance success and recovers via the fallback.
    const redis = getRedis();
    if (!redis || !isRedisAvailable()) {
      // Without Redis the pre-fix bug doesn't apply (issuance always
      // wrote to memStore); skip rather than declare a false pass.
      return;
    }

    const issued = await issueFreshAuthToken('carol', 'password');
    // Force the consume-side getdel to throw. Single-call mock: the
    // consume falls through to memStore (which has the backup written
    // at issuance) and recovers.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap'));
    try {
      const result = await consumeFreshAuthToken(issued.token, 'carol');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mechanism).toBe('password');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });

  it('Redis-issuance success + healthy Redis.getdel on consume → memStore backup is also deleted (no replay window)', async () => {
    // Mutation-kill: a regression that wrote the memStore backup at
    // issuance but did NOT clear it on a successful Redis GETDEL would
    // admit a replay attack via the fallback path. Pin the symmetric
    // delete: after a successful Redis consume, a follow-up consume
    // (now Redis-down) MUST not find the entry in memStore.
    const redis = getRedis();
    if (!redis || !isRedisAvailable()) return;

    const issued = await issueFreshAuthToken('dave', 'orcid');
    const first = await consumeFreshAuthToken(issued.token, 'dave');
    expect(first.valid).toBe(true);

    // Now simulate Redis flapping out and check that the memStore copy
    // is gone (the round-4 fix deletes the backup after a successful
    // Redis GETDEL).
    const getdelSpy = vi.spyOn(redis, 'getdel').mockResolvedValueOnce(null);
    try {
      const replay = await consumeFreshAuthToken(issued.token, 'dave');
      expect(replay.valid).toBe(false);
      if (!replay.valid) {
        expect(replay.reason).toBe('expired');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });
});
