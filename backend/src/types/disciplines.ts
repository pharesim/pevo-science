// PEvO Discipline Taxonomy - based on OECD Fields of Research (Frascati Manual)

export interface DisciplineField {
  field: string;
  subfields: string[];
}

export const DISCIPLINE_TAXONOMY: DisciplineField[] = [
  {
    field: "Natural Sciences",
    subfields: [
      "Mathematics",
      "Computer Science",
      "Physics",
      "Chemistry",
      "Earth Sciences",
      "Biology",
      "Astronomy",
    ],
  },
  {
    field: "Engineering and Technology",
    subfields: [
      "Civil Engineering",
      "Electrical Engineering",
      "Mechanical Engineering",
      "Chemical Engineering",
      "Materials Engineering",
      "Biomedical Engineering",
      "Environmental Engineering",
    ],
  },
  {
    field: "Medical and Health Sciences",
    subfields: [
      "Basic Medicine",
      "Clinical Medicine",
      "Health Sciences",
      "Neuroscience",
      "Pharmacology",
    ],
  },
  {
    field: "Agricultural and Veterinary Sciences",
    subfields: [
      "Agriculture",
      "Animal Science",
      "Veterinary Science",
      "Forestry",
    ],
  },
  {
    field: "Social Sciences",
    subfields: [
      "Psychology",
      "Economics",
      "Education",
      "Sociology",
      "Law",
      "Political Science",
      "Geography",
    ],
  },
  {
    field: "Humanities and Arts",
    subfields: [
      "History",
      "Philosophy",
      "Languages and Literature",
      "Arts",
      "Theology",
    ],
  },
];

/** Flat list of all valid discipline sub-field values */
export const DISCIPLINES: string[] = DISCIPLINE_TAXONOMY.flatMap(
  (f) => f.subfields
);

/** Look up the top-level field for a given sub-field */
export function getFieldForDiscipline(
  discipline: string
): string | undefined {
  return DISCIPLINE_TAXONOMY.find((f) =>
    f.subfields.includes(discipline)
  )?.field;
}

// ──────────────────────────────────────────────
// ?discipline= filter validation (BE-DISCIPLINE-LENGTH-CAP)
// ──────────────────────────────────────────────

export const DISCIPLINE_FILTER_MAX_LEN = 100;
export const DISCIPLINE_FILTER_PATTERN = /^[\p{L}\p{N} \-]+$/u;
const DISCIPLINE_FILTER_INVALID_MESSAGE = 'Discipline filter invalid';

/**
 * Result shape returned by `validateDisciplineFilter`:
 * - `null` — the filter is absent (not provided, repeated/array shape, or
 *   non-string). Callers should treat as "no filter".
 * - `{ ok: true, value }` — the filter is present and valid; `value` is the
 *   canonical lowercased form ready to bind into SQL / cache keys.
 * - `{ ok: false, message }` — the filter is present but violates the length
 *   or charset guard. Callers convert to `400 BAD_REQUEST`.
 *
 * Discriminated union avoids the throw/instanceof rethrow shape that an
 * expected 400 path does not deserve.
 */
export type DisciplineFilterResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/**
 * Validates a raw `?discipline=` filter value. Enforces:
 * - Length <= DISCIPLINE_FILTER_MAX_LEN (guards against oversize-string DoS
 *   on String.prototype.toLowerCase() and Postgres LOWER()).
 * - Charset matches DISCIPLINE_FILTER_PATTERN (Unicode letters/digits/space/hyphen).
 *
 * Returns null for absent input (missing, empty, non-string, or array shape
 * from repeated `?discipline=a&discipline=b` params), `{ ok: true, value }`
 * with the lowercased canonical form on success, or `{ ok: false, message }`
 * on guard failure. The length check runs against the raw input before any
 * `.toLowerCase()` so an oversize string is rejected before V8 / Postgres
 * touch it.
 */
export function validateDisciplineFilter(raw: unknown): DisciplineFilterResult | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  if (raw.length > DISCIPLINE_FILTER_MAX_LEN) {
    return { ok: false, message: DISCIPLINE_FILTER_INVALID_MESSAGE };
  }
  if (!DISCIPLINE_FILTER_PATTERN.test(raw)) {
    return { ok: false, message: DISCIPLINE_FILTER_INVALID_MESSAGE };
  }
  return { ok: true, value: raw.toLowerCase() };
}

// ──────────────────────────────────────────────
// Per-paper `discipline` response field (BE-PAPERS-DISCIPLINE-FIELD-CANON-NAME)
// ──────────────────────────────────────────────

/**
 * Normalizes the per-paper `discipline` response field to canon_name
 * (lowercased). Every response-shaping site that surfaces a paper's
 * discipline must route through this so future drift becomes a type-check
 * failure at the helper call site, not a whack-a-mole across routes.
 *
 * Returns null for missing/empty/non-string input so callers can distinguish
 * "no discipline tagged" from a canonicalized value.
 *
 * Canon semantics mirror `/api/disciplines.canon_name` (lowercased) and the
 * `?discipline=` URL-filter contract: clients can round-trip the response
 * field back through a filter URL without re-canonicalizing. Display form
 * (titlecase) is a one-hop lookup via `/api/disciplines.display_name` or a
 * CSS `text-transform: capitalize` on the render site.
 *
 * Accepts `unknown` because `pevo.discipline` is `unknown` from
 * `safePevoMeta` and the typeof narrow on the first line guards every
 * non-string shape (null, undefined, number, object, array) the same way.
 * Mirrors the sibling `validateDisciplineFilter(raw: unknown)` shape so
 * call sites do not need to lie to the type checker.
 */
export function paperDisciplineField(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}
