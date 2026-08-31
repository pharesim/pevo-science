import { describe, it, expect, vi, beforeEach } from 'vitest';

// withSettingsFreshAuth orchestrates the settings-action fresh-auth flow. The
// HTTP mint lives in api.js and the ORCID-redirect + consent-op proof cache live
// in fresh-auth.js (both covered in their own suites). Mock those so these tests
// assert the orchestration: custody routing, cache reuse, factor selection,
// password re-prompt, ORCID redirect, the 401 re-mint+retry, and the 403/wrong-
// mechanism generic-failure outcome.
const mockMintSettingsActionProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintSettingsActionProof: (...a) => mockMintSettingsActionProof(...a),
  // Factor selection runs through the REAL shared resolver (importActual below),
  // which reads the account status. This mock is what the resolver sees.
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. Never called from here.
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
  mintSessionAuthProof: vi.fn(),
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
const authDisconnect = vi.fn();
const toastShow = vi.fn();
let i18nMessages = null;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'reauthModal') return { request: (...a) => reauthRequest(...a) };
      // `username` matches the LIGHT ctx below so the shared resolver's
      // username-keyed memo branches are live in this suite; without it the
      // memo is never read or written and the retry-gate reuse is untestable.
      if (name === 'auth') return { disconnect: (...a) => authDisconnect(...a), username: 'alice' };
      if (name === 'toast') return { show: (...a) => toastShow(...a) };
      if (name === 'i18n') return { messages: i18nMessages };
      return null;
    }),
  },
}));

import { withSettingsFreshAuth } from '../../src/lib/settings-fresh-auth.js';
import { clearPasswordFactorMemo } from '../../src/lib/fresh-auth.js';
import { REAUTH_PROMPT_BUSY } from '../../src/components/reauth-modal.js';

// Mirrors the real `ApiRequestError` shape (api.js): a `code` plus optional
// `details`, and crucially NO `status` field. The orchestrator's 401-retry gate
// keys on `details.reason` (the `FRESH_AUTH_REQUIRED` code already establishes
// the 401 class) — never on a `status` field. Fabricating `status` here would
// mask a regression that reintroduces a `status`-based gate (which would be dead
// against production's real shape). FRESH_AUTH_REQUIRED carries details.reason;
// other coded errors (DUPLICATE, UNAUTHORIZED) carry just a code.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

// The ctx carries no factor hint any more: the orchestrator resolves
// password-vs-ORCID through the shared resolver, so the account status is the
// only thing that moves it. These helpers set what the resolver sees.
const LIGHT = { custody: 'light', username: 'alice' };
const passwordless = () =>
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
const statusUnavailable = () => mockFetchEmailStatus.mockRejectedValue(new Error('Failed to fetch'));

