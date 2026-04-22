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

/**
 * Thrown by `validateDisciplineFilter` when a raw filter value violates the
 * length or charset guard. Callers convert this to a `400 BAD_REQUEST`
 * response with the error's message. See BE-DISCIPLINE-LENGTH-CAP.
 */
export class DisciplineFilterError extends Error {
  constructor(message = 'Discipline filter invalid') {
    super(message);
    this.name = 'DisciplineFilterError';
  }
}

/**
 * Validates a raw `?discipline=` filter value. Enforces:
 * - Length <= DISCIPLINE_FILTER_MAX_LEN (guards against oversize-string DoS
 *   on String.prototype.toLowerCase() and Postgres LOWER()).
 * - Charset matches DISCIPLINE_FILTER_PATTERN (Unicode letters/digits/space/hyphen).
 *
 * Returns the canonical (lowercased) value on success, null for empty/undefined,
 * or throws `DisciplineFilterError` on guard failure. Callers convert the error
 * to a 400 BAD_REQUEST response.
 *
 * Accepts `unknown` because Express types `req.query[k]` as
 * `string | ParsedQs | string[] | ParsedQs[] | undefined`; non-string shapes
 * (repeated `?discipline=a&discipline=b` yields `string[]`) are treated as
 * invalid input and return null — same as absent. This preserves the prior
 * `typeof raw === 'string'` narrow while centralising the guard.
 */
export function validateDisciplineFilter(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  if (raw.length > DISCIPLINE_FILTER_MAX_LEN) {
    throw new DisciplineFilterError();
  }
  if (!DISCIPLINE_FILTER_PATTERN.test(raw)) {
    throw new DisciplineFilterError();
  }
  return raw.toLowerCase();
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
 */
export function paperDisciplineField(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}
