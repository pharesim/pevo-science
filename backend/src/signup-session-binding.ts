import crypto from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Session-binding for the signup `auth_token` flow.
 *
 * Possession of an `accounts.verify_token` value (random hex during the
 * pre-email-verify window; `confirmed:…` after `/api/auth/verify`) was the
 * sole credential for `/api/auth/confirm` and `/api/auth/link`. That made
 * the token capability-equivalent to a password: anyone who could read a
 * mailbox, observe a Referer header, or pull the token out of a login error
 * body could complete the signup with their own browser-controlled Hive
 * keys.
 *
 * The fix binds the auth_token to the browser session that initiated the
 * signup. Mechanism:
 *
 *   1. At every auth_token-issuing ceremony (`/api/auth/signup`,
 *      `/api/auth/verify`, `/api/auth/resume-signup`, and the
 *      `PENDING_SIGNUP` branch of `/api/auth/login`), the server generates a
 *      32-byte random binding value, sets it in an httpOnly cookie
 *      (`pevo_signup_session`), and stores its SHA-256 hash on the
 *      `accounts.signup_binding_hash` column for the same row.
 *
 *   2. The `/api/auth/confirm` and `/api/auth/link` handlers read the
 *      cookie, SHA-256 it, and compare against the row's stored hash. They
 *      reject any request whose cookie hash does not equal the stored hash
 *      (or whose cookie is absent, or whose row has no hash). The reject
 *      response shape is deliberately the same `400 BAD_REQUEST` as
 *      "invalid or expired auth token" — distinguishing the two would give
 *      an attacker who possesses a leaked token an oracle confirming token
 *      validity even without the binding.
 *
 *   3. The cookie scope is `path=/api/auth`, `sameSite='lax'`,
 *      `secure=isProd`, `httpOnly`, max-age 24h (matches
 *      `SIGNUP_TOKEN_EXPIRY_MS`). httpOnly defeats JS exfil; sameSite=lax
 *      defeats cross-site cookie attachment via top-level navigation while
 *      still letting the SPA's same-origin XHRs send it; path scoping keeps
 *      the cookie out of every other route's request headers.
 *
 * The cookie value never leaves the browser; only its SHA-256 hash lives
 * server-side. A DB dump of `accounts` therefore does NOT expose any
 * credential capable of completing a pending signup.
 */

const COOKIE_NAME = 'pevo_signup_session';
const COOKIE_PATH = '/api/auth';
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MintedBinding {
  /** The opaque cookie value (32 bytes, hex). Never logged, never returned to API consumers. */
  cookieValue: string;
  /** SHA-256 of `cookieValue`. Stored on `accounts.signup_binding_hash` (BYTEA). */
  hash: Buffer;
}

/**
 * Generate a fresh binding token and return both the cookie value (for
 * `setBindingCookie` to put in `Set-Cookie`) and its hash (for the route
 * handler to write to `accounts.signup_binding_hash`).
 */
export function mintBinding(): MintedBinding {
  const cookieValue = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(cookieValue).digest();
  return { cookieValue, hash };
}

/**
 * Set the binding cookie on the outgoing response. Idempotent within a
 * single response — calling twice for the same request overwrites the
 * earlier value (Express's `res.cookie()` semantics).
 *
 * `secure` mirrors the `Cookie.Secure` discipline used for the
 * authentication-session JWT path: in non-production environments (no TLS
 * termination) the flag is omitted so localhost dev / Docker still works;
 * in production behind nginx-with-TLS it MUST be on so a downgraded HTTP
 * leg cannot harvest the value.
 */
export function setBindingCookie(res: Response, cookieValue: string): void {
  res.cookie(COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

/**
 * Clear the binding cookie. Called after a successful `/confirm` or `/link`
 * (the row's `signup_binding_hash` is also nulled in the same UPDATE) so a
 * subsequent navigation from the same browser carries no stale binding.
 */
export function clearBindingCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
}

/**
 * Read the binding cookie value off an incoming request. Returns `null`
 * when the cookie is absent or empty. Cookies arrive in the `Cookie:`
 * request header; this helper parses by name without pulling in a cookie-
 * parser middleware dependency, matching the same approach used for
 * `PEVO_LOCALE` in `app.ts`.
 */
export function extractBindingCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return value.length > 0 ? value : null;
}

/**
 * Constant-time verify a candidate cookie value against the stored hash.
 *
 * `crypto.timingSafeEqual` requires equal-length inputs; both arguments are
 * 32 raw bytes by construction (SHA-256). The function returns `false` (not
 * throws) on any length mismatch so a corrupted DB column or truncated
 * input degrades to a deterministic reject rather than a 500.
 */
export function verifyBinding(cookieValue: string, storedHash: Buffer | null | undefined): boolean {
  if (!storedHash || storedHash.length !== 32) return false;
  const candidateHash = crypto.createHash('sha256').update(cookieValue).digest();
  if (candidateHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

/**
 * Cookie name exported for tests that set the cookie directly via supertest
 * `set('Cookie', ...)`. Production code paths should go through
 * `setBindingCookie` / `extractBindingCookie` and never reference the
 * cookie name directly.
 */
export const SIGNUP_BINDING_COOKIE_NAME = COOKIE_NAME;
