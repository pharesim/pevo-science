/**
 * Auth helpers for E2E write-flow specs.
 *
 * Problem: write flows require a logged-in, accredited user, but the Keychain
 * stub cannot produce a valid Hive signature (see keychain.js). So we bypass
 * the Hive-signature path by minting a JWT directly with SESSION_SECRET and
 * seeding it into localStorage before the app boots.
 *
 * The backend's verifyHiveSignature middleware accepts `Authorization: Bearer
 * <jwt>` as an alternative to a Hive signature, so authenticated API calls
 * (IPFS upload, etc.) succeed as long as the account is accredited on HAF.
 *
 * Accreditation itself lives in HAF (chain custom_json) and is shared
 * read-only with the dev env — we don't mint new accreditations; we pick
 * an already-accredited account via /api/accreditations.
 */

import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(__dirname, '..', '..', '..');

/**
 * Parse a minimal `KEY=VALUE` env file. Strips surrounding quotes and any
 * trailing inline `# comment` suffix, but honours `#` inside quoted values.
 * Kept hand-rolled (dotenv is not a declared dep) — fix the corner cases the
 * raw `.trim()`/quote-strip pipeline missed.
 *
 * Exported for unit coverage; production call sites use it internally.
 */
export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip inline `# comment` suffix, but only when the `#` is not inside a
    // quoted string. `SESSION_SECRET=abc # dev` → `abc`; `X="a # b"` → `a # b`.
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closingIdx = value.indexOf(quote, 1);
      if (closingIdx !== -1) {
        value = value.slice(1, closingIdx);
      } else {
        value = value.slice(1);
      }
    } else {
      const hashIdx = value.indexOf('#');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }

    out[key] = value;
  }
  return out;
}

let cachedSecret = null;

/**
 * Resolve the SESSION_SECRET the running backend is using. Priority:
 *   1. process.env.SESSION_SECRET (explicit override)
 *   2. frontend/.env.test
 *
 * We deliberately do NOT fall back to the repo-root `.env`. That file holds the
 * real dev/prod SESSION_SECRET in every environment that mounts the workspace,
 * and this helper mints JWTs the backend accepts as genuine auth. If CI (or a
 * dev laptop pointed at a remote backend) picked up a production SESSION_SECRET
 * via silent fallback, the JWT would authenticate against the live deployment.
 * Surfaced by FE-E2E-AUTH-FIXTURE-HARDEN action #3.
 */
export function getSessionSecret() {
  if (cachedSecret !== null) return cachedSecret;

  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const testEnv = parseEnvFile(resolve(FRONTEND_ROOT, '.env.test'));
  if (testEnv.SESSION_SECRET) {
    cachedSecret = testEnv.SESSION_SECRET;
    return cachedSecret;
  }

  throw new Error(
    '[e2e auth] SESSION_SECRET not found. Set process.env.SESSION_SECRET ' +
      'or populate frontend/.env.test (see frontend/.env.test.example). ' +
      'The repo-root .env fallback has been removed: it holds the real dev/prod ' +
      'secret and would let E2E mint JWTs the live backend accepts as genuine auth.',
  );
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Mint a HS256 JWT compatible with the backend's `verifyHiveSignature` Bearer
 * path. Matches the shape of tokens issued by `/api/auth/session`.
 */
export function mintSessionJwt(username, { custody = 'self', expiresInSec = 3600 } = {}) {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: username, custody, iat: now, exp: now + expiresInSec };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest();
  return {
    token: `${encoded}.${base64url(sig)}`,
    expiresAt: new Date((now + expiresInSec) * 1000).toISOString(),
  };
}

/**
 * Pick an already-accredited researcher from HAF and return the info the
 * frontend would normally populate into the session on login.
 *
 * Returns null if HAF has no accreditations (CI misconfigured).
 */
export async function pickAccreditedResearcher(request) {
  // HAF reads can transiently fail or time out when multiple Playwright
  // workers query concurrently (/api/accreditations proxies to HAF SQL).
  // Retry with backoff so the spec-level assertion "at least one accredited
  // researcher" stays deterministic under the default parallel worker count.
  const attempts = 4;
  for (let i = 0; i < attempts; i++) {
    const picked = await pickAccreditedResearcherOnce(request);
    if (picked) return picked;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

async function pickAccreditedResearcherOnce(request) {
  const listResp = await request.get('/api/accreditations?limit=10');
  if (!listResp.ok()) return null;
  const list = (await listResp.json()).data || [];
  if (list.length === 0) return null;

  // Re-fetch via the status endpoint — that's the shape auth.js actually
  // saves into the session (the list endpoint uses a slightly leaner shape).
  for (const r of list) {
    const statusResp = await request.get(`/api/accreditations/${encodeURIComponent(r.username)}`);
    if (!statusResp.ok()) continue;
    const status = (await statusResp.json()).data;
    if (status?.is_accredited) {
      return { username: status.username, accreditation: status.accreditation };
    }
  }
  return null;
}

/**
 * Seed `localStorage.pevo_session` with a valid JWT before the app boots, so
 * the auth store's `_restoreSession()` picks it up on load. Must be called
 * before `page.goto()`.
 */
export async function seedAccreditedSession(page, { username, accreditation, custody = 'self' }) {
  const { token, expiresAt } = mintSessionJwt(username, { custody });
  const session = {
    token,
    username,
    expiresAt,
    isAccredited: true,
    accreditation,
    custody,
  };
  await page.addInitScript((s) => {
    window.localStorage.setItem('pevo_session', JSON.stringify(s));
  }, session);
  return { token, expiresAt };
}

/**
 * Seed a connected-but-not-accredited session. Useful for accreditation-
 * request flows: the form requires `isConnected` but is gated behind
 * `!isAccredited`. The username does not have to exist in HAF — the
 * accreditation-status endpoint returns `is_accredited: false` for any
 * unknown account, which keeps the form visible.
 */
export async function seedUnaccreditedSession(page, { username, custody = 'self' } = {}) {
  const actualUsername = username || `e2eunaccr${Date.now().toString(36)}`;
  const { token, expiresAt } = mintSessionJwt(actualUsername, { custody });
  const session = {
    token,
    username: actualUsername,
    expiresAt,
    isAccredited: false,
    accreditation: null,
    custody,
  };
  await page.addInitScript((s) => {
    window.localStorage.setItem('pevo_session', JSON.stringify(s));
  }, session);
  return { token, expiresAt, username: actualUsername };
}

/**
 * Minimal valid PDF bytes — passes the backend's `%PDF-` magic-byte check and
 * the IPFS upload MIME filter without shipping a real PDF fixture on disk.
 */
export function minimalPdfBuffer() {
  const pdf =
    '%PDF-1.0\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\n' +
    'xref\n' +
    '0 4\n' +
    '0000000000 65535 f\n' +
    '0000000010 00000 n\n' +
    '0000000053 00000 n\n' +
    '0000000102 00000 n\n' +
    'trailer<</Size 4/Root 1 0 R>>\n' +
    'startxref\n' +
    '149\n' +
    '%%EOF\n';
  return Buffer.from(pdf, 'utf8');
}
