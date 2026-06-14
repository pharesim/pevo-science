import { describe, it, expect, vi, beforeEach } from 'vitest';

// withSettingsFreshAuth orchestrates the settings-action fresh-auth flow. The
// HTTP mint lives in api.js and the ORCID-redirect + consent-op proof cache live
// in fresh-auth.js (both covered in their own suites). Mock those so these tests
// assert the orchestration: custody routing, cache reuse, factor selection,
// password re-prompt, ORCID redirect, the 401 re-mint+retry, and the 403/wrong-
// mechanism generic-failure outcome.
const mockMintSettingsActionProof = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintSettingsActionProof: (...a) => mockMintSettingsActionProof(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. Never called from here.
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
}));

// signer.js is a module-load dependency of the real fresh-auth.js; mock it so the
// partial mock below loads the real module without pulling real broadcast I/O.
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

const mockGetCachedConsentOpProof = vi.fn();
const mockClearCachedConsentOpProof = vi.fn();
const mockBeginOrcid = vi.fn();
// Partial mock: keep the REAL shared password-factor helper, outcome sentinels,
// and REMINTABLE_REASONS so the orchestrator exercises the real
// mintViaPasswordFactor and compares against the real sentinel symbols. Mock
// only the cache and the ORCID redirect.
vi.mock('../../src/lib/fresh-auth.js', async (importActual) => ({
  ...(await importActual()),
  getCachedConsentOpProof: (...a) => mockGetCachedConsentOpProof(...a),
  clearCachedConsentOpProof: (...a) => mockClearCachedConsentOpProof(...a),
  beginSettingsActionOrcidFreshAuth: (...a) => mockBeginOrcid(...a),
}));

const reauthRequest = vi.fn();
let i18nMessages = null;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'reauthModal') return { request: (...a) => reauthRequest(...a) };
      if (name === 'i18n') return { messages: i18nMessages };
      return null;
    }),
  },
}));

import { withSettingsFreshAuth } from '../../src/lib/settings-fresh-auth.js';

// Mirrors the real `ApiRequestError` shape (api.js): a `code` plus optional
// `details`, and crucially NO `status` field. The orchestrator's 401-retry gate
// keys on `details.reason` (the `FRESH_AUTH_REQUIRED` code already establishes
// the 401 class) — never on a `status` field. Fabricating `status` here would
// mask a regression that reintroduces a `status`-based gate (which would be dead
// against production's real shape). FRESH_AUTH_REQUIRED carries details.reason;
// other coded errors (DUPLICATE, UNAUTHORIZED) carry just a code.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

const LIGHT = { custody: 'light', username: 'alice', hasPassword: true };
const LIGHT_NOPW = { custody: 'light', username: 'alice', hasPassword: false };

