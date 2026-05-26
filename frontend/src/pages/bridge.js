import Alpine from 'alpinejs';
import { fetchBridgeLookup, fetchBridgeCheck, registerBridgePaper } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { formatEta } from '../lib/format-eta.js';

const DISCIPLINE_TAXONOMY = [
  { field: 'Natural Sciences', subfields: ['Mathematics', 'Computer Science', 'Physics', 'Chemistry', 'Earth Sciences', 'Biology', 'Astronomy'] },
  { field: 'Engineering and Technology', subfields: ['Civil Engineering', 'Electrical Engineering', 'Mechanical Engineering', 'Chemical Engineering', 'Materials Engineering', 'Biomedical Engineering', 'Environmental Engineering'] },
  { field: 'Medical and Health Sciences', subfields: ['Basic Medicine', 'Clinical Medicine', 'Health Sciences', 'Neuroscience', 'Pharmacology'] },
  { field: 'Agricultural and Veterinary Sciences', subfields: ['Agriculture', 'Animal Science', 'Veterinary Science', 'Forestry'] },
  { field: 'Social Sciences', subfields: ['Psychology', 'Economics', 'Education', 'Sociology', 'Law', 'Political Science', 'Geography'] },
  { field: 'Humanities and Arts', subfields: ['History', 'Philosophy', 'Languages and Literature', 'Arts', 'Theology'] },
];

