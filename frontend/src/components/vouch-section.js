import Alpine from 'alpinejs';
import { fetchVouchStatus, notifyVouch, notifyRetractVouch } from '../api.js';
import { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } from '../lib/fresh-auth.js';
import { getAppTag } from '../config.js';
import { createTimerGuard } from '../lib/timer-guard.js';

export function initVouchSection() {
  Alpine.data('vouchSection', (opts = {}) => ({
    // Lifecycle guard. See frontend/src/lib/timer-guard.js. handleVouch /
    // handleRetract / loadVouchStatus all await multi-second I/O (Hive
    // broadcast + backend notify + HAF status fetch). Post-teardown writes
    // to `step` / `message` / `vouchStatus` are a classic Alpine race.
    ...createTimerGuard(),

    targetUsername: opts.targetUsername || '',
    isTargetAccredited: opts.isTargetAccredited || false,
    vouchStatus: null,
    loading: true,
    step: 'idle',
    relationship: 'colleague',
    retractReason: '',
    showRetract: false,
    message: '',

    navigate(path) { Alpine.store('router').navigate(path); },
    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },

    destroy() {
      this._teardownTimers();
    },

    get currentUserHasVouched() {
      return this.vouchStatus?.vouches?.some((v) => v.voucher === this.username) ?? false;
    },

    get isLightAccount() {
      return Alpine.store('auth').custody === 'light';
    },

    get canVouch() {
      return this.isConnected && !this.isLightAccount && this.username !== this.targetUsername && !this.currentUserHasVouched && !this.isTargetAccredited;
    },

    get canRetract() {
      return this.isConnected && !this.isLightAccount && this.currentUserHasVouched;
    },

    relationshipLabel(r) {
      switch (r) {
        case 'colleague': return this.$t('wot.colleague');
        case 'advisor': return this.$t('wot.advisor');
        case 'collaborator': return this.$t('wot.collaborator');
        default: return r;
      }
    },

    formatDate(iso) {
      return new Date(iso).toLocaleDateString();
    },

    init() {
      this.loadVouchStatus();
    },

    async loadVouchStatus() {
      try {
        const res = await fetchVouchStatus(this.targetUsername);
        if (!this._mounted) return;
        this.vouchStatus = res.data;
      } catch {
        if (!this._mounted) return;
        this.vouchStatus = null;
      } finally {
        if (this._mounted) this.loading = false;
      }
    },

    async handleVouch() {
      if (!this.username) return;
      if (this.step === 'signing') return;
      this.step = 'signing';
      this.message = '';
      try {
        const APP_TAG = getAppTag();
        const broadcastResult = await broadcastWithFreshAuth(this.username, [['custom_json', {
          required_auths: [],
          required_posting_auths: [this.username],
          id: APP_TAG,
          json: JSON.stringify({
            action: 'vouch',
            voucher: this.username,
            vouchee: this.targetUsername,
            relationship: this.relationship,
            timestamp: new Date().toISOString(),
          }),
        }]]);
        if (!this._mounted) return;
        // FRESH_AUTH_REDIRECT_PENDING covers both the ORCID redirect-in-flight
        // case and the 403 username_mismatch disconnect+toast case. Reset
        // the step machine so the UI doesn't hang at 'signing' indefinitely
        // when the page doesn't navigate away (the 403 path).
        if (broadcastResult === FRESH_AUTH_REDIRECT_PENDING) {
          this.step = 'idle';
          return;
        }
        try {
          const res = await notifyVouch(this.targetUsername);
          if (!this._mounted) return;
          const accMsg = res.data.accredited
            ? ` ${this.$t('wot.accreditedViaWot', { username: this.targetUsername })}`
            : '';
          this.step = 'success';
          this.message = `${this.$t('wot.vouchSuccess')}${accMsg}`;
        } catch {
          if (!this._mounted) return;
          this.step = 'success';
          this.message = this.$t('wot.vouchBroadcastPending');
        }
        await this.loadVouchStatus();
      } catch (err) {
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[vouch]', err);
        this.message = this.$t('wot.vouchFailed');
      }
    },

    async handleRetract() {
      if (!this.username) return;
      if (this.step === 'signing') return;
      this.step = 'signing';
      this.message = '';
      try {
        const APP_TAG2 = getAppTag();
        const broadcastResult = await broadcastWithFreshAuth(this.username, [['custom_json', {
          required_auths: [],
          required_posting_auths: [this.username],
          id: APP_TAG2,
          json: JSON.stringify({
            action: 'retract_vouch',
            voucher: this.username,
            vouchee: this.targetUsername,
            reason: this.retractReason || this.$t('retraction.banner'),
            timestamp: new Date().toISOString(),
          }),
        }]]);
        if (!this._mounted) return;
        // See handleVouch above for the rationale on the explicit step
        // reset; both paths share the same FRESH_AUTH_REDIRECT_PENDING
        // semantics from broadcastWithFreshAuth.
        if (broadcastResult === FRESH_AUTH_REDIRECT_PENDING) {
          this.step = 'idle';
          return;
        }
        try {
          const res = await notifyRetractVouch(this.targetUsername);
          if (!this._mounted) return;
          // The retract custom_json broadcast already succeeded above;
          // revocation_outcome describes the cascade revocation of dependent
          // accreditations. Surface its state honestly rather than always showing
          // success copy: a fail-closed (unverified) or errored cascade must not
          // read as a clean success. revocations is [] on the non-revoked arms.
          const outcome = res.data.revocation_outcome;
          if (outcome === 'timeout' || outcome === 'chain_error') {
            this.step = 'error';
            this.message = this.$t('wot.retractRevocationDegraded');
          } else if (outcome === 'unverified') {
            // The on-chain retract may just be lagging HAF ingestion; not an
            // error, so it stays green with a re-check-shortly message.
            this.step = 'success';
            this.message = this.$t('wot.retractUnverified');
          } else {
            // 'revoked' (cascade done), 'skipped' (nothing to cascade), or a
            // response that predates the discriminator: the retract succeeded.
            const revocations = res.data.revocations || [];
            const revMsg = revocations.length > 0
              ? ` ${this.$t('wot.accreditationRevoked', { accounts: revocations.join(', ') })}`
              : '';
            this.step = 'success';
            this.message = `${this.$t('wot.retractSuccess')}${revMsg}`;
          }
        } catch {
          if (!this._mounted) return;
          this.step = 'success';
          this.message = this.$t('wot.retractBroadcastPending');
        }
        this.showRetract = false;
        this.retractReason = '';
        await this.loadVouchStatus();
      } catch (err) {
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[vouch retract]', err);
        this.message = this.$t('wot.retractFailed');
      }
    },
  }));
}
