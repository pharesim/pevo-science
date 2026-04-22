// Display-only title-casing for discipline names.
//
// Backend stores disciplines lowercased (`canon_name`) and also returns a
// `display_name` that mirrors the first-seen casing; neither is guaranteed
// to be presentation-ready. Replaces the prior CSS `text-transform: capitalize`
// hack which mangled initialisms ("ml" -> "Ml") and stopwords ("theory of
// computation" -> "Theory Of Computation").
//
// English-only by design (see task FE-DISCIPLINE-DISPLAY-HARDEN, non-goals).
// If/when non-English disciplines surface, revisit via i18n follow-up.

// Stopwords stay lowercase when they are NOT the first word. Kept deliberately
// small; expand only when a real discipline name motivates it.
const STOPWORDS = new Set(['of', 'and', 'for', 'in', 'the', 'to', 'a', 'an']);

// Initialisms render ALL-CAPS. Extend this set as new short-form disciplines
// are added server-side. Entries must be lowercase for the lookup to hit.
const INITIALISMS = new Set(['ml', 'ai', 'nlp', 'dna', 'rna', 'gpu', 'cpu']);

// Capitalize a single word segment:
// - empty -> ''
// - initialism -> ALL-CAPS
// - default -> first-letter-uppercase, rest lowercase
function capitalizeWord(word) {
  if (!word) return '';
  const lower = word.toLowerCase();
  if (INITIALISMS.has(lower)) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Title-case a word that may contain hyphens (e.g. "bio-informatics"),
// so each hyphen-separated segment is independently capitalized/initialism-
// checked: "bio-informatics" -> "Bio-Informatics", "ml-ops" -> "ML-Ops".
function titleCaseHyphenated(word) {
  if (!word.includes('-')) return capitalizeWord(word);
  return word.split('-').map(capitalizeWord).join('-');
}

/**
 * Title-case a discipline name for display.
 *
 * Rules:
 * - First word is always capitalized (stopwords don't apply to it).
 * - Subsequent stopwords (of, and, for, in, the, to, a, an) stay lowercase.
 * - Known initialisms (ml, ai, nlp, dna, rna, gpu, cpu) render ALL-CAPS,
 *   including when they appear as the first word.
 * - Hyphenated words capitalize each hyphen-separated segment.
 * - Whitespace is collapsed; leading/trailing whitespace is trimmed.
 * - Non-string or empty input returns ''.
 *
 * @param {string} name - Usually `canon_name` (lowercase) from the API.
 * @returns {string} Display-ready title-cased name.
 */
export function titleCaseDiscipline(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  // Split on any run of whitespace so stray double-spaces collapse cleanly.
  const words = trimmed.split(/\s+/);
  return words
    .map((word, idx) => {
      const lower = word.toLowerCase();
      // Initialism wins over stopword rule for consistency ("AI in Biology",
      // not "Ai in Biology" if "ai" is ever the first word).
      if (INITIALISMS.has(lower)) return lower.toUpperCase();
      // Stopwords only stay lowercase when not the first word.
      if (idx > 0 && STOPWORDS.has(lower)) return lower;
      return titleCaseHyphenated(word);
    })
    .join(' ');
}
