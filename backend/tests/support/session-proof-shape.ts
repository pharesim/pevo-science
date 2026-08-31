/**
 * Shared wire-level assertion for `agents/docs/ARCHITECTURE.md` § 6.5
 * invariant #9: establishing or reissuing a session never hands the client a
 * session-proof grant.
 *
 * Deliberately a deep walk over the whole response rather than a check on
 * `data.fresh_auth_proof`. The field's placement is not the invariant — a proof
 * handed back under `data.session.fresh_auth_proof`, beside a reissued token,
 * renamed to `session_proof`, or set as a cookie breaks the invariant just as
 * completely as one at the documented path, and a path-specific assertion
 * passes for all of them.
 *
 * Two independent tells, because each covers the other's blind spot: what the
 * field is CALLED, and what the value IS.
 */
import { expect } from 'vitest';
import { SIGNUP_BINDING_COOKIE_NAME } from '../../src/signup-session-binding.js';

/** A key that NAMES a session proof. Hyphens AND underscores are stripped
 *  before matching, so `fresh_auth_proof`, `freshAuthProof` and a header or
 *  cookie spelled `X-Fresh-Auth-Proof` are one key to this check. */
const PROOF_NAME_RE = /freshauth|sessionproof/;

const normalizeKey = (key: string): string => key.replace(/[-_]/g, '').toLowerCase();

/** A value SHAPED like a session proof. `issueSessionFreshAuthToken` mints
 *  `crypto.randomBytes(TOKEN_BYTES).toString('hex')` with TOKEN_BYTES = 32, so
 *  the proof is exactly 64 hex characters and nothing else. The token IS the
 *  store key the consume path looks up, so a regression cannot re-encode it and
 *  still have a client that works.
 *
 *  Why shape matters as much as name: a regression that returns the proof as
 *  `proof`, `reauth_token` or `broadcast_token` renames the field but cannot
 *  change what it is, and a name-only check waves all three through.
 *
 *  Bounded on both sides by a non-hex character and matched as a SUBSTRING, not
 *  against the whole string. The boundaries keep a longer digest from matching a
 *  64-char slice of itself (a 128-char sha512 does not match; the 32-char ORCID
 *  state does not match). The substring form is what reaches a proof that never
 *  occupies a whole field: a `Set-Cookie` value, or a redirect carrying it as a
 *  query parameter.
 *
 *  It cannot collide with the JWT these routes return beside it. A JWT is
 *  base64url in three period-separated segments; a period is non-hex, so a run
 *  cannot cross a segment boundary, an HS256 signature segment is 43 characters,
 *  and the header and payload segments encode ASCII JSON, which emits non-hex
 *  characters densely. Case-insensitive because a re-encoding helper could
 *  upper-case the hex. The other base64 strings on these responses, express's
 *  weak ETag and helmet's CSP script hash, are 27 and 44 characters and cannot
 *  reach 64. */
const PROOF_VALUE_RE = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

/** Assert that nothing in a response — body, headers, or cookies — looks like a
 *  session-proof grant. Pass the whole supertest response, not just its body:
 *  a proof delivered as a header or a cookie reaches the client exactly as
 *  completely as one in the JSON. */
export function expectNoSessionProof(
  res: { body?: unknown; headers?: Record<string, string | string[] | undefined> },
  label: string,
): void {
  const offenders: string[] = [];
  const checkValue = (value: unknown, path: string): void => {
    if (typeof value === 'string' && PROOF_VALUE_RE.test(value)) {
      offenders.push(`${path} (proof-shaped value)`);
    }
  };
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') {
      checkValue(node, path);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (PROOF_NAME_RE.test(normalizeKey(key))) {
        offenders.push(`${path}.${key} (proof-shaped name)`);
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(res.body, `${label} body`);

  for (const [name, raw] of Object.entries(res.headers ?? {})) {
    if (PROOF_NAME_RE.test(normalizeKey(name))) {
      offenders.push(`${label} header ${name} (proof-shaped name)`);
    }
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const isSetCookie = name.toLowerCase() === 'set-cookie';
    values.forEach((value, i) => {
      const where = `${label} header ${name}[${i}]`;
      if (!isSetCookie) {
        checkValue(value, where);
        return;
      }
      // A cookie's own name lives inside the header VALUE, so the name tell has
      // to be applied to it explicitly. Without this, a proof returned as a
      // cookie named for the fresh-auth layer matches neither tell: the header
      // name is `set-cookie` and a re-encoded value is not hex.
      const cookieName = value.split('=', 1)[0].trim();
      if (PROOF_NAME_RE.test(normalizeKey(cookieName))) {
        offenders.push(`${where} cookie ${cookieName} (proof-shaped name)`);
      }
      // `mintBinding` emits the SAME 32-byte-hex shape for the signup-session
      // binder. It is not a broadcast credential: httpOnly, scoped to
      // /api/auth, and only ever compared against `accounts.signup_binding_hash`.
      // Its VALUE is exempt by cookie name so this helper stays safe to point at
      // a route that mints one; its NAME is still checked above, and every other
      // cookie is fully scanned.
      if (cookieName === SIGNUP_BINDING_COOKIE_NAME) return;
      checkValue(value, where);
    });
  }

  expect(
    offenders,
    `${label} carries a session-proof grant. Only an explicit re-auth act may ` +
      'open a broadcast window (ARCHITECTURE.md § 6.5 invariant #9); a session ' +
      'established by logging in, finalizing or linking a signup, presenting a ' +
      'Hive signature, refreshing a token, upgrading custody, or recovering an ' +
      `account must not come with one attached:\n${offenders.join('\n')}\n\n` +
      `body:\n${JSON.stringify(res.body, null, 2)}\n\n` +
      `headers:\n${JSON.stringify(res.headers, null, 2)}`,
  ).toEqual([]);
}
