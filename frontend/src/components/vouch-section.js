import Alpine from 'alpinejs';
import { fetchVouchStatus, notifyVouch, notifyRetractVouch } from '../api.js';
import { broadcastOps } from '../signer.js';
import { getAppTag } from '../config.js';

export function initVouchSection() {
  Alpine.data('vouchSection', (opts = {}) => ({
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
        this.vouchStatus = res.data;
      } catch {
        this.vouchStatus = null;
      } finally {
        this.loading = false;
      }
    },

    async handleVouch() {
      if (!this.username) return;
      this.step = 'signing';
      this.message = '';
      try {
        const APP_TAG = getAppTag();
        await broadcastOps(this.username, [['custom_json', {
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
        try {
          const res = await notifyVouch(this.targetUsername);
          const accMsg = res.data.accredited
            ? ` ${this.$t('wot.accreditedViaWot', { username: this.targetUsername })}`
            : '';
          this.step = 'success';
          this.message = `${this.$t('wot.vouchSuccess')}${accMsg}`;
        } catch {
          this.step = 'success';
          this.message = this.$t('wot.vouchBroadcastPending');
        }
        await this.loadVouchStatus();
      } catch (err) {
        this.step = 'error';
        this.message = err.message || this.$t('wot.vouchFailed');
      }
    },

    async handleRetract() {
      if (!this.username) return;
      this.step = 'signing';
      this.message = '';
      try {
        const APP_TAG2 = getAppTag();
        await broadcastOps(this.username, [['custom_json', {
          required_auths: [],
          required_posting_auths: [this.username],
          id: APP_TAG2,
          json: JSON.stringify({
            action: 'retract_vouch',
            voucher: this.username,
            vouchee: this.targetUsername,
            reason: this.retractReason || 'Retracted',
            timestamp: new Date().toISOString(),
          }),
        }]]);
        try {
          const res = await notifyRetractVouch(this.targetUsername);
          const revocations = res.data.revocations;
          const revMsg = revocations.length > 0
            ? ` ${this.$t('wot.accreditationRevoked', { accounts: revocations.join(', ') })}`
            : '';
          this.step = 'success';
          this.message = `${this.$t('wot.retractSuccess')}${revMsg}`;
        } catch {
          this.step = 'success';
          this.message = this.$t('wot.retractBroadcastPending');
        }
        this.showRetract = false;
        this.retractReason = '';
        await this.loadVouchStatus();
      } catch (err) {
        this.step = 'error';
        this.message = err.message || this.$t('wot.retractFailed');
      }
    },
  }));
}
