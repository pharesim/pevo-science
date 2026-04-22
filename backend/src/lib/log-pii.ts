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
