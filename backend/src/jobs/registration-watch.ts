import type pg from 'pg';
import { config } from '../config.js';
import { getAppPool } from '../app-db.js';
import { getPool, isHafConfigured } from '../db.js';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';
import { T } from '../hafsql.js';
import { queryWithStatementTimeout, HEAD_QUERY_TIMEOUT_MS } from '../reputation.js';

/**
 * Beta registration watch: posts new-researcher activity to a Discord webhook.
 *
 * Motivation: the institutional-email gate (`email-validator.ts`) can be widened
 * to open mail providers during a testing phase. Once it is, the operator has no
 * passive view of who is coming through the door, and open-provider addresses
 * carry an aliasing risk the gate itself cannot see (`a.l.ice+2@gmail.com` and
 * `alice@gmail.com` are one mailbox but two distinct `accounts.email` values).
 * This job is that view.
 *
 * Shape: a poller, NOT an inline hook on the signup routes. Two reasons.
 * (a) `routes/auth.ts` equalizes argon2 wall-time across the duplicate-email and
 * happy paths to close a registration-enumeration oracle; an outbound HTTP call
 * on that path is a timing signal and a failure mode inside a hardened flow.
 * (b) A poller re-reads durable state each tick, so a webhook outage or a
 * restart mid-flight loses nothing. PEvO is single-instance, so no leader
 * election is needed (same assumption as every other `setInterval` job here).
 *
 * Three event classes, two sources:
 *
 *   signup_started       app DB   a new `accounts` row appears (state E or F)
 *   registration_done    app DB   a row reaches a finalized state (A/B/C/D)
 *   accreditation_grant  HAF      an `accredit` custom_json lands on chain
 *
 * The first two are Postgres-observable because signup writes `accounts`. The
 * third is not: `POST /api/accreditation/verify` (the flow for users who already
 * have a Hive account) writes only Redis and the chain, never `accounts`. Chain
 * is the SSoT for accreditation, so that class reads from HAF and therefore also
 * covers admin-issued and non-signup grants for free.
 *
 * Because a light-account finalization ALSO broadcasts an `accredit` op, classes
 * two and three would double-report the same person. Class three suppresses any
 * username already announced, so the chain feed reports only the grants the app
 * DB could not see.
 *
 * State lives in Redis under `${appTag}:regwatch:`. Three cursors advance
 * monotonically; two sets absorb the cases a cursor cannot express (see
 * `collectCompleted`). Nothing is marked seen and no cursor advances until the
 * whole batch has been delivered, so a webhook outage replays the window rather
 * than silently dropping it. On a cold start (first deploy, or a flushed Redis)
 * the cursors are seeded to current head values and the tick announces nothing;
 * otherwise every historical account would replay into the channel at once.
 *
 * Logging discipline (memory `feedback_pevo_logging_minimal`): no per-tick
 * success logs. Only startup, a webhook/query failure, and the cold-start seed.
 */

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const WEBHOOK_TIMEOUT_MS = 8_000;
/** Discord caps a single webhook payload at 10 embeds. */
const MAX_EMBEDS_PER_MESSAGE = 10;
/** Per-class, per-tick announcement ceiling. A backlog drains over later ticks. */
const MAX_EVENTS_PER_TICK = 30;
/** Bound on the chain-side query, measured against the live HAF node. */
const ACCREDIT_QUERY_TIMEOUT_MS = 15_000;
/**
 * Widest block window the accredit query may scan in one tick (~7 days at 3s
 * blocks). The query cost scales with the window: a 200k-block scan measures
 * around 2s on the live node, while a multi-million-block one exceeds the
 * server-side statement timeout outright. Steady state advances ~40 blocks per
 * tick, so this only binds after extended downtime -- and there it converts a
 * query that would fail forever into one that skips the gap and resumes.
 */
const MAX_BLOCK_LOOKBACK = 200_000;

const COLOR_STARTED = 0x9aa0a6;    // grey - attempt, not yet a user
const COLOR_COMPLETED = 0x3fb950;  // green - real account exists
const COLOR_ACCREDITED = 0x58a6ff; // blue - chain-observed grant

let pollTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

// ── Redis state keys ───────────────────────────

