/**
 * Canonical Hive account-name validation.
 *
 * Hive's witness-imposed account-name rules (see `chain/protocol/include/hive/protocol/validation.hpp`
 * and the consensus checks in the reference node implementation):
 *
 *   - The name is split by `.` into one or more segments.
 *   - Each segment matches `[a-z][a-z0-9-]*[a-z0-9]` (must start with a lowercase
 *     letter, must end with a lowercase letter or digit; hyphens may appear only
 *     in the interior).
 *   - Each segment is 3 to 16 chars long.
 *   - The overall account name is at most 16 chars (witness-imposed cap).
 *
 * The legacy round-2 regex `/^[a-z][a-z0-9.-]{2,15}$/` accepted canonically-invalid
 * names like `pevo.` (trailing dot), `a..b` (consecutive dots), `a-bc-` (trailing
 * hyphen), and `.abc` (leading dot). Those configured values would survive boot
 * and silently mismatch every chain query that pins on the account name (e.g.
 * `validPevoPaperWhere`'s author pin on `config.hiveBridgeAccount`), producing
 * empty result sets with no operator signal — the exact silent-zero-rows failure
 * mode the boot-time validator was filed to prevent.
 *
 * `HIVE_ACCOUNT_NAME_REGEX` below tightens to the canonical witness shape. Use it
 * when validating deploy-time configuration (env vars resolved into `config.*`
 * fields) so a misconfigured deploy fails boot loudly.
 *
 * Single source of truth — imported by:
 *   - `startup-checks.ts` (validateAccountNameFormat — boot-time deploy validation)
 *   - `routes/anonymousReview.ts` (sanitizing already-on-chain user-supplied authors)
 *
 * NOT imported by `routes/signup-verify.ts:29` — that pattern guards a different
 * surface (username-availability check on sign-up, with a stricter
 * "ends in [a-z0-9]" rule applied to a single segment without dot-separation).
 */

/**
 * Canonical Hive account-name regex. Matches dot-separated segments, each
 * `[a-z][a-z0-9-]*[a-z0-9]` of length 3-16, with overall length ≤ 16 enforced
 * by the negative lookahead `(?!.{17,})`. Segment-level length is enforced by
 * the inner repetition counter `{1,14}` (1 lowercase start + 1-14 middle chars
 * + 1 letter/digit end = 3-16 chars per segment).
 */
export const HIVE_ACCOUNT_NAME_REGEX =
  /^(?!.{17,})[a-z][a-z0-9-]{1,14}[a-z0-9](\.[a-z][a-z0-9-]{1,14}[a-z0-9])*$/;
