import { describe, it, expect, vi, beforeEach } from 'vitest';

// withAuthorshipFreshAuth orchestrates the authorship consent/credit fresh-auth
// flow (Routes 2 & 3). The HTTP mint lives in api.js and the ORCID redirect +
// target-bound proof cache live in fresh-auth.js (both covered in their own
// suites). Mock those so these tests assert the orchestration: custody routing,
// per-target cache lookup, factor selection, password re-prompt, ORCID redirect,
// the 401 re-mint+retry, and the freshAuthFailed outcomes. Sibling of
// lib-settings-fresh-auth.test.js (the same shell, keyed on a paper target).
//
// Mocking justification (project-CLAUDE.md carve-out, clause-a): the mint
// (`mintAuthorshipFreshAuthProof`, a real fetch() of POST /custody/fresh-auth
// bound to a paper target) and the status read (`fetchEmailStatus`, a real
// fetch() of /settings/email) are mocked because what these cases stage is
// impractical to reproduce per-test against a live backend. A wrong password
// at the mint, an expired or mismatched proof at the broadcast, an unreachable
// status endpoint, and a cross-tab subject change landing inside each of
// those awaits would need differently-provisioned accounts (one with a
// password, one without, one whose status read fails), a way to close a
// proof or swap the tab's JWT subject at a chosen instant, and, for the
// ORCID-start cases, observing window.location without following it.
// Clause-b: the mocked modules are mint transport + cache, not
// auth-verification paths; the proof's cryptographic binding is verified
// server-side (backend integration tests).
// Clause-c real-path companion: no e2e spec drives this orchestrator end to
// end on a light account, and none drives a light-account custody broadcast
// with a proof attached (tests/e2e/non-consent-fresh-auth.spec.js covers only
// the /orcid/callback session_auth handler caching an issued window, against
// a stubbed callback; its closing note records the real-broadcast case as
// prototyped and removed). The two factors this orchestrator selects between
// are driven for real on the settings surface: tests/e2e/settings.spec.js
// mints at the real POST /custody/fresh-auth through the reauth modal, and
// tests/e2e/settings-orcid-factor.spec.js completes the ORCID factor's full
// round-trip. tests/e2e/authorship-consent-actions.spec.js covers the four
// consent and credit ops being built and handed to the Keychain stub on
// self-custody, against route-mocked paper data, where no proof is minted.
const mockMintAuthorshipFreshAuthProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
vi.mock('../../src/api.js', () => ({
  mintAuthorshipFreshAuthProof: (...a) => mockMintAuthorshipFreshAuthProof(...a),
  // Factor selection runs through the REAL shared resolver (importActual below),
  // which reads the account status. This mock is what the resolver sees.
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  // The real fresh-auth.js (loaded via importActual below) imports these at
  // module load; stub them so the import resolves. `mintSessionAuthProof` is
  // never called from here. `startOrcid` and `consentOpRequestFields` ARE
  // exercised: the ORCID-start teardown cases below drive the real redirect
  // starter via importActual, which builds the start payload and calls the
  // start round-trip.
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
  mintSessionAuthProof: vi.fn(),
}));

// signer.js is a module-load dependency of the real fresh-auth.js; mock it so the
// partial mock below loads the real module without pulling real broadcast I/O.
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

const mockGetCachedConsentOpProof = vi.fn();
const mockClearCachedConsentOpProof = vi.fn();
const mockBeginAuthorshipOrcid = vi.fn();
// Partial mock: keep the REAL shared password-factor helper, outcome sentinels,
// and REMINTABLE_REASONS so the orchestrator exercises the real
// mintViaPasswordFactor and compares against the real sentinel symbols (a
// re-stubbed Symbol would never be === the helper's return). Mock only the
// cache and the ORCID redirect.
vi.mock('../../src/lib/fresh-auth.js', async (importActual) => ({
  ...(await importActual()),
  getCachedConsentOpProof: (...a) => mockGetCachedConsentOpProof(...a),
  clearCachedConsentOpProof: (...a) => mockClearCachedConsentOpProof(...a),
  beginAuthorshipOrcidFreshAuth: (...a) => mockBeginAuthorshipOrcid(...a),
}));

const reauthRequest = vi.fn();
const authDisconnect = vi.fn();
const toastShow = vi.fn();
let i18nMessages = null;
vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      // `cancel` mirrors the real store's: it resolves the parked `request()`
      // with null, which is how the subject scrub unwinds an open prompt in
      // production.
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
      if (name === 'auth') return { disconnect: (...a) => authDisconnect(...a), username: 'carol' };
      if (name === 'toast') return { show: (...a) => toastShow(...a) };
      if (name === 'i18n') return { messages: i18nMessages };
      return null;
    }),
  },
}));

