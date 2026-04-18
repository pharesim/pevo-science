import Alpine from 'alpinejs';
import { isKeychainInstalled } from '../keychain.js';
import { fetchEmailStatus, submitEmail, deleteEmail } from '../api.js';
import { deriveHiveKeys, deriveHivePublicKeys } from '../hive-keys.js';

// Number of words to re-enter for confirmation
const CONFIRM_WORD_COUNT = 3;

const template = `
      <div x-data="settingsPage" class="container-narrow py-8">
        <!-- Not signed in -->
        <template x-if="!isConnected">
          <div class="text-center py-16">
            <p class="text-ink-muted mb-4" x-text="$t('settings.signInRequired')"></p>
            <button @click="navigate('/login')" class="btn-primary" x-text="$t('settings.signIn')"></button>
          </div>
        </template>

        <template x-if="isConnected">
          <div class="max-w-lg mx-auto">
            <h1 class="text-3xl font-bold text-ink mb-8" x-text="$t('settings.title')"></h1>

            <!-- Upgrade section (only for light accounts) -->
            <template x-if="isLight">
              <div class="border border-parchment-dark rounded-xl p-6">
                <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('upgrade.title')"></h2>
                <p class="text-sm text-ink-muted mb-6" x-text="$t('upgrade.description')"></p>

                <!-- Idle: start button -->
                <div x-show="upgradePhase === 'idle'">
                  <button @click="startUpgrade()" class="btn-primary" x-text="$t('upgrade.start')"></button>
                </div>

                <!-- Error -->
                <div x-show="upgradePhase === 'error'">
                  <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                    <p class="text-red-700 text-sm" x-text="upgradeError"></p>
                  </div>
                  <button @click="resetUpgrade()" class="text-pevo-teal hover:underline text-sm" x-text="$t('common.tryAgain')"></button>
                </div>

                <!-- Step 1: New seed phrase display -->
                <div x-show="upgradePhase === 'new-seed'">
                  <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                    <p class="text-amber-800 text-sm font-medium" x-text="$t('upgrade.newSeedWarning')"></p>
                  </div>
                  <div class="grid grid-cols-3 gap-3 mb-6">
                    <template x-for="(word, i) in newSeedWords" :key="i">
                      <div class="bg-white border border-parchment-dark rounded-lg px-3 py-2 text-center">
                        <span class="text-xs text-ink-muted" x-text="(i + 1) + '.'"></span>
                        <span class="ml-1 font-mono text-sm text-ink font-medium" x-text="word"></span>
                      </div>
                    </template>
                  </div>
                  <button @click="proceedToConfirmNew()" class="w-full btn-primary py-2.5" x-text="$t('upgrade.iWroteItDown')"></button>
                </div>

                <!-- Step 2: Confirm new seed phrase -->
                <div x-show="upgradePhase === 'confirm-new'">
                  <p class="text-ink-muted text-sm mb-4" x-text="$t('upgrade.confirmNewDescription')"></p>
                  <div class="space-y-4 mb-6">
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
                  <button @click="proceedToOldSeed()" :disabled="!confirmCorrect"
                          class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                          x-text="$t('upgrade.next')"></button>
                </div>

                <!-- Step 3: Enter old seed phrase + password -->
                <div x-show="upgradePhase === 'enter-old'">
                  <div class="space-y-4 mb-6">
                    <div>
                      <label class="block text-sm font-medium text-ink mb-1" x-text="$t('upgrade.oldSeedLabel')"></label>
                      <textarea x-model="oldSeedPhrase" rows="3"
                                class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                                :placeholder="$t('upgrade.oldSeedPlaceholder')"
                                autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-ink mb-1" x-text="$t('upgrade.passwordLabel')"></label>
                      <input type="password" x-model="upgradePassword"
                             class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    </div>
                  </div>
                  <button @click="executeUpgrade()" :disabled="!oldSeedPhrase.trim() || !upgradePassword"
                          class="w-full btn-primary py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                          x-text="$t('upgrade.execute')"></button>
                </div>

                <!-- Upgrading spinner -->
                <div x-show="upgradePhase === 'upgrading'" class="text-center py-8">
                  <div class="animate-pulse">
                    <div class="w-12 h-12 bg-parchment-dark rounded-full mx-auto mb-4"></div>
                    <p class="text-ink-muted" x-text="$t('upgrade.upgrading')"></p>
                  </div>
                </div>

                <!-- Done -->
                <div x-show="upgradePhase === 'done'" class="text-center py-4">
                  <div class="w-12 h-12 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg class="w-6 h-6 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                  </div>
                  <p class="text-ink font-medium mb-2" x-text="$t('upgrade.doneTitle')"></p>
                  <p class="text-sm text-ink-muted" x-text="$t('upgrade.doneDescription')"></p>
                </div>
              </div>
            </template>

            <!-- Already self-custody -->
            <template x-if="!isLight">
              <div class="border border-parchment-dark rounded-xl p-6">
                <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('settings.accountType')"></h2>
                <p class="text-sm text-ink-muted" x-text="$t('settings.selfCustody')"></p>
              </div>
            </template>

            <!-- Email section -->
            <div class="border border-parchment-dark rounded-xl p-6 mt-6">
              <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('settings.emailTitle')"></h2>

              <!-- Loading -->
              <div x-show="emailLoading" class="py-4">
                <div class="animate-pulse h-4 bg-parchment-dark rounded w-48"></div>
              </div>

              <template x-if="!emailLoading && emailStatus">
                <div>
                  <!-- State 1: No email -->
                  <template x-if="!emailStatus.hasEmail">
                    <div>
                      <p class="text-sm text-ink-muted mb-4" x-text="$t('settings.emailAddDescription')"></p>
                      <form @submit.prevent="handleEmailSubmit()" class="flex gap-3">
                        <input type="email" x-model="newEmail" required
                               class="flex-1 border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                               :placeholder="$t('settings.emailPlaceholder')">
                        <button type="submit" class="btn-primary whitespace-nowrap" :disabled="emailSubmitting || !newEmail.trim()"
                                x-text="$t('settings.emailAdd')"></button>
                      </form>
                      <p x-show="emailMessage" class="text-sm text-pevo-green mt-2" x-text="emailMessage"></p>
                      <p x-show="emailError" class="text-sm text-red-600 mt-2" x-text="emailError"></p>
                    </div>
                  </template>

                  <!-- State 2: Has email, verified -->
                  <template x-if="emailStatus.hasEmail && emailStatus.verified">
                    <div>
                      <div class="flex items-center gap-2 mb-4">
                        <span class="text-sm text-ink" x-text="$t('settings.emailMasked', { email: emailStatus.email })"></span>
                        <span class="text-xs font-medium text-pevo-green" x-text="$t('settings.emailVerified')"></span>
                      </div>

                      <!-- Change form (hidden by default) -->
                      <div x-show="showChangeForm" class="mb-4">
                        <p class="text-sm text-ink-muted mb-2" x-text="$t('settings.emailChangeDescription')"></p>
                        <form @submit.prevent="handleEmailSubmit()" class="flex gap-3">
                          <input type="email" x-model="newEmail" required
                                 class="flex-1 border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                                 :placeholder="$t('settings.emailPlaceholder')">
                          <button type="submit" class="btn-primary whitespace-nowrap" :disabled="emailSubmitting || !newEmail.trim()"
                                  x-text="$t('settings.emailSendVerification')"></button>
                        </form>
                        <p x-show="emailMessage" class="text-sm text-pevo-green mt-2" x-text="emailMessage"></p>
                        <p x-show="emailError" class="text-sm text-red-600 mt-2" x-text="emailError"></p>
                      </div>

                      <div class="flex gap-4">
                        <button x-show="!showChangeForm" @click="showChangeForm = true; newEmail = ''; emailMessage = null; emailError = null"
                                class="text-sm text-pevo-teal hover:underline" x-text="$t('settings.emailChange')"></button>
                        <button @click="showDeleteConfirm = !showDeleteConfirm"
                                class="text-sm text-red-600 hover:underline" x-text="$t('settings.emailDelete')"></button>
                      </div>

                      <!-- Delete confirmation -->
                      <div x-show="showDeleteConfirm" class="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
                        <p class="text-sm text-red-700 mb-3"
                           x-text="custody === 'light' ? $t('settings.deleteWarningLight') : $t('settings.deleteWarningSelf')"></p>
                        <div class="flex gap-3">
                          <button @click="handleEmailDelete()" :disabled="deleting"
                                  class="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50"
                                  x-text="$t('settings.emailDeleteConfirm')"></button>
                          <button @click="showDeleteConfirm = false"
                                  class="text-sm text-ink-muted hover:underline" x-text="$t('common.cancel')"></button>
                        </div>
                      </div>
                    </div>
                  </template>

                  <!-- State 3: Has email, not verified -->
                  <template x-if="emailStatus.hasEmail && !emailStatus.verified">
                    <div>
                      <div class="flex items-center gap-2 mb-4">
                        <span class="text-sm text-ink" x-text="$t('settings.emailMasked', { email: emailStatus.email })"></span>
                        <span class="text-xs font-medium text-amber-600" x-text="$t('settings.emailPending')"></span>
                      </div>

                      <!-- Resend form (hidden by default) -->
                      <div x-show="showChangeForm" class="mb-4">
                        <p class="text-sm text-ink-muted mb-2" x-text="$t('settings.emailChangeDescription')"></p>
                        <form @submit.prevent="handleEmailSubmit()" class="flex gap-3">
                          <input type="email" x-model="newEmail" required
                                 class="flex-1 border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                                 :placeholder="$t('settings.emailPlaceholder')">
                          <button type="submit" class="btn-primary whitespace-nowrap" :disabled="emailSubmitting || !newEmail.trim()"
                                  x-text="$t('settings.emailSendVerification')"></button>
                        </form>
                      </div>

                      <div class="flex gap-4">
                        <button x-show="!showChangeForm" @click="handleEmailResend()"
                                class="text-sm text-pevo-teal hover:underline" x-text="$t('settings.emailResend')"></button>
                        <button @click="showDeleteConfirm = !showDeleteConfirm"
                                class="text-sm text-red-600 hover:underline" x-text="$t('settings.emailDelete')"></button>
                      </div>

                      <p x-show="emailMessage" class="text-sm text-pevo-green mt-2" x-text="emailMessage"></p>
                      <p x-show="emailError" class="text-sm text-red-600 mt-2" x-text="emailError"></p>

                      <!-- Delete confirmation -->
                      <div x-show="showDeleteConfirm" class="mt-4 bg-red-50 border border-red-200 rounded-lg p-4">
                        <p class="text-sm text-red-700 mb-3"
                           x-text="custody === 'light' ? $t('settings.deleteWarningLight') : $t('settings.deleteWarningSelf')"></p>
                        <div class="flex gap-3">
                          <button @click="handleEmailDelete()" :disabled="deleting"
                                  class="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50"
                                  x-text="$t('settings.emailDeleteConfirm')"></button>
                          <button @click="showDeleteConfirm = false"
                                  class="text-sm text-ink-muted hover:underline" x-text="$t('common.cancel')"></button>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
`;

