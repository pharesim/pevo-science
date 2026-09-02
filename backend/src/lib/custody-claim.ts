/**
 * The one derivation of a session's `custody` claim from an `accounts` row.
 *
 * `custody: 'light'` in a JWT is the claim that lets the custody routes sign
 * on the account's behalf (`/api/custody/broadcast`, `/fresh-auth`,
 * `/session-auth` all require `req.hiveCustody === 'light'`); `'self'` grants
 * nothing server-side. Two columns describe that posture on the row:
 *
 *   - `upgraded_at`: the light-to-self epoch. Set by `/api/custody/upgrade`
 *     and by the signup-verify `/link` finalize, never unset. This is the
 *     column every gate that REFUSES server-side signing reads (the custody
 *     routes, the recovery paths), so it is the authoritative "the server can
 *     no longer sign for this account" signal.
 *   - `custody`: `'light'` while the server holds encrypted broadcasting keys
 *     (ARCHITECTURE.md § 6.1 states A-C), `'self'` once it does not (state D),
 *     written by the same two writers alongside `upgraded_at` and back-filled
 *     to agree with it. A schema CHECK refuses an epoch on any row whose
 *     column is not `'self'`. The column is also NULL on a row that never
 *     went through light signup at all: a pure self-custody Keychain account
 *     that registered an email through settings gets a row with a username,
 *     no password, no keys, and no custody value. The server holds nothing
 *     for that account either.
 *
 * Every session mint that reads a row (password login, ORCID login, both
 * recovery reissues) and every reader that reports custody to the SPA derives
 * the value here, so the sites cannot disagree about what one row means. The
 * rule: `'light'` is minted only from a row with no epoch AND an explicit
 * `'light'` column; everything else is `'self'`. That direction is
 * deliberate. The light claim is the one with authority attached, so an
 * epoch wins over a lagging column, and a column that is NULL or carries an
 * unexpected value falls toward the claim that grants nothing rather than
 * toward server signing. The writer sites that mint a literal claim right
 * after writing the column (`/upgrade`, `/confirm`, `/link`) do not go
 * through here; the literal IS the value they just wrote.
 */

export type CustodyClaim = 'light' | 'self';

/** The two `accounts` columns the derivation reads. `upgraded_at` is typed
 *  loosely because the row types across the mint sites annotate it as the
 *  pg-driver `Date` in some places and the ISO string in others; only its
 *  nullness matters here. */
export interface CustodyRow {
  custody: string | null;
  upgraded_at: string | Date | null;
}

export function custodyClaimFor(row: CustodyRow): CustodyClaim {
  // `!= null` on purpose: a mocked row that omits the column entirely reads
  // as `undefined`, and an absent epoch must mean "not upgraded", not "self".
  if (row.upgraded_at != null) return 'self';
  return row.custody === 'light' ? 'light' : 'self';
}
