import Alpine from 'alpinejs';
import { completeOrcid } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';

// Cap on self-triggered retries of a retriable 409 ORCID_ALREADY_LINKED.
// After this many automatic retries, switch to the durable-binding message
// instead of re-arming another countdown, so the user isn't trapped in an
// infinite retry loop if the backend keeps reporting contention.
const MAX_RETRIES = 1;

const template = `
      <div x-data="orcidCallbackPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto text-center py-16">
          <!-- Verifying -->
          <div x-show="status === 'verifying'">
            <div class="animate-pulse text-ink-muted mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.verifyingOrcid')"></p>
          </div>

          <!-- Login success (brief, auto-redirects) -->
          <div x-show="status === 'login-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.loginSuccess')"></p>
          </div>

          <!-- Accreditation success -->
          <div x-show="status === 'accredit-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink font-medium mb-2" x-text="$t('orcid.verificationSuccess')"></p>
            <a :href="$lp('/profile/' + resultUsername)" @click.prevent="navigate('/profile/' + resultUsername)" class="btn-primary inline-block mt-4 no-underline" x-text="$t('orcid.viewProfile')"></a>
          </div>

          <!-- Error -->
          <div x-show="status === 'error'">
            <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="errorKind === 'alreadyLinkedRetriable' ? $t('orcid.alreadyLinkedRetriable', { seconds: retryCountdown }) : errorMessage"></p>
            </div>
            <template x-if="errorAction === 'signup'">
              <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="btn-primary inline-block no-underline" x-text="$t('common.signUp')"></a>
            </template>
            <template x-if="errorAction === 'recover'">
              <a :href="$lp('/recover')" @click.prevent="navigate('/recover')" class="btn-primary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
            <template x-if="errorAction === 'settings'">
              <a :href="$lp('/settings')" @click.prevent="navigate('/settings')" class="btn-primary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
            <template x-if="errorAction === 'retry'">
              <button @click="_retryVerify()" :disabled="retryCountdown > 0" class="btn-primary inline-block no-underline" x-text="$t('common.retry')"></button>
            </template>
            <template x-if="errorAction === '' || errorAction === null">
              <a :href="$lp(backPath)" @click.prevent="navigate(backPath)" class="btn-secondary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
          </div>
        </div>
      </div>
`;

export { template as orcidCallbackPageTemplate };

