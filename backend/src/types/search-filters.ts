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

// ──────────────────────────────────────────────
// /api/search ?type= / ?source= / ?sort= / ?language= filter validation
// (BE-SEARCH-QUERY-PARAM-TYPEOF-NARROW-SWEEP)
// ──────────────────────────────────────────────
//
// Each `?param=` enum is exported as three pieces:
//   - a `readonly` literal-tuple `SEARCH_*` constant
//   - the derived literal-union `Search*` type
//   - a user-defined type guard `isSearch*(s: string): s is Search*`
//
// The type guard form lets route handlers drop the `as Search*` cast at the
// assignment site after a `typeof raw === 'string'` narrow. Repeated params
// (`?type=a&type=b`) yield `string[]` in Express's parsed query — the
// typeof-string narrow rejects them so an `as string` cast can't silently
// coerce to `"a,b"`.

export const SEARCH_TYPES = ['all', 'paper', 'review'] as const;
export type SearchType = typeof SEARCH_TYPES[number];
export function isSearchType(s: string): s is SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(s);
}

export const SEARCH_SOURCES = ['native', 'bridge'] as const;
export type SearchSource = typeof SEARCH_SOURCES[number];
export function isSearchSource(s: string): s is SearchSource {
  return (SEARCH_SOURCES as readonly string[]).includes(s);
}

export const SEARCH_SORTS = ['date', 'relevance'] as const;
export type SearchSort = typeof SEARCH_SORTS[number];
export function isSearchSort(s: string): s is SearchSort {
  return (SEARCH_SORTS as readonly string[]).includes(s);
}

/**
 * Result returned by `parseLanguageFilter`:
 *   - `{ ok: true, value: string | undefined }` — absent (undefined) or a
 *     single string value passed through unchanged.
 *   - `{ ok: false, message }` — non-string shape (repeated `?language=`
 *     yields `string[]`; anything else also rejects).
 *
 * **Contract decision (typeof-narrow only, no charset constraint).** The
 * route currently binds `?language=` value through
 * `c.json_metadata ->> 'language'` for an exact-equality match. Stored
 * values are not centrally validated — historical papers may have any
 * shape. Enforcing ISO 639-1 (e.g. `^[a-z]{2}$`) is a defensible follow-up
 * but would change the observable accept-set and risks orphaning real
 * papers in the corpus. The sweep this helper closes is the silent-coerce
 * vector (repeated params → `"en,fr"`), which is unambiguously a bug.
 * Charset/length enforcement is intentionally out of scope here; revisit
 * when the publishing UI's allowed-language set is pinned end-to-end.
 *
 * Option A from the sweep spec (mirror `?type=` 400-on-repeated) is the
 * adopted contract; Option B (silent-unfilter like `?discipline=`) was
 * dismissed because language has no "all languages" semantic — an
 * unparseable value is more useful as a 400 than as a silent unfilter.
 */
export type LanguageFilterResult =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

const INVALID_LANGUAGE_MESSAGE = 'Invalid language. Must be a single string value';

export function parseLanguageFilter(raw: unknown): LanguageFilterResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'string') return { ok: true, value: raw };
  return { ok: false, message: INVALID_LANGUAGE_MESSAGE };
}