describe('withSettingsFreshAuth', () => {
  let run;
  beforeEach(() => {
    mockMintSettingsActionProof.mockReset();
    mockGetCachedConsentOpProof.mockReset();
    mockClearCachedConsentOpProof.mockReset();
    mockBeginOrcid.mockReset();
    reauthRequest.mockReset();
    i18nMessages = null;
    // Defaults: cache miss, password modal returns a password, mint succeeds,
    // ORCID begin returns the redirect-pending sentinel (null).
    mockGetCachedConsentOpProof.mockReturnValue(null);
    reauthRequest.mockResolvedValue('hunter2');
    mockMintSettingsActionProof.mockResolvedValue('minted-proof');
    mockBeginOrcid.mockResolvedValue(null);
    run = vi.fn().mockResolvedValue({ data: { ok: true } });
  });

  it('self-custody calls run with no proof and mints nothing', async () => {
    const out = await withSettingsFreshAuth('change_email', { custody: 'self', username: 'bob' }, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(run).toHaveBeenCalledWith(undefined);
    expect(mockGetCachedConsentOpProof).not.toHaveBeenCalled();
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('light account reuses a cached consent-op proof without prompting', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(mockGetCachedConsentOpProof).toHaveBeenCalledWith('change_email', 'alice', '');
    expect(run).toHaveBeenCalledWith('cached-proof');
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockBeginOrcid).not.toHaveBeenCalled();
    // Single-use proof consumed by the backend on success → cache cleared.
    expect(mockClearCachedConsentOpProof).toHaveBeenCalled();
  });

  it('change_email on a password account mints via the password factor', async () => {
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintSettingsActionProof).toHaveBeenCalledWith('change_email', 'hunter2');
    expect(run).toHaveBeenCalledWith('minted-proof');
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('cancelling the password modal returns { cancelled } and never calls run', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('set_password is ORCID-only even when the account has a password', async () => {
    const out = await withSettingsFreshAuth('set_password', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('set_password');
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('passwordless change_email routes to the ORCID factor (redirect)', async () => {
    const out = await withSettingsFreshAuth('change_email', LIGHT_NOPW, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email');
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('re-prompts once when the entered password is wrong, then succeeds', async () => {
    mockMintSettingsActionProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce('proof-ok');
    reauthRequest.mockResolvedValueOnce('wrong').mockResolvedValueOnce('right');
    const out = await withSettingsFreshAuth('delete_account', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockMintSettingsActionProof).toHaveBeenNthCalledWith(1, 'delete_account', 'wrong');
    expect(mockMintSettingsActionProof).toHaveBeenNthCalledWith(2, 'delete_account', 'right');
    expect(run).toHaveBeenCalledWith('proof-ok');
  });

  it('a 401 missing/expired proof re-mints and retries the action once', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ ok: 1 });
    mockMintSettingsActionProof.mockResolvedValueOnce('proof-1').mockResolvedValueOnce('proof-2');
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { ok: 1 } });
    expect(mockClearCachedConsentOpProof).toHaveBeenCalled();
    expect(run).toHaveBeenNthCalledWith(1, 'proof-1');
    expect(run).toHaveBeenNthCalledWith(2, 'proof-2');
    // Re-prompt on the re-mint (the password factor re-challenges).
    expect(reauthRequest).toHaveBeenCalledTimes(2);
  });

  it('a 403 target_mismatch surfaces freshAuthFailed without retrying', async () => {
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a 401 wrong_mechanism is not re-mintable and surfaces freshAuthFailed', async () => {
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'wrong_mechanism'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a second fresh-auth rejection on the retry surfaces freshAuthFailed', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'missing'))
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-fresh-auth error (e.g. DUPLICATE) to the caller', async () => {
    run.mockRejectedValue(codedError('DUPLICATE'));
    await expect(withSettingsFreshAuth('change_email', LIGHT, run)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  // ─── Second password-mint failure maps to freshAuthFailed, never escapes ──

  it('a second wrong password surfaces freshAuthFailed (no escape to the action error)', async () => {
    mockMintSettingsActionProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'));
    reauthRequest.mockResolvedValueOnce('wrong1').mockResolvedValueOnce('wrong2');
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    // The action never ran — the mint failed before it.
    expect(run).not.toHaveBeenCalled();
  });

  it('a transport error on the second password mint surfaces freshAuthFailed (not the action error)', async () => {
    mockMintSettingsActionProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    reauthRequest.mockResolvedValueOnce('wrong').mockResolvedValueOnce('retry');
    const out = await withSettingsFreshAuth('delete_account', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).not.toHaveBeenCalled();
  });

  // ─── Action coverage across set_password / delete_account, not just change_email ──

  it('passwordless delete_account routes to the ORCID factor (redirect)', async () => {
    const out = await withSettingsFreshAuth('delete_account', LIGHT_NOPW, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('delete_account');
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a 401 expired proof on delete_account re-mints and retries once', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ ok: 1 });
    mockMintSettingsActionProof.mockResolvedValueOnce('proof-1').mockResolvedValueOnce('proof-2');
    const out = await withSettingsFreshAuth('delete_account', LIGHT, run);
    expect(out).toEqual({ ok: { ok: 1 } });
    expect(run).toHaveBeenNthCalledWith(1, 'proof-1');
    expect(run).toHaveBeenNthCalledWith(2, 'proof-2');
    expect(mockMintSettingsActionProof).toHaveBeenNthCalledWith(1, 'delete_account', 'hunter2');
    expect(mockMintSettingsActionProof).toHaveBeenNthCalledWith(2, 'delete_account', 'hunter2');
  });

  it('a 403 target_mismatch on set_password (cached ORCID proof) surfaces freshAuthFailed', async () => {
    // set_password is ORCID-only; its action runs post-redirect off a cached
    // consent-op proof. A 403 binding violation there must surface the generic
    // re-auth failure, never a silent re-redirect.
    mockGetCachedConsentOpProof.mockReturnValue('cached-orcid-proof');
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withSettingsFreshAuth('set_password', LIGHT_NOPW, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledWith('cached-orcid-proof');
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('an ORCID-factor 401-on-arrival is terminal, not a second redirect (re-OAuth-loop guard)', async () => {
    // Passwordless account back from an ORCID round-trip whose cached proof
    // expired before the action fired (dawdled near the 5-minute TTL). The
    // retry must NOT re-run beginSettingsActionOrcidFreshAuth (a full-page OAuth
    // redirect → re-OAuth loop); it surfaces a terminal freshAuthFailed.
    mockGetCachedConsentOpProof.mockReturnValue('stale-cached-proof');
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withSettingsFreshAuth('change_email', LIGHT_NOPW, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });
});