export { template as settingsPageTemplate };

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

    // Email management state
    emailStatus: null,
    emailLoading: true,
    newEmail: '',
    emailSubmitting: false,
    emailMessage: null,
    emailError: null,
    showDeleteConfirm: false,
    showChangeForm: false,
    deleting: false,

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

    init() {
      if (this.isConnected) {
        this.loadEmailStatus();
      }
      this.$watch('isConnected', (connected) => {
        if (connected) this.loadEmailStatus();
      });
    },

    async loadEmailStatus() {
      this.emailLoading = true;
      try {
        const res = await fetchEmailStatus();
        this.emailStatus = res.data;
      } catch {
        this.emailStatus = { hasEmail: false, custody: 'self' };
      } finally {
        this.emailLoading = false;
      }
    },

    async handleEmailSubmit() {
      if (!this.newEmail.trim() || this.emailSubmitting) return;
      this.emailSubmitting = true;
      this.emailMessage = null;
      this.emailError = null;
      try {
        await submitEmail(this.newEmail.trim());
        this.emailMessage = this.$t('settings.emailVerificationSent');
        this.newEmail = '';
        this.showChangeForm = false;
        await this.loadEmailStatus();
      } catch (err) {
        if (err.code === 'DUPLICATE') {
          this.emailError = this.$t('settings.emailAlreadyInUse');
        } else {
          this.emailError = err.message || this.$t('common.connectionFailed');
        }
      } finally {
        this.emailSubmitting = false;
      }
    },

    handleEmailResend() {
      this.emailMessage = null;
      this.emailError = null;
      this.newEmail = '';
      this.showChangeForm = true;
    },

    async handleEmailDelete() {
      if (this.deleting) return;
      this.deleting = true;
      try {
        await deleteEmail(true);
        this.emailStatus = { hasEmail: false, custody: this.custody };
        this.showDeleteConfirm = false;
        this.showChangeForm = false;
        this.emailMessage = null;
        this.emailError = null;
        Alpine.store('toast').show(this.$t('settings.emailDeleted'), 'success');
      } catch (err) {
        this.emailError = err.message || this.$t('common.connectionFailed');
      } finally {
        this.deleting = false;
      }
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
        const dhive = await import('@hiveio/dhive');
        const oldSeed = mnemonicToSeedSync(oldWords);
        const oldKeys = deriveHiveKeys(oldSeed, this.username);
        const newSeed = mnemonicToSeedSync(this.newSeedPhrase);
        const newKeys = deriveHiveKeys(newSeed, this.username);
        const newPubKeys = await deriveHivePublicKeys(newKeys);

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
          await new Promise((resolve, reject) => {
            window.hive_keychain.requestAddAccountAuthority(
              this.username, newKeys.posting, 'posting',
              (res) => res.success ? resolve(res) : reject(new Error(res.message))
            );
          });
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
      throw new Error(this.$t('common.bip39NotLoaded'));
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
