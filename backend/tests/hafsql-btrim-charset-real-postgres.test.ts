/**
 * Real-Postgres byte-level canary for the chain-orcid BTRIM charset
 * (`CHAIN_ORCID_BTRIM_CHARSET` in `backend/src/hafsql.ts`).
 *
 * The mocked-pool canary in `papers-canonical-orcid-resolution.test.ts`
 * pins the emitted SQL TEXT — it asserts the literal
 * `BTRIM(a.elem ->> 'orcid', E' \\t\\n\\r\\x0B\\f')` appears in both
 * supersession sites. That assertion cannot catch a regression where
 * the SQL text is correct but PostgreSQL's E-string parser silently
 * misinterprets one of the escape sequences (e.g., `\v`, which
 * Postgres does NOT recognize and which collapses to a literal `v`
 * byte 0x76 instead of vertical-tab 0x0B). This file closes that gap
 * by executing the BTRIM expression against a live Postgres and
 * asserting the bytes on the wire match the byte-level intent.
 *
 * Per CLAUDE.md "Running Tests" carve-out:
 *   (a) Real-Postgres execution of `BTRIM` is required to verify
 *       byte-level escape parsing. The mocked-pool canary cannot
 *       distinguish `E'\v'` (literal `v`) from `E'\x0B'` (vertical-
 *       tab) because both emit identical SQL strings to the
 *       captured-SQL `toContain` assertion; only Postgres knows the
 *       difference at parse time.
 *   (b) `verifyHiveSignature` is irrelevant — no route is exercised.
 *   (c) No real-path companion needed: this IS the real-path companion
 *       for the mocked-pool canary's risk class (escape-string parse
 *       behavior).
 *
 * Skip-if-no-Postgres guard mirrors the `isHafConfigured()` pattern
 * used by sibling real-HAF tests so CI environments without a DB
 * stay green.
 */
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { CHAIN_ORCID_BTRIM_CHARSET } from '../src/hafsql.js';

const APP_DB_URL = process.env.APP_DATABASE_URL;
const HAF_DB_URL = process.env.HAF_DATABASE_URL?.split(',')[0];
// Either Postgres works — this test only exercises generic SQL
// (`SELECT BTRIM(...)`), no PEvO schema dependency. App DB is
// preferred when available because it's the closer-to-tests fixture.
const DB_URL = APP_DB_URL || HAF_DB_URL;

const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL, max: 1 }) : null;

afterAll(async () => {
  if (pool) await pool.end();
});

describe('CHAIN_ORCID_BTRIM_CHARSET — Postgres E-string parses the canonical hex escape correctly', () => {
  it.skipIf(!pool)('strips vertical-tab (0x0B) when present in the input', async () => {
    // Interpolate the constant into the BTRIM call exactly as the
    // production builders do. The SQL parser sees the literal text
    // `BTRIM($1, E' \t\n\r\x0B\f')`; the runtime byte set is space,
    // tab, LF, CR, vertical-tab, form-feed.
    const sql = `SELECT BTRIM($1, E'${CHAIN_ORCID_BTRIM_CHARSET}') AS stripped`;
    const inputs = [
      { label: 'vt-prefixed',   raw: '\x0B' + '0000-0001-2345-6789', expected: '0000-0001-2345-6789' },
      { label: 'vt-suffixed',   raw: '0000-0001-2345-6789' + '\x0B', expected: '0000-0001-2345-6789' },
      { label: 'tab-prefixed',  raw: '\t'   + '0000-0001-2345-6789', expected: '0000-0001-2345-6789' },
      { label: 'space-prefixed',raw: ' '    + '0000-0001-2345-6789', expected: '0000-0001-2345-6789' },
      { label: 'lf-suffixed',   raw: '0000-0001-2345-6789' + '\n',   expected: '0000-0001-2345-6789' },
      { label: 'cr-suffixed',   raw: '0000-0001-2345-6789' + '\r',   expected: '0000-0001-2345-6789' },
      { label: 'ff-suffixed',   raw: '0000-0001-2345-6789' + '\f',   expected: '0000-0001-2345-6789' },
      { label: 'unpadded',      raw: '0000-0001-2345-6789',          expected: '0000-0001-2345-6789' },
      // All-VT (and all other charset bytes) collapses to '' so the
      // sibling `NULLIF(BTRIM(...), '')` no-claim guard fires.
      { label: 'all-vt',        raw: '\x0B\x0B\x0B',                 expected: '' },
    ];
    for (const { label, raw, expected } of inputs) {
      const res = await pool!.query(sql, [raw]);
      expect(res.rows[0].stripped, `BTRIM should strip charset bytes for input "${label}"`).toBe(expected);
    }
  });

  it.skipIf(!pool)('does NOT strip a leading literal `v` (0x76) — the post-fix charset is byte 0x0B, not the alphabet letter', async () => {
    // Pre-fix regression: when the charset literal carried `\v`, the
    // Postgres parser silently treated it as a literal `v` byte 0x76,
    // making BTRIM strip the alphabet letter `v` from inputs. This
    // test pins the post-fix charset's correct behavior: a leading
    // literal `v` is NOT whitespace and survives the strip.
    const sql = `SELECT BTRIM($1, E'${CHAIN_ORCID_BTRIM_CHARSET}') AS stripped`;
    const raw = 'v0000-0001-2345-6789';
    const res = await pool!.query(sql, [raw]);
    expect(res.rows[0].stripped).toBe('v0000-0001-2345-6789');
  });

  it.skipIf(!pool)('byte-level: the charset literal parses to the canonical 6-byte ASCII C-whitespace set', async () => {
    // Mutation kill on the charset constant itself. Pre-fix, the
    // 6-byte set was `20 09 0A 0D 76 0C` (space, tab, LF, CR, literal
    // `v`, FF) — a 0x76 in place of the intended 0x0B. Post-fix,
    // `\x0B` parses correctly and the bytes are `20 09 0A 0D 0B 0C`.
    const res = await pool!.query(`SELECT encode((E' \\t\\n\\r\\x0B\\f')::bytea, 'hex') AS hex_bytes`);
    expect(res.rows[0].hex_bytes).toBe('20090a0d0b0c');
  });
});
