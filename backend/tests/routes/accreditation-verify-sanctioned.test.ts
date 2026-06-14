/**
 * P1 coverage: the email /verify accreditation path refuses a sanctioned
 * account. A self-service /verify must NOT lift a moderation sanction (only a
 * deliberate admin accredit lifts it), so the guard returns 403
 * ACCREDITATION_SANCTIONED before the broadcast-attempt cap claim and the
 * admin broadcast, without leaking the moderation reason.
 *
 * Carve-out (root CLAUDE.md "Running Tests"): `hasUnliftedSanction` is mocked to
 * true because the read-only public HAF has no sanctioned `pevotest` account to
 * seed against; the rest of accreditation.js (the existing-accreditation gate
 * via the real HAF pool) runs real, and `broadcastAdminCustomJson` is mocked so
 * the no-broadcast invariant is asserted deterministically. The /verify route is
 * unauthenticated, so no auth middleware is bypassed. The shared guard logic
 * itself (`hasUnliftedSanction` SQL) is covered against real Postgres in
 * `accreditation-membership-cte.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { PrivateKey } from '@hiveio/dhive';

const { broadcastJsonMock, hasUnliftedSanctionMock } = vi.hoisted(() => ({
  broadcastJsonMock: vi.fn().mockResolvedValue({ id: 'mock-accred-tx' }),
  hasUnliftedSanctionMock: vi.fn().mockResolvedValue(true),
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
    hasUnliftedSanction: hasUnliftedSanctionMock,
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

describe('POST /api/accreditation/verify — ever-sanctioned guard', () => {
  beforeEach(() => {
    broadcastJsonMock.mockReset().mockResolvedValue({ id: 'mock-accred-tx' });
    hasUnliftedSanctionMock.mockReset().mockResolvedValue(true);
  });

  it('refuses a sanctioned account with 403 ACCREDITATION_SANCTIONED and does not broadcast', async ({ skip }) => {
    const redis = getRedis();
    if (!redis || !isHafConfigured()) return skip(); // needs Redis + the HAF gate

    const username = `sanctioned-verify-${crypto.randomBytes(6).toString('hex')}`;
    const token = `sanctioned-verify-${crypto.randomBytes(8).toString('hex')}`;
    await seedPendingAccreditation(token, username);

    const res = await request(app).post('/api/accreditation/verify').send({ token });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCREDITATION_SANCTIONED');
    expect(res.body.error.message.toLowerCase()).not.toContain('sanction');
    expect(broadcastJsonMock).not.toHaveBeenCalled();

    // Cleanup
    await redis.del(`${config.appTag}:pending_accred:${token}`);
  });
});
