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

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvFile } from '../e2e/fixtures/auth.js';
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
    ).toThrowError(/does not end in "_test"/);
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
});
