// Poll + settle helper for `custody_audit_log` SELECT-INSERT races in tests.
//
// Background: production paths that audit-log via `logCustodyBroadcast` (or
// peer helpers in the auth/recover surface) intentionally fire-and-forget the
// INSERT (`.catch(() => {})`, no await) so the HTTP response can return before
// the audit row settles. Combined with vitest's `retry: 3` and class-level
// `beforeAll` / `afterAll` cleanup (rather than `beforeEach`), this is the
// three-condition trigger documented in the
// `vitest-retry-fire-and-forget-side-effect-poisoning` convention: a count
// assertion that fires too early can either (a) see zero rows and fail, or
// (b) see the first INSERT, pass, and silently miss an in-flight retry-poisoned
// second INSERT that would arrive a few ms later.
//
// Defense shape: poll up to 1500ms at 25ms intervals for `rows.length >= N`,
// then add a 100ms settle delay, then re-SELECT and return the settled set.
// The 100ms settle window catches an in-flight retry-poisoned (or
// over-log-mutated) second INSERT before the count assertion runs, so a
// mutation that turns one INSERT into two will surface as `rows.length > N`
// instead of slipping past unseen. A `beforeEach` reset at the describe-block
// level remains load-bearing: it guarantees a clean baseline so the post-settle
// count is ground truth, not a stale accumulation.
//
// Two call shapes are exported:
//   - `fetchSettledAuditRows(pool, username, operationType)` — the canonical
//     shape used by recover.test.ts; SELECTs `operation_type` only and filters
//     by `(username, operation_type)`. Poll-min defaults to 1.
//   - `fetchSettledAuditRowsWith({ pool, username, columns, ... })` — the
//     extended shape for consent-ops-style tests that need additional columns
//     (`auth_mechanism`, `fresh_auth_outcome`, `session_id`, `user_agent`),
//     filter by username only (to span multiple operation types within one
//     spec), accept a custom `minRows` (e.g. 2 for tests that issue two
//     consent ops), and an optional `ORDER BY` for created-at ordering.
//
// Both wrap the same poll + settle invariant. The 1500ms budget and 25ms
// poll interval are the convention's prescribed parameters; the 100ms settle
// window is the mutation-kill threshold for over-log production changes.

type PoolLike<TRow> = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: TRow[] }>;
};

const POLL_BUDGET_MS = 1500;
const POLL_INTERVAL_MS = 25;
const SETTLE_MS = 100;

/**
 * Canonical poll + settle for the `(username, operation_type)`-filtered shape
 * used by recover.test.ts. Returns the `operation_type`-projected rows.
 *
 * Signature is preserved across the extraction from recover.test.ts so the
 * two pre-existing call sites in that file continue to work unchanged.
 */
export async function fetchSettledAuditRows(
  pool: PoolLike<{ operation_type: string }>,
  username: string,
  operationType: string,
): Promise<{ operation_type: string }[]> {
  const sql = `SELECT operation_type FROM custody_audit_log
               WHERE username = $1 AND operation_type = $2`;
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    const { rows } = await pool.query(sql, [username, operationType]);
    if (rows.length >= 1) {
      await sleep(SETTLE_MS);
      const { rows: settled } = await pool.query(sql, [username, operationType]);
      return settled;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const { rows } = await pool.query(sql, [username, operationType]);
  return rows;
}

/**
 * Extended poll + settle for tests that need additional columns, a
 * username-only filter (spanning multiple operation types within one spec),
 * a non-default minimum row count, and/or a custom `ORDER BY`.
 *
 * The poll + settle invariant is identical to `fetchSettledAuditRows` above:
 * 1500ms / 25ms-interval poll, 100ms settle window, then a re-SELECT.
 *
 * `columns` is interpolated raw into the SELECT clause; the caller is
 * responsible for ensuring it is a literal column list and never carries
 * user input. (Tests construct it from string literals.)
 *
 * `orderBy` is similarly raw and optional; omit for unordered results.
 */
export async function fetchSettledAuditRowsWith<TRow>(opts: {
  pool: PoolLike<TRow>;
  username: string;
  columns: string;
  minRows?: number;
  orderBy?: string;
}): Promise<TRow[]> {
  const { pool, username, columns, minRows = 1, orderBy } = opts;
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : '';
  const sql = `SELECT ${columns} FROM custody_audit_log
               WHERE username = $1${orderClause}`;
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    const { rows } = await pool.query(sql, [username]);
    if (rows.length >= minRows) {
      await sleep(SETTLE_MS);
      const { rows: settled } = await pool.query(sql, [username]);
      return settled;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const { rows } = await pool.query(sql, [username]);
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
