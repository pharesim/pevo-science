/**
 * Session invalidation closes open session-proof windows.
 *
 * `accounts.sessions_invalidated_at` (`agents/docs/ARCHITECTURE.md` § 6.7) is
 * the bearer-JWT revocation mechanism: a credential rotation stamps it, and
 * `verifyHiveSignature` then rejects every token minted at or before that
 * second. On its own that is not enough once a session-kind
 * fresh-auth proof is windowed (§ 6.4.1): the proof is target-less and
 * multi-use for up to its absolute cap, so revoking tokens while leaving a live
 * window standing has not actually cut off the compromised session. Every
 * writer of `sessions_invalidated_at` must also call
 * `invalidateSessionFreshAuthTokens`.
 *
 * There are four such writers. This suite drives three of them end to end
 * through their real routes:
 *   - `POST /api/auth/reset` — the emailed password-reset token.
 *   - `POST /api/auth/recover` — the ORCID branch, which reissues a JWT.
 *   - `POST /api/auth/recover/verify` — phase 2 of memo-key recovery, which
 *     applies the staged swap inside a transaction and then reissues a JWT.
 * The fourth, `POST /api/custody/upgrade`, needs the mocked-chain fixtures its
 * own suite owns, so its end-to-end leg lives in `custody-upgrade.test.ts`;
 * the whole-tree scans below still cover it like any other toucher.
 *
 * "The window is closed" is asserted by consuming the proof through the real
 * `consumeSessionFreshAuthToken` against the real store the broadcast route
 * reads. It is deliberately NOT the same call that route makes: the route also
 * hands the consume the account's revocation epoch from
 * `req.hiveSessionsInvalidatedAt`, and the helpers here pass `undefined`
 * instead. Withholding the epoch is what scopes these assertions to the SWEEP
 * and nothing else. With the epoch supplied, every window below would be
 * rejected by the cut-off whether or not the sweep ran, so a writer that
 * stamped the column and skipped the sweep would sail through the very suite
 * written to catch it. The cut-off has its own end-to-end coverage through
 * `POST /api/custody/broadcast` and `POST /api/ipfs/upload-token`. A
 * blast-radius test pins the other direction: an unrelated account's window
 * must survive.
 *
 * These three routes must also not OPEN a window while closing one. The two
 * recovery phases reissue a JWT, which makes them session-establishment
 * surfaces in the sense of § 6.5 invariant #9; the reset reissues nothing and
 * must not open a window either. The real recovery fixtures live here (a seeded
 * `reset_token`, a seeded ORCID receipt, an inserted `pending_recovery` row),
 * so the wire-level no-proof assertion rides along rather than a second suite
 * rebuilding them.
 *
 * The static half of the guarantee lives in the last describe block: any future
 * TOUCH of `sessions_invalidated_at` in executable source anywhere under
 * `src/`, matched on the bare column name so no SQL spelling of the write can
 * slip past, must also sweep the proofs from the same function, and the sweep
 * must be a live call: not one commented out whole-line or inside a block
 * toggle, not one surviving only in a trailing comment on a live line, and not
 * the sweep's own definition vouching for its own body. The middleware's read
 * is exempted by exact line, not by pattern and not by enclosing symbol: under-
 * matching a write is fail-open, so the scan over-matches on purpose and spares
 * three named lines explicitly, which leaves a write added beside them still
 * visible. A wiring omission is the realistic failure here, not a bug inside the
 * helper (which `tests/lib/fresh-auth.test.ts` covers directly), and an omission
 * in a handler written months from now is exactly what an end-to-end test of
 * today's three routes cannot catch.
 *
 * What that scan cannot see, so it is not over-trusted: pairing is by enclosing
 * symbol, not by control flow, so a write on an early-return branch of a handler
 * that sweeps further down still pairs; and a write that never spells the column
 * in a `.ts` file is outside it entirely.
 *
 * Note what the sweep is and is not. It reclaims storage; it is NOT the
 * authoritative close. That is the revocation-epoch check inside the session
 * consume, which rejects any window minted at or before
 * `sessions_invalidated_at` straight from Postgres. The wiring canary still
 * matters — a writer that skips the sweep leaves dead windows occupying Redis
 * until their cap, and the sweep is what makes the end-to-end assertions below
 * hold for a caller that never re-presents the proof through the middleware.
 *
 * Mocks (per root CLAUDE.md "Carve-out for deterministic edge-case coverage"):
 *   (a) None. Postgres, Redis, argon2, the fresh-auth store, and all three
 *       routes run for real. The two token-bearing flows are set up by writing
 *       the row the mailed link would have produced — a `reset_token` on the
 *       account and a `pending_recovery` staging row — rather than by mocking
 *       the SMTP transporter to read the link back out, so no third-party
 *       surface is stubbed at all. The ORCID branch consumes a verification
 *       receipt seeded directly into the same store the OAuth callback writes.
 *   (b) No auth middleware is involved: all three routes are unauthenticated,
 *       because the recovery or reset factor IS the authentication.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import path from 'node:path';
import {
  isCommentLine,
  isCommentedOut,
  isModuleScopeKey,
  occurrencesOf,
  sourcesUnder,
  type ScannedSource,
} from '../support/enclosing-symbol.js';
import { expectNoSessionProof } from '../support/session-proof-shape.js';

const { createApp } = await import('../../src/app.js');
const { getAppPool } = await import('../../src/app-db.js');
const { config } = await import('../../src/config.js');
const { getRedis, isRedisAvailable } = await import('../../src/redis.js');
const { orcidVerified } = await import('../../src/routes/orcid.js');
const { consumeSessionFreshAuthToken, issueSessionFreshAuthToken } = await import(
  '../../src/lib/fresh-auth.js'
);
const { clearRateLimitKeys } = await import('../support/redis-helpers.js');

const app = createApp();

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

const RUN = Date.now();
const USER = `sesinval_${RUN}`;
const BYSTANDER = `sesinval_by_${RUN}`;
const EMAIL = `sesinval_${RUN}@example.com`;
const BYSTANDER_EMAIL = `sesinval_by_${RUN}@example.com`;
const PASSWORD = 'OriginalPass1';
const ORCID_ID = '0000-0002-4444-5555';

async function seedAccounts() {
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, verify_token, orcid)
     VALUES ($1, $2, $3, 'light', NULL, $4)`,
    [EMAIL, USER, passwordHash, ORCID_ID],
  );
  await pool.query(
    `INSERT INTO accounts (email, username, password_hash, custody, verify_token)
     VALUES ($1, $2, $3, 'light', NULL)`,
    [BYSTANDER_EMAIL, BYSTANDER, passwordHash],
  );
}

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM pending_recovery WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
  await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
  await pool.query('DELETE FROM accounts WHERE username LIKE $1', ['sesinval_%']).catch(() => {});
}

/** Restore the seeded baseline so each test starts from the same account state
 *  regardless of which swap the previous one applied. */
