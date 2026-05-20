// Display helpers for `authors[]` rows returned by `/api/papers` and
// `/api/papers/:author/:permlink`. The supersession contract is documented in
// `agents/docs/api-contracts/papers.md` (authors[].orcid / orcid_verified /
// orcid_discrepancy) and the hive-schemas supersession rule.

// Mirrors the backend's ORCID_RE on the validation surface. The chain-claimed
// `authors[].orcid` is broadcaster-supplied with only a length cap on the
// backend, so an attacker can stuff a 50-char junk string that the UI would
// otherwise render as a green-logo ORCID-iD link. Validating shape here keeps
// the trust-spoof closed without changing the wire contract.
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/;

function validOrcidOrNull(value) {
  if (typeof value !== 'string') return null;
  return ORCID_RE.test(value) ? value : null;
}

/**
 * Returns the canonical display ORCID for an author row — the verified value
 * when present and well-formed, else the chain-claimed value when well-formed,
 * else null. Truthy-`||` semantics: empty / non-string / malformed values fall
 * through. Older backend responses that pre-date the supersession projection
 * fall through to chain `orcid` (graceful staleness rather than blank bylines).
 */
export function canonicalOrcid(author) {
  if (!author) return null;
  return validOrcidOrNull(author.orcid_verified) || validOrcidOrNull(author.orcid);
}

/**
 * True when the backend signals an ORCID discrepancy on this author row.
 * Reads `orcid_discrepancy` strictly (=== true) so undefined/older responses
 * degrade quietly to "no discrepancy".
 */
export function hasOrcidDiscrepancy(author) {
  if (!author) return false;
  return author.orcid_discrepancy === true;
}

/**
 * True when the discrepancy indicator should render at the byline. Combines
 * the wire-level discrepancy flag with a values-differ check: the backend
 * emits `orcid_discrepancy: true` even on accredited authors where it has
 * already overridden `out.orcid := orcid_verified` (per the PaperDetail /
 * PaperSummary caveat in api-contracts/papers.md), producing a wire shape
 * where the chain and verified values are now identical. Rendering the
 * two-value tooltip in that case would surface "Claimed: X • Verified: X" —
 * suppressing the indicator there avoids the self-contradiction.
 */
export function shouldShowDiscrepancyIndicator(author) {
  if (!hasOrcidDiscrepancy(author)) return false;
  return author.orcid !== author.orcid_verified;
}
