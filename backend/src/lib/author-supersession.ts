/**
 * ORCID supersession helpers — JS-side mirror of `authorsWithSupersessionSelect`
 * in `backend/src/hafsql.ts`.
 *
 * Per `agents/docs/hive-schemas.md` § 1.1, a paper's `authors[i]` carries a
 * chain-typed `orcid` value (whatever the broadcaster claimed at publish
 * time). For each author, the read path projects two supersession fields:
 *
 *   - `orcid_verified` — the accreditation-attested ORCID when the hive
 *     account is currently accredited AND the accreditation carries an
 *     ORCID; null otherwise.
 *   - `orcid_discrepancy` — `true` IFF chain `orcid` and `orcid_verified`
 *     are both non-empty AND differ.
 *
 * The SQL projection lives in `hafsql.ts` and is used by endpoints that
 * shape responses via SQL projection (`/api/papers` list, `/api/papers/:author/:permlink`
 * detail). JS code paths that build authors arrays without round-tripping
 * through SQL projection (`?version=N` reconstruction, the
 * `metadata_restored` fallback, continuation-chain cumulative union, and
 * `/api/profile/:username/papers`) use these helpers to apply the same
 * supersession rule with the same semantics.
 *
 * The two surfaces MUST stay in lockstep. Drift between SQL and JS
 * supersession output is a cross-surface parity break (see
 * `agents/docs/solutions/conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md`).
 */

/**
 * Normalize a chain-metadata `hive` value to its lookup-canonical form.
 *
 * Hive consensus enforces lowercase account names at op level — every
 * `account` value in `active_accreditations` is lowercase by chain rule.
 * But chain `json_metadata` payloads (`authors[i].hive`) can carry
 * mixed-case or whitespace-padded variants: a co-author input form that
 * doesn't normalize, or hand-broadcast metadata. Without canonicalization
 * before the supersession lookup, a vouched co-author can suppress the
 * `orcid_verified` surface (silencing the discrepancy audit signal) by
 * varying case on the `hive` field.
 *
 * The SQL-side LEFT JOIN in `authorsWithSupersessionSelect` uses
 * `LOWER(TRIM(a.elem ->> 'hive'))` for the same purpose. The two paths
 * MUST stay in lockstep; the parity is the contract.
 *
 * Returns `null` for non-string inputs or strings that canonicalize to
 * empty (preserves the case-1 behavior: "no hive → no verified ORCID").
 */
export function canonicalHiveKey(hive: unknown): string | null {
  if (typeof hive !== 'string') return null;
  const norm = hive.trim().toLowerCase();
  return norm.length === 0 ? null : norm;
}

/**
 * Compute `orcid_verified` and `orcid_discrepancy` for a single author
 * entry per `agents/docs/hive-schemas.md` § 1.1 supersession rule.
 * Mirrors the SQL-side `authorsWithSupersessionSelect` semantics for
 * code paths that build authors arrays in JS (continuation-chain union,
 * `?version=N` reconstruction, `metadata_restored` fallback,
 * `/api/profile/:username/papers`).
 *
 * Four cases:
 *   - hive empty/absent OR not in `orcidMap` → verified=null, discrepancy=false.
 *   - hive in `orcidMap` with null attestation → verified=null, discrepancy=false.
 *   - hive in `orcidMap` with non-null attestation, chain orcid empty →
 *     verified=attestation, discrepancy=false (no claim to compare against).
 *   - hive in `orcidMap` with non-null attestation, chain orcid non-empty AND
 *     differs from attestation → verified=attestation, discrepancy=true.
 *
 * The hive value is canonicalized via `canonicalHiveKey` before the
 * `orcidMap` lookup — see the helper's docstring for why. Callers MAY
 * pre-canonicalize (e.g., `buildCumulativeAuthorsForChain` already
 * lowercases for its own bookkeeping); canonicalizing again is idempotent.
 *
 * @param hive - the author entry's hive username; canonicalized
 *   internally via `canonicalHiveKey`. `orcidMap` keys are exact
 *   (already-lowercase) account names from `active_accreditations`.
 * @param chainOrcid - the chain-stored `authors[i].orcid` value, or null
 *   when the field is missing/empty.
 * @param orcidMap - per-accredited-account ORCID map from
 *   `getAccreditedOrcidsByAccount` (`null` value = accredited without ORCID).
 */
export function computeSupersession(
  hive: string | undefined | null,
  chainOrcid: string | undefined | null,
  orcidMap: Map<string, string | null>,
): { orcid_verified: string | null; orcid_discrepancy: boolean } {
  const key = canonicalHiveKey(hive);
  if (key === null) {
    return { orcid_verified: null, orcid_discrepancy: false };
  }
  const attested = orcidMap.has(key) ? (orcidMap.get(key) ?? null) : null;
  const claimed = typeof chainOrcid === 'string' && chainOrcid.length > 0 ? chainOrcid : null;
  const discrepancy = attested !== null && claimed !== null && attested !== claimed;
  return { orcid_verified: attested, orcid_discrepancy: discrepancy };
}

/**
 * Apply the supersession rule to a chain-shaped authors array. Returns a
 * new array (does not mutate the input). Each entry's chain fields are
 * preserved verbatim; `orcid_verified` and `orcid_discrepancy` are added
 * per the four-case rule in `computeSupersession`.
 *
 * Callers that emit PaperSummary (which omits `affiliation` per
 * `agents/docs/api-contracts/papers.md`) should strip `affiliation` from
 * the returned entries — the SQL-side helper parameterizes this via
 * `includeAffiliation`; the JS helper preserves all chain fields and
 * leaves the contract-shape enforcement to the caller (see
 * `helpers.ts:toPaperSummary` for the PaperSummary site).
 */
export function applyAuthorSupersession(
  authors: unknown,
  orcidMap: Map<string, string | null>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(authors)) return [];
  return authors.map((entry) => {
    if (!entry || typeof entry !== 'object') return {};
    const e = entry as Record<string, unknown>;
    const hive = typeof e.hive === 'string' ? e.hive : null;
    const chainOrcid = typeof e.orcid === 'string' ? e.orcid : null;
    const supersession = computeSupersession(hive, chainOrcid, orcidMap);
    return { ...e, ...supersession };
  });
}
