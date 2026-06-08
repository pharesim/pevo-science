/**
 * Email notification digest — scheduled via setInterval, runs hourly.
 *
 * For each user with email_digest enabled, queries HAF for notification events
 * since their last digest block and sends an HTML digest email via Nodemailer.
 * Uses block-based deduplication: after sending, stores the latest block number
 * so the next run only picks up new events.
 */

import { createSmtpTransporter } from './lib/smtp.js';
import { LINE_TERMINATORS } from './lib/line-terminators.js';
import crypto from 'node:crypto';
import { getAppPool } from './app-db.js';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  fetchNotificationsFromHaf,
  computeNotificationWindowFloor,
  filterEventsAfter,
  NOTIFICATION_WINDOW_FETCH_CAP,
} from './notification-queries.js';
import { getGenesisBlock } from './hafsql.js';
import { getPool } from './db.js';
import { getLastBlock } from './block-watcher.js';
import type { NotificationEvent } from './notification-queries.js';

// ── Types ───────────────────────────────────────

interface DigestUser {
  username: string;
  email: string;
  digest_frequency: string;
  last_digest_block: number;
}

// ── Helpers ─────────────────────────────────────

function generateUnsubscribeToken(username: string): string {
  const secret = config.unsubscribeSecret || config.sessionSecret;
  return crypto.createHmac('sha256', secret).update(`unsubscribe:${username}`).digest('hex');
}

