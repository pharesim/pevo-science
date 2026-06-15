import Alpine from 'alpinejs';
import { verifyEmail, resumeSignup, confirmAccount, linkExistingAccount } from '../api.js';
import { generateMnemonic, validateMnemonic, deriveAllKeys, loadDhive } from '../hive-keys.js';
import { isKeychainInstalled } from '../keychain.js';
import { createTimerGuard } from '../lib/timer-guard.js';

// Query-param value that marks a PENDING_SIGNUP login redirect into the resume
// form. Shared between the producers (login.js, sign-in-modal.js, signup.js'
// _resolveExistingAccount) that write `?resume=<RESUME_MARKER>` and the consumer
// (this module's init()) that gates the resume landing on it. A literal typo at
// any site would silently fall through to the invalid-link path with no signal,
// so the producer/consumer coupling lives in one constant.
export const RESUME_MARKER = '1';

const template = `
      <div x-data="signupVerifyPage" class="container-narrow py-8">
        <div class="max-w-lg mx-auto">

          <!-- Verifying email token -->
          <div x-show="phase === 'verifying'" class="text-center py-16">
            <div class="animate-pulse">
              <div class="w-12 h-12 bg-parchment-dark rounded-full mx-auto mb-4"></div>
              <p class="text-ink-muted" x-text="$t('seedPhrase.verifying')"></p>
            </div>
          </div>

          <!-- Error / Resume -->
          <div x-show="phase === 'error'" class="py-16">
            <div class="text-center mb-8">
              <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.resumeTitle')"></h2>
              <p class="text-ink-muted mb-4" x-text="$t('seedPhrase.resumeDescription')"></p>
            </div>

            <!-- Resume signup form -->
            <div class="max-w-sm mx-auto bg-parchment-light border border-parchment-dark rounded-lg p-6">

              <div x-show="resumeFromLogin" class="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
                <p class="text-blue-800 text-sm" x-text="$t('seedPhrase.resumeFromLogin')"></p>
              </div>

              <div x-show="error" class="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                <p class="text-red-700 text-sm" x-text="error"></p>
              </div>

              <form @submit.prevent="handleResume" class="space-y-3">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.email')"></label>
                  <input type="email" x-model="resumeEmail" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                </div>
                <div>
                  <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.password')"></label>
                  <input type="password" x-model="resumePassword" required
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                </div>
                <button type="submit" class="btn-primary w-full" :disabled="isResuming || !resumeEmail || !resumePassword">
                  <span x-show="!isResuming" x-text="$t('seedPhrase.resumeButton')"></span>
                  <span x-show="isResuming" x-text="$t('seedPhrase.resuming')"></span>
                </button>
              </form>

              <div class="flex justify-between mt-4">
                <a :href="$lp('/reset-password')" @click.prevent="navigate('/reset-password')"
                   class="text-sm text-pevo-teal hover:underline" x-text="$t('login.forgotPassword')"></a>
                <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="text-sm text-pevo-teal hover:underline" x-text="$t('seedPhrase.startOver')"></a>
              </div>
            </div>
          </div>

          <!-- Choose: create new account or link existing -->
          <div x-show="phase === 'choose'" class="py-8">
            <div class="text-center mb-8">
              <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </div>
              <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.emailVerified')"></h2>
              <p class="text-ink-muted" x-text="$t('seedPhrase.chooseDescription')"></p>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <button @click="chooseCreate()"
                      class="bg-white border-2 border-pevo-teal rounded-xl p-6 text-center hover:bg-pevo-teal/5 transition-colors">
                <div class="w-12 h-12 bg-pevo-teal/10 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg class="w-6 h-6 text-pevo-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                </div>
                <h3 class="font-semibold text-ink mb-1" x-text="$t('seedPhrase.chooseCreate')"></h3>
                <p class="text-xs text-ink-muted" x-text="$t('seedPhrase.chooseCreateHint')"></p>
              </button>
              <button @click="chooseLink()"
                      class="bg-white border-2 border-parchment-dark rounded-xl p-6 text-center hover:bg-parchment-light transition-colors">
                <div class="w-12 h-12 bg-parchment-light rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg class="w-6 h-6 text-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
                </div>
                <h3 class="font-semibold text-ink mb-1" x-text="$t('seedPhrase.chooseLink')"></h3>
                <p class="text-xs text-ink-muted" x-text="$t('seedPhrase.chooseLinkHint')"></p>
              </button>
            </div>
          </div>

          <!-- Create flow: Seed phrase display -->
          <div x-show="phase === 'create-seed'">
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.title')"></h1>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.description')"></p>

            <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
              <p class="text-amber-800 text-sm font-medium" x-text="$t('seedPhrase.warning')"></p>
            </div>

            <!-- Word grid -->
            <div class="grid grid-cols-3 gap-3 mb-8">
              <template x-for="(word, i) in seedWords" :key="i">
                <div class="bg-white border border-parchment-dark rounded-lg px-3 py-2 text-center">
                  <span class="text-xs text-ink-muted" x-text="(i + 1) + '.'"></span>
                  <span class="ml-1 font-mono text-sm text-ink font-medium" x-text="word"></span>
                </div>
              </template>
            </div>

            <button @click="proceedToConfirm()" class="w-full btn-primary py-2.5" x-text="$t('seedPhrase.iWroteItDown')"></button>
          </div>

          <!-- Create flow: Confirm seed phrase -->
          <div x-show="phase === 'create-confirm'">
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.confirmTitle')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.confirmDescription')"></p>

            <div class="space-y-4 mb-8">
              <template x-for="idx in confirmIndices" :key="idx">
                <div>
                  <label class="block text-sm font-medium text-ink mb-1">
                    <span x-text="$t('seedPhrase.wordNumber', { number: idx + 1 })"></span>
                  </label>
                  <input type="text" x-model="confirmInputs[idx]"
                         class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                         autocomplete="off" autocapitalize="off" spellcheck="false">
                </div>
              </template>
            </div>

            <button @click="proceedToUsername()" :disabled="!confirmCorrect"
                    class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    x-text="$t('seedPhrase.confirm')">
            </button>
            <button @click="phase = 'create-seed'"
                    class="w-full mt-3 text-sm text-ink-muted hover:text-ink underline"
                    x-text="$t('seedPhrase.showWordsAgain')">
            </button>
          </div>

          <!-- Create flow: Choose username -->
          <div x-show="phase === 'create-username'" x-init="watchUsername()">
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.chooseUsername')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.chooseUsernameDescription')"></p>

            <div x-show="error" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="error"></p>
            </div>

            <div class="mb-6">
              <label class="block text-sm font-medium text-ink mb-1" x-text="$t('signup.username')"></label>
              <div class="relative">
                <input type="text" x-model="username" maxlength="16"
                       class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal lowercase"
                       :placeholder="$t('signup.usernamePlaceholder')"
                       @input="username = username.toLowerCase()">
                <div class="absolute right-3 top-1/2 -translate-y-1/2">
                  <span x-show="usernameStatus === 'checking'" class="text-ink-muted text-xs">...</span>
                  <span x-show="usernameStatus === 'available'" class="text-pevo-green text-sm">&#10003;</span>
                  <span x-show="usernameStatus === 'taken'" class="text-pevo-crimson text-sm">&#10007;</span>
                  <span x-show="usernameStatus === 'invalid'" class="text-amber-500 text-sm">&#10007;</span>
                </div>
              </div>
              <p x-show="usernameStatus === 'taken'" class="text-xs text-pevo-crimson mt-1" x-text="$t('signup.usernameTaken')"></p>
              <p x-show="usernameStatus === 'invalid'" class="text-xs text-amber-500 mt-1" x-text="$t('signup.usernameInvalid')"></p>
              <p x-show="!usernameStatus || usernameStatus === 'available' || usernameStatus === 'checking'" class="text-xs text-ink-muted mt-1" x-text="$t('signup.usernameHint')"></p>
            </div>

            <button @click="submitCreateAccount()" :disabled="usernameStatus !== 'available' || isSubmitting"
                    class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    x-text="$t('seedPhrase.createAccount')">
            </button>
          </div>

          <!-- Create flow: Submitting -->
          <div x-show="phase === 'create-submitting'" class="text-center py-16">
            <div class="animate-pulse">
              <div class="w-12 h-12 bg-pevo-teal/20 rounded-full mx-auto mb-4"></div>
              <p class="text-ink-muted" x-text="$t('seedPhrase.creating')"></p>
            </div>
          </div>

          <!-- Link existing account: Keychain step -->
          <div x-show="phase === 'link-keychain'">
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.linkTitle')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.linkDescription')"></p>

            <div x-show="error" class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="error"></p>
            </div>

            <div class="mb-4">
              <label class="block text-sm font-medium text-ink mb-1" x-text="$t('seedPhrase.hiveUsername')"></label>
              <input type="text" x-model="hiveUsername" maxlength="16"
                     class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal lowercase"
                     :placeholder="$t('seedPhrase.hiveUsernamePlaceholder')"
                     @input="hiveUsername = hiveUsername.toLowerCase()">
              <p class="text-xs text-ink-muted mt-1" x-text="$t('seedPhrase.hiveUsernameHint')"></p>
            </div>

            <button @click="handleLinkAccount()" :disabled="isSubmitting || !hiveUsername.trim()"
                    class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed">
              <span x-show="!isSubmitting" x-text="$t('seedPhrase.linkButton')"></span>
              <span x-show="isSubmitting" x-text="$t('seedPhrase.linking')"></span>
            </button>
          </div>

          <!-- Accreditation broadcast outcome uncertain: account finalized,
               verify before retry (genuine timeout, degrade, or self-held bind lock) -->
          <div x-show="phase === 'broadcast-pending'" class="text-center py-16">
            <div class="w-16 h-16 bg-pevo-teal/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-pevo-teal" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.broadcastPendingTitle')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.broadcastPendingDescription')"></p>
            <button @click="navigate('/login')" class="btn-primary" x-text="$t('seedPhrase.broadcastPendingLogin')"></button>
          </div>

          <!-- Done -->
          <div x-show="phase === 'done'" class="text-center py-16">
            <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <h2 class="text-2xl font-bold text-ink mb-2" x-text="$t('seedPhrase.doneTitle')"></h2>
            <p class="text-ink-muted mb-6" x-text="$t('seedPhrase.doneDescription')"></p>
            <button @click="navigate('/papers')" class="btn-primary" x-text="$t('seedPhrase.goToPapers')"></button>
          </div>

        </div>
      </div>`;

