/**
 * Unit coverage for the E2E fixture helpers that would otherwise only be
 * exercised via a live Playwright run. The fixture files ship as production
 * infrastructure for the E2E suite — the bugs they used to hide (inline-comment
 * stripping in .env parsing, missing `_test` DB-suffix guard) are subtle enough
 * that a regression would land silently until a developer happened to rerun
 * against the wrong DB or point SESSION_SECRET at a commented value.
 *
 * Added in FE-E2E-AUTH-FIXTURE-HARDEN actions #5 + #11 to keep the fix
 * regression-proof.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  parseEnvFile,
  mintSessionJwt,
  _resetCachedSessionSecret,
} from '../e2e/fixtures/auth.js';
import { assertTestDatabase } from '../e2e/fixtures/db.js';

describe('parseEnvFile', () => {
  const tmpDirs = [];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
  });

  function writeTmp(contents) {
    const dir = mkdtempSync(join(tmpdir(), 'pevo-envparse-'));
    tmpDirs.push(dir);
    const path = join(dir, '.env.test');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('returns {} when the file does not exist', () => {
    expect(parseEnvFile(join(tmpdir(), 'nope-does-not-exist.env'))).toEqual({});
  });

  it('parses simple KEY=VALUE pairs', () => {
    const path = writeTmp('A=1\nB=two\n');
    expect(parseEnvFile(path)).toEqual({ A: '1', B: 'two' });
  });

  it('skips comment-only and blank lines', () => {
    const path = writeTmp('# top comment\n\nFOO=bar\n# another\n');
    expect(parseEnvFile(path)).toEqual({ FOO: 'bar' });
  });

  it('strips a trailing inline "# comment" suffix from unquoted values', () => {
    // Regression: before FE-E2E-AUTH-FIXTURE-HARDEN #5, `SESSION_SECRET=abc # dev`
    // yielded the literal `'abc # dev'`, which the backend rejected as a 401 on
    // the JWT probe.
    const path = writeTmp('SESSION_SECRET=abc # dev\nFOO=bar#nospace\n');
    const out = parseEnvFile(path);
    expect(out.SESSION_SECRET).toBe('abc');
    expect(out.FOO).toBe('bar');
  });

  it('preserves "#" inside quoted values', () => {
    const path = writeTmp('A="a # b"\nB=\'c # d\'\n');
    expect(parseEnvFile(path)).toEqual({ A: 'a # b', B: 'c # d' });
  });

  it('strips surrounding quotes and keeps inner content verbatim', () => {
    const path = writeTmp('KEY="quoted value"\nOTHER=\'single\'\n');
    expect(parseEnvFile(path)).toEqual({ KEY: 'quoted value', OTHER: 'single' });
  });
});

describe('assertTestDatabase', () => {
  it('accepts URLs whose database name ends in _test', () => {
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/pevo_app_test'),
    ).not.toThrow();
    expect(() =>
      assertTestDatabase('postgres://u:p@127.0.0.1:5432/some_other_test'),
    ).not.toThrow();
  });

  it('refuses a dev-looking database name', () => {
    // The guard's whole point: a spec-in-isolation run (skipping global-setup)
    // must not silently write to pevo_app.
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/pevo_app'),
    ).toThrowError(/does not match/);
  });

  it('refuses an empty or missing connection string', () => {
    expect(() => assertTestDatabase('')).toThrowError(/APP_DATABASE_URL is not set/);
    expect(() => assertTestDatabase(undefined)).toThrowError(
      /APP_DATABASE_URL is not set/,
    );
    expect(() => assertTestDatabase(null)).toThrowError(
      /APP_DATABASE_URL is not set/,
    );
  });

  it('refuses a URL with no database name in the path', () => {
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/'),
    ).toThrowError(/has no database name/);
  });

  it('refuses non-URL garbage with a parse-error message', () => {
    expect(() => assertTestDatabase('not a url at all')).toThrowError(
      /is not a valid URL/,
    );
  });

  it('refuses a URL whose path contains extra slashes even if it ends in _test', () => {
    // Regression: `postgresql://.../pevo_app/test` would have parsed dbName
    // as `pevo_app/test` — `endsWith('_test')` returned true but libpq opens
    // `pevo_app`. The tightened guard requires a single-token name.
    expect(() =>
      assertTestDatabase('postgresql://u:p@localhost:5432/pevo_app/x_test'),
    ).toThrowError(/does not match/);
  });
});

describe('mintSessionJwt', () => {
  // Restore a clean env around each test so the cachedSecret + process.env
  // mutations don't leak into parseEnvFile / assertTestDatabase cases above.
  const savedEnv = {};
  const envKeys = ['E2E_SESSION_SECRET', 'SESSION_SECRET'];
  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    _resetCachedSessionSecret();
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetCachedSessionSecret();
  });

  function base64urlDecode(segment) {
    const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
    return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  }

  it('produces a deterministic, HMAC-verifiable HS256 JWT for a known secret', () => {
    const SECRET = 'deterministic-test-secret-not-a-real-key';
    process.env.E2E_SESSION_SECRET = SECRET;

    const { token, expiresAt } = mintSessionJwt('alice', {
      custody: 'self',
      expiresInSec: 3600,
    });

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [encodedHeader, encodedPayload, encodedSig] = parts;

    const header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });

    const payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8'));
    expect(payload.sub).toBe('alice');
    expect(payload.custody).toBe('self');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBe(payload.iat + 3600);

    // expiresAt returned from the helper must match the exp claim (within a
    // round-trip through Date parsing), so callers can trust the value they
    // seed into localStorage.
    expect(Math.floor(new Date(expiresAt).getTime() / 1000)).toBe(payload.exp);

    // HMAC verification — the signature must match a fresh HMAC over the
    // `header.payload` segments using the configured secret.
    const expectedSig = crypto
      .createHmac('sha256', SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const actualSig = base64urlDecode(encodedSig);
    expect(Buffer.compare(actualSig, expectedSig)).toBe(0);
  });

  it('defaults custody to "self" and exp to iat + 3600 when options omitted', () => {
    process.env.E2E_SESSION_SECRET = 'x'.repeat(32);
    const { token } = mintSessionJwt('bob');
    const payload = JSON.parse(
      base64urlDecode(token.split('.')[1]).toString('utf8'),
    );
    expect(payload.sub).toBe('bob');
    expect(payload.custody).toBe('self');
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it('prefers E2E_SESSION_SECRET over the backend SESSION_SECRET in the shell env', () => {
    // The whole point of the rename: even if the backend's SESSION_SECRET is
    // present (Docker Compose injects it), the fixture must NOT use it. Only
    // E2E_SESSION_SECRET (or the .env.test file) counts.
    process.env.SESSION_SECRET = 'backend-secret-must-not-leak';
    process.env.E2E_SESSION_SECRET = 'e2e-override';
    const { token } = mintSessionJwt('carol');
    const [h, p, s] = token.split('.');
    const okWithOverride = Buffer.compare(
      base64urlDecode(s),
      crypto.createHmac('sha256', 'e2e-override').update(`${h}.${p}`).digest(),
    );
    const okWithBackend = Buffer.compare(
      base64urlDecode(s),
      crypto
        .createHmac('sha256', 'backend-secret-must-not-leak')
        .update(`${h}.${p}`)
        .digest(),
    );
    expect(okWithOverride).toBe(0);
    expect(okWithBackend).not.toBe(0);
  });

  it('throws a recognisable error when no secret source is configured', () => {
    delete process.env.E2E_SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    // frontend/.env.test may exist in the developer's workspace, in which
    // case getSessionSecret resolves it via parseEnvFile and does NOT throw.
    // The error path is only taken when both sources are absent, so we skip
    // this assertion if the on-disk file would satisfy the lookup.
    // eslint-disable-next-line no-undef
    let fileHasSecret = false;
    try {
      const repoEnvTest = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.test');
      fileHasSecret = Boolean(parseEnvFile(repoEnvTest).SESSION_SECRET);
    } catch {
      // swallow — absence is the only thing we care about
    }
    if (fileHasSecret) return;
    expect(() => mintSessionJwt('eve')).toThrowError(/SESSION_SECRET not found/);
  });
});
