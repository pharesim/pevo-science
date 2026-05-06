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
 * Round-5 hold of `backend-coauthor-trust-model`:
 *  - Item 1: memStore-fallback compensating Redis.del. The pre-fix dual-tier
 *    deletion was asymmetric: only the Redis-success leg deleted the
 *    memStore backup; the memStore-fallback leg did NOT issue a paired
 *    `redis.del` of the canonical entry, so a Redis flap mid-getdel that
 *    didn't actually delete the entry left the canonical Redis copy alive,
 *    admitting a same-process replay once Redis recovered within the TTL.
 *    Test pins the compensating del.
 *  - Item 3: per-op target binding. The round-4 proof bound only to
 *    `(token, username)`. A compromised SPA could swap action/paper between
 *    the user's auth ceremony and the consume side under the 5-min TTL.
 *    Round-5 binds the proof to a SHA-256 of `(action, root_author,
 *    root_permlink)`; tests pin (a) target X / target Y → mismatch,
 *    (b) target X / target X → valid, (c) consume without target →
 *    closed-default reject.
 *  - Item 8: replace silent `if (!redis) return;` early-bail with
 *    `it.skipIf(...)` so the absence of Redis is visibly reported by the
 *    runner instead of silently passing the assertion-free body.
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
  computeFreshAuthTargetHash,
  consumeFreshAuthToken,
  isFreshAuthMechanism,
  issueFreshAuthToken,
  _resetFreshAuthMemStoreForTests,
  _restartCleanupForTests,
  _stopCleanupForTests,
  type FreshAuthTarget,
} from '../../src/lib/fresh-auth.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';

// Fixture target reused across the suite. The (action, root_author,
// root_permlink) triple is what the proof binds to; tests that exercise
// non-binding paths reuse the same target on issue + consume so the bind
// check passes; tests that exercise binding violations vary one or more
// fields.
const T: FreshAuthTarget = {
  action: 'author_accept',
  root_author: 'alice',
  root_permlink: 'paper-1',
};
const TH = computeFreshAuthTargetHash(T);

// Round-5 hold #8: hoist the "Redis present?" check to module scope so
// it.skipIf can read it at registration time. A flat module-scoped check
// (rather than a per-test inline early-return) makes Redis absence
// visible in the runner output as a `skipped` count.
//
// Implementation note: `getRedis()` returns the redis instance before
// its `connect()` promise resolves; the global `setup.ts`'s beforeAll
// awaits `redis.ping()` but runs after this file's top-level evaluates.
// Same poll-for-ready pattern as `tests/support/redis-helpers.ts` —
// up to ~1s for status to become 'ready', then fall through. Without
// this, the it.skipIf read at registration time would always see the
// pre-ready state and skip on every CI run, which is the silent-skip
// pattern this item exists to remove.
const redisAvailable = await (async () => {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < 20 && r.status !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  return Boolean(r && isRedisAvailable());
})();

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

describe('computeFreshAuthTargetHash — content hash (round-5 hold #3)', () => {
  it('produces a 64-char lowercase hex digest', () => {
    const hash = computeFreshAuthTargetHash(T);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic for the same target', () => {
    expect(computeFreshAuthTargetHash(T)).toBe(computeFreshAuthTargetHash(T));
  });
  it('differs when action changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, action: 'author_accept' });
    const h2 = computeFreshAuthTargetHash({ ...T, action: 'author_resign' });
    expect(h1).not.toBe(h2);
  });
  it('differs when root_author changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, root_author: 'alice' });
    const h2 = computeFreshAuthTargetHash({ ...T, root_author: 'bob' });
    expect(h1).not.toBe(h2);
  });
  it('differs when root_permlink changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, root_permlink: 'p1' });
    const h2 = computeFreshAuthTargetHash({ ...T, root_permlink: 'p2' });
    expect(h1).not.toBe(h2);
  });
  it('domain-separates pipe-laden permlinks (defensive — Hive permlinks restrict |, but the encoder must not collide if the constraint relaxes)', () => {
    // `'a|b' + '|c'` and `'a' + '|b|c'` would collide under naive concat.
    // The pipe is structurally a domain separator; each field is concated
    // verbatim with literal '|' between, so a permlink containing '|' is
    // not isomorphic to a different (action, root_author, root_permlink)
    // shape.
    const h1 = computeFreshAuthTargetHash({
      action: 'author_accept',
      root_author: 'a|b',
      root_permlink: 'c',
    });
    const h2 = computeFreshAuthTargetHash({
      action: 'author_accept',
      root_author: 'a',
      root_permlink: 'b|c',
    });
    expect(h1).not.toBe(h2);
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

    const issued = await issueFreshAuthToken('alice', 'password', T);

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
      const within = await consumeFreshAuthToken(issued.token, 'alice', TH);
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

    const issued = await issueFreshAuthToken('bob', 'orcid', T);

    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      const spy = vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced flap for TTL test'));
      try {
        vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
        const result = await consumeFreshAuthToken(issued.token, 'bob', TH);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe('expired');
        }
      } finally {
        spy.mockRestore();
      }
    } else {
      vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
      const result = await consumeFreshAuthToken(issued.token, 'bob', TH);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
      }
    }
  });
});

