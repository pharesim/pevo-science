import { describe, it, expect, vi, beforeEach } from 'vitest';

// withSettingsFreshAuth orchestrates the settings-action fresh-auth flow. The
// HTTP mint lives in api.js and the ORCID-redirect + consent-op proof cache live
// in fresh-auth.js (both covered in their own suites). Mock those so these tests
// assert the orchestration: custody routing, cache reuse, factor selection,
// password re-prompt, ORCID redirect, the 401 re-mint+retry, and the 403/wrong-
// mechanism generic-failure outcome.
//
// Mocking justification (project-CLAUDE.md carve-out, clause-a): the mint
// (`mintSettingsActionProof`, a real fetch() of POST /custody/fresh-auth bound
// to a settings action) and the status read (`fetchEmailStatus`, a real
// fetch() of /settings/email) are mocked because what these cases stage is
// impractical to reproduce per-test against a live backend. A wrong password
// at the mint, an expired or mismatched proof at the action, an unreachable
// status endpoint, and a cross-tab subject change landing inside each of
// those awaits would need differently-provisioned accounts (one with a
// password, one without, one whose status read fails), a way to close a
// proof or swap the tab's JWT subject at a chosen instant, and, for the
// ORCID-start cases, observing window.location without following it.
// Clause-b: the mocked modules are mint transport + cache, not
// auth-verification paths; the proof's cryptographic binding is verified
// server-side (backend integration tests).
// Clause-c real-path companion: both factors are driven against the real
// test-mode stack. tests/e2e/settings.spec.js covers the PASSWORD factor (the
// change-email reauth modal, minting at the real POST /custody/fresh-auth),
// and tests/e2e/settings-orcid-factor.spec.js covers the ORCID factor's full
// start/callback/resume round-trip, including one case that completes on a
// genuine backend-minted proof.
const mockMintSettingsActionProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintSettingsActionProof: (...a) => mockMintSettingsActionProof(...a),
  // Factor selection runs through the REAL shared resolver (importActual below),
  // which reads the account status. This mock is what the resolver sees.
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. `consentOpRequestFields`
  // and `mintSessionAuthProof` are never called from here. `startOrcid` IS
  // exercised: the ORCID-start teardown cases below drive the real redirect
  // starter via importActual, which calls it for the start round-trip.
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
// One store object for the whole file, so what a disconnect does to it is
// still there on the next read. The liveness flip lives in the method body
// rather than in the spy's implementation, where a per-test reset or a
// one-shot override would strip it.
const authStore = {
  username: 'alice',
  isConnected: true,
  disconnect(...a) {
    this.isConnected = false;
    return authDisconnect(...a);
  },
};
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
      if (name === 'auth') return authStore;
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
  handleSessionInconsistency,
  resolvePasswordFactor,
} from '../../src/lib/fresh-auth.js';
import { REAUTH_PROMPT_BUSY } from '../../src/components/reauth-modal.js';
// The mocked start round-trip (api.js factory above): the ORCID-start cases
// park it to hold the flow at the pre-navigation boundary.
import { startOrcid } from '../../src/api.js';
// The storage half of the subject scrub, plus the two flow keys the redirect
// starter writes and the assertions below read back — all from the shared
// single source of truth, so neither the staged teardown nor the assertions
// can drift from the keys the module actually uses.
import {
  ORCID_MODE_KEY,
  RETURN_PATH_KEY,
  SUBJECT_BOUND_STORAGE_KEYS,
} from '../../src/lib/subject-bound-keys.js';