async function resetAccountState() {
  const pool = getAppPool()!;
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `UPDATE accounts
     SET email = $1, password_hash = $2, orcid = $3,
         sessions_invalidated_at = NULL, upgraded_at = NULL,
         reset_token = NULL, reset_token_expires_at = NULL
     WHERE username = $4`,
    [EMAIL, passwordHash, ORCID_ID, USER],
  );
  await pool.query('DELETE FROM pending_recovery WHERE username = $1', [USER]).catch(() => {});
}

/** Write the ORCID verification receipt the OAuth callback would have left, so
 *  the recover route's ORCID branch can consume it without a live provider. */
async function seedOrcidReceipt(nonce: string): Promise<void> {
  const payload = { orcid_id: ORCID_ID, works_count: 5, name: 'Test' };
  const redis = getRedis();
  if (redis && isRedisAvailable()) {
    await redis.set(`${config.appTag}:orcid_verified:${nonce}`, JSON.stringify(payload), 'EX', 600);
  }
  orcidVerified.set(nonce, { ...payload, expires: Date.now() + 600_000 });
}

/** Assert a proof no longer consumes, with NO revocation epoch supplied.
 *  `undefined` is passed on purpose: it disables the epoch cut-off, so the only
 *  thing that can close the window here is the sweep the route under test was
 *  supposed to call. Handing the real epoch in would make this pass for a writer
 *  that stamped `sessions_invalidated_at` and never swept, which is the exact
 *  omission this suite exists to catch. `undefined` rather than `null`: `null`
 *  is the store's encoding of "this account has never had its sessions
 *  revoked", which is false at these call sites. */
async function expectWindowClosed(token: string, username: string): Promise<void> {
  const result = await consumeSessionFreshAuthToken(token, username, undefined);
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.reason).toBe('expired');
  }
}