const template = `
      <div x-data="bridgePage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink font-serif mb-2" x-text="$t('bridge.title')"></h1>
        <p class="text-ink-muted mb-6" x-text="$t('bridge.description')"></p>

        <!-- Not connected warning -->
        <template x-if="!isConnected">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('bridge.signInHint')"></p>
                <button class="btn-primary text-xs mt-2" @click="handleConnect()" x-text="$t('signIn.signInButton')"></button>
              </div>
            </div>
          </div>
        </template>

        <!-- Not accredited warning -->
        <template x-if="isConnected && !isAccredited">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('publish.accreditationRequired')"></p>
                <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary text-xs mt-2 no-underline inline-block" x-text="$t('common.getAccredited')"></a>
              </div>
            </div>
          </div>
        </template>

          <div>
            <!-- Step 1: Identifier input -->
            <div class="card mb-6">
              <label for="bridge-id" class="block text-sm font-semibold text-ink mb-2" x-text="$t('bridge.identifierLabel')"></label>
              <div class="flex gap-3">
                <input id="bridge-id" type="text" class="select-control flex-1" :placeholder="$t('bridge.identifierPlaceholder')"
                       x-model="identifier" @keydown.enter="handleLookup()" :disabled="lookingUp || step === 'registering'" />
                <button class="btn-primary text-sm whitespace-nowrap" @click="handleLookup()" :disabled="lookingUp || !identifier.trim() || step === 'registering'"
                        x-text="lookingUp ? $t('bridge.lookingUp') : $t('bridge.lookupButton')"></button>
              </div>
              <template x-if="lookupError">
                <p class="text-sm text-pevo-crimson mt-2" x-text="lookupError"></p>
              </template>
            </div>

            <!-- Step 2: Preview -->
            <template x-if="lookup">
              <div class="card mb-6">
                <h2 class="text-lg font-semibold text-ink mb-4" x-text="$t('bridge.previewTitle')"></h2>
                <h3 class="text-base font-semibold text-ink mb-2" x-text="lookup.title"></h3>
                <div class="text-sm text-ink-light mb-3">
                  <span class="font-medium text-ink-muted" x-text="$t('bridge.authors') + ':'"></span>
                  <span x-text="lookup.authors.map(a => a.name).join(', ')"></span>
                </div>
                <div class="text-sm text-ink-muted mb-3 line-clamp-4">
                  <span class="font-medium" x-text="$t('bridge.abstract') + ':'"></span>
                  <span x-text="lookup.abstract"></span>
                </div>
                <div class="flex flex-wrap gap-4 text-sm text-ink-muted mb-3">
                  <span>
                    <span class="font-medium" x-text="$t('bridge.published') + ':'"></span>
                    <span x-text="new Date(lookup.published_date).toLocaleDateString()"></span>
                  </span>
                  <span>
                    <span class="font-medium" x-text="$t('bridge.source') + ':'"></span>
                    <a :href="lookup.source_url" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline" x-text="lookup.source_name"></a>
                  </span>
                  <template x-if="lookup.pdf_url">
                    <a :href="lookup.pdf_url" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline" x-text="$t('bridge.pdfLink')"></a>
                  </template>
                </div>
                <!-- Duplicate warning -->
                <template x-if="isDuplicate && check">
                  <div class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 mt-4">
                    <p class="text-sm font-medium text-amber-800 mb-1" x-text="$t('bridge.duplicateWarning')"></p>
                    <a :href="$lp('/paper/' + check.author + '/' + check.permlink)" @click.prevent="navigate('/paper/' + check.author + '/' + check.permlink)" class="text-sm text-pevo-teal hover:underline" x-text="$t('bridge.viewExisting')"></a>
                  </div>
                </template>
              </div>
            </template>

            <!-- Step 3: Registration form -->
            <template x-if="lookup && !isDuplicate">
              <div class="card">
                <h2 class="text-lg font-semibold text-ink mb-4" x-text="$t('bridge.registerTitle')"></h2>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <!-- Discipline picker -->
                  <div class="relative" @click.outside="disciplineDropdownOpen = false">
                    <label for="bridge-discipline" class="block text-sm font-semibold text-ink mb-2" x-text="$t('bridge.disciplineLabel')"></label>
                    <input id="bridge-discipline" type="text" class="select-control" :placeholder="$t('bridge.disciplinePlaceholder')"
                           :value="disciplineDisplayValue" @input="onDisciplineInput($event)" @focus="disciplineDropdownOpen = true" autocomplete="off" required />
                    <template x-if="discipline && !disciplineDropdownOpen">
                      <button type="button" class="absolute right-2 top-9 text-ink-muted hover:text-ink" @click="clearDiscipline()">
                        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                      </button>
                    </template>
                    <div x-show="disciplineDropdownOpen" class="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-parchment-dark bg-parchment shadow-md">
                      <template x-if="filteredTaxonomy.length === 0 && disciplineSearch.trim()">
                        <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors"
                                @click="selectDiscipline(disciplineSearch.trim())">
                          <span x-text="$t('bridge.useCustomDiscipline', { value: disciplineSearch.trim() })"></span>
                        </button>
                      </template>
                      <template x-for="group in filteredTaxonomy" :key="group.field">
                        <div>
                          <div class="px-4 py-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide bg-parchment-warm" x-text="group.field"></div>
                          <template x-for="sf in group.subfields" :key="sf">
                            <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors" x-text="sf" @click="selectDiscipline(sf)"></button>
                          </template>
                        </div>
                      </template>
                      <template x-if="filteredTaxonomy.length > 0 && disciplineSearch.trim() && !filteredTaxonomy.some(g => g.subfields.some(sf => sf.toLowerCase() === disciplineSearch.trim().toLowerCase()))">
                        <div class="border-t border-parchment-dark">
                          <button type="button" class="block w-full text-left px-4 py-2 text-sm text-pevo-teal-dark hover:bg-parchment-warm transition-colors"
                                  @click="selectDiscipline(disciplineSearch.trim())">
                            <span x-text="$t('bridge.useCustomDiscipline', { value: disciplineSearch.trim() })"></span>
                          </button>
                        </div>
                      </template>
                    </div>
                  </div>
                  <!-- Keywords -->
                  <div>
                    <label for="bridge-keywords" class="block text-sm font-semibold text-ink mb-2" x-text="$t('bridge.keywordsLabel')"></label>
                    <input id="bridge-keywords" type="text" class="select-control" :placeholder="$t('bridge.keywordsPlaceholder')" x-model="keywordsText" />
                  </div>
                </div>
                <!-- Language -->
                <div class="mb-6">
                  <label for="bridge-language" class="block text-sm font-semibold text-ink mb-2" x-text="$t('bridge.languageLabel')"></label>
                  <input id="bridge-language" type="text" class="select-control max-w-xs" :placeholder="$t('bridge.languagePlaceholder')" x-model="language" />
                </div>
                <!-- Status / Submit -->
                <template x-if="step === 'idle' && isAccredited">
                  <button class="btn-primary" @click="handleRegister()" :disabled="!canRegister" x-text="$t('bridge.registerButton')"></button>
                </template>
                <template x-if="step === 'idle' && !isAccredited && !isConnected">
                  <a :href="$lp('/getting-started')" @click.prevent="navigate('/getting-started')" class="btn-primary inline-block text-center no-underline" x-text="$t('bridge.registerButton')"></a>
                </template>
                <template x-if="step === 'idle' && !isAccredited && isConnected">
                  <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary inline-block text-center no-underline" x-text="$t('common.getAccredited')"></a>
                </template>
                <template x-if="step === 'registering'">
                  <p class="text-sm text-ink-muted" x-text="$t('bridge.stepRegistering')"></p>
                </template>
                <!-- Queued (HTTP 202): the import was accepted into the publish
                     queue and will be broadcast on a later worker tick. Distinct
                     from the prior synchronous-success state — the paper does not
                     exist on chain yet, so we surface queue position + ETA and
                     point at My imports instead of redirecting to a paper page. -->
                <template x-if="step === 'queued'">
                  <div class="rounded-lg border border-pevo-teal/40 bg-pevo-teal-light px-4 py-3">
                    <p class="text-sm font-semibold text-pevo-teal-dark mb-1" x-text="$t('bridge.queuedTitle')"></p>
                    <p class="text-sm text-ink-muted mb-2" x-text="queuedDetailText"></p>
                    <a :href="$lp('/my-imports')" @click.prevent="navigate('/my-imports')"
                       class="text-sm text-pevo-teal hover:underline" x-text="$t('bridge.queuedViewMyImports')"></a>
                  </div>
                </template>
                <!-- Per-user in-flight cap (HTTP 429 RATE_LIMITED with
                     details.cap): the caller already holds the max number of
                     pending/in-progress imports. Worded as a usage-limit
                     remediation hint, deliberately NOT styled like the transient
                     chain-error path below — submission resumes once one of the
                     in-flight imports completes. -->
                <template x-if="step === 'userCap'">
                  <div class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                    <p class="text-sm font-medium text-amber-800 mb-1" x-text="$t('bridge.userCapTitle')"></p>
                    <p class="text-sm text-amber-800 mb-2" x-text="userCapMessageText"></p>
                    <a :href="$lp('/my-imports')" @click.prevent="navigate('/my-imports')"
                       class="text-sm text-pevo-teal hover:underline" x-text="$t('myImports.navLabel')"></a>
                  </div>
                </template>
                <template x-if="step === 'error' && duplicateExisting">
                  <div class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                    <p class="text-sm font-medium text-amber-800 mb-1" x-text="$t('bridge.duplicateWarning')"></p>
                    <a :href="$lp('/paper/' + duplicateExisting.author + '/' + duplicateExisting.permlink)"
                       @click.prevent="navigate('/paper/' + duplicateExisting.author + '/' + duplicateExisting.permlink)"
                       class="text-sm text-pevo-teal hover:underline" x-text="$t('bridge.viewExisting')"></a>
                  </div>
                </template>
                <template x-if="step === 'error' && !duplicateExisting">
                  <div>
                    <p class="text-sm text-pevo-crimson mb-2" x-text="errorMessage"></p>
                    <button class="btn-secondary text-sm" @click="resetRegisterError()" x-text="$t('common.tryAgain')"></button>
                  </div>
                </template>
              </div>
            </template>
          </div>
      </div>
`;

