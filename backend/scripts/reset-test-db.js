#!/usr/bin/env node
/**
 * reset-test-db.js — truncates every user table in the app DB pointed at by
 * APP_DATABASE_URL. Intended to be called from Playwright's global-setup so
 * each E2E run starts against an empty, migrated schema.
 *
 * Safety gate: refuses to run unless the target database name ends in "_test".
 * This is the primary guard against accidentally wiping the dev `pevo_app` DB.
 *
 * Schema discovery is dynamic (reads pg_tables) so future migrations that add
 * tables do not require touching this script.
 *
 * Invocation:
 *   APP_DATABASE_URL=postgresql://.../pevo_app_test node backend/scripts/reset-test-db.js
 *
 * Or via the npm script:
 *   APP_DATABASE_URL=... npm run --prefix backend test-db:reset
 *
 * Exits 0 on success, non-zero on any failure (including the safety gate).
 */

const { Pool } = require('pg');

function extractDbName(url) {
  try {
    const u = new URL(url);
    return (u.pathname || '').replace(/^\//, '');
  } catch {
    return '';
  }
}

async function main() {
  const url = process.env.APP_DATABASE_URL || '';
  if (!url) {
    console.error('[reset-test-db] APP_DATABASE_URL is required');
    process.exit(1);
  }

  const dbName = extractDbName(url);
  if (!dbName.endsWith('_test')) {
    console.error(
      `[reset-test-db] refusing to run — database name '${dbName || '<unparseable>'}' does not end in '_test'.`,
    );
    console.error('[reset-test-db] this safety gate prevents accidentally truncating the dev/prod DB.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });

  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public'
         ORDER BY tablename`,
    );
    if (rows.length === 0) {
      console.log(`[reset-test-db] no tables in ${dbName}.public — nothing to truncate`);
      return;
    }
    const quoted = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    console.log(`[reset-test-db] truncated ${rows.length} table(s) in ${dbName}: ${rows.map((r) => r.tablename).join(', ')}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[reset-test-db] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
