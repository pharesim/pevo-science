/**
 * Shared ORCID OAuth-stub bridge for E2E specs that drive a REAL ORCID
 * round-trip against the test-mode stack.
 *
 * The test stack points the backend at the compose-internal orcid-stub
 * (ORCID_BASE_URL=http://orcid-stub:8099) and orcid-works-stub
 * (ORCID_API_BASE_URL=http://orcid-works-stub:8098). No browser can reach those
 * hosts, and the SPA's open-redirect guard only allows orcid.org /
 * sandbox.orcid.org redirect hosts. This helper bridges both gaps so the real
 * /api/orcid/start -> authorize -> /api/orcid/callback round-trip completes
 * in-page.
 *
 * Registers two routes; `code` is the only lever a caller varies (the seeded iD
 * for the match case, a distinct valid-format iD for a mismatch case):
 *
 *   1. **\/api/orcid/start — the real /api/orcid/start builds redirect_url from
 *      config.orcidBaseUrl, which the test stack points at the compose-internal
 *      stub (http://orcid-stub:8099). The SPA validates the redirect host against
 *      the ORCID_REDIRECT_HOSTS allowlist (orcid.org / sandbox.orcid.org) BEFORE
 *      navigating, so an orcid-stub host throws before the browser ever leaves
 *      the app. Pass /start through to the REAL backend (it allocates the real
 *      Redis state), then rewrite ONLY the redirect_url host to orcid.org so the
 *      guard passes and the authorize navigation fires. The real `state` rides
 *      through untouched.
 *   2. **\/oauth/authorize* — no browser can reach the compose-internal stub, and
 *      the stub serves no /oauth/authorize endpoint by design. Intercept the
 *      authorize navigation, read the real `state` the backend stored in Redis,
 *      and 302 the browser to the real /orcid/callback with the given `code`. The
 *      backend exchanges that code against the stub's /oauth/token, which reflects
 *      it straight back as the `orcid` field, so the callback binds against that
 *      iD (signup mints a verified-ORCID nonce; login looks the account up by it).
 */
export async function routeOrcidStubBridge(page, baseURL, code) {
  await page.route('**/api/orcid/start', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const real = new URL(body.data.redirect_url);
    body.data.redirect_url = `https://orcid.org${real.pathname}${real.search}`;
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route('**/oauth/authorize*', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    await route.fulfill({
      status: 302,
      headers: { location: `${baseURL}/orcid/callback?code=${code}&state=${state}` },
    });
  });
}