describe('Redis-flap recovery via memStore backup (round-4 hold #3)', () => {
  // Round-5 hold #8: it.skipIf replaces the silent `if (!redis) return;`
  // bail-out so a Redis-less CI surface explicitly reports these as
  // skipped instead of silently passing an assertion-free body.
  it.skipIf(!redisAvailable)('Redis-issuance success + Redis.getdel throws on consume → memStore backup recovers the token', async () => {
    // Under fake Redis-flap shape: issue against a healthy Redis, then
    // make `redis.getdel` throw on consume. The pre-fix path returned
    // `'expired'`; the round-4 fix writes a backup to memStore on
    // issuance success and recovers via the fallback.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('carol', 'password', T);
    // Force the consume-side getdel to throw. Single-call mock: the
    // consume falls through to memStore (which has the backup written
    // at issuance) and recovers.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap'));
    try {
      const result = await consumeFreshAuthToken(issued.token, 'carol', TH);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mechanism).toBe('password');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('Redis-issuance success + healthy Redis.getdel on consume → memStore backup is also deleted (no replay window)', async () => {
    // Mutation-kill: a regression that wrote the memStore backup at
    // issuance but did NOT clear it on a successful Redis GETDEL would
    // admit a replay attack via the fallback path. Pin the symmetric
    // delete: after a successful Redis consume, a follow-up consume
    // (now Redis-down) MUST not find the entry in memStore.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('dave', 'orcid', T);
    const first = await consumeFreshAuthToken(issued.token, 'dave', TH);
    expect(first.valid).toBe(true);

    // Now simulate Redis flapping out and check that the memStore copy
    // is gone (the round-4 fix deletes the backup after a successful
    // Redis GETDEL).
    const getdelSpy = vi.spyOn(redis, 'getdel').mockResolvedValueOnce(null);
    try {
      const replay = await consumeFreshAuthToken(issued.token, 'dave', TH);
      expect(replay.valid).toBe(false);
      if (!replay.valid) {
        expect(replay.reason).toBe('expired');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });
});

describe('Symmetric dual-tier deletion (round-5 hold #1)', () => {
  // The pre-fix asymmetric variant deleted memStore on the Redis-success
  // leg but did not issue a compensating `redis.del` on the
  // memStore-fallback leg. A Redis blip mid-getdel that threw BEFORE
  // Redis actually deleted the entry left the canonical Redis copy alive
  // — the user's consume succeeded via memStore, but a same-process
  // replay within the TTL hit Redis getdel and returned valid AGAIN.
  // Round-5 fix: the memStore-fallback success path issues a best-effort
  // `redis.del` of the canonical entry to close the replay window.
  it.skipIf(!redisAvailable)('memStore-fallback success path issues a compensating redis.del so a subsequent Redis-recovered consume cannot replay', async () => {
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('eve', 'password', T);

    // Step 1: stub Redis to throw on the first getdel. This forces the
    // fallback to memStore on consume — which succeeds via the memStore
    // backup written at issuance.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap on getdel'));
    // We allow the compensating del to land — the test asserts replay
    // rejection by the canonical `redis.del`'s effect on the next consume.

    let firstResult;
    try {
      firstResult = await consumeFreshAuthToken(issued.token, 'eve', TH);
    } finally {
      getdelSpy.mockRestore();
    }
    expect(firstResult.valid).toBe(true);

    // Step 2: Redis is "recovered" (default behavior, no spy). A second
    // consume with the same token must return `expired` because:
    //   (a) memStore was deleted at the start of the fallback path (so
    //       the round-4 fallback path itself burns the memStore copy),
    //   (b) the round-5 compensating redis.del cleared the canonical
    //       Redis entry so the Redis branch returns nil → 'expired'.
    // A pre-fix variant (no compensating del) would have left the Redis
    // entry alive: this second consume's Redis.getdel would have
    // returned the entry → the round-5 narrowing would have parsed it →
    // returned `valid: true` → DOUBLE-CONSUME. The test fails on that
    // mutation.
    const replay = await consumeFreshAuthToken(issued.token, 'eve', TH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('memStore-fallback compensating del is best-effort (a throwing redis.del does not break the consume)', async () => {
    // The compensating `redis.del` runs inside a try/catch in
    // consumeFreshAuthToken: if Redis is still flaky on the del side,
    // the user's broadcast must still proceed (we already consumed the
    // memStore copy). Pin that the consume reports valid even when the
    // compensating del also throws.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('frank', 'password', T);

    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('flap on getdel'));
    const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('flap persists on del'));
    try {
      const result = await consumeFreshAuthToken(issued.token, 'frank', TH);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mechanism).toBe('password');
      }
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });
});

describe('Per-op target binding (round-5 hold #3)', () => {
  it('issue with target X, consume with target X (same hash) → valid', async () => {
    const issued = await issueFreshAuthToken('grace', 'password', T);
    const result = await consumeFreshAuthToken(issued.token, 'grace', TH);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('password');
    }
  });

  it('issue with target X, consume with a DIFFERENT target hash → target_mismatch', async () => {
    const issued = await issueFreshAuthToken('hank', 'password', T);
    const otherTarget: FreshAuthTarget = {
      action: 'author_resign',
      root_author: 'mallory',
      root_permlink: 'paper-2',
    };
    const otherHash = computeFreshAuthTargetHash(otherTarget);
    const result = await consumeFreshAuthToken(issued.token, 'hank', otherHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('1-fold substitution: issue for (author_accept, paper-1), consume for (author_resign, paper-1) → target_mismatch (action swap)', async () => {
    // Closes the 1-fold cross-action substitution attack: a compromised
    // SPA could authenticate the user mentally for `author_accept` then
    // submit `author_resign` under the same proof.
    const issued = await issueFreshAuthToken('iris', 'orcid', T);
    const swappedTarget: FreshAuthTarget = { ...T, action: 'author_resign' };
    const swappedHash = computeFreshAuthTargetHash(swappedTarget);
    const result = await consumeFreshAuthToken(issued.token, 'iris', swappedHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('1-fold substitution: issue for paper-1, consume for paper-2 → target_mismatch (paper swap)', async () => {
    // Closes the cross-paper substitution attack: same action, different
    // paper. Distinct test from the action-swap case to lock both axes
    // of the binding independently.
    const issued = await issueFreshAuthToken('jules', 'password', T);
    const swappedTarget: FreshAuthTarget = { ...T, root_permlink: 'paper-2' };
    const swappedHash = computeFreshAuthTargetHash(swappedTarget);
    const result = await consumeFreshAuthToken(issued.token, 'jules', swappedHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with empty-string expectedTargetHash → target_mismatch (legacy callers cannot bypass the bind)', async () => {
    // The hold block says: "consume without expected target (legacy
    // callers) → reject (closed-default policy)." A legacy caller that
    // somehow passes an empty string (or any non-hex value) MUST be
    // rejected rather than allowed to bypass the bind.
    const issued = await issueFreshAuthToken('kate', 'password', T);
    const result = await consumeFreshAuthToken(issued.token, 'kate', '');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with malformed (non-hex / wrong-length) expectedTargetHash → target_mismatch', async () => {
    const issued = await issueFreshAuthToken('luca', 'password', T);
    // Length-63 hex (one short) — fails the `^[0-9a-f]{64}$` shape.
    const malformed = 'a'.repeat(63);
    const result = await consumeFreshAuthToken(issued.token, 'luca', malformed);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with uppercase-hex expectedTargetHash → target_mismatch (the guard is strict-lowercase)', async () => {
    // The validator at `isValidTargetHash` is strict lowercase
    // (`/^[0-9a-f]{64}$/`). Uppercase hex from a future caller that
    // does not normalize is rejected — pins the strict-lowercase
    // contract so a future relaxation is intentional rather than
    // accidental.
    const issued = await issueFreshAuthToken('maya', 'password', T);
    const upper = TH.toUpperCase();
    const result = await consumeFreshAuthToken(issued.token, 'maya', upper);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });
});
