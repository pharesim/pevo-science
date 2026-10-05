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
 *     column is not `'self'`. The column is also NULL on a finalized row that
 *     never went through light signup at all (§ 6.1 state G): a Keychain account
 *     that registered an email through settings gets a row with a username,
 *     no password, no keys, and no custody value. The server holds nothing
 *     for that account either.
 *
 * Every session mint that reads a row (password login, ORCID login, both
 * recovery reissues) and every reader that reports custody to the SPA derives
 * the value here, so two sites handed the SAME row snapshot cannot disagree
 * about what it means. That guarantee is per-read, not per-account. The
 * rule: `'light'` is minted only from a row with no epoch AND an explicit
 * `'light'` column; everything else is `'self'`. That direction is
 * deliberate. The light claim is the one with authority attached, so an
 * epoch wins over a lagging column, and a column that is NULL or carries an
 * unexpected value falls toward the claim that grants nothing rather than
 * toward server signing. The writer sites that mint a literal claim right
 * after writing the column (`/upgrade`, `/confirm`, `/link`) do not go
 * through here; the literal IS the value they just wrote.
 *
 * What "per-read" excludes: a handler that reads the row and then awaits
 * before deriving is working from a snapshot, and an upgrade can commit inside
 * that await. The password login awaits `argon2.verify` (which queues behind
 * the argon2 semaphore) between its SELECT and this call, and both recovery
 * reissues await a factor proof and their own UPDATE, so each can mint
 * `'light'` for an account that is already self-custody. The window predates
 * this helper and the helper does not close it. It does not need to, because
 * the claim is not the authority. Such a token carries no `reissuedAt`, so the
 * session-invalidation epoch revokes it whenever the mint lands in the same
 * integer second the upgrade stamped; a mint landing in a later second
 * survives that check and is refused instead at the route it is presented to.
 * Every route that ACTS on a light claim (`/api/custody/broadcast`,
 * `/fresh-auth`, `/session-auth`, `/upgrade`) re-reads the row itself and
 * refuses it unless this helper derives `'light'` from that read. A row that
 * carries an epoch is answered first, by the route's own `upgraded_at` branch;
 * a row that never was light (§ 6.1 state G) has no epoch and is refused by
 * the derived claim. The encrypted keys a stale light claim would unlock on an
 * upgraded row were nulled by the upgrade in the statement that set the epoch.
 *
 * One consumer carries the claim without acting on it, so the guarantee is not
 * universal over consumers: `POST /api/auth/session` re-mints whatever
 * `custody` the presented token holds into a fresh token with a new `iat` and
 * a full expiry. Its handler reads no `accounts` row; the row its request does
 * read is the one `verifyHiveSignature` reads for `sessions_invalidated_at`,
 * which is a revocation check and never looks at `upgraded_at`. So a stale
 * `'light'` that already survived the revocation epoch is copied forward and
 * its clock restarts. That copy grants nothing SERVER-SIDE, which is the
 * scope of this whole docblock: the response hands the value back to the
 * client, but spending a light claim still means reaching
 * `/api/custody/broadcast`, `/fresh-auth`, `/session-auth` or `/upgrade`, and
 * each of those re-reads the row the copy names and refuses it unless the
 * claim derived here from that read is `'light'`.
 */

export type CustodyClaim = 'light' | 'self';

/** The two `accounts` columns the derivation reads.
 *
 *  `upgraded_at` is typed loosely because its declared shape and its runtime
 *  shape differ. Every row type at the calling sites annotates the column
 *  `string | null`. The column is `TIMESTAMPTZ`, and this backend registers no
 *  `setTypeParser`, so node-postgres decodes it with the default timestamptz
 *  parser and hands back a `Date` on every read at every one of those sites.
 *  The union spans both spellings so each caller can pass its row in as it is
 *  typed, rather than through a cast asserting something the value does not
 *  satisfy. Only nullness is read here, so the difference cannot change the
 *  claim. */
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