function keys() {
  const p = `${config.appTag}:regwatch`;
  return {
    /** Max `accounts.id` announced as a started signup. */
    cursorSignupId: `${p}:cursor:signup_id`,
    /** Max `accounts.updated_at` (epoch ms) scanned for finalized rows. */
    cursorCompletedAt: `${p}:cursor:completed_at`,
    /** Max HAF `block_num` scanned for accredit ops. */
    cursorBlock: `${p}:cursor:block`,
    /** `accounts.id` values already announced as finalized. */
    seenAccounts: `${p}:seen:accounts`,
    /** Hive usernames already announced by any class. */
    seenUsers: `${p}:seen:users`,
  };
}

// ── Event model ────────────────────────────────

interface WatchEvent {
  title: string;
  fields: { name: string; value: string; inline?: boolean }[];
  color: number;
  timestamp?: string;
}

/** Trim a free-text profile field for embed display. */
function short(value: string | null | undefined, max = 80): string {
  const v = (value ?? '').trim();
  if (!v) return '-';
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/**
 * SQL expression folding `accounts.email` to its canonical mailbox.
 *
 * Gmail ignores dots and everything from `+` onward in the local part, so those
 * variants address one inbox while occupying distinct `accounts` rows. Folding
 * them is what turns "12 signups" into "12 signups, 9 mailboxes".
 *
 * Deliberately narrow: only the Gmail-family domains fold. Plus-addressing is
 * widespread but dot-folding is not, so applying it everywhere would merge
 * genuinely distinct users at other providers. Kept as SQL rather than mirrored
 * in TypeScript so there is exactly one definition of the fold; a JS copy used
 * for display and an SQL copy used for counting would drift apart silently.
 */
const CANONICAL_MAILBOX_SQL = `
  CASE
    WHEN split_part(lower(email), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(lower(email), '@', 1), '+', 1), '.', '') || '@gmail.com'
    ELSE lower(email)
  END`;

// ── Redis state helpers ────────────────────────

interface WatchState {
  signupId: number;
  completedAt: number;
  block: number;
  cold: boolean;
}

async function readState(redis: NonNullable<ReturnType<typeof getRedis>>): Promise<WatchState> {
  const k = keys();
  const [signupId, completedAt, block] = await redis.mget(
    k.cursorSignupId,
    k.cursorCompletedAt,
    k.cursorBlock,
  );
  // A missing signup cursor is the cold-start marker: it is written on every
  // tick (seed included), so its absence means this deployment has never run
  // or Redis was flushed. Either way, history must not replay.
  return {
    signupId: Number(signupId ?? 0),
    completedAt: Number(completedAt ?? 0),
    block: Number(block ?? 0),
    cold: signupId === null,
  };
}

// ── Source: app DB ─────────────────────────────

interface AccountRow {
  id: number;
  email: string | null;
  username: string | null;
  full_name: string;
  institution: string;
  field: string;
  orcid: string | null;
  custody: string | null;
  created_at: Date;
  updated_at: Date;
}

const ACCOUNT_COLUMNS =
  'id, email, username, full_name, institution, field, orcid, custody, created_at, updated_at';

/**
 * Canonical-mailbox sibling counts for a batch of account ids, in one query.
 * Returns `id -> { mailbox, siblings }` where `siblings` EXCLUDES the row
 * itself. The self-join runs over the whole table, so the count reflects every
 * historical account, not just the rows in this tick.
 */
async function mailboxSiblings(
  pool: pg.Pool,
  ids: number[],
): Promise<Map<number, { mailbox: string; siblings: number }>> {
  const out = new Map<number, { mailbox: string; siblings: number }>();
  if (ids.length === 0) return out;

  const { rows } = await pool.query<{ id: number; mailbox: string; siblings: string }>(
    `WITH canon AS (
       SELECT id, ${CANONICAL_MAILBOX_SQL} AS mailbox
         FROM accounts
        WHERE email IS NOT NULL
     )
     SELECT t.id, t.mailbox, count(o.id) AS siblings
       FROM canon t
       LEFT JOIN canon o ON o.mailbox = t.mailbox AND o.id <> t.id
      WHERE t.id = ANY($1::int[])
      GROUP BY t.id, t.mailbox`,
    [ids],
  );
  for (const r of rows) out.set(r.id, { mailbox: r.mailbox, siblings: Number(r.siblings) });
  return out;
}

async function collectSignupStarted(
  pool: pg.Pool,
  state: WatchState,
): Promise<{ events: WatchEvent[]; maxId: number }> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
      WHERE id > $1
      ORDER BY id ASC
      LIMIT $2`,
    [state.signupId, MAX_EVENTS_PER_TICK],
  );

  const siblings = await mailboxSiblings(
    pool,
    rows.filter((r) => r.email).map((r) => r.id),
  );

  const events: WatchEvent[] = [];
  let maxId = state.signupId;
  for (const row of rows) {
    maxId = Math.max(maxId, row.id);
    const fields = [
      { name: 'Email', value: short(row.email, 120), inline: false },
      { name: 'Name', value: short(row.full_name), inline: true },
      { name: 'Institution', value: short(row.institution), inline: true },
      { name: 'Field', value: short(row.field), inline: true },
      { name: 'Path', value: row.orcid ? 'ORCID' : 'Email + password', inline: true },
    ];
    const sib = siblings.get(row.id);
    if (sib && sib.siblings > 0) {
      // The aliasing signal the email gate cannot produce on its own.
      fields.push({
        name: '⚠ Same mailbox',
        value: `${sib.siblings} other account${sib.siblings === 1 ? '' : 's'} fold to \`${sib.mailbox}\``,
        inline: false,
      });
    }
    events.push({
      title: 'Signup started',
      fields,
      color: COLOR_STARTED,
      timestamp: row.created_at?.toISOString(),
    });
  }
  return { events, maxId };
}

