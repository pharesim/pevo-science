/**
 * P1 coverage: the email /verify accreditation path refuses a sanctioned
 * account. A self-service /verify must NOT lift a moderation sanction (only a
 * deliberate admin accredit lifts it), so the guard returns 403
 * ACCREDITATION_SANCTIONED before the broadcast-attempt cap claim and the
 * admin broadcast, without leaking the moderation reason. The 403 also
 * consumes a slot of the `/verify` limiter.
 *
 * Carve-out (root CLAUDE.md "Running Tests"): `readSanctionState` is mocked to
 * `'sanctioned'` because the read-only public HAF has no sanctioned `pevotest`
 * account to seed against; the rest of accreditation.js runs real, and
 * `broadcastAdminCustomJson` is mocked so
 * the no-broadcast invariant is asserted deterministically. `verifyHiveSignature`
 * is not mocked. The shared guard logic
 * itself (`readSanctionState` SQL) is covered against real Postgres in
 * `sanction-read-real-postgres.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';
import jwt from 'jsonwebtoken';

const { broadcastJsonMock, readSanctionStateMock } = vi.hoisted(() => ({
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-accred-tx' }),
  readSanctionStateMock: vi.fn().mockResolvedValue('sanctioned'),
}));

vi.mock('../../src/hive.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hive.js')>('../../src/hive.js');
  return {
    ...actual,
    broadcastAdminCustomJson: (payload: Record<string, unknown>, timeoutMs?: number) =>
      (broadcastJsonMock as (...a: unknown[]) => unknown)(payload, timeoutMs),
  };
});

vi.mock('../../src/accreditation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/accreditation.js')>('../../src/accreditation.js');
  return {
    ...actual,
    readSanctionState: readSanctionStateMock,
  };
});

const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
const { getRedis } = await import('../../src/redis.js');
const { isHafConfigured } = await import('../../src/db.js');

const app = createApp();

// /verify short-circuits with 500 if the admin posting key is unset; stub a
// valid-checksum WIF so the flow reaches the ever-sanctioned guard. The broadcast
// is mocked, so this key never signs anything.
(config as { pevoAdminPostingKey: string }).pevoAdminPostingKey = PrivateKey.fromSeed(
  'pevo-accred-verify-sanctioned-seed',
).toString();

async function seedPendingAccreditation(token: string, username: string): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error('Redis required');
  const pending = {
    hive_username: username,
    full_name: 'Sanctioned Verify User',
    institution: 'Test University',
    field: 'physics',
    email: 'sanctioned-verify@university.edu',
    orcid: '',
    token,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };
  await redis.set(`${config.appTag}:pending_accred:${token}`, JSON.stringify(pending), 'EX', 24 * 60 * 60);
}

// Posts the token with a session JWT for `username`, which the real
// `verifyHiveSignature` checks.
function postVerify(token: string, username: string) {
  const session = jwt.sign({ sub: username, custody: 'self' }, config.sessionSecret, { expiresIn: '5m' });
  return request(app)
    .post('/api/accreditation/verify')
    .set('Authorization', `Bearer ${session}`)
    .send({ token });
}

describe('POST /api/accreditation/verify — ever-sanctioned guard', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-accred-tx' });
    readSanctionStateMock.mockReset().mockResolvedValue('sanctioned');
  });

  it('refuses a sanctioned account with 403 ACCREDITATION_SANCTIONED and does not broadcast', async ({ skip }) => {
    const redis = getRedis();
    if (!redis || !isHafConfigured()) return skip(); // needs Redis + the HAF gate

    const username = `sanctioned-verify-${crypto.randomBytes(6).toString('hex')}`;
    const token = `sanctioned-verify-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token, username);

    const res = await postVerify(token, username);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCREDITATION_SANCTIONED');
    expect(res.body.error.message.toLowerCase()).not.toContain('sanction');
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // Cleanup
    await redis.del(`${config.appTag}:pending_accred:${token}`);
  });

  it('the 403 consumes a /verify limiter slot', async ({ skip }) => {
    const redis = getRedis();
    if (!redis || !isHafConfigured()) return skip(); // needs Redis + the HAF gate

    // The fresh account gives this spec its own bucket of the 5-per-minute
    // limiter.
    const username = `sanctioned-verify-${crypto.randomBytes(6).toString('hex')}`;
    const limiterKey = `${config.appTag}:rl:accred-verify:${username}`;
    const token = `sanctioned-verify-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token, username);

    try {
      // Four invalid-token 400s use all but one of the five slots.
      for (let i = 0; i < 4; i++) {
        const res = await postVerify(`sanctioned-verify-missing-${i}`, username);
        expect(res.status).toBe(400);
      }

      const refused = await postVerify(token, username);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('ACCREDITATION_SANCTIONED');

      // A 403 here means the refusal gave its slot back.
      const res = await postVerify(token, username);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await redis.del(`${config.appTag}:pending_accred:${token}`, limiterKey);
    }
  });
});
