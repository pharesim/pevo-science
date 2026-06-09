/**
 * Coverage for `pollForRetraction` — the on-chain retraction-verification step
 * in POST /api/wot/retract. The poll busts the 60s `vouch_status` cache and
 * re-reads HAF until the retracting voucher's vouch edge to the vouchee has
 * DISAPPEARED (the retract_vouch is reflected on-chain) or a tight cap elapses.
 * The route revokes only on a verified retraction; an edge that never
 * disappears is treated as unverified and is NOT honored — that gate is what
 * stops an accredited voucher from revoking a victim's accreditation by claiming
 * a retraction they never broadcast.
 *
 * Sibling to `tests/routes/wot-vouch-poll.test.ts` (the vouch-appears poll) and
 * `tests/routes/wot-retract-cascaderevocation.test.ts` (the integrated route).
 * This file isolates the poll-loop control flow below the route layer so the
 * verified/unverified decision is exercised deterministically with short caps
 * instead of through the route's hardcoded ~6s cap against real HAF.
 *
 * Justification for mocking `getVouchStatus` + spying `hafCache.invalidate`
 * (per root CLAUDE.md "Running Tests" carve-out):
 *   - The behavior under test is the bust-then-read loop and its cap timeout,
 *     not HAF's query planner. Reproducing "the retraction surfaces on the Nth
 *     HAF read after ~3s+ block-ingestion lag" against real HAF is seed-and-wait
 *     per test and inherently timing-nondeterministic. `getVouchStatus` is an
 *     intra-app helper covered by the carve-out catch-all ("any case where
 *     exercising the real path per-test is impractical"), mocked at the `wot.js`
 *     module boundary; `pollForRetraction` (in `routes/wot.ts`) imports it
 *     cross-module so the mock intercepts it.
 *   - `hafCache.invalidate` is SPIED (resolves to a no-op) so the "busts before
 *     every read" invariant has an observable signal. No cryptographic
 *     verification is in scope: `pollForRetraction` is exercised directly as a
 *     function, never through `verifyHiveSignature`, so clause (b) does not
 *     apply (no auth middleware is bypassed here).
 *   - Real-path companion (clause c): the integrated retract route runs with
 *     real `verifyHiveSignature` + real `pollForRetraction` in
 *     `wot-retract-cascaderevocation.test.ts` (including the unverified-edge
 *     griefing case end-to-end). This file's risk class ("poll-loop control
 *     flow / cap timeout") is orthogonal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VouchStatus } from '../../src/wot.js';

const { getVouchStatusMock } = vi.hoisted(() => ({
  getVouchStatusMock: vi.fn<(username: string) => Promise<VouchStatus | null>>(),
}));

// Mock at the wot.js boundary and re-export the rest so the route module's other
// wot.js imports (revokeVoucheeIfBelowThreshold, etc.) still load.
vi.mock('../../src/wot.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/wot.js')>('../../src/wot.js');
  return { ...actual, getVouchStatus: getVouchStatusMock };
});

const { pollForRetraction } = await import('../../src/routes/wot.js');
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
  };
}

let invalidateSpy: ReturnType<typeof vi.spyOn>;

// Each iteration's bust must fire strictly before its paired read; call-count
// parity alone is satisfied by a read-then-bust swap, which would re-cache the
// stale (pre-retraction) answer. Pin per-iteration ordering via the global
// invocationCallOrder counters.
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
  invalidateSpy = vi.spyOn(hafCache, 'invalidate').mockResolvedValue(undefined);
});

afterEach(() => {
  invalidateSpy.mockRestore();
});

describe('pollForRetraction — bust-and-poll for a freshly-broadcast retraction', () => {
  it("returns as soon as the voucher's edge disappears, busting before each read", async () => {
    // Edge still present on the first HAF read (block-ingestion lag), gone on the
    // second. The poll should bust + re-read and return the moment it clears.
    getVouchStatusMock
      .mockResolvedValueOnce(statusWith([VOUCHER, 'carol', 'dave'])) // pre-ingestion
      .mockResolvedValueOnce(statusWith(['carol', 'dave'])); // retraction surfaced

    const result = await pollForRetraction(VOUCHEE, VOUCHER, { capMs: 1_000, intervalMs: 5 });

    expect(result?.vouches.some((v) => v.voucher === VOUCHER)).toBe(false);
    expect(getVouchStatusMock).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledWith(`vouch_status:${VOUCHEE}`);
    expectBustBeforeEachRead();
  });

  it('busts the cache before every read across multiple poll iterations', async () => {
    getVouchStatusMock.mockResolvedValue(statusWith([VOUCHER, 'carol', 'dave'])); // never clears

    await pollForRetraction(VOUCHEE, VOUCHER, { capMs: 35, intervalMs: 10 });

    expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(invalidateSpy.mock.calls.length).toBe(getVouchStatusMock.mock.calls.length);
    for (const call of invalidateSpy.mock.calls) {
      expect(call[0]).toBe(`vouch_status:${VOUCHEE}`);
    }
    expectBustBeforeEachRead();
  });

  it('falls through with the still-vouched status (no throw) when the cap elapses before the edge clears', async () => {
    const stillVouched = statusWith([VOUCHER, 'carol', 'dave']);
    getVouchStatusMock.mockResolvedValue(stillVouched);

    const result = await pollForRetraction(VOUCHEE, VOUCHER, { capMs: 30, intervalMs: 10 });

    // Latest status handed back; the voucher's edge is still present, so the
    // route treats this as an unverified retraction and does NOT revoke.
    expect(result).toEqual(stillVouched);
    expect(result?.vouches.some((v) => v.voucher === VOUCHER)).toBe(true);
  });

  it('returns null without throwing when HAF is unavailable (getVouchStatus null)', async () => {
    getVouchStatusMock.mockResolvedValue(null);

    const result = await pollForRetraction(VOUCHEE, VOUCHER, { capMs: 30, intervalMs: 10 });

    // Null is unverifiable; the route fails closed (no revoke) on a null status.
    expect(result).toBeNull();
  });
});