export function initOrcidCallbackPage() {
  Alpine.data('orcidCallbackPage', () => ({
    // Lifecycle guards (spread first). Every async continuation (awaited
    // promise resolution, setTimeout callback) that writes to component
    // state or fires navigation must check _mounted first. Timers are
    // tracked in _pendingTimers and cleared in destroy() so a user
    // navigating away mid-wait does not trip post-teardown state mutations.
    // See frontend/src/lib/timer-guard.js for the helper contract.
    ...createTimerGuard(),

    status: 'verifying',
    errorMessage: '',
    errorAction: '', // 'signup' for NO_ACCOUNT, 'recover' for durable ORCID_ALREADY_LINKED, 'settings' for BROADCAST_TIMEOUT, 'retry' for retriable ORCID_ALREADY_LINKED, else empty
    errorKind: '', // 'alreadyLinkedRetriable' surfaces countdown-parameterized i18n; other branches render the static errorMessage key
    retryCountdown: 0,
    // Cap self-triggered retries of a retriable 409 to MAX_RETRIES. On the
    // (MAX_RETRIES+1)th retriable response, surface the durable message so
    // the user stops seeing a countdown that keeps re-arming. Counter resets
    // on a successful verify (inside _verify after the await resolves without
    // throwing) and on destroy().
    _retryCount: 0,
    // Stash last _verify args so a user-initiated retry (retriable 409) can
    // re-invoke against the same state token. Reused by _retryVerify(); the
    // state token remains valid so long as the backend-side Redis record has
    // not been consumed (single-use) and has not expired.
    _lastVerifyArgs: null,
    resultUsername: '',
    backPath: '/',

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      const code = Alpine.store('router').query.code;
      const state = Alpine.store('router').query.state;

      if (!code || typeof code !== 'string' || code.length > 100 ||
          !state || typeof state !== 'string' || state.length > 256) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.missingParams');
        return;
      }

      // Read mode from localStorage (set before redirect) for error routing.
      // Do NOT remove it here. If completeOrcid fails (e.g. 503) and the user
      // refreshes, we need the mode to still be present so the retry can
      // reach the correct endpoint with the correct auth. It's cleared after
      // completeOrcid resolves successfully inside _verify.
      const mode = localStorage.getItem('pevo_orcid_mode') || '';

      if (mode === 'signup' || mode === 'login') {
        this.backPath = mode === 'signup' ? '/signup' : '/login';
      } else if (mode === 'accredit') {
        this.backPath = '/accreditation';
      } else if (mode === 'link') {
        this.backPath = '/settings';
      }

      this._verify(code, state, mode);
    },

    destroy() {
      this._teardownTimers();
      this._retryCount = 0;
    },

    async _verify(code, state, mode) {
      this._lastVerifyArgs = { code, state, mode };
      let res;
      try {
        res = await completeOrcid(code, state, mode);
      } catch (err) {
        if (!this._mounted) return;
        this.status = 'error';

        if (err.code === 'NO_ACCOUNT') {
          this.errorMessage = this.$t('orcid.noAccountFound');
          this.errorAction = 'signup';
          return;
        }

        // ORCID_ALREADY_LINKED has a retriable discriminator per
        // api-contracts/orcid.md. `err.details?.retriable === true` OR a
        // parsed `Retry-After` header signals lock contention (transient);
        // absence of both signals a durable binding (on-chain accreditation
        // to another account, or a cache-lag record of one).
        if (err.code === 'ORCID_ALREADY_LINKED') {
          // Loose `!= null` intentionally catches both `null` (api.js default
          // when Retry-After header absent) and `undefined` (defensive: a
          // thrown value constructed outside the ApiRequestError constructor
          // may omit the field entirely). `!== null` alone misclassifies
          // `undefined` as retriable, which would arm a countdown on a
          // durable-binding error.
          const retriable = err.details?.retriable === true || err.retryAfterSeconds != null;
          // Retriable 409 flagged but we've already burned our self-retry
          // budget. Fall through to the durable-binding message so the user
          // isn't stuck watching the countdown re-arm indefinitely.
          if (retriable && this._retryCount >= MAX_RETRIES) {
            this.errorMessage = this.$t('orcid.alreadyLinkedDurable');
            this.errorAction = 'recover';
            return;
          }
          if (retriable) {
            // Parametric i18n — the countdown renders in real time via the
            // template's $t('orcid.alreadyLinkedRetriable', { seconds: retryCountdown }).
            this.errorKind = 'alreadyLinkedRetriable';
            this.errorAction = 'retry';
            // Clamp to [1, 300]s. Lower bound: `Retry-After: 0` would
            // collapse the UX into an immediate synchronous-looking retry
            // loop (the nullish coalesce does NOT fire on 0, so without
            // the lower clamp a zero-second hint would trigger
            // _retryVerify() on the very next tick). Upper bound:
            // a misconfigured backend or proxy emitting `Retry-After:
            // 99999` would otherwise pin the user on the page for hours
            // with the retry button disabled; 300s (5 min) is a
            // conservative cap. Anything legitimately larger is a
            // backend bug worth surfacing rather than respecting silently.
            const seconds = Math.max(1, Math.min(300, err.retryAfterSeconds ?? 10));
            this.retryCountdown = seconds;
            // Ticks every 1s until zero; re-invokes _retryVerify() at zero
            // for up to MAX_RETRIES self-triggered retries (task non-goal:
            // exponential backoff). Timers route through _setTimer so
            // destroy() tears them down cleanly.
            this._tickRetryCountdown();
          } else {
            this.errorMessage = this.$t('orcid.alreadyLinkedDurable');
            this.errorAction = 'recover';
          }
          return;
        }

        // Forward-compat for BE-ORCID-BROADCAST-ABORT-TIMEOUT: backend may
        // emit this code once the 504 envelope lands. Surfacing it now is
        // safe — the branch is inert until the code appears on the wire.
        if (err.code === 'BROADCAST_TIMEOUT') {
          this.errorMessage = this.$t('orcid.broadcastPending');
          this.errorAction = 'settings';
          return;
        }

        // NO_ACCOUNT and VALIDATION_ERROR are semantic codes, safe to
        // branch on. All other failures take the generic-message +
        // console.warn sanitization path shared with executeUpgrade() in
        // settings.js. console.warn fires only on the generic fallback,
        // not on expected VALIDATION_ERROR responses (avoids log noise).
        if (err.code === 'VALIDATION_ERROR') {
          this.errorMessage = this.$t('signup.orcidInsufficientWorks');
        } else {
          console.warn('[orcid callback complete]', err);
          this.errorMessage = this.$t('orcid.verificationFailed');
        }
        return;
      }

      if (!this._mounted) return;
      const data = res.data;

      // Successful verify clears the self-retry budget so a later fresh flow
      // (same component instance, e.g. navigate-back) starts from zero.
      this._retryCount = 0;

      // Only clear the stored mode after completeOrcid resolved successfully.
      // If this throws (e.g. 503), we leave it so a refresh can retry.
      // If any handler below later gains an `await`, move this removeItem
      // inside the handler after the mutation resolves. Otherwise a mid-await
      // destroy() could clear the mode without routing the flow, breaking
      // the 503-refresh-retry invariant.
      localStorage.removeItem('pevo_orcid_mode');

      // Handlers self-guard on _mounted. The dispatch-level check above is
      // belt-and-suspenders — either guard alone would suffice; both together
      // tolerate a direct-call code path being added later without re-reading
      // the whole file.
      switch (data.mode) {
        case 'signup':
          this._handleSignup(data);
          break;
        case 'login':
          this._handleLogin(data);
          break;
        case 'accredit':
          this._handleAccredit(data);
          break;
        case 'link':
          this._handleLink(data);
          break;
        default:
          this.status = 'error';
          this.errorMessage = this.$t('orcid.verificationFailed');
      }
    },

    // Countdown tick for retriable ORCID_ALREADY_LINKED 409. Decrements
    // retryCountdown once per second; when it hits zero, auto-invokes
    // _retryVerify() (up to MAX_RETRIES self-triggered retries, not
    // aggressive backoff). Each tick is armed through _setTimer so
    // component teardown cancels any pending tick — no post-teardown
    // state writes.
    _tickRetryCountdown() {
      if (!this._mounted) return;
      if (this.retryCountdown <= 0) {
        this._retryVerify();
        return;
      }
      this._setTimer(() => {
        if (!this._mounted) return;
        this.retryCountdown = Math.max(0, this.retryCountdown - 1);
        this._tickRetryCountdown();
      }, 1000);
    },

    _retryVerify() {
      if (!this._mounted) return;
      if (!this._lastVerifyArgs) return;
      // Increment BEFORE re-invoking _verify so that if the next response is
      // again retriable, the catch block can compare _retryCount >= MAX_RETRIES
      // and bail out to the durable-binding branch instead of arming another
      // countdown. Reset to 0 on a successful verify (see post-await block
      // in _verify) and on destroy() (so a re-mount starts fresh).
      this._retryCount += 1;
      // Reset error UI for the retry attempt.
      this.status = 'verifying';
      this.errorMessage = '';
      this.errorAction = '';
      this.errorKind = '';
      this.retryCountdown = 0;
      const { code, state, mode } = this._lastVerifyArgs;
      this._verify(code, state, mode);
    },

    _handleSignup(data) {
      if (!this._mounted) return;
      // Store verified ORCID nonce for the signup page
      localStorage.setItem('pevo_signup_orcid_token', data.orcid_token);
      localStorage.setItem('pevo_signup_orcid_id', data.orcid_id);
      // Note: `data.name` intentionally not persisted. Auto-fill of the
      // full name field was considered (and the orphaned
      // pevo_signup_orcid_name key was previously written here for that)
      // but the signup form never reads it and the feature was abandoned.
      // The user fills Full Name themselves; ORCID surfaces the ID only.

      // Return to the originating page (signup or recover)
      const returnTo = localStorage.getItem('pevo_orcid_return_to');
      localStorage.removeItem('pevo_orcid_return_to');
      this.navigate(returnTo === 'recover' ? '/recover' : '/signup');
    },

    _handleLogin(data) {
      if (!this._mounted) return;
      this.status = 'login-success';

      const auth = Alpine.store('auth');
      auth.token = data.token;
      auth.username = data.username;
      auth.isConnected = true;
      auth.custody = data.custody || 'light';
      auth.expiresAt = data.expires_at;
      // Reset accreditation state for the newly-logged-in ORCID username so
      // no-arg _saveSession() does not carry stale values (from a prior session
      // or the initial store defaults after a re-login as a different user)
      // into localStorage. _checkAccreditation() below refreshes these from
      // the server, but _saveSession runs synchronously before that resolves.
      auth.isAccredited = false;
      auth.accreditation = null;

      auth._saveSession();

      // Start the accreditation polling loop (matches sibling login paths
      // `loginFromResponse` and `connect` in auth.js). A bare
      // `_checkAccreditation()` is a single fetch — a transient failure
      // (network flap, slow backend) would leave the store at
      // `isAccredited=false` permanently until manual reload. The polling
      // loop retries every 60s and self-stops once accreditation is
      // confirmed (or the user disconnects).
      auth._startAccreditationPolling();

      Alpine.store('toast').show(this.$t('orcid.loginSuccess'), 'success');
      this._setTimer(() => this.navigate('/papers'), 500);
    },

    _handleAccredit(data) {
      if (!this._mounted) return;
      this.status = 'accredit-success';
      this.resultUsername = data.username;

      // Refresh accreditation data in auth store
      Alpine.store('auth')._checkAccreditation();
      Alpine.store('toast').show(this.$t('orcid.verificationSuccess'), 'success');
    },

    _handleLink(data) {
      if (!this._mounted) return;
      // Signal settings page to show success
      localStorage.setItem('pevo_orcid_link_complete', '1');
      this.navigate('/settings');
    },
  }));
}
