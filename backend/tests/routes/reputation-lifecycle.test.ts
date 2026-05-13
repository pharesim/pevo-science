/**
 * Accreditation lifecycle + batch idempotency tests.
 *
 * Covers the acceptance criteria from
 * backend-reputation-single-source-of-truth.md scope #7:
 *
 * 1. Fresh accreditation seeds the bonus immediately, without waiting for
 *    a cycle boundary. Exercises seedAccreditationBonus() directly because
 *    the broadcast itself can't be reproduced in test (no chain).
 * 2. Revocation drops the entry to 0 immediately. Exercises
 *    invalidateOnRevocation() directly for the same reason.
 * 3. computeReputationBatch is deterministic — re-running with identical
 *    inputs produces a byte-identical result map. Catches non-deterministic
 *    SQL (missing ORDER BY, unstable DISTINCT, FP reordering).
 *
 * Mock carve-out (per root CLAUDE.md "Running Tests" carve-out clauses
 * a/b/c): the `seedAccreditationBonus — permanent vs transient error
 * discrimination` describe block at the bottom of this file uses
 * `vi.spyOn(redis, 'set')`, `vi.spyOn(logger, 'warn')`, and
 * `vi.spyOn(redisModule, 'getRedis')` to drive the cascade fn into its
 * permanent / transient / null-Redis branches deterministically.
 *
 * (a) Real path that's impractical: the production triggers for the
 *     permanent branch (TypeError thrown by `provisionalScore` on a
 *     malformed `weights.accreditation_bonus`, SyntaxError on a corrupted
 *     upstream weights JSON document) require corrupting real HAF /
 *     real Redis state, which (i) bleeds across the suite's shared Redis
 *     fixture and (ii) couples a class-based discrimination test to a
 *     specific upstream data shape. Likewise the null-Redis branch can't
 *     be exercised against the real fixture without tearing down the
 *     shared connection mid-suite.
 * (b) Why these mocks are justified: the discrimination is class-based
 *     (`isPermanentSeedError` matches `TypeError | SyntaxError |
 *     RangeError`), so any error of the right class surfaces the same
 *     branch — the test only needs a deterministic source of that error
 *     class. `verifyHiveSignature` and other middleware are NOT mocked
 *     (these are unit-level specs against the function directly, not
 *     route specs). `vi.spyOn(redisModule, 'getRedis')` is the same
 *     namespace-import + spy pattern round-1 established for
 *     `appDbModule.getAppPool` in `tests/routes/orcid.test.ts`.
 * (c) Real-Redis sibling coverage: the rest of this file (lifecycle
 *     seed-on-grant, invalidate-on-revocation, batch idempotency) runs
 *     against real Redis + real HAF and exercises `seedAccreditationBonus`
 *     end-to-end on the happy path. The carve-out covers only the
 *     error-class branches the happy path can't reach.
 *
 * Carve-out extension for `backfillAccreditationSeeds` describe block
 * (BACKEND-REPUTATION-SSOT round-2 hold #10): this block uses
 * `vi.spyOn(accreditationModule, 'getAllAccreditedAccounts')` to drive
 * the boot-backfill into its `accredited.size === 0` early-return branch
 * and to pin the normal `pipeline.set('NX')` path against a known
 * accredited set.
 *   (a) Real path that's impractical: HAF accreditation state cannot be
 *       set deterministically per-test — broadcasting `accredit` ops on
 *       Hive and waiting for HAF to index them is seed-and-wait, and
 *       constructing a per-test accredited set against a real HAF fixture
 *       bleeds into every other test in the suite (the
 *       `accredited_accounts_all` cache TTL is 10 minutes).
 *   (b) Why this mock is justified: the test pins the
 *       `backfillAccreditationSeeds` control flow — empty-set short-
 *       circuit, redis-null short-circuit, normal pipeline-SET-NX path,
 *       and the "starting"/"complete" log emission ordering. The mocked
 *       function is a domain function (not pool/cache), so explicit
 *       per-test justification is required. `verifyHiveSignature` and
 *       other auth middleware are NOT mocked.
 *   (c) Real-path companion: the rest of this file exercises the
 *       boot-backfill's downstream effect (`seedAccreditationBonus` SET
 *       NX on real Redis) against real HAF, covering the integrated
 *       behavior on the happy path. The mocked block covers only the
 *       branches the real-HAF environment cannot reach deterministically.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as redisModule from '../../src/redis.js';
import { getRedis } from '../../src/redis.js';
import { logger } from '../../src/logger.js';
import {
  backfillAccreditationSeeds,
  batchKey,
  computeReputationBatch,
  getReputationScore,
  invalidateOnRevocation,
  parseBatchValue,
  resetParseWarnStateForTests,
  seedAccreditationBonus,
} from '../../src/reputation.js';
import * as accreditationModule from '../../src/accreditation.js';
import { DEFAULT_REPUTATION_WEIGHTS } from '../../src/types/index.js';
import { isHafConfigured } from '../../src/db.js';
import { getAllAccreditedAccounts } from '../../src/accreditation.js';
import { getCachedGenesisBlock } from '../../src/hafsql.js';

const TEST_USER = 'pevo-lifecycle-test-user';

describe('accreditation lifecycle: seed on grant', () => {
  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(TEST_USER));
  });

  it('seedAccreditationBonus writes the provisional entry', async () => {
    const redis = getRedis();
    if (!redis) return;

    await seedAccreditationBonus(TEST_USER);

    const raw = await redis.get(batchKey(TEST_USER));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.score).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
    expect(parsed.breakdown.papers).toBe(0);
    expect(parsed.breakdown.reviews).toBe(0);
    expect(parsed.breakdown.citations).toBe(0);
    expect(parsed.breakdown.accreditation).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
  });

  it('getReputationScore returns the bonus immediately, without a cycle', async () => {
    const redis = getRedis();
    if (!redis) return;

    await seedAccreditationBonus(TEST_USER);
    const rep = await getReputationScore(TEST_USER);

    expect(rep.score).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
    expect(rep.breakdown.accreditation).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
  });

  it('SET NX semantics: never clobbers a real cycle-computed score', async () => {
    const redis = getRedis();
    if (!redis) return;

    const real = {
      score: 87.5,
      breakdown: { papers: 30, reviews: 40, citations: 12.5, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(real));

    await seedAccreditationBonus(TEST_USER);

    const after = await getReputationScore(TEST_USER);
    expect(after.score).toBe(87.5);
    expect(after.breakdown.papers).toBe(30);
  });
});

describe('accreditation lifecycle: invalidate on revocation', () => {
  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(TEST_USER));
  });

  it('invalidateOnRevocation deletes the entry', async () => {
    const redis = getRedis();
    if (!redis) return;

    const stale = {
      score: 42,
      breakdown: { papers: 10, reviews: 20, citations: 7, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(stale));

    await invalidateOnRevocation(TEST_USER);

    const raw = await redis.get(batchKey(TEST_USER));
    expect(raw).toBeNull();
  });

  it('getReputationScore returns 0 immediately after revocation, without a cycle', async () => {
    const redis = getRedis();
    if (!redis) return;

    const stale = {
      score: 42,
      breakdown: { papers: 10, reviews: 20, citations: 7, accreditation: 5 },
    };
    await redis.set(batchKey(TEST_USER), JSON.stringify(stale));

    await invalidateOnRevocation(TEST_USER);

    const rep = await getReputationScore(TEST_USER);
    expect(rep.score).toBe(0);
    expect(rep.breakdown).toEqual({ papers: 0, reviews: 0, citations: 0, accreditation: 0 });
  });
});

describe('computeReputationBatch idempotency', () => {
  it('two runs with identical inputs produce a byte-identical result map', { timeout: 90_000 }, async (ctx) => {
    // Per BACKEND-REPUTATION-SSOT round-1 hold #22: the canary previously
    // silently returned on HAF-empty / no-accredited / no-genesis. Use
    // ctx.skip() so the absence is visible in CI test output rather than
    // a vacuous pass.
    if (!isHafConfigured()) {
      return ctx.skip(true, 'HAF unavailable');
    }
    const accredited = await getAllAccreditedAccounts();
    if (accredited.size === 0) {
      return ctx.skip(true, 'No accredited corpus on HAF');
    }
    const genesis = getCachedGenesisBlock();
    if (genesis === 0) {
      return ctx.skip(true, 'Genesis block not yet discovered');
    }

    const users = [...accredited].slice(0, 5);
    // Use a fixed cycleEndBlock (genesis + 1 day at 3s blocks) so head-block
    // drift between the two runs cannot perturb the result.
    const cycleEndBlock = genesis + 28_800;
    const prevScores = {};

    const run1 = await computeReputationBatch(users, prevScores, cycleEndBlock);
    const run2 = await computeReputationBatch(users, prevScores, cycleEndBlock);

    const obj1 = Object.fromEntries(run1);
    const obj2 = Object.fromEntries(run2);
    expect(JSON.stringify(obj2)).toBe(JSON.stringify(obj1));
  });
});

// Per BACKEND-REPUTATION-SSOT round-1 hold #18: parseBatchValue is the
// load-bearing shape guard between the batch writer (JSON-encoded
// {score, breakdown}) and the readers. Three failure branches exist —
// null/undefined, JSON.parse throws, and parsed lacks numeric .score —
// and the latter two are critical when a deploy-time flush is skipped and
// pre-existing legacy numeric-string keys persist. The tests verify each
// branch returns null (so the readers fall through to ZERO_SCORE) and that
// the rate-limited operator warn fires for the malformed branches.
describe('parseBatchValue — malformed shape branches surface ZERO_SCORE', () => {
  const TEST_LEGACY_USER = 'pevo-parse-legacy-test-user';

  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(TEST_LEGACY_USER));
    // Per BACKEND-REPUTATION-SSOT round-2 hold #4 +
    // vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12:
    // reset the module-private rate-limiter so each test sees the immediate-
    // log branch (not the suppressed-by-recent-fire branch). The warn-fires
    // assertions below would flake without this — `flagMalformedBatchValue`
    // suppresses additional warns within PARSE_WARN_INTERVAL_MS (60s).
    resetParseWarnStateForTests();
  });

  it('returns null on null/undefined input', () => {
    expect(parseBatchValue(null)).toBeNull();
    expect(parseBatchValue(undefined)).toBeNull();
  });

  it('returns null on non-JSON garbage and warns with structured event payload', () => {
    // No `.mockImplementation(noop)` — bypassing the function under test would
    // hide a mutation removing the structured `event` / `count` / `raw_sample`
    // fields per vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.
    // The spy tracks calls while the real logger still fires (filtered by
    // pino-level config in the test env so console isn't spammed).
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const result = parseBatchValue('not-valid-json{');
      expect(result).toBeNull();

      const parseFailedCalls = warnSpy.mock.calls.filter(([arg]) => {
        if (!arg || typeof arg !== 'object') return false;
        return (arg as { event?: string }).event === 'reputation.batch.parse_failed';
      });
      expect(parseFailedCalls.length).toBeGreaterThanOrEqual(1);
      const [payload] = parseFailedCalls[0];
      expect(payload).toMatchObject({
        event: 'reputation.batch.parse_failed',
        count: expect.any(Number),
        raw_sample: expect.any(String),
      });
      // `raw_sample` should reflect the malformed input (or its truncated head).
      expect(((payload as { raw_sample: string }).raw_sample)).toContain('not-valid-json');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns null on JSON whose parsed value lacks numeric `score` (legacy numeric-string) and warns with the same event', () => {
    // The deploy-flush-skipped scenario: pre-existing keys hold '42'
    // (a JSON-parseable bare number) instead of '{"score":42,...}'.
    // This branch (parsed-but-wrong-shape) fires the same
    // `reputation.batch.parse_failed` warn as the JSON-parse-throws branch.
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      expect(parseBatchValue('42')).toBeNull();
      // Other malformed shapes (no warn assertion here — the rate-limiter
      // suppresses repeat warns within PARSE_WARN_INTERVAL_MS):
      expect(parseBatchValue('{"score":"42"}')).toBeNull();
      expect(parseBatchValue('{"breakdown":{}}')).toBeNull();
      expect(parseBatchValue('[]')).toBeNull();

      const parseFailedCalls = warnSpy.mock.calls.filter(([arg]) => {
        if (!arg || typeof arg !== 'object') return false;
        return (arg as { event?: string }).event === 'reputation.batch.parse_failed';
      });
      // At least one warn fired (the rate-limiter may suppress subsequent
      // ones from the additional malformed-shape assertions).
      expect(parseFailedCalls.length).toBeGreaterThanOrEqual(1);
      const [payload] = parseFailedCalls[0];
      expect(payload).toMatchObject({
        event: 'reputation.batch.parse_failed',
        count: expect.any(Number),
        raw_sample: expect.any(String),
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('getReputationScore returns ZERO_SCORE for a legacy numeric-string entry', async () => {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(batchKey(TEST_LEGACY_USER), '42');
    const rep = await getReputationScore(TEST_LEGACY_USER);
    expect(rep.score).toBe(0);
    expect(rep.breakdown).toEqual({ papers: 0, reviews: 0, citations: 0, accreditation: 0 });
  });
});

// Per BACKEND-REPUTATION-SSOT round-1 hold #16: backfillAccreditationSeeds
// is the boot-time recovery path that ensures every chain-accredited user
// has a provisional batch entry after a Redis flush or fresh deploy. The
// acceptance criterion explicitly requires coverage for the redis-null
// branch (no-op), the accredited-empty branch (no SET calls), and the
// normal pipeline-SET-NX path.
describe('backfillAccreditationSeeds — boot-time recovery', () => {
  it('returns silently when Redis is unavailable', async () => {
    const redis = getRedis();
    if (!redis) return;

    const getRedisSpy = vi.spyOn(redisModule, 'getRedis').mockReturnValueOnce(null);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(backfillAccreditationSeeds()).resolves.toBeUndefined();
      // No "starting" or "complete" log when Redis is unavailable.
      const startCalls = infoSpy.mock.calls.filter(([, m]) => m === 'Accreditation seed backfill starting');
      const completeCalls = infoSpy.mock.calls.filter(([, m]) => m === 'Accreditation seed backfill complete');
      expect(startCalls).toHaveLength(0);
      expect(completeCalls).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
      getRedisSpy.mockRestore();
    }
  });

  it('returns silently when no accredited users exist', async () => {
    const redis = getRedis();
    if (!redis) return;

    const accreditedSpy = vi.spyOn(accreditationModule, 'getAllAccreditedAccounts').mockResolvedValueOnce(new Set());
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(backfillAccreditationSeeds()).resolves.toBeUndefined();
      // The function returns at `if (accredited.size === 0) return` BEFORE
      // emitting any starting/complete log.
      const startCalls = infoSpy.mock.calls.filter(([, m]) => m === 'Accreditation seed backfill starting');
      const completeCalls = infoSpy.mock.calls.filter(([, m]) => m === 'Accreditation seed backfill complete');
      expect(startCalls).toHaveLength(0);
      expect(completeCalls).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
      accreditedSpy.mockRestore();
    }
  });

  it('SET NX every accredited user without clobbering existing entries', async () => {
    const redis = getRedis();
    if (!redis) return;

    const FRESH = 'pevo-backfill-fresh-user';
    const EXISTING = 'pevo-backfill-existing-user';

    // Existing entry with a non-default score (mimics a real cycle-computed
    // value from a prior cycle that backfill must NOT clobber).
    const existingValue = JSON.stringify({
      score: 73,
      breakdown: { papers: 40, reviews: 25, citations: 3, accreditation: 5 },
    });

    await redis.del(batchKey(FRESH));
    await redis.set(batchKey(EXISTING), existingValue);

    const accreditedSpy = vi
      .spyOn(accreditationModule, 'getAllAccreditedAccounts')
      .mockResolvedValueOnce(new Set([FRESH, EXISTING]));

    try {
      await backfillAccreditationSeeds();

      const freshRaw = await redis.get(batchKey(FRESH));
      expect(freshRaw).not.toBeNull();
      const freshParsed = JSON.parse(freshRaw!);
      expect(freshParsed.score).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);
      expect(freshParsed.breakdown.accreditation).toBe(DEFAULT_REPUTATION_WEIGHTS.accreditation_bonus);

      // SET NX must NOT overwrite the existing entry.
      const existingRaw = await redis.get(batchKey(EXISTING));
      expect(existingRaw).toBe(existingValue);
    } finally {
      accreditedSpy.mockRestore();
      await redis.del(batchKey(FRESH));
      await redis.del(batchKey(EXISTING));
    }
  });
});

// BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS — `seedAccreditationBonus`
// re-throws on permanent (operator-actionable) error classes so the orcid
// post-broadcast cascade wrap surfaces 502 POST_BROADCAST_FAILED with
// `failed_step:'reputation_seed'`. Transient errors (Redis-side blips) stay
// swallowed because the next batch cycle re-derives provisional scores from
// chain state regardless. The discrimination is class-based (TypeError /
// SyntaxError / RangeError signal data-shape regressions in the upstream
// weights or scoring code, which the next cycle will NOT self-heal).
describe('seedAccreditationBonus — permanent vs transient error discrimination', () => {
  const RETHROW_USER = 'pevo-cascade-rethrow-test-user';

  beforeEach(async () => {
    const redis = getRedis();
    if (redis) await redis.del(batchKey(RETHROW_USER));
  });

  it('re-throws permanent errors (TypeError) so post-broadcast discrimination surfaces 502', async () => {
    const redis = getRedis();
    if (!redis) return; // Redis required to exercise the try/catch path.

    // Synthesize a permanent error from `redis.set` — the actual production
    // source is more typically a TypeError thrown inside
    // `provisionalScore(weights.accreditation_bonus)` when getReputationWeights
    // returns malformed data, but the discrimination is class-based, so any
    // TypeError surfaces the same branch. Pinning it via redis.set keeps the
    // test deterministic without depending on a corrupted weights document.
    const permanentErr = new TypeError("Cannot read property 'accreditation_bonus' of null");
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(permanentErr);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).rejects.toBe(permanentErr);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('re-throws permanent errors (SyntaxError)', async () => {
    const redis = getRedis();
    if (!redis) return;
    const permanentErr = new SyntaxError('Unexpected token in JSON at position 0');
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(permanentErr);
    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).rejects.toBe(permanentErr);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('swallows transient errors (generic Error) — next batch cycle re-derives', async () => {
    const redis = getRedis();
    if (!redis) return;
    const transientErr = new Error('Connection is closed');
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValueOnce(transientErr);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: transientErr, username: RETHROW_USER }),
        'Failed to seed accreditation bonus',
      );
    } finally {
      warnSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('returns silently when Redis is unavailable (transient — next cycle re-derives)', async () => {
    // Spec is intentionally conservative: a Redis outage at the time of an
    // accredit broadcast should NOT surface 502 POST_BROADCAST_FAILED to the
    // user, because the next batch cycle reconstructs the provisional score
    // from chain state. Re-throwing on null-Redis would couple the user-
    // visible accredit envelope to ephemeral Redis health, which is the
    // wrong contract per the task spec ("transient errors stay swallowed
    // because next batch cycle re-derives anyway").
    //
    // The shared-Redis fixture is up in the documented test topology, so we
    // flip `getRedis()` to null via `vi.spyOn(redisModule, 'getRedis')`
    // (same namespace-import + spy pattern round-1 established for
    // `appDbModule.getAppPool`). Asserts: silent return (no throw), no
    // Redis call, no log line — the function's `if (!redis) return` guard
    // is the only branch reached.
    const redis = getRedis();
    if (!redis) return; // No real Redis to spy on; nothing to assert.

    const getRedisSpy = vi.spyOn(redisModule, 'getRedis').mockReturnValueOnce(null);
    const setSpy = vi.spyOn(redis, 'set');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as void);

    try {
      await expect(seedAccreditationBonus(RETHROW_USER)).resolves.toBeUndefined();
      expect(getRedisSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      setSpy.mockRestore();
      getRedisSpy.mockRestore();
    }
  });
});

