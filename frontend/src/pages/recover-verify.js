import Alpine from 'alpinejs';
import { verifyRecovery } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const template = `
      <div x-data="recoverVerifyPage" class="container-narrow py-16">
        <div class="max-w-md mx-auto text-center">

          <template x-if="state === 'ready' || state === 'submitting'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.verifyTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.verifyDescription')"></p>
              <button type="button" @click="submit()" :disabled="state === 'submitting'"
                      class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                <span x-show="state === 'ready'" x-text="$t('recover.verifyButton')"></span>
                <span x-show="state === 'submitting'" x-text="$t('recover.verifySubmitting')"></span>
              </button>
            </div>
          </template>

          <template x-if="state === 'done'">
            <div>
              <div class="w-16 h-16 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-8 h-8 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
              </div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.doneTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t(doneCopy.description)"></p>
              <button type="button" @click="doneAction()" class="btn-primary" x-text="$t(doneCopy.action)"></button>
            </div>
          </template>

          <template x-if="state === 'invalid'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.linkInvalidTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.verifyInvalid')"></p>
              <div class="flex gap-3 justify-center">
                <a :href="$lp('/login')" @click.prevent="navigate('/login')" class="btn-primary no-underline" x-text="$t('recover.goToLogin')"></a>
                <a :href="$lp('/recover')" @click.prevent="navigate('/recover')" class="btn-secondary no-underline" x-text="$t('recover.startAgain')"></a>
              </div>
            </div>
          </template>

          <template x-if="state === 'duplicate'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.verifyDuplicateTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.verifyDuplicate')"></p>
              <a :href="$lp('/recover')" @click.prevent="navigate('/recover')" class="btn-primary no-underline" x-text="$t('recover.startAgain')"></a>
            </div>
          </template>

          <template x-if="state === 'failed'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.linkFailedTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.linkFailed')"></p>
              <button type="button" @click="submit()" class="btn-primary" x-text="$t('common.tryAgain')"></button>
            </div>
          </template>

        </div>
      </div>
`;

export { template as recoverVerifyPageTemplate };

// The page a seed-phrase recovery's confirmation link opens. The token is
// sent only from the confirm button: the link is single-use, so a mail
// scanner that opened the link and ran the page would otherwise spend it.
export function initRecoverVerifyPage() {
  Alpine.data('recoverVerifyPage', () => ({
    ...createTimerGuard(),

    state: 'ready', // ready | submitting | done | invalid | duplicate | failed
    // Whether this browser took up the recovered account's reissued session.
    signedIn: false,
    // The server's answer, kept for the done screen's switch when another
    // account stayed signed in.
    _recovered: null,
    _token: null,

    init() {
      const token = Alpine.store('router').query?.token;
      if (!token) {
        this.state = 'invalid';
        return;
      }
      this._token = token;
    },

    destroy() {
      this._teardownTimers();
    },

    get doneCopy() {
      if (this.signedIn) {
        return { description: 'recover.verifyDoneSignedIn', action: 'recover.goToSettings' };
      }
      return { description: 'recover.verifyDoneOtherAccount', action: 'recover.switchAccount' };
    },

    // When another account stayed signed in, the button switches this
    // browser to the recovered account at the user's request.
    doneAction() {
      if (this.signedIn) return this.navigate('/settings');
      this.signedIn = Alpine.store('auth').adoptRecoveredSession(this._recovered, { replaceAnotherAccount: true });
    },

    async submit() {
      if (this.state !== 'ready' && this.state !== 'failed') return;
      this.state = 'submitting';
      try {
        const res = await verifyRecovery(this._token);
        // The link is spent and the account's other sessions are revoked
        // once the server answers, so the answer goes to
        // adoptRecoveredSession even if the page has gone.
        const signedIn = Alpine.store('auth').adoptRecoveredSession(res.data);
        if (!this._mounted) return;
        this._recovered = res.data;
        this.signedIn = signedIn;
        this.state = 'done';
      } catch (err) {
        if (!this._mounted) return;
        if (err?.code === 'INVALID_TOKEN') {
          this.state = 'invalid';
        } else if (err?.code === 'DUPLICATE') {
          this.state = 'duplicate';
        } else {
          // Sanitization pattern (see executeUpgrade() in settings.js).
          console.warn('[recover verify]', err);
          this.state = 'failed';
        }
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