describe('withSettingsFreshAuth', () => {
  let run;
  beforeEach(() => {
    mockMintSettingsActionProof.mockReset();
    mockFetchEmailStatus.mockReset();
    // The resolver memoizes a positive answer per username for the tab; drop it
    // so one test's password-holder cannot decide the next test's factor.
    clearPasswordFactorMemo();
    mockGetCachedConsentOpProof.mockReset();
    mockClearCachedConsentOpProof.mockReset();
    mockBeginOrcid.mockReset();
    reauthRequest.mockReset();
    authDisconnect.mockReset();
    toastShow.mockReset();
    i18nMessages = null;
    // Defaults: cache miss, password modal returns a password, mint succeeds,
    // ORCID begin returns the redirect-pending sentinel (null).
    mockGetCachedConsentOpProof.mockReturnValue(null);
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
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
    passwordless();
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
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

  it('a username_mismatch tears down the session and surfaces sessionInconsistent', async () => {
    // Corrupted session: the JWT subject and the proof subject diverge. Matches
    // the authorship and session-kind siblings — disconnect + re-login toast —
    // rather than the retryable freshAuthFailed "try again" outcome, so the user
    // does not retry a broken session indefinitely on a settings critical action.
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'username_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ sessionInconsistent: true });
    expect(authDisconnect).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
    // No inline retry on a corrupted session — the action ran once and stopped.
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
    passwordless();
    const out = await withSettingsFreshAuth('delete_account', LIGHT, run);
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
    passwordless();
    mockGetCachedConsentOpProof.mockReturnValue('cached-orcid-proof');
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withSettingsFreshAuth('set_password', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledWith('cached-orcid-proof');
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  // ─── Factor resolution goes through the one shared resolver ──────────────

  it('an unavailable account status falls through to the password prompt, never the ORCID redirect', async () => {
    // The failure direction the shared resolver enforces. The ORCID factor is a
    // full-page navigation that discards page state, so a transient status
    // failure must not be what fires it; the prompt runs and the backend is
    // left to reject a genuinely passwordless account.
    statusUnavailable();
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintSettingsActionProof).toHaveBeenCalledWith('change_email', 'hunter2');
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('a status response with no hasPassword field falls through to the password prompt', async () => {
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasEmail: true } });
    const out = await withSettingsFreshAuth('delete_account', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('an unavailable account status still leaves set_password on the ORCID factor', async () => {
    // The one deliberate exception: set_password targets a passwordless account
    // by definition, so it is ORCID-only regardless of what the status says (or
    // fails to say). The exception must survive the unknown-status fallthrough.
    statusUnavailable();
    const out = await withSettingsFreshAuth('set_password', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('set_password');
    expect(reauthRequest).not.toHaveBeenCalled();
  });

  it('set_password never consults the account status at all', async () => {
    const out = await withSettingsFreshAuth('set_password', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockFetchEmailStatus).not.toHaveBeenCalled();
  });

  it('an unavailable status on the 401 retry gate retries inline instead of dead-ending', async () => {
    // The retry gate reads the same resolver as the initial mint, so the two
    // cannot disagree about which factor this account has.
    statusUnavailable();
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ ok: 1 });
    mockMintSettingsActionProof.mockResolvedValueOnce('proof-1').mockResolvedValueOnce('proof-2');
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { ok: 1 } });
    expect(run).toHaveBeenNthCalledWith(2, 'proof-2');
  });

  it('the 401 retry gate reuses the memoized factor instead of a second status read', async () => {
    // The initial gate observed hasPassword true and memoized it; the retry
    // gate must ride that memo rather than spending the rate-limited status
    // budget again mid-action.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ ok: 1 });
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { ok: 1 } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  // ─── Assumed-password 401 at the mint falls back to the ORCID factor ─────

  it('an assumed password the backend rejects at the mint falls back to the ORCID redirect', async () => {
    // With the status unavailable the password factor is a guess. The mint's
    // 401 is the first hard evidence the account has no password, and a
    // second prompt would dead-end change_email / delete_account for exactly
    // the accounts whose only registered factor is ORCID. One prompt, then
    // the round-trip.
    statusUnavailable();
    mockMintSettingsActionProof.mockRejectedValue(codedError('UNAUTHORIZED'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email');
    expect(run).not.toHaveBeenCalled();
  });

  it('an observed password that 401s still re-prompts instead of redirecting', async () => {
    // The escape hatch is for guesses only: an observed password's 401 is a
    // typo and earns the second prompt.
    mockMintSettingsActionProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce('proof-ok');
    reauthRequest.mockResolvedValueOnce('wrong').mockResolvedValueOnce('right');
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { data: { ok: true } } });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('an assumed password rejected at the RETRY mint also redirects rather than dead-ending', async () => {
    // The initial proof comes from the consent-op cache (an earlier ORCID
    // round-trip), NOT from a password mint: a successful mint proves the
    // password exists and upgrades the resolver's answer to observed, after
    // which a retry 401 re-prompts. Only a still-unproven assumed password
    // may hand the retry to the ORCID round-trip.
    statusUnavailable();
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    mockMintSettingsActionProof.mockRejectedValue(codedError('UNAUTHORIZED'));
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a successful mint under an ASSUMED factor upgrades it: a retry mistype re-prompts, never redirects', async () => {
    // The initial mint succeeding IS the proof the account has a password —
    // stronger evidence than the unavailable status endpoint could give. The
    // retry gate must ride that proof (no second status fetch) and treat its
    // 401 as a typo: re-prompt inline instead of firing the full-page ORCID
    // fallback at a proven password-holder.
    statusUnavailable();
    mockMintSettingsActionProof
      .mockResolvedValueOnce('proof-1')
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockResolvedValueOnce('proof-2');
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ ok: 1 });
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ ok: { ok: 1 } });
    expect(mockBeginOrcid).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
    expect(reauthRequest).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(2, 'proof-2');
  });

  // ─── Refuse-while-open (busy) discriminates from a cancel ────────────────
  //
  // The reauth modal is a singleton; a prompt for a DIFFERENT action already
  // open resolves this one to the busy sentinel before the user ever sees it.
  // The orchestrator unwinds through the same { cancelled } outcome a cancel
  // takes — call sites need no new branch — and the busy toast is the whole
  // difference. These cases pin both halves of that discrimination; without
  // them the busy branches are deletable with every suite still green.

  it('a prompt owned by another action unwinds as { cancelled } WITH the busy toast', async () => {
    reauthRequest.mockResolvedValue(REAUTH_PROMPT_BUSY);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a plain cancel unwinds with NO toast, so busy and cancel stay distinguishable', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a busy refusal at the 401 retry gate also toasts instead of dropping silently', async () => {
    // The retry gate is a separately deletable branch from the initial one.
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    reauthRequest
      .mockResolvedValueOnce('hunter2')
      .mockResolvedValueOnce(REAUTH_PROMPT_BUSY);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an ORCID-factor 401-on-arrival is terminal, not a second redirect (re-OAuth-loop guard)', async () => {
    // Passwordless account back from an ORCID round-trip whose cached proof
    // expired before the action fired (dawdled near the 5-minute TTL). The
    // retry must NOT re-run beginSettingsActionOrcidFreshAuth (a full-page OAuth
    // redirect → re-OAuth loop); it surfaces a terminal freshAuthFailed.
    passwordless();
    mockGetCachedConsentOpProof.mockReturnValue('stale-cached-proof');
    run.mockRejectedValue(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });
});
