// ──────────────────────────────────────────────
// /api/search ?q= filter validation
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
// Generic optional LIKE-filter validation
// ──────────────────────────────────────────────
//
// Same two defenses as validateSearchQuery (length cap + LIKE-metacharacter
// escape), but with optional semantics: `?param=` is OPTIONAL — absent /
// repeated-param / non-string all silently unfilter (return value: undefined)
// rather than 400ing as "required". Used for the `?field=` and `?institution=`
// filters on /api/accreditations, which bind to `latest.field ILIKE $N` and
// `latest.institution ILIKE $N` against the same ranked-CTE materialization.
//
// Caller wires the result like:
//   const r = validateOptionalLikeFilter(req.query.field, 'field');
//   if (!r.ok) return sendError(res, 400, 'BAD_REQUEST', r.message);
//   const field = r.value; // string | undefined — fold into SQL params on string

/**
 * Result returned by `validateOptionalLikeFilter`:
 * - `{ ok: true, value: string }` — the filter is present and valid; `value`
 *   is the LIKE-metacharacter-escaped form ready to bind into a pattern
 *   under `ESCAPE '\\'`.
 * - `{ ok: true, value: undefined }` — the filter is absent (missing,
 *   empty/whitespace-only, repeated `?param=a&param=b` array shape, or
 *   non-string). Callers omit the WHERE clause entirely (silent-unfilter).
 * - `{ ok: false, message }` — the filter is present but violates the
 *   length cap. Callers convert to `400 BAD_REQUEST`.
 */
export type OptionalLikeFilterResult =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

/**
 * Validates an optional `?param=` filter value bound to an ILIKE site.
 * `paramName` is interpolated into the "too long" error message so callers
 * get a per-param-specific 400 string (e.g. "Filter \"field\" too long").
 *
 * Behaviour:
 * - absent (missing) / non-string (repeated `?param=a&param=b` → string[]) /
 *   empty / whitespace-only → `{ ok: true, value: undefined }` (silent
 *   unfilter; mirrors the `?discipline=` silent-unfilter contract).
 * - length > SEARCH_QUERY_MAX_LEN → `{ ok: false, message }`.
 * - otherwise → `{ ok: true, value: escapeLikePattern(raw) }`.
 *
 * The escape MUST be paired with an `ESCAPE '\\'` clause at every ILIKE
 * call site that binds the returned value.
 */
export function validateOptionalLikeFilter(
  raw: unknown,
  paramName: string,
): OptionalLikeFilterResult {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: true, value: undefined };
  if (raw.trim().length === 0) return { ok: true, value: undefined };
  if (raw.length > SEARCH_QUERY_MAX_LEN) {
    return { ok: false, message: `Filter "${paramName}" too long` };
  }
  return { ok: true, value: escapeLikePattern(raw) };
}

// ──────────────────────────────────────────────
// /api/search ?type= / ?source= / ?sort= / ?language= filter validation
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
 *   - `{ ok: true, value: string | undefined }` — absent (undefined or
 *     empty string) or a single non-empty string passed through unchanged.
 *   - `{ ok: false, message }` — non-string shape (repeated `?language=`
 *     yields `string[]`) or length exceeds SEARCH_LANGUAGE_MAX_LEN.
 *
 * **Contract decision: typeof-narrow + length cap, charset deferred.** The
 * route binds `?language=` value through
 * `c.json_metadata ->> 'language'` for an exact-equality match. Stored
 * values are not centrally validated — historical papers (including
 * bridge imports from arXiv/Crossref) may have any shape. Length is
 * capped at SEARCH_LANGUAGE_MAX_LEN = 16, which fits BCP-47 / IETF
 * language tags comfortably (most real tags are ≤10 chars; 16 leaves
 * headroom for shapes like `zh-Hant-TW`). The cap closes a cache-key
 * enumeration vector: without it, an attacker could enumerate distinct
 * `?language=` values to populate distinct `hafCache` entries on
 * cache-miss, costing HAF backend CPU. SHA-256 hashing of the cache
 * `rawKey` bounds Redis KEY size but does not bound the COUNT of distinct
 * cache entries.
 *
 * Empty-string handling: `?language=` (no value) yields the empty string.
 * Treated as ABSENT (returns `{ok: true, value: undefined}`), mirroring
 * the `?q=` whitespace-only contract — avoids querying for papers with
 * a literal empty-string language tag.
 *
 * Charset enforcement (e.g. `^[a-zA-Z0-9-]+$` for BCP-47) is intentionally
 * out of scope here. The publishing UI's allowed-language set is not yet
 * pinned end-to-end, and enforcing a charset would orphan any historical
 * bridge papers with non-conforming tags. A separate follow-up can pin
 * the charset once the publishing UI lands.
 *
 * The adopted contract mirrors `?type=` (400-on-repeated); the
 * silent-unfilter alternative (like `?discipline=`) was dismissed because
 * language has no "all languages" semantic — an unparseable value is more
 * useful as a 400 than as a silent unfilter.
 */
export type LanguageFilterResult =
  | { ok: true; value: string | undefined }
  | { ok: false; message: string };

/** Maximum allowed length of the raw `?language=` parameter, in code points. */
export const SEARCH_LANGUAGE_MAX_LEN = 16;

const INVALID_LANGUAGE_SHAPE_MESSAGE = 'Invalid language. Must be a single value (repeated params not allowed)';
const INVALID_LANGUAGE_LENGTH_MESSAGE = `Invalid language. Must be ${SEARCH_LANGUAGE_MAX_LEN} characters or fewer`;

export function parseLanguageFilter(raw: unknown): LanguageFilterResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, message: INVALID_LANGUAGE_SHAPE_MESSAGE };
  if (raw.length === 0) return { ok: true, value: undefined };
  if (raw.length > SEARCH_LANGUAGE_MAX_LEN) {
    return { ok: false, message: INVALID_LANGUAGE_LENGTH_MESSAGE };
  }
  return { ok: true, value: raw };
}
