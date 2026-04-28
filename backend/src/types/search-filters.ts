// ──────────────────────────────────────────────
// /api/search ?q= filter validation (BE-SEARCH-Q-LIKEGUARD-AND-LENGTH-CAP)
// ──────────────────────────────────────────────
//
// Two distinct defenses for the `?q=` parameter on /api/search:
//
//   1. Length cap. Bound parameter length scales linearly with per-request
//      Postgres LOWER()/ILIKE work. An unbounded `?q=` lets an attacker
//      submit ~7900 bytes per request (capped only by Node's default URL
//      limit) and tie up backend workers without hitting the rate limiter.
//
//   2. LIKE-metacharacter escape. The bound parameter is interpolated into
//      `'%' || $N || '%'` via ILIKE. User-supplied `%` and `_` characters
//      become live LIKE wildcards; `_%_%_…` injects N wildcards and
//      Postgres backtracks per wildcard against every comment body the
//      outer CTE admits — the dominant CPU vector vs. plain LOWER().
//
// The escape uses backslash + `ESCAPE '\'` clause; this is the standard
// PostgreSQL idiom and survives across pg client versions without
// application-side regex transformation on the result side.

/** Maximum allowed length of the raw `?q=` parameter, in code points. */
export const SEARCH_QUERY_MAX_LEN = 200;

const SEARCH_QUERY_TOO_LONG_MESSAGE = 'Search query too long';

/**
 * Result returned by `validateSearchQuery`:
 * - `null` — the query is absent (missing, empty/whitespace-only, repeated-
 *   param array shape, or non-string). Callers convert to the existing
 *   "Search query \"q\" is required" 400 path.
 * - `{ ok: true, value }` — the query is valid; `value` is the LIKE-escaped
 *   form (backslash-escaped `\` `%` `_`) ready to bind into
 *   `'%' || $N || '%'` with `ESCAPE '\\'`.
 * - `{ ok: false, message }` — the query is present but violates the
 *   length cap. Callers convert to a 400 with the message.
 *
 * Mirrors the discriminated-union shape used by `validateDisciplineFilter`.
 */
export type SearchQueryResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Escape PostgreSQL LIKE metacharacters in a raw string. Maps:
 *   `\`  →  `\\`
 *   `%`  →  `\%`
 *   `_`  →  `\_`
 *
 * Pair with an `ESCAPE '\\'` clause on every ILIKE call site so Postgres
 * treats the escaped sequences as literal characters.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, '\\$&');
}

/**
 * Validates a raw `?q=` filter value. Enforces:
 * - Length <= SEARCH_QUERY_MAX_LEN (guards against unbounded ILIKE work).
 * - Empty/whitespace-only input is treated as absent (returns null) so the
 *   caller can return the existing "required" 400 message.
 * - Repeated `?q=a&q=b` (Express yields `string[]`) is treated as absent
 *   (returns null), mirroring the silent-unfilter contract on `?discipline=`.
 *
 * On success, returns the LIKE-metacharacter-escaped value ready to embed
 * into a `'%' || $N || '%'` pattern. The escape MUST be paired with an
 * `ESCAPE '\\'` clause at every ILIKE call site (see the SQL binders in
 * `backend/src/routes/search.ts`).
 */
export function validateSearchQuery(raw: unknown): SearchQueryResult | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.trim().length === 0) return null;
  if (raw.length > SEARCH_QUERY_MAX_LEN) {
    return { ok: false, message: SEARCH_QUERY_TOO_LONG_MESSAGE };
  }
  return { ok: true, value: escapeLikePattern(raw) };
}
