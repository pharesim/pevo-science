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

/**
 * Validate that `body[fieldName]` is a non-empty string with `length <=
 * maxLength`. The raw value is trimmed before the empty check, so a
 * whitespace-only input is rejected as missing; the trimmed string is what
 * the success arm returns. The length-cap check runs against the trimmed
 * value too, so a cap-overshoot via leading/trailing whitespace is also
 * rejected. Returns a discriminated result; callers forward `error` to
 * `sendError(res, 400, 'VALIDATION_ERROR', error)` on the failure arm.
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
): RequireStringFieldResult {
  const raw = body[fieldName];
  if (typeof raw !== 'string') {
    return { ok: false, error: message ?? `${fieldName} is required` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return { ok: false, error: message ?? `${fieldName} is required` };
  }
  return { ok: true, value: trimmed };
}
