/**
 * runDigest cursor-consumption tests: wide-floor dedup + advance-to-highest-
 * delivered-block on every non-empty run.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: these canaries need to drive
 *       runDigest across two consecutive runs with a DETERMINISTIC notification
 *       batch (an edit-of-pre-cursor-content scenario, and a sustained >cap window
 *       that reports has_more=true), plus an observable cursor-advance and email
 *       payload. The public HAF corpus cannot be seeded with a published-then-
 *       edited paper at exact block numbers at test time. The mocked surfaces are
 *       all inside the carve-out's mock-target scope:
 *         - `fetchNotificationsFromHaf` returns the controlled batch (its real
 *           SQL dedup is pinned separately in notifications-arm-sql-shape.test.ts;
 *           here it stands in for the earliest-wins dedup result so the test can
 *           verify runDigest's in-app cursor + advance logic).
 *         - `getAppPool` feeds the digest-user rows and captures
 *           updateLastDigestBlock's (username, block) so the cursor advance is
 *           observable.
 *         - `getPool` (truthy stub) + `getGenesisBlock` → 0 (no genesis clamp).
 *         - `getLastBlock` → a fixed head so the wide window floor is deterministic.
 *         - `createSmtpTransporter` captures sendMail so the emailed events are
 *           observable (nodemailer is a third-party boundary).
 *   (b) No auth middleware is exercised by runDigest (it is a scheduled job, not
 *       an HTTP route), so the clause-(b) cryptographic-verification refinement
 *       does not apply here.
 *   (c) Real-path companion: the real wide-floor DISTINCT ON dedup SQL is pinned
 *       against the real query in notifications-arm-sql-shape.test.ts, and the
 *       shared computeNotificationWindowFloor/filterEventsAfter helpers run real
 *       in this test (only fetchNotificationsFromHaf's HAF round-trip is stubbed).
 *
 * Mutation kill: reverting runDigest to fetch against `last_digest_block` (the
 * narrow floor) fails the wide-floor assertion; re-introducing the
 * advance-only-on-`!has_more` gate fails the >cap-window advance assertion (that
 * gate caused the re-send cascade — fetchNotificationsFromHaf drops the cap
 * boundary block, so every delivered block is whole and the cursor must advance
 * to it on every non-empty run regardless of has_more).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { NotificationBatch, NotificationEvent } from '../src/notification-queries.js';

const HEAD = 1_000_000;
// computeNotificationWindowFloor(HEAD=1_000_000, genesis=0) = HEAD - 100_000.
const WIDE_FLOOR = HEAD - 100_000;

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(async (..._args: any[]): Promise<NotificationBatch | null> => null),
}));

vi.mock('../src/notification-queries.js', async () => {
  const actual = await vi.importActual<typeof import('../src/notification-queries.js')>('../src/notification-queries.js');
  return { ...actual, fetchNotificationsFromHaf: fetchMock };
});
vi.mock('../src/hafsql.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hafsql.js')>('../src/hafsql.js');
  return { ...actual, getGenesisBlock: async () => 0 };
});
vi.mock('../src/block-watcher.js', async () => {
  const actual = await vi.importActual<typeof import('../src/block-watcher.js')>('../src/block-watcher.js');
  return { ...actual, getLastBlock: () => HEAD };
});
vi.mock('../src/db.js', () => ({
  getPool: () => ({}),
  isHafConfigured: () => true,
  closeHafPool: async () => { /* no-op */ },
}));

// Digest-user rows and captured cursor advances.
let digestUsers: Array<{ username: string; email: string; digest_frequency: string; last_digest_block: number }> = [];
const updateCalls: Array<{ username: string; block: number }> = [];

vi.mock('../src/app-db.js', () => ({
  getAppPool: () => ({
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM notification_preferences') && sql.trimStart().startsWith('SELECT')) {
        const freq = params[0];
        return { rows: digestUsers.filter((u) => u.digest_frequency === freq) };
      }
      if (sql.includes('UPDATE notification_preferences')) {
        updateCalls.push({ username: params[0] as string, block: params[1] as number });
        return { rows: [] };
      }
      return { rows: [] };
    },
  }),
}));

// Capture emailed payloads via the SMTP transporter boundary.
const sentMails: Array<{ to: string; text: string }> = [];
vi.mock('../src/lib/smtp.js', () => ({
  createSmtpTransporter: () => ({
    sendMail: async (opts: { to: string; text: string }) => {
      sentMails.push({ to: opts.to, text: opts.text });
      return { messageId: 'test' };
    },
  }),
}));

const { runDigest } = await import('../src/digest.js');
const { config } = await import('../src/config.js');

function reviewEvent(block: number, title: string): NotificationEvent {
  return {
    type: 'new_review',
    block_num: block,
    timestamp: new Date(block * 1000).toISOString(),
    actor: 'reviewer.acct',
    paper_author: 'pevo.admin',
    paper_permlink: `paper-${block}`,
    paper_title: title,
    permlink: `review-${block}`,
  };
}

beforeAll(() => {
  // sendDigestEmail short-circuits when smtpHost is empty; set it so the path
  // reaches the (mocked) transporter and we can observe the emitted events.
  config.smtpHost = 'smtp.test';
});

beforeEach(() => {
  digestUsers = [];
  updateCalls.length = 0;
  sentMails.length = 0;
  fetchMock.mockReset();
});