import { withAuthorshipFreshAuth } from '../../src/lib/authorship-consent.js';
import {
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
  dismissOpenReauthPrompt,
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
// prove the generation guard alone stops the flow: with the dismissal in play
// the parked prompt resolves null and the plain-cancel branch could carry the
// unwind on its own.
function teardownWithoutPromptDismissal() {
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();
  for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
}

// Real timers in this file; a macrotask hop lets a pending orchestration
// advance to the await currently blocking it.
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// Set by the tests that answer (or abandon) a prompt after it opens.
let pendingPromptResolve = null;

// A localized value distinct from every English fallback in the module, so an
// assertion can name WHICH message fired: the busy refusal toasts the same
// shape from the same store, and expect.any(String) cannot tell them apart.
const TEARDOWN_CANCEL_SENTINEL = 'LOCALIZED-teardown-cancel-sentinel';

// Mirrors the signer.js broadcastOps error shape consumed by the orchestrator:
// a `code` (FRESH_AUTH_REQUIRED) plus `details.reason`. The retry gate keys on
// details.reason, never on a fabricated status.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

// An approve target binds the richest set (paper + slot + claimer).
const TARGET = { action: 'approve_authorship', rootAuthor: 'alice', rootPermlink: 'perm', authorIndex: 2, claimer: 'bob' };
// The ctx carries no factor hint any more: the orchestrator resolves
// password-vs-ORCID through the shared resolver, so the account status is the
// only thing that moves it. These helpers set what the resolver sees.
const LIGHT = { custody: 'light', username: 'carol' };
const passwordless = () =>
  mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: false } });
const statusUnavailable = () => mockFetchEmailStatus.mockRejectedValue(new Error('Failed to fetch'));