export function verifyUnsubscribeToken(username: string, token: string): boolean {
  const expected = generateUnsubscribeToken(username);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

// ── Event descriptions ──────────────────────────

/**
 * Flatten a chain-derived free-form string to a single line for safe
 * interpolation into the plain-text email body. The first pass strips every
 * member of the shared `LINE_TERMINATORS` alphabet (CR, LF, VT, FF, FS, GS, RS,
 * NEL, LS, PS); the second pass collapses remaining whitespace runs.
 *
 * Why the explicit first pass when a `\s+` collapse pass follows: NEL (U+0085)
 * and the C0 information separators FS/GS/RS (U+001C-U+001E) are NOT `\s`
 * members in V8 (verified empirically), so without the first pass they would
 * survive the collapse and forge a line break in clients (or `splitlines()`-class
 * importers) that render them. VT, FF, LS, and PS ARE `\s` members and would
 * already be collapsed by the second pass — the first pass does not earn its
 * keep on those four. What the
 * SHARED constant buys is single-source-of-truth against separator-alphabet
 * drift: the citation-export escapers in `routes/papers.ts` consume the same
 * `lib/line-terminators.js` constant, so the digest and cite-export paths
 * cannot diverge to different separator alphabets. Flattening these forged line
 * breaks stops an attacker-controlled paper title from forging digest lines or
 * injecting a header-spoofing line that starts at column 0. Apply to any
 * free-form chain field; Hive usernames and internal enums are constrained and
 * do not need it.
 */
export function singleLine(s: string | null | undefined): string {
  return (s ?? '').replace(LINE_TERMINATORS, ' ').replace(/\s+/g, ' ').trim();
}

export function describeEvent(event: NotificationEvent): string {
  switch (event.type) {
    case 'new_review':
      return `${event.actor} reviewed your paper "${singleLine(event.paper_title)}"`;
    case 'new_vote':
      return event.weight < 0
        ? `${event.actor} raised concerns about your ${event.target_type}`
        : `${event.actor} endorsed your ${event.target_type}`;
    case 'new_vouch':
      return `${event.actor} vouched for you`;
    case 'new_reply':
      return `${event.actor} replied to your comment`;
    case 'accreditation_update':
      return event.action === 'accredit'
        ? 'Your accreditation has been approved'
        : 'Your accreditation has been revoked';
    case 'new_citation':
      return `${event.actor} cited your paper "${singleLine(event.paper_title)}"`;
    case 'claim_pending':
      return `${event.actor} claimed authorship on your paper`;
    case 'claim_approved':
      return 'Your authorship claim was approved';
    case 'claim_revoked':
      return 'Your authorship claim was revoked';
    default:
      return 'New activity on your account';
  }
}

// ── Database queries ────────────────────────────

async function getDigestUsers(frequency: 'daily' | 'weekly'): Promise<DigestUser[]> {
  const pool = getAppPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT username, email, digest_frequency, last_digest_block
     FROM notification_preferences
     WHERE email_digest = true AND email IS NOT NULL AND digest_frequency = $1
       AND last_digest_block > 0`,
    [frequency],
  );
  return result.rows.map((r) => ({
    ...r,
    last_digest_block: Number(r.last_digest_block),
  }));
}

async function updateLastDigestBlock(username: string, blockNum: number): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;

  await pool.query(
    `UPDATE notification_preferences SET last_digest_block = $2, updated_at = now() WHERE username = $1`,
    [username, blockNum],
  );
}

// ── Email sending ───────────────────────────────

async function sendDigestEmail(user: DigestUser, events: NotificationEvent[]): Promise<void> {
  if (!config.smtpHost) {
    logger.warn({ username: user.username }, 'SMTP not configured — skipping digest email');
    return;
  }

  const transporter = createSmtpTransporter();

  const frequency = user.digest_frequency === 'daily' ? 'Daily' : 'Weekly';
  const unsubToken = generateUnsubscribeToken(user.username);
  const unsubUrl = `${config.appUrl}/api/profile/${encodeURIComponent(user.username)}/notification-preferences/unsubscribe?token=${unsubToken}`;
  const profileUrl = `${config.appUrl}/profile/${encodeURIComponent(user.username)}`;

  const body = [
    `${frequency} Activity Digest for ${user.username}`,
    '',
    'Here is what happened since your last digest:',
    '',
    ...events.map((e) => `- ${describeEvent(e)}`),
    '',
    `View your profile: ${profileUrl}`,
    '',
    '---',
    `Unsubscribe: ${unsubUrl}`,
    '',
    'PEvO - Open Scientific Publishing',
    'https://pevo.science',
  ].join('\n');

  await transporter.sendMail({
    from: config.smtpFrom,
    to: user.email,
    subject: `PEvO - ${frequency} activity digest`,
    text: body,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

// ── Core digest logic ───────────────────────────

export async function runDigest(frequency: 'daily' | 'weekly'): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;

  const users = await getDigestUsers(frequency);

  // Clamp to namespace genesis — no PEvO data exists before the first accreditation
  const pool = getPool();
  const genesis = pool ? await getGenesisBlock(pool) : 0;

  // Consume the batch the same way the SPA route does: fetch against the wide
  // window floor (so the per-arm DISTINCT ON dedup runs across a window that
  // includes each event's publication row — an edit or revote of pre-cursor
  // content collapses against its publication instead of re-firing as a fresh
  // digest line), then apply the per-user cursor in-app. Computing the batch
  // against `last_digest_block` (the old behavior) deduplicated only above the
  // cursor, so an edit landing after the last digest had no publication row to
  // lose against and re-fired every cycle.
  const windowFloor = computeNotificationWindowFloor(getLastBlock(), genesis);

  for (const user of users) {
    try {
      // In-app cursor, genesis-clamped (no PEvO data exists before genesis).
      const cursor = genesis > 0 && user.last_digest_block < genesis
        ? genesis - 1
        : user.last_digest_block;
      const batch = await fetchNotificationsFromHaf(user.username, windowFloor, NOTIFICATION_WINDOW_FETCH_CAP);

      if (!batch) {
        skipped++;
        continue;
      }

      const newEvents = filterEventsAfter(batch.events, cursor);
      if (newEvents.length === 0) {
        skipped++;
        continue;
      }

      await sendDigestEmail(user, newEvents);

      // Advance the stored cursor ONLY when the window fully drained
      // (`has_more === false`). A truncated batch (`has_more === true`) means
      // recipient-relevant events beyond the fetch cap are still undelivered —
      // including a single block whose events overflowed the cap. Advancing past
      // them would skip them permanently (the original boundary-drop bug);
      // leaving the cursor lets the next digest re-fetch and drain further, so
      // the overflow appears in a later digest rather than being lost. Advance to
      // the highest delivered block (ascending order → last element).
      if (!batch.has_more) {
        await updateLastDigestBlock(user.username, newEvents[newEvents.length - 1].block_num);
      }
      sent++;
    } catch (err) {
      logger.error({ err, username: user.username }, 'Failed to process digest for user');
      skipped++;
    }
  }

  logger.info({ frequency, sent, skipped }, 'Digest run complete');
  return { sent, skipped };
}

// ── Scheduler ───────────────────────────────────

const DIGEST_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let digestTimer: ReturnType<typeof setInterval> | null = null;
let lastDailyRunDate = '';

async function digestTick(): Promise<void> {
  try {
    const now = new Date();
    const hour = now.getUTCHours();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Run at 07:00 UTC, once per day
    if (hour === 7 && lastDailyRunDate !== todayStr) {
      lastDailyRunDate = todayStr;

      await runDigest('daily');

      // Weekly digests on Monday only
      if (now.getUTCDay() === 1) {
        await runDigest('weekly');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Digest scheduler tick failed');
  }
}

export function startDigestScheduler(): void {
  if (digestTimer) return;
  digestTimer = setInterval(digestTick, DIGEST_CHECK_INTERVAL_MS);
  digestTimer.unref();
  logger.info('Digest scheduler started (hourly check, sends at 07:00 UTC)');
}

export function stopDigestScheduler(): void {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}
