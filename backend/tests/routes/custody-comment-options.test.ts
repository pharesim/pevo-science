/**
 * `comment_options` on `POST /api/custody/broadcast`.
 *
 * Every new post the SPA builds (comment composer, publish page, review page,
 * edit-page continuation post) bundles a `comment_options` op after its
 * `comment` op to apply the rewards policy (`percent_hbd: 0`, no
 * beneficiaries). The route admits that op only under bindings that keep the
 * server from signing anything the SPA does not build:
 *   - an EARLIER `comment` op in the same bundle has the same author and
 *     permlink (a lone options op, or one aimed at another post, is refused);
 *   - its `author` is the JWT subject;
 *   - `percent_hbd` is exactly 0 and `extensions` is an empty array, so a
 *     stolen session cannot route rewards through beneficiaries;
 *   - `max_accepted_payout`, `allow_votes` and `allow_curation_rewards` carry
 *     the SPA's values. The bound comment op may edit an existing post, and
 *     the chain only lets these fields tighten, so on a post still in its
 *     payout window that nobody has voted on yet an unpinned value could not
 *     be reverted.
 * Every binding refusal is the pre-gate 403 FORBIDDEN: the refusal tests send NO
 * fresh-auth proof, so a refusal that ran after the gate would surface as
 * 401 FRESH_AUTH_REQUIRED instead and fail the assertion.
 *
 * Justification per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - `../../src/hive.js` broadcast helpers mocked. The dhive client is in the
 *    carve-out's "third-party libraries non-trivial to run for real per-test"
 *    list; a real broadcast would sign and submit to a live witness. The
 *    broadcast surface's error and timeout handling is covered in
 *    `tests/lib/broadcast-error.test.ts`.
 *  - `../../src/custody-crypto.js` decryptKey mocked, same rationale as
 *    `tests/routes/custody-non-consent-fresh-auth.test.ts`. The AES-GCM
 *    encrypt/decrypt round-trip is exercised by
 *    `tests/lib/custody-crypto.test.ts`.
 *  - `verifyHiveSignature` runs REAL: the admit path must cross the real
 *    session-proof gate, so the middleware is not mocked (clause b).
 *
 * Real: Postgres (`accounts` row), Redis or its in-memory fallback for the
 * fresh-auth store, the JWT middleware, and `src/lib/fresh-auth.ts`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { sendOperationsMock } = vi.hoisted(() => ({
  sendOperationsMock: vi.fn().mockResolvedValue({ id: 'comment-options-tx-id', block_num: 8765 }),
}));

vi.mock('../../src/hive.js', async () => {
  const { MockBroadcastTimeoutError } = await import('../support/broadcast-mocks.js');
  return {
    hiveClient: {
      database: { getAccounts: vi.fn().mockResolvedValue([]) },
      broadcast: { sendOperations: (...args: unknown[]) => sendOperationsMock(...args) },
    },
    broadcastSendOperationsWithTimeout: (...args: unknown[]) => sendOperationsMock(...args),
    BroadcastTimeoutError: MockBroadcastTimeoutError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30_000,
  };
});

import { PrivateKey } from '@hiveio/dhive';
const TEST_POSTING_WIF = PrivateKey.fromSeed('pevo-comment-options-seed').toString();

vi.mock('../../src/custody-crypto.js', () => ({
  decryptKey: () => TEST_POSTING_WIF,
}));

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const {
  _resetFreshAuthMemStoreForTests,
  issueSessionFreshAuthToken,
} = await import('../../src/lib/fresh-auth.js');
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

const RUN_ID = Date.now();
const SUFFIX = (RUN_ID % 100000).toString(36).padStart(4, '0').slice(-4);
const USER = `coop${SUFFIX}a`;
const OTHER = `coop${SUFFIX}b`;
const USER_EMAIL = `co_user_${RUN_ID}@example.com`;

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

function bearerFor(username: string): string {
  const token = jwt.sign({ sub: username, custody: 'light' }, config.sessionSecret, { expiresIn: '5m' });
  return `Bearer ${token}`;
}

/** The comment op exactly as the SPA's publish page builds it. */
function commentOp(author: string, permlink: string): [string, Record<string, unknown>] {
  return ['comment', {
    parent_author: '',
    parent_permlink: config.appTag,
    author,
    permlink,
    title: 'A paper',
    body: 'Abstract.',
    json_metadata: JSON.stringify({ app: `${config.appTag}/1.0`, tags: [config.appTag] }),
  }];
}

/** The comment_options op exactly as every SPA bundle site builds it, with
 *  per-test overrides layered on top. */
function optionsOp(
  author: string,
  permlink: string,
  overrides: Record<string, unknown> = {},
): [string, Record<string, unknown>] {
  return ['comment_options', {
    author,
    permlink,
    max_accepted_payout: '1000000.000 HBD',
    percent_hbd: 0,
    allow_votes: true,
    allow_curation_rewards: true,
    extensions: [],
    ...overrides,
  }];
}

const VOTE_OP = (voter: string) => [
  'vote',
  { voter, author: 'someauthor', permlink: 'somepermlink', weight: 10000 },
];

async function broadcast(operations: unknown[], proof?: string) {
  return request(app)
    .post('/api/custody/broadcast')
    .set('Authorization', bearerFor(USER))
    .send(proof === undefined ? { operations } : { operations, fresh_auth_proof: proof });
}

