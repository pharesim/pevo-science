/**
 * Typed-narrowing helpers for Express body-shape validation.
 *
 * Three custody routes (`/upgrade`, `/fresh-auth`, `/session-auth`) ship body-
 * shape validators that must run BEFORE their per-account limiters (the
 * layered-pattern obligation on `RateLimitConfig.skipFailedRequests`). Each
 * validator used to open with `const body = (req.body ?? {}) as Record<string,
 * unknown>` — a non-narrowing cast that silenced the checker without proving
 * the runtime shape. Subsequent property reads inherited the lie.
 *
 * The cluster of issues this module addresses:
 *
 *   - The unsafe `as` cast that silences `req.body: any` rather than narrowing it.
 *   - Length-cap policy that lived in the middleware but diverged from the
 *     handler-side defense-in-depth checks (no comment declared the divergence
 *     intentional; no test pinned which side won on oversized input).
 *   - The 3× duplication of the entry-cast + per-field length-check shape
 *     across the three validators.
 *
 * `assertBodyRecord` is the typed boundary: it returns a guaranteed
 * `Record<string, unknown>` after a runtime `typeof === 'object' && !== null`
 * check. `requireStringField` consumes the narrowed record and returns either
 * the validated string or a `{ error }` object that the caller forwards to
 * `sendError`. The discriminated return shape forces the caller to handle the
 * error case (no boolean-misuse path).
 *
 * Sharing the helper between middleware and handler also collapses the
 * middleware-vs-handler length-cap divergence: a handler-side defense-in-
 * depth check using `requireStringField` cannot diverge from its middleware
 * counterpart because both sites pass the same `maxLength` constant.
 */

import type { Request } from 'express';

/**
 * Narrow `req.body` to `Record<string, unknown>`. Returns an empty object when
 * the body parser produced a non-object (e.g., parse failure on malformed
 * JSON), so downstream `requireStringField` reads on a missing field will
 * surface the missing-field error rather than a TypeError on a null read.
 */
export function assertBodyRecord(req: Request): Record<string, unknown> {
  if (typeof req.body !== 'object' || req.body === null) return {};
  return req.body as Record<string, unknown>;
}

/** Discriminated result for {@link requireStringField}. */
export type RequireStringFieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Options for {@link requireStringField}. */
export interface RequireStringFieldOptions {
  /**
   * When `true`, the value is trimmed before the empty/length checks AND the
   * trimmed string is what the success arm returns. Use this for identifier-
   * or slug-shaped fields (account names, permlinks, pubkeys, signatures,
   * timestamps) where surrounding whitespace is never semantically part of
   * the value.
   *
   * Defaults to `false` (NO trim): the raw string is empty-checked,
   * length-checked, and returned BYTE-FOR-BYTE. This default is load-bearing
   * for credential fields. The bytes a custody re-auth route feeds to
   * `argon2.verify` must equal the bytes the signup/set-password/recover path
   * fed to `argon2.hash`; the `/login` verify path also reads the raw
   * password. Trimming a credential here would make a whitespace-bearing
   * password authenticate at `/login` but fail at `/fresh-auth` and
   * `/session-auth` (or vice-versa), a byte-exactness lockout. Leave the
   * default for any value that participates in a byte-exact comparison
   * (passwords, and any other secret compared against a stored hash).
   *
   * NOTE: even with `trim: false`, a whitespace-ONLY input is still rejected
   * (empty check sees `length === 0` only when trimmed, so the empty check
   * always trims for the rejection decision). The `trim` flag controls
   * whether the RETURNED value is trimmed, not whether whitespace-only is
   * accepted — whitespace-only is rejected for every field.
   */
  trim?: boolean;
}

/**
 * Validate that `body[fieldName]` is a non-empty string with `length <=
 * maxLength`. Returns a discriminated result; callers forward `error` to
 * `sendError(res, 400, 'VALIDATION_ERROR', error)` on the failure arm.
 *
 * Whitespace handling is governed by `options.trim`:
 *
 *   - A whitespace-ONLY input is ALWAYS rejected as missing (the empty check
 *     trims for the decision regardless of the flag).
 *   - With `trim: true` (identifier/slug-shaped fields): the value is trimmed
 *     before the length-cap check and the TRIMMED string is returned, so a
 *     cap-overshoot via padding is rejected and surrounding whitespace is
 *     stripped from the result.
 *   - With `trim: false` (the DEFAULT; credential/byte-exact fields): the RAW
 *     string is length-checked and returned byte-for-byte. Surrounding
 *     whitespace is preserved so the value matches what other paths hashed or
 *     compared against. See {@link RequireStringFieldOptions.trim}.
 *
 * The default error message is `"<fieldName> is required"`; pass `message`
 * to override (e.g., when the user-facing field name differs from the wire
 * key, as with `password` rendered "Password is required" on the custody
 * routes).
 */
export function requireStringField(
  body: Record<string, unknown>,
  fieldName: string,
  maxLength: number,
  message?: string,
  options?: RequireStringFieldOptions,
): RequireStringFieldResult {
  const raw = body[fieldName];
  if (typeof raw !== 'string') {
    return { ok: false, error: message ?? `${fieldName} is required` };
  }
  // Whitespace-only is rejected for EVERY field: the empty check always
  // trims. The `trim` flag only decides whether the surviving value is
  // returned trimmed (identifiers) or byte-for-byte (credentials).
  if (raw.trim().length === 0) {
    return { ok: false, error: message ?? `${fieldName} is required` };
  }
  const value = options?.trim ? raw.trim() : raw;
  if (value.length > maxLength) {
    return { ok: false, error: message ?? `${fieldName} is required` };
  }
  return { ok: true, value };
}
