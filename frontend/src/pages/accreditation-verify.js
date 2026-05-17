import Alpine from 'alpinejs';
import { verifyAccreditation } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const template = `
      <div x-data="accreditationVerifyPage" class="container-narrow py-16 text-center">
        <template x-if="state === 'loading'">
          <div>
            <h1 class="text-2xl font-bold text-ink mb-4" x-text="$t('verify.title')"></h1>
            <p class="text-ink-muted" x-text="$t('verify.pleaseWait')"></p>
          </div>
        </template>
        <template x-if="state === 'success'">
          <div>
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-green-light mb-6">
              <svg class="h-8 w-8 text-pevo-green" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" /></svg>
            </div>
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('verify.confirmedTitle')"></h1>
            <p class="text-ink-muted mb-6" x-text="$t('verify.confirmedMessage', { username: '@' + resultUsername })"></p>
            <div class="flex gap-3 justify-center">
              <a :href="$lp('/profile/' + resultUsername)" @click.prevent="navigate('/profile/' + resultUsername)" class="btn-primary no-underline" x-text="$t('verify.viewProfile')"></a>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="btn-secondary no-underline" x-text="$t('verify.browsePapers')"></a>
            </div>
          </div>
        </template>
        <template x-if="state === 'error'">
          <div>
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-crimson-light mb-6">
              <svg class="h-8 w-8 text-pevo-crimson" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
            </div>
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('verify.failedTitle')"></h1>
            <p class="text-ink-muted mb-6" x-text="errorMessage"></p>
            <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary no-underline" x-text="$t('verify.requestNew')"></a>
          </div>
        </template>
        <template x-if="state === 'retriable_error'">
          <div>
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-pevo-teal-light mb-6">
              <svg class="h-8 w-8 text-pevo-teal" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd" /></svg>
            </div>
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('verify.failedTitle')"></h1>
            <p class="text-ink-muted mb-6" x-text="errorMessage"></p>
            <button
              type="button"
              @click="retryVerification()"
              :disabled="retryCooldownRemaining > 0"
              class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              x-text="retryCooldownRemaining > 0 ? $t('verify.retryAvailableIn', { seconds: retryCooldownRemaining }) : $t('verify.retry')"
            ></button>
          </div>
        </template>
      </div>
`;

export { template as accreditationVerifyPageTemplate };

export function initAccreditationVerifyPage() {
  Alpine.data('accreditationVerifyPage', () => ({
    // Lifecycle guard. See frontend/src/lib/timer-guard.js. The .then/.catch
    // below fire after a multi-second network round-trip; a user navigating
    // away mid-flight destroys the component, and the resolution must not
    // write to torn-down reactive state.
    ...createTimerGuard(),

    state: 'loading', // loading | success | error | retriable_error
    resultUsername: '',
    errorMessage: '',
    retryCooldownRemaining: 0,
    // Token captured at init so Retry uses the same token the user received
    // in their accreditation email — the backend explicitly preserves the
    // token on `ACCREDITATION_GATE_UNAVAILABLE` (see backend route
    // accreditation.ts gate-catch branch).
    _token: null,
    // Per-countdown opaque id. Each new countdown bumps this; chained
    // setTimeout callbacks only re-arm while their captured id still matches,
    // so a fresh countdown supersedes an in-flight one without racing.
    _cooldownId: 0,
    // Per-verify-flight opaque id. Bumped synchronously at the top of
    // `_verify()` and captured into the `.then`/`.catch` closures; the
    // resolution branches bail before writing state if a newer flight has
    // since superseded them. Mirrors the `_cooldownId` supersession pattern
    // above. See `agents/docs/solutions/conventions/
    // synchronous-flag-before-await-idempotency-guard-2026-05-16.md`.
    _verifyGeneration: 0,

    navigate(path) { Alpine.store('router').navigate(path); },

    destroy() {
      this._teardownTimers();
    },

    init() {
      const token = Alpine.store('router').query.token;
      if (!token) {
        this.state = 'error';
        this.errorMessage = this.$t('verify.noToken');
        return;
      }
      this._token = token;
      this._verify();
    },

    retryVerification() {
      // Double-submit guard: if a verify flight is already in flight (state
      // flipped to 'loading' on entry), drop the click. Belt+suspenders with
      // the `_verifyGeneration` supersession below — this stops the second
      // flight from ever dispatching; the generation counter is the
      // defensive backstop if a future caller bypasses retryVerification().
      if (this.state === 'loading') return;
      if (this.retryCooldownRemaining > 0) return;
      this.state = 'loading';
      this.errorMessage = '';
      this._verify();
    },

    _verify() {
      // Bump synchronously so concurrent in-flight `.then`/`.catch`
      // closures captured a now-stale generation and bail before writing
      // state. The bump precedes the `verifyAccreditation()` dispatch so
      // even a same-tick second `_verify()` invocation captures a higher
      // generation than the first flight's closures.
      const generation = ++this._verifyGeneration;
      verifyAccreditation(this._token)
        .then((res) => {
          if (!this._mounted) return;
          if (generation !== this._verifyGeneration) return;
          this.state = 'success';
          this.resultUsername = res.data.username;
        })
        .catch((err) => {
          if (!this._mounted) return;
          if (generation !== this._verifyGeneration) return;
          // Sanitization pattern (see executeUpgrade() in settings.js).
          console.warn('[accreditation verify]', err);
          if (this._isRetriable(err)) {
            this.state = 'retriable_error';
            this.errorMessage = this.$t('verify.serviceTemporarilyUnavailable');
            this._startCooldown(err.retryAfterSeconds);
          } else {
            this.state = 'error';
            this.errorMessage = this.$t('verify.verificationFailed');
          }
        });
    },

    _isRetriable(err) {
      return err?.code === 'ACCREDITATION_GATE_UNAVAILABLE'
        || err?.details?.retriable === true;
    },

    _startCooldown(seconds) {
      const initial = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
      this.retryCooldownRemaining = initial;
      const id = ++this._cooldownId;
      if (initial > 0) this._tickCooldown(id);
    },

    _tickCooldown(id) {
      this._setTimer(() => {
        if (id !== this._cooldownId) return;
        if (this.retryCooldownRemaining <= 0) return;
        this.retryCooldownRemaining -= 1;
        if (this.retryCooldownRemaining > 0) this._tickCooldown(id);
      }, 1000);
    },
  }));
}
