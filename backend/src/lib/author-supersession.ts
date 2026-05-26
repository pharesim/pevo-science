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
export function trimAsciiSpace(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

/**
 * Strip leading/trailing ASCII C-whitespace (space, tab, LF, CR, vertical
 * tab, form feed) from a string. Matches PostgreSQL's
 * `BTRIM(text, E' \t\n\r\x0B\f')` semantics exactly — the same charset
 * the SQL-side `authorsWithSupersessionSelect` projection and the
 * `authorshipClaimsCteBody` ORCID auto-accept arm reference via
 * `CHAIN_ORCID_BTRIM_CHARSET` in `hafsql.ts`. Used at JS sites that
 * compare a chain-supplied ORCID claim against a chain-validated ORCID
 * (e.g. the server-override + audit emission path in `papers.ts`).
 *
 * Distinct from `trimAsciiSpace` (U+0020 only) and JS
 * `String.prototype.trim()` (full ECMA-262 WhiteSpace). The asymmetry
 * with `.trim()` on extended Unicode whitespace (NBSP / BOM /
 * U+2028 / U+2029) is the known residual gap documented on
 * `authorsWithSupersessionSelect`; this helper deliberately matches
 * SQL semantics so the raw-compare audit path and the SQL supersession
 * path produce the same discrepancy verdict.
 */
export function trimAsciiCWhitespace(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/^[ \t\n\r\x0B\f]+|[ \t\n\r\x0B\f]+$/g, '');
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
 * The chain `orcid` is whitespace-trimmed via `String.prototype.trim()`
 * before both the empty-check AND the equality compare against the
 * attested value. A broadcaster posting `{orcid: ' '}` (whitespace-only)
 * is treated as "no claim" rather than "I claim a whitespace ORCID",
 * and a broadcaster posting `{orcid: '\t<attested>'}` for an accredited
 * account whose attested ORCID equals the trimmed value is treated as
 * "no discrepancy" rather than a whitespace-character-set-induced
 * false-positive discrepancy badge.
 *
 * Parity contract with the SQL side `authorsWithSupersessionSelect`:
 * both the no-claim guard and the equality compare apply a stripper to
 * the chain `orcid`. SQL uses `BTRIM(..., E' \t\n\r\x0B\f')` (explicit
 * ASCII C-whitespace charset, centralized as
 * `CHAIN_ORCID_BTRIM_CHARSET` in `hafsql.ts` — `\x0B` is the canonical
 * PostgreSQL hex escape for vertical-tab; PostgreSQL escape-string
 * syntax does not recognize `\v`, so the literal `E'\v'` would parse
 * as a literal `v` byte 0x76). JS uses `String.prototype.trim()` (full
 * ECMA-262 WhiteSpace set).
 *
 * The two paths agree on ASCII C-whitespace padding (space, tab, LF,
 * CR, vertical-tab, form-feed). They diverge on the following
 * extended-Unicode-whitespace code points — JS `.trim()` strips them;
 * SQL BTRIM with the ASCII C-whitespace charset does NOT:
 *   - NBSP    (U+00A0, no-break space)
 *   - BOM     (U+FEFF, byte-order mark / zero-width no-break space)
 *   - U+2028  (line separator)
 *   - U+2029  (paragraph separator)
 * A `{orcid: ' <attested>'}` payload from an accredited account
 * therefore surfaces `orcid_discrepancy=false` on this JS-projected
 * surface and `orcid_discrepancy=true` on the SQL-projected surfaces.
 * The residual gap is accepted (these code points are not a known
 * broadcaster input shape on PEvO); see
 * `agents/docs/solutions/conventions/sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md`.
 *
 * Both sides MUST apply the same stripper at both the no-claim guard
 * AND the equality compare — pairing a stripped value at one site with
 * the raw value at the other reintroduces the cross-site split for
 * whitespace-padded claims.
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
 * Resolve an author entry's display `name`, combining name-supersession with
 * the read-time fallback chain per `agents/docs/hive-schemas.md` § 1.1.
 *
 * Resolution order (first non-empty wins):
 *   1. **Attested name** — the accreditation-attested `researcher_name` when
 *      the entry's `hive` is CURRENTLY accredited (key present in `nameMap`).
 *      This is name-supersession: the accredited author's attested name is
 *      authoritative and overrides whatever the broadcaster typed. Unlike
 *      ORCID supersession, name divergence is silent — no discrepancy field,
 *      no audit event — because name variation (Rob/Robert, maiden names,
 *      transliterations, initials) is benign and high-noise.
 *   2. **Broadcaster name** — the chain-claimed `authors[i].name`.
 *   3. **Hive handle** — the entry's `hive` value, for a co-author who has a
 *      Hive account but no typed name.
 *   4. **ORCID** — last-resort identifier when nothing else is present.
 *
 * Returns `undefined` only for a fully-empty entry (no attested/broadcaster
 * name, no hive, no orcid) — such an entry names no one and is dropped by
 * the cumulative-union's name-based exit guard. The fallback makes `name`
 * satisfiable for every realistic author entry (chain is SSoT and a direct
 * Keychain broadcast can omit `name`); it is NOT a legacy-compat shim (PEvO
 * is beta — no grandfathered posts).
 *
 * **SQL parity.** The `name` projection in `authorsWithSupersessionSelect`
 * (`hafsql.ts`) mirrors this exactly via
 * `COALESCE(NULLIF(aa.researcher_name, ''), NULLIF(a.elem ->> 'name', ''),
 * NULLIF(a.elem ->> 'hive', ''), NULLIF(a.elem ->> 'orcid', ''))` — the
 * LEFT JOIN to `active_accreditations` makes arm 1 active-only, matching
 * `nameMap`'s currently-accredited-only membership. Both sides treat only an
 * exactly-empty string as absent (no whitespace trimming) so the two
 * surfaces agree on the common case; the same extended-whitespace residual
 * noted on `computeSupersession` applies but is benign for names.
 *
 * @param hive - the entry's chain `hive` value; canonicalized internally via
 *   `normalizeHiveAccount` for the `nameMap` lookup. The raw value (when a
 *   non-empty string) is the arm-3 fallback so the resolved name matches the
 *   surface's displayed `hive`.
 * @param broadcasterName - the chain-claimed `authors[i].name`.
 * @param orcid - the chain-claimed `authors[i].orcid` (arm-4 fallback).
 * @param nameMap - per-currently-accredited-account attested-name map from
 *   `getAccreditedNamesByAccount` (only non-empty attested names present).
 */
export function resolveAuthorName(
  hive: string | undefined | null,
  broadcasterName: unknown,
  orcid: unknown,
  nameMap: Map<string, string>,
): string | undefined {
  const key = normalizeHiveAccount(hive);
  if (key !== null) {
    const attested = nameMap.get(key);
    if (typeof attested === 'string' && attested.length > 0) return attested;
  }
  if (typeof broadcasterName === 'string' && broadcasterName.length > 0) return broadcasterName;
  if (typeof hive === 'string' && hive.length > 0) return hive;
  if (typeof orcid === 'string' && orcid.length > 0) return orcid;
  return undefined;
}

/**
 * Apply the supersession rule to a chain-shaped authors array. Returns a
 * new array (does not mutate the input). Each entry is projected through
 * an enumerated key set — `name`, `hive`, `orcid`, `affiliation`, plus
 * `orcid_verified` and `orcid_discrepancy` — matching the SQL-side
 * `authorsWithSupersessionSelect` projection's `jsonb_build_object` keys.
 *
 * `name` is resolved via `resolveAuthorName` (name-supersession + the
 * read-time fallback chain), so an accredited author's attested name
 * supersedes the broadcaster claim and a Hive-/ORCID-only entry still
 * surfaces a display name. See that helper for the SQL parity contract.
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
  nameMap: Map<string, string>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(authors)) return [];
  return authors.map((entry) => {
    // Non-object entries (null, strings, numbers, arrays interpreted as
    // non-object, etc.) cannot carry name/hive/orcid/affiliation fields,
    // so the projection collapses to the supersession defaults only. This
    // keeps the output shape's supersession-key set total: every returned
    // entry has both `orcid_verified` and `orcid_discrepancy` set, matching
    // the SQL-side `jsonb_build_object` projection which always emits both
    // keys (with the equivalent null/false defaults via its CASE arms).
    if (!entry || typeof entry !== 'object') {
      return { orcid_verified: null, orcid_discrepancy: false };
    }
    const e = entry as Record<string, unknown>;
    const hive = typeof e.hive === 'string' ? e.hive : null;
    const chainOrcid = typeof e.orcid === 'string' ? e.orcid : null;
    const supersession = computeSupersession(hive, chainOrcid, orcidMap);
    return {
      name: resolveAuthorName(hive, e.name, e.orcid, nameMap),
      hive: e.hive,
      orcid: e.orcid,
      affiliation: e.affiliation,
      ...supersession,
    };
  });
}
