import Alpine from 'alpinejs';
import { isKeychainInstalled } from '../keychain.js';
import { fetchEmailStatus, submitEmail, deleteEmail, startOrcid, setPassword } from '../api.js';
import { deriveHiveKeys, deriveHivePublicKeys, generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '../hive-keys.js';
import { isPasswordValid } from '../password-policy.js';

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
                <div x-show="upgradePhase === 'done'" class="py-4">
                  <div class="text-center">
                    <div class="w-12 h-12 bg-pevo-green/10 rounded-full flex items-center justify-center mx-auto mb-4">
                      <svg class="w-6 h-6 text-pevo-green" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                    </div>
                    <p class="text-ink font-medium mb-2" x-text="$t('upgrade.doneTitle')"></p>
                    <p class="text-sm text-ink-muted" x-text="$t('upgrade.doneDescription')"></p>
                  </div>
                  <!-- Best-effort Keychain-import warnings. Empty on a fully-
                       successful upgrade; one yellow notice per role whose
                       requestImportKey popup was denied or failed. -->
                  <template x-if="upgradeWarnings && upgradeWarnings.length > 0">
                    <ul class="mt-6 space-y-2">
                      <template x-for="(warning, i) in upgradeWarnings" :key="i">
                        <li class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800" x-text="warning"></li>
                      </template>
                    </ul>
                  </template>
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

            <!-- ORCID section (accredited users only) -->
            <template x-if="isAccredited">
              <div class="border border-parchment-dark rounded-xl p-6 mt-6">
                <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('settings.orcidTitle')"></h2>

                <!-- Has verified ORCID -->
                <template x-if="currentOrcid">
                  <div>
                    <div class="flex items-center gap-2 mb-4">
                      <a :href="'https://orcid.org/' + currentOrcid" target="_blank" rel="noopener noreferrer"
                         class="inline-flex items-center gap-1.5 text-sm text-ink hover:text-pevo-teal no-underline">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" class="h-4 w-4 shrink-0">
                          <circle cx="128" cy="128" r="128" fill="#A6CE39"/>
                          <path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 56.8c-5.7 0-10.3 4.6-10.3 10.3s4.6 10.3 10.3 10.3 10.3-4.6 10.3-10.3-4.6-10.3-10.3-10.3zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4z"/>
                        </svg>
                        <span x-text="currentOrcid"></span>
                      </a>
                      <span class="text-xs font-medium text-pevo-green" x-text="$t('settings.orcidVerified')"></span>
                    </div>
                    <button @click="handleOrcidLink()" :disabled="orcidLinking"
                            class="text-sm text-pevo-teal hover:underline" x-text="orcidLinking ? $t('settings.orcidRedirecting') : $t('settings.orcidUpdate')"></button>
                  </div>
                </template>

                <!-- No ORCID linked -->
                <template x-if="!currentOrcid">
                  <div>
                    <p class="text-sm text-ink-muted mb-4" x-text="$t('settings.orcidLinkDescription')"></p>
                    <button @click="handleOrcidLink()" :disabled="orcidLinking"
                            class="btn-primary" x-text="orcidLinking ? $t('settings.orcidRedirecting') : $t('settings.orcidLink')"></button>
                  </div>
                </template>

                <p x-show="orcidError" class="text-sm text-red-600 mt-2" x-text="orcidError"></p>
              </div>
            </template>

            <!-- Set a password section: only shown for accounts with no
                 password. ORCID-verified signups/recoveries leave the
                 password empty; this lets the user opt into password
                 login later. On success we flip emailStatus.hasPassword
                 true, which collapses this outer x-if and hides the
                 section entirely. The success surface is the toast
                 fired from handleSetPassword, not an inline confirmation. -->
            <template x-if="!emailLoading && emailStatus && emailStatus.hasPassword === false">
              <div data-testid="set-password-section" class="border border-parchment-dark rounded-xl p-6 mt-6">
                <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('settings.setPasswordTitle')"></h2>
                <p class="text-sm text-ink-muted mb-4" x-text="$t('settings.setPasswordDescription')"></p>

                <form @submit.prevent="handleSetPassword()" class="space-y-3">
                  <div>
                    <label class="block text-sm font-medium text-ink mb-1" x-text="$t('settings.setPasswordLabel')"></label>
                    <input type="password" data-testid="set-password-input" x-model="newPasswordInput" required minlength="10"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    <p class="text-xs text-ink-muted mt-1" x-text="$t('settings.setPasswordHint')"></p>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-ink mb-1" x-text="$t('settings.setPasswordConfirmLabel')"></label>
                    <input type="password" data-testid="set-password-confirm-input" x-model="newPasswordConfirmInput" required
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           :class="newPasswordConfirmInput && !newPasswordsMatch ? 'border-pevo-crimson' : ''">
                    <p x-show="newPasswordConfirmInput && !newPasswordsMatch" class="text-xs text-pevo-crimson mt-1" x-text="$t('settings.setPasswordMismatch')"></p>
                  </div>
                  <button type="submit" data-testid="set-password-submit" :disabled="!canSubmitPassword || passwordSubmitting"
                          class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                          x-text="passwordSubmitting ? $t('settings.setPasswordSaving') : $t('settings.setPasswordSubmit')"></button>
                  <p x-show="passwordError" class="text-sm text-red-600" x-text="passwordError"></p>
                </form>
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
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get currentOrcid() { return Alpine.store('auth').accreditation?.orcid || null; },

    // ORCID link state
    orcidLinking: false,
    orcidError: null,

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

    // Set-password state: for ORCID-verified accounts that have no
    // password_hash set, lets the user opt into password login. On
    // success we patch emailStatus.hasPassword true, which collapses the
    // outer x-if and hides the section. No separate "done" flag.
    newPasswordInput: '',
    newPasswordConfirmInput: '',
    passwordSubmitting: false,
    passwordError: null,

    // Upgrade flow state
    // Phases: 'idle' | 'new-seed' | 'confirm-new' | 'enter-old' | 'upgrading' | 'done' | 'error'
    upgradePhase: 'idle',
    upgradeError: null,

    // Best-effort Keychain-import warnings surfaced on the success screen.
    // Populated when one or more `requestImportKey` popups are denied or
    // fail after the irreversible (broadcast + backend cleanup) pair has
    // landed. Empty on a fully-successful upgrade. Reset on resetUpgrade()
    // and on entry to executeUpgrade().
    upgradeWarnings: [],

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

    // Set-password validity mirrors signup/recover password policy
    // (shared helper in frontend/src/password-policy.js).
    get newPasswordValid() {
      return isPasswordValid(this.newPasswordInput);
    },

    get newPasswordsMatch() {
      return this.newPasswordInput === this.newPasswordConfirmInput;
    },

    get canSubmitPassword() {
      return this.newPasswordValid && this.newPasswordsMatch;
    },

    init() {
      if (this.isConnected) {
        this.loadEmailStatus();
      }
      this.$watch('isConnected', (connected) => {
        if (connected) this.loadEmailStatus();
      });

      // Check if returning from ORCID link callback
      const orcidLinked = localStorage.getItem('pevo_orcid_link_complete');
      if (orcidLinked) {
        localStorage.removeItem('pevo_orcid_link_complete');
        // Refresh accreditation data to pick up the new ORCID
        Alpine.store('auth')._checkAccreditation();
        Alpine.store('toast').show(this.$t('settings.orcidLinkSuccess'), 'success');
      }
    },

    async handleOrcidLink() {
      if (this.orcidLinking) return;
      this.orcidLinking = true;
      this.orcidError = null;

      localStorage.setItem('pevo_orcid_mode', 'link');

      try {
        const data = await startOrcid('link');
        const target = new URL(data.redirect_url);
        if (!['orcid.org', 'sandbox.orcid.org'].includes(target.hostname)) {
          throw new Error('Invalid ORCID redirect URL');
        }
        window.location.href = data.redirect_url;
      } catch (err) {
        // Sanitization pattern (shared with executeUpgrade()): the
        // DOM-bound error takes a generic localized message rather than
        // `err.message`, which is x-text'd directly. The raw error still
        // reaches console.warn for developer diagnostics. Prevents
        // accidental disclosure if a future error shape embeds sensitive
        // material.
        console.warn('[orcid link]', err);
        this.orcidError = this.$t('settings.orcidLinkFailed');
        this.orcidLinking = false;
        localStorage.removeItem('pevo_orcid_mode');
      }
    },

    async loadEmailStatus() {
      this.emailLoading = true;
      try {
        const res = await fetchEmailStatus();
        this.emailStatus = res.data;
      } catch {
        this.emailStatus = { hasEmail: false, custody: 'self', hasPassword: false };
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
        // DUPLICATE is a semantic code, safe to branch on and surface the
        // matching localized message without warning. All other failures
        // take the generic-message + console.warn sanitization path shared
        // with executeUpgrade().
        if (err.code === 'DUPLICATE') {
          this.emailError = this.$t('settings.emailAlreadyInUse');
        } else {
          console.warn('[email submit]', err);
          this.emailError = this.$t('settings.emailUpdateFailed');
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

    async handleSetPassword() {
      if (!this.canSubmitPassword || this.passwordSubmitting) return;
      this.passwordSubmitting = true;
      this.passwordError = null;
      try {
        await setPassword(this.newPasswordInput);
        // Patch emailStatus FIRST. The outer `x-if` on
        // `emailStatus.hasPassword === false` is the single success signal;
        // flipping it hides the section in the next render tick. Mutating
        // emailStatus before clearing inputs and firing the toast keeps the
        // "form stuck on success while still visible" state unreachable
        // even if a later line throws (spread on a frozen proxy, a future
        // toast-store API change, etc.).
        if (this.emailStatus) this.emailStatus = { ...this.emailStatus, hasPassword: true };
        this.newPasswordInput = '';
        this.newPasswordConfirmInput = '';
        Alpine.store('toast').show(this.$t('settings.setPasswordSuccess'), 'success');
      } catch (err) {
        // Zero plaintext password on error path so it doesn't linger in
        // Alpine reactive state (XSS-read surface) while the error is shown.
        this.newPasswordInput = '';
        this.newPasswordConfirmInput = '';
        // Sanitization pattern (see handleOrcidLink).
        console.warn('[set password]', err);
        this.passwordError = this.$t('settings.passwordUpdateFailed');
      } finally {
        this.passwordSubmitting = false;
      }
    },

    async handleEmailDelete() {
      if (this.deleting) return;
      this.deleting = true;
      try {
        await deleteEmail(true);
        this.emailStatus = {
          hasEmail: false,
          custody: this.custody,
          hasPassword: this.emailStatus?.hasPassword ?? false,
        };
        this.showDeleteConfirm = false;
        this.showChangeForm = false;
        this.emailMessage = null;
        this.emailError = null;
        Alpine.store('toast').show(this.$t('settings.emailDeleted'), 'success');
      } catch (err) {
        // Sanitization pattern (see handleOrcidLink).
        console.warn('[email delete]', err);
        this.emailError = this.$t('settings.emailDeleteFailed');
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
      try {
        this.newSeedPhrase = generateMnemonic();
        this.newSeedWords = this.newSeedPhrase.split(' ');
        this.upgradePhase = 'new-seed';
        this.upgradeError = null;
      } catch (err) {
        // Sanitization pattern (see executeUpgrade() below). The
        // generateMnemonic() path pulls BIP39 entropy; a thrown error
        // could plausibly embed partial entropy or seed material on a
        // future library revision. Generic message to DOM, raw to
        // console.warn for diagnostics.
        console.warn('[custody upgrade start]', err);
        this.upgradeError = this.$t('upgrade.generationFailed');
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
      // Reset best-effort warnings on each attempt so a previous partial
      // run doesn't leak its messages into a subsequent success screen.
      this.upgradeWarnings = [];

      // Snapshot the new seed phrase locally so the keychain-import helper
      // (and the broadcast helper) receive it as a primitive-string argument
      // rather than reading `this.newSeedPhrase` directly. This keeps each
      // helper's frame the only owner of the derived material it produces
      // (closure-wipe invariant — see _performUpgradeKeyRotation and
      // _performKeychainImport). The wipe runs AFTER the keychain import in
      // the finally block (see ORDERING block below); the snapshot is for
      // closure-wipe hygiene, not for surviving a wipe-before-import.
      const newSeedPhrase = this.newSeedPhrase;

      // ORDERING — round-2 hold (P1 partial-import lockout) reshape:
      //   (a) validate
      //   (b) _performUpgradeKeyRotation     — IRREVERSIBLE: account_update broadcast
      //   (c) /api/custody/upgrade            — IRREVERSIBLE: backend cleanup
      //   (d) Keychain import loop           — best-effort; failures become warnings
      //   (e) _clearSensitiveUpgradeState    — wipe reactive sensitive fields
      //   (f) upgradePhase = 'done'
      //
      // The (b)→(c) pair is the only remaining irreversible-pair gap. If
      // (c) fails, the user sees an error (real failure). If (d) fails on
      // any role, the user sees the success screen WITH per-role warnings
      // — the upgrade succeeded on-chain and the backend cleared stored
      // keys; only Keychain's local convenience-import is incomplete and
      // the user can retry from settings later. Mid-loop denials must NOT
      // wipe the mnemonic, must NOT mark the upgrade as failed, and must
      // NOT skip backend cleanup — backend cleanup happens BEFORE the loop.
      try {
        // Validate old seed phrase
        const oldWords = this.oldSeedPhrase.trim().toLowerCase();
        if (!validateMnemonic(oldWords)) {
          throw new Error(this.$t('upgrade.invalidOldSeed'));
        }

        // FE-UPGRADE-CLOSURE-WIPE — derive keys + broadcast `account_update`
        // inside a narrower-scoped helper so the closure frame that captured
        // the derived private-key material (oldSeed, oldKeys, newSeed,
        // newKeys, newPubKeys, ownerKey) is popped off the call stack
        // BEFORE `_clearSensitiveUpgradeState()` runs below. Reachability
        // invariant: no variable bound inside `_performUpgradeKeyRotation()`
        // escapes to `executeUpgrade()` other than control flow.
        await this._performUpgradeKeyRotation(oldWords, newSeedPhrase);

        // Notify backend to clean up stored keys. Failure here surfaces as
        // upgradeError — this is the only remaining irreversible-pair gap
        // (broadcast already landed; if cleanup fails the backend retains
        // stale encrypted keys for now-superseded authorities). We keep it
        // as a real error so the user can contact support to resolve.
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

        // Update session. The upgrade response rotates the session token
        // (the old light-custody JWT is invalidated server-side); if the
        // backend emits a new token + expires_at pair, refresh both on the
        // store BEFORE _saveSession() so the persisted expires_at matches
        // the new token.
        auth.custody = 'self';
        if (result.data?.token) {
          auth.token = result.data.token;
        }
        if (result.data?.expires_at) {
          auth.expiresAt = result.data.expires_at;
        }
        auth._saveSession();
      } catch (err) {
        // The (b)→(c) pair lives inside this try. A failure here means
        // either (b) reverted (Keychain-signing of account_update denied,
        // chain rejection) or (c) failed (backend refused). Both are real
        // failures from the user's perspective.
        //
        // Defense in depth: zero sensitive state on error. The 'error'
        // phase routes the user to `resetUpgrade()` via the "try again"
        // button which would clear these anyway, but a refresh or
        // navigation away leaves them lingering otherwise.
        this._clearSensitiveUpgradeState();
        // Surface a generic localized message rather than `err.message`.
        // Raw `err.message` is x-text'd directly into the DOM; if a library
        // swap, future dhive error shape, or bug ever embeds key-material
        // (seed words, hex private-key seeds) into the error message, the
        // wiped Alpine state would be effectively un-wiped via a DOM-visible
        // error string. The real error is still surfaced to the debugger via
        // console.warn for developer diagnostics.
        console.warn('[custody upgrade]', err);
        this.upgradeError = this.$t('upgrade.failed');
        this.upgradePhase = 'error';
        return;
      }

      // Best-effort Keychain import. By this point:
      //   - account_update has landed on-chain (b)
      //   - backend custody cleanup succeeded (c)
      // Per-role failures inside the loop push a localized warning string;
      // the loop never re-throws, never wipes the mnemonic, never marks
      // upgrade failed. But the helper has unguarded pre-loop work
      // (dynamic dhive import, mnemonicToSeedSync, deriveHiveKeys,
      // PrivateKey.fromSeed) that could throw before the loop's per-role
      // try/catch even runs (e.g., flaky dynamic-chunk fetch). The
      // try/catch/finally below ensures wipe + upgradePhase = 'done' run
      // unconditionally — without it, a thrown helper would leave the
      // mnemonic in Alpine reactive state (XSS-readable on /settings) and
      // upgradePhase stuck at 'upgrading' (no recovery UI). Failures
      // surface as a single fallback warning on the 'done' screen.
      try {
        await this._performKeychainImport(newSeedPhrase);
      } catch (err) {
        console.warn('[custody upgrade] keychain helper threw', err);
        this.upgradeWarnings.push(this.$t('upgrade.keychainImportFailed'));
      } finally {
        // FE-UPGRADE-CREDENTIAL-WIPE: zero all sensitive reactive state on
        // the happy path (success or partial-keychain-import) before
        // flipping to 'done'. Without this, the old and new 12-word
        // mnemonics plus the re-entered password sit in Alpine's reactive
        // data indefinitely; any XSS on /settings can read them via
        // `window.Alpine.$data(el).oldSeedPhrase` etc.
        this._clearSensitiveUpgradeState();
        this.upgradePhase = 'done';
      }
    },

    // FE-UPGRADE-CLOSURE-WIPE — narrower-scoped key-material handler.
    //
    // Encapsulates the irreversible step: seed derivation, pubkey
    // derivation, and the `account_update` broadcast. All `const` bindings
    // that hold sensitive material (`oldSeed`, `oldKeys`, `newSeed`,
    // `newKeys`, `newPubKeys`, `ownerKey`) are local to this method's
    // frame. When this method's promise resolves, the frame is popped off
    // the stack and those bindings become unreachable, eligible for GC on
    // the next cycle. The Keychain WIF-import loop is intentionally NOT
    // here (split out to `_performKeychainImport`) so a denied popup
    // mid-loop cannot interrupt the broadcast/backend-cleanup atomic pair
    // — see `executeUpgrade()` ordering comment.
    //
    // Reachability invariant: this method returns `undefined` (via the
    // resolved promise); none of the `const` bindings inside it are
    // returned, assigned to `this`, captured in a closure that outlives
    // the call, or passed by reference to the caller. The only persistent
    // side effect is on-chain (`sendOperations`). If a future refactor
    // needs data back from here (e.g., a tx id), return a scalar, not the
    // key objects.
    //
    // Arguments are passed by value (`oldWords` is a string; `newSeedPhrase`
    // is a string — Alpine reactive fields resolve to primitive strings
    // before being passed in, so no observer reference leaks through).
    async _performUpgradeKeyRotation(oldWords, newSeedPhrase) {
      // Derive keys from old and new seed phrases
      const dhive = await import('@hiveio/dhive');
      const oldSeed = mnemonicToSeedSync(oldWords);
      const oldKeys = deriveHiveKeys(oldSeed, this.username);
      const newSeed = mnemonicToSeedSync(newSeedPhrase);
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
      // Intentionally returns `undefined`. Do NOT return `newKeys`,
      // `newPubKeys`, or anything else that would re-escape the derived
      // material into `executeUpgrade`'s frame.
    },

    // Best-effort Keychain WIF import for posting + active + memo. Runs
    // AFTER the irreversible (broadcast + backend cleanup) pair has
    // landed; per-role failures push a localized warning to
    // `this.upgradeWarnings` instead of throwing. The user can retry from
    // settings later for any role that didn't land.
    //
    // NOT owner — owner keys are the account-recovery root of trust and
    // should live in the user's seed phrase only, never in a browser
    // extension. `account_update` still rotates owner on-chain (see
    // newPubKeys.owner in `_performUpgradeKeyRotation`); the user's new
    // mnemonic is the only way to re-derive it.
    //
    // Closure-wipe shape: this helper re-derives `newKeys` from the seed
    // phrase locally (rather than receiving it from the caller) so its
    // own frame holds the only references to derived material; when the
    // helper returns, the frame pops and `newKeys` / per-iteration `wif`
    // become unreachable. Reachability invariant matches
    // `_performUpgradeKeyRotation`: returns `undefined`; no key object
    // escapes to `executeUpgrade`'s frame.
    //
    // Historical bug: the upgrade flow used to call
    // `requestAddAccountAuthority(username, rawHexSeed, 'posting', ...)`
    // which (a) is the wrong API semantic (second arg should be an
    // ACCOUNT NAME, not a key) and (b) leaks the raw 64-char hex
    // private-key seed into Keychain's extension logs. `requestImportKey`
    // is the correct API.
    async _performKeychainImport(newSeedPhrase) {
      if (!isKeychainInstalled()) {
        // Race: extension was installed at executeUpgrade() entry (proven
        // by the account_update sign in _performUpgradeKeyRotation) but
        // disabled or crashed before this helper ran (auto-update, manual
        // toggle, content-script crash). Without surfacing warnings the
        // user lands on a clean 'done' screen with zero Keychain-bound
        // roles; the first post-upgrade vote/comment/transfer fails
        // silently because Keychain has no key for this account. Push the
        // same per-role warnings the in-loop denial path uses so the
        // success surface is consistent with a 3-deny outcome.
        for (const role of ['posting', 'active', 'memo']) {
          this.upgradeWarnings.push(this.$t(`upgrade.keychainImportWarning.${role}`));
        }
        return;
      }
      const dhive = await import('@hiveio/dhive');
      const newSeed = mnemonicToSeedSync(newSeedPhrase);
      const newKeys = deriveHiveKeys(newSeed, this.username);
      const importRoles = ['posting', 'active', 'memo'];
      for (const role of importRoles) {
        const wif = dhive.PrivateKey.fromSeed(newKeys[role]).toString();
        try {
          await new Promise((resolve, reject) => {
            window.hive_keychain.requestImportKey(
              this.username, wif,
              (res) => res.success ? resolve(res) : reject(new Error(res.message || 'Keychain import failed'))
            );
          });
        } catch (err) {
          // Per-role failure becomes a warning, not a fatal error. The
          // loop continues to the next role so a denial on (e.g.) active
          // doesn't block the memo import.
          // Sanitization pattern: raw err to console.warn for diagnostics,
          // localized message to user-visible warnings array.
          console.warn(`[custody upgrade] keychain import ${role}`, err);
          const key = `upgrade.keychainImportWarning.${role}`;
          this.upgradeWarnings.push(this.$t(key));
        }
      }
    },

    // Zero the plaintext-sensitive fields used during the custody upgrade
    // flow: the old mnemonic the user typed, the freshly-generated new
    // mnemonic (both as a string and as the words array used for the
    // confirmation step), the confirmation inputs, and the re-entered
    // light-account password. Callers that also need to reset phase/error
    // should use `resetUpgrade()` instead.
    //
    // FE-UPGRADE-CLOSURE-WIPE — this helper zeros REACTIVE (Alpine `this.*`)
    // fields only. Closure-captured `const` bindings that held derived key
    // material during the broadcast/import step live inside
    // `_performUpgradeKeyRotation()` and are dropped when that method's
    // frame pops, BEFORE this helper runs. See the big comment block on
    // `_performUpgradeKeyRotation()`.
    _clearSensitiveUpgradeState() {
      this.oldSeedPhrase = '';
      this.newSeedPhrase = '';
      this.newSeedWords = [];
      this.confirmInputs = {};
      this.upgradePassword = '';
    },

    resetUpgrade() {
      this._clearSensitiveUpgradeState();
      this.upgradePhase = 'idle';
      this.upgradeError = null;
      this.upgradeWarnings = [];
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
