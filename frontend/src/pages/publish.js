import Alpine from 'alpinejs';
import { uploadToIpfs, fetchDisciplines } from '../api.js';
import { broadcastOps } from '../signer.js';
import { sha256File, slugify } from '../crypto.js';
import { createTimerGuard } from '../lib/timer-guard.js';

import { getAppTag, getAppId, getMaxUploadSize, getMaxUploadSizeMB } from '../config.js';

const DRAFT_KEY = 'pevo-draft-publish';
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
const ABSTRACT_MAX_CHARS = 2000;
const TX_WARN_BYTES = 55000;
const TX_HARD_BYTES = 60000;

// Discipline taxonomy (loaded from API or hardcoded fallback)
const DISCIPLINE_TAXONOMY = [
  { field: 'Natural Sciences', subfields: ['Mathematics', 'Computer Science', 'Physics', 'Chemistry', 'Earth Sciences', 'Biology', 'Astronomy'] },
  { field: 'Engineering and Technology', subfields: ['Civil Engineering', 'Electrical Engineering', 'Mechanical Engineering', 'Chemical Engineering', 'Materials Engineering', 'Biomedical Engineering', 'Environmental Engineering'] },
  { field: 'Medical and Health Sciences', subfields: ['Basic Medicine', 'Clinical Medicine', 'Health Sciences', 'Neuroscience', 'Pharmacology'] },
  { field: 'Agricultural and Veterinary Sciences', subfields: ['Agriculture', 'Animal Science', 'Veterinary Science', 'Forestry'] },
  { field: 'Social Sciences', subfields: ['Psychology', 'Economics', 'Education', 'Sociology', 'Law', 'Political Science', 'Geography'] },
  { field: 'Humanities and Arts', subfields: ['History', 'Philosophy', 'Languages and Literature', 'Arts', 'Theology'] },
];


function relativeTime(timestamp, t) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesLong', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursLong', { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.yesterday');
  return t('time.daysLong', { count: days });
}

function composePostBody(abstract, fullText) {
  if (!fullText) return '## Abstract\n\n' + abstract;
  return '## Abstract\n\n' + abstract + '\n\n---\n\n' + fullText;
}

function estimateTxBytes(title, postBody, metadataJson) {
  const encoder = new TextEncoder();
  return encoder.encode(title).length + encoder.encode(postBody).length + encoder.encode(metadataJson).length + 500;
}

