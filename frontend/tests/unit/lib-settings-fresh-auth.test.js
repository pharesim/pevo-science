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
}));

const mockGetCachedConsentOpProof = vi.fn();
const mockClearCachedConsentOpProof = vi.fn();
const mockBeginOrcid = vi.fn();
vi.mock('../../src/lib/fresh-auth.js', () => ({
  FRESH_AUTH_REDIRECT_PENDING: null,
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

// FRESH_AUTH_REQUIRED errors carry { status, details: { reason } }; other coded
// errors (DUPLICATE, UNAUTHORIZED) just carry a code.
const codedError = (code, status, reason) =>
  Object.assign(new Error(code), { code, status, details: reason ? { reason } : undefined });

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
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 401, 'expired'))
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
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 403, 'target_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a 401 wrong_mechanism is not re-mintable and surfaces freshAuthFailed', async () => {
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 401, 'wrong_mechanism'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a second fresh-auth rejection on the retry surfaces freshAuthFailed', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 401, 'missing'))
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 403, 'target_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-fresh-auth error (e.g. DUPLICATE) to the caller', async () => {
    run.mockRejectedValue(codedError('DUPLICATE', 409));
    await expect(withSettingsFreshAuth('change_email', LIGHT, run)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});
