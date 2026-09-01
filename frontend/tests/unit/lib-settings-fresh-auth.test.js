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
      // `cancel` mirrors the real store's: it resolves the parked `request()`
      // with null, which is exactly how the subject scrub unwinds an open
      // prompt in production.
      if (name === 'reauthModal') {
        return {
          request: (...a) => reauthRequest(...a),
          cancel: () => {
            const resolve = pendingPromptResolve;
            pendingPromptResolve = null;
            if (resolve) resolve(null);
          },
        };
      }
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
import {
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
  dismissOpenReauthPrompt,
} from '../../src/lib/fresh-auth.js';
import { REAUTH_PROMPT_BUSY } from '../../src/components/reauth-modal.js';

// The subject-bound scrub as this surface feels it, composed from the exported
// pieces the real auth-store scrub delegates to (that store's own suite drives
// the whole scrub end to end). The window cache and the ORCID flow keys are
// omitted: this surface touches neither.
function teardownSubjectState() {
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  dismissOpenReauthPrompt();
}

// The same teardown MINUS the prompt dismissal, for the cases that have to
// prove the generation guard alone stops the flow. With the dismissal in play
// the parked prompt resolves null and the plain-cancel branch could carry the
// unwind on its own; withholding it forces the user's answer through, which is
// the interleaving where the guard is the only thing standing between a typed
// password and a mint under the next subject.
function teardownWithoutPromptDismissal() {
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
}

// Real timers in this file; a macrotask hop lets a pending orchestration
// advance through its internal awaits to the point currently blocking it.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// Set by the tests that need to answer (or abandon) a prompt after it opens.
let pendingPromptResolve = null;