describe.skipIf(!dbReachable)('POST /api/custody/broadcast admits comment_options bound to its comment', () => {
  beforeEach(async () => {
    sendOperationsMock.mockReset();
    sendOperationsMock.mockResolvedValue({ id: 'comment-options-tx-id', block_num: 8765 });
    _resetFreshAuthMemStoreForTests();
    await clearRateLimitKeys(['custody-broadcast']);

    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [USER]).catch(() => {});
    await pool.query(
      `INSERT INTO accounts (email, username, password_hash, custody, posting_key_enc, iv_posting, verify_token, expires_at)
       VALUES ($1, $2, 'placeholder-hash', 'light', $3, $4, NULL, $5)`,
      [
        USER_EMAIL,
        USER,
        Buffer.from('placeholder-ciphertext'),
        Buffer.from('placeholder-iv'),
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      ],
    );
  });

  afterAll(async () => {
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username = $1', [USER]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username = $1', [USER]).catch(() => {});
  });

  describe('admitted', () => {
    it('comment + comment_options with a session proof broadcasts both ops unchanged', async () => {
      const proof = await issueSessionFreshAuthToken(USER, 'password');
      const operations = [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one')];
      const res = await broadcast(operations, proof.token);

      expect(res.status).toBe(200);
      expect(res.body.data.tx_id).toBe('comment-options-tx-id');
      expect(sendOperationsMock).toHaveBeenCalledTimes(1);
      expect(sendOperationsMock.mock.calls[0][0]).toEqual(operations);
    });

    it('comment + comment_options without a proof passes the allowlist and stops at the fresh-auth gate', async () => {
      const res = await broadcast([commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one')]);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('FRESH_AUTH_REQUIRED');
      expect(res.body.error.details?.reason).toBe('missing');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    });

    it('a vote-only bundle is unchanged', async () => {
      const proof = await issueSessionFreshAuthToken(USER, 'password');
      const res = await broadcast([VOTE_OP(USER)], proof.token);
      expect(res.status).toBe(200);
    });

    it('a lone comment (the edit page\'s native edit) is unchanged', async () => {
      const proof = await issueSessionFreshAuthToken(USER, 'password');
      const res = await broadcast([commentOp(USER, 'paper-one')], proof.token);
      expect(res.status).toBe(200);
    });
  });

  describe('refused before the fresh-auth gate with 403 FORBIDDEN', () => {
    async function expectRefused(operations: unknown[], message: RegExp) {
      const res = await broadcast(operations);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toMatch(message);
      expect(res.body.error.message).not.toContain('\u2014');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    }

    it('a lone comment_options op', async () => {
      await expectRefused(
        [optionsOp(USER, 'paper-one')],
        /comment_options must follow a comment op for the same author and permlink/,
      );
    });

    it('comment_options placed before its comment', async () => {
      await expectRefused(
        [optionsOp(USER, 'paper-one'), commentOp(USER, 'paper-one')],
        /comment_options must follow a comment op for the same author and permlink/,
      );
    });

    it('comment_options whose permlink differs from the bundled comment', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'someone-elses-paper')],
        /comment_options must follow a comment op for the same author and permlink/,
      );
    });

    it('comment_options whose author differs from the bundled comment', async () => {
      // The bundled comment's author is already bound to the JWT subject, so an
      // options author that differs from it is refused by the subject binding.
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(OTHER, 'paper-one')],
        new RegExp(`comment_options author must be '${USER}'`),
      );
    });

    it('a lone comment_options op for another author is refused by the subject binding', async () => {
      // A foreign comment op would be refused first by the comment binding,
      // so the options op is sent by itself.
      await expectRefused(
        [optionsOp(OTHER, 'their-paper')],
        new RegExp(`comment_options author must be '${USER}'`),
      );
    });

    it('a nonzero percent_hbd', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { percent_hbd: 10000 })],
        /comment_options percent_hbd must be 0/,
      );
    });

    it('a percent_hbd that is not the number 0', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { percent_hbd: '0' })],
        /comment_options percent_hbd must be 0/,
      );
    });

    it('beneficiaries in extensions', async () => {
      await expectRefused(
        [
          commentOp(USER, 'paper-one'),
          optionsOp(USER, 'paper-one', {
            extensions: [[0, { beneficiaries: [{ account: OTHER, weight: 10000 }] }]],
          }),
        ],
        /comment_options extensions must be empty/,
      );
    });

    it('a lowered max_accepted_payout', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { max_accepted_payout: '0.000 HBD' })],
        /comment_options max_accepted_payout must be '1000000\.000 HBD'/,
      );
    });

    it('allow_votes false', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { allow_votes: false })],
        /comment_options allow_votes and allow_curation_rewards must be true/,
      );
    });

    it('allow_curation_rewards false', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { allow_curation_rewards: false })],
        /comment_options allow_votes and allow_curation_rewards must be true/,
      );
    });

    it('a missing extensions field', async () => {
      await expectRefused(
        [commentOp(USER, 'paper-one'), optionsOp(USER, 'paper-one', { extensions: undefined })],
        /comment_options extensions must be empty/,
      );
    });
  });

  describe('a non-object payload is refused before the fresh-auth gate with 400 VALIDATION_ERROR', () => {
    async function expectInvalidPayload(params: unknown) {
      const res = await broadcast([commentOp(USER, 'paper-one'), ['comment_options', params]]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe('Invalid comment_options payload');
      expect(sendOperationsMock).not.toHaveBeenCalled();
    }

    it('null params', async () => {
      await expectInvalidPayload(null);
    });

    it('string params', async () => {
      await expectInvalidPayload('paper-one');
    });
  });
});
