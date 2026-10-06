import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import enMessages from '../../public/messages/en.json';
import { mockLoginFromResponse } from './fixtures/mock-auth.js';

const mockVerifyEmail = vi.fn();
const mockResumeSignup = vi.fn();
const mockConfirmAccount = vi.fn();
const mockLinkExistingAccount = vi.fn();
const mockGenerateMnemonic = vi.fn(() => 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12');
const mockValidateMnemonic = vi.fn(() => true);
const mockDeriveAllKeys = vi.fn(() => ({
  owner: { public: 'STM_owner_pub' },
  active: { public: 'STM_active_pub' },
  posting: { public: 'STM_posting_pub', private: 'posting_priv' },
  memo: { public: 'STM_memo_pub', private: 'memo_priv' },
}));
const mockIsKeychainInstalled = vi.fn(() => true);

vi.mock('../../src/api.js', () => ({
  verifyEmail: (...args) => mockVerifyEmail(...args),
  resumeSignup: (...args) => mockResumeSignup(...args),
  confirmAccount: (...args) => mockConfirmAccount(...args),
  linkExistingAccount: (...args) => mockLinkExistingAccount(...args),
}));

vi.mock('../../src/hive-keys.js', () => ({
  generateMnemonic: (...args) => mockGenerateMnemonic(...args),
  validateMnemonic: (...args) => mockValidateMnemonic(...args),
  deriveAllKeys: (...args) => mockDeriveAllKeys(...args),
}));

vi.mock('../../src/keychain.js', () => ({
  isKeychainInstalled: (...args) => mockIsKeychainInstalled(...args),
}));

const mockAuthStore = {
  isConnected: false,
  token: null,
  username: null,
  isAccredited: false,
  accreditation: null,
  custody: null,
  expiresAt: null,
  _saveSession: vi.fn(),
  _startAccreditationPolling: vi.fn(),
  loginFromResponse: vi.fn(mockLoginFromResponse),
};
const mockRouterStore = { navigate: vi.fn(), query: {}, params: {} };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initSignupVerifyPage, signupVerifyPageTemplate } from '../../src/pages/signup-verify.js';

const resolves = (key) => typeof key.split('.').reduce((node, part) => node?.[part], enMessages) === 'string';