// The subject-bound scrub as this surface feels it: the exported module-state
// clears this surface can observe, plus the same storage-key removal loop the
// real auth-store scrub runs (that store's own suite drives the whole scrub end
// to end). The loop is what makes the ORCID flow keys null after a staged
// teardown here, exactly as the scrub does in production — the redirect
// starter's own unwind must never be what these assertions rest on. One piece
// the loop cannot reach is the session window's in-memory mirror, which only
// `clearCachedSessionProof` drops; this surface never populates it.
function teardownSubjectState() {
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  dismissOpenReauthPrompt();
  for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
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
  for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
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
// The self-narrating teardown's own message, distinct from the cancel above
// so a count of one can also say WHICH of the two spoke.
const INCONSISTENCY_SENTINEL = 'LOCALIZED-session-inconsistency-sentinel';

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

// `run` as the real consumers behave when the proof is falsy. The settings and
// admin API functions spread
// `...(freshAuthProof ? { fresh_auth_proof: freshAuthProof } : {})`, so an
// empty proof leaves the request carrying none at all, and the backend's
// consume check reports `missing` — a remintable reason. The suite's default
// `run` resolves for any argument it is handed, which would report an empty
// proof as a completed action: the one outcome production cannot reach.
const refusesFalsyProof = (proof) => (proof
  ? Promise.resolve({ data: { ok: true } })
  : Promise.reject(codedError('FRESH_AUTH_REQUIRED', 'missing')));

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
    authStore.isConnected = true;
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
    expect(mockBeginOrcid).toHaveBeenCalledWith('set_password', expect.any(Function));
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('passwordless change_email routes to the ORCID factor (redirect)', async () => {
    passwordless();
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email', expect.any(Function));
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

  it.each([
    { label: 'a null proof field', value: null },
    { label: 'a mint response with no proof field', value: undefined },
    { label: 'a numeric proof', value: 4242 },
  ])('a mint that answers without a proof string surfaces freshAuthFailed: $label', async ({ value }) => {
    // The redirect sentinel is `null`, the one member of the outcome vocabulary
    // a JSON response can carry, and the mint returns `fresh_auth_proof`
    // verbatim. Handed through uncoerced, a null proof reads as an ORCID
    // round-trip in flight: the caller aborts silently, no navigation happens,
    // and the user watches a correctly-answered prompt do nothing. The rows
    // drive the whole non-string class, not the null member alone, because the
    // type half of the coercion admits or refuses all of them together. `''` is
    // not one of them and has its own case: a string clears that half, and only
    // the truthiness half refuses it.
    mockMintSettingsActionProof.mockResolvedValue(value);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    // Never handed on to the action: `run(undefined)` is the self-custody shape,
    // and sending it would spend a write on a request the backend refuses.
    expect(run).not.toHaveBeenCalled();
  });

  it('a mint that answers without a proof string on the RETRY surfaces freshAuthFailed too', async () => {
    // The retry gate mints through the same callback on its own leg, and never
    // compares that result against FRESH_AUTH_REDIRECT_PENDING: the
    // `{ redirect: true }` its ladder can return belongs to the ORCID_FALLBACK
    // arm, which a null does not reach. So an uncoerced null here does not read
    // as a redirect the way the initial resolution's does; it falls past every
    // sentinel comparison into `run(retry)` and spends the action's write on a
    // token the mint has already declined to issue. A coercion applied to only
    // the first acquisition leaves that open.
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'missing'));
    mockMintSettingsActionProof
      .mockResolvedValueOnce('minted-proof')
      .mockResolvedValueOnce(null);
    const out = await withSettingsFreshAuth('change_email', LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('an empty-string mint refuses at the first leg, on one prompt and no action call', async () => {
    // Its own case rather than a fourth `it.each` row, because `''` is not a
    // member of the class those rows drive: it IS a string, so the type half
    // admits it and the outcome ladder finds it equal to none of the four
    // sentinels and reads it as a proof to act on. Past there nothing compares
    // it against a sentinel any more, only against truthiness, so the action
    // leaves with no proof field at all, the backend's consume reports
    // `missing`, and that reason is remintable: the gate re-resolves the factor
    // and mints through this same callback, asking for the password a second
    // time to obtain the same empty answer. Only the second refusal is
    // terminal. The outcome object is `{ freshAuthFailed: true }` either way,
    // and so is the re-authentication message every caller renders from it. What
    // the truthiness half removes is what this case measures: the second prompt,
    // the second mint, and the two refused writes it used to cost to reach that
    // message.
    mockMintSettingsActionProof.mockResolvedValue('');
    run.mockImplementation(refusesFalsyProof);

    const out = await withSettingsFreshAuth('change_email', LIGHT, run);

    expect(out).toEqual({ freshAuthFailed: true });
    // Never handed on: an empty proof spends the action's write for a request
    // the backend refuses, exactly as `run(undefined)` would.
    expect(run).not.toHaveBeenCalled();
    // And the refusal costs one prompt and one mint. Nothing remintable
    // reaches the retry gate, so the user is asked once.
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintSettingsActionProof).toHaveBeenCalledTimes(1);
  });

  it('an empty-string mint on the RETRY leg refuses there too', async () => {
    // The retry gate mints through the same callback, so a narrowing applied to
    // the initial resolution alone would leave this leg handing `''` into
    // `run(retry)` with the whole suite still green. That deletability is the
    // whole reason this case exists, and it is the only reason: the asymmetry
    // the null rows turn on does not carry over. A null reads as a redirect in
    // flight on the initial resolution and costs a write only on the retry,
    // where `''` clears the ladder on both legs — so for an empty proof the
    // initial resolution is the expensive one (two prompts, two refused
    // writes), and this leg spends one, after a first attempt that carried a
    // real proof and 401d on its own.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'missing'))
      .mockImplementation(refusesFalsyProof);
    mockMintSettingsActionProof
      .mockResolvedValueOnce('minted-proof')
      .mockResolvedValueOnce('');

    const out = await withSettingsFreshAuth('change_email', LIGHT, run);

    expect(out).toEqual({ freshAuthFailed: true });
    // Exactly once: the attempt that 401d. The retry never got a proof to send
    // with.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-fresh-auth error (e.g. DUPLICATE) to the caller', async () => {
    run.mockRejectedValue(codedError('DUPLICATE'));
    await expect(withSettingsFreshAuth('change_email', LIGHT, run)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  // ─── The shared retry gate's ladder, driven at its consumption site ──
  //
  // The remintable-401 ladder lives once in `consentOpFreshAuthRetryGate`
  // (fresh-auth.js) and is shared with the authorship orchestrator, so its
  // arms have a single home. Cases above already reach two of them — the
  // retry's successful `run()`, and a second FRESH_AUTH_REQUIRED out of it —
  // but three had no spec on either surface: what the retry MINT's own cancel
  // and its exhaustion resolve to, and what a NON-fresh-auth error from the
  // retry's `run()` does. These three drive exactly those, through the public
  // orchestrator, which is what puts this surface's bindings (its factor
  // resolution, its bound mint, its `run`) in the picture at all.

  it('a dismissed re-prompt on the retry unwinds as { cancelled }, not a re-auth failure', async () => {
    // Closing the SECOND prompt is the user stopping, exactly as closing the
    // first is. Reporting "re-authentication failed" for a prompt they
    // dismissed on purpose blames the account for a choice, and the busy
    // refusal's toast is what distinguishes a real refusal from this silence.
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    reauthRequest.mockResolvedValueOnce('right').mockResolvedValueOnce(null);

    const out = await withSettingsFreshAuth('change_email', LIGHT, run);

    expect(out).toEqual({ cancelled: true });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    // No second attempt: the retry had no proof to make one with.
    expect(run).toHaveBeenCalledTimes(1);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('an exhausted re-prompt on the retry surfaces freshAuthFailed', async () => {
    // Two wrong passwords AFTER the action already 401d: the re-auth could not
    // be completed. That is the generic re-auth failure, not the action's own
    // error and not a silent stop.
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    mockMintSettingsActionProof
      .mockResolvedValueOnce('proof-1')
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'));
    reauthRequest
      .mockResolvedValueOnce('right')
      .mockResolvedValueOnce('wrong1')
      .mockResolvedValueOnce('wrong2');

    const out = await withSettingsFreshAuth('change_email', LIGHT, run);

    expect(out).toEqual({ freshAuthFailed: true });
    expect(reauthRequest).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a non-fresh-auth error on the RETRY action propagates, exactly as on the first', async () => {
    // The gate re-mints and calls the action again; a DUPLICATE surfacing on
    // that second call is the action's own error and belongs to the caller's
    // per-action handling. Mapping it to freshAuthFailed would tell the user
    // to re-authenticate for a request whose re-auth worked.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockRejectedValueOnce(codedError('DUPLICATE'));

    await expect(withSettingsFreshAuth('change_email', LIGHT, run)).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
    expect(run).toHaveBeenCalledTimes(2);
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
    expect(mockBeginOrcid).toHaveBeenCalledWith('delete_account', expect.any(Function));
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
    expect(mockBeginOrcid).toHaveBeenCalledWith('set_password', expect.any(Function));
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
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email', expect.any(Function));
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
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email', expect.any(Function));
    expect(run).toHaveBeenCalledTimes(1);

    // Write-on-success, never write-on-attempt: the rejected mint proved
    // nothing, so the memo is still empty and the next resolution re-reads
    // the status. A memo written on the attempt would lock a passwordless
    // account onto a password that does not exist after its first failed
    // guess.
    expect(await resolvePasswordFactor()).toEqual({ usesPassword: true, assumed: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
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

  it('two rejections of a password the memo vouched for retire it: the next action can fall back to ORCID', async () => {
    // The memo can outlive the password it vouches for (an ORCID recovery
    // with no new password in another tab, then a same-subject re-login that
    // keeps this tab's state on purpose). A memo hit answers "observed", so
    // the assumed-401 escape never fires, and without retirement every action
    // prompts, 401s, re-prompts, and loops until a page reload. Two
    // consecutive rejections at the verifying route outrank the memo.
    mockMintSettingsActionProof.mockRejectedValue(codedError('UNAUTHORIZED'));
    expect(await withSettingsFreshAuth('change_email', LIGHT, run)).toEqual({ freshAuthFailed: true });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockBeginOrcid).not.toHaveBeenCalled();

    // The next action re-reads the status; with that read unavailable the
    // factor is a guess again, and its rejection hands the action to ORCID.
    statusUnavailable();
    expect(await withSettingsFreshAuth('change_email', LIGHT, run)).toEqual({ redirect: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
    expect(reauthRequest).toHaveBeenCalledTimes(3);
    expect(mockBeginOrcid).toHaveBeenCalledWith('change_email', expect.any(Function));
    expect(run).not.toHaveBeenCalled();
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

  it('a subject change while the guarded call is in flight stops the retry gate re-minting and reports it once', async () => {
    // The gate re-prompts and re-mints after a remintable 401. Its guard is
    // the orchestrator's, opened before run(), so a teardown that landed while
    // run() was in flight is still visible — a guard opened inside the gate
    // would not be. And the gate is the only site left that can say so: its
    // { cancelled } is silent at every call site, so its own report is the
    // whole message, and without it the user watches the action end unsaid.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
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
    // Exactly one message, and it is the teardown's.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a teardown that narrates itself is not talked over by the retry gate', async () => {
    // The gate's report is a claim as much as a message. When the teardown
    // that abandoned the action has already spoken for itself (a
    // corrupted-session disconnect on a sibling flight runs the same scrub and
    // shows its own message), the gate must find the generation claimed and
    // stay silent; a bare toast in its place would stack the vaguer message
    // on top of the one the user needs.
    i18nMessages = {
      auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL, sessionInconsistency: INCONSISTENCY_SENTINEL },
    };
    let rejectRun;
    run.mockImplementationOnce(
      () => new Promise((resolve, reject) => { rejectRun = reject; }),
    );
    // The disconnect runs the subject scrub in production; mirror that here so
    // the inconsistency report is a real teardown that then claims itself.
    authDisconnect.mockImplementationOnce(() => teardownSubjectState());

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the prompt answered, the proof minted, run() is pending
    handleSessionInconsistency();

    rejectRun(codedError('FRESH_AUTH_REQUIRED', 'expired'));

    expect(await pending).toEqual({ cancelled: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    // Exactly one message, and it is the teardown's own, not the gate's.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(INCONSISTENCY_SENTINEL, 'error');
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
    // The observed-factor sibling of the assumed-password 401 that lands
    // after a subject change: without the teardown check at the catch
    // entry, a mistyped password would open a SECOND prompt
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

  // ─── A subject change while the second attempt is in flight ──────────────
  //
  // The wrong-password re-prompt is as human-length a pause as the first
  // prompt, and the retry mint behind it reads the JWT at call time all the
  // same. These stage the same teardown one attempt later, where the second
  // prompt's resumption and the second mint's rejection are the only
  // boundaries left standing between the flow and the new subject.

  it('a password typed into the second prompt left open across a subject change does not spend a mint', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    let resolveSecondPrompt;
    reauthRequest
      .mockResolvedValueOnce('first-try')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondPrompt = resolve; }));
    mockMintSettingsActionProof.mockRejectedValueOnce(codedError('UNAUTHORIZED'));

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // the first mint 401'd; the second prompt is now open
    teardownWithoutPromptDismissal();

    resolveSecondPrompt('second-try');

    expect(await pending).toEqual({ cancelled: true });
    // The first attempt's mint stays the only one: nothing was spent on the
    // answer that arrived after the teardown.
    expect(mockMintSettingsActionProof).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a second-mint rejection landing after a subject change cancels rather than reporting a spent re-auth', async () => {
    // Without the teardown check at the second attempt's catch, the rejection
    // reads as a spent re-auth and whoever the tab now represents is told
    // "re-authentication failed" for an action the departed subject started.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    reauthRequest.mockResolvedValueOnce('first-try').mockResolvedValueOnce('second-try');
    let rejectSecondMint;
    mockMintSettingsActionProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectSecondMint = reject; }));

    const pending = withSettingsFreshAuth('delete_account', LIGHT, run);
    await tick(); // both prompts answered; the second mint is now pending
    teardownWithoutPromptDismissal();

    rejectSecondMint(codedError('UNAUTHORIZED'));

    expect(await pending).toEqual({ cancelled: true });
    expect(run).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  // ─── A subject change during the ORCID start round-trip ──────────────────
  //
  // The redirect starter awaits the start round-trip and then assigns
  // window.location; the orchestrator's own guard check sits one await
  // earlier. A teardown landing inside the round-trip therefore used to
  // navigate the new subject's tab to ORCID for the subject that left — and
  // with the flow keys already scrubbed, the return would dead-end in the
  // callback's generic error arm. These drive the REAL starter (the mock
  // delegates to it) so the pre-navigation re-check, the scrub's own key
  // removal, and the single report are all pinned end to end.

  it('an ORCID start resolving after a subject change cancels instead of navigating', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    sessionStorage.clear();
    passwordless();
    const actual = await vi.importActual('../../src/lib/fresh-auth.js');
    mockBeginOrcid.mockImplementation((...a) => actual.beginSettingsActionOrcidFreshAuth(...a));
    let resolveStart;
    startOrcid.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/settings' } });
    try {
      const pending = withSettingsFreshAuth('change_email', LIGHT, run);
      await tick(); // the start round-trip is now pending
      teardownSubjectState();

      resolveStart({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });

      expect(await pending).toEqual({ cancelled: true });
      // No navigation for the departed subject, and no flow keys left for the
      // callback to mis-dispatch on.
      expect(window.location.href).toBe('');
      expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
      expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
      expect(toastShow).toHaveBeenCalledTimes(1);
      expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the retry gate\'s ORCID fallback cancels rather than redirects when the start resolves after a subject change', async () => {
    // The gate's starter hook is the third path into the redirect, and the
    // outcome mapping is the gate's own: a stale start must come back as
    // { cancelled }, never as { redirect } for a navigation that is not
    // happening.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    sessionStorage.clear();
    statusUnavailable();
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    mockMintSettingsActionProof.mockRejectedValue(codedError('UNAUTHORIZED'));
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const actual = await vi.importActual('../../src/lib/fresh-auth.js');
    mockBeginOrcid.mockImplementation((...a) => actual.beginSettingsActionOrcidFreshAuth(...a));
    let resolveStart;
    startOrcid.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/settings' } });
    try {
      const pending = withSettingsFreshAuth('change_email', LIGHT, run);
      await tick(); // the assumed mint 401'd at the gate; the start round-trip is pending
      teardownWithoutPromptDismissal();

      resolveStart({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });

      expect(await pending).toEqual({ cancelled: true });
      expect(window.location.href).toBe('');
      expect(sessionStorage.getItem(ORCID_MODE_KEY)).toBeNull();
      expect(sessionStorage.getItem(RETURN_PATH_KEY)).toBeNull();
      expect(toastShow).toHaveBeenCalledTimes(1);
      expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