const template = `
      <div x-data="publishPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('publish.title')"></h1>
        <p class="text-ink-muted mb-8" x-text="$t('publish.description')"></p>

        <!-- Draft restored banner -->
        <template x-if="draftRestored && draftSavedAt">
          <div class="card bg-pevo-teal-light border-pevo-teal/30 mb-6">
            <div class="flex items-center justify-between">
              <p class="text-sm text-ink" x-text="$t('publish.draftRestored', { time: draftTimeAgo() })"></p>
              <button type="button" class="text-sm font-medium text-pevo-teal hover:text-pevo-teal-dark" @click="discardDraft()" x-text="$t('common.discard')"></button>
            </div>
          </div>
        </template>

        <!-- Not connected warning -->
        <template x-if="!isConnected">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('signIn.signInToPublish')"></p>
                <p class="text-xs text-ink-muted mt-1" x-text="$t('publish.signInHint')"></p>
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

        <!-- Progress indicator -->
        <template x-if="step !== 'idle'">
          <div class="card mb-6" :class="stepClass">
            <p class="text-sm font-medium" x-text="stepMessage"></p>
            <template x-if="step === 'error'">
              <button class="btn-secondary text-xs mt-2" @click="step = 'idle'" x-text="$t('common.tryAgain')"></button>
            </template>
          </div>
        </template>

        <form @submit.prevent="isAccredited ? handleSubmit() : null" class="space-y-6">
          <!-- Title -->
          <div class="card">
            <label for="paper-title" class="block text-sm font-semibold text-ink mb-2" x-text="$t('publish.paperTitle')"></label>
            <input id="paper-title" type="text" class="select-control text-base" :placeholder="$t('publish.titlePlaceholder')" x-model="title" required />
          </div>

          <!-- Abstract -->
          <div class="card">
            <label class="block text-sm font-semibold text-ink mb-2" x-text="$t('publish.abstract')"></label>
            <div x-ref="abstractEditor"></div>
            <p class="text-xs text-ink-muted mt-1" x-text="$t('publish.abstractHint')"></p>
          </div>

          <!-- Discipline + Keywords -->
          <div class="card">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div class="relative" @click.outside="disciplineDropdownOpen = false">
                <label for="discipline" class="block text-sm font-semibold text-ink mb-2" x-text="$t('filters.discipline')"></label>
                <input id="discipline" type="text" class="select-control" :placeholder="$t('publish.disciplinePlaceholder')"
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
                      <span x-text="$t('publish.useCustomDiscipline', { value: disciplineSearch.trim() })"></span>
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
                        <span x-text="$t('publish.useCustomDiscipline', { value: disciplineSearch.trim() })"></span>
                      </button>
                    </div>
                  </template>
                </div>
              </div>
              <div>
                <label for="keywords" class="block text-sm font-semibold text-ink mb-2" x-text="$t('publish.keywords')"></label>
                <input id="keywords" type="text" class="select-control" :placeholder="$t('publish.keywordsPlaceholder')" x-model="keywordsText" />
                <p class="text-xs text-ink-muted mt-1" x-text="$t('publish.keywordsHint')"></p>
              </div>
            </div>
          </div>

          <!-- Primary author -->
          <div class="card">
            <label class="block text-sm font-semibold text-ink mb-3" x-text="$t('publish.yourInfo')"></label>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label for="author-name" class="block text-xs font-medium text-ink-muted mb-1"><span x-text="$t('publish.yourName')"></span> *</label>
                <input id="author-name" type="text" class="select-control" :placeholder="$t('publish.fullName')" x-model="authorName" required />
              </div>
              <div>
                <label for="author-affiliation" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('publish.affiliation')"></label>
                <input id="author-affiliation" type="text" class="select-control" :placeholder="$t('publish.affiliation')" x-model="authorAffiliation" />
              </div>
              <div>
                <label for="author-orcid" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('publish.orcidOptional')"></label>
                <input id="author-orcid" type="text" class="select-control" placeholder="0000-0001-2345-6789" x-model="authorOrcid" />
              </div>
            </div>
          </div>

          <!-- Co-authors -->
          <div class="card">
            <div class="flex items-center justify-between mb-3">
              <label class="text-sm font-semibold text-ink" x-text="$t('publish.coAuthors')"></label>
              <button type="button" class="btn-secondary text-xs" @click="addCoAuthor()" x-text="$t('publish.addCoAuthor')"></button>
            </div>
            <template x-if="coAuthors.length === 0">
              <p class="text-xs text-ink-muted" x-text="$t('publish.noCoAuthors')"></p>
            </template>
            <template x-for="(ca, i) in coAuthors" :key="i">
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 p-3 bg-parchment rounded-lg">
                <input type="text" class="select-control text-xs" :placeholder="$t('publish.fullName')" :value="ca.name" @input="updateCoAuthor(i, 'name', $event.target.value)" />
                <input type="text" class="select-control text-xs" :placeholder="$t('publish.hiveUsername')" :value="ca.hive" @input="updateCoAuthor(i, 'hive', $event.target.value)" />
                <input type="text" class="select-control text-xs" :placeholder="$t('publish.orcidOptional')" :value="ca.orcid" @input="updateCoAuthor(i, 'orcid', $event.target.value)" />
                <div class="flex gap-2">
                  <input type="text" class="select-control text-xs flex-1" :placeholder="$t('publish.affiliation')" :value="ca.affiliation" @input="updateCoAuthor(i, 'affiliation', $event.target.value)" />
                  <button type="button" class="text-ink-muted hover:text-ink shrink-0 px-1" @click="removeCoAuthor(i)">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                  </button>
                </div>
              </div>
            </template>
          </div>

          <!-- Paper body (full editor) -->
          <div class="card">
            <label class="text-sm font-semibold text-ink mb-2 block" x-text="$t('publish.paperContent')"></label>
            <div x-ref="bodyEditor"></div>
            <p class="text-xs text-ink-muted mt-2" x-text="$t('publish.markdownHint')"></p>
          </div>

          <!-- PDF Upload -->
          <div class="card">
            <label for="pdf-upload" class="text-sm font-semibold text-ink mb-2 block" x-text="$t('publish.pdfUpload')"></label>
            <p class="text-xs text-ink-muted mb-3" x-text="$t('publish.pdfHint', { maxSize: maxUploadSizeMB })"></p>
            <input id="pdf-upload" type="file" accept=".pdf" class="block text-sm text-ink-muted file:mr-4 file:py-2 file:px-4 file:rounded-md file:border file:border-parchment-dark file:text-sm file:font-medium file:bg-white file:text-ink hover:file:bg-parchment-warm file:cursor-pointer file:transition-colors" @change="handlePdfChange($event)" />
            <template x-if="pdfFile">
              <p class="text-xs text-pevo-green mt-2" x-text="$t('publish.pdfSelected', { name: pdfFileName, size: pdfFileSize })"></p>
            </template>
          </div>

          <!-- Supplementary Files -->
          <div class="card">
            <label class="text-sm font-semibold text-ink mb-2 block" x-text="$t('publish.supplementaryFiles')"></label>
            <p class="text-xs text-ink-muted mb-3" x-text="$t('publish.supplementaryFilesHint', { maxSize: maxUploadSizeMB })"></p>

            <!-- File list -->
            <template x-if="supplementaryFiles.length > 0">
              <div class="space-y-2 mb-3">
                <template x-for="(sf, i) in supplementaryFiles" :key="i">
                  <div class="flex flex-col gap-2 p-3 bg-parchment rounded-md border border-parchment-dark">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-sm font-medium text-ink truncate" x-text="sf.fileName"></span>
                        <span class="text-xs text-ink-muted shrink-0" x-text="sf.fileSize + ' MB'"></span>
                        <template x-if="sf.cid">
                          <span class="text-xs text-pevo-green shrink-0">&#10003;</span>
                        </template>
                        <template x-if="sf.uploading">
                          <span class="text-xs text-pevo-teal shrink-0" x-text="$t('publish.uploading')"></span>
                        </template>
                        <template x-if="sf.error">
                          <span class="text-xs text-pevo-crimson shrink-0" x-text="sf.error"></span>
                        </template>
                      </div>
                      <button type="button" class="text-xs text-pevo-crimson hover:text-pevo-crimson-dark shrink-0" @click="removeSupplementaryFile(i)" x-text="$t('publish.removeFile')"></button>
                    </div>
                    <input type="text" class="input text-sm" :placeholder="$t('publish.fileDescriptionPlaceholder')" :value="sf.description" @input="updateSupplementaryDescription(i, $event.target.value)" />
                  </div>
                </template>
              </div>
            </template>

            <!-- Add files button -->
            <template x-if="supplementaryFiles.length < 5">
              <div>
                <label class="inline-flex items-center gap-2 cursor-pointer text-sm text-pevo-teal hover:text-pevo-teal-dark">
                  <span x-text="$t('publish.addSupplementaryFile')"></span>
                  <input type="file" class="hidden" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.csv,.zip" @change="handleSupplementaryFiles($event)" />
                </label>
              </div>
            </template>
          </div>

          <!-- Citations -->
          <div class="card">
            <label class="text-sm font-semibold text-ink mb-2 block" x-text="$t('publish.citations')"></label>
            <p class="text-xs text-ink-muted mb-3" x-text="$t('publish.citationsHint')"></p>
            <template x-if="citations.length > 0">
              <div class="space-y-3">
                <template x-for="(cit, i) in citations" :key="'pub-cit-' + i">
                  <div class="p-3 bg-parchment rounded-lg space-y-2 flex gap-2"
                       draggable="true"
                       @dragstart="dragCitationStart(i)"
                       @dragover="dragCitationOver($event, i)"
                       @drop="dragCitationDrop(i)">
                    <div class="flex items-center cursor-grab text-ink-muted hover:text-ink shrink-0 pt-1" :title="$t('aria.dragToReorder')">
                      <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M7 2a2 2 0 10.001 4.001A2 2 0 007 2zm0 6a2 2 0 10.001 4.001A2 2 0 007 8zm0 6a2 2 0 10.001 4.001A2 2 0 007 14zm6-8a2 2 0 10-.001-4.001A2 2 0 0013 6zm0 2a2 2 0 10.001 4.001A2 2 0 0013 8zm0 6a2 2 0 10.001 4.001A2 2 0 0013 14z" /></svg>
                    </div>
                    <div class="flex-1 space-y-2">
                      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input type="text" class="select-control text-xs" :placeholder="$t('publish.citationAuthor')" :value="cit.author" @input="updateCitation(i, 'author', $event.target.value)" />
                        <input type="text" class="select-control text-xs" :placeholder="$t('publish.citationPermlink')" :value="cit.permlink" @input="updateCitation(i, 'permlink', $event.target.value)" />
                        <input type="text" class="select-control text-xs" :placeholder="$t('publish.citationTitle')" :value="cit.title" @input="updateCitation(i, 'title', $event.target.value)" />
                      </div>
                      <div class="flex items-center justify-between">
                        <label class="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                          <input type="checkbox" class="rounded border-parchment-dark text-pevo-teal focus:ring-pevo-teal" :checked="cit.reputation_relevant" @change="toggleCitationRelevance(i)" />
                          <span x-text="$t('publish.citationReputationRelevant')"></span>
                        </label>
                        <button type="button" class="text-ink-muted hover:text-ink px-1" @click="removeCitation(i)">
                          <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </template>
            <template x-if="citations.length === 0">
              <p class="text-xs text-ink-muted italic" x-text="$t('publish.noCitations')"></p>
            </template>
            <button type="button" class="text-sm text-pevo-teal hover:text-pevo-teal-dark mt-3" @click="addCitation()" x-text="$t('publish.addCitation')"></button>
          </div>

          <!-- Transaction size warning -->
          <template x-if="txWarn">
            <div class="card" :class="txBlock ? 'bg-pevo-crimson-light border-pevo-crimson/30' : 'bg-pevo-gold-light border-pevo-gold/30'">
              <p class="text-sm font-medium" :class="txBlock ? 'text-pevo-crimson' : 'text-pevo-gold-dark'" x-text="txBlock ? $t('publish.txTooLarge') : $t('publish.txWarnLarge')"></p>
              <p class="text-xs text-ink-muted mt-1" x-text="$t('publish.txSizeHint', { current: Math.round(txEstimate / 1024), max: Math.round(60000 / 1024) })"></p>
            </div>
          </template>

          <!-- Submit -->
          <div class="flex flex-col-reverse sm:flex-row items-start sm:items-center justify-between gap-3">
            <p class="text-xs text-ink-muted" x-text="$t('publish.permanentNotice')"></p>
            <template x-if="isAccredited">
              <button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="isSubmitting || txBlock"
                      x-text="isSubmitting ? $t('publish.publishing') : $t('publish.publishButton')"></button>
            </template>
            <template x-if="!isAccredited && !isConnected">
              <a :href="$lp('/getting-started')" @click.prevent="navigate('/getting-started')" class="btn-primary w-full sm:w-auto shrink-0 text-center no-underline" x-text="$t('publish.publishButton')"></a>
            </template>
            <template x-if="!isAccredited && isConnected">
              <a :href="$lp('/accreditation')" @click.prevent="navigate('/accreditation')" class="btn-primary w-full sm:w-auto shrink-0 text-center no-underline" x-text="$t('common.getAccredited')"></a>
            </template>
          </div>
        </form>

        <p class="text-sm text-ink-muted mt-4">
          <span x-text="$t('publish.needHelp')"></span>
          <a :href="$lp('/contact?category=keychain')" @click.prevent="navigate('/contact?category=keychain')" class="text-pevo-teal hover:underline" x-text="$t('publish.contactUs')"></a>
        </p>
      </div>
`;

