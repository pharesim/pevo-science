/**
 * Privacy-aware log field helpers.
 *
 * PEvO's root CLAUDE.md declares "Privacy by design" as a core principle.
 * Error logs at HTTP-surface catch sites need enough context for an operator
 * to correlate a log entry back to the affected user without leaking the
 * plaintext email to anyone with log-read access (which would turn the error
 * log into a harvestable user list).
 *
 * This module exports small, pure helpers for producing stable-but-opaque
 * per-user identifiers suitable for log correlation.
 */

import { createHash } from 'node:crypto';

/**
 * Truncated SHA-256 of an email address, suitable for log correlation
 * without exposing the plaintext address.
 *
 * Truncation length: 12 hex chars = 48 bits of entropy.
 *
 *   Collision bound: for a bounded user set of N users, the expected number
 *   of birthday-paradox collisions is approximately N^2 / 2^49. At N = 1e6
 *   users, that is roughly 1 collision — acceptable for operator correlation
 *   (an operator can always cross-reference the email_hash against the
 *   accounts table to resolve ambiguity), but NOT adequate as a forensic
 *   unique identifier. If cross-referential uniqueness across years of logs
 *   is ever required, widen the truncation (e.g. 20 hex = 80 bits).
 *
 * Normalization: the input is lowercased and trimmed before hashing so that
 * "Alice@Example.COM" and "alice@example.com " produce the same hash. Email
 * addresses are stored lowercased in our database, so this mostly guards
 * against upstream callers that haven't normalized yet.
 *
 * The 12-char output is returned lowercase hex. The hash is one-way and
 * the output does not include any substring of the input.
 */
export function hashEmailForLogs(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Nullable-input companion to `hashEmailForLogs`. Returns `null` when the
 * input is `null` or `undefined`, otherwise delegates to `hashEmailForLogs`.
 *
 * ORCID-only signups insert `accounts.email = NULL` (the user authenticated
 * via ORCID without supplying an email). Routes that catch errors after
 * looking up such a row and call `hashEmailForLogs(account.email)` would
 * synchronously throw a TypeError on `null.trim()`, converting a recoverable
 * `logger.error + 200` flow into a 500 INTERNAL_ERROR. Use this helper at any
 * log call site where the underlying column is nullable. Reserve the strict
 * `hashEmailForLogs` for sites where the email is provably non-null (e.g.,
 * accreditation `pending_accreditations.email NOT NULL`).
 */
export function safeHashEmailForLogs(
  email: string | null | undefined,
): string | null {
  if (email == null) return null;
  return hashEmailForLogs(email);
}

/**
 * Truncated SHA-256 of a verification token, suitable for log correlation
 * without exposing the plaintext token.
 *
 * Mirrors `hashEmailForLogs` (sha256 → first 12 hex chars). Used in
 * accreditation `/verify` operator-log paths where the raw 64-hex token is
 * the SOLE credential for the route — anyone with read access to operator
 * logs (aggregation pipelines, archives, third-party log SaaS) for the
 * 24h TTL window could replay the token to enqueue an `accredit`
 * `custom_json` op signed by the admin key. Logging only the hash keeps
 * the operator-correlation handle while removing the replay capability.
 *
 * Truncation length: 12 hex chars = 48 bits of entropy. Same collision
 * properties as `hashEmailForLogs` (acceptable for operator correlation,
 * inadequate for forensic uniqueness — widen if/when needed).
 *
 * No normalization step (tokens are uniformly hex-encoded by the
 * route's `crypto.randomBytes(32).toString('hex')`).
 */
export function hashTokenForLogs(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
