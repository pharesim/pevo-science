/**
 * Canonical Hive permlink shape constants.
 *
 * Hive permlinks are derived from post titles by the chain's slug-normalisation:
 * lowercased, non-alphanumerics replaced with hyphens, runs collapsed. The
 * witness-imposed maximum length is 256 bytes; any longer permlink fails
 * consensus validation at broadcast time.
 *
 * Shared by URL-shape validators on `/retract` (papers.ts) and body-shape
 * validators for `root_permlink` on custody routes (custody.ts), so the
 * format and length cap cannot drift between sites that all gate on the
 * same chain-imposed constraint.
 */
export const HIVE_PERMLINK_MAX_LEN = 256;

/**
 * Lowercase alphanumeric plus hyphen, one or more characters. Pairs with
 * {@link HIVE_PERMLINK_MAX_LEN} for the full shape check. Slugs derived from
 * post titles always normalize to this character class; a permlink outside
 * it cannot resolve to a real post.
 */
export const HIVE_PERMLINK_FORMAT_REGEX = /^[a-z0-9-]+$/;