export { template as publishPageTemplate };

export function initPublishPage() {
  Alpine.data('publishPage', () => ({
    // Post-teardown setTimeout guard. See frontend/src/lib/timer-guard.js.
    ...createTimerGuard(),

    title: '',
    abstract: '',
    body: '',
    discipline: '',
    disciplineSearch: '',
    disciplineDropdownOpen: false,
    keywordsText: '',
    coAuthors: [],
    authorName: '',
    authorAffiliation: '',
    authorOrcid: '',
    pdfFile: null,
    pdfFileName: '',
    pdfFileSize: 0,
    supplementaryFiles: [], // { file, fileName, fileSize, description, uploading, cid, error }
    citations: [], // { author, permlink, title, reputation_relevant }

    dragIndex: null,

    draftRestored: false,
    draftSavedAt: null,
    _draftTimer: null,
    _initialLoadDone: false,
    _storageListener: null,

    maxUploadSizeMB: getMaxUploadSizeMB(),

    step: 'idle', // idle | hashing | uploading | broadcasting | success | error
    errorMessage: '',

    navigate(path) {
      Alpine.store('router').navigate(path);
    },

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },
    get accreditation() { return Alpine.store('auth').accreditation; },

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

    get postBody() {
      return composePostBody(this.abstract, this.body);
    },

    get txEstimate() {
      const APP_TAG = getAppTag();
      const APP_ID = getAppId();
      const metaEstimate = JSON.stringify({
        app: APP_ID,
        tags: [APP_TAG, 'science', this.discipline, ...this.keywordsText.split(',').map((k) => k.trim()).filter(Boolean)],
        [APP_TAG]: { type: 'paper', version: 1, authors: this.coAuthors, discipline: this.discipline, keywords: [] },
      });
      return estimateTxBytes(this.title, this.postBody, metaEstimate);
    },

    get txWarn() { return this.txEstimate >= TX_WARN_BYTES; },
    get txBlock() { return this.txEstimate >= TX_HARD_BYTES; },
    get isSubmitting() { return this.step !== 'idle' && this.step !== 'success' && this.step !== 'error'; },

    get stepMessage() {
      const t = (key) => this.$t(`publish.${key}`);
      const msgs = {
        idle: '',
        hashing: t('stepHashing'),
        uploading: t('stepUploading'),
        broadcasting: t('stepBroadcasting'),
        success: t('stepSuccess'),
        error: this.errorMessage || this.$t('common.error'),
      };
      return msgs[this.step] || '';
    },

    get stepClass() {
      if (this.step === 'success') return 'bg-pevo-green-light border-pevo-green/30';
      if (this.step === 'error') return 'bg-pevo-crimson-light border-pevo-crimson/30';
      return 'bg-pevo-teal-light border-pevo-teal/30';
    },

    init() {
      // Restore accreditation info
      const acc = this.accreditation;
      if (acc) {
        if (!this.authorName) this.authorName = acc.name || '';
        if (!this.authorAffiliation) this.authorAffiliation = acc.institution || '';
      }

      // Restore draft
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const draft = JSON.parse(raw);
          if (draft && typeof draft.title === 'string') {
            this.title = draft.title;
            this.abstract = draft.abstract;
            this.body = draft.body;
            this.discipline = draft.discipline;
            this.keywordsText = draft.keywordsText;
            this.coAuthors = draft.coAuthors || [];
            this.citations = draft.citations || [];
            if (draft.authorName) this.authorName = draft.authorName;
            if (draft.authorAffiliation) this.authorAffiliation = draft.authorAffiliation;
            if (draft.authorOrcid) this.authorOrcid = draft.authorOrcid;
            this.draftSavedAt = draft.savedAt;
            this.draftRestored = true;
          }
        }
      } catch {
        localStorage.removeItem(DRAFT_KEY);
        console.warn('Draft recovery failed');
      }
      this._initialLoadDone = true;

      // Merge citation collection from localStorage
      this._mergeCitationCollection();

      // Listen for cross-tab citation collection changes
      this._storageListener = (e) => {
        if (e.key === 'pevo-citation-collection' && e.newValue) {
          this._mergeCitationCollection();
        }
      };
      window.addEventListener('storage', this._storageListener);

      // Mount standalone editors (outside Alpine reactivity)
      this.$nextTick(() => {
        this._mountEditors();
      });

      // Watch for changes and auto-save
      this.$watch('title', () => this._scheduleDraftSave());
      this.$watch('abstract', () => this._scheduleDraftSave());
      this.$watch('body', () => this._scheduleDraftSave());
      this.$watch('discipline', () => this._scheduleDraftSave());
      this.$watch('keywordsText', () => this._scheduleDraftSave());
      this.$watch('coAuthors', () => this._scheduleDraftSave());
      this.$watch('citations', () => this._scheduleDraftSave());
      this.$watch('authorName', () => this._scheduleDraftSave());
      this.$watch('authorAffiliation', () => this._scheduleDraftSave());
      this.$watch('authorOrcid', () => this._scheduleDraftSave());
    },

    async _mountEditors() {
      const { createEditor } = await import('../editor.js');
      const abstractEl = this.$refs.abstractEditor;
      const bodyEl = this.$refs.bodyEditor;

      if (abstractEl) {
        this._abstractEditor = createEditor(abstractEl, {
          variant: 'abstract',
          maxLength: ABSTRACT_MAX_CHARS,
          placeholder: this.$t('publish.abstractPlaceholder'),
          onChange: (md) => { this.abstract = md; },
          initialMarkdown: this.abstract,
        });
      }

      if (bodyEl) {
        this._bodyEditor = createEditor(bodyEl, {
          variant: 'full',
          placeholder: this.$t('editor.placeholderBody'),
          onChange: (md) => { this.body = md; },
          username: this.username,
          remainingChars: TX_HARD_BYTES - this.txEstimate,
          initialMarkdown: this.body,
        });
      }
    },

    destroy() {
      this._teardownTimers();
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      if (this._abstractEditor) { this._abstractEditor.destroy(); this._abstractEditor = null; }
      if (this._bodyEditor) { this._bodyEditor.destroy(); this._bodyEditor = null; }
      if (this._storageListener) { window.removeEventListener('storage', this._storageListener); this._storageListener = null; }
    },

    _scheduleDraftSave() {
      if (!this._initialLoadDone) return;
      if (this._draftTimer) clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => {
        const hasContent = this.title.trim() || this.abstract.trim() || this.body.trim();
        if (!hasContent) {
          localStorage.removeItem(DRAFT_KEY);
          return;
        }
        const draft = {
          title: this.title, abstract: this.abstract, body: this.body,
          discipline: this.discipline, keywordsText: this.keywordsText,
          coAuthors: this.coAuthors, citations: this.citations, authorName: this.authorName,
          authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
          savedAt: Date.now(),
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        this.draftSavedAt = draft.savedAt;
      }, 2000);
    },

    discardDraft() {
      localStorage.removeItem(DRAFT_KEY);
      this.title = '';
      this.abstract = '';
      this.body = '';
      this.discipline = '';
      this.keywordsText = '';
      this.coAuthors = [];
      this.citations = [];
      this.authorName = this.accreditation?.name || '';
      this.authorAffiliation = this.accreditation?.institution || '';
      this.authorOrcid = '';
      this.supplementaryFiles = [];
      this.draftRestored = false;
      this.draftSavedAt = null;
      if (this._abstractEditor) this._abstractEditor.setContent('');
      if (this._bodyEditor) this._bodyEditor.setContent('');
    },

    draftTimeAgo() {
      if (!this.draftSavedAt) return '';
      return relativeTime(this.draftSavedAt, this.$t);
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

    onDisciplineInput(e) {
      this.disciplineSearch = e.target.value;
      this.discipline = e.target.value.trim();
      this.disciplineDropdownOpen = true;
    },

    get disciplineDisplayValue() {
      return this.disciplineDropdownOpen ? this.disciplineSearch : (this.discipline || this.disciplineSearch);
    },

    addCoAuthor() {
      this.coAuthors.push({ name: '', hive: '', orcid: '', affiliation: '' });
    },

    updateCoAuthor(index, field, value) {
      this.coAuthors[index][field] = value;
    },

    removeCoAuthor(index) {
      this.coAuthors.splice(index, 1);
    },

    addCitation() {
      this.citations.push({ author: '', permlink: '', title: '', reputation_relevant: true });
    },

    updateCitation(index, field, value) {
      this.citations[index][field] = value;
    },

    toggleCitationRelevance(index) {
      this.citations[index].reputation_relevant = !this.citations[index].reputation_relevant;
    },

    removeCitation(index) {
      const removed = this.citations.splice(index, 1)[0];
      if (removed?.author && removed?.permlink) {
        const key = 'pevo-citation-collection';
        const raw = localStorage.getItem(key);
        if (raw) {
          const collection = JSON.parse(raw).filter(c => !(c.author === removed.author && c.permlink === removed.permlink));
          if (collection.length > 0) localStorage.setItem(key, JSON.stringify(collection));
          else localStorage.removeItem(key);
        }
      }
    },

    _mergeCitationCollection() {
      const key = 'pevo-citation-collection';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const collection = JSON.parse(raw);
      if (!Array.isArray(collection) || collection.length === 0) return;
      for (const entry of collection) {
        const exists = this.citations.some(c => c.author === entry.author && c.permlink === entry.permlink);
        if (!exists) {
          this.citations.push({ author: entry.author, permlink: entry.permlink, title: entry.title || '', reputation_relevant: true });
        }
      }
      localStorage.removeItem(key);
    },

    dragCitationStart(index) {
      this.dragIndex = index;
    },

    dragCitationOver(event, index) {
      event.preventDefault();
    },

    dragCitationDrop(index) {
      if (this.dragIndex === null || this.dragIndex === index) { this.dragIndex = null; return; }
      const item = this.citations.splice(this.dragIndex, 1)[0];
      this.citations.splice(index, 0, item);
      this.dragIndex = null;
    },

    handlePdfChange(e) {
      const file = e.target.files?.[0];
      if (file) {
        this.pdfFile = file;
        this.pdfFileName = file.name;
        this.pdfFileSize = (file.size / 1024 / 1024).toFixed(2);
      }
    },

    handleSupplementaryFiles(e) {
      const files = Array.from(e.target.files || []);
      const remaining = 5 - this.supplementaryFiles.length;
      if (remaining <= 0) {
        Alpine.store('toast').show(this.$t('publish.maxSupplementaryFiles'), 'error');
        return;
      }
      for (const file of files.slice(0, remaining)) {
        if (file.size > getMaxUploadSize()) {
          Alpine.store('toast').show(this.$t('publish.fileTooLarge', { name: file.name, maxSize: getMaxUploadSizeMB() }), 'error');
          continue;
        }
        this.supplementaryFiles.push({
          file,
          fileName: file.name,
          fileSize: (file.size / 1024 / 1024).toFixed(2),
          description: '',
          uploading: false,
          cid: null,
          error: null,
        });
      }
      e.target.value = '';
    },

    removeSupplementaryFile(index) {
      this.supplementaryFiles.splice(index, 1);
    },

    updateSupplementaryDescription(index, value) {
      this.supplementaryFiles[index].description = value;
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        Alpine.store('toast').show(err.message || this.$t('common.connectionFailed'), 'error');
      }
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected || !this.authorName.trim()) return;
      if (!this.isAccredited) return;
      if (!this.title.trim() || !this.abstract.trim() || !this.discipline.trim()) {
        Alpine.store('toast').show(this.$t('publish.missingRequiredFields'), 'error');
        return;
      }
      if (this.txBlock) {
        Alpine.store('toast').show(this.$t('publish.txTooLarge'), 'error');
        return;
      }

      this.step = 'hashing';
      this.errorMessage = '';

      try {

        let ipfsCid = null;
        let ipfsFilename = null;
        let documentHash = null;

        if (this.pdfFile) {
          documentHash = await sha256File(this.pdfFile);
          this.step = 'uploading';
          const uploadRes = await uploadToIpfs(this.pdfFile);
          ipfsCid = uploadRes.data.cid;
          ipfsFilename = uploadRes.data.filename;
        }

        // Upload supplementary files
        const supplementaryFiles = [];
        if (this.supplementaryFiles.length > 0) {
          this.step = 'uploading';
          for (const sf of this.supplementaryFiles) {
            sf.uploading = true;
            sf.error = null;
            try {
              const res = await uploadToIpfs(sf.file);
              sf.cid = res.data.cid;
              supplementaryFiles.push({
                cid: res.data.cid,
                filename: res.data.filename,
                type: res.data.type || sf.file.type,
                size: res.data.size || sf.file.size,
                description: sf.description || undefined,
              });
            } catch (err) {
              // Sanitization pattern (see executeUpgrade() in settings.js).
              console.warn('[publish supplementary upload]', err);
              sf.error = this.$t('common.uploadFailed');
              throw new Error(this.$t('publish.supplementaryUploadFailed', { name: sf.fileName }));
            } finally {
              sf.uploading = false;
            }
          }
        }

        const permlink = slugify(this.title) + '-' + Date.now().toString(36);

        const keywords = this.keywordsText
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean);

        const authors = [
          { name: this.authorName, hive: username, orcid: this.authorOrcid, affiliation: this.authorAffiliation },
          ...this.coAuthors.filter((ca) => ca.name),
        ];

        const APP_TAG = getAppTag();
        const APP_ID = getAppId();

        // Extract image URLs from markdown embeds (![alt](url)), not plain links
        const images = [];
        for (const match of this.postBody.matchAll(MARKDOWN_IMAGE_RE)) {
          images.push(match[1]);
        }

        const jsonMetadata = {
          app: APP_ID,
          canonical_url: `${window.location.origin}/paper/${username}/${permlink}`,
          tags: [APP_TAG, 'science', this.discipline, ...keywords].filter(Boolean),
          ...(images.length > 0 && { image: images }),
          [APP_TAG]: {
            type: 'paper',
            version: 1,
            authors,
            discipline: this.discipline,
            keywords,
            ipfs_cid: ipfsCid,
            ipfs_filename: ipfsFilename,
            language: 'en',
            document_hash: documentHash,
            citations: this.citations
              .filter((c) => c.author && c.permlink)
              .map((c) => ({ author: c.author, permlink: c.permlink, title: c.title || undefined, reputation_relevant: c.reputation_relevant })),
            supplementary_files: supplementaryFiles,
          },
        };

        const confirmed = await Alpine.store('broadcastConfirm').request({
          title: this.$t('confirm.publishTitle'),
          message: this.$t('confirm.publishMessage', { title: this.title }),
          confirmLabel: this.$t('confirm.publish'),
        });
        if (!this._mounted) return;
        if (!confirmed) { this.step = 'idle'; return; }

        this.step = 'broadcasting';
        const operations = [
          ['comment', {
            parent_author: '',
            parent_permlink: APP_TAG,
            author: username,
            permlink,
            title: this.title,
            body: this.postBody,
            json_metadata: JSON.stringify(jsonMetadata),
          }],
          ['comment_options', {
            author: username,
            permlink,
            max_accepted_payout: '1000000.000 HBD',
            percent_hbd: 0,
            allow_votes: true,
            allow_curation_rewards: true,
            extensions: [],
          }],
        ];
        await broadcastOps(username, operations);
        if (!this._mounted) return;

        this.step = 'success';
        localStorage.removeItem(DRAFT_KEY);
        this._setTimer(() => {
          this.navigate(`/paper/${username}/${permlink}`);
        }, 1500);
      } catch (err) {
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[publish submit]', err);
        this.errorMessage = this.$t('common.publishingFailed');
      }
    },
  }));
}
