// Display helpers for `authors[]` rows returned by `/api/papers` and
// `/api/papers/:author/:permlink`. The supersession contract is documented in
// `agents/docs/api-contracts/papers.md` (authors[].orcid / orcid_verified /
// orcid_discrepancy) and `agents/docs/hive-schemas.md` § 1.1.

/**
 * Returns the canonical display ORCID for an author row, or null if neither
 * the verified nor the chain-claimed value is present.
 *
 * Falls through to chain `orcid` when `orcid_verified` is absent — covers
 * older backend responses that pre-date the supersession projection (graceful
 * staleness rather than blank bylines).
 */
export function canonicalOrcid(author) {
  if (!author) return null;
  if (author.orcid_verified) return author.orcid_verified;
  return author.orcid || null;
}

/**
 * True when both chain-claimed and verified ORCIDs are present and differ.
 * Reads the backend-emitted `orcid_discrepancy` flag (which captures the
 * pre-override comparison on continuation-chain papers); falls back to null
 * fields meaning "no discrepancy" so older responses degrade quietly.
 */
export function hasOrcidDiscrepancy(author) {
  if (!author) return false;
  return author.orcid_discrepancy === true;
}
