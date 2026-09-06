import Alpine from 'alpinejs';
import { isKeychainInstalled } from '../keychain.js';
import { fetchEmailStatus, submitEmail, deleteEmail, startOrcid, setPassword, submitAccreditationMetadata, fetchAdminRoster } from '../api.js';
import { withSettingsFreshAuth } from '../lib/settings-fresh-auth.js';
import { deriveHiveKeys, deriveHivePublicKeys, generateMnemonic, loadDhive, validateMnemonic } from '../hive-keys.js';
import { isPasswordValid } from '../password-policy.js';
import { getAppTag } from '../config.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { createOrcidRedirectGuard } from '../lib/orcid-redirect-guard.js';
import { ORCID_REDIRECT_HOSTS } from '../lib/fresh-auth.js';

// Number of words to re-enter for confirmation
const CONFIRM_WORD_COUNT = 3;

// Per-field length bounds for the editable-accreditation-metadata form, mirroring
// accreditationRequestSchema in backend/src/validation.ts (full_name/institution
// max 200, field max 100; min 1 after trim). The client gate is UX-only; the
// backend re-validates. The single source for both the `canSubmitMetadata` gate
// and the template `:maxlength` bindings (exposed as `metadataMax`), so a future
// bound change is a one-line edit here.
const METADATA_MAX = { name: 200, institution: 200, field: 100 };

// Single source of truth for `upgradeErrorKey` discriminators. Catch-block
// sub-cases reference UPGRADE_ERROR_KEYS by symbolic name; `canRetryUpgrade`
// and `handleRetry` consume the paired RETRYABILITY annotation. Adding a new
// sub-case is a one-shot edit at this map: a mis-typed key surfaces as an
// `undefined` RETRYABILITY entry rather than a silent classification flip.
//
// Retryability values:
//   'retryable-backend-only' — chain rotation landed; only re-run the backend
//                              cleanup POST via `retryUpgradeBackend()`. Keeps
//                              `newSeedPhrase` in state so the re-derive
//                              succeeds. (`upgrade.backendUnavailable` post-503,
//                              `upgrade.proofRejected` first-401, and
//                              `upgrade.sessionChangedBeforeCleanup`, where the
//                              retry's own start guard declined to spend
//                              anything, so a re-login as the pinned subject
//                              that keeps this component mounted is all the
//                              next attempt needs.)
//   'retryable-reset'       — pre-broadcast failure; safe to reset the wizard
//                              to 'idle' and re-broadcast. `handleRetry`
//                              dispatches to `resetUpgrade()`.
//   'terminal'              — chain rotation landed AND no further retry is
//                              meaningful (alreadyUpgraded, rateLimited, second
//                              401, post-broadcast backendTimeout, generic
//                              partialApplyFailed, and the after-cleanup half
//                              of the session-changed pair, where the upgrade
//                              is complete and only the local Keychain import
//                              is left, for a session this tab no longer
//                              holds). Try Again is hidden.
const UPGRADE_ERROR_KEYS = {
  keychainRequired: 'upgrade.keychainRequired',
  generationFailed: 'upgrade.generationFailed',
  failed: 'upgrade.failed',
  proofRejected: 'upgrade.proofRejected',
  backendUnavailable: 'upgrade.backendUnavailable',
  backendTimeout: 'upgrade.backendTimeout',
  partialApplyFailed: 'upgrade.partialApplyFailed',
  alreadyUpgraded: 'upgrade.alreadyUpgraded',
  rateLimited: 'upgrade.rateLimited',
  // The two halves of "this tab stopped representing the account the upgrade
  // started for". Both are reached only after the chain rotation landed; they
  // differ in whether the backend cleanup also landed, which decides what is
  // left for the user to do. The after-cleanup half is terminal: the upgrade
  // is complete, the seed is spent, and only the local Keychain import is
  // missing. The before-cleanup half is retryable: it is reached only from
  // the retry's start guard, which declines before spending anything and
  // keeps the seed and the pin, so once the user signs back in as the
  // pinned subject the same Try Again runs the cleanup. Splitting them
  // is what keeps each message true: one string for both would have to lie
  // in one of the two cases. Neither name is a prefix of the other, so the
  // per-key grep over the translation-stub ledger still names one key at a
  // time.
  sessionChangedAfterCleanup: 'upgrade.sessionChangedAfterCleanup',
  sessionChangedBeforeCleanup: 'upgrade.sessionChangedBeforeCleanup',
};

const RETRYABILITY = {
  [UPGRADE_ERROR_KEYS.keychainRequired]: 'retryable-reset',
  [UPGRADE_ERROR_KEYS.generationFailed]: 'retryable-reset',
  [UPGRADE_ERROR_KEYS.failed]: 'retryable-reset',
  [UPGRADE_ERROR_KEYS.proofRejected]: 'retryable-backend-only',
  [UPGRADE_ERROR_KEYS.backendUnavailable]: 'retryable-backend-only',
  [UPGRADE_ERROR_KEYS.backendTimeout]: 'terminal',
  [UPGRADE_ERROR_KEYS.partialApplyFailed]: 'terminal',
  [UPGRADE_ERROR_KEYS.alreadyUpgraded]: 'terminal',
  [UPGRADE_ERROR_KEYS.rateLimited]: 'terminal',
  [UPGRADE_ERROR_KEYS.sessionChangedAfterCleanup]: 'terminal',
  [UPGRADE_ERROR_KEYS.sessionChangedBeforeCleanup]: 'retryable-backend-only',
};

// Clock-skew tolerance before warning advisory fires. Backend's freshness
// window is 60s; warn at 30s so the user has slack to correct before a
// proof-rejected 401. Advisory-only fallback: no `GET /api/time` endpoint
// exists yet, so we cannot abort on skew; we log the `signed_at` generation
// time as a console.warn instead. When the backend endpoint lands, swap to
// a hard pre-broadcast abort with `upgrade.clockSkewBlocked`.
const UPGRADE_CLOCK_SKEW_WARN_MS = 30_000;

