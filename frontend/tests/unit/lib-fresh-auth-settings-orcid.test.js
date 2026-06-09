// Direct unit coverage for `beginSettingsActionOrcidFreshAuth` in
// `frontend/src/lib/fresh-auth.js` — the settings-action ORCID fresh-auth mint
// entry point (the only factor for `set_password`, the fallback for passwordless
// `change_email` / `delete_account`). The orchestrator that calls it
// (lib-settings-fresh-auth.test.js) mocks this module out, so its open-redirect
// host-allowlist gate and sessionStorage cleanup-on-error had no direct guard.
//
// Mocking justification (project-CLAUDE.md "Carve-out for deterministic
// edge-case coverage", clause a): `startOrcid` performs a real fetch() against
// the backend `/api/orcid/start` endpoint; exercising it per-test would need a
// running backend + ORCID stack and the ability to induce a non-allowlisted
// redirect host — an open-redirect response the real backend never emits. We
// mock api.js#startOrcid to return crafted redirect URLs deterministically and
// assert the host-allowlist gate + sessionStorage cleanup. signer.js is stubbed
// only so the fresh-auth.js module import resolves (this function never calls
// broadcastOps); alpinejs is stubbed for the same reason.
//
// Auth-focus carve-out (clause b): this function is not itself an
// auth-verification path — it initiates an OAuth redirect; the cryptographic
// fresh_auth_proof is minted and verified server-side. No frontend auth
// middleware is mocked. Clause-c real-path companion: the settings-action ORCID
// factor is driven end-to-end against the real backend by the E2E settings spec.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStartOrcid = vi.fn();
vi.mock('../../src/api.js', () => ({
  startOrcid: (...args) => mockStartOrcid(...args),
}));
// fresh-auth.js imports broadcastOps from signer.js at module load; stub it so
// the import resolves. beginSettingsActionOrcidFreshAuth never calls it.
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: vi.fn(() => ({})) } }));

const { beginSettingsActionOrcidFreshAuth, FRESH_AUTH_REDIRECT_PENDING } =
  await import('../../src/lib/fresh-auth.js');

const MODE_KEY = 'pevo_orcid_mode';
const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

describe('beginSettingsActionOrcidFreshAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    // Stub window.location so the redirect assignment is observable and does not
    // trigger jsdom navigation. Mirrors pages-settings.test.js handleOrcidLink.
    // No `pathname`, so the return path falls back to '/settings'.
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to an allowlisted ORCID host, persists markers, returns the pending sentinel', async () => {
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });

    const res = await beginSettingsActionOrcidFreshAuth('set_password');

    expect(res).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(mockStartOrcid).toHaveBeenCalledWith('fresh_auth', { action: 'set_password' });
    expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
    // Mode marker + return path persisted for the /orcid/callback handler to
    // dispatch on and bounce back to.
    expect(sessionStorage.getItem(MODE_KEY)).toBe('fresh_auth');
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBe('/settings');
  });

  it('accepts the sandbox ORCID host', async () => {
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://sandbox.orcid.org/oauth' });

    const res = await beginSettingsActionOrcidFreshAuth('change_email');

    expect(res).toBe(FRESH_AUTH_REDIRECT_PENDING);
    expect(window.location.href).toBe('https://sandbox.orcid.org/oauth');
  });

  it('rejects a non-allowlisted redirect host without navigating, and clears markers', async () => {
    mockStartOrcid.mockResolvedValue({ redirect_url: 'https://evil.example.com/phish' });

    await expect(beginSettingsActionOrcidFreshAuth('delete_account'))
      .rejects.toThrow('Invalid ORCID redirect URL');

    // No navigation occurred — open-redirect defense held.
    expect(window.location.href).toBe('');
    // Rejection cleans up the mode marker and return path so a later flow cannot
    // read a stale 'fresh_auth' dispatch / return target.
    expect(sessionStorage.getItem(MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
  });

  it('rejects an unparseable redirect URL without navigating, and clears markers', async () => {
    mockStartOrcid.mockResolvedValue({ redirect_url: 'not-a-url' });

    await expect(beginSettingsActionOrcidFreshAuth('change_email'))
      .rejects.toThrow('Invalid ORCID redirect URL');

    expect(window.location.href).toBe('');
    expect(sessionStorage.getItem(MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
  });

  it('cleans up sessionStorage when startOrcid throws (no orphaned mode marker)', async () => {
    mockStartOrcid.mockRejectedValue(new Error('network down'));

    await expect(beginSettingsActionOrcidFreshAuth('set_password'))
      .rejects.toThrow('network down');

    expect(sessionStorage.getItem(MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
    expect(window.location.href).toBe('');
  });
});
