/**
 * Unit tests for the idempotency layer that closes the retry-amplification
 * class on custody /broadcast + accreditation /verify (Option A.4 in
 * `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`).
 *
 * Mock posture (per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage"): this file is the unit-style companion for shape-only logic and
 * SQL parameterization. The pool is mocked because per-test HAF connections
 * are operationally infeasible at this granularity. **The sibling route-level
 * tests in `tests/routes/{custody,accreditation}-idempotency.test.ts` ALSO
 * mock `db.js`** (per their own carve-out headers), so they are NOT the
 * real-path companion for the SQL-shape risk class. The real-path
 * commitment is captured by `backend-idempotency-haf-integration-test.md`
 * (round-2 F6 follow-up) — that task adds an integration spec that exercises
 * `findCustodyBroadcastByIdempotencyKey` and
 * `findAccreditationBroadcastByIdempotencyKey` against a live HAF pool so a
 * schema/view/operator regression is caught by the real-path lane.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  embedIdempotencyKey,
  validateIdempotencyKey,
  findCustodyBroadcastByIdempotencyKey,
  findAccreditationBroadcastByIdempotencyKey,
  type IdempotencyPool,
} from '../../src/lib/idempotency.js';
import { config } from '../../src/config.js';

const KEY = '11111111-2222-3333-4444-555555555555';

describe('validateIdempotencyKey (discriminated result)', () => {
  it('returns { ok: true, value } for a non-empty string within the 128-char cap', () => {
    const result = validateIdempotencyKey(KEY);
    expect(result).toEqual({ ok: true, value: KEY });
  });
  it('rejects empty string with { ok: false, error: /empty/ }', () => {
    const result = validateIdempotencyKey('');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/empty/);
  });
  it('rejects non-string with { ok: false, error: /string/ }', () => {
    for (const v of [42, undefined, null]) {
      const result = validateIdempotencyKey(v);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error).toMatch(/string/);
    }
  });
  it('rejects strings longer than 128 chars', () => {
    const result = validateIdempotencyKey('a'.repeat(129));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/128/);
  });
});

describe('embedIdempotencyKey', () => {
  it('embeds in the first comment op json_metadata under appTag namespace', () => {
    const ops = [
      [
        'comment',
        {
          author: 'alice',
          permlink: 'p1',
          json_metadata: JSON.stringify({ app: `${config.appTag}/0.1.0`, [config.appTag]: { type: 'paper' } }),
        },
      ],
    ];
    const result = embedIdempotencyKey(ops, KEY);
    expect(result.embedded).toBe(true);
    if (!result.embedded) throw new Error('unreachable');
    expect(result.opType).toBe('comment');
    const params = result.ops[0] as [string, { json_metadata: string }];
    const meta = JSON.parse(params[1].json_metadata);
    expect(meta[config.appTag].idempotency_key).toBe(KEY);
    // Original namespace fields preserved
    expect(meta[config.appTag].type).toBe('paper');
    expect(meta.app).toBe(`${config.appTag}/0.1.0`);
  });

  it('embeds in custom_json op json payload as a top-level field', () => {
    const ops = [
      [
        'custom_json',
        {
          required_auths: [],
          required_posting_auths: ['alice'],
          id: config.appTag,
          json: JSON.stringify({ action: 'revote', target: 'bob/post' }),
        },
      ],
    ];
    const result = embedIdempotencyKey(ops, KEY);
    expect(result.embedded).toBe(true);
    if (!result.embedded) throw new Error('unreachable');
    expect(result.opType).toBe('custom_json');
    const params = result.ops[0] as [string, { json: string }];
    const payload = JSON.parse(params[1].json);
    expect(payload.idempotency_key).toBe(KEY);
    expect(payload.action).toBe('revote');
  });

  it('returns embedded:false for pure-vote bundles (no embed surface)', () => {
    const ops = [
      ['vote', { voter: 'alice', author: 'bob', permlink: 'p1', weight: 10000 }],
    ];
    const result = embedIdempotencyKey(ops, KEY);
    expect(result.embedded).toBe(false);
  });

  it('picks first comment in multi-op bundle when both comment + custom_json present', () => {
    const ops = [
      [
        'comment',
        { author: 'alice', permlink: 'p1', json_metadata: JSON.stringify({ app: config.appTag }) },
      ],
      [
        'custom_json',
        {
          required_auths: [],
          required_posting_auths: ['alice'],
          id: config.appTag,
          json: JSON.stringify({ action: 'revote' }),
        },
      ],
    ];
    const result = embedIdempotencyKey(ops, KEY);
    expect(result.embedded).toBe(true);
    if (!result.embedded) throw new Error('unreachable');
    expect(result.opType).toBe('comment');
    // The custom_json op MUST be untouched — first-op-wins. The HAF lookup
    // probes the same op type the embed picked, so consistency is required.
    const cj = result.ops[1] as [string, { json: string }];
    expect(JSON.parse(cj[1].json)).toEqual({ action: 'revote' });
  });

  it('returns a fresh array (does not mutate input)', () => {
    const original = [
      [
        'custom_json',
        {
          required_auths: [],
          required_posting_auths: ['alice'],
          id: config.appTag,
          json: JSON.stringify({ action: 'revote' }),
        },
      ],
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    const result = embedIdempotencyKey(original, KEY);
    expect(result.embedded).toBe(true);
    expect(original).toEqual(snapshot);
  });

  it('skips ops with malformed json_metadata and falls through to next op', () => {
    const ops = [
      ['comment', { author: 'alice', permlink: 'p1', json_metadata: 'not-valid-json{' }],
      [
        'custom_json',
        {
          required_auths: [],
          required_posting_auths: ['alice'],
          id: config.appTag,
          json: JSON.stringify({ action: 'revote' }),
        },
      ],
    ];
    const result = embedIdempotencyKey(ops, KEY);
    // The malformed comment is skipped; the second op (custom_json) takes the
    // embed. The malformed comment will be rejected by the route's upstream
    // validator anyway; the helper just keeps the embed pipeline lossless.
    expect(result.embedded).toBe(true);
    if (!result.embedded) throw new Error('unreachable');
    expect(result.opType).toBe('custom_json');
  });
});

describe('findCustodyBroadcastByIdempotencyKey', () => {
  function poolReturning(
    commentRows: Array<{ trx_id: string; block_num: number | null }>,
    customJsonRows: Array<{ trx_id: string; block_num: number | null }>,
  ): IdempotencyPool {
    const query = vi
      .fn()
      .mockImplementationOnce(async () => ({ rows: commentRows }))
      .mockImplementationOnce(async () => ({ rows: customJsonRows }));
    return { query } as unknown as IdempotencyPool;
  }

  it('returns the comment hit on first match (unscoped probe)', async () => {
    const pool = poolReturning([{ trx_id: 'tx-comment-1', block_num: 100 }], []);
    const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    expect(hit).toEqual({ tx_id: 'tx-comment-1', block_num: 100 });
  });

  it('falls through to custom_json query when no comment matches (unscoped probe)', async () => {
    const pool = poolReturning([], [{ trx_id: 'tx-cj-1', block_num: 200 }]);
    const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    expect(hit).toEqual({ tx_id: 'tx-cj-1', block_num: 200 });
  });

  it('returns null when neither op surface has a row (unscoped probe)', async () => {
    const pool = poolReturning([], []);
    const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    expect(hit).toBeNull();
  });

  it('scopes the comment query by author = username and joins haf_operations for trx_id', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    const firstCall = queryFn.mock.calls[0];
    expect(firstCall[0]).toMatch(/operation_comment_view/);
    expect(firstCall[0]).toMatch(/ocv\.author = \$1/);
    expect(firstCall[0]).toMatch(/haf_operations/);
    expect(firstCall[0]).toMatch(/included_trx_id/);
    expect(firstCall[1][0]).toBe('alice');
    expect(firstCall[1][2]).toBe(KEY);
  });

  it('scopes the custom_json query by required_posting_auths containing username and joins haf_operations', async () => {
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    const secondCall = queryFn.mock.calls[1];
    expect(secondCall[0]).toMatch(/required_posting_auths/);
    expect(secondCall[0]).toMatch(/haf_operations/);
    expect(secondCall[0]).toMatch(/included_trx_id/);
    expect(secondCall[1][1]).toEqual(['alice']);
    expect(secondCall[1][2]).toBe(KEY);
  });

  // F2 round-2: opType-bound lookup binds the HAF probe to the same op
  // surface the embed picks, closing the cross-op-type shadowing class.
  describe('opType-scoped lookup (round-2 F2)', () => {
    it('opType:"comment" probes ONLY the comment arm and skips custom_json', async () => {
      const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
      const pool = { query: queryFn } as unknown as IdempotencyPool;
      const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY, 'comment');
      expect(hit).toBeNull();
      // Only one HAF round-trip for the scoped probe.
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryFn.mock.calls[0][0]).toMatch(/operation_comment_view/);
    });

    it('opType:"comment" returns the comment hit without probing custom_json', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ trx_id: 'tx-comment-2', block_num: 300 }] });
      const pool = { query: queryFn } as unknown as IdempotencyPool;
      const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY, 'comment');
      expect(hit).toEqual({ tx_id: 'tx-comment-2', block_num: 300 });
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it('opType:"custom_json" probes ONLY the custom_json arm and skips comment', async () => {
      const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
      const pool = { query: queryFn } as unknown as IdempotencyPool;
      const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY, 'custom_json');
      expect(hit).toBeNull();
      expect(queryFn).toHaveBeenCalledTimes(1);
      // The single round-trip must be the custom_json query, not the comment query.
      expect(queryFn.mock.calls[0][0]).toMatch(/required_posting_auths/);
      expect(queryFn.mock.calls[0][0]).not.toMatch(/operation_comment_view/);
    });

    it('opType:"custom_json" returns the custom_json hit without probing comment', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ trx_id: 'tx-cj-2', block_num: 400 }] });
      const pool = { query: queryFn } as unknown as IdempotencyPool;
      const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY, 'custom_json');
      expect(hit).toEqual({ tx_id: 'tx-cj-2', block_num: 400 });
      expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it('omitted opType falls back to the unscoped two-arm probe', async () => {
      const queryFn = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const pool = { query: queryFn } as unknown as IdempotencyPool;
      const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
      expect(hit).toBeNull();
      expect(queryFn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('findAccreditationBroadcastByIdempotencyKey', () => {
  it('returns the accredit hit when HAF has a matching row', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({
      rows: [{ trx_id: 'accredit-tx-1', block_num: 999 }],
    });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    const hit = await findAccreditationBroadcastByIdempotencyKey(pool, KEY);
    expect(hit).toEqual({ tx_id: 'accredit-tx-1', block_num: 999 });
  });

  it('returns null when no row matches', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    const hit = await findAccreditationBroadcastByIdempotencyKey(pool, KEY);
    expect(hit).toBeNull();
  });

  it('filters by accreditationAuthorities + appTag + accredit action and joins haf_operations', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    await findAccreditationBroadcastByIdempotencyKey(pool, KEY);
    const [sql, params] = queryFn.mock.calls[0];
    expect(sql).toMatch(/cj\.custom_id = \$1/);
    expect(sql).toMatch(/'action' = 'accredit'/);
    expect(sql).toMatch(/required_posting_auths/);
    expect(sql).toMatch(/haf_operations/);
    expect(sql).toMatch(/included_trx_id/);
    expect(params[0]).toBe(config.appTag);
    expect(params[1]).toBe(KEY);
    expect(params[2]).toEqual(config.accreditationAuthorities);
  });
});
