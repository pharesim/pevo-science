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
 * Hive consensus restricts account names to `[a-z0-9.-]`. The chain enforces
 * this at the op layer, so every `account` value in `active_accreditations`
 * conforms by construction. Chain `json_metadata` payloads
 * (`authors[i].hive`) are broadcaster-controlled and may carry mixed-case,
 * space-padded, or otherwise malformed variants. This regex is the
 * normalize-and-validate boundary: anything that does not match (after
 * lowercase + ASCII-space trim) is rejected as "not a valid Hive account
 * reference."
 */
const HIVE_ACCOUNT_RE = /^[a-z0-9.-]+$/;

/** Strip leading/trailing ASCII space (U+0020) only. Matches PostgreSQL's
 *  `TRIM(text)` semantics exactly — `TRIM` with no character-set arg strips
 *  only U+0020, not the broader ECMA-262 WhiteSpace set that JS
 *  `String.prototype.trim()` covers (tab, LF, CR, NBSP, BOM, U+2028/2029,
 *  etc.). Using the broader JS trim here would create cross-surface drift:
 *  `'\tbob'` would normalize to `bob` in JS but stay `\tbob` in SQL. */
function trimAsciiSpace(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

/**
 * Normalize a chain-metadata `hive` value to its lookup-canonical form, or
 * return `null` when the value cannot represent a real Hive account.
 *
 * Returns `null` for:
 *   - non-string inputs
 *   - strings that canonicalize to empty after lowercase + ASCII-space trim
 *   - strings that contain characters outside Hive's account-name charset
 *     `[a-z0-9.-]` after canonicalization (this rejects mixed-whitespace
 *     inputs like `'\tbob'` or `'bob\n'`, and broadcaster typos like
 *     `'al;ice'`)
 *
 * The last rule is the load-bearing one: it rejects malformed broadcaster
 * input at the boundary so a co-author entry like `{hive: '\tAlice'}` or
 * `{hive: 'al;ice'}` cannot silently lookup against the accreditation map.
 * Without this rejection, the SQL-side and JS-side normalization shapes
 * could diverge — PostgreSQL `TRIM()` strips only ASCII space (U+0020),
 * while JS `String.prototype.trim()` strips the full ECMA-262 WhiteSpace
 * set. Rejecting at the boundary eliminates the asymmetry: both sides
 * agree such inputs do not name a real account.
 *
 * The SQL-side LEFT JOIN in `authorsWithSupersessionSelect` uses
 * `LOWER(TRIM(...)) ~ '^[a-z0-9.-]+$'` as the parity-symmetric guard. The
 * two paths MUST stay in lockstep; the parity is the contract.
 */
export function normalizeHiveAccount(hive: unknown): string | null {
  if (typeof hive !== 'string') return null;
  const norm = trimAsciiSpace(hive.toLowerCase());
  if (norm.length === 0) return null;
  if (!HIVE_ACCOUNT_RE.test(norm)) return null;
  return norm;
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
 *   - hive empty/absent/malformed OR not in `orcidMap` → verified=null, discrepancy=false.
 *   - hive in `orcidMap` with null attestation → verified=null, discrepancy=false.
 *   - hive in `orcidMap` with non-null attestation, chain orcid empty/whitespace-only →
 *     verified=attestation, discrepancy=false (no claim to compare against).
 *   - hive in `orcidMap` with non-null attestation, chain orcid non-empty AND
 *     differs from attestation → verified=attestation, discrepancy=true.
 *
 * The hive value is canonicalized via `normalizeHiveAccount` before the
 * `orcidMap` lookup — see the helper's docstring for why. Callers MAY
 * pre-canonicalize; doing so again is idempotent.
 *
 * The chain `orcid` is whitespace-trimmed before the empty-check. A
 * broadcaster posting `{orcid: ' '}` (whitespace-only) is treated as "no
 * claim" rather than "I claim a whitespace ORCID" — matches the SQL-side
 * `NULLIF(BTRIM(...), '')` guard.
 *
 * @param hive - the author entry's hive username; canonicalized
 *   internally via `normalizeHiveAccount`. `orcidMap` keys are exact
 *   (already-lowercase) account names from `active_accreditations`.
 * @param chainOrcid - the chain-stored `authors[i].orcid` value, or null
 *   when the field is missing/empty/whitespace-only.
 * @param orcidMap - per-accredited-account ORCID map from
 *   `getAccreditedOrcidsByAccount` (`null` value = accredited without ORCID).
 */
export function computeSupersession(
  hive: string | undefined | null,
  chainOrcid: string | undefined | null,
  orcidMap: Map<string, string | null>,
): { orcid_verified: string | null; orcid_discrepancy: boolean } {
  const key = normalizeHiveAccount(hive);
  if (key === null) {
    return { orcid_verified: null, orcid_discrepancy: false };
  }
  const attested = orcidMap.has(key) ? (orcidMap.get(key) ?? null) : null;
  const trimmedOrcid =
    typeof chainOrcid === 'string' && chainOrcid.trim().length > 0 ? chainOrcid.trim() : null;
  const discrepancy = attested !== null && trimmedOrcid !== null && attested !== trimmedOrcid;
  return { orcid_verified: attested, orcid_discrepancy: discrepancy };
}

/**
 * Apply the supersession rule to a chain-shaped authors array. Returns a
 * new array (does not mutate the input). Each entry is projected through
 * an enumerated key set — `name`, `hive`, `orcid`, `affiliation`, plus
 * `orcid_verified` and `orcid_discrepancy` — matching the SQL-side
 * `authorsWithSupersessionSelect` projection's `jsonb_build_object` keys.
 *
 * The enumerated projection is load-bearing: it pins the JS-side output
 * shape to the same key set the SQL side emits, so a broadcaster posting
 * `authors: [{hive: 'alice', orcid: '...', evil_field: 'payload'}]` cannot
 * leak `evil_field` through the JS-projected response surfaces
 * (`/api/profile/:username/papers`, chain-detail fallbacks). Prior shape
 * (`{ ...entry, ...supersession }`) spread-merged every chain field.
 *
 * Callers that emit PaperSummary (which omits `affiliation` per
 * `agents/docs/api-contracts/papers.md`) should strip `affiliation` from
 * the returned entries — the SQL-side helper parameterizes this via
 * `includeAffiliation`; the JS helper retains `affiliation` so PaperDetail
 * fallback consumers reuse it unchanged. `helpers.ts:toPaperSummary` is
 * the PaperSummary affiliation-strip site.
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
    return {
      name: e.name,
      hive: e.hive,
      orcid: e.orcid,
      affiliation: e.affiliation,
      ...supersession,
    };
  });
}