/** Assert a proof still consumes, under the same no-epoch posture as
 *  {@link expectWindowClosed}. Serves as the pre-condition each route test rests
 *  on (the window really was open before the route ran) and, for the unrelated
 *  account, as the blast-radius assertion itself. */
async function expectWindowOpen(token: string, username: string): Promise<void> {
  expect((await consumeSessionFreshAuthToken(token, username, undefined)).valid).toBe(true);
}

beforeAll(async () => {
  await cleanup();
  if (!dbReachable) return;
  await seedAccounts();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await clearRateLimitKeys(['auth-reset', 'auth-recover', 'auth-login']);
  await resetAccountState();
});

describe('session invalidation closes outstanding session-proof windows', () => {
  it.skipIf(!dbReachable)('POST /api/auth/reset closes the window', async () => {
    const pool = getAppPool()!;
    const resetToken = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE accounts
       SET reset_token = $1, reset_token_expires_at = NOW() + INTERVAL '1 hour'
       WHERE username = $2`,
      [resetToken, USER],
    );

    const issued = await issueSessionFreshAuthToken(USER, 'password');
    await expectWindowOpen(issued.token, USER);

    const res = await request(app)
      .post('/api/auth/reset')
      .send({ token: resetToken, password: 'BrandNewPass1' });
    expect(res.status).toBe(200);
    expectNoSessionProof(res, 'password-reset response');

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('POST /api/auth/recover (ORCID branch) closes the window', async () => {
    const nonce = `sesinval-orcid-${Date.now()}`;
    await seedOrcidReceipt(nonce);

    const issued = await issueSessionFreshAuthToken(USER, 'orcid');
    await expectWindowOpen(issued.token, USER);

    const res = await request(app)
      .post('/api/auth/recover')
      .send({
        username: USER,
        new_email: `sesinval_orcid_new_${Date.now()}@example.com`,
        new_password: 'RecoveredPass1',
        orcid_token: nonce,
      });
    expect(res.status).toBe(200);
    // The route reissues a JWT. The window must already be gone by the time the
    // caller holds that token, or the reissue hands back a session with a
    // pre-existing broadcast window still attached to it.
    expect(res.body.data.token).toBeDefined();
    expectNoSessionProof(res, 'orcid-recovery response');

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('POST /api/auth/recover/verify closes the window', async () => {
    const pool = getAppPool()!;
    const verifyToken = crypto.randomBytes(24).toString('hex');
    const verifyHash = crypto.createHash('sha256').update(verifyToken).digest();
    const disputeHash = crypto.createHash('sha256').update('unused-dispute-token').digest();
    const newPasswordHash = await argon2.hash('VerifiedPass1', { type: argon2.argon2id });
    await pool.query(
      `INSERT INTO pending_recovery
         (username, new_email, new_password_hash, verify_token_hash, verify_expires_at,
          dispute_token_hash, dispute_expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', $5, NOW() + INTERVAL '48 hours')`,
      [USER, `sesinval_verify_new_${Date.now()}@example.com`, newPasswordHash, verifyHash, disputeHash],
    );

    const issued = await issueSessionFreshAuthToken(USER, 'password');
    await expectWindowOpen(issued.token, USER);

    const res = await request(app)
      .post('/api/auth/recover/verify')
      .send({ token: verifyToken });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    expectNoSessionProof(res, 'recovery-verify response');

    await expectWindowClosed(issued.token, USER);
  });

  it.skipIf(!dbReachable)('an unrelated account keeps its window', async () => {
    // Blast-radius pin. A sweep that cleared the whole store, or keyed on
    // anything other than the username, would log out every light account
    // whenever one of them reset a password.
    const pool = getAppPool()!;
    const resetToken = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE accounts
       SET reset_token = $1, reset_token_expires_at = NOW() + INTERVAL '1 hour'
       WHERE username = $2`,
      [resetToken, USER],
    );

    const bystanderProof = await issueSessionFreshAuthToken(BYSTANDER, 'password');
    const targetProof = await issueSessionFreshAuthToken(USER, 'password');

    const res = await request(app)
      .post('/api/auth/reset')
      .send({ token: resetToken, password: 'AnotherNewPass1' });
    expect(res.status).toBe(200);

    await expectWindowClosed(targetProof.token, USER);
    await expectWindowOpen(bystanderProof.token, BYSTANDER);
  });
});

describe('every toucher of the revocation column also closes session-proof windows', () => {
  // Standing wiring canary. Four routes write the column today (the password
  // reset, both recovery phases, and the custody upgrade); the failure this
  // guards against is a fifth one added later that stamps
  // `sessions_invalidated_at` and stops there, leaving a live broadcast window
  // attached to a session the operator believes they cut off. That omission is
  // invisible to every test in this file, because those tests name their routes.
  //
  // Three granularity properties this scan needs, each of which a narrower
  // version silently lacked:
  //
  //   - It walks ALL of `src/` recursively, not a flat listing of `src/routes`.
  //     A writer added under `src/lib`, or in any subdirectory, was previously
  //     not scanned at all.
  //   - It pairs each TOUCH with a sweep in the SAME enclosing symbol. Testing
  //     "this file contains a write" against "this file contains a sweep" means
  //     a second, unswept writer added to `recover.ts` — which already sweeps
  //     from two other handlers — passes untouched.
  //   - It matches the bare column name and requires the sweep to be a LIVE
  //     call. Both directions of under-matching are fail-open: a write spelled
  //     in a way the pattern misses never has to pair with anything, and a
  //     sweep read out of a commented-out line pairs with a write that has no
  //     live sweep behind it at all.

  /** Any mention of the revocation column in executable source. Deliberately
   *  the BARE column name rather than `column = value`: the `=` form matched
   *  only two of this write's spellings, and an unmatched write is FAIL-OPEN,
   *  since it never enters the occurrence set and is therefore never required
   *  to pair with a sweep. A quoted identifier, a multi-column
   *  `SET (a, b) = (...)`, an INSERT naming the column in its column list, a
   *  query-builder object literal, and a template-literal UPDATE that wraps the
   *  line before the `=` all write the column and all evaded it. Over-matching
   *  is the safe direction: a false positive is a red bar naming a symbol, a
   *  false negative is a revocation that silently leaves a broadcast window
   *  open. */
  const REVOCATION_COLUMN_RE = /\bsessions_invalidated_at\b/;

  /** A CALL to the sweep. Commented-out lines are filtered out of THIS scan
   *  because over-matching here is fail-open: a sweep the scan reads out of
   *  prose, or out of a call commented out during debugging and never restored,
   *  pairs with a live write in the same handler and the canary goes silent for
   *  the omission it exists to catch. Over-matching a column TOUCH has no
   *  equivalent danger, since a touch read out of prose can only demand a sweep
   *  that had to be there anyway. */
  const SWEEP_CALL_RE = /invalidateSessionFreshAuthTokens\s*\(/;

  /** The sweep's own definition line. Without this skip the definition
   *  satisfies pairings for the symbol it names: a revocation-column write
   *  added inside the sweep function's body would pair with the function's own
   *  signature and never be asked for a live sweep call. Every sibling
   *  occurrence scan skips its subject's definition by shape; this one now
   *  does too. */
  const SWEEP_DEFINITION_RE = /function\s+invalidateSessionFreshAuthTokens\s*\(/;

  /** Line text with trailing comment content removed, for the sweep side only.
   *  `isCommentedOut` spares whole-line and block-toggled comments, but a dead
   *  call in a TRAILING comment rides a live line (`markDone(); // await
   *  invalidateSessionFreshAuthTokens(u)`) and satisfied a live write's
   *  pairing. The mint canary deliberately does NOT strip trailing comments —
   *  there an over-match goes red, which is loud — but that reasoning inverts
   *  on a REQUIRED-call scan, where an over-match is exactly what makes the
   *  pairing pass. The strip is naive about comment markers inside string
   *  literals (`'http://x'` truncates the line); on this scan that
   *  direction is fail-closed — a real sweep sharing a line with such a
   *  string goes unread and the bar turns red, naming the line — so the
   *  naivety is accepted and the fix is to put the call on its own line. */
  const stripTrailingComment = (line: string): string =>
    line
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*$/, ' ');

  /** Whitespace-normalized line text, so the read exemption below survives a
   *  reindent or a rewrapped call without surviving an edit to the statement. */
  const normalize = (line: string): string => line.trim().replace(/\s+/g, ' ');

  /** The lines that touch the column without writing it: the middleware's JWT
   *  branch types the row shape, SELECTs the column, and reads the field off the
   *  row. Reading a revocation epoch revokes nothing, so these are spared.
   *
   *  Exempted by LINE, not by enclosing symbol. A symbol-wide exemption would
   *  cover any write later added inside that same function, and the obvious
   *  guard against that — asserting the symbol never matches `column =` — is the
   *  same under-matching form this scan just abandoned: it sees neither a quoted
   *  identifier, nor `SET (a, b) = (...)`, nor an INSERT column list, nor a
   *  wrapped `=`. Per-line, any new column line inside the middleware is a new
   *  occurrence that must pair with a sweep, in every spelling. Kept honest by
   *  the staleness test below. */
  const READ_ONLY_LINES = [
    'const { rows } = await pool.query<{ sessions_invalidated_at: Date | null }>(',
    "'SELECT sessions_invalidated_at FROM accounts WHERE username = $1',",
    'const invalidatedAt = rows.length > 0 ? rows[0].sessions_invalidated_at : null;',
  ];

  /** Prose cannot write a column, and the broadened signal matches every
   *  docblock mention of the name across the module, the middleware, and two
   *  route files. Without this skip each mention becomes an occurrence that must
   *  pair with a sweep in its own enclosing symbol, and the suite goes red on
   *  documentation alone. The shape-only predicate is the right one here: on a
   *  scan where a match DEMANDS something, an over-match is safe and a skip is
   *  not. An inline trailing comment on a code line is deliberately not
   *  stripped, because a comment marker also occurs inside string literals and
   *  truncating there would drop a real write sharing the line. */
  const skipColumnLine = (line: string): boolean =>
    isCommentLine(line) || READ_ONLY_LINES.includes(normalize(line));

  const sources = sourcesUnder(path.resolve(__dirname, '..', '..', 'src'));

  /** The pairing every assertion below rests on, built once so the synthetic
   *  probes exercise the same call the whole-tree scan does. A probe that
   *  rebuilt the scan with its own arguments would stay green when the real scan
   *  lost its comment filter, which is the regression the probes exist to catch
   *  and which the real tree cannot show, since no writer is commented out
   *  today. */
  const unsweptWriters = (files: ScannedSource[]) => {
    const touches = occurrencesOf(files, REVOCATION_COLUMN_RE, skipColumnLine);
    // Three filters on the satisfying side, each closing a way a dead or
    // self-referential mention could vouch for a live write: commented-out
    // lines, the sweep's own definition, and a call that survives only inside
    // a trailing comment. Module-scope keys are dropped as well — a pairing
    // must never let the label every unresolvable declaration shares satisfy
    // itself (see tests/support/enclosing-symbol.ts).
    const sweeps = new Set(
      occurrencesOf(
        files,
        SWEEP_CALL_RE,
        (line, i, lines) =>
          isCommentedOut(line, i, lines) ||
          SWEEP_DEFINITION_RE.test(line) ||
          !SWEEP_CALL_RE.test(stripTrailingComment(line)),
      ).keys.filter((key) => !isModuleScopeKey(key)),
    );
    return { touches, sweeps, offenders: touches.keys.filter((key) => !sweeps.has(key)) };
  };

  it('the scan reaches the whole source tree, not just the top of src/routes', () => {
    // Without this, a bad path or a non-recursive walk would make the assertion
    // below vacuously true for everything it failed to visit.
    expect(sources.length).toBeGreaterThan(20);
    const rels = sources.map((s) => s.rel);
    expect(rels).toContain('routes/auth.ts');
    expect(rels).toContain('routes/recover.ts');
    // A file in a subdirectory, proving the walk descends.
    expect(rels).toContain('lib/fresh-auth.ts');
  });

  it('no toucher of the revocation column skips the proof sweep', () => {
    const { touches, offenders } = unsweptWriters(sources);
    // Non-vacuity by name rather than by count: a pattern edit that stops
    // matching one of today's writers fails here first, instead of quietly
    // shrinking the set the offender filter runs over. `arrayContaining` so a
    // legitimate new writer that does sweep is not a mandatory list update.
    expect(touches.keys, `revocation-column sites:\n${touches.sites.join('\n')}`).toEqual(
      expect.arrayContaining([
        'routes/auth.ts#POST /reset',
        'routes/custody.ts#POST /upgrade',
        'routes/recover.ts#POST /recover',
        'routes/recover.ts#POST /recover/verify',
      ]),
    );
    expect(
      offenders,
      'these functions touch sessions_invalidated_at but never call ' +
        'invalidateSessionFreshAuthTokens, so they revoke bearer tokens while ' +
        'leaving an open broadcast window attached to the session they claim to ' +
        'have cut off. If one of these only READS the column, add its exact ' +
        `line to READ_ONLY_LINES:\n${offenders.join('\n')}\n\n` +
        `all sites:\n${touches.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('every credential-rotating route stamps the revocation epoch', () => {
    // The INVERSE direction of the pairing above, which on its own is
    // one-directional: it requires every writer of the epoch to sweep, and
    // never requires a route that rotates credentials to write the epoch in
    // the first place. A rotation that skips the stamp is invisible to it —
    // the exact shape the custody upgrade sat in until it was noticed, with
    // every outstanding window and bearer JWT surviving a change of the
    // account's whole authentication posture.
    //
    // The set is pinned by name because "rotates credentials" has no greppable
    // signal: a `password_hash` write is also how signup creates an account
    // (no sessions exist yet to revoke), a custody flip is also how signup
    // finalization lands, and enumerating those exemptions would just re-state
    // this list as its inverse. The names are the routes whose semantics
    // replace an EXISTING account's authentication material: the password
    // reset, both recovery phases, and the custody upgrade. A new
    // credential-rotating route belongs in this list, and its handler must
    // stamp the column — the pairing above then forces the sweep too, so one
    // membership buys both halves of invalidation.
    const CREDENTIAL_ROTATING_SITES = [
      'routes/auth.ts#POST /reset',
      'routes/custody.ts#POST /upgrade',
      'routes/recover.ts#POST /recover',
      'routes/recover.ts#POST /recover/verify',
    ];
    const { touches } = unsweptWriters(sources);
    const missing = CREDENTIAL_ROTATING_SITES.filter((site) => !touches.keys.includes(site));
    expect(
      missing,
      'these routes rotate account credentials without stamping ' +
        'sessions_invalidated_at, so every bearer JWT and session-proof ' +
        'window issued before the rotation keeps working after it:\n' +
        `${missing.join('\n')}\n\nall column sites:\n${touches.sites.join('\n')}`,
    ).toEqual([]);
  });

  it('the read exemption stays anchored to a line that still exists', () => {
    // A per-line exemption rots silently: refactor the middleware query and the
    // entry covers nothing, while a reader still believes the read is accounted
    // for. Exactly one occurrence each, so a removal and a copy-paste into a
    // second file are both caught.
    for (const exempt of READ_ONLY_LINES) {
      const hits = sources.flatMap(({ rel, lines }) =>
        lines.flatMap((line, i) => (normalize(line) === exempt ? [`${rel}#${i}`] : [])),
      );
      expect(hits, `read exemption no longer matches exactly one line: ${exempt}`).toHaveLength(1);
    }
  });

  it('the column matcher fires on every spelling of the write', () => {
    // Planted positives and negatives, so a mangled pattern cannot leave the
    // scan silently matching nothing while the suite stays green.
    const touches = (line: string): boolean =>
      REVOCATION_COLUMN_RE.test(line) && !skipColumnLine(line);

    expect(touches('SET sessions_invalidated_at = NOW()')).toBe(true);
    expect(touches('             sessions_invalidated_at = $3')).toBe(true);
    // Spellings the `column = value` form missed. Every one writes the column,
    // and every one was fail-open before.
    expect(touches('SET "sessions_invalidated_at" = NOW()')).toBe(true);
    expect(touches('SET (email, sessions_invalidated_at) = ($1, NOW())')).toBe(true);
    expect(
      touches('INSERT INTO accounts (username, sessions_invalidated_at) VALUES ($1, NOW())'),
    ).toBe(true);
    expect(touches('             sessions_invalidated_at')).toBe(true);
    expect(touches('  .set({ sessions_invalidated_at: new Date() })')).toBe(true);
    // A SELECT is matched by the pattern and spared only by the exact-line
    // exemption, which is what lets the touch side over-match safely. An
    // unexempted SELECT still counts, so a read added elsewhere gets reviewed.
    expect(touches('SELECT sessions_invalidated_at FROM accounts')).toBe(true);
    expect(
      touches("            'SELECT sessions_invalidated_at FROM accounts WHERE username = $1',"),
    ).toBe(false);
    // Prose is skipped, and the camelCase request field is a different name.
    expect(touches(' * `sessions_invalidated_at` MUST call this.')).toBe(false);
    expect(touches('  // sessions_invalidated_at and reissues a fresh session token')).toBe(false);
    expect(touches('  const ms = req.hiveSessionsInvalidatedAt;')).toBe(false);

    expect(SWEEP_CALL_RE.test('await invalidateSessionFreshAuthTokens(account.username);')).toBe(
      true,
    );
    expect(SWEEP_CALL_RE.test('  invalidateSessionFreshAuthTokens,')).toBe(false);
    // The pattern alone cannot tell a live call from a dead one, which is why
    // the scan above is the one that carries the filter.
    expect(SWEEP_CALL_RE.test('  // await invalidateSessionFreshAuthTokens(username);')).toBe(true);

    // The trailing-comment strip: dead tails vanish, live calls survive their
    // own comment tails, and the accepted string-literal naivety fails closed.
    expect(SWEEP_CALL_RE.test(stripTrailingComment('  done(); // invalidateSessionFreshAuthTokens(u);'))).toBe(false);
    expect(SWEEP_CALL_RE.test(stripTrailingComment('  done(); /* invalidateSessionFreshAuthTokens(u) */'))).toBe(false);
    expect(SWEEP_CALL_RE.test(stripTrailingComment('  await invalidateSessionFreshAuthTokens(u); // done'))).toBe(true);
    expect(SWEEP_CALL_RE.test(stripTrailingComment('  await invalidateSessionFreshAuthTokens(u);'))).toBe(true);
    // A comment marker inside a string truncates the strip. On this scan that
    // is the safe direction: the call after it goes unread, the pairing fails,
    // and the red bar names the line; the fix is a line of its own.
    expect(
      SWEEP_CALL_RE.test(stripTrailingComment("  log('http://x'); await invalidateSessionFreshAuthTokens(u);")),
    ).toBe(false);

    expect(SWEEP_DEFINITION_RE.test('export async function invalidateSessionFreshAuthTokens(username: string): Promise<void> {')).toBe(true);
    expect(SWEEP_DEFINITION_RE.test('  await invalidateSessionFreshAuthTokens(username);')).toBe(false);
    const dead = [
      '  /* restore before merge',
      '  await invalidateSessionFreshAuthTokens(username);',
      '  */',
      '  await invalidateSessionFreshAuthTokens(username);',
    ];
    expect(isCommentedOut(dead[1], 1, dead)).toBe(true);
    expect(isCommentedOut(dead[3], 3, dead)).toBe(false);
    expect(
      isCommentedOut(' * calls invalidateSessionFreshAuthTokens(u) from the same handler', 0, []),
    ).toBe(true);
  });

  it('a write and a sweep in different functions of one file do not pair up', () => {
    // The granularity the assertion above rests on. Under the previous
    // whole-file form these synthetic handlers passed, because the file
    // contained both a write and a sweep somewhere. `/quoted` and `/wrapped`
    // were additionally invisible to the `column = value` signal, and
    // `/promises` was visible to it but PAIRED, because a commented-out sweep
    // counted as a sweep.
    const lines = [
      "router.post('/sweeps', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  await invalidateSessionFreshAuthTokens(username);',
      '});',
      '',
      "router.post('/forgets', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '});',
      '',
      "router.post('/quoted', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET "sessions_invalidated_at" = NOW()`);',
      '});',
      '',
      "router.post('/wrapped', async (req, res) => {",
      '  await pool.query(`UPDATE accounts',
      '     SET sessions_invalidated_at',
      '         = NOW()`);',
      '});',
      '',
      "router.post('/promises', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  // TODO: await invalidateSessionFreshAuthTokens(username);',
      '});',
    ];
    const { touches, offenders } = unsweptWriters([{ rel: 'routes/synthetic.ts', lines }]);
    expect(touches.keys).toEqual([
      'routes/synthetic.ts#POST /forgets',
      'routes/synthetic.ts#POST /promises',
      'routes/synthetic.ts#POST /quoted',
      'routes/synthetic.ts#POST /sweeps',
      'routes/synthetic.ts#POST /wrapped',
    ]);
    expect(offenders).toEqual([
      'routes/synthetic.ts#POST /forgets',
      'routes/synthetic.ts#POST /promises',
      'routes/synthetic.ts#POST /quoted',
      'routes/synthetic.ts#POST /wrapped',
    ]);
  });

  it('a sweep commented out with a line comment does not pair with a live write', () => {
    // The ordinary accident, not an adversarial one: the call is commented out
    // while debugging and never restored. The handler still stamps the
    // revocation column and still leaves an open broadcast window, and a scan
    // that counts the dead line as the sweep stays green through it.
    const lines = [
      "router.post('/stale', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  // await invalidateSessionFreshAuthTokens(username);',
      '});',
    ];
    const { touches, sweeps, offenders } = unsweptWriters([{ rel: 'routes/synthetic.ts', lines }]);
    expect(touches.keys).toEqual(['routes/synthetic.ts#POST /stale']);
    expect([...sweeps]).toEqual([]);
    expect(offenders).toEqual(['routes/synthetic.ts#POST /stale']);
  });

  it('a sweep commented out with a block does not pair with a live write', () => {
    // The same accident by the other editor gesture. A block toggle over a
    // multi-line selection prefixes only the first line, so the dead call keeps
    // its indentation and its `await` and reads as live code to any predicate
    // that judges a line by its own first characters.
    const lines = [
      "router.post('/stale-block', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  /* restore before merge',
      '  await invalidateSessionFreshAuthTokens(username);',
      '  */',
      '});',
    ];
    const { touches, sweeps, offenders } = unsweptWriters([{ rel: 'routes/synthetic.ts', lines }]);
    expect(touches.keys).toEqual(['routes/synthetic.ts#POST /stale-block']);
    expect([...sweeps]).toEqual([]);
    expect(offenders).toEqual(['routes/synthetic.ts#POST /stale-block']);
  });

  it('a sweep in a trailing comment on a live line does not pair with a live write', () => {
    // The third comment gesture, and the one the two filters above are blind
    // to: the line itself is live code, so it is not comment-shaped and sits
    // inside no block, yet the call exists only in its comment tail. Both
    // trailing forms are planted — the line comment, and an inline block.
    const lines = [
      "router.post('/tail', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  markDone(); // await invalidateSessionFreshAuthTokens(username);',
      '});',
      '',
      "router.post('/tail-block', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  markDone(); /* invalidateSessionFreshAuthTokens(username) */',
      '});',
      '',
      "router.post('/tail-live', async (req, res) => {",
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '  await invalidateSessionFreshAuthTokens(username); // closes every open window',
      '});',
    ];
    const { sweeps, offenders } = unsweptWriters([{ rel: 'routes/synthetic.ts', lines }]);
    // The live call keeps its pairing even with a comment tail of its own; the
    // two dead tails vouch for nothing.
    expect([...sweeps]).toEqual(['routes/synthetic.ts#POST /tail-live']);
    expect(offenders).toEqual([
      'routes/synthetic.ts#POST /tail',
      'routes/synthetic.ts#POST /tail-block',
    ]);
  });

  it('the sweep definition line does not vouch for a write in the sweep function itself', () => {
    // Definition self-satisfaction. The definition line matches the call
    // pattern, so without its shape skip a revocation-column write added
    // INSIDE the sweep helper would pair with the function's own signature.
    const lines = [
      'export async function invalidateSessionFreshAuthTokens(username: string): Promise<void> {',
      '  await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW() WHERE username = $1`);',
      '}',
    ];
    const { sweeps, offenders } = unsweptWriters([{ rel: 'lib/synthetic.ts', lines }]);
    expect([...sweeps]).toEqual([]);
    expect(offenders).toEqual(['lib/synthetic.ts#invalidateSessionFreshAuthTokens']);
  });

  it('a declaration shape the resolver cannot parse is a red bar, not a satisfied pair', () => {
    // Module-scope vacuity, the pairing-scan failure mode documented in
    // tests/support/enclosing-symbol.ts: an object-method shorthand is a
    // declaration the resolver does not recognize, so the write and the sweep
    // it carries both resolve to module scope — one label satisfying itself.
    // With module-scope keys dropped from the satisfying set, the write is an
    // offender demanding a declaration shape the resolver can name.
    const lines = [
      'export const recovery = {',
      '  async applySwap(username) {',
      '    await pool.query(`UPDATE accounts SET sessions_invalidated_at = NOW()`);',
      '    await invalidateSessionFreshAuthTokens(username);',
      '  },',
      '};',
    ];
    const { touches, sweeps, offenders } = unsweptWriters([{ rel: 'routes/synthetic.ts', lines }]);
    expect(touches.keys).toEqual(['routes/synthetic.ts#<module>']);
    expect([...sweeps]).toEqual([]);
    expect(offenders).toEqual(['routes/synthetic.ts#<module>']);
  });
});
