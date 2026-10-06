import Alpine from 'alpinejs';
import { disputeRecovery } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const template = `
      <div x-data="recoverDisputePage" class="container-narrow py-16">
        <div class="max-w-md mx-auto text-center">

          <template x-if="state === 'ready' || state === 'submitting'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.disputeTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.disputeDescription')"></p>
              <button type="button" @click="submit()" :disabled="state === 'submitting'"
                      class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
                <span x-show="state === 'ready'" x-text="$t('recover.disputeButton')"></span>
                <span x-show="state === 'submitting'" x-text="$t('recover.disputeSubmitting')"></span>
              </button>
            </div>
          </template>

          <template x-if="state === 'done'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.disputeDoneTitle')"></h1>
              <p class="text-ink-muted mb-6" x-text="$t('recover.disputeDone')"></p>
              <a :href="$lp('/contact')" @click.prevent="navigate('/contact')" class="btn-secondary no-underline" x-text="$t('contact.title')"></a>
            </div>
          </template>

          <template x-if="state === 'invalid'">
            <div>
              <h1 class="text-2xl font-bold text-ink mb-2" x-text="$t('recover.linkInvalidTitle')"></h1>
              <p class="text-ink-muted" x-text="$t('recover.disputeInvalid')"></p>
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

export { template as recoverDisputePageTemplate };

// The page a seed-phrase recovery's stop link opens, mailed to the account's
// previous address. The token is sent only from the stop button: a mail
// scanner on that mailbox that opened the link and ran the page would
// otherwise stop every recovery, the owner's own included.
//
// The server answers the same whether or not the recovery had already been
// confirmed, so the done copy covers both.
export function initRecoverDisputePage() {
  Alpine.data('recoverDisputePage', () => ({
    ...createTimerGuard(),

    state: 'ready', // ready | submitting | done | invalid | failed
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

    async submit() {
      if (this.state !== 'ready' && this.state !== 'failed') return;
      this.state = 'submitting';
      try {
        await disputeRecovery(this._token);
        if (!this._mounted) return;
        this.state = 'done';
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[recover dispute]', err);
        this.state = err?.code === 'INVALID_TOKEN' ? 'invalid' : 'failed';
      }
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