export { template as bridgePageTemplate };

export function initBridgePage() {
  Alpine.data('bridgePage', () => ({
    // Post-teardown setTimeout guard. See frontend/src/lib/timer-guard.js.
    ...createTimerGuard(),

    identifier: '',
    lookingUp: false,
    lookupError: '',
    lookup: null,
    check: null,

    discipline: '',
    disciplineSearch: '',
    disciplineDropdownOpen: false,
    keywordsText: '',
    language: '',

    // step transitions: idle → registering → {queued | userCap | error | idle-on-success-redirect}
    // 'queued' is the async-enqueue success state (HTTP 202). 'userCap' is the
    // per-user in-flight cap rejection (429 RATE_LIMITED with details.cap).
    step: 'idle',
    errorMessage: '',
    // When step === 'error' and the failure was a DUPLICATE 409 from /register,
    // this holds {author, permlink} of the pre-existing paper so the template
    // renders a link to it (in lieu of the generic "Try again" button). Stays
    // null on every other error path, including LOCK_HELD-after-retry.
    duplicateExisting: null,
    // Populated on a successful 202 enqueue, read by the `queued` template.
    queuedPosition: null,
    queuedEtaSeconds: null,
    // Populated on the per-user-cap rejection, read by the `userCap` template.
    userCapInflight: null,

    navigate(path) { Alpine.store('router').navigate(path); },

    destroy() {
      this._teardownTimers();
    },

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },

    get filteredTaxonomy() {
      if (!this.disciplineSearch.trim()) return DISCIPLINE_TAXONOMY;
      const q = this.disciplineSearch.toLowerCase();
      return DISCIPLINE_TAXONOMY
        .map((group) => ({
          ...group,
          subfields: group.subfields.filter((sf) => sf.toLowerCase().includes(q)),
        }))
        .filter((group) => group.subfields.length > 0);
    },

    get isDuplicate() { return this.check?.exists === true; },

    get canRegister() {
      return this.lookup && !this.isDuplicate && this.discipline && this.step === 'idle';
    },

    // Queued-state copy. When the backend supplied a usable ETA estimate we
    // render position + ETA; when eta_seconds is missing/unknown we fall back
    // to position-only rather than show a bogus "in 0 min".
    get queuedDetailText() {
      const position = this.queuedPosition ?? 1;
      const eta = this.queuedEtaSeconds;
      if (eta === null || eta === undefined || !Number.isFinite(eta)) {
        return this.$t('bridge.queuedPositionOnly', { position });
      }
      return this.$t('bridge.queuedPositionAndEta', { position, eta: formatEta(eta, this.$t.bind(this)) });
    },

    get userCapMessageText() {
      return this.$t('bridge.userCapMessage', { pending: this.userCapInflight ?? '' });
    },

    get disciplineDisplayValue() {
      return this.disciplineDropdownOpen ? this.disciplineSearch : (this.discipline || this.disciplineSearch);
    },

    selectDiscipline(sf) {
      this.discipline = sf;
      this.disciplineSearch = sf;
      this.disciplineDropdownOpen = false;
    },

    clearDiscipline() {
      this.discipline = '';
      this.disciplineSearch = '';
    },

    // Reset to the pre-submit state after a register failure. The template's
    // generic "Try again" button calls this; it must clear `duplicateExisting`
    // alongside `step` so a subsequent error path that lands without a
    // DUPLICATE discriminator does not inherit a stale link-block from the
    // prior attempt.
    resetRegisterError() {
      this.step = 'idle';
      this.errorMessage = '';
      this.duplicateExisting = null;
      this.queuedPosition = null;
      this.queuedEtaSeconds = null;
      this.userCapInflight = null;
    },

    onDisciplineInput(e) {
      this.disciplineSearch = e.target.value;
      this.discipline = e.target.value.trim();
      this.disciplineDropdownOpen = true;
    },

    prefillDiscipline(lookup) {
      if (!lookup) return;
      // Prefer explicit subjects from the source API
      if (lookup.subjects && lookup.subjects.length > 0) {
        this.selectDiscipline(lookup.subjects[0]);
        return;
      }
      // Fall back to journal/source name (strip common prefixes)
      if (lookup.source_name) {
        const name = lookup.source_name
          .replace(/^frontiers\s+in\s+/i, '')
          .replace(/^journal\s+of\s+(the\s+)?/i, '')
          .replace(/^proceedings\s+of\s+(the\s+)?/i, '');
        if (name.length > 0 && name.length < 60) {
          this.selectDiscipline(name.charAt(0).toUpperCase() + name.slice(1));
        }
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        if (!this._mounted) return;
        console.warn('[bridge connect]', err);
        Alpine.store('toast').show(this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleLookup() {
      if (!this.identifier.trim()) return;
      // Defense-in-depth alongside the template :disabled gate. handleLookup
      // resets `step` and `duplicateExisting` at entry, which would mask an
      // in-flight register broadcast — the broadcast snapshot already
      // captured the original identifier, so a mid-flight lookup against a
      // different identifier creates a wrong-paper landing on redirect.
      if (this.step === 'registering') return;
      this.lookingUp = true;
      this.lookupError = '';
      this.lookup = null;
      this.check = null;
      // Clear post-DUPLICATE residue: stale `duplicateExisting` from a prior
      // failed register on identifier A must not point at A's existing paper
      // once the user kicks off a new lookup for identifier B. `step` and
      // `errorMessage` reset for the same reason — keep the error UI from
      // leaking across lookups.
      this.step = 'idle';
      this.errorMessage = '';
      this.duplicateExisting = null;
      this.queuedPosition = null;
      this.queuedEtaSeconds = null;
      this.userCapInflight = null;
      try {
        const [lookupRes, checkRes] = await Promise.all([
          fetchBridgeLookup(this.identifier.trim()),
          fetchBridgeCheck(this.identifier.trim()),
        ]);
        if (!this._mounted) return;
        this.lookup = lookupRes.data;
        this.check = checkRes.data;
        this.prefillDiscipline(this.lookup);
      } catch (err) {
        if (!this._mounted) return;
        const code = err.code || '';
        this.lookupError = code === 'INTERNAL_ERROR' ? this.$t('bridge.lookupUnavailable') : this.$t('bridge.lookupFailed');
      } finally {
        if (this._mounted) this.lookingUp = false;
      }
    },

    async handleRegister() {
      if (!this.username || !this.discipline) return;

      // 409 LOCK_HELD on /api/bridge/register means a concurrent registration
      // of the same preprint holds the Redis lock (35s TTL on the backend).
      // We auto-retry transparently with short backoffs so users on the
      // losing side of a benign race don't see an error UI for a condition
      // that self-clears in seconds. Budget kept small (~7s wall-time) so
      // the user isn't stuck waiting if the lock outlasts the budget; on
      // exhaust we surface bridge.lockHeldRetry with the manual "Try again"
      // path. The analogous transparent-retry pattern is in paper-detail.js
      // loadPaper() for SERVICE_UNAVAILABLE with details.retriable.
      const lockHeldRetryDelaysMs = [1500, 2500, 3500];
      let lockHeldAttempt = 0;

      this.step = 'registering';
      this.duplicateExisting = null;
      this.errorMessage = '';
      this.queuedPosition = null;
      this.queuedEtaSeconds = null;
      this.userCapInflight = null;
      const keywords = this.keywordsText.split(',').map((k) => k.trim()).filter(Boolean);
      const payload = {
        identifier: this.identifier.trim(),
        discipline: this.discipline,
        keywords: keywords.length > 0 ? keywords : undefined,
        language: this.language.trim() || undefined,
      };

      while (true) {
        try {
          const res = await registerBridgePaper(payload);
          if (!this._mounted) return;
          // Async enqueue: a successful /register returns HTTP 202 with the
          // pending queue entry, its 1-based queue_position, and a best-effort
          // eta_seconds. The paper is NOT on chain yet, so we render the queued
          // state (position + ETA) inline and point at My imports rather than
          // redirecting to a paper page that does not exist. The terminal
          // outcome surfaces on the My imports surface (GET /api/bridge/imports).
          const data = res.data || {};
          this.queuedPosition = data.queue_position ?? null;
          this.queuedEtaSeconds = data.eta_seconds ?? null;
          this.step = 'queued';
          Alpine.store('toast').show(this.$t('bridge.queuedTitle'), 'success');
          return;
        } catch (err) {
          if (!this._mounted) return;
          if (err.code === 'LOCK_HELD' && lockHeldAttempt < lockHeldRetryDelaysMs.length) {
            await this._sleep(lockHeldRetryDelaysMs[lockHeldAttempt]);
            if (!this._mounted) return;
            lockHeldAttempt++;
            continue;
          }
          // Per-user in-flight cap: RATE_LIMITED (429) carrying details.cap is
          // the cap rejection (vs. the per-IP limiter, which shares the code
          // but omits details.cap). Render the cap-specific remediation surface
          // — distinct from the transient chain-error path — telling the user
          // submission resumes once one in-flight import completes. Returns
          // before console.warn: a usage-cap hit is expected operation, not an
          // error worth log noise.
          if (err.code === 'RATE_LIMITED' && err.details?.cap !== undefined) {
            this.userCapInflight = err.details.inflight ?? err.details.cap;
            this.step = 'userCap';
            return;
          }
          this.step = 'error';
          if (err.code === 'LOCK_HELD') {
            // Retry budget exhausted; expose the manual-retry path via the
            // generic "Try again" button while keeping the LOCK_HELD-specific
            // copy. Returns BEFORE console.warn — routine contention isn't
            // worth log noise.
            this.errorMessage = this.$t('bridge.lockHeldRetry');
            return;
          }
          if (err.code === 'DUPLICATE') {
            // Race condition: /api/bridge/check returned exists:false at
            // preview time, but another user landed a /register broadcast
            // for the same canonical permlink between preview and submit.
            // Surface the existing paper via err.details per
            // agents/docs/api-contracts/bridge.md, suppress the "Try again"
            // affordance, and let the user navigate to the existing paper.
            const author = err.details?.existing_author || null;
            const permlink = err.details?.existing_permlink || null;
            if (author && permlink) {
              this.duplicateExisting = { author, permlink };
              this.errorMessage = '';
              return;
            }
            // Backend omitted the discriminator fields — fall through to
            // the generic message rather than rendering a broken link.
          }
          console.warn('[bridge register]', err);
          this.errorMessage = this.$t('common.registrationFailed');
          return;
        }
      }
    },
  }));
}
