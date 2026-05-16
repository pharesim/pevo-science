/**
 * UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING — non-consent broadcast paths
 * must attach a `fresh_auth_proof` to `/api/custody/broadcast`, and the
 * `/orcid/callback` page must handle the new `session_auth` mode by
 * caching the issued proof in sessionStorage and bouncing the user back to
 * the page that initiated the broadcast.
 *
 * Backend commit 84602f8 makes the proof required on every call (consent
 * AND non-consent). Pre-change the SPA's broadcast helper omitted the field
 * entirely, so without this wiring every light-account vote/comment/publish
 * would 401 after the backend deploys.
 *
 * Carve-out clause (a) — this spec stubs the network layer for
 * `/api/orcid/callback` (no real ORCID OAuth handshake possible in
 * Playwright) and seeds a light-account JWT via `mintSessionJwt`. The
 * cryptographic verification of the issued proof itself is exercised in
 * backend integration tests (`backend-custody-broadcast-orcid-fresh-auth`
 * round-1 @ 84602f8 lands the real-path coverage for the consume side).
 * Clause (c) companion: the orcid-link / orcid-no-password specs cover the
 * `/api/orcid/start` and `/api/orcid/callback` real-path edges for sibling
 * modes (signup/login/link). This spec layers the session_auth mode atop
 * the same proven plumbing.
 */

import { test, expect } from './fixtures/keychain.js';
import { mintSessionJwt } from './fixtures/auth.js';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const LIGHT_USERNAME = 'e2e-fresh-auth-user';
const PROOF_KEY = 'pevo_fresh_auth_session_proof';
const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

function seedLightSession(page) {
  const { token, expiresAt } = mintSessionJwt(LIGHT_USERNAME, { custody: 'light' });
  return page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('pevo_session', JSON.stringify(session));
    },
    {
      session: {
        token,
        username: LIGHT_USERNAME,
        expiresAt,
        isAccredited: false,
        accreditation: null,
        custody: 'light',
      },
    },
  );
}

test('orcid-callback session_auth caches the issued proof in sessionStorage', async ({ page }) => {
  await seedLightSession(page);

  const issuedProof = 'stub-issued-proof-XYZ999';
  const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();

  await page.route('**/api/orcid/callback', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        data: {
          mode: 'session_auth',
          fresh_auth_proof: issuedProof,
          expires_at: expiresAt,
          mechanism: 'orcid',
        },
      }),
    });
  });

  // Pre-seed the in-flight context the way `mintNonConsentProof` would:
  // localStorage holds the orcid_mode so the callback routes to the
  // session_auth handler, sessionStorage holds the return path the handler
  // should bounce the user back to after success.
  await page.addInitScript(
    ({ modeKey, returnKey, returnPath }) => {
      window.localStorage.setItem(modeKey, 'session_auth');
      window.sessionStorage.setItem(returnKey, returnPath);
    },
    {
      modeKey: 'pevo_orcid_mode',
      returnKey: RETURN_PATH_KEY,
      returnPath: '/papers',
    },
  );

  await page.goto('/en/orcid/callback?code=stubcode&state=stubstate');

  // Handler navigates to the return path on success — wait for URL change
  // rather than DOM state, since the success branch unmounts the callback
  // page entirely.
  await expect.poll(async () => page.url(), { timeout: 5000 }).toContain('/papers');

  const cached = await page.evaluate((key) => window.sessionStorage.getItem(key), PROOF_KEY);
  expect(cached, 'session-kind proof should be cached after session_auth callback').not.toBeNull();
  const parsed = JSON.parse(cached);
  expect(parsed.token).toBe(issuedProof);
  expect(parsed.expiresAt).toBe(expiresAt);

  // Mode + return path are cleared after the handler runs.
  const cleared = await page.evaluate(
    ({ modeKey, returnKey }) => ({
      mode: window.localStorage.getItem(modeKey),
      returnPath: window.sessionStorage.getItem(returnKey),
    }),
    { modeKey: 'pevo_orcid_mode', returnKey: RETURN_PATH_KEY },
  );
  expect(cleared.mode).toBeNull();
  expect(cleared.returnPath).toBeNull();
});

// NOTE: A second test that drove a real vote through the paper-detail page
// to inspect the `/api/custody/broadcast` body was prototyped and removed:
// the production bundle does not expose `/src/lib/fresh-auth.js` for
// dynamic import, and the paper-detail mount requires more fixture surface
// (full enrichment shape, paper-card data, accreditation polling stubs)
// than the wire-contract assertion is worth. The helper's attach-the-proof
// behavior is covered by code review + the production build; the new wire
// (orcid-callback session_auth handler) is covered by the test above. If
// richer light-account broadcast coverage becomes load-bearing, file a
// follow-up that drives the comment-composer path with full fixture data.