describe('withAuthorshipFreshAuth', () => {
  let run;
  beforeEach(() => {
    mockMintAuthorshipFreshAuthProof.mockReset();
    mockFetchEmailStatus.mockReset();
    // The resolver memoizes a positive answer per username for the tab; drop it
    // so one test's password-holder cannot decide the next test's factor.
    clearPasswordFactorMemo();
    mockGetCachedConsentOpProof.mockReset();
    mockClearCachedConsentOpProof.mockReset();
    mockBeginAuthorshipOrcid.mockReset();
    reauthRequest.mockReset();
    authDisconnect.mockReset();
    toastShow.mockReset();
    mockGetCachedConsentOpProof.mockReturnValue(null);
    mockFetchEmailStatus.mockResolvedValue({ status: 'ok', data: { hasPassword: true } });
    reauthRequest.mockResolvedValue('hunter2');
    mockMintAuthorshipFreshAuthProof.mockResolvedValue('minted-proof');
    mockBeginAuthorshipOrcid.mockResolvedValue(null); // redirect-pending sentinel
    i18nMessages = null;
    pendingPromptResolve = null;
    run = vi.fn().mockResolvedValue({ tx_id: 'tx1' });
  });

  it('self-custody calls run with no proof and mints nothing', async () => {
    const out = await withAuthorshipFreshAuth(TARGET, { custody: 'self', username: 'carol' }, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(run).toHaveBeenCalledWith(undefined);
    expect(mockGetCachedConsentOpProof).not.toHaveBeenCalled();
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
  });

  it('light account looks up the cache keyed on the FULL target', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(mockGetCachedConsentOpProof).toHaveBeenCalledWith('approve_authorship', 'alice', 'perm', 2, 'bob');
    expect(run).toHaveBeenCalledWith('cached-proof');
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    // Single-use proof: cache cleared after a successful run.
    expect(mockClearCachedConsentOpProof).toHaveBeenCalled();
  });

  it('password factor: cache miss + hasPassword → prompt, mint, run(minted)', async () => {
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(reauthRequest).toHaveBeenCalled();
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledWith(TARGET, 'hunter2');
    expect(run).toHaveBeenCalledWith('minted-proof');
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('ORCID factor: cache miss + no password → redirect (no password prompt)', async () => {
    passwordless();
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET, expect.any(Function));
    expect(out).toEqual({ redirect: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('password modal dismissed → { cancelled }, no broadcast', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('401 re-mintable (password factor) → re-mint and retry once → ok', async () => {
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('401 re-mintable (ORCID factor, no password) → freshAuthFailed, no inline re-OAuth', async () => {
    // First call resolves a cached proof so we reach run(); run then 401s.
    passwordless();
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
    // No second full-page ORCID redirect attempted inline.
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('403 target_mismatch → freshAuthFailed (not fixable by re-mint)', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'target_mismatch'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ freshAuthFailed: true });
  });

  it('403 username_mismatch → tears down the session and surfaces sessionInconsistent', async () => {
    // Corrupted session: the JWT subject and the proof subject diverge. Matches
    // broadcastWithFreshAuth's session-kind handling — disconnect + re-login
    // toast — rather than the retryable freshAuthFailed "try again" outcome.
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'username_mismatch'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ sessionInconsistent: true });
    expect(authDisconnect).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('an unavailable account status prompts for a password instead of redirecting', async () => {
    // The failure direction the shared resolver enforces, on the surface where
    // it costs the most: a full-page ORCID navigation from a paper page throws
    // away the reader's scroll position, open modals, and in-flight state. A
    // transient status failure must not be what triggers it.
    statusUnavailable();
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('an unavailable status on the 401 retry gate retries inline instead of dead-ending', async () => {
    // The retry gate reads the same resolver as the initial mint, so the two
    // cannot disagree about which factor this account has.
    statusUnavailable();
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the 401 retry gate reuses the memoized factor instead of a second status read', async () => {
    // The initial gate observed hasPassword true and memoized it; the retry
    // gate must ride that memo rather than spending the rate-limited status
    // budget again mid-op.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
  });

  it('an assumed password the backend rejects at the mint falls back to the ORCID redirect', async () => {
    // With the status unavailable the password factor is a guess, and the
    // mint's 401 is the first hard evidence the account has no password. A
    // second prompt would dead-end every consent op for exactly the accounts
    // whose only registered factor is ORCID; one prompt, then the round-trip.
    statusUnavailable();
    mockMintAuthorshipFreshAuthProof.mockRejectedValue(
      Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }),
    );
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET, expect.any(Function));
    expect(run).not.toHaveBeenCalled();
  });

  it('an assumed password rejected at the RETRY mint also redirects rather than dead-ending', async () => {
    // The retry-gate fallback arm, separately deletable from the initial
    // gate's (which the mint-rejection case above pins via resolveProof).
    // The initial proof comes from the consent-op cache (an earlier ORCID
    // round-trip), NOT from a password mint: a successful mint proves the
    // password exists and upgrades the resolver's answer to observed, after
    // which a retry 401 re-prompts. Only a still-unproven assumed password
    // may hand the retry to the ORCID round-trip.
    statusUnavailable();
    mockGetCachedConsentOpProof.mockReturnValueOnce('cached-proof');
    mockMintAuthorshipFreshAuthProof.mockRejectedValue(
      Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }),
    );
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ redirect: true });
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET, expect.any(Function));
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
    // 401 as a typo: re-prompt inline instead of throwing the user off the
    // paper page into the full-page ORCID fallback.
    statusUnavailable();
    mockMintAuthorshipFreshAuthProof
      .mockResolvedValueOnce('proof-1')
      .mockRejectedValueOnce(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce('proof-2');
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockResolvedValueOnce({ tx_id: 'tx2' });
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx2' } });
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(1);
    expect(reauthRequest).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(2, 'proof-2');
  });

  it('two rejections of a password the memo vouched for retire it: the next op can fall back to ORCID', async () => {
    // The memo can outlive the password it vouches for (an ORCID recovery
    // with no new password in another tab, then a same-subject re-login that
    // keeps this tab's state on purpose). A memo hit answers "observed", so
    // the assumed-401 escape never fires, and without retirement every op
    // prompts, 401s, re-prompts, and loops until a page reload. Two
    // consecutive rejections at the verifying route outrank the memo.
    mockMintAuthorshipFreshAuthProof.mockRejectedValue(codedError('UNAUTHORIZED'));
    expect(await withAuthorshipFreshAuth(TARGET, LIGHT, run)).toEqual({ freshAuthFailed: true });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();

    // The next op re-reads the status; with that read unavailable the factor
    // is a guess again, and its rejection hands the op to ORCID.
    statusUnavailable();
    expect(await withAuthorshipFreshAuth(TARGET, LIGHT, run)).toEqual({ redirect: true });
    expect(mockFetchEmailStatus).toHaveBeenCalledTimes(2);
    expect(reauthRequest).toHaveBeenCalledTimes(3);
    expect(mockBeginAuthorshipOrcid).toHaveBeenCalledWith(TARGET, expect.any(Function));
    expect(run).not.toHaveBeenCalled();
  });

  it('an observed password that 401s still re-prompts instead of redirecting', async () => {
    // The escape hatch is for guesses only: an observed password's 401 is a
    // typo and earns the second prompt.
    mockMintAuthorshipFreshAuthProof
      .mockRejectedValueOnce(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce('proof-ok');
    reauthRequest.mockResolvedValueOnce('wrong').mockResolvedValueOnce('right');
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ ok: { tx_id: 'tx1' } });
    expect(reauthRequest).toHaveBeenCalledTimes(2);
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
  });

  it('non-fresh-auth errors propagate to the caller', async () => {
    mockGetCachedConsentOpProof.mockReturnValue('cached-proof');
    run.mockRejectedValueOnce(codedError('FORBIDDEN'));
    await expect(withAuthorshipFreshAuth(TARGET, LIGHT, run)).rejects.toThrow('FORBIDDEN');
  });

  // ─── Refuse-while-open (busy) discriminates from a cancel ────────────────
  //
  // The reauth modal is a singleton, and a vote and an authorship action on
  // the same paper page can collide on it. The refused action unwinds through
  // the same { cancelled } outcome a cancel takes — the busy toast is the
  // whole difference, and without these cases the busy branches are deletable
  // with every suite still green.

  it('a prompt owned by another action unwinds as { cancelled } WITH the busy toast', async () => {
    reauthRequest.mockResolvedValue(REAUTH_PROMPT_BUSY);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a plain cancel unwinds with NO toast, so busy and cancel stay distinguishable', async () => {
    reauthRequest.mockResolvedValue(null);
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
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
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ cancelled: true });
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a username_mismatch on the 401 retry tears down too, not just on the first attempt', async () => {
    // Same contract as the first-attempt case above: a mismatch is a corrupted
    // session, not a re-auth the user can retry into. The retry leg is a
    // separately deletable branch and had been reporting the retryable
    // freshAuthFailed instead.
    run
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'expired'))
      .mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'username_mismatch'));
    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);
    expect(out).toEqual({ sessionInconsistent: true });
    expect(authDisconnect).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // ─── A subject change while the prompt is open ───────────────────────────
  //
  // The mint behind the prompt reads the JWT at call time, so a cross-tab
  // login as someone else during that human-length pause turns an answered
  // prompt into a mint for the NEW subject. The chain gate on the broadcast
  // surface rejects the op that follows (its posting auth still names the
  // previous subject), so the cost here is a spent mint and a verified
  // password rather than a cross-account write — but neither is owed, and the
  // guard lives in the shared password-factor mint, so this surface gets it
  // without a check of its own. These cases pin that it arrives.

  it('a password typed into a prompt left open across a subject change does not spend a mint', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    let resolvePrompt;
    reauthRequest.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePrompt = resolve; }),
    );

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the prompt is now open
    teardownWithoutPromptDismissal();

    resolvePrompt('hunter2');

    expect(await pending).toEqual({ cancelled: true });
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    // Distinguishable from the user's own dismissal, which stays silent, and
    // named rather than counted: the busy refusal is the same shape.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a subject change during the factor read stops the op before it prompts', async () => {
    // The status round-trip is the FIRST await of the op, and the memo is
    // empty on a fresh page load (the scrub clears it too), so it really runs.
    // A guard opened after it would compare the post-teardown generation
    // against itself and never fire.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the factor read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: true } });

    expect(await pending).toEqual({ cancelled: true });
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('a passwordless answer arriving after a subject change does not start an ORCID round-trip', async () => {
    // Navigating away from the paper page for the subject that left, and
    // rewriting the ORCID flow keys the scrub just cleared.
    let resolveStatus;
    mockFetchEmailStatus.mockReturnValueOnce(
      new Promise((resolve) => { resolveStatus = resolve; }),
    );

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the factor read is now pending
    teardownSubjectState();

    resolveStatus({ status: 'ok', data: { hasPassword: false } });

    expect(await pending).toEqual({ cancelled: true });
    expect(mockBeginAuthorshipOrcid).not.toHaveBeenCalled();
    expect(reauthRequest).not.toHaveBeenCalled();
  });

  it('a subject change while the mint is in flight does not hand the proof to the broadcast', async () => {
    let resolveMint;
    mockMintAuthorshipFreshAuthProof.mockReturnValueOnce(
      new Promise((resolve) => { resolveMint = resolve; }),
    );

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the default prompt answered; the mint is now pending
    teardownWithoutPromptDismissal();

    resolveMint('late-proof');

    expect(await pending).toEqual({ cancelled: true });
    expect(run).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
  });

  it('a subject change while the guarded call is in flight stops the retry gate re-minting and reports it once', async () => {
    // The gate re-prompts and re-mints after a remintable 401. Its guard is
    // the orchestrator's, opened before run(), so a teardown that landed while
    // the broadcast was in flight is still visible — a guard opened inside the
    // gate would not be. And the gate is the only site left that can say so:
    // its { cancelled } is silent at every call site, so its own report is the
    // whole message, and without it the user watches the op end unsaid.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    let rejectRun;
    run.mockImplementationOnce(
      () => new Promise((resolve, reject) => { rejectRun = reject; }),
    );

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the prompt answered, the proof minted, run() is pending
    teardownSubjectState();

    rejectRun(codedError('FRESH_AUTH_REQUIRED', 'expired'));

    expect(await pending).toEqual({ cancelled: true });
    // One prompt (the initial mint), never a second for the new subject.
    expect(reauthRequest).toHaveBeenCalledTimes(1);
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    // Exactly one message, and it is the teardown's.
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  // ─── A subject change while the second attempt is in flight ──────────────
  //
  // The wrong-password re-prompt is as human-length a pause as the first
  // prompt, and the retry mint behind it reads the JWT at call time all the
  // same. These stage the same teardown one attempt later, where the second
  // prompt's resumption and the second mint's rejection are the only
  // boundaries left standing between the op and the new subject.

  it('a password typed into the second prompt left open across a subject change does not spend a mint', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    let resolveSecondPrompt;
    reauthRequest
      .mockResolvedValueOnce('first-try')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondPrompt = resolve; }));
    mockMintAuthorshipFreshAuthProof.mockRejectedValueOnce(codedError('UNAUTHORIZED'));

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
    await tick(); // the first mint 401'd; the second prompt is now open
    teardownWithoutPromptDismissal();

    resolveSecondPrompt('second-try');

    expect(await pending).toEqual({ cancelled: true });
    // The first attempt's mint stays the only one: nothing was spent on the
    // answer that arrived after the teardown.
    expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow).toHaveBeenCalledWith(TEARDOWN_CANCEL_SENTINEL, 'error');
  });

  it('a second-mint rejection landing after a subject change cancels rather than reporting a spent re-auth', async () => {
    // Without the teardown check at the second attempt's catch, the rejection
    // reads as a spent re-auth and whoever the tab now represents is told
    // "re-authentication failed" for an op the departed subject started.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    reauthRequest.mockResolvedValueOnce('first-try').mockResolvedValueOnce('second-try');
    let rejectSecondMint;
    mockMintAuthorshipFreshAuthProof
      .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectSecondMint = reject; }));

    const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
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
  // navigate the new subject's tab to ORCID for the subject that left. These
  // drive the REAL starter (the mock delegates to it) so the pre-navigation
  // re-check, the scrub's own key removal, and the single report are pinned
  // end to end on this surface too.

  it('an ORCID start resolving after a subject change cancels instead of navigating', async () => {
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    sessionStorage.clear();
    passwordless();
    const actual = await vi.importActual('../../src/lib/fresh-auth.js');
    mockBeginAuthorshipOrcid.mockImplementation((...a) => actual.beginAuthorshipOrcidFreshAuth(...a));
    let resolveStart;
    startOrcid.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/paper/alice/perm' } });
    try {
      const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
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

  it('an assumed-password fallback whose start resolves after a subject change cancels instead of navigating', async () => {
    // The second path into the starter on this surface: the status read is
    // down, the guessed password 401s at the mint, and the op falls back to
    // the round-trip — whose start is itself an await the teardown can land
    // in.
    i18nMessages = { auth: { reauthCancelled: TEARDOWN_CANCEL_SENTINEL } };
    sessionStorage.clear();
    statusUnavailable();
    mockMintAuthorshipFreshAuthProof.mockRejectedValueOnce(codedError('UNAUTHORIZED'));
    const actual = await vi.importActual('../../src/lib/fresh-auth.js');
    mockBeginAuthorshipOrcid.mockImplementation((...a) => actual.beginAuthorshipOrcidFreshAuth(...a));
    let resolveStart;
    startOrcid.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/paper/alice/perm' } });
    try {
      const pending = withAuthorshipFreshAuth(TARGET, LIGHT, run);
      await tick(); // the assumed mint 401'd; the start round-trip is pending
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