/**
 * Finalized rows (states A/B/C/D per ARCHITECTURE.md section 6.1: `verify_token`
 * NULL and `username` set). The `updated_at` cursor cannot stand alone here --
 * that column is an overlay bumped by later password, ORCID, and custody writes
 * too, so a long-finalized account would re-announce on its next profile change.
 * The `seen:accounts` set is what makes the class report each account once.
 *
 * Membership is only READ here. Marking happens after delivery succeeds --
 * marking during collection would drop the batch permanently if the webhook
 * POST then failed.
 */
async function collectCompleted(
  pool: pg.Pool,
  redis: NonNullable<ReturnType<typeof getRedis>>,
  state: WatchState,
): Promise<{ events: WatchEvent[]; maxAt: number; announced: AccountRow[] }> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
      WHERE verify_token IS NULL
        AND username IS NOT NULL
        AND updated_at > to_timestamp($1::double precision / 1000)
      ORDER BY updated_at ASC
      LIMIT $2`,
    [state.completedAt, MAX_EVENTS_PER_TICK],
  );

  const k = keys();
  let maxAt = state.completedAt;
  for (const row of rows) maxAt = Math.max(maxAt, row.updated_at.getTime());
  if (rows.length === 0) return { events: [], maxAt, announced: [] };

  const pipeline = redis.pipeline();
  for (const row of rows) pipeline.sismember(k.seenAccounts, String(row.id));
  const results = await pipeline.exec();

  const events: WatchEvent[] = [];
  const announced: AccountRow[] = [];
  rows.forEach((row, i) => {
    // ioredis pipeline results are [err, value] pairs; a null exec (connection
    // lost mid-pipeline) is treated as "already seen" so nothing is announced
    // on an indeterminate read.
    const entry = results?.[i];
    if (!entry || entry[0] || entry[1] === 1) return;
    announced.push(row);
    events.push({
      title: 'Registration completed',
      fields: [
        { name: 'Hive account', value: `\`@${row.username}\``, inline: true },
        { name: 'Custody', value: short(row.custody), inline: true },
        { name: 'Email', value: short(row.email, 120), inline: false },
        { name: 'Name', value: short(row.full_name), inline: true },
        { name: 'Institution', value: short(row.institution), inline: true },
        { name: 'ORCID', value: row.orcid ? `\`${row.orcid}\`` : '-', inline: true },
      ],
      color: COLOR_COMPLETED,
      timestamp: row.updated_at.toISOString(),
    });
  });
  return { events, maxAt, announced };
}

// ── Source: HAF (chain) ────────────────────────

interface AccreditRow {
  account: string;
  researcher_name: string | null;
  institution: string | null;
  field: string | null;
  method: string | null;
  orcid: string | null;
  block_num: number;
  event_timestamp: string | null;
}

