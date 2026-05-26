/**
 * Unit coverage for the Pinata unpin helper's benign-absence tolerance.
 *
 * Carve-out clause (a): `fetch` (the global network I/O boundary) is stubbed
 * because the behavior under test — whether `unpinFromPinata` swallows an
 * "already-unpinned" signal versus raising — is a pure response-classification
 * branch that cannot be exercised against the live Pinata API per-test. It
 * requires an authenticated Pinata account and a CID known to be already
 * unpinned, and Pinata does not document the exact already-unpinned response
 * body (verified against docs.pinata.cloud, which documents only the 200). No
 * auth/crypto middleware is involved; this is a leaf helper over `fetch`.
 *
 * Carve-out clause (c): the integrated companion is the Pinata-backend
 * compensation-dispatch test in `ipfs-pin-durability.test.ts`, which drives the
 * real upload route with the real config toggle but exercises this helper only
 * on the success path. This file pins the helper's classification branch
 * itself — the benign-absence tolerance that the pre-fix code lacked (it raised
 * unconditionally on any non-2xx), so a revert to unconditional-throw fails red
 * here. Because the live already-unpinned body is undocumented, the match is
 * deliberately content-based over the known not-pinned reason-code family; this
 * test pins that current behavior rather than over-fitting a verbatim string.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { unpinFromPinata } from '../../src/lib/ipfs-shared.js';

function stubFetch(opts: { ok: boolean; status: number; body: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: opts.ok,
      status: opts.status,
      text: async () => opts.body,
    })) as unknown as typeof fetch,
  );
}

describe('unpinFromPinata benign-absence tolerance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The CURRENT_USER_HAS_NOT_PINNED_CID reason-code family and any plain-English
  // "not pinned" phrasing, matched case-insensitively across the underscore and
  // spaced forms.
  const benignBodies = [
    'CURRENT_USER_HAS_NOT_PINNED_CID',
    'not_pinned',
    'The CID is not pinned',
    'NOT PINNED',
  ];

  for (const body of benignBodies) {
    it(`swallows a non-2xx whose body signals already-unpinned: ${JSON.stringify(body)}`, async () => {
      stubFetch({ ok: false, status: 400, body });
      await expect(unpinFromPinata('QmFakeCid')).resolves.toBeUndefined();
    });
  }

  it('resolves on a clean 2xx', async () => {
    stubFetch({ ok: true, status: 200, body: 'OK' });
    await expect(unpinFromPinata('QmFakeCid')).resolves.toBeUndefined();
  });

  it('throws on a non-benign non-2xx (genuine error body)', async () => {
    stubFetch({ ok: false, status: 500, body: 'Internal Server Error' });
    await expect(unpinFromPinata('QmFakeCid')).rejects.toThrow(/Pinata unpin failed: 500/);
  });
});