function createComponent(query = {}) {
  mockRouterStore.query = query;
  initSignupVerifyPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

// Put a freshly created component into the post-verify/post-resume "choose"
// state. This mirrors how handleVerify() and handleResume() seed authToken from
// a RESPONSE BODY (never from a URL query param). Used by the create/link flow
// specs below, which exercise behavior downstream of obtaining the token.
function enterChooseState(comp, { authToken = 'tok' } = {}) {
  comp.authToken = authToken;
  comp.phase = 'choose';
}

// Mirrors the ApiRequestError shape api.js throws for the signup-finalize 504
// ambiguous-outcome envelope (genuine broadcast timeout, degrade
// forced-ambiguous, or self-held binding lock). The component branches on
// err.code; details is carried for fidelity with the real wire shape.
function broadcastTimeoutError() {
  const err = new Error('Accreditation broadcast outcome uncertain. Verify your accreditation before retrying.');
  err.code = 'BROADCAST_TIMEOUT';
  err.details = { retriable: false, outcome: 'uncertain', verify_before_retry: true };
  return err;
}

// An error carrying only an API error code.
function codedError(code) {
  const err = new Error(`terminal error ${code}`);
  err.code = code;
  return err;
}

// Finalize refusals that leave the account set up but unaccredited:
// [code, details, reason key, bound account the page shows].
const FINALIZE_REFUSALS = [
  ['MAILBOX_ALREADY_BOUND', { bound_to: 'olderaccount' }, 'seedPhrase.unaccreditedMailboxBound', 'olderaccount'],
  ['MAILBOX_ALREADY_BOUND', undefined, 'seedPhrase.unaccreditedMailboxBoundUnnamed', ''],
  ['ORCID_ALREADY_LINKED', undefined, 'seedPhrase.unaccreditedOrcidLinked', ''],
  ['ACCREDITATION_SANCTIONED', undefined, 'seedPhrase.unaccreditedSanctioned', ''],
];

// Mirrors the ApiRequestError shape api.js throws for the POST_BROADCAST_* 502
// envelopes on signup finalize (auth.md /confirm + /link error lists). With
// outcome:'confirmed' the chain bind is durable and only a downstream cascade
// write failed, so the account is already finalized. The component branches on
// the (code, details.outcome) pair only — never on failed_step or err.message.
function postBroadcastError(code, { outcome = 'confirmed' } = {}) {
  const err = new Error(`post-broadcast ${code}`);
  err.code = code;
  err.details = { retriable: false, outcome, tx_id: 'a'.repeat(40), failed_step: 'reputation_seed' };
  return err;
}

describe('signupVerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthStore.isConnected = false;
    mockAuthStore.token = null;
    mockAuthStore.username = null;
    mockAuthStore.isAccredited = false;
    mockAuthStore.accreditation = null;
    mockAuthStore.custody = null;
    mockAuthStore.expiresAt = null;
  });

  describe('init', () => {
    // Login PENDING_SIGNUP redirect: the URL carries resume=1 + email but
    // NEVER an auth_token (it is the row-lookup credential for /confirm and
    // /link). The page must land on the resume form so the user re-verifies
    // their password via /resume-signup, which mints the binding cookie and
    // returns a fresh auth_token in its response body.
    it('goes to resume form (error phase) on resume=1 redirect, prefilling email, with no authToken from URL', () => {
      const comp = createComponent({ resume: '1', email: 'e@x.com' });
      comp.init();
      expect(comp.phase).toBe('error');
      expect(comp.resumeFromLogin).toBe(true);
      expect(comp.resumeEmail).toBe('e@x.com');
      // The auth_token must NOT be lifted from the URL.
      expect(comp.authToken).toBeNull();
      // No verify-link error copy on the resume-from-login path.
      expect(comp.error).toBeNull();
      expect(mockVerifyEmail).not.toHaveBeenCalled();
    });

    // Regression guard for the original break: a stale/absent auth_token used
    // to be URL-encoded as the literal string "undefined", which is truthy and
    // silently set this.authToken = "undefined", 400ing every later /confirm
    // and /link. The init must NOT activate any auth_token fast-path; the only
    // marker it honors is resume === '1', and authToken stays null.
    it('does not treat a literal "undefined" auth_token param as a credential', () => {
      const comp = createComponent({ auth_token: 'undefined', email: 'undefined' });
      comp.init();
      // No resume marker → falls through to the email-token path (no token →
      // invalid-link error). Critically, authToken is never set to "undefined".
      expect(comp.authToken).toBeNull();
      expect(comp.authToken).not.toBe('undefined');
      expect(comp.phase).toBe('error');
    });

    // Even a real-looking auth_token in the URL must be ignored — auth_token is
    // never accepted from the address bar, only from a response body.
    it('ignores an auth_token query param when resume marker is absent', () => {
      const comp = createComponent({ auth_token: 'confirmed:realtok', email: 'e@x.com' });
      comp.init();
      expect(comp.authToken).toBeNull();
      // No resume=1 and no email token → invalid-link error.
      expect(comp.phase).toBe('error');
      expect(comp.error).toBe('seedPhrase.invalidLink');
    });

    it('goes to error phase when no token in query', () => {
      const comp = createComponent({});
      comp.init();
      expect(comp.phase).toBe('error');
      // No resume marker → this is the consumed/expired-link case, which shows
      // the invalid-link copy (distinct from the resume-from-login note).
      expect(comp.resumeFromLogin).toBe(false);
    });

    // Landing with the mailed token verifies nothing: the page asks for the
    // password chosen at signup and sends both together on submit.
    it('lands on the password form when an email token is present, without verifying', () => {
      const comp = createComponent({ token: 'email-tok' });
      comp.init();
      expect(comp.phase).toBe('password');
      expect(comp.emailToken).toBe('email-tok');
      expect(comp.error).toBeNull();
      expect(mockVerifyEmail).not.toHaveBeenCalled();
    });
  });

  describe('handleVerify', () => {
    function landOnPasswordForm() {
      const comp = createComponent({ token: 'email-tok' });
      comp.init();
      return comp;
    }

    it('sends the token and the password, then sets choose phase', async () => {
      mockVerifyEmail.mockResolvedValue({ data: { flow: 'choose', auth_token: 'a', email: 'b@x.com' } });
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'signup-pass';

      await comp.handleVerify();

      expect(mockVerifyEmail).toHaveBeenCalledWith('email-tok', 'signup-pass');
      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('a');
      expect(comp.isVerifying).toBe(false);
    });

    it('does nothing without a password', async () => {
      const comp = landOnPasswordForm();
      comp.verifyPassword = '';

      await comp.handleVerify();

      expect(mockVerifyEmail).not.toHaveBeenCalled();
      expect(comp.phase).toBe('password');
    });

    it('sets error phase on unexpected flow', async () => {
      mockVerifyEmail.mockResolvedValue({ data: { flow: 'other' } });
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'signup-pass';

      await comp.handleVerify();

      expect(comp.phase).toBe('error');
      expect(comp.error).toBe('seedPhrase.unexpectedResponse');
    });

    // On a wrong password the form and the token stay, so a retry can still
    // succeed.
    it('keeps the form and the token on a wrong password, and a retry with the right password reaches choose', async () => {
      mockVerifyEmail
        .mockRejectedValueOnce(codedError('UNAUTHORIZED'))
        .mockResolvedValueOnce({ data: { flow: 'choose', auth_token: 'a', email: 'b@x.com' } });
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'wrong-pass';

      await comp.handleVerify();

      expect(comp.phase).toBe('password');
      expect(comp.error).toBe('seedPhrase.passwordWrong');
      expect(comp.emailToken).toBe('email-tok');
      expect(comp.authToken).toBeNull();
      expect(comp.isVerifying).toBe(false);

      comp.verifyPassword = 'signup-pass';
      await comp.handleVerify();

      expect(mockVerifyEmail).toHaveBeenLastCalledWith('email-tok', 'signup-pass');
      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('a');
      expect(comp.error).toBeNull();
    });

    // The unknown, already used and expired token answers: the link is spent,
    // so the page offers the resume form.
    it('shows the resume form on a 400 BAD_REQUEST token answer', async () => {
      mockVerifyEmail.mockRejectedValue(codedError('BAD_REQUEST'));
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'signup-pass';

      await comp.handleVerify();

      expect(comp.phase).toBe('error');
      expect(comp.error).toBeNull(); // Shows resume form, no error message
    });

    it('keeps the form with a retry message on a 503', async () => {
      const busy = codedError('SERVICE_UNAVAILABLE');
      busy.details = { reason: 'queue_full' };
      mockVerifyEmail.mockRejectedValue(busy);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'signup-pass';

      await comp.handleVerify();

      expect(comp.phase).toBe('password');
      expect(comp.error).toBe('seedPhrase.verifyRetry');
      expect(comp.emailToken).toBe('email-tok');
      expect(comp.isVerifying).toBe(false);
      warnSpy.mockRestore();
    });

    it('keeps the form with a wait message on a 429', async () => {
      mockVerifyEmail.mockRejectedValue(codedError('RATE_LIMITED'));
      const comp = landOnPasswordForm();
      comp.verifyPassword = 'signup-pass';

      await comp.handleVerify();

      expect(comp.phase).toBe('password');
      expect(comp.error).toBe('seedPhrase.verifyRateLimited');
      expect(comp.emailToken).toBe('email-tok');
    });
  });

  describe('chooseCreate', () => {
    it('generates mnemonic and moves to create-seed phase', () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();

      expect(mockGenerateMnemonic).toHaveBeenCalled();
      expect(comp.seedWords).toHaveLength(12);
      expect(comp.phase).toBe('create-seed');
    });
  });

  describe('chooseLink', () => {
    it('moves to link-keychain phase', () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      expect(comp.phase).toBe('link-keychain');
    });
  });

  describe('proceedToConfirm', () => {
    it('picks random indices and moves to confirm phase', () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.proceedToConfirm();

      expect(comp.confirmIndices).toHaveLength(3);
      expect(comp.phase).toBe('create-confirm');
      // Each index should have an empty input entry
      comp.confirmIndices.forEach((i) => {
        expect(comp.confirmInputs[i]).toBe('');
      });
    });
  });

  describe('confirmCorrect', () => {
    it('returns true when inputs match seed words', () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.proceedToConfirm();

      // Fill in correct answers
      comp.confirmIndices.forEach((i) => {
        comp.confirmInputs[i] = comp.seedWords[i];
      });

      expect(comp.confirmCorrect).toBe(true);
    });

    it('returns false when inputs are wrong', () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.proceedToConfirm();

      comp.confirmIndices.forEach((i) => {
        comp.confirmInputs[i] = 'wrong';
      });

      expect(comp.confirmCorrect).toBe(false);
    });
  });

  describe('submitCreateAccount', () => {
    it('derives keys and calls confirmAccount', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: { token: 'jwt', username: 'alice', expires_at: '2099-01-01', accreditation: null },
      });

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(mockDeriveAllKeys).toHaveBeenCalledWith(comp.mnemonic, 'alice');
      expect(mockConfirmAccount).toHaveBeenCalledWith('tok', 'alice', {
        owner_public: 'STM_owner_pub',
        active_public: 'STM_active_pub',
        posting_public: 'STM_posting_pub',
        memo_public: 'STM_memo_pub',
        posting_private: 'posting_priv',
        memo_private: 'memo_priv',
      });
      expect(comp.phase).toBe('done');
      expect(mockAuthStore.token).toBe('jwt');
      expect(mockAuthStore.custody).toBe('light');
    });

    // submitCreateAccount used to pass six
    // positional args to _saveSession(), which the no-arg implementation
    // silently ignored — the call happened to work only because the store
    // fields were already set on the lines above. Lock in the full pre-save
    // state-reset: token/username/isAccredited/accreditation/custody MUST
    // land on the store, AND expiresAt MUST be set before _saveSession() is
    // invoked. Otherwise _restoreSession rejects the persisted entry on
    // next load and the user is silently logged out.
    it('sets full auth state including expiresAt before calling no-arg _saveSession()', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: {
          token: 'jwt-create',
          username: 'alice',
          expires_at: '2099-12-31T00:00:00.000Z',
          accreditation: { some: 'acc-payload' },
        },
      });
      // Snapshot-capturing stub: inspects what _saveSession would persist
      // *at the moment it was called*, locking in the ordering invariant.
      // Final-state assertions (mockAuthStore.<field> after await returns)
      // pass against a refactor that moves `auth.expiresAt = res.data.expires_at`
      // to AFTER _saveSession() — re-introducing the "stale prior expiresAt
      // persisted, user logged out on reload" bug.
      let savedSnapshot;
      mockAuthStore._saveSession = vi.fn(function () {
        savedSnapshot = { ...mockAuthStore };
      });

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.token).toBe('jwt-create');
      expect(savedSnapshot.username).toBe('alice');
      expect(savedSnapshot.isConnected).toBe(true);
      expect(savedSnapshot.isAccredited).toBe(true);
      expect(savedSnapshot.accreditation).toEqual({ some: 'acc-payload' });
      expect(savedSnapshot.custody).toBe('light');
      // Load-bearing: expiresAt MUST be on the store BEFORE the no-arg
      // _saveSession() reads from it.
      expect(savedSnapshot.expiresAt).toBe('2099-12-31T00:00:00.000Z');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Handle the null-accreditation default. Backend may omit
    // `accreditation`; the pre-save reset must coerce it to null (not leave a
    // stale value carried over from a prior login-as-different-user).
    it('coerces missing accreditation to null before _saveSession()', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: { token: 'jwt-create2', username: 'alice', expires_at: '2099-01-01' },
      });
      // Simulate a stale prior value on the store.
      mockAuthStore.accreditation = { stale: true };

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(mockAuthStore.accreditation).toBeNull();
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Per-site preserve-on-omit coverage. submitCreateAccount routes through
    // loginFromResponse(), which enforces the atomic {token, expires_at} pair
    // invariant.
    it('atomic pair: preserves token + expiresAt when confirmAccount response omits expires_at', async () => {
      mockConfirmAccount.mockResolvedValue({
        data: {
          token: 'jwt-create-no-expiry',
          username: 'alice',
          accreditation: { some: 'acc' },
          // expires_at omitted — atomic pair must NOT half-rotate.
        },
      });
      const originalToken = mockAuthStore.token;
      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(mockAuthStore.token).toBe(originalToken);
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      // Non-atomic fields still land on the store.
      expect(mockAuthStore.username).toBe('alice');
      expect(mockAuthStore.isAccredited).toBe(true);
      expect(mockAuthStore.custody).toBe('light');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    it('does nothing with invalid username', async () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.username = 'ab'; // too short
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();
      expect(mockConfirmAccount).not.toHaveBeenCalled();
    });

    it('does nothing without authToken', async () => {
      const comp = createComponent({});
      comp.phase = 'create-username';
      comp.authToken = null;
      comp.username = 'validname';
      comp.usernameStatus = 'available';
      comp.mnemonic = 'a b c d e f g h i j k l';
      comp.seedWords = comp.mnemonic.split(' ');

      await comp.submitCreateAccount();
      expect(mockConfirmAccount).not.toHaveBeenCalled();
      expect(comp.error).toBe('seedPhrase.credentialsRequired');
    });

    // submitCreateAccount derives keys from the BIP39 mnemonic. Raw
    // err.message must not reach the DOM; it goes to console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn, returns to username phase', async () => {
      const leaky = new Error('creation failed hex=deadbeefcafebabe');
      mockConfirmAccount.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.error).toBe('seedPhrase.createAccountFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.phase).toBe('create-username');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // Ambiguous broadcast outcome (504): the account is already finalized and
    // the bind may have landed. The client must surface the verify/retry
    // affordance, NOT the terminal "creation failed" copy, and must NOT bounce
    // back to the username entry phase (a blind retry could double-bind).
    it('renders broadcast-pending affordance on BROADCAST_TIMEOUT instead of generic failure', async () => {
      mockConfirmAccount.mockRejectedValue(broadcastTimeoutError());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.phase).not.toBe('create-username');
      expect(comp.error).toBeNull();
      expect(comp.error).not.toBe('seedPhrase.createAccountFailed');
      expect(comp.isSubmitting).toBe(false);
      // BROADCAST_TIMEOUT keeps the give-it-a-moment-to-sync copy (the default),
      // NOT the operator-contact copy. Non-regression guard for the existing
      // affordance now that the phase renders reactive copy keys.
      expect(comp.broadcastPendingTitleKey).toBe('seedPhrase.broadcastPendingTitle');
      expect(comp.broadcastPendingDescriptionKey).toBe('seedPhrase.broadcastPendingDescription');
      // Expected wire shape, not an unexpected failure: no console.warn noise.
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // POST_BROADCAST_FAILED with outcome:'confirmed': the chain bind is durable
    // and only a transient downstream cascade write failed. Route to the
    // verify-before-retry affordance with the give-it-a-moment-to-sync copy, NOT
    // the generic "creation failed" + bounce. Per common.md the chain state is
    // canonical, so implying creation failed is plainly wrong here.
    it('renders broadcast-pending (sync copy) on POST_BROADCAST_FAILED outcome:confirmed', async () => {
      mockConfirmAccount.mockRejectedValue(postBroadcastError('POST_BROADCAST_FAILED'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.phase).not.toBe('create-username');
      expect(comp.error).toBeNull();
      expect(comp.broadcastPendingTitleKey).toBe('seedPhrase.broadcastPendingTitle');
      expect(comp.broadcastPendingDescriptionKey).toBe('seedPhrase.broadcastPendingDescription');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // POST_BROADCAST_OPERATOR_REQUIRED with outcome:'confirmed': chain bind
    // durable, but the downstream cascade failed PERMANENTLY and will not
    // auto-reconcile. Route to broadcast-pending but swap in the
    // contact-support copy — the "give it a moment to sync" framing would be
    // misleading. Sibling of POST_BROADCAST_FAILED; common.md requires handling
    // both wherever one is handled.
    it('renders broadcast-pending (operator-contact copy) on POST_BROADCAST_OPERATOR_REQUIRED outcome:confirmed', async () => {
      mockConfirmAccount.mockRejectedValue(postBroadcastError('POST_BROADCAST_OPERATOR_REQUIRED'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.phase).not.toBe('create-username');
      expect(comp.error).toBeNull();
      expect(comp.broadcastPendingTitleKey).toBe('seedPhrase.broadcastOperatorTitle');
      expect(comp.broadcastPendingDescriptionKey).toBe('seedPhrase.broadcastOperatorDescription');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // Discriminator guard: the outcome:'confirmed' field is load-bearing. A
    // POST_BROADCAST_FAILED whose outcome is anything other than 'confirmed'
    // (legacy/malformed envelope, future variant) must NOT borrow the
    // confirmed-outcome affordance — it falls through to the generic failure +
    // bounce. Branch is on the contract enum, never failed_step / err.message.
    it('keeps POST_BROADCAST_FAILED with non-confirmed outcome on the generic failure path', async () => {
      mockConfirmAccount.mockRejectedValue(postBroadcastError('POST_BROADCAST_FAILED', { outcome: 'uncertain' }));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.phase).toBe('create-username');
      expect(comp.error).toBe('seedPhrase.createAccountFailed');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // A finalize refusal comes after the account is set up: the page moves to
    // the unaccredited phase and takes up no session.
    it.each(FINALIZE_REFUSALS)('%s with details %o shows the unaccredited phase', async (code, details, reasonKey, boundTo) => {
      const err = codedError(code);
      err.details = details;
      mockConfirmAccount.mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';

      await comp.submitCreateAccount();

      expect(comp.phase).toBe('unaccredited');
      expect(comp.unaccreditedReasonKey).toBe(reasonKey);
      expect(comp.boundTo).toBe(boundTo);
      expect(comp.error).toBeNull();
      expect(comp.isSubmitting).toBe(false);
      expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
      // Expected wire shape, not an unexpected failure: no console.warn noise.
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // Leaving the username step clears the username debounce timer so a stale
    // _checkUsername dhive call cannot fire ~400ms after the phase transition.
    it.each([
      ['broadcast-pending', broadcastTimeoutError],
      ['unaccredited', () => codedError('MAILBOX_ALREADY_BOUND')],
    ])('clears the username debounce timer when routing to %s', async (phase, makeError) => {
      mockConfirmAccount.mockRejectedValue(makeError());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseCreate();
      comp.username = 'alice';
      comp.usernameStatus = 'available';
      // Simulate an armed debounce timer (watchUsername's $watch is mocked, so
      // set the handle directly).
      const handle = setTimeout(() => {}, 100000);
      comp._usernameTimer = handle;

      await comp.submitCreateAccount();

      expect(comp.phase).toBe(phase);
      expect(clearSpy).toHaveBeenCalledWith(handle);
      expect(comp._usernameTimer).toBeNull();
      clearSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('handleLinkAccount', () => {
    it('calls linkExistingAccount and sets auth', async () => {
      mockLinkExistingAccount.mockResolvedValue({
        data: { token: 'jwt2', username: 'bob', expires_at: '2099-01-01', accreditation: null },
      });

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(mockLinkExistingAccount).toHaveBeenCalledWith('tok', 'bob');
      expect(comp.phase).toBe('done');
      expect(mockAuthStore.custody).toBe('self');
    });

    // The link-account path used to pass six positional args to
    // _saveSession() (silently ignored by the no-arg implementation). Lock in
    // the full pre-save state-reset.
    it('sets full auth state including expiresAt before calling no-arg _saveSession()', async () => {
      mockLinkExistingAccount.mockResolvedValue({
        data: {
          token: 'jwt-link',
          username: 'bob',
          expires_at: '2099-06-15T00:00:00.000Z',
          accreditation: { link: 'acc' },
        },
      });
      // Snapshot-capturing stub: see submitCreateAccount full-state spec
      // above for rationale. Catches a refactor that moves any of the
      // pre-save assignments to AFTER _saveSession().
      let savedSnapshot;
      mockAuthStore._saveSession = vi.fn(function () {
        savedSnapshot = { ...mockAuthStore };
      });

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.token).toBe('jwt-link');
      expect(savedSnapshot.username).toBe('bob');
      expect(savedSnapshot.isConnected).toBe(true);
      expect(savedSnapshot.isAccredited).toBe(true);
      expect(savedSnapshot.accreditation).toEqual({ link: 'acc' });
      expect(savedSnapshot.custody).toBe('self');
      // Load-bearing: expiresAt MUST be on the store BEFORE the no-arg
      // _saveSession() reads from it.
      expect(savedSnapshot.expiresAt).toBe('2099-06-15T00:00:00.000Z');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    // Per-site preserve-on-omit coverage. handleLinkAccount routes through
    // loginFromResponse(), which enforces the atomic {token, expires_at} pair
    // invariant.
    it('atomic pair: preserves token + expiresAt when linkExistingAccount response omits expires_at', async () => {
      mockLinkExistingAccount.mockResolvedValue({
        data: {
          token: 'jwt-link-no-expiry',
          username: 'bob',
          accreditation: { link: 'acc' },
          // expires_at omitted — atomic pair must NOT half-rotate.
        },
      });
      const originalToken = mockAuthStore.token;
      const originalExpiry = mockAuthStore.expiresAt;
      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(mockAuthStore.token).toBe(originalToken);
      expect(mockAuthStore.expiresAt).toBe(originalExpiry);
      // Non-atomic fields still land on the store.
      expect(mockAuthStore.username).toBe('bob');
      expect(mockAuthStore.isAccredited).toBe(true);
      expect(mockAuthStore.custody).toBe('self');
      expect(mockAuthStore._saveSession).toHaveBeenCalledWith();
    });

    it('does nothing without hiveUsername', async () => {
      const comp = createComponent();
      enterChooseState(comp);
      comp.hiveUsername = '';
      await comp.handleLinkAccount();
      expect(mockLinkExistingAccount).not.toHaveBeenCalled();
    });

    it('requires keychain installed', async () => {
      mockIsKeychainInstalled.mockReturnValue(false);
      const comp = createComponent();
      enterChooseState(comp);
      comp.hiveUsername = 'bob';

      await comp.handleLinkAccount();

      expect(comp.error).toBe('seedPhrase.keychainRequired');
      expect(mockLinkExistingAccount).not.toHaveBeenCalled();
    });

    // Failure surfaces a generic localized message; raw err reaches
    // console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const leaky = new Error('link failed hex=deadbeefcafebabe');
      mockLinkExistingAccount.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.error).toBe('seedPhrase.linkAccountFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // Ambiguous broadcast outcome (504) on the link path: the account is
    // already activated; surface the verify/retry affordance, not the terminal
    // "link failed" copy.
    it('renders broadcast-pending affordance on BROADCAST_TIMEOUT instead of generic failure', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      mockLinkExistingAccount.mockRejectedValue(broadcastTimeoutError());
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.error).toBeNull();
      expect(comp.error).not.toBe('seedPhrase.linkAccountFailed');
      expect(comp.isSubmitting).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // POST_BROADCAST_FAILED with outcome:'confirmed' on the link path: chain
    // bind durable, transient cascade failure. Verify-before-retry affordance
    // with the sync copy, not the generic "link failed".
    it('renders broadcast-pending (sync copy) on POST_BROADCAST_FAILED outcome:confirmed', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      mockLinkExistingAccount.mockRejectedValue(postBroadcastError('POST_BROADCAST_FAILED'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.error).toBeNull();
      expect(comp.error).not.toBe('seedPhrase.linkAccountFailed');
      expect(comp.broadcastPendingTitleKey).toBe('seedPhrase.broadcastPendingTitle');
      expect(comp.broadcastPendingDescriptionKey).toBe('seedPhrase.broadcastPendingDescription');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // POST_BROADCAST_OPERATOR_REQUIRED with outcome:'confirmed' on the link
    // path: chain bind durable, permanent cascade failure. Swap in the
    // contact-support copy.
    it('renders broadcast-pending (operator-contact copy) on POST_BROADCAST_OPERATOR_REQUIRED outcome:confirmed', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      mockLinkExistingAccount.mockRejectedValue(postBroadcastError('POST_BROADCAST_OPERATOR_REQUIRED'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.phase).toBe('broadcast-pending');
      expect(comp.error).toBeNull();
      expect(comp.error).not.toBe('seedPhrase.linkAccountFailed');
      expect(comp.broadcastPendingTitleKey).toBe('seedPhrase.broadcastOperatorTitle');
      expect(comp.broadcastPendingDescriptionKey).toBe('seedPhrase.broadcastOperatorDescription');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('MAILBOX_ALREADY_BOUND on the link path shows the unaccredited phase', async () => {
      mockIsKeychainInstalled.mockReturnValue(true);
      const err = codedError('MAILBOX_ALREADY_BOUND');
      err.details = { bound_to: 'olderaccount' };
      mockLinkExistingAccount.mockRejectedValue(err);

      const comp = createComponent();
      enterChooseState(comp);
      comp.chooseLink();
      comp.hiveUsername = 'Bob';

      await comp.handleLinkAccount();

      expect(comp.phase).toBe('unaccredited');
      expect(comp.unaccreditedReasonKey).toBe('seedPhrase.unaccreditedMailboxBound');
      expect(comp.boundTo).toBe('olderaccount');
      expect(comp.error).toBeNull();
      expect(comp.isSubmitting).toBe(false);
      expect(mockAuthStore.loginFromResponse).not.toHaveBeenCalled();
    });
  });

  describe('unaccredited phase', () => {
    const start = signupVerifyPageTemplate.indexOf(`x-show="phase === 'unaccredited'"`);
    const block = signupVerifyPageTemplate.slice(start, signupVerifyPageTemplate.indexOf('<!-- Done -->', start));

    it('passes the bound account to the reason string', () => {
      expect(start).toBeGreaterThan(-1);
      expect(block).toContain("$t(unaccreditedReasonKey, { account: '@' + boundTo })");
    });

    it('links to sign-in and the contact page, never to a new signup', () => {
      expect(block).toContain(":href=\"$lp('/login')\" @click.prevent=\"navigate('/login')\"");
      expect(block).toContain(":href=\"$lp('/contact')\" @click.prevent=\"navigate('/contact')\"");
      expect(block).not.toContain('/signup');
    });

    it('every string the template names resolves in en.json', () => {
      const keys = [...signupVerifyPageTemplate.matchAll(/\$t\('([^']+)'/g)].map((m) => m[1]);
      expect(keys).toEqual(expect.arrayContaining(['seedPhrase.unaccreditedTitle', 'seedPhrase.unaccreditedSignIn']));
      expect(keys.filter((key) => !resolves(key))).toEqual([]);
      const reasonKeys = FINALIZE_REFUSALS.map(([, , reasonKey]) => reasonKey);
      expect(reasonKeys.filter((key) => !resolves(key))).toEqual([]);
    });
  });

  describe('handleResume', () => {
    it('calls resumeSignup and transitions to choose phase', async () => {
      mockResumeSignup.mockResolvedValue({ data: { flow: 'choose', auth_token: 'a2', email: 'x@x.com' } });
      const comp = createComponent({});
      comp.phase = 'error';
      comp.resumeEmail = 'x@x.com';
      comp.resumePassword = 'pass';

      await comp.handleResume();

      expect(mockResumeSignup).toHaveBeenCalledWith('x@x.com', 'pass');
      expect(comp.phase).toBe('choose');
      expect(comp.authToken).toBe('a2');
    });

    it('does nothing when fields empty', async () => {
      const comp = createComponent({});
      comp.resumeEmail = '';
      comp.resumePassword = '';
      await comp.handleResume();
      expect(mockResumeSignup).not.toHaveBeenCalled();
    });

    // Failure surfaces a generic localized message; raw err reaches
    // console.warn.
    it('sanitizes failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('bad hex=deadbeefcafebabe');
      mockResumeSignup.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent({});
      comp.resumeEmail = 'x@x.com';
      comp.resumePassword = 'pass';

      await comp.handleResume();

      expect(comp.error).toBe('seedPhrase.resumeFailed');
      expect(comp.error).not.toContain('deadbeef');
      expect(comp.isResuming).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  // Post-destroy() async continuations must not write to component state. The
  // create-account path derives keys from a BIP39 mnemonic and makes a
  // multi-second Hive broadcast; the user easily navigates away mid-flight.
  describe('teardown', () => {
    it('handleVerify catch does not flip phase to error after destroy()', async () => {
      let rejectFn;
      mockVerifyEmail.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent({ token: 'emailtok' });
      comp.init();
      comp.verifyPassword = 'signup-pass';
      const pending = comp.handleVerify();
      comp.destroy();
      rejectFn(codedError('BAD_REQUEST'));
      await pending;
      // phase stays 'password' (not flipped to 'error') after destroy.
      expect(comp.phase).toBe('password');
      expect(comp.error).toBeNull();
    });

    it('submitCreateAccount catch does not set error after destroy()', async () => {
      let rejectFn;
      mockConfirmAccount.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.mnemonic = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12';
      comp.seedWords = comp.mnemonic.split(' ');
      comp.authToken = 'tok';
      comp.username = 'alice';
      comp.usernameStatus = 'available';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.submitCreateAccount();
      // Give deriveAllKeys a tick to resolve, so we're guaranteed to be
      // waiting on confirmAccount when destroy() fires.
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleLinkAccount catch does not set error after destroy()', async () => {
      let rejectFn;
      mockLinkExistingAccount.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.authToken = 'tok';
      comp.hiveUsername = 'alice';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleLinkAccount();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });

    it('handleResume catch does not set error after destroy()', async () => {
      let rejectFn;
      mockResumeSignup.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = createComponent();
      comp.resumeEmail = 'e@x.com';
      comp.resumePassword = 'pass';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = comp.handleResume();
      comp.destroy();
      rejectFn(new Error('late'));
      await pending;
      expect(comp.error).toBeNull();
      warnSpy.mockRestore();
    });
  });
});