async function collectAccreditations(
  hafPool: pg.Pool,
  redis: NonNullable<ReturnType<typeof getRedis>>,
  state: WatchState,
  announcedThisTick: Set<string>,
): Promise<{ events: WatchEvent[]; maxBlock: number; announced: string[] }> {
  // Clamp the scan floor. Past MAX_BLOCK_LOOKBACK the query stops returning at
  // all, so a long outage would otherwise wedge this class permanently.
  const headBlock = await getHeadBlock(hafPool);
  const floor = headBlock > 0 ? Math.max(state.block, headBlock - MAX_BLOCK_LOOKBACK) : state.block;
  if (floor > state.block) {
    logger.warn(
      { from: state.block, to: floor, skipped: floor - state.block },
      'Registration watch: accredit scan window exceeded the lookback cap; skipping the gap',
    );
  }

  const { rows } = await queryWithStatementTimeout<AccreditRow>(
    hafPool,
    ACCREDIT_QUERY_TIMEOUT_MS,
    `SELECT
       cj.json::jsonb ->> 'account'      AS account,
       cj.json::jsonb ->> 'name'         AS researcher_name,
       cj.json::jsonb ->> 'institution'  AS institution,
       cj.json::jsonb ->> 'field'        AS field,
       cj.json::jsonb ->> 'method'       AS method,
       cj.json::jsonb ->> 'orcid'        AS orcid,
       cj.json::jsonb ->> 'timestamp'    AS event_timestamp,
       cj.block_num                      AS block_num
     FROM ${T.customJson} cj
     WHERE cj.custom_id = $1
       AND cj.json::jsonb ->> 'action' = 'accredit'
       AND cj.required_posting_auths ?| $2::text[]
       AND cj.block_num > $3
     ORDER BY cj.block_num ASC, cj.id ASC
     LIMIT $4`,
    [config.appTag, config.accreditationAuthorities, floor, MAX_EVENTS_PER_TICK],
  );

  const k = keys();
  let maxBlock = floor;
  for (const row of rows) maxBlock = Math.max(maxBlock, row.block_num);

  const candidates = rows.filter((r) => r.account && !announcedThisTick.has(r.account));
  if (candidates.length === 0) return { events: [], maxBlock, announced: [] };

  const pipeline = redis.pipeline();
  for (const row of candidates) pipeline.sismember(k.seenUsers, row.account);
  const results = await pipeline.exec();

  const events: WatchEvent[] = [];
  const announced: string[] = [];
  candidates.forEach((row, i) => {
    const entry = results?.[i];
    // Suppress the light-account path: those are announced as "Registration
    // completed" from the app DB, and their accredit op is the same event seen
    // from the other side.
    if (!entry || entry[0] || entry[1] === 1) return;
    announced.push(row.account);
    events.push({
      title: 'Accreditation granted',
      fields: [
        { name: 'Hive account', value: `\`@${row.account}\``, inline: true },
        { name: 'Method', value: short(row.method, 24), inline: true },
        { name: 'Block', value: String(row.block_num), inline: true },
        { name: 'Name', value: short(row.researcher_name), inline: true },
        { name: 'Institution', value: short(row.institution), inline: true },
        { name: 'ORCID', value: row.orcid ? `\`${row.orcid}\`` : '-', inline: true },
      ],
      color: COLOR_ACCREDITED,
      timestamp: row.event_timestamp ?? undefined,
    });
  });
  return { events, maxBlock, announced };
}

// ── Discord delivery ───────────────────────────

/**
 * POST one batch of embeds. Returns false on any non-2xx or transport failure so
 * the caller can hold the cursors and retry the same window next tick.
 */
async function postToDiscord(events: WatchEvent[]): Promise<boolean> {
  const url = config.discordRegistrationWebhookUrl;
  if (!url) return false;

  const embeds = events.map((e) => ({
    title: e.title,
    color: e.color,
    fields: e.fields,
    ...(e.timestamp ? { timestamp: e.timestamp } : {}),
  }));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'PEvO registrations', embeds }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, count: events.length },
        'Registration watch: Discord webhook rejected batch',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, count: events.length }, 'Registration watch: Discord webhook POST failed');
    return false;
  }
}

// ── Tick ───────────────────────────────────────

