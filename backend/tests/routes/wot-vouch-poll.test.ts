/**
 * Coverage for `pollForVouch` — the pre-broadcast bust-and-poll step in
 * POST /api/wot/vouch. The poll busts the 60s `vouch_status` cache and re-reads
 * HAF until the just-broadcast vouch surfaces or a tight cap elapses, so an
 * over-threshold vouch can accredit in the same request instead of waiting for
 * the next vouch or cache expiry. Sibling to
 * `tests/routes/wot-vouch-broadcast-outcomes.test.ts`, which covers the route's
 * response branching with `verifyHiveSignature` exercised for real; this file
 * isolates the poll-loop control flow below the route layer.
 *
 * Justification for mocking `getVouchStatus` + spying `hafCache.invalidate`
 * (per root CLAUDE.md "Running Tests" carve-out):
 *   - The behavior under test is the bust-then-read loop and its cap timeout,
 *     not HAF's query planner. Reproducing "the vouch appears on the Nth HAF
 *     read after ~3s+ block-ingestion lag" against real HAF is seed-and-wait
 *     per test and inherently timing-nondeterministic. `getVouchStatus` is an
 *     intra-app helper not in the carve-out's enumerated mock-target list; it
 *     falls under the catch-all ("any case where exercising the real path
 *     per-test is impractical"), the same justification used by the sibling
 *     route test. It is mocked at the `wot.js` module boundary; `pollForVouch`
 *     (in `routes/wot.ts`) imports it cross-module so the mock intercepts it.
 *   - `hafCache.invalidate` is SPIED (resolves to a no-op) so the
 *     "busts before every read" invariant has an observable signal and bust
 *     counts can be asserted without real Redis traffic. Cryptographic
 *     verification is not in scope: `pollForVouch` is exercised directly as a
 *     function, never through `verifyHiveSignature`, so clause (b) does not
 *     apply (no auth middleware is bypassed here).
 *   - Real-path companion (clause c): the integrated vouch route is exercised
 *     end-to-end with real `verifyHiveSignature` in
 *     `wot-vouch-broadcast-outcomes.test.ts`, and the `QueryCache`
 *     invalidate→getOrSet interaction runs against real Redis in the cache
 *     suite. This file's risk class ("poll-loop control flow / cap timeout")
 *     is orthogonal to both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VouchStatus } from '../../src/wot.js';

const { getVouchStatusMock } = vi.hoisted(() => ({
  getVouchStatusMock: vi.fn<(username: string) => Promise<VouchStatus | null>>(),
}));

// Mock at the wot.js boundary and re-export the rest so broadcastWotAccreditation
// and the other wot.js exports imported in the route module still load.
vi.mock('../../src/wot.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/wot.js')>('../../src/wot.js');
  return { ...actual, getVouchStatus: getVouchStatusMock };
});

const { pollForVouch } = await import('../../src/routes/wot.js');
const { hafCache } = await import('../../src/cache.js');

const VOUCHER = 'alice';
const VOUCHEE = 'bob';

function statusWith(vouchers: string[]): VouchStatus {
  return {
    username: VOUCHEE,
    vouch_count: vouchers.length,
    threshold: 3,
    eligible: vouchers.length >= 3,
    vouches: vouchers.map((v) => ({
      voucher: v,
      relationship: 'colleague',
      timestamp: '2026-01-01T00:00:00Z',
    })),
    accreditation_method: vouchers.length >= 3 ? 'wot' : null,
  };
}

let invalidateSpy: ReturnType<typeof vi.spyOn>;

// Assert the bust-strictly-before-read invariant per iteration via the global
// invocationCallOrder counters: the i-th invalidate must have fired before the
// i-th getVouchStatus read. Call-count parity alone is satisfied by a read-
// then-bust swap; this ordering check is what fails that mutation red.
function expectBustBeforeEachRead(): void {
  const bustOrder = invalidateSpy.mock.invocationCallOrder;
  const readOrder = getVouchStatusMock.mock.invocationCallOrder;
  expect(bustOrder.length).toBe(readOrder.length);
  for (let i = 0; i < bustOrder.length; i++) {
    expect(bustOrder[i]).toBeLessThan(readOrder[i]);
  }
}

beforeEach(() => {
  getVouchStatusMock.mockReset();
  // No-op the bust so it has no real Redis/memory side effect; we only need
  // to observe that it fires once per read with the vouchee-scoped key.
  invalidateSpy = vi.spyOn(hafCache, 'invalidate').mockResolvedValue(undefined);
});

afterEach(() => {
  invalidateSpy.mockRestore();
});

describe('pollForVouch — bust-and-poll for a freshly-broadcast vouch', () => {
  it('returns as soon as the voucher\'s vouch surfaces, busting before each read', async () => {
    // Vouch absent on the first HAF read (block-ingestion lag), present on the
    // second. The poll should bust + re-read and return the moment it appears.
    getVouchStatusMock
      .mockResolvedValueOnce(statusWith([])) // pre-ingestion
      .mockResolvedValueOnce(statusWith([VOUCHER])); // vouch surfaced

    const result = await pollForVouch(VOUCHEE, VOUCHER, { capMs: 1_000, intervalMs: 5 });

    expect(result?.vouches.some((v) => v.voucher === VOUCHER)).toBe(true);
    expect(getVouchStatusMock).toHaveBeenCalledTimes(2);
    // Busted once per read (both iterations) with the vouchee-scoped key.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith(`vouch_status:${VOUCHEE}`);
    // Bust-strictly-before-each-read is the load-bearing property: a read-then-
    // bust swap re-caches the stale answer. Pin per-iteration ordering via
    // invocationCallOrder so the swap fails red (call-count parity alone passes
    // it). Each invalidate must precede its paired read.
    expectBustBeforeEachRead();
  });

  it('busts the cache before every read across multiple poll iterations', async () => {
    getVouchStatusMock.mockResolvedValue(statusWith([])); // never surfaces

    await pollForVouch(VOUCHEE, VOUCHER, { capMs: 35, intervalMs: 10 });

    // Bust count tracks read count one-to-one (the bust-before-read invariant);
    // exact iteration count varies with real-timer jitter, so assert the
    // relationship, not a fixed number.
    expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(invalidateSpy.mock.calls.length).toBe(getVouchStatusMock.mock.calls.length);
    for (const call of invalidateSpy.mock.calls) {
      expect(call[0]).toBe(`vouch_status:${VOUCHEE}`);
    }
    // Order, not just parity: each iteration's bust must precede its read. A
    // mutation swapping the two lines keeps the counts equal but fails here.
    expectBustBeforeEachRead();
  });

  it('falls through with the latest status (no throw) when the cap elapses before the vouch appears', async () => {
    const stale = statusWith(['someone-else']);
    getVouchStatusMock.mockResolvedValue(stale);

    const result = await pollForVouch(VOUCHEE, VOUCHER, { capMs: 30, intervalMs: 10 });

    // Latest status handed back for the caller's threshold check; no exception
    // (the route then falls through to its existing skipped path).
    expect(result).toEqual(stale);
    expect(result?.vouches.some((v) => v.voucher === VOUCHER)).toBe(false);
  });

  it('returns null without throwing when HAF is unavailable (getVouchStatus null)', async () => {
    getVouchStatusMock.mockResolvedValue(null);

    const result = await pollForVouch(VOUCHEE, VOUCHER, { capMs: 30, intervalMs: 10 });

    expect(result).toBeNull();
  });
});