export { template as signupVerifyPageTemplate };

// Number of words the user must re-enter to confirm retention
const CONFIRM_WORD_COUNT = 3;

// Username format: 3-16 chars, lowercase a-z, 0-9, dots/hyphens not at start/end
const USERNAME_RE = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const MIN_USERNAME = 3;
const MAX_USERNAME = 16;

function pickRandomIndices(total, count) {
  const indices = [];
  while (indices.length < count) {
    const i = Math.floor(Math.random() * total);
    if (!indices.includes(i)) indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

function isValidUsername(u) {
  return u.length >= MIN_USERNAME && u.length <= MAX_USERNAME && USERNAME_RE.test(u);
}

export function initSignupVerifyPage() {
  Alpine.data('signupVerifyPage', () => ({
    ...createTimerGuard(),
    // Phases: 'verifying' | 'choose' | 'create-seed' | 'create-confirm' | 'create-username' | 'create-submitting' | 'link-keychain' | 'broadcast-pending' | 'done' | 'error'
    phase: 'verifying',
    error: null,

    // Mnemonic (generated client-side)
    mnemonic: null,
    seedWords: [],

    // Auth token returned by verify/resume — used to authenticate confirm/link
    authToken: null,

    // Create flow: username step
    username: '',
    usernameStatus: null, // null | 'checking' | 'available' | 'taken' | 'error'
    _usernameTimer: null,
    isSubmitting: false,

    // Link flow: Hive username
    hiveUsername: '',

    // Resume flow (shown on error phase)
    resumeEmail: '',
    resumePassword: '',
    isResuming: false,
    // True when the resume form was reached from a PENDING_SIGNUP login
    // redirect (vs. a consumed/expired email link). Drives an explanatory
    // note so the user understands why a password re-entry is asked for.
    resumeFromLogin: false,

    // Confirmation step
    confirmIndices: [],
    confirmInputs: {},

    get usernameFormatValid() {
      return isValidUsername(this.username);
    },

    get confirmCorrect() {
      return this.confirmIndices.every(
        (i) => this.confirmInputs[i]?.trim().toLowerCase() === this.seedWords[i]
      );
    },

    init() {
      const query = Alpine.store('router').query || {};

      // Resuming from a PENDING_SIGNUP login redirect. The auth_token is NOT
      // carried in the URL anymore (it is the row-lookup credential for
      // /confirm and /link; passing it via a query param leaks it into logs
      // and Referer). Instead, land on the resume form so the user re-verifies
      // the password via /resume-signup — that call mints the binding cookie
      // and returns a fresh auth_token in its response body. The email is just
      // a UX prefill hint.
      //
      // Guard on the shared RESUME_MARKER, not on the mere presence of an
      // auth_token/email param: a stale or absent auth_token used to encode the
      // string "undefined" here, which is truthy and silently set
      // this.authToken = "undefined", breaking every later /confirm and /link.
      if (query.resume === RESUME_MARKER) {
        this.resumeFromLogin = true;
        if (query.email) this.resumeEmail = query.email;
        this.phase = 'error';
        this.error = null;
        return;
      }

      const emailToken = query.token;
      if (!emailToken) {
        this.phase = 'error';
        this.error = this.$t('seedPhrase.invalidLink');
        return;
      }
      this.verifyToken(emailToken);
    },

    destroy() {
      // _teardownTimers flips _mounted so in-flight verifyEmail / resumeSignup
      // / confirmAccount / linkExistingAccount continuations bail before
      // touching reactive state. Also clears the debounce username timer.
      this._teardownTimers();
      if (this._usernameTimer) {
        clearTimeout(this._usernameTimer);
        this._usernameTimer = null;
      }
    },

    async verifyToken(emailToken) {
      try {
        const res = await verifyEmail(emailToken);
        if (!this._mounted) return;
        if (res.data.flow === 'choose') {
          this.authToken = res.data.auth_token;
          this.phase = 'choose';
        } else {
          this.phase = 'error';
          this.error = this.$t('seedPhrase.unexpectedResponse');
        }
      } catch {
        if (!this._mounted) return;
        // Token already consumed (second click) or expired — show resume form
        this.phase = 'error';
        this.error = null;
      }
    },

    // ─── Choose phase ──────────────────────────────────────────

    chooseCreate() {
      this.mnemonic = generateMnemonic();
      this.seedWords = this.mnemonic.split(' ');
      this.phase = 'create-seed';
    },

    chooseLink() {
      this.phase = 'link-keychain';
    },

    // ─── Create flow: seed → confirm → username → submit ──────

    proceedToConfirm() {
      this.confirmIndices = pickRandomIndices(this.seedWords.length, CONFIRM_WORD_COUNT);
      this.confirmInputs = {};
      this.confirmIndices.forEach((i) => { this.confirmInputs[i] = ''; });
      this.phase = 'create-confirm';
    },

    proceedToUsername() {
      if (!this.confirmCorrect) return;
      this.phase = 'create-username';
    },

    watchUsername() {
      this.$watch('username', (val) => {
        clearTimeout(this._usernameTimer);
        if (!val) {
          this.usernameStatus = null;
          return;
        }
        const normalized = val.trim().toLowerCase();
        if (!isValidUsername(normalized)) {
          this.usernameStatus = normalized.length >= MIN_USERNAME ? 'invalid' : null;
          return;
        }
        this.usernameStatus = 'checking';
        this._usernameTimer = setTimeout(() => this._checkUsername(normalized), 400);
      });
    },

    async _checkUsername(val) {
      try {
        const { Client } = await loadDhive();
        if (!this._mounted) return;
        const client = new Client(['https://api.hive.blog', 'https://api.deathwing.me']);
        const accounts = await client.database.getAccounts([val]);
        if (!this._mounted) return;
        if (this.username.trim().toLowerCase() === val) {
          this.usernameStatus = accounts.length === 0 ? 'available' : 'taken';
        }
      } catch {
        if (!this._mounted) return;
        if (this.username.trim().toLowerCase() === val) this.usernameStatus = 'error';
      }
    },

    async submitCreateAccount() {
      const normalizedUsername = this.username.trim().toLowerCase();
      if (!isValidUsername(normalizedUsername) || this.usernameStatus !== 'available' || this.isSubmitting) return;
      if (!this.authToken) {
        this.error = this.$t('seedPhrase.credentialsRequired');
        return;
      }

      this.isSubmitting = true;
      this.error = null;
      this.phase = 'create-submitting';

      try {
        // Derive all keys from mnemonic + username
        const allKeys = await deriveAllKeys(this.mnemonic, normalizedUsername);
        if (!this._mounted) return;

        const keys = {
          owner_public: allKeys.owner.public,
          active_public: allKeys.active.public,
          posting_public: allKeys.posting.public,
          memo_public: allKeys.memo.public,
          posting_private: allKeys.posting.private,
          memo_private: allKeys.memo.private,
        };

        const res = await confirmAccount(this.authToken, normalizedUsername, keys);
        if (!this._mounted) return;

        // Set auth state via the shared helper. expiresAt rotates with
        // the new token as an atomic pair; the helper persists state via
        // _saveSession(). isAccredited=true because successful confirm
        // implies a verified ORCID identity; custody='light' because new
        // accounts created via this path are server-custodial until the
        // user upgrades.
        const auth = Alpine.store('auth');
        auth.loginFromResponse({
          token: res.data.token,
          expires_at: res.data.expires_at,
          username: res.data.username,
          custody: 'light',
          is_accredited: true,
          accreditation: res.data.accreditation ?? null,
        });

        this.phase = 'done';
      } catch (err) {
        if (!this._mounted) return;
        // Ambiguous broadcast outcome takes precedence over the generic
        // failure path: the account is already finalized, so do not bounce to
        // the username entry phase or imply creation failed.
        if (this._handleAmbiguousBroadcastOutcome(err)) return;
        // Sanitization pattern (see executeUpgrade() in settings.js). The
        // create-account path derives keys from the BIP39 mnemonic, so
        // surfacing raw err.message risks leaking key-adjacent material
        // (seed words, hex entropy) on a future error shape.
        console.warn('[signup verify create account]', err);
        this.error = this.$t('seedPhrase.createAccountFailed');
        this.phase = 'create-username';
      } finally {
        if (this._mounted) this.isSubmitting = false;
      }
    },

    // Ambiguous broadcast outcome: the accreditation broadcast may have landed
    // but its result is unconfirmed from this request's view (a genuine
    // broadcast timeout, a degrade forced-ambiguous response, or a self-held
    // binding lock from this account's own prior timed-out attempt). The
    // account itself is already finalized, so a blind retry risks a duplicate
    // bind and the terminal "creation failed" copy + bounce to the entry phase
    // is misleading. Surface a calm verify-before-retry affordance instead.
    // Mirrors the orcid-callback.js BROADCAST_TIMEOUT branch. Returns true when
    // it handled the error (caller must skip its generic-failure handling).
    _handleAmbiguousBroadcastOutcome(err) {
      if (err?.code !== 'BROADCAST_TIMEOUT') return false;
      this.phase = 'broadcast-pending';
      return true;
    },

    // ─── Link flow ─────────────────────────────────────────────

    async handleLinkAccount() {
      if (!this.hiveUsername || this.isSubmitting) return;
      if (!this.authToken) {
        this.error = this.$t('seedPhrase.credentialsRequired');
        return;
      }
      if (!isKeychainInstalled()) {
        this.error = this.$t('seedPhrase.keychainRequired');
        return;
      }

      this.isSubmitting = true;
      this.error = null;
      try {
        const username = this.hiveUsername.trim().toLowerCase();
        const res = await linkExistingAccount(this.authToken, username);
        if (!this._mounted) return;

        // Set auth state via the shared helper. expiresAt rotates with
        // the new token as an atomic pair. isAccredited=true since the
        // link path requires a verified ORCID identity; custody='self'
        // since linking attaches a user-controlled Hive account
        // (Keychain) instead of server-custodial light keys.
        const auth = Alpine.store('auth');
        auth.loginFromResponse({
          token: res.data.token,
          expires_at: res.data.expires_at,
          username: res.data.username,
          custody: 'self',
          is_accredited: true,
          accreditation: res.data.accreditation ?? null,
        });

        this.phase = 'done';
      } catch (err) {
        if (!this._mounted) return;
        // Ambiguous broadcast outcome takes precedence over the generic
        // failure path: the account is already activated, so do not imply the
        // link failed. See _handleAmbiguousBroadcastOutcome.
        if (this._handleAmbiguousBroadcastOutcome(err)) return;
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[signup verify link account]', err);
        this.error = this.$t('seedPhrase.linkAccountFailed');
      } finally {
        if (this._mounted) this.isSubmitting = false;
      }
    },

    // ─── Resume flow ───────────────────────────────────────────

    async handleResume() {
      if (!this.resumeEmail || !this.resumePassword || this.isResuming) return;
      this.isResuming = true;
      this.error = null;

      try {
        const res = await resumeSignup(this.resumeEmail, this.resumePassword);
        if (!this._mounted) return;
        if (res.data.flow === 'choose') {
          this.authToken = res.data.auth_token;
          this.phase = 'choose';
        } else {
          this.error = this.$t('seedPhrase.unexpectedResponse');
        }
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see executeUpgrade() in settings.js). The
        // resume path handles email/password auth; backend error shapes
        // can embed credential-adjacent text on unusual failures.
        console.warn('[signup verify resume]', err);
        this.error = this.$t('seedPhrase.resumeFailed');
      } finally {
        if (this._mounted) this.isResuming = false;
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
