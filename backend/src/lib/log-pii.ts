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
 * Nullable-input companion to `hashEmailForLogs`. Returns `undefined` when
 * the input is `null` or `undefined`, otherwise delegates to
 * `hashEmailForLogs`.
 *
 * ORCID-only signups insert `accounts.email = NULL` (the user authenticated
 * via ORCID without supplying an email). Routes that catch errors after
 * looking up such a row and call `hashEmailForLogs(account.email)` would
 * synchronously throw a TypeError on `null.trim()`, converting a recoverable
 * `logger.error + 200` flow into a 500 INTERNAL_ERROR. Use this helper at any
 * log call site where the underlying column is nullable. Reserve the strict
 * `hashEmailForLogs` for sites where the email is provably non-null (e.g.,
 * accreditation `pending_accreditations.email NOT NULL`).
 *
 * Return type is `string | undefined` (not `string | null`) to match the
 * shape consumed by `LogContext.email_hash?: string` and the project-wide
 * convention of using `undefined` for "absent" structured-log fields. This
 * lets call sites assign the return value directly without a `?? undefined`
 * coercion. Pino omits `undefined` properties from emitted JSON, so the
 * resulting log payload simply lacks an `email_hash` key when the input is
 * nullish — the load-bearing privacy invariant is the absence of any
 * top-level `email` key, not the literal value of `email_hash`.
 */
export function safeHashEmailForLogs(
  email: string | null | undefined,
): string | undefined {
  if (email == null) return undefined;
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

/**
 * Full (untruncated) SHA-256 hex digest of an arbitrary string.
 *
 * Distinct from the truncated `hashEmailForLogs` / `hashTokenForLogs`
 * correlators: those sacrifice collision resistance for a compact 12-char
 * log field, whereas this returns the full 64-char digest for at-rest
 * forensic/audit storage where collision resistance is load-bearing (an
 * incident triage joining on the digest must not see distinct inputs alias).
 *
 * Callers needing nullable-input handling (e.g. a header that may be absent,
 * empty, or non-string) should wrap this in a domain-specific guard that
 * returns `undefined` for the absent case rather than threading the guard
 * through here — the digest itself is total over `string`.
 */
export function sha256HexDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Partially-redacted email for user-facing confirmation messages.
 *
 * Distinct from `hashEmailForLogs` (operator-log correlation, fully opaque).
 * This helper is for surfaces where the user needs to recognize their own
 * email but the response must not echo the full plaintext back — e.g.
 * "Verification email sent to j***h@***.edu" on `/api/auth/signup` or
 * `/api/accreditation/request`.
 *
 * Output shape:
 *   - Long local (≥3 chars): first char + '***' + last char + '@***' + tld
 *     e.g. `joseph@mit.edu` → `j***h@***.edu`
 *   - Short local (≤2 chars): first char + '***' + '@***' + tld
 *     e.g. `j@x.io` → `j***@***.io`, `jo@x.io` → `j***@***.io`
 *   - `tld` is the slice from the LAST dot in the domain (multi-dot domains
 *     get only the final TLD, e.g. `mail.example.co.uk` → `.uk`).
 *
 * Fallback shape `***@***` is returned for any input lacking exactly one `@`
 * with non-empty local + domain parts (empty string, missing `@`, multiple
 * `@`, leading/trailing `@`). Domains without a `.` get an empty tld
 * (output: `<masked>@***`).
 *
 * Three earlier copies of this helper existed in `routes/auth.ts`,
 * `routes/accreditation.ts`, and `routes/settings.ts`. The accreditation
 * copy had a dead `length <= 2` conditional (both branches produced the
 * same output, silently). The settings copy returned the full domain
 * unmasked. This canonical version replaces all three to keep masking
 * consistent across user-facing confirmation surfaces.
 */
export function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '***@***';
  const [local, domain] = parts;
  const tldIdx = domain.lastIndexOf('.');
  const tld = tldIdx >= 0 ? domain.slice(tldIdx) : '';
  const maskedLocal =
    local.length <= 2
      ? `${local[0]}***`
      : `${local[0]}***${local[local.length - 1]}`;
  return `${maskedLocal}@***${tld}`;
}
