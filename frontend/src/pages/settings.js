import Alpine from 'alpinejs';
import { isKeychainInstalled } from '../keychain.js';

// Number of words to re-enter for confirmation
const CONFIRM_WORD_COUNT = 3;

function pickRandomIndices(total, count) {
  const indices = [];
  while (indices.length < count) {
    const i = Math.floor(Math.random() * total);
    if (!indices.includes(i)) indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

export function initSettingsPage() {
  Alpine.data('settingsPage', () => ({
    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },
    get custody() { return Alpine.store('auth').custody; },
    get isLight() { return this.custody === 'light'; },

    // Upgrade flow state
    // Phases: 'idle' | 'new-seed' | 'confirm-new' | 'enter-old' | 'upgrading' | 'done' | 'error'
    upgradePhase: 'idle',
    upgradeError: null,

    // New seed phrase
    newSeedPhrase: null,
    newSeedWords: [],
    confirmIndices: [],
    confirmInputs: {},

    // Old seed phrase entry
    oldSeedPhrase: '',

    // Password re-entry
    upgradePassword: '',

    get confirmCorrect() {
      return this.confirmIndices.every(
        (i) => this.confirmInputs[i]?.trim().toLowerCase() === this.newSeedWords[i]
      );
    },

    startUpgrade() {
      if (!isKeychainInstalled()) {
        this.upgradeError = this.$t('upgrade.keychainRequired');
        this.upgradePhase = 'error';
        return;
      }

      // Generate new 12-word BIP39 seed phrase client-side
      // Requires @scure/bip39 to be available
      try {
        const { generateMnemonic, wordlist } = this._getBip39();
        this.newSeedPhrase = generateMnemonic(wordlist);
        this.newSeedWords = this.newSeedPhrase.split(' ');
        this.upgradePhase = 'new-seed';
        this.upgradeError = null;
      } catch (err) {
        this.upgradeError = err.message || this.$t('upgrade.generationFailed');
        this.upgradePhase = 'error';
      }
    },

    proceedToConfirmNew() {
      this.confirmIndices = pickRandomIndices(this.newSeedWords.length, CONFIRM_WORD_COUNT);
      this.confirmInputs = {};
      this.confirmIndices.forEach((i) => { this.confirmInputs[i] = ''; });
      this.upgradePhase = 'confirm-new';
    },

    proceedToOldSeed() {
      if (!this.confirmCorrect) return;
      this.oldSeedPhrase = '';
      this.upgradePassword = '';
      this.upgradePhase = 'enter-old';
    },

    async executeUpgrade() {
      if (!this.oldSeedPhrase.trim() || !this.upgradePassword) return;
      this.upgradePhase = 'upgrading';
      this.upgradeError = null;

      try {
        // Dynamic imports — these packages must be installed before upgrade is used
        // npm install @scure/bip39 @hiveio/dhive
        const bip39 = this._getBip39();
        const { mnemonicToSeedSync, validateMnemonic, wordlist } = bip39;

        // Validate old seed phrase
        const oldWords = this.oldSeedPhrase.trim().toLowerCase();
        if (!validateMnemonic(oldWords, wordlist)) {
          throw new Error(this.$t('upgrade.invalidOldSeed'));
        }

        // Derive keys from old and new seed phrases
        const hiveKeys = await import('../hive-keys.js');
        const dhive = await import('@hiveio/dhive');
        const oldSeed = mnemonicToSeedSync(oldWords);
        const oldKeys = hiveKeys.deriveHiveKeys(oldSeed, this.username);
        const newSeed = mnemonicToSeedSync(this.newSeedPhrase);
        const newKeys = hiveKeys.deriveHiveKeys(newSeed, this.username);
        const newPubKeys = await hiveKeys.deriveHivePublicKeys(newKeys);

        // Broadcast account_update signed with old owner key
        const client = new dhive.Client(['https://api.hive.blog']);

        const ownerKey = dhive.PrivateKey.fromSeed(oldKeys.owner);
        const op = {
          account: this.username,
          owner: { weight_threshold: 1, account_auths: [], key_auths: [[newPubKeys.owner, 1]] },
          active: { weight_threshold: 1, account_auths: [], key_auths: [[newPubKeys.active, 1]] },
          posting: { weight_threshold: 1, account_auths: [], key_auths: [[newPubKeys.posting, 1]] },
          memo_key: newPubKeys.memo,
          json_metadata: '',
        };

        await client.broadcast.sendOperations([['account_update', op]], ownerKey);

        // Import new posting key into Keychain
        if (isKeychainInstalled()) {
          try {
            await new Promise((resolve, reject) => {
              window.hive_keychain.requestAddAccountAuthority(
                this.username, newKeys.posting, 'posting',
                (res) => res.success ? resolve(res) : reject(new Error(res.message))
              );
            });
          } catch {
            // User may need to import manually — not a failure
          }
        }

        // Notify backend to clean up stored keys
        const auth = Alpine.store('auth');
        const res = await fetch('/api/custody/upgrade', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ password: this.upgradePassword }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || this.$t('upgrade.backendFailed'));
        }

        const result = await res.json();

        // Update session
        auth.custody = 'self';
        if (result.data?.token) {
          auth.token = result.data.token;
        }
        auth._saveSession(
          auth.token, auth.username, null, auth.isAccredited, auth.accreditation, 'self'
        );

        this.upgradePhase = 'done';
      } catch (err) {
        this.upgradeError = err.message;
        this.upgradePhase = 'error';
      }
    },

    resetUpgrade() {
      this.upgradePhase = 'idle';
      this.upgradeError = null;
      this.newSeedPhrase = null;
      this.newSeedWords = [];
      this.oldSeedPhrase = '';
      this.upgradePassword = '';
    },

    _getBip39() {
      // @scure/bip39 must be bundled
      // eslint-disable-next-line no-undef
      if (typeof scureBip39 !== 'undefined') return scureBip39;
      // Try dynamic import as fallback
      throw new Error('BIP39 library not loaded');
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
