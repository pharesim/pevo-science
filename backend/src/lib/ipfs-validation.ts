/**
 * Output-side IPFS CID shape validation.
 *
 * Background. PEvO's `pevo.ipfs_cid` field flows from chain `json_metadata`
 * (attacker-controlled) through `pevoString`/`safePevoMeta` and into the
 * `/api/papers/...` JSON response. The metadata helpers only enforce
 * "is-a-string"; they do NOT validate that the string is a syntactically
 * well-formed CID. A broadcaster can therefore set
 * `pevo.ipfs_cid = "Qm…\n<script>"` or `"  Qm…  "` or an arbitrary garbage
 * string, and the response will faithfully echo it. Frontend renderers and
 * downstream gateway probes then have to defend against shape they assumed
 * the backend had vetted.
 *
 * Defense. Validate the CID at every emit site against a strict regex
 * predicate; on rejection, emit `null` (not the raw value) and log a
 * structured operator warning so we can spot abuse patterns. The two CID
 * formats covered:
 *
 *   - **CIDv0:** legacy multihash, base58btc-encoded SHA-256, fixed
 *     length 46 chars, prefix `Qm`. Regex: `/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/`.
 *     The 44-char body uses base58btc's alphabet (no `0`, `O`, `I`, `l`).
 *
 *   - **CIDv1 base32:** modern multibase form prefixed `b` (lowercase),
 *     followed by base32 (RFC4648) lowercase characters. Length is variable
 *     (depends on multihash + codec), but always >= ~21 chars. Regex:
 *     `/^b[a-z2-7]{20,}$/`.
 *
 * Out of scope (deferred to a separate task if needed):
 *   - Other CIDv1 multibases (base16, base58btc-prefix-z, etc.). Pinata and
 *     our own pinner emit base32 exclusively today; broadening later is
 *     additive.
 *   - Decoding the multihash to verify hash-length and codec consistency.
 *     A well-formed-shape filter is sufficient to block log-injection /
 *     embedded-newline / XSS-injection vectors which are the immediate
 *     threat surface.
 *   - Strengthening `pevoString` itself with trim/validate (it stays
 *     permissive; CID-shape is enforced one layer up at the emit site).
 */

import { logger } from '../logger.js';

const CIDV0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CIDV1_BASE32_RE = /^b[a-z2-7]{20,}$/;

/**
 * Correlation context for `validatedCid` operator warns. Threaded into the
 * structured `paper_detail_ipfs_cid_rejected` event so operators can pivot a
 * rejected-CID anchor back to the chain post that supplied the malformed
 * value. Exported as a named interface (not inlined on the function
 * signature) so callers and tests can construct context objects against a
 * deliberate contract rather than an anonymous bag, and so editor hover
 * surfaces the type by name.
 */
export interface CidValidationContext {
  author: string;
  permlink: string;
}

/**
 * Returns true iff `cid` is a syntactically well-formed IPFS CID
 * (CIDv0 base58btc or CIDv1 lowercase-base32). Returns false on null,
 * non-string, empty, padded, or malformed input.
 *
 * Strict shape match: any leading/trailing whitespace, embedded control
 * characters, or zero-width characters cause rejection. The regex anchors
 * (`^` … `$`) ensure no padding or trailing junk is admitted.
 */
export function isValidIpfsCid(cid: unknown): boolean {
  if (typeof cid !== 'string') return false;
  if (cid.length === 0) return false;
  return CIDV0_RE.test(cid) || CIDV1_BASE32_RE.test(cid);
}

/**
 * Output-side guard: if `value` is a syntactically well-formed CID, return
 * it unchanged; otherwise, emit a `paper_detail_ipfs_cid_rejected` operator
 * warning anchor with `(author, permlink)` correlation context plus a
 * truncated raw-value prefix, and return `null`.
 *
 * Rationale. The two-phase shape (validate + warn-on-reject + clear-to-null)
 * lets us:
 *   1. Stop malformed CIDs from reaching the API response (the integrity
 *      goal of this task).
 *   2. Surface abuse patterns to operators without flooding logs (warn,
 *      not error).
 *   3. Avoid log-injection: the raw value is prefix-truncated to 32 chars
 *      so a multi-line attack payload can't widen the log line.
 *
 * `value === null` (and `value === undefined`) is a legitimate state (paper
 * has no IPFS attachment); it returns null silently with no warn emission.
 * Any other non-string runtime value (number, object, array, boolean) is a
 * defect upstream — the typeof guard fires the structured warn and clears
 * to null so the bad call site is detectable in operator logs without
 * surfacing the value to API consumers.
 *
 * The parameter is typed `unknown` (not `string | null | undefined`) so the
 * non-string defensive branch is live, not a dead type-narrowed branch.
 * This matches `isValidIpfsCid`'s signature and removes the need for `as`
 * casts at any future TS-loose call site that passes a non-string value.
 * Today's callers all funnel through `pevoString(...)` which returns
 * `string | null`, so the typeof branch is exercised only by tests and by
 * any future call site that bypasses `pevoString` — both of which we want
 * to surface, not silently coerce.
 */
export function validatedCid(
  value: unknown,
  context: CidValidationContext,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    // Defensive: today's callers pass through `pevoString`/`safePevoMeta`
    // which already string-coerce, but the `unknown` signature admits
    // future call sites that might bypass those helpers (e.g., a direct
    // JSON-metadata read in a TS-loose neighborhood). When that happens
    // we want a structured warn anchor, not a silent coercion.
    logger.warn(
      {
        event: 'paper_detail_ipfs_cid_rejected',
        author: context.author,
        permlink: context.permlink,
        raw_cid_prefix: String(value).slice(0, 32),
      },
      'paper detail emitted with non-string ipfs_cid; clearing to null',
    );
    return null;
  }
  if (isValidIpfsCid(value)) return value;
  logger.warn(
    {
      event: 'paper_detail_ipfs_cid_rejected',
      author: context.author,
      permlink: context.permlink,
      raw_cid_prefix: value.slice(0, 32),
    },
    'paper detail emitted with malformed ipfs_cid; clearing to null',
  );
  return null;
}