// A localized value distinct from every English fallback in the module, so an
// assertion can name WHICH message fired. Without it `expect.any(String)`
// cannot tell the teardown cancel from the busy refusal or a re-auth failure,
// and a typo in the key would serve the hardcoded fallback forever.
const TEARDOWN_CANCEL_SENTINEL = 'LOCALIZED-teardown-cancel-sentinel';

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
    pendingPromptResolve = null;
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

  it('a username_mismatch on the 401 retry tears down too, not just on the first attempt', async () => {
    // The gate's own contract is that a mismatch is a corrupted session rather
    // than a retryable re-auth failure. That has to hold on the retry leg as
    // well, or the same divergence reports as "re-authentication failed" and
    // invites the user to try again against a session no re-mint can fix.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'username_mismatch'));
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ sessionInconsistent: true });
    expect(authDisconnect).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // ─── A subject change while the prompt is open ───────────────────────────
  //
  // The prompt is a human-length pause, and the mint behind it reads the JWT
  // at call time (api.js `authenticatedRequest`). A cross-tab login as someone
  // else during that pause therefore turns an answered prompt into a mint for
  // the NEW subject, after which this orchestrator would run the FIRST
  // subject's captured action — with `delete_account` in the action set, that
  // is the most destructive surface in the app. The shared password-factor
  // mint carries the guard, so no per-orchestrator check is needed here; these
  // cases pin that it reaches this surface.

  it('a password typed into a prompt left open across a subject change does not spend a mint', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    let resolvePrompt;
    reauthRequest.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the prompt is now open
    teardownWithoutPromptDismissal();

    resolvePrompt('hunter2');

    expect(await pending).toEqual({ cancelled: true });
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    // Distinguishable from the user's own dismissal, which stays silent, and
    // named rather than merely counted: every call site treats { cancelled }
    // as a silent abort, and the busy refusal toasts the same shape from the
    // same store, so only the localized value identifies which one fired.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('the scrub dismissing the prompt reports the teardown, not a plain cancel', async () => {
    // The production shape: the scrub resolves the parked prompt with null,
    // the same value a user's Cancel produces. The teardown check has to
    // outrank the null branch, or the flow unwinds silently and the user is
    // left with a button that did nothing.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    reauthRequest.mockImplementationOnce(
      () => new Promise((resolve) => { pendingPromptResolve = resolve; }),
    );

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the prompt is now open
    teardownSubjectState();

    expect(await pending).toEqual({ cancelled: true });
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a subject change during the factor read stops the action before it prompts', async () => {
    // The status round-trip is the FIRST await of the action, and the memo is
    // empty on a fresh page load (the scrub clears it too), so it really runs.
    // A guard opened after it would compare the post-teardown generation
    // against itself and never fire, leaving the prompt to open for whoever
    // the tab now represents.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the factor read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: true } });

    expect(await pending).toEqual({ cancelled: true });
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a passwordless answer arriving after a subject change does not start an ORCID round-trip', async () => {
    // The other branch of the same await: a full-page navigation fired for the
    // subject that left, which also rewrites the ORCID flow keys the scrub
    // just cleared.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = withSettingsFreshAuth('change_email', LIGHT, run);
    await tick(); // the factor read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: false } });

    expect(await pending).toEqual({ cancelled: true });
    expect(mockBeginOrcid).not.toHaveBeenCalled();
    expect(reauthRequest).not.toHaveBeenCalled();
  });

  it('a subject change while the guarded call is in flight stops the retry gate re-minting', async () => {
    // The gate re-prompts and re-mints after a remintable 401. Its guard is
    // the orchestrator's, opened before run(), so a teardown that landed while
    // run() was in flight is still visible — a guard opened inside the gate
    // would not be.
    let rejectRun;
    run.mockImplementationOnce(
      () => new Promise((resolve, reject) => { rejectRun = reject; }),
    );

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the prompt answered, the proof minted, run() is pending
    teardownSubjectState();

    rejectRun(codedError('FRESH_AUTH_REQUIRED', 'expired'));

    expect(await pending).toEqual({ cancelled: true });
    // One prompt (the initial mint), never a second for the new subject.
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintSettingsActionProof).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a subject change while the mint is in flight does not hand the proof to the action', async () => {
    // The narrower half: the prompt is already answered and the mint round-trip
    // is pending, so dismissing the modal cannot help. The proof that lands is
    // bound to a subject this tab no longer represents and must not reach run().
    let resolveMint;
    mockMintSettingsActionProof.mockReturnValueOnce(
      new Promise((resolve) => { resolveMint = resolve; }),
    );

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the default prompt answered; the mint is now pending
    teardownWithoutPromptDismissal();

    resolveMint('late-proof');

    expect(await pending).toEqual({ cancelled: true });
    expect(run).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
  });

  it('an assumed-password 401 landing after a subject change does not start an ORCID round-trip', async () => {
    // The status read is down, so the factor is assumed; a mint 401 would
    // normally hand the action to the ORCID factor by full-page navigation.
    // Arriving after the scrub, that navigation would fire for the subject
    // that left and rewrite the flow keys the scrub just cleared.
    statusUnavailable();
    let rejectMint;
    mockMintSettingsActionProof.mockReturnValueOnce(
      new Promise((resolve, reject) => { rejectMint = reject; }),
    );

    const pending = withSettingsFreshAuth('change_email', LIGHT, run);
    await tick(); // the default prompt answered; the mint is now pending
    teardownWithoutPromptDismissal();

    rejectMint(codedError('UNAUTHORIZED'));

    expect(await pending).toEqual({ cancelled: true });
    expect(mockBeginOrcid).not.toHaveBeenCalled();
  });

  it('a wrong password whose 401 lands after a subject change does not re-prompt', async () => {
    // The observed-factor sibling of the case above: without the teardown
    // check at the catch entry, a mistyped password would open a SECOND prompt
    // — carrying the previous action's copy — for whoever the tab now
    // represents, and that prompt would then own the singleton modal.
    let rejectMint;
    mockMintSettingsActionProof.mockReturnValueOnce(
      new Promise((resolve, reject) => { rejectMint = reject; }),
    );

    const pending = withSettingsFreshAuth('change_email', LIGHT, run);
    await tick(); // the default prompt answered; the mint is now pending
    teardownWithoutPromptDismissal();

    rejectMint(codedError('UNAUTHORIZED'));

    expect(await pending).toEqual({ cancelled: true });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginOrcid).not.toHaveBeenCalled();
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
