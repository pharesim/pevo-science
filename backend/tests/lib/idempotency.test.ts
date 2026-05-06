/**
 * Unit tests for the idempotency layer that closes the retry-amplification
 * class on custody /broadcast + accreditation /verify (Option A.4 in
 * `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`).
 *
 * Coverage shape (pure logic + mocked pg.Pool, per the carve-out at root
 * CLAUDE.md "Carve-out for deterministic edge-case coverage"): the helper
 * is shape-only (no I/O) and the pool calls are exercised against a
 * vi.fn-backed query stub. The real HAF integration is exercised by the
 * route-level real-DB tests in `tests/routes/{custody,accreditation}*.test.ts`,
 * so this file is the unit-style companion that pins per-arm behavior
 * without requiring a HAF connection per test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  embedIdempotencyKey,
  validateIdempotencyKey,
  findCustodyBroadcastByIdempotencyKey,
  findAccreditByIdempotencyKey,
  type IdempotencyPool,
} from '../../src/lib/idempotency.js';
import { config } from '../../src/config.js';

const KEY = '11111111-2222-3333-4444-555555555555';

describe('validateIdempotencyKey', () => {
  it('accepts a non-empty string within the 128-char cap', () => {
    expect(validateIdempotencyKey(KEY)).toBeNull();
  });
  it('rejects empty string', () => {
    expect(validateIdempotencyKey('')).toMatch(/empty/);
  });
  it('rejects non-string', () => {
    expect(validateIdempotencyKey(42)).toMatch(/string/);
    expect(validateIdempotencyKey(undefined)).toMatch(/string/);
    expect(validateIdempotencyKey(null)).toMatch(/string/);
  });
  it('rejects strings longer than 128 chars', () => {
    expect(validateIdempotencyKey('a'.repeat(129))).toMatch(/128/);
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

  it('returns the comment hit on first match', async () => {
    const pool = poolReturning([{ trx_id: 'tx-comment-1', block_num: 100 }], []);
    const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    expect(hit).toEqual({ tx_id: 'tx-comment-1', block_num: 100 });
  });

  it('falls through to custom_json query when no comment matches', async () => {
    const pool = poolReturning([], [{ trx_id: 'tx-cj-1', block_num: 200 }]);
    const hit = await findCustodyBroadcastByIdempotencyKey(pool, 'alice', KEY);
    expect(hit).toEqual({ tx_id: 'tx-cj-1', block_num: 200 });
  });

  it('returns null when neither op surface has a row', async () => {
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
});

describe('findAccreditByIdempotencyKey', () => {
  it('returns the accredit hit when HAF has a matching row', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({
      rows: [{ trx_id: 'accredit-tx-1', block_num: 999 }],
    });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    const hit = await findAccreditByIdempotencyKey(pool, KEY);
    expect(hit).toEqual({ tx_id: 'accredit-tx-1', block_num: 999 });
  });

  it('returns null when no row matches', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    const hit = await findAccreditByIdempotencyKey(pool, KEY);
    expect(hit).toBeNull();
  });

  it('filters by accreditationAuthorities + appTag + accredit action and joins haf_operations', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] });
    const pool = { query: queryFn } as unknown as IdempotencyPool;
    await findAccreditByIdempotencyKey(pool, KEY);
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