// Retry budget for proof-rejected (post-broadcast 401). First 401 keeps
// `newSeedPhrase` and routes to a retryable sub-case so the user can correct
// their system clock (the most-likely 401 cause until a backend time endpoint
// exists). Second 401 wipes — at that point the proof is genuinely broken and
// a budget past 2 would just delay an inevitable terminal route.
const UPGRADE_PROOF_RETRY_BUDGET = 2;

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

            <!-- Admin console entry: shown only when the best-effort tier probe
                 returns a tier (roster members). The /admin route re-gates
                 server-side, so this is discoverability only. -->
            <template x-if="adminTier">
              <a :href="$lp('/admin')" @click.prevent="navigate('/admin')"
                 class="inline-block -mt-4 mb-8 text-sm text-pevo-teal hover:underline" x-text="$t('settings.adminConsoleLink')"></a>
            </template>

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
                  <!-- "Try Again" is hidden on terminal post-broadcast sub-cases
                       because resetUpgrade()→startUpgrade() generates a new
                       mnemonic and re-broadcasts account_update with the
                       OLD seed-derived keys, which the chain rejects (the
                       prior attempt's rotation already landed). The copy
                       on those sub-cases describes an out-of-band recovery
                       (sign in again, wait out the hour, or contact
                       support); no in-app retry is meaningful. The 503/backendUnavailable
                       sub-case IS retryable but only against the backend
                       cleanup call — handleRetry() dispatches to
                       retryUpgradeBackend() in that case, preserving the
                       already-rotated chain state and re-signing a fresh
                       proof. The same holds for a retry that its start guard
                       declined because the browser was no longer signed in
                       as the upgrade's account: nothing was spent, so Try
                       Again stays for after the user signs back in. -->
                  <button x-show="canRetryUpgrade" @click="handleRetry()" class="text-pevo-teal hover:underline text-sm" x-text="$t('common.tryAgain')"></button>
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

                <!-- Step 3: Enter old seed phrase -->
                <div x-show="upgradePhase === 'enter-old'">
                  <div class="space-y-4 mb-6">
                    <div>
                      <label class="block text-sm font-medium text-ink mb-1" x-text="$t('upgrade.oldSeedLabel')"></label>
                      <textarea x-model="oldSeedPhrase" rows="3"
                                class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                                :placeholder="$t('upgrade.oldSeedPlaceholder')"
                                autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
                    </div>
                  </div>
                  <button @click="executeUpgrade()" :disabled="!oldSeedPhrase.trim()"
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

            <!-- Editable accreditation metadata (accredited users). Edits
                 re-broadcast an admin-signed accredit op (the user never signs;
                 they only re-auth per § 6.4). The latest op is authoritative for
                 metadata so edits show; tenure ("accredited since") stays on the
                 earliest-op anchor. ORCID-accredited users with empty
                 institution/field fill them in here for the first time via the
                 same form. -->
            <template x-if="isAccredited">
              <div data-testid="accreditation-metadata-section" class="border border-parchment-dark rounded-xl p-6 mt-6">
                <h2 class="text-xl font-bold text-ink mb-2" x-text="$t('settings.metadataTitle')"></h2>
                <p class="text-sm text-ink-muted mb-4" x-text="$t('settings.metadataDescription')"></p>

                <form @submit.prevent="handleMetadataSubmit()" class="space-y-3">
                  <div>
                    <label class="block text-sm font-medium text-ink mb-1" x-text="$t('settings.metadataNameLabel')"></label>
                    <input type="text" data-testid="metadata-name-input" x-model="editName" required :maxlength="metadataMax.name"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           :placeholder="$t('settings.metadataNamePlaceholder')">
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-ink mb-1" x-text="$t('settings.metadataInstitutionLabel')"></label>
                    <input type="text" data-testid="metadata-institution-input" x-model="editInstitution" required :maxlength="metadataMax.institution"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           :placeholder="$t('settings.metadataInstitutionPlaceholder')">
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-ink mb-1" x-text="$t('settings.metadataFieldLabel')"></label>
                    <input type="text" data-testid="metadata-field-input" x-model="editField" required :maxlength="metadataMax.field"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           :placeholder="$t('settings.metadataFieldPlaceholder')">
                  </div>
                  <button type="submit" data-testid="metadata-submit" :disabled="!canSubmitMetadata || metadataSubmitting"
                          class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                          x-text="metadataSubmitting ? $t('settings.metadataSaving') : $t('settings.metadataSubmit')"></button>
                  <p x-show="metadataError" class="text-sm text-red-600" x-text="metadataError"></p>
                </form>
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

              <!-- Status unavailable: assert nothing, offer a retry. -->
              <template x-if="!emailLoading && emailStatusError">
                <div class="py-2">
                  <p class="text-sm text-ink-muted mb-3" x-text="$t('settings.emailStatusLoadFailed')"></p>
                  <button type="button" data-testid="email-status-retry" @click="loadEmailStatus()"
                          class="btn-primary" x-text="$t('common.retry')"></button>
                </div>
              </template>

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
                        <p x-show="custody === 'light'" class="text-sm text-ink-muted mb-3"
                           x-text="$t('settings.deleteSeedPhraseContinuation')"></p>
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
                        <p x-show="custody === 'light'" class="text-sm text-ink-muted mb-3"
                           x-text="$t('settings.deleteSeedPhraseContinuation')"></p>
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
    // Lifecycle guard. See frontend/src/lib/timer-guard.js. executeUpgrade's
    // post-broadcast _postUpgradeBackend fetch can take 20s before resolving;
    // if the user navigates away mid-flight, the continuation must not call
    // loginFromResponse (and _saveSession + _startAccreditationPolling
    // through it) on the singleton auth store, since the singleton has no
    // component boundary to absorb the writes. Unmount is one of two reasons
    // that continuation must hold off; `_upgradeSubjectDiverged` covers the
    // other, where the component is alive but the store has moved to a
    // different account or to none. `_mounted` says nothing about who the
    // store names, so the two guards sit together at every landing.
    ...createTimerGuard(),
    // Resets `orcidLinking` on bfcache restore (Back from the ORCID link flow).
    ...createOrcidRedirectGuard('orcidLinking'),

    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },
    get custody() { return Alpine.store('auth').custody; },
    get isLight() { return this.custody === 'light'; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get accreditation() { return Alpine.store('auth').accreditation; },
    get currentOrcid() { return Alpine.store('auth').accreditation?.orcid || null; },

    // Mirrors the backend bounds (METADATA_MAX / accreditationRequestSchema):
    // all three fields required, non-empty after trim, within length. UX gate
    // only; the backend re-validates.
    get canSubmitMetadata() {
      const n = this.editName.trim();
      const i = this.editInstitution.trim();
      const f = this.editField.trim();
      return n.length >= 1 && n.length <= METADATA_MAX.name
        && i.length >= 1 && i.length <= METADATA_MAX.institution
        && f.length >= 1 && f.length <= METADATA_MAX.field;
    },

    // ORCID link state
    orcidLinking: false,
    orcidError: null,

    // Email management state
    emailStatus: null,
    // A failed status fetch asserts NOTHING: `emailStatus` stays null (which
    // hides every section that branches on it, the set-a-password one
    // included) and this flag renders a retry affordance instead. A
    // fabricated status here once drew the set-password section at accounts
    // that already had one, and that section's action is `set_password`,
    // whose only factor is a full-page ORCID navigation.
    emailStatusError: false,
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

    // Editable accreditation metadata. Pre-filled once from the auth store's
    // current accreditation (persisted/restored, so usually present at init;
    // a $watch covers the late-load case). ORCID-accredited users land with
    // empty institution/field and fill them in here via the same inputs.
    editName: '',
    editInstitution: '',
    editField: '',
    metadataSubmitting: false,
    metadataError: null,
    _metadataPrefilled: false,
    // Exposed for the template `:maxlength` bindings so the per-field caps share
    // the single METADATA_MAX source with the canSubmitMetadata gate.
    metadataMax: METADATA_MAX,

    // Admin-console entry-link gate: the viewer's admin tier, or null if not in
    // the roster (or before the roster endpoint lands). Best-effort, set in init.
    adminTier: null,

    // Upgrade flow state
    // Phases: 'idle' | 'new-seed' | 'confirm-new' | 'enter-old' | 'upgrading' | 'done' | 'error'
    upgradePhase: 'idle',
    upgradeError: null,
    // Discriminator paired with `upgradeError`. Holds the i18n key behind
    // the currently-displayed error string, not the translated text. The
    // `canRetryUpgrade` getter consults this key (not the translated
    // `upgradeError`) so its decision is invariant to locale switches the
    // user might trigger from the header switcher on the error screen, and
    // so a future non-retryable sub-case requires only a 'terminal' entry
    // in RETRYABILITY at module top, not a coincidental
    // string match. Per
    // agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md.
    // Reset alongside `upgradeError` at every clear site.
    upgradeErrorKey: null,

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

    // Post-broadcast 401-proof retry counter. Increments on every
    // post-broadcast 401 (first in executeUpgrade, subsequent ones in
    // retryUpgradeBackend). Below UPGRADE_PROOF_RETRY_BUDGET the catch keeps
    // `newSeedPhrase` and routes to retryable `proofRejected`; at or above
    // the budget the catch wipes and routes to terminal `partialApplyFailed`.
    // Reset on `resetUpgrade` (a fresh wizard run is a new budget).
    _proofRetryAttempts: 0,

    // The account this upgrade is for, captured before `executeUpgrade`'s
    // first await. Every later step reads this instead of the live store:
    // `this.username` is a getter over the singleton auth store, the backend
    // cleanup window is up to 20 seconds, and the error screen the retry
    // starts from has no timeout at all, so the store can name a different
    // account by the time a continuation resumes. One field rather than a
    // capture per call site, because `retryUpgradeBackend` runs on a click
    // that can arrive long after the drift it would otherwise bake in.
    // Cleared with the rest of the upgrade's state so its lifetime matches
    // the seed's: while a retry is still possible both survive, and once the
    // flow is spent both go.
    _upgradeSubject: null,

    // beforeunload listener installed in init() and torn down in destroy()
    // (init() also deregisters a previous instance before reassigning). It
    // stays registered across every upgrade phase; outside 'upgrading' the
    // handler's own phase check makes it a no-op. Held as a bound reference
    // so addEventListener and removeEventListener target the same function.
    _beforeUnloadHandler: null,

    get confirmCorrect() {
      return this.confirmIndices.every(
        (i) => this.confirmInputs[i]?.trim().toLowerCase() === this.newSeedWords[i]
      );
    },

    // Drives the "Try Again" button visibility on the error screen. False
    // when `upgradeErrorKey` is one of the terminal post-broadcast sub-cases:
    // on those paths the on-chain account_update has already landed, so a
    // fresh attempt would sign account_update with the OLD seed-derived
    // keys and the chain would reject it (auth mismatch). The error-copy
    // on those sub-cases describes an out-of-band recovery (sign in again,
    // wait out the hour, or contact support); the in-app retry path is
    // structurally unavailable. The `upgrade.backendUnavailable`
    // sub-case (post-broadcast 503) IS retryable but only against the
    // backend cleanup call — `handleRetry()` dispatches to
    // `retryUpgradeBackend()` which keeps `newSeedPhrase` and re-signs the
    // proof without re-broadcasting the now-stale chain rotation. The
    // `alreadyUpgraded` and `rateLimited` sub-cases are non-retryable for
    // semantic reasons (nothing to retry / per-account-hour budget burnt),
    // and `sessionChangedAfterCleanup` for a third: the upgrade is complete
    // and the seed is spent, so there is nothing left for a retry to do.
    // Its before-cleanup sibling is retryable, because it is reached only
    // from `retryUpgradeBackend`'s start guard, which spent nothing and
    // kept the seed: after the user signs back in as the pinned subject,
    // the same Try Again runs the cleanup.
    // Compares discriminator keys, not translated strings, so the result
    // is invariant to mid-error-screen locale switches.
    get canRetryUpgrade() {
      // Consume the RETRYABILITY annotation rather than a hand-curated
      // NON_RETRYABLE list. Unknown keys (including null on the initial-load
      // path) fall through to `true` to match the prior default; every
      // assigned key appears in RETRYABILITY at module top so a typo lands
      // as "undefined RETRYABILITY entry" rather than a silent classification
      // flip.
      return RETRYABILITY[this.upgradeErrorKey] !== 'terminal';
    },

    // Dispatch retry to the right action based on the error sub-case. The
    // `retryable-backend-only` sub-cases (post-broadcast 503, first-401 proof
    // rejection, and a retry the start guard declined for a diverged store)
    // preserve the chain-rotated state and retry only the backend
    // cleanup call; the `retryable-reset` sub-cases are pre-broadcast failures
    // that reset the wizard to idle so a fresh attempt regenerates the new
    // mnemonic and re-broadcasts cleanly. Dispatch reads RETRYABILITY (the
    // single source of truth), not a hand-curated key comparison.
    handleRetry() {
      const r = RETRYABILITY[this.upgradeErrorKey];
      if (r === 'retryable-backend-only') {
        this.retryUpgradeBackend();
      } else {
        this.resetUpgrade();
      }
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
      // Reset the ORCID linking flag if the page is restored from bfcache
      // after a Back from the ORCID link flow (the success path navigates
      // away with the flag still true and init()/destroy() do not run on
      // bfcache restore).
      this._installOrcidRedirectGuard();

      if (this.isConnected) {
        this.loadEmailStatus();
      }
      this.$watch('isConnected', (connected) => {
        if (connected) this.loadEmailStatus();
      });

      // Pre-fill the editable-metadata inputs from the current accreditation.
      // Usually present at init (the store is persisted/restored); the $watch
      // covers the case where accreditation lands later (login or polling). The
      // one-shot guard prevents a late update from clobbering in-progress edits.
      this._prefillMetadata();
      this.$watch('isAccredited', (accredited) => {
        if (accredited) this._prefillMetadata();
      });

      // Best-effort admin-tier probe for the console entry link. Silent on
      // failure (non-admins, or before the roster endpoint lands) so it renders
      // nothing rather than an error. The /admin route re-gates server-side.
      if (this.isConnected) {
        fetchAdminRoster()
          .then((res) => { if (this._mounted) this.adminTier = res.data?.tier ?? null; })
          .catch(() => {});
      }

      // Warn on tab close / navigation while `upgradePhase==='upgrading'`.
      // Mid-broadcast unload bricks the account (server keeps stale keys,
      // chain has new keys, next sign-in lands in a broken state with no
      // auto-recovery — see executeUpgrade ordering comment). Browsers honour
      // a non-empty `returnValue` as "you have unsaved changes". This is a UX
      // affordance, not a hard block; modern browsers may suppress repeated
      // dialogs and ignore the string content, but they still show the
      // generic confirmation. Listener is bound to a method-reference field
      // so destroy() can removeEventListener against the exact same handler
      // — anonymous lambdas would silently leak across remount/unmount.
      //
      // Deregister-before-reassign: Alpine can re-instantiate the component
      // (x-data scope change, route re-mount) without an intervening
      // destroy(). Without this guard the first init's closure stays bound
      // to window for the tab's lifetime, capturing the dead component
      // scope and firing for every navigation.
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        if (this._beforeUnloadHandler && typeof window.removeEventListener === 'function') {
          window.removeEventListener('beforeunload', this._beforeUnloadHandler);
          this._beforeUnloadHandler = null;
        }
        this._beforeUnloadHandler = (event) => {
          if (this.upgradePhase === 'upgrading') {
            // The string itself is largely ignored by modern browsers (Chrome
            // and Firefox display their generic "Leave site?" dialog) but the
            // non-empty `returnValue` is the signal that triggers the prompt
            // at all. setting returnValue + returning the same string keeps
            // legacy browsers happy too.
            event.preventDefault();
            event.returnValue = 'Upgrade in progress';
            return 'Upgrade in progress';
          }
          return undefined;
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
      }

      // SPA-internal navigation guard. `beforeunload` only fires on tab/window
      // close, not on router `navigate(...)` calls (in-page link clicks,
      // programmatic navigation). Without this guard, a user mid-broadcast
      // who clicks the PEvO logo or another nav link silently leaves the
      // upgrade flow: the component unmounts, the in-flight POST is orphaned,
      // and the user lands with a light JWT pointing at an already-rotated
      // chain account. Mirrors the beforeunload deregister-before-reassign
      // pattern above so Alpine re-instantiation doesn't double-register.
      const router = Alpine.store('router');
      if (this._navigationGuard) {
        router.unregisterNavigationGuard(this._navigationGuard);
        this._navigationGuard = null;
      }
      this._navigationGuard = () => {
        if (this.upgradePhase !== 'upgrading') return true;
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
          // No confirm prompt available; fall back to block (safer than
          // silently allowing nav and bricking the account).
          return false;
        }
        return window.confirm(this.$t('upgrade.navigationGuardConfirm'));
      };
      router.registerNavigationGuard(this._navigationGuard);

      // Check if returning from ORCID link callback
      const orcidLinked = localStorage.getItem('pevo_orcid_link_complete');
      if (orcidLinked) {
        localStorage.removeItem('pevo_orcid_link_complete');
        // Refresh accreditation data to pick up the new ORCID. Pass the
        // current polling generation so a concurrent in-flight poll fetch
        // cannot clobber this one-shot result via the stale-fetch race.
        const auth = Alpine.store('auth');
        auth._checkAccreditation(auth._pollingGeneration);
        Alpine.store('toast').show(this.$t('settings.orcidLinkSuccess'), 'success');
      }
    },

    destroy() {
      // Explicit unmount cleanup signal for in-flight upgrade work. The
      // upgrade flow can be mid-Keychain-loop when the user navigates
      // away; the loop's per-iteration _mounted check will short-circuit,
      // but the mnemonic + WIFs in this.* are reactive state that would
      // otherwise live until GC reclaims the orphaned component. Wiping
      // here closes the navigate-away XSS-surface window deterministically.
      // Order: the wipe runs first and `_teardownTimers()` flips `_mounted`
      // last. That is not cosmetic. Between those two statements the flag
      // still reads true while the fields are already gone, and a continuation
      // that resumes after this returns finds them zeroed either way. Which is
      // why the in-flight legs snapshot what they need (the seed phrase, the
      // pinned account) into frame-locals before their first await rather than
      // reading these fields back: the flag is not a proxy for the wipe, and
      // the stretch between the chain rotation and the backend cleanup has to
      // finish on what it captured.
      this._clearSensitiveUpgradeState();
      // Remove the beforeunload listener so it does not remain bound to a
      // torn-down component (would leak handler closures and would flash a
      // confirm dialog on subsequent navigations even after the upgrade
      // flow is gone).
      if (this._beforeUnloadHandler && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        this._beforeUnloadHandler = null;
      }
      // Symmetric cleanup for the SPA-internal navigation guard. Without
      // this, an unmounted component's closure stays registered on the
      // router store and continues to block navigation forever.
      if (this._navigationGuard) {
        Alpine.store('router').unregisterNavigationGuard(this._navigationGuard);
        this._navigationGuard = null;
      }
      this._teardownOrcidRedirectGuard();
      this._teardownTimers();
    },

    async handleOrcidLink() {
      if (this.orcidLinking) return;
      this.orcidLinking = true;
      this.orcidError = null;

      // sessionStorage (not localStorage) — see fresh-auth.js
      // beginOrcidFreshAuthRedirect for the cross-tab-interference rationale that
      // scopes `pevo_orcid_mode` to the originating tab.
      sessionStorage.setItem('pevo_orcid_mode', 'link');

      try {
        const data = await startOrcid('link');
        const target = new URL(data.redirect_url);
        if (!ORCID_REDIRECT_HOSTS.includes(target.hostname)) {
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
        sessionStorage.removeItem('pevo_orcid_mode');
      }
    },

    async loadEmailStatus() {
      this.emailLoading = true;
      this.emailStatusError = false;
      try {
        const res = await fetchEmailStatus();
        this.emailStatus = res.data;
      } catch {
        // Assert nothing about the account on a failed fetch — see the
        // `emailStatusError` declaration for why a fabricated status is
        // dangerous here. The template renders a retry affordance instead.
        this.emailStatus = null;
        this.emailStatusError = true;
      } finally {
        this.emailLoading = false;
      }
    },

    // Context for the settings fresh-auth orchestrator. `custody` gates whether
    // a body proof is sent at all (light → proof required on the JWT path;
    // self-custody → the per-request Keychain signature is already fresh).
    // Password-vs-ORCID factor selection is NOT passed in: it lives in
    // `resolvePasswordFactor` (lib/fresh-auth.js), so a failed status fetch
    // on this page cannot route the user to a different factor than the same
    // account gets anywhere else.
    _freshAuthCtx() {
      return {
        custody: this.custody,
        username: this.username,
      };
    },

    // One-shot pre-fill of the editable-metadata inputs from the current
    // accreditation. No-op once filled so a late store update (polling) cannot
    // overwrite edits the user has started typing.
    _prefillMetadata() {
      if (this._metadataPrefilled) return;
      const acc = this.accreditation;
      if (!acc) return;
      this.editName = acc.name || '';
      this.editInstitution = acc.institution || '';
      this.editField = acc.field || '';
      this._metadataPrefilled = true;
    },

    async handleMetadataSubmit() {
      if (!this.canSubmitMetadata || this.metadataSubmitting) return;
      this.metadataSubmitting = true;
      this.metadataError = null;
      // Trim to match the backend's trim-before-validate; the broadcast carries
      // the merged values and the latest accredit op becomes authoritative.
      const values = {
        full_name: this.editName.trim(),
        institution: this.editInstitution.trim(),
        field: this.editField.trim(),
      };
      try {
        // Critical action (admin-signed on-chain broadcast): the JWT path needs
        // an edit_accreditation_metadata fresh-auth proof. The orchestrator
        // mints it (password modal or ORCID round-trip) and threads it into the
        // request; self-custody passes no proof. Same flow as handleEmailSubmit.
        const outcome = await withSettingsFreshAuth(
          'edit_accreditation_metadata',
          this._freshAuthCtx(),
          (proof) => submitAccreditationMetadata(values, proof),
        );
        // ORCID round-trip navigating away, password modal dismissed, or a
        // torn-down corrupted session: abort cleanly (the orchestrator already
        // toasted on sessionInconsistent).
        if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) return;
        if (outcome.freshAuthFailed) {
          this.metadataError = this.$t('settings.reauthFailed');
          return;
        }
        // Optimistically reflect the merged metadata in the auth store so the
        // Settings inputs, profile, and accreditation pages update without a
        // reload. The store helper merges the latest-op metadata, preserves
        // tenure, and invalidates any in-flight accreditation poll that could
        // revert the display (see auth.applyAccreditationMetadata). Only claim
        // success when the merge landed: if the store has no current
        // accreditation to merge into, the on-chain edit still landed but the
        // display can't update, so a "saved" toast against stale values would
        // mislead.
        const applied = Alpine.store('auth').applyAccreditationMetadata({
          name: values.full_name,
          institution: values.institution,
          field: values.field,
        });
        if (applied) {
          Alpine.store('toast').show(this.$t('settings.metadataSaved'), 'success');
        }
      } catch (err) {
        // Sanitization pattern (see handleOrcidLink): generic localized message
        // to the DOM, raw error only to console.warn.
        console.warn('[accreditation metadata]', err);
        this.metadataError = this.$t('settings.metadataUpdateFailed');
      } finally {
        this.metadataSubmitting = false;
      }
    },

    async handleEmailSubmit() {
      if (!this.newEmail.trim() || this.emailSubmitting) return;
      this.emailSubmitting = true;
      this.emailMessage = null;
      this.emailError = null;
      const email = this.newEmail.trim();
      try {
        // Critical action: the JWT path needs a change_email fresh-auth proof.
        // The orchestrator mints it (password modal or ORCID round-trip) and
        // threads it into submitEmail; self-custody passes no proof.
        const outcome = await withSettingsFreshAuth(
          'change_email',
          this._freshAuthCtx(),
          (proof) => submitEmail(email, proof),
        );
        // ORCID round-trip navigating away, password modal dismissed, or a
        // torn-down corrupted session: abort cleanly. The user resumes
        // (re-clicks) after returning from ORCID; on sessionInconsistent the
        // orchestrator already disconnected and showed the re-login toast, so we
        // skip a second toast here.
        if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) return;
        if (outcome.freshAuthFailed) {
          this.emailError = this.$t('settings.reauthFailed');
          return;
        }
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
      // Snapshot the password as a primitive so the orchestrator's run callback
      // captures it by value. set-password is ORCID-only (a passwordless State-C
      // account has no password to base a password proof on), so on a light
      // account this always routes through the ORCID round-trip; after the user
      // returns and re-submits, the cached proof is consumed.
      const password = this.newPasswordInput;
      try {
        const outcome = await withSettingsFreshAuth(
          'set_password',
          this._freshAuthCtx(),
          (proof) => setPassword(password, proof),
        );
        if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) {
          // Zero the plaintext password from reactive state before navigating
          // away (ORCID redirect), returning (cancel), or aborting on a torn-down
          // corrupted session (sessionInconsistent — the orchestrator already
          // disconnected and toasted) — same XSS-read hygiene the custody-upgrade
          // flow applies to held credentials.
          this.newPasswordInput = '';
          this.newPasswordConfirmInput = '';
          return;
        }
        if (outcome.freshAuthFailed) {
          this.newPasswordInput = '';
          this.newPasswordConfirmInput = '';
          this.passwordError = this.$t('settings.reauthFailed');
          return;
        }
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
        // Account erasure is a critical action: the JWT path needs a
        // delete_account fresh-auth proof, minted via the orchestrator
        // (password modal or ORCID round-trip) and threaded into deleteEmail.
        const outcome = await withSettingsFreshAuth(
          'delete_account',
          this._freshAuthCtx(),
          (proof) => deleteEmail(true, proof),
        );
        // ORCID round-trip navigating away, password modal dismissed, or a
        // torn-down corrupted session: abort cleanly. The user resumes
        // (re-confirms) after returning from ORCID; on sessionInconsistent the
        // orchestrator already disconnected and showed the re-login toast, so we
        // skip a second toast here.
        if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) return;
        if (outcome.freshAuthFailed) {
          this.emailError = this.$t('settings.reauthFailed');
          return;
        }
        // The DELETE erases the entire PEvO account row, not just the email
        // column. The current session JWT now points at a deleted account, so
        // there is no logged-in state left to render. Tear the session down
        // and route to the landing page rather than optimistically patching
        // emailStatus into a logged-in settings view bound to a dead account.
        // No pre-navigate state resets here: navigate('/') destroys this
        // component in the same tick, so any local-field writes are unobserved.
        Alpine.store('auth').disconnect();
        Alpine.store('notifications').stop();
        Alpine.store('toast').show(this.$t('settings.accountDeleted'), 'success');
        this.navigate('/');
      } catch (err) {
        // Sanitization pattern (see handleOrcidLink).
        console.warn('[email delete]', err);
        this.emailError = this.$t('settings.emailDeleteFailed');
      } finally {
        this.deleting = false;
      }
    },

    startUpgrade() {
      // Ensure a fresh wizard run resets the proof-retry budget.
      // resetUpgrade() does this for the Try Again path; startUpgrade() can
      // be reached directly from idle without resetUpgrade firing first, so
      // the reset has to happen here too.
      this._proofRetryAttempts = 0;
      if (!isKeychainInstalled()) {
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.keychainRequired);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.keychainRequired;
        this.upgradePhase = 'error';
        return;
      }

      // Generate new 12-word BIP39 seed phrase client-side
      try {
        this.newSeedPhrase = generateMnemonic();
        this.newSeedWords = this.newSeedPhrase.split(' ');
        this.upgradePhase = 'new-seed';
        this.upgradeError = null;
        this.upgradeErrorKey = null;
      } catch (err) {
        // Sanitization pattern (see executeUpgrade() below). The
        // generateMnemonic() path pulls BIP39 entropy; a thrown error
        // could plausibly embed partial entropy or seed material on a
        // future library revision. Generic message to DOM, raw to
        // console.warn for diagnostics.
        console.warn('[custody upgrade start]', err);
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.generationFailed);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.generationFailed;
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
      this.upgradePhase = 'enter-old';
    },

    async executeUpgrade() {
      // Concurrent-invocation guard. The phase assignment two lines below
      // (`this.upgradePhase = 'upgrading'`) runs synchronously before the
      // first `await`. Any subsequent invocation — whether a synchronous
      // back-to-back x-on:click handler, a re-entry during a suspended
      // await (sendOperations in `_performUpgradeKeyRotation`, the
      // `/api/custody/upgrade` fetch, `_performKeychainImport`), or a
      // stray `$watch`/`x-effect` triggered by the phase change itself —
      // observes the mutated phase and short-circuits at this guard. The
      // opening field-presence check below is not sufficient because it
      // does not change between invocations; the phase IS the lock.
      // 'enter-old' is the only legal entry phase (set by
      // `proceedToOldSeed()`); two parallel flows would otherwise issue
      // two `account_update` broadcasts + two `/api/custody/upgrade` POSTs
      // + two 3-popup Keychain sequences.
      if (this.upgradePhase !== 'enter-old') return;
      if (!this.oldSeedPhrase.trim()) return;
      this.upgradePhase = 'upgrading';
      this.upgradeError = null;
      this.upgradeErrorKey = null;
      // Reset best-effort warnings on each attempt so a previous partial
      // run doesn't leak its messages into a subsequent success screen.
      this.upgradeWarnings = [];

      // Discriminator: flipped to true the moment `_performUpgradeKeyRotation`
      // resolves. Anything caught after that point is a post-broadcast
      // failure (chain rotation has already landed, retry would sign with
      // stale keys), and the catch routes to a non-retryable sub-case.
      // Errors caught BEFORE this flip (invalid old seed, Keychain denial
      // of account_update, chain rejection of the broadcast) are pre-
      // broadcast and genuinely retriable.
      let broadcastLanded = false;

      // Snapshot the new seed phrase locally so the keychain-import helper
      // (and the broadcast helper) receive it as a primitive-string argument
      // rather than reading `this.newSeedPhrase` directly. This keeps each
      // helper's frame the only owner of the derived material it produces
      // (closure-wipe invariant — see _performUpgradeKeyRotation and
      // _performKeychainImport). The wipe runs AFTER the keychain import in
      // the finally block (see ORDERING block below); the snapshot is for
      // closure-wipe hygiene, not for surviving a wipe-before-import.
      const newSeedPhrase = this.newSeedPhrase;

      // Pin the account this upgrade is for, before the first await. See the
      // `_upgradeSubject` field for why the pin outlives this frame, and take a
      // frame-local copy for this leg's own use: `destroy()` wipes the field,
      // and every step below resumes after an await, so reading the field
      // across one would hand a helper a null account name the moment the user
      // navigates away. The seed phrase is snapshotted just above for the same
      // reason. The field is what a LATER leg (the retry) reads; this local is
      // what THIS leg uses.
      this._upgradeSubject = this.username;
      const upgradeSubject = this._upgradeSubject;
      // Pin the credential beside it. The bearer the cleanup POST carries is
      // what identifies the account server-side, and the store's token can be
      // replaced across any of the suspensions below: by a login as someone
      // else, or by a same-subject re-login in another tab, which the subject
      // guards deliberately do not treat as a change. A local const rather
      // than a field, because nothing after this frame may reuse it: the
      // retry leg captures its own at its own start.
      const upgradeToken = Alpine.store('auth').token;

      // ORDERING:
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
      // the user can re-import the account into the Keychain extension
      // using their seed phrase. Mid-loop denials must NOT wipe the
      // mnemonic, must NOT mark the upgrade as failed, and must NOT skip
      // backend cleanup — backend cleanup happens BEFORE the loop.
      try {
        // Validate old seed phrase
        const oldWords = this.oldSeedPhrase.trim().toLowerCase();
        if (!validateMnemonic(oldWords)) {
          throw new Error(this.$t('upgrade.invalidOldSeed'));
        }

        // Closure-wipe: derive keys + broadcast `account_update`
        // inside a narrower-scoped helper so the closure frame that captured
        // the derived private-key material (oldSeed, oldKeys, newSeed,
        // newKeys, newPubKeys, ownerKey) is popped off the call stack
        // BEFORE `_clearSensitiveUpgradeState()` runs below. Reachability
        // invariant: no variable bound inside `_performUpgradeKeyRotation()`
        // escapes to `executeUpgrade()` other than control flow.
        await this._performUpgradeKeyRotation(upgradeSubject, oldWords, newSeedPhrase);
        broadcastLanded = true;

        // NO subject check between here and the POST, deliberately. A
        // cross-tab login or a sign-out can land in any of the suspensions
        // below, but every step from here on is bound to values captured
        // before the first await: the proof is derived and signed for
        // `upgradeSubject`, and the POST carries `upgradeToken`. The backend
        // takes the account from that bearer and rebuilds the challenge from
        // it, so neither the request body nor anything in this tab's store can
        // redirect the cleanup to whoever the tab now names. A stop here would
        // prevent no wrong-account action; it would only abandon step (c) of
        // the pair the ORDERING block above calls the flow's one irreversible
        // gap, leaving the account rotated on-chain while the backend still
        // holds keys that no longer sign for it. What a diverged tab does lose
        // is the right to adopt the response, and that is refused at the
        // landing below.

        // Sign the upgrade proof with the NEW seed-derived active key. The
        // proof binds the JWT-authenticated session to the seed phrase that
        // just rotated the on-chain authorities. After
        // `_performUpgradeKeyRotation` resolves the chain reflects the new
        // pubkeys, so `derived_pubkey` (from newSeedPhrase) appears in the
        // on-chain key_auths and the backend's chain-state check passes.
        // The proof is built inside `_signUpgradeProof` (its own frame) so
        // the derived private key stays local and doesn't escape into
        // executeUpgrade's frame. See `_performUpgradeKeyRotation` for the
        // closure-wipe invariant pattern this mirrors.
        const proof = await this._signUpgradeProof(upgradeSubject, newSeedPhrase);

        // Notify backend to clean up stored keys. Failure here surfaces as
        // upgradeError. Post-broadcast 503 is retryable via
        // `retryUpgradeBackend()` (chain rotation done, only the backend
        // RPC lookup failed); other post-broadcast errors route to a
        // terminal sub-case.
        const result = await this._postUpgradeBackend(proof, upgradeToken);
        // Post-await unmount guard: the backend cleanup can take up to 20s
        // before resolving. Every other adoption site of loginFromResponse
        // gates the helper call on `_mounted`; without the gate here, a
        // post-unmount continuation calls loginFromResponse on the singleton
        // auth store (firing _saveSession + _startAccreditationPolling) for
        // a user who has navigated away or explicitly disconnected.
        if (!this._mounted) return;

        // A landing for a subject this tab no longer represents must not
        // touch the singleton store at all. Two ways the tab gets there
        // during the backend window, both of which adoption would wave
        // through: a sign-out (`disconnect()` nulls the tab-subject marker,
        // so adoption sees no change and skips the scrub, and the landing
        // would write a full durable session for a user who just signed out
        // and propagate it to every tab), and a cross-tab login as a
        // different user (the payload omits `is_accredited` and
        // `accreditation`, which are preserve-on-undefined, so the
        // intervening user's badge would end up filed under the upgrade
        // subject's username). Dropping the landing leaves the store to its
        // current owner; the upgrade itself is finished, so the terminal
        // copy only has to route the user back for the Keychain import.
        if (this._upgradeSubjectDiverged(upgradeSubject)) {
          this._endUpgradeAsSessionChanged({ cleanupLanded: true, upgradeSubject });
          return;
        }

        // Update session via the shared helper. The upgrade response
        // rotates the session token; the helper enforces the atomic
        // {token, expires_at} pair invariant — both rotate together or
        // neither does. The decoupled-guard form this site used to ship
        // allowed `{token: new, expires_at: undefined}` to persist a
        // server-invalidated old token with new expiry. `username` is the
        // pinned upgrade subject rather than the store's current value:
        // belt-and-braces now that the guard above has already established
        // they are the same, and it keeps the helper's current-username
        // fallback out of this call site entirely. is_accredited and
        // accreditation are omitted from the data payload so the helper
        // preserves them (the upgrade flips custody and rotates session
        // credentials, not accreditation status).
        Alpine.store('auth').loginFromResponse({
          token: result.data?.token,
          expires_at: result.data?.expires_at,
          username: upgradeSubject,
          custody: 'self',
        });
        // Re-check post-loginFromResponse: the helper resolves synchronously
        // today but is contractually allowed to suspend (it calls into the
        // accreditation poller). The _completeUpgradeAfterBackend tail runs
        // a ~180s-worst-case Keychain loop, so any unmount up to here must
        // skip it — otherwise the orphaned component opens Keychain popups
        // on a navigated-away page. destroy() wipes sensitive state, so an
        // early return here leaks nothing.
        if (!this._mounted) return;
      } catch (err) {
        // Shared post-broadcast catch ladder consuming UPGRADE_ERROR_KEYS so
        // every sub-case has exactly one source-of-truth assignment site.
        this._handlePostBroadcastError(err, { broadcastLanded, logTag: '[custody upgrade]' });
        return;
      }

      await this._completeUpgradeAfterBackend(upgradeSubject, newSeedPhrase);
    },

    // Backend-cleanup retry. Reachable from the 'error' phase whenever
    // `RETRYABILITY[upgradeErrorKey] === 'retryable-backend-only'` — that's
    // post-broadcast 503 (`upgrade.backendUnavailable`), the first-401
    // proof rejection (`upgrade.proofRejected`), and a previous retry that
    // the start guard below declined (`upgrade.sessionChangedBeforeCleanup`).
    // Keeps `newSeedPhrase` from the failed attempt, re-derives a fresh proof
    // (new `signed_at` + new signature), and re-POSTs only the backend
    // cleanup call. The chain rotation already landed in `executeUpgrade`
    // and is NOT re-attempted — re-broadcasting account_update with stale
    // old-seed keys would auth-fail at the chain. On success, runs the
    // keychain-import tail and transitions to 'done' just like the happy
    // path. On 503 again, stays in the retryable error state. On a second
    // 401 (proof retry budget exhausted), terminal partialApplyFailed.
    async retryUpgradeBackend() {
      // Concurrency gate. Flip phase to 'upgrading' immediately after the
      // two guard checks, mirroring executeUpgrade's pattern. Without this,
      // two parallel invocations (rapid double-click on the Try Again button,
      // $watch re-entry from the phase write itself) both pass the guard
      // before either writes 'upgrading' and we issue two parallel
      // /api/custody/upgrade POSTs with two fresh signed proofs — same hazard
      // the executeUpgrade gate addresses at the chain-broadcast site.
      if (this.upgradePhase !== 'error') return;
      if (RETRYABILITY[this.upgradeErrorKey] !== 'retryable-backend-only') return;
      this.upgradePhase = 'upgrading';
      this.upgradeError = null;
      this.upgradeErrorKey = null;
      const newSeedPhrase = this.newSeedPhrase;
      if (!newSeedPhrase) {
        // Defensive: every sub-case that can reach this handler either
        // kept the seed or is not retryable at all, so reaching here
        // means the state machine drifted. (Not every terminal sub-case
        // wipes: backendTimeout preserves the seed precisely because the
        // user may still need it.)
        // Route to partialApplyFailed (terminal) rather than offering
        // another retry that would re-derive from an empty string. Flip
        // phase back to 'error' since the gate above moved it to 'upgrading'.
        this._clearSensitiveUpgradeState();
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.partialApplyFailed);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.partialApplyFailed;
        this.upgradePhase = 'error';
        return;
      }
      // Start guard, after the drift check above so a state that lost the
      // seed keeps its own diagnosis. Ordering them the other way would
      // re-label that drifted state as a session change, and the pin is
      // present here whenever the seed is: this handler is only reachable
      // from a post-broadcast error key, and the only writer of those keys
      // is a leg that set the pin before anything else it does. The
      // subject is read from the pin `executeUpgrade` set, never re-captured
      // here: this handler runs on a Try Again click that can arrive minutes
      // after the failure, with the error screen idling and no timeout on
      // it, so a re-capture would silently adopt whatever account a
      // cross-tab login left in the store. If the store has moved off the
      // upgrade's subject, decline before spending anything: no proof signed
      // with the new seed for the wrong account, no POST, and no attempt
      // against the proof-retry budget whose exhaustion is what wipes the
      // seed. Nothing here wipes it either: the backend cleanup has not run,
      // so the mnemonic is still the only key to an account whose on-chain
      // authorities already rotated. Because nothing was spent, the
      // sub-case this declines into is itself retryable: once the store
      // names the pinned subject again, the next Try Again passes this
      // guard and runs the cleanup, with the same outcome ladder as any
      // other backend-only retry.
      const upgradeSubject = this._upgradeSubject;
      if (this._upgradeSubjectDiverged(upgradeSubject)) {
        this._endUpgradeAsSessionChanged({ cleanupLanded: false, upgradeSubject });
        return;
      }
      // Pin the credential for this attempt, beside the subject the guard
      // above just confirmed. Same reason as the executor: the proof await
      // below is a real gap, and the store's token can be replaced inside it
      // without the account changing.
      const upgradeToken = Alpine.store('auth').token;
      try {
        const proof = await this._signUpgradeProof(upgradeSubject, newSeedPhrase);
        // No mid-flight subject check here either, for the reason spelled out
        // in `executeUpgrade`: both the proof and the bearer below were fixed
        // before this leg's first await, so letting the cleanup land is
        // strictly better for the account than stopping.
        const result = await this._postUpgradeBackend(proof, upgradeToken);
        // Post-await unmount guard before loginFromResponse. The backend
        // cleanup can take up to 20s and post-503 retry is exactly when the
        // user is most likely to navigate away. Without the guard, the
        // singleton auth store mutates for a user whose component has
        // unmounted.
        if (!this._mounted) return;
        // Same drop-the-landing rule as `executeUpgrade`: the POST window is
        // the same multi-second one, and the store may have moved to another
        // subject (or to nobody) inside it.
        if (this._upgradeSubjectDiverged(upgradeSubject)) {
          this._endUpgradeAsSessionChanged({ cleanupLanded: true, upgradeSubject });
          return;
        }
        Alpine.store('auth').loginFromResponse({
          token: result.data?.token,
          expires_at: result.data?.expires_at,
          username: upgradeSubject,
          custody: 'self',
        });
        // Re-check post-loginFromResponse for the same reason as executeUpgrade:
        // a 503 retry is exactly when users navigate away, and the
        // _completeUpgradeAfterBackend tail must not start its Keychain loop
        // on an orphaned component.
        if (!this._mounted) return;
      } catch (err) {
        // Shared helper (see executeUpgrade's catch). `broadcastLanded: true`
        // is the contract here — retryUpgradeBackend is only ever reached
        // after executeUpgrade's broadcast already landed, so every failure
        // is post-broadcast by construction.
        this._handlePostBroadcastError(err, { broadcastLanded: true, logTag: '[custody upgrade retry]' });
        return;
      }
      await this._completeUpgradeAfterBackend(upgradeSubject, newSeedPhrase);
    },

    // True when the singleton auth store no longer represents the account
    // this upgrade started for: the tab signed out, or a login from another
    // tab advanced the store (and the tab-subject marker) to a different
    // user. The disconnected arm is not redundant with the username
    // comparison — it states the rule the guard enforces, which is that a
    // store with no subject represents nobody, not that null happens to
    // compare unequal.
    //
    // Three call sites, and all three are about a STORE MUTATION rather than
    // about the upgrade's own steps: the two `loginFromResponse` landings, and
    // the retry's start guard, which is the one place the flow genuinely
    // cannot act for the pinned account, because the only credential available
    // to it there belongs to whoever the store now names. Everything in
    // between runs on values pinned before the first await and needs no
    // permission from the live store.
    //
    // The subject is an argument so the predicate compares against the same
    // value every other step of the calling leg uses, rather than re-reading a
    // field `destroy()` can null out from under an in-flight continuation. The
    // landings already return on `!_mounted` before reaching this; the start
    // guard runs synchronously, before anything can unmount.
    _upgradeSubjectDiverged(upgradeSubject) {
      const auth = Alpine.store('auth');
      return !auth.isConnected || auth.username !== upgradeSubject;
    },

    // Error route for a diverged subject. Every caller reaches it after the
    // chain rotation landed, so a fresh wizard run is structurally
    // unavailable (it would re-broadcast account_update signed with the old
    // seed's keys and the chain would reject it). `cleanupLanded` picks the
    // sub-case, and with it both the fate of the mnemonic and whether Try
    // Again stays: once the backend cleanup succeeded the phrase is written
    // down and spent, so it is wiped like every other completed path and the
    // sub-case is terminal; before that it is the user's only key to an
    // account whose authorities already rotated, so a guard that declines to
    // act must not destroy it (the backendTimeout sub-case preserves it for
    // the same reason), and the sub-case stays retryable because the decline
    // cost nothing that a re-login as the pinned subject cannot restore.
    //
    // The error copy is rendered by the settings page, which is itself bound
    // to the live store: after a sign-out, or a login as a self-custody
    // user, the surrounding sections stop rendering and the message is not
    // seen. That is the accepted cost of leaving the store alone. What the
    // unseen copy costs differs by half. The after-cleanup recovery (sign
    // in as the pinned subject with the new phrase, then import to
    // Keychain) does not depend on having read it here. The before-cleanup
    // recovery is this component's own Try Again, so it depends on the
    // re-login keeping this component mounted: the global header's sign-in
    // modal and another tab's login both do, while the signed-out body's
    // own button navigates away and takes the retry's inputs with it.
    // That is why the before-cleanup copy scopes its retry instruction to
    // this tab and this page and then carries an out-of-band fallback: the
    // one route the message can send a reader who has already left, and the
    // only instruction in it that survives an unmount.
    _endUpgradeAsSessionChanged({ cleanupLanded, upgradeSubject }) {
      // Mirrors _handlePostBroadcastError's entry guard: most callers reach
      // this after at least one await (the retry's start guard is the one
      // synchronous caller), and writing phase/error state on an unmounted
      // component is silent mutation with no observer.
      if (!this._mounted) return;
      // The subject comes from the caller's frame, not the field: the wipe
      // below clears the field, and so does `destroy()`.
      const subject = upgradeSubject;
      const key = cleanupLanded
        ? UPGRADE_ERROR_KEYS.sessionChangedAfterCleanup
        : UPGRADE_ERROR_KEYS.sessionChangedBeforeCleanup;
      if (cleanupLanded) this._clearSensitiveUpgradeState();
      this.upgradeError = this.$t(key, { username: subject });
      this.upgradeErrorKey = key;
      this.upgradePhase = 'error';
    },

    // Shared post-broadcast error router. Consumes UPGRADE_ERROR_KEYS so the
    // sub-case assignments here are the single source-of-truth — drift
    // between this helper and the const map becomes an `undefined` reference
    // at runtime, which is louder than the pre-refactor silent
    // mis-classification. The `wipe` choice is encoded per sub-case here, not
    // taken from the caller: timeout never wipes (user needs the mnemonic to
    // recover), 409/429 always wipe, proof-rejected wipes only on the SECOND
    // consecutive 401 (proof retry budget), 503 never wipes (retry needs the
    // seed). The pre-broadcast catch-all and the post-broadcast generic
    // catch-all diverge only in upgradeErrorKey ('failed' vs
    // 'partialApplyFailed') and wipe (no-op on pre vs wipe on post).
    _handlePostBroadcastError(err, { broadcastLanded, logTag }) {
      // Both callers (executeUpgrade, retryUpgradeBackend) reach this helper
      // after at least one await. If the component unmounted during that
      // suspension, abort: writing upgradeError/upgradeErrorKey/upgradePhase
      // or calling _clearSensitiveUpgradeState on a dead object is silent
      // mutation with no observer, and destroy() has already wiped state.
      if (!this._mounted) return;
      const status = err && typeof err.status === 'number' ? err.status : null;

      // Timeout. AbortSignal.timeout() in `_postUpgradeBackend` produces a
      // TimeoutError DOMException at 20s. Do NOT wipe newSeedPhrase: the
      // backend may have committed `upgraded_at` before the abort fired; the
      // user must sign out and back in to discover whether the upgrade
      // landed, and they may need their phrase if it didn't. Copy directs
      // them to that recovery path. Gate on `broadcastLanded`: a
      // pre-broadcast TimeoutError/AbortError (dhive surfacing a hung
      // connection on account_update sign) is genuinely retriable because
      // the chain has NOT rotated; it falls through to the pre-broadcast
      // `failed` catch-all below.
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError') && broadcastLanded) {
        console.warn(`${logTag} backend cleanup timeout`, err);
        // Keep the mnemonic in state so the user can copy it if needed
        // before signing out. The copy explicitly tells them to keep it safe.
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.backendTimeout);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.backendTimeout;
        this.upgradePhase = 'error';
        return;
      }

      // Post-broadcast 503: Hive RPC unavailable during backend's chain-state
      // lookup. Chain rotation landed; retry just the backend POST. State
      // preserved so `retryUpgradeBackend` can re-derive.
      if (broadcastLanded && status === 503) {
        console.warn(`${logTag} backend 503`, err);
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.backendUnavailable);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.backendUnavailable;
        this.upgradePhase = 'error';
        return;
      }

      // Post-broadcast 401: proof rejected (signature recovery fail,
      // derived_pubkey mismatch, OR signed_at outside backend's 60s
      // freshness window — the backend deliberately returns 401 uniformly
      // for these to avoid disclosure). Distinguish first 401 (likely clock
      // skew) from second 401 (proof is genuinely broken). On first 401,
      // KEEP newSeedPhrase, route to retryable `proofRejected`; on second,
      // wipe and route to terminal `partialApplyFailed`. The counter resets
      // in `resetUpgrade` so a fresh wizard run gets a fresh budget. Without
      // this split, a single clock-skew-induced 401 wipes the only retry
      // surface for the most recoverable post-broadcast failure mode.
      if (broadcastLanded && status === 401) {
        this._proofRetryAttempts += 1;
        console.warn(`${logTag} proof rejected (attempt ${this._proofRetryAttempts}/${UPGRADE_PROOF_RETRY_BUDGET})`, err);
        if (this._proofRetryAttempts >= UPGRADE_PROOF_RETRY_BUDGET) {
          // Budget exhausted — proof is genuinely broken. Wipe + terminal.
          this._clearSensitiveUpgradeState();
          this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.partialApplyFailed);
          this.upgradeErrorKey = UPGRADE_ERROR_KEYS.partialApplyFailed;
          this.upgradePhase = 'error';
          return;
        }
        // First 401: keep the seed, retryable. The user can correct their
        // system clock and click Try Again, which dispatches to
        // retryUpgradeBackend (per RETRYABILITY map).
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.proofRejected);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.proofRejected;
        this.upgradePhase = 'error';
        return;
      }

      // Post-broadcast 409 ALREADY_UPGRADED: backend cleanup already ran in
      // an earlier attempt (timed-out request that actually committed,
      // retried). Wipe and surface terminal sub-case.
      if (broadcastLanded && status === 409) {
        console.warn(`${logTag} already upgraded`, err);
        this._clearSensitiveUpgradeState();
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.alreadyUpgraded);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.alreadyUpgraded;
        this.upgradePhase = 'error';
        return;
      }

      // Post-broadcast 429: rate-limit budget exhausted. The backend's
      // `skipFailedRequests: true` limiter does not burn the slot on
      // transient failures, but a sequence of 200-status replies can still
      // hit the budget. Wipe and surface terminal copy — the user has to
      // wait the hour out.
      if (broadcastLanded && status === 429) {
        console.warn(`${logTag} rate limited`, err);
        this._clearSensitiveUpgradeState();
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.rateLimited);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.rateLimited;
        this.upgradePhase = 'error';
        return;
      }

      // Catch-all. Post-broadcast: terminal partialApplyFailed (chain
      // rotated, can't safely retry). Pre-broadcast: retryable
      // upgrade.failed. Defense in depth: zero sensitive state either way.
      this._clearSensitiveUpgradeState();
      console.warn(logTag, err);
      if (broadcastLanded) {
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.partialApplyFailed);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.partialApplyFailed;
      } else {
        this.upgradeError = this.$t(UPGRADE_ERROR_KEYS.failed);
        this.upgradeErrorKey = UPGRADE_ERROR_KEYS.failed;
      }
      this.upgradePhase = 'error';
    },

    // Best-effort Keychain import + wipe + transition to 'done'. Reached
    // from both the initial `executeUpgrade` happy path and the
    // `retryUpgradeBackend` happy path. By this point:
    //   - account_update has landed on-chain
    //   - backend custody cleanup succeeded
    // Per-role failures inside `_performKeychainImport` push a localized
    // warning string and never re-throw; if the helper itself throws
    // before the loop runs (dynamic dhive import, deriveHiveKeys), the
    // outer try/catch ensures the wipe + 'done' transition still happen
    // — without it, the mnemonic would stay in Alpine reactive state
    // (XSS surface) and upgradePhase would stick at 'upgrading' (no
    // recovery UI). Failures surface as a single fallback warning on
    // the 'done' screen.
    async _completeUpgradeAfterBackend(upgradeSubject, newSeedPhrase) {
      try {
        await this._performKeychainImport(upgradeSubject, newSeedPhrase);
      } catch (err) {
        console.warn('[custody upgrade] keychain helper threw', err);
        // Skip the user-visible warning on unmount: the warnings array is
        // bound to a component that no longer renders, and destroy() will
        // wipe sensitive state. The warning would be a write to an
        // orphaned object with no observer.
        if (this._mounted) {
          this.upgradeWarnings.push(this.$t('upgrade.keychainImportFailed'));
        }
      } finally {
        // Credential wipe: zero all sensitive reactive state on
        // the happy path (success or partial-keychain-import) before
        // flipping to 'done'. Without this, the old and new 12-word
        // mnemonics sit in Alpine's reactive data indefinitely; any XSS
        // on /settings can read them via `window.Alpine.$data(el).oldSeedPhrase`
        // etc. Guarded on _mounted: destroy() already wipes sensitive state
        // on unmount via the explicit cleanup signal (see destroy() below);
        // writing upgradePhase='done' on an orphaned component is silent
        // mutation with no observer.
        if (this._mounted) {
          this._clearSensitiveUpgradeState();
          this.upgradePhase = 'done';
        }
      }
    },

    // Closure-wipe: derive + sign the upgrade proof inside its
    // own frame so the private key never escapes. Returns only scalars
    // (the public key, the hex signature, the ISO timestamp). Used both
    // by `executeUpgrade` immediately after the chain rotation and by
    // `retryUpgradeBackend` on a fresh attempt against the already-rotated
    // chain state. The proof binds the JWT-authenticated session to a
    // pubkey that appears in the on-chain account's key_auths (the
    // backend independently verifies both the signature recovery and the
    // on-chain presence) — see `agents/docs/api-contracts/custody.md`
    // POST /api/custody/upgrade and `backend/src/routes/custody.ts`
    // `buildCustodyUpgradeChallenge`. Signs with the `active` role: the
    // strongest single-key authority that doesn't expose owner rotation
    // capacity.
    //
    // The account name is an argument, not a live store read: the backend
    // rebuilds the challenge from the JWT subject, so a name that drifted
    // across this helper's own awaits yields a proof that cannot verify, and
    // the key it derives would be the wrong account's besides.
    async _signUpgradeProof(upgradeSubject, newSeedPhrase) {
      const dhive = await loadDhive();
      const newKeys = await deriveHiveKeys(newSeedPhrase, upgradeSubject);
      const privateKey = dhive.PrivateKey.fromString(newKeys.active);
      const derivedPubkey = privateKey.createPublic().toString();
      const signedAt = new Date().toISOString();
      // Advisory-only fallback: no `GET /api/time` endpoint exists yet, so we
      // cannot fetch a server-time reference to abort on clock skew before
      // signing. The full fix (pre-broadcast abort on |client - server| >
      // UPGRADE_CLOCK_SKEW_WARN_MS) requires a backend endpoint. Until then,
      // log the generation timestamp as advisory: ops can correlate this
      // with backend's signed_at-rejected 401 to confirm clock skew is the
      // cause when a user reports a failed upgrade.
      console.warn(`[custody upgrade] signing proof at signed_at=${signedAt} (client clock; no server-time reference available to validate skew, threshold ${UPGRADE_CLOCK_SKEW_WARN_MS}ms when backend GET /api/time lands)`);
      const challenge = `${getAppTag()}-custody-upgrade|v1|${upgradeSubject}|${signedAt}`;
      const msgHash = dhive.cryptoUtils.sha256(challenge);
      const signedProof = privateKey.sign(msgHash).toString();
      // Intentionally returns scalars only. Do NOT return `privateKey`,
      // `newKeys`, or anything else that would re-escape derived material
      // into the caller's frame.
      return { derived_pubkey: derivedPubkey, signed_proof: signedProof, signed_at: signedAt };
    },

    // POST the proof to /api/custody/upgrade. Throws an Error with
    // `.status` and `.code` attached on non-2xx responses so the caller's
    // catch can branch on status (503 retryable, 409/429 terminal-sub-case,
    // rest terminal). 20s budget guards against a hung backend after the
    // on-chain rotation; TimeoutError DOMException surfaces via err.name
    // in the caller's catch.
    //
    // The bearer is an argument rather than a store read at fetch time. It is
    // what binds the request to an account server-side, and both callers are
    // several awaits deep by the time they get here; a live read would send
    // whatever credential the store holds at that moment, which after a
    // cross-tab login is another user's.
    async _postUpgradeBackend(proof, upgradeToken) {
      const res = await fetch('/api/custody/upgrade', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${upgradeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(proof),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error('Upgrade backend rejected');
        err.status = res.status;
        err.code = body?.error?.code ?? null;
        throw err;
      }
      return res.json();
    },

    // Closure-wipe: narrower-scoped key-material handler.
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
    // Arguments are passed by value (`upgradeSubject`, `oldWords` and
    // `newSeedPhrase` are all strings — Alpine reactive fields and the
    // store-backed username getter resolve to primitive strings before being
    // passed in, so no observer reference leaks through). The account name is
    // an argument rather than a live `this.username` read for a second
    // reason: it salts both derivations and names the account the
    // `account_update` rotates, and this method runs behind the flow's first
    // dynamic import, so a live read here could name whoever a cross-tab
    // login left in the store.
    async _performUpgradeKeyRotation(upgradeSubject, oldWords, newSeedPhrase) {
      // Derive keys from old and new seed phrases
      const dhive = await loadDhive();
      const oldKeys = await deriveHiveKeys(oldWords, upgradeSubject);
      const newKeys = await deriveHiveKeys(newSeedPhrase, upgradeSubject);
      const newPubKeys = await deriveHivePublicKeys(newKeys);

      // Broadcast account_update signed with old owner key
      const client = new dhive.Client(['https://api.hive.blog']);

      const ownerKey = dhive.PrivateKey.fromString(oldKeys.owner);
      const op = {
        account: upgradeSubject,
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
    // The account to import under is an argument. This loop holds the
    // widest suspension in the flow — up to 45 seconds per role while a
    // popup waits on the user, three times — and it names its target once
    // per iteration, so a live read could file the second and third keys
    // under an account that logged in from another tab mid-loop. The import
    // is a local convenience for the account that was just upgraded, so it
    // stays bound to that account for every role regardless of what the tab's
    // session does meanwhile.
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
    async _performKeychainImport(upgradeSubject, newSeedPhrase) {
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
      const newKeys = await deriveHiveKeys(newSeedPhrase, upgradeSubject);
      // Unmount check before the loop: deriveHiveKeys is async (calls
      // PrivateKey.fromLogin per role), so the user may have navigated
      // away during derivation. Returning here means no Keychain popups
      // fire on a navigated-away component.
      if (!this._mounted) return;
      const importRoles = ['posting', 'active', 'memo'];
      for (const role of importRoles) {
        // Per-iteration unmount check. The previous iteration's
        // requestImportKey awaited 0-45s (popup display + user click or
        // timeout); if the user navigated away during that window,
        // skipping the remaining roles prevents fresh popups from
        // appearing on the navigated-away page. The popup for the
        // already-in-flight iteration cannot be aborted — there is no
        // cancel API in window.hive_keychain. The user will see one
        // residual popup at most per navigate-away.
        if (!this._mounted) return;
        const wif = newKeys[role];
        try {
          // Promise.race against a 45s timeout: the Hive Keychain extension
          // does not guarantee its callback fires if the popup is dismissed
          // via the extension UI, the content script wedges, or the
          // extension is uninstalled mid-flow. Without the race, a hung
          // callback leaves the `await` permanently pending, the for-loop
          // stalls, the call site's `finally` never runs, and the user is
          // wedged: chain rotated + backend cleaned + mnemonic still in
          // reactive state + upgradePhase stuck at 'upgrading'. The race
          // converts a hang into a normal per-role rejection that the
          // existing catch surfaces as a warning, and the loop proceeds.
          const importPromise = new Promise((resolve, reject) => {
            window.hive_keychain.requestImportKey(
              upgradeSubject, wif,
              (res) => res.success ? resolve(res) : reject(new Error(res.message || 'Keychain import failed'))
            );
          });
          // Capture the timer id so we can clear it after the race
          // resolves. Without `clearTimeout`, a successful (or denied)
          // import leaves the 45s timer + its closure live until the timer
          // fires, then the race's now-settled internal reject path
          // silently swallows the rejection. 45s × 3 roles = ~135s of
          // orphan timers per successful upgrade. Cleanliness/resource
          // concern only.
          let timerId;
          const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(
              () => reject(new Error('keychain timeout')),
              45_000,
            );
          });
          try {
            await Promise.race([importPromise, timeoutPromise]);
          } finally {
            clearTimeout(timerId);
          }
        } catch (err) {
          // Per-role failure becomes a warning, not a fatal error. The
          // loop continues to the next role so a denial on (e.g.) active
          // doesn't block the memo import.
          // Sanitization pattern: raw err to console.warn for diagnostics,
          // localized message to user-visible warnings array.
          // Both denial and timeout funnel through here; the user's
          // recovery action is the same either way (re-import the
          // account into the Keychain extension using the seed phrase),
          // so we reuse the per-role keychainImportWarning keys for both
          // paths rather than introducing a separate
          // keychainImportTimeout family.
          console.warn(`[custody upgrade] keychain import ${role}`, err);
          // Skip the user-visible warning on unmount: the catch may fire
          // on an orphaned `this` if the user navigated away during the
          // 45s race. The next iteration's _mounted check will exit the
          // loop, but the warning write would still land on the dead
          // component.
          if (this._mounted) {
            const key = `upgrade.keychainImportWarning.${role}`;
            this.upgradeWarnings.push(this.$t(key));
          }
        }
      }
    },

    // Zero the plaintext-sensitive fields used during the custody upgrade
    // flow: the old mnemonic the user typed, the freshly-generated new
    // mnemonic (both as a string and as the words array used for the
    // confirmation step), and the confirmation inputs. Callers that also
    // need to reset phase/error should use `resetUpgrade()` instead.
    //
    // Closure-wipe: this helper zeros REACTIVE (Alpine `this.*`)
    // fields only. Closure-captured `const` bindings that held derived key
    // material during the broadcast/import/proof-signing step live inside
    // `_performUpgradeKeyRotation()` / `_performKeychainImport()` /
    // `_signUpgradeProof()` and are dropped when that method's frame
    // pops, BEFORE this helper runs. See the big comment block on
    // `_performUpgradeKeyRotation()`.
    _clearSensitiveUpgradeState() {
      this.oldSeedPhrase = '';
      this.newSeedPhrase = '';
      this.newSeedWords = [];
      this.confirmInputs = {};
      // upgradePassword is the user's light-account password held in
      // reactive state during the upgrade wizard (re-auth proof input).
      // It is just as sensitive as the mnemonic: leaking it from Alpine's
      // reactive data after a completed or failed upgrade is the same XSS
      // surface as leaking the seed phrase, just for a different
      // credential. Wipe alongside the mnemonics.
      this.upgradePassword = '';
      // Not sensitive on its own — a username, not a secret. It is cleared
      // here so its lifetime is exactly the seed's: the pin exists to serve
      // the steps that still have work to do, and every site that decides
      // there is no work left calls this helper.
      this._upgradeSubject = null;
    },

    resetUpgrade() {
      this._clearSensitiveUpgradeState();
      this.upgradePhase = 'idle';
      this.upgradeError = null;
      this.upgradeErrorKey = null;
      this.upgradeWarnings = [];
      // Fresh wizard run starts a fresh proof-retry budget. Without this
      // reset, a user who hit the 401-budget on a prior attempt, resolved
      // their clock, and re-started the wizard would land back in the
      // post-broadcast catch with `_proofRetryAttempts === 2` already and
      // wipe on the FIRST 401 of the new attempt.
      this._proofRetryAttempts = 0;
    },

    navigate(path) {
      Alpine.store('router').navigate(path);
    },
  }));
}