describe('runDigest — wide-floor dedup + advance-to-highest-delivered-block', () => {
  it('fetches against the wide window floor, not the per-user last_digest_block', async () => {
    digestUsers = [{ username: 'alice', email: 'a@x.test', digest_frequency: 'daily', last_digest_block: 950_000 }];
    fetchMock.mockResolvedValue({ events: [reviewEvent(960_000, 'Paper P')], latest_block: 960_000, has_more: false });

    await runDigest('daily');

    // The dedup-re-fire fix hinges on the floor being the wide window floor so the
    // DISTINCT ON sees each event's publication row, not last_digest_block.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [account, floor, , direction] = fetchMock.mock.calls[0] as unknown as [string, number, number, string];
    expect(account).toBe('alice');
    expect(floor).toBe(WIDE_FLOOR);
    expect(floor).not.toBe(950_000);
    // The digest MUST fetch oldest-first ('asc') so it drains the window forward;
    // a silent flip to 'desc' would deliver newest-first and skip in-between
    // events for long-offline users with zero OTHER failing tests (the cap-edge
    // boundary-block drop + advance-to-highest-delivered logic both assume
    // oldest-first ordering).
    expect(direction).toBe('asc');
  });

  it('an edit of pre-cursor content does not re-fire a digest line in the next run', async () => {
    // Run N: paper published at 960_000 (after last_digest_block 950_000) → emailed,
    // cursor advances to 960_000.
    digestUsers = [{ username: 'alice', email: 'a@x.test', digest_frequency: 'daily', last_digest_block: 950_000 }];
    fetchMock.mockResolvedValue({ events: [reviewEvent(960_000, 'Paper P')], latest_block: 960_000, has_more: false });
    await runDigest('daily');
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].text).toContain('Paper P');
    expect(updateCalls).toEqual([{ username: 'alice', block: 960_000 }]);

    // Run N+1: the paper is edited at 970_000. The wide-floor DISTINCT ON collapses
    // the edit against the 960_000 publication row (earliest-wins), so the batch
    // still reports the canonical event at 960_000. The cursor (now 960_000) filters
    // it out — no duplicate digest line, no spurious advance.
    sentMails.length = 0;
    updateCalls.length = 0;
    digestUsers[0].last_digest_block = 960_000;
    fetchMock.mockResolvedValue({ events: [reviewEvent(960_000, 'Paper P')], latest_block: 960_000, has_more: false });
    await runDigest('daily');
    expect(sentMails).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('advances to the highest delivered block on a sustained >cap (has_more) batch, then drains the next slice exactly once', async () => {
    // Run 1: a sustained window holding more recipient-relevant events than the
    // fetch cap, so fetchNotificationsFromHaf reports has_more=true. Crucially it
    // has ALREADY dropped the cap-truncated boundary block, so every delivered
    // event sits in a WHOLE block — the digest emails them and advances to the
    // highest delivered block (920_000). Gating the advance on !has_more here was
    // the re-send cascade: the cursor would never move and this same oldest slice
    // would re-email every cadence while head-side events stayed buried.
    digestUsers = [{ username: 'bob', email: 'b@x.test', digest_frequency: 'daily', last_digest_block: 905_000 }];
    fetchMock.mockResolvedValue({
      events: [reviewEvent(910_000, 'Paper A'), reviewEvent(915_000, 'Paper B'), reviewEvent(920_000, 'Paper C')],
      latest_block: 920_000,
      has_more: true,
    });
    await runDigest('daily');
    expect(sentMails).toHaveLength(1);
    expect(updateCalls).toEqual([{ username: 'bob', block: 920_000 }]); // advance despite has_more

    // Run 2: the cursor (now 920_000) re-fetches the wide window. The DISTINCT ON
    // batch still includes the already-delivered prefix, but filterEventsAfter
    // strips everything at/below 920_000, so only the next slice (930_000) is
    // emailed and the cursor advances once more. No duplicate of the run-1 events.
    sentMails.length = 0;
    updateCalls.length = 0;
    digestUsers[0].last_digest_block = 920_000;
    fetchMock.mockResolvedValue({
      events: [
        reviewEvent(910_000, 'Paper A'),
        reviewEvent(915_000, 'Paper B'),
        reviewEvent(920_000, 'Paper C'),
        reviewEvent(930_000, 'Paper D next slice'),
      ],
      latest_block: 930_000,
      has_more: false,
    });
    await runDigest('daily');
    expect(updateCalls).toEqual([{ username: 'bob', block: 930_000 }]);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].text).toContain('Paper D next slice');
    expect(sentMails[0].text).not.toContain('Paper A'); // run-1 prefix not re-emailed
  });

  it('holds the cursor when the batch is empty (single-block-exceeds-cap deferral)', async () => {
    // The single-block-exceeds-cap case: fetchNotificationsFromHaf drops the lone
    // cap-truncated boundary block, returning an empty batch even though chain
    // events exist. The digest skips (nothing to email) and the cursor holds, so
    // the block surfaces in a later run once the window floor slides to contain it.
    // This is the graceful-deferral half of the partial-block-drop contract; it is
    // what makes advancing-on-every-non-empty-run safe (an undelivered overflow is
    // never in a "non-empty" batch).
    digestUsers = [{ username: 'dave', email: 'd@x.test', digest_frequency: 'daily', last_digest_block: 905_000 }];
    fetchMock.mockResolvedValue({ events: [], latest_block: 905_000, has_more: true });
    const result = await runDigest('daily');
    expect(sentMails).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('skips a user with no events past the cursor without advancing', async () => {
    digestUsers = [{ username: 'carol', email: 'c@x.test', digest_frequency: 'daily', last_digest_block: 960_000 }];
    // Batch holds only pre-cursor (already-delivered) events.
    fetchMock.mockResolvedValue({ events: [reviewEvent(955_000, 'Old Paper')], latest_block: 955_000, has_more: false });
    const result = await runDigest('daily');
    expect(sentMails).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });
});