/**
 * Current chain head, read from the blocks table.
 *
 * NOT `MAX(block_num)` on the custom_json view: that form exceeds the HAF
 * server-side statement timeout (verified against the live node), which would
 * make every cold start fail. `haf_blocks` answers the same question in ~200ms.
 * Mirrors the head read in `reputation-batch.ts`.
 */
async function getHeadBlock(hafPool: pg.Pool): Promise<number> {
  const { rows } = await queryWithStatementTimeout<{ head: string | number | null }>(
    hafPool,
    HEAD_QUERY_TIMEOUT_MS,
    `SELECT MAX(block_num) AS head FROM ${T.blocks}`,
    [],
  );
  return Number(rows[0]?.head ?? 0);
}

/**
 * Seed cursors at current head and announce nothing. Without this, a first
 * deploy (or a flushed Redis) would replay every historical account at once.
 */
async function coldStart(pool: pg.Pool, hafPool: pg.Pool | null): Promise<void> {
  const k = keys();
  const redis = getRedis();
  if (!redis) return;

  const { rows: maxRows } = await pool.query<{ max_id: string | null }>(
    'SELECT MAX(id)::text AS max_id FROM accounts',
  );
  const maxId = Number(maxRows[0]?.max_id ?? 0);

  const headBlock = hafPool ? await getHeadBlock(hafPool) : 0;

  await redis.mset(
    k.cursorSignupId, String(maxId),
    k.cursorCompletedAt, String(Date.now()),
    k.cursorBlock, String(headBlock),
  );
  logger.info(
    { signup_id: maxId, block: headBlock },
    'Registration watch: cold start, cursors seeded (no backfill announced)',
  );
}

async function tick(): Promise<void> {
  // Overlap guard: a slow HAF query must not let a second tick double-post.
  if (ticking) return;
  const pool = getAppPool();
  const redis = getRedis();
  if (!pool || !redis) return;

  ticking = true;
  try {
    const k = keys();
    const state = await readState(redis);
    const hafPool = isHafConfigured() ? getPool() : null;

    if (state.cold) {
      await coldStart(pool, hafPool);
      return;
    }

    const started = await collectSignupStarted(pool, state);
    const completed = await collectCompleted(pool, redis, state);

    // Usernames finalized in THIS tick are not in `seen:users` yet (marking is
    // deferred to commit), so pass them explicitly or a light account whose
    // accredit op indexes within the same 2-minute window reports twice.
    const completedUsernames = new Set(
      completed.announced.map((r) => r.username).filter((u): u is string => Boolean(u)),
    );

    const accredited = hafPool
      ? await collectAccreditations(hafPool, redis, state, completedUsernames)
      : { events: [], maxBlock: state.block, announced: [] as string[] };

    const events = [...started.events, ...completed.events, ...accredited.events];

    for (let i = 0; i < events.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const batch = events.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
      // Commit nothing on failure: cursors stay put and no id is marked seen,
      // so the next tick retries the whole window. A batch that already posted
      // before a later one failed will repeat -- a duplicate message is the
      // acceptable side of this trade, a silently skipped registration is not.
      if (!(await postToDiscord(batch))) return;
    }

    // Commit: mark identities, then advance cursors. Reached only when every
    // batch delivered (or there was nothing to send).
    const commit = redis.pipeline();
    for (const row of completed.announced) {
      commit.sadd(k.seenAccounts, String(row.id));
      if (row.username) commit.sadd(k.seenUsers, row.username);
    }
    for (const username of accredited.announced) commit.sadd(k.seenUsers, username);
    commit.mset(
      k.cursorSignupId, String(started.maxId),
      k.cursorCompletedAt, String(completed.maxAt),
      k.cursorBlock, String(accredited.maxBlock),
    );
    await commit.exec();
  } catch (err) {
    // Keep the process alive: a DB blip or a HAF timeout must not take the
    // backend down, and the next tick re-reads the same durable window.
    logger.error({ err }, 'Registration watch tick failed');
  } finally {
    ticking = false;
  }
}

export function startRegistrationWatch(): void {
  if (!config.discordRegistrationWebhookUrl) return;
  void tick();
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
  logger.info('Registration watch started (Discord webhook, every 2m)');
}

export function stopRegistrationWatch(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const __test_seams = { tick, keys, CANONICAL_MAILBOX_SQL };
