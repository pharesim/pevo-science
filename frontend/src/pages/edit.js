import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, invalidatePaperCache, uploadToIpfs } from '../api.js';
import { broadcastOps } from '../signer.js';
import { sha256File, slugify } from '../crypto.js';

import { getAppTag, getAppId, getMaxUploadSize, getMaxUploadSizeMB } from '../config.js';
import diff_match_patch from 'diff-match-patch';

const ABSTRACT_MAX_CHARS = 2000;

function composePostBody(abstract, fullText) {
  if (!fullText) return '## Abstract\n\n' + abstract;
  return '## Abstract\n\n' + abstract + '\n\n---\n\n' + fullText;
}

function computeDiff(oldText, newText) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupEfficiency(diffs);
  const patches = dmp.patch_make(oldText, diffs);
  return dmp.patch_toText(patches);
}

const template = `
      <div x-data="editPage" class="container-narrow py-8">
        <!-- Loading state -->
        <template x-if="loadingPaper">
          <div class="card text-center py-12">
            <div class="inline-block animate-spin rounded-full h-8 w-8 border-2 border-pevo-teal border-t-transparent mb-4"></div>
            <p class="text-ink-muted" x-text="$t('edit.loadingPaper')"></p>
          </div>
        </template>

        <!-- Load error -->
        <template x-if="loadError">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 text-center py-8">
            <p class="text-sm text-pevo-crimson font-medium" x-text="loadError"></p>
            <button class="btn-secondary text-xs mt-3" @click="loadPaperData()" x-text="$t('common.retry')"></button>
          </div>
        </template>

        <!-- Not authorized -->
        <template x-if="!loadingPaper && !loadError && !isAuthorized">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 text-center py-8">
            <p class="text-sm text-pevo-crimson font-medium" x-text="$t('edit.notAuthorized')"></p>
            <a :href="$lp('/paper/' + author + '/' + permlink)" @click.prevent="navigate('/paper/' + author + '/' + permlink)"
               class="btn-secondary text-xs mt-3 no-underline inline-block" x-text="$t('common.backToPapers')"></a>
          </div>
        </template>

        <!-- Edit form -->
        <template x-if="!loadingPaper && !loadError && isAuthorized && paper">
          <div>
            <a :href="$lp('/paper/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
               @click.prevent="navigate('/paper/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
               class="text-sm text-pevo-teal hover:text-pevo-teal-dark no-underline">&larr; <span x-text="$t('common.backToPapers')"></span></a>

            <h1 class="text-3xl font-bold text-ink mt-4 mb-2" x-text="$t('edit.title')"></h1>
            <p class="text-ink-muted mb-8" x-text="$t('edit.description')"></p>

            <!-- Continuation banner -->
            <template x-if="isContinuation">
              <div class="card bg-pevo-teal-light border-pevo-teal/30 mb-6">
                <p class="text-sm font-medium text-ink" x-text="$t('edit.continuationNotice')"></p>
                <p class="text-xs text-ink-muted mt-1" x-text="$t('edit.continuationExplainer')"></p>
              </div>
            </template>

            <!-- Progress indicator -->
            <template x-if="step !== 'idle'">
              <div class="card mb-6" :class="stepClass">
                <p class="text-sm font-medium" x-text="stepMessage"></p>
                <template x-if="step === 'error'">
                  <button class="btn-secondary text-xs mt-2" @click="step = 'idle'" x-text="$t('common.ok')"></button>
                </template>
              </div>
            </template>

            <form @submit.prevent="handleSubmit()" class="space-y-6">
              <!-- Title -->
              <div class="card">
                <label for="edit-title" class="block text-sm font-semibold text-ink mb-2" x-text="$t('publish.paperTitle')"></label>
                <input id="edit-title" type="text" class="select-control text-base" :placeholder="$t('publish.titlePlaceholder')" x-model="title" required />
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
                  <div>
                    <label class="block text-sm font-semibold text-ink mb-2" x-text="$t('filters.discipline')"></label>
                    <input type="text" class="select-control bg-parchment-warm cursor-not-allowed" :value="discipline" disabled />
                    <p class="text-xs text-ink-muted mt-1" x-text="$t('edit.disciplineFixed')"></p>
                  </div>
                  <div>
                    <label for="edit-keywords" class="block text-sm font-semibold text-ink mb-2" x-text="$t('publish.keywords')"></label>
                    <input id="edit-keywords" type="text" class="select-control" :placeholder="$t('publish.keywordsPlaceholder')" x-model="keywordsText" />
                    <p class="text-xs text-ink-muted mt-1" x-text="$t('publish.keywordsHint')"></p>
                  </div>
                </div>
              </div>

              <!-- Primary author -->
              <div class="card">
                <label class="block text-sm font-semibold text-ink mb-3" x-text="$t('publish.yourInfo')"></label>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label for="edit-author-name" class="block text-xs font-medium text-ink-muted mb-1"><span x-text="$t('publish.yourName')"></span> *</label>
                    <input id="edit-author-name" type="text" class="select-control" :placeholder="$t('publish.fullName')" x-model="authorName" required />
                  </div>
                  <div>
                    <label for="edit-author-affiliation" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('publish.affiliation')"></label>
                    <input id="edit-author-affiliation" type="text" class="select-control" :placeholder="$t('publish.affiliation')" x-model="authorAffiliation" />
                  </div>
                  <div>
                    <label for="edit-author-orcid" class="block text-xs font-medium text-ink-muted mb-1" x-text="$t('publish.orcidOptional')"></label>
                    <input id="edit-author-orcid" type="text" class="select-control" placeholder="0000-0001-2345-6789" x-model="authorOrcid" />
                  </div>
                </div>
              </div>

              <!-- Co-authors (add-only) -->
              <div class="card">
                <div class="flex items-center justify-between mb-3">
                  <label class="text-sm font-semibold text-ink" x-text="$t('publish.coAuthors')"></label>
                  <button type="button" class="btn-secondary text-xs" @click="addCoAuthor()" x-text="$t('publish.addCoAuthor')"></button>
                </div>
                <p class="text-xs text-ink-muted mb-3" x-text="$t('edit.authorsAddOnly')"></p>
                <!-- Existing authors (read-only) -->
                <template x-for="(ca, i) in existingCoAuthors" :key="'existing-' + i">
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 p-3 bg-parchment rounded-lg opacity-75">
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.name" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.hive || ''" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.orcid || ''" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.affiliation || ''" disabled />
                  </div>
                </template>
                <!-- New co-authors (editable + removable) -->
                <template x-for="(ca, i) in newCoAuthors" :key="'new-' + i">
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 p-3 bg-parchment rounded-lg">
                    <input type="text" class="select-control text-xs" :placeholder="$t('publish.fullName')" :value="ca.name" @input="updateNewCoAuthor(i, 'name', $event.target.value)" />
                    <input type="text" class="select-control text-xs" :placeholder="$t('publish.hiveUsername')" :value="ca.hive" @input="updateNewCoAuthor(i, 'hive', $event.target.value)" />
                    <input type="text" class="select-control text-xs" :placeholder="$t('publish.orcidOptional')" :value="ca.orcid" @input="updateNewCoAuthor(i, 'orcid', $event.target.value)" />
                    <div class="flex gap-2">
                      <input type="text" class="select-control text-xs flex-1" :placeholder="$t('publish.affiliation')" :value="ca.affiliation" @input="updateNewCoAuthor(i, 'affiliation', $event.target.value)" />
                      <button type="button" class="text-ink-muted hover:text-ink shrink-0 px-1" @click="removeNewCoAuthor(i)">
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

              <!-- Supplementary Files -->
              <div class="card">
                <label class="text-sm font-semibold text-ink mb-2 block" x-text="$t('publish.supplementaryFiles')"></label>
                <p class="text-xs text-ink-muted mb-3" x-text="$t('publish.supplementaryFilesHint', { maxSize: maxUploadSizeMB })"></p>

                <!-- Existing files (read-only) -->
                <template x-if="existingSupplementaryFiles.length > 0">
                  <div class="space-y-2 mb-3">
                    <template x-for="(sf, i) in existingSupplementaryFiles" :key="'existing-sf-' + i">
                      <div class="flex items-center gap-2 p-3 bg-parchment rounded-md border border-parchment-dark opacity-75">
                        <span class="text-sm font-medium text-ink truncate" x-text="sf.filename"></span>
                        <span class="text-xs text-pevo-green shrink-0">&#10003;</span>
                        <span class="text-xs text-ink-muted" x-text="sf.description || ''"></span>
                      </div>
                    </template>
                  </div>
                </template>

                <!-- New files -->
                <template x-if="supplementaryFiles.length > 0">
                  <div class="space-y-2 mb-3">
                    <template x-for="(sf, i) in supplementaryFiles" :key="'new-sf-' + i">
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

                <template x-if="(supplementaryFiles.length + existingSupplementaryFiles.length) < 5">
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
                    <template x-for="(cit, i) in citations" :key="'edit-cit-' + i">
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

              <!-- Address reviews checklist -->
              <template x-if="reviews.length > 0">
                <div class="card">
                  <label class="block text-sm font-semibold text-ink mb-2" x-text="$t('edit.addressReviews')"></label>
                  <p class="text-xs text-ink-muted mb-3" x-text="$t('edit.addressReviewsHint')"></p>
                  <div class="space-y-2">
                    <template x-for="rev in reviews" :key="rev.permlink">
                      <label class="flex items-start gap-3 p-3 rounded-lg hover:bg-parchment transition-colors cursor-pointer">
                        <input type="checkbox" class="mt-1 rounded border-parchment-dark text-pevo-teal focus:ring-pevo-teal"
                               :value="rev.author + '/' + rev.permlink"
                               @change="toggleAddressedReview(rev.author, rev.permlink, $event.target.checked)" />
                        <div class="min-w-0">
                          <span class="text-sm font-medium text-ink" x-text="rev.is_anonymous ? $t('review.anonymousReviewer') : ('@' + rev.author)"></span>
                          <template x-if="rev.reviewed_version">
                            <span class="text-xs text-ink-muted ml-1" x-text="'v' + rev.reviewed_version"></span>
                          </template>
                          <p class="text-xs text-ink-muted mt-0.5 line-clamp-2" x-text="rev.body?.substring(0, 120) + (rev.body?.length > 120 ? '...' : '')"></p>
                        </div>
                      </label>
                    </template>
                  </div>
                </div>
              </template>

              <!-- Submit -->
              <div class="flex flex-col-reverse sm:flex-row items-start sm:items-center justify-between gap-3">
                <p class="text-xs text-ink-muted" x-text="$t('edit.versionLabel', { version: String(nextVersion) })"></p>
                <button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="isSubmitting"
                        x-text="isSubmitting ? $t('edit.saving') : (isContinuation ? $t('edit.publishRevision') : $t('edit.saveButton'))"></button>
              </div>
            </form>
          </div>
        </template>
      </div>
`;

export { template as editPageTemplate };

export function initEditPage() {
  Alpine.data('editPage', () => ({
    paper: null,
    reviews: [],
    loadingPaper: true,
    loadError: null,

    title: '',
    abstract: '',
    body: '',
    discipline: '',
    keywordsText: '',
    authorName: '',
    authorAffiliation: '',
    authorOrcid: '',
    existingCoAuthors: [],
    newCoAuthors: [],
    addressedReviews: [], // [{ author, permlink }]

    // Supplementary files
    supplementaryFiles: [], // { file, fileName, fileSize, description, uploading, cid, error }
    existingSupplementaryFiles: [], // from paper metadata (read-only display)

    // Citations
    citations: [], // { author, permlink, title, reputation_relevant }
    dragIndex: null,

    maxUploadSizeMB: getMaxUploadSizeMB(),

    step: 'idle',
    errorMessage: '',

    _abstractEditor: null,
    _bodyEditor: null,
    _draftTimer: null,
    _initialLoadDone: false,
    _originalBody: '',
    _storageListener: null,

    navigate(path) {
      Alpine.store('router').navigate(path);
    },

    get isConnected() { return Alpine.store('auth').isConnected; },
    get isAccredited() { return Alpine.store('auth').isAccredited; },
    get username() { return Alpine.store('auth').username; },
    get accreditation() { return Alpine.store('auth').accreditation; },

    get author() { return this.$store.router.params.author; },
    get permlink() { return this.$store.router.params.permlink; },

    get isAuthorized() {
      const username = this.username;
      if (!username || !this.paper) return false;
      // Original author
      if (username === this.paper.author) return true;
      // Co-author
      const authors = this.paper.authors || [];
      if (authors.some(a => a.hive === username)) return true;
      // Accredited users can create continuation posts
      return this.isAccredited;
    },

    get isContinuation() {
      if (!this.paper || !this.username) return false;
      // If a continuation chain exists, the displayed content comes from
      // the chain head. Editing the root post in-place would produce a
      // broken diff (Hive applies diffs against the post's own body, not
      // the head's). So everyone must use a continuation post, unless
      // the user is the original author AND no chain exists yet.
      const hasChain = this.paper.head_author !== this.paper.author
        || this.paper.head_permlink !== this.paper.permlink;
      if (hasChain) return true;
      return this.username !== this.paper.author;
    },

    get nextVersion() {
      if (!this.paper?.versions?.length) return 2;
      const max = Math.max(...this.paper.versions.map(v => v.version_number));
      return max + 1;
    },

    get isSubmitting() {
      return this.step !== 'idle' && this.step !== 'success' && this.step !== 'error';
    },

    get stepMessage() {
      const msgs = {
        idle: '',
        diffing: this.$t('edit.stepDiffing'),
        uploading: this.$t('edit.stepUploading'),
        broadcasting: this.$t('edit.stepBroadcasting'),
        success: this.$t('edit.stepSuccess'),
        error: this.errorMessage || this.$t('common.error'),
      };
      return msgs[this.step] || '';
    },

    get stepClass() {
      if (this.step === 'success') return 'bg-pevo-green-light border-pevo-green/30';
      if (this.step === 'error') return 'bg-pevo-crimson-light border-pevo-crimson/30';
      return 'bg-pevo-teal-light border-pevo-teal/30';
    },

    get draftKey() {
      return `pevo-draft-edit-${this.author}-${this.permlink}`;
    },

    init() {
      this.loadPaperData();
    },

    async loadPaperData() {
      const author = this.author;
      const permlink = this.permlink;
      this.loadingPaper = true;
      this.loadError = null;

      try {
        const [paperRes, enrichmentRes] = await Promise.allSettled([
          fetchPaper(author, permlink),
          fetchPaperEnrichment(author, permlink),
        ]);

        if (this.author !== author || this.permlink !== permlink) return;

        if (paperRes.status === 'rejected') {
          this.loadError = this.$t('edit.loadError');
          return;
        }

        this.paper = paperRes.value.data;

        if (enrichmentRes.status === 'fulfilled') {
          this.reviews = enrichmentRes.value.data?.reviews || [];
        }

        this._prefillForm();
        this._restoreDraft();
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

        this.$nextTick(() => {
          this._mountEditors();
        });

        // Watch for changes and auto-save draft
        this.$watch('title', () => this._scheduleDraftSave());
        this.$watch('abstract', () => this._scheduleDraftSave());
        this.$watch('body', () => this._scheduleDraftSave());
        this.$watch('keywordsText', () => this._scheduleDraftSave());
        this.$watch('authorName', () => this._scheduleDraftSave());
        this.$watch('authorAffiliation', () => this._scheduleDraftSave());
        this.$watch('authorOrcid', () => this._scheduleDraftSave());
        this.$watch('citations', () => this._scheduleDraftSave());
      } catch (err) {
        if (this.author !== author || this.permlink !== permlink) return;
        this.loadError = err?.message || this.$t('edit.loadError');
      } finally {
        this.loadingPaper = false;
      }
    },

    _prefillForm() {
      const p = this.paper;
      if (!p) return;

      this.title = p.title || '';

      // Split body on first \n\n---\n\n to extract abstract vs full text
      const fullBody = p.body || '';
      const sep = fullBody.indexOf('\n\n---\n\n');
      if (sep !== -1) {
        let abstractPart = fullBody.slice(0, sep);
        // Strip leading ## Abstract\n\n
        abstractPart = abstractPart.replace(/^##\s*Abstract\s*\n\n/i, '');
        this.abstract = abstractPart;
        this.body = fullBody.slice(sep + 7);
      } else {
        let abstractPart = fullBody;
        abstractPart = abstractPart.replace(/^##\s*Abstract\s*\n\n/i, '');
        this.abstract = abstractPart;
        this.body = '';
      }

      this._originalBody = composePostBody(this.abstract, this.body);

      // Discipline
      const pevo = p.json_metadata?.[getAppTag()] || {};
      this.discipline = pevo.discipline || '';

      // Keywords
      const keywords = pevo.keywords || [];
      this.keywordsText = keywords.join(', ');

      // Citations
      this.citations = (pevo.citations || []).map(c => ({
        author: c.author || '',
        permlink: c.permlink || '',
        title: c.title || '',
        reputation_relevant: c.reputation_relevant !== false,
      }));

      // Supplementary files (existing, read-only)
      this.existingSupplementaryFiles = pevo.supplementary_files || p.supplementary_files || [];

      // Authors
      const authors = pevo.authors || p.authors || [];
      if (authors.length > 0) {
        const primary = authors[0];
        this.authorName = primary.name || '';
        this.authorAffiliation = primary.affiliation || '';
        this.authorOrcid = primary.orcid || '';
        this.existingCoAuthors = authors.slice(1);
      }
    },

    _restoreDraft() {
      try {
        const raw = localStorage.getItem(this.draftKey);
        if (raw) {
          const draft = JSON.parse(raw);
          if (draft && typeof draft.title === 'string') {
            this.title = draft.title;
            this.abstract = draft.abstract;
            this.body = draft.body;
            this.keywordsText = draft.keywordsText;
            if (draft.authorName) this.authorName = draft.authorName;
            if (draft.authorAffiliation) this.authorAffiliation = draft.authorAffiliation;
            if (draft.authorOrcid) this.authorOrcid = draft.authorOrcid;
            this.newCoAuthors = draft.newCoAuthors || [];
            if (draft.citations) this.citations = draft.citations;
          }
        }
      } catch {
        localStorage.removeItem(this.draftKey);
        console.warn('Draft recovery failed');
      }
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
          placeholder: this.$t('publish.paperContentPlaceholder'),
          onChange: (md) => { this.body = md; },
          username: this.username,
          initialMarkdown: this.body,
        });
      }
    },

    destroy() {
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      if (this._abstractEditor) { this._abstractEditor.destroy(); this._abstractEditor = null; }
      if (this._bodyEditor) { this._bodyEditor.destroy(); this._bodyEditor = null; }
      if (this._storageListener) { window.removeEventListener('storage', this._storageListener); this._storageListener = null; }
    },

    _scheduleDraftSave() {
      if (!this._initialLoadDone) return;
      if (this._draftTimer) clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => {
        const draft = {
          title: this.title, abstract: this.abstract, body: this.body,
          keywordsText: this.keywordsText, authorName: this.authorName,
          authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
          newCoAuthors: this.newCoAuthors, citations: this.citations, savedAt: Date.now(),
        };
        localStorage.setItem(this.draftKey, JSON.stringify(draft));
      }, 2000);
    },

    addCoAuthor() {
      this.newCoAuthors.push({ name: '', hive: '', orcid: '', affiliation: '' });
    },

    updateNewCoAuthor(index, field, value) {
      this.newCoAuthors[index][field] = value;
    },

    removeNewCoAuthor(index) {
      this.newCoAuthors.splice(index, 1);
    },

    // Supplementary files
    handleSupplementaryFiles(event) {
      const files = Array.from(event.target.files || []);
      const remaining = 5 - this.supplementaryFiles.length - this.existingSupplementaryFiles.length;
      if (remaining <= 0) {
        Alpine.store('toast').show(this.$t('publish.maxSupplementaryFiles'), 'error');
        event.target.value = '';
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
          fileSize: (file.size / (1024 * 1024)).toFixed(2),
          description: '',
          uploading: false,
          cid: null,
          error: null,
        });
      }
      event.target.value = '';
    },

    removeSupplementaryFile(index) {
      this.supplementaryFiles.splice(index, 1);
    },

    updateSupplementaryDescription(index, value) {
      this.supplementaryFiles[index].description = value;
    },

    // Citations
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

    toggleAddressedReview(author, permlink, checked) {
      if (checked) {
        this.addressedReviews.push({ author, permlink });
      } else {
        this.addressedReviews = this.addressedReviews.filter(
          r => !(r.author === author && r.permlink === permlink)
        );
      }
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected) return;
      if (!this.authorName.trim()) return;

      this.step = 'diffing';
      this.errorMessage = '';

      try {
        const newPostBody = composePostBody(this.abstract, this.body);
        const APP_TAG = getAppTag();
        const APP_ID = getAppId();

        const keywords = this.keywordsText
          .split(',')
          .map(k => k.trim().toLowerCase())
          .filter(Boolean);

        const allAuthors = [
          { name: this.authorName, hive: this.isContinuation ? username : (this.paper.author), orcid: this.authorOrcid, affiliation: this.authorAffiliation },
          ...this.existingCoAuthors,
          ...this.newCoAuthors.filter(ca => ca.name),
        ];

        // Upload new supplementary files
        const uploadedSupplementary = [...this.existingSupplementaryFiles];
        if (this.supplementaryFiles.length > 0) {
          this.step = 'uploading';
          for (const sf of this.supplementaryFiles) {
            sf.uploading = true;
            try {
              const res = await uploadToIpfs(sf.file);
              sf.cid = res.data.cid;
              uploadedSupplementary.push({
                cid: res.data.cid,
                filename: sf.fileName,
                size: sf.file.size,
                description: sf.description,
                type: sf.file.type,
              });
            } catch {
              sf.error = this.$t('publish.supplementaryUploadFailed', { name: sf.fileName });
              throw new Error(sf.error);
            } finally {
              sf.uploading = false;
            }
          }
        }

        const citationsData = this.citations.filter(c => c.author && c.permlink);

        const pevoMeta = this.paper.json_metadata?.[APP_TAG] || {};

        if (this.isContinuation) {
          // Continuation post: new post with full body
          const headAuthor = this.paper.head_author || this.paper.author;
          const headPermlink = this.paper.head_permlink || this.paper.permlink;

          const newPermlink = slugify(this.title) + '-' + Date.now().toString(36);

          const jsonMetadata = {
            app: APP_ID,
            canonical_url: `${window.location.origin}/paper/${username}/${newPermlink}`,
            tags: [APP_TAG, 'science', this.discipline, ...keywords].filter(Boolean),
            [APP_TAG]: {
              ...pevoMeta,
              type: 'paper',
              version: this.nextVersion,
              authors: allAuthors,
              discipline: this.discipline,
              keywords,
              continues: { author: headAuthor, permlink: headPermlink },
              addresses_reviews: this.addressedReviews.length > 0 ? this.addressedReviews : undefined,
              citations: citationsData.length > 0 ? citationsData : undefined,
              supplementary_files: uploadedSupplementary.length > 0 ? uploadedSupplementary : undefined,
            },
          };

          this.step = 'broadcasting';
          const continuationOps = [
            ['comment', {
              parent_author: '',
              parent_permlink: APP_TAG,
              author: username,
              permlink: newPermlink,
              title: this.title,
              body: newPostBody,
              json_metadata: JSON.stringify(jsonMetadata),
            }],
            ['comment_options', {
              author: username,
              permlink: newPermlink,
              max_accepted_payout: '1000000.000 HBD',
              percent_hbd: 0,
              allow_votes: true,
              allow_curation_rewards: true,
              extensions: [],
            }],
          ];
          await broadcastOps(username, continuationOps);

          // Invalidate cache for the canonical paper
          const canonicalAuthor = this.paper.canonical_author || this.paper.author;
          const canonicalPermlink = this.paper.canonical_permlink || this.paper.permlink;
          await invalidatePaperCache(canonicalAuthor, canonicalPermlink);

          this.step = 'success';
          localStorage.removeItem(this.draftKey);
          setTimeout(() => {
            this.navigate(`/paper/${canonicalAuthor}/${canonicalPermlink}`);
          }, 1500);
        } else {
          // Same-author edit: compute diff, broadcast single comment op
          if (newPostBody === this._originalBody && this.title === this.paper.title) {
            // Check if metadata changed
            const metaChanged = JSON.stringify(keywords) !== JSON.stringify(pevoMeta.keywords || [])
              || JSON.stringify(allAuthors) !== JSON.stringify(pevoMeta.authors || [])
              || JSON.stringify(citationsData) !== JSON.stringify(pevoMeta.citations || [])
              || this.supplementaryFiles.length > 0
              || this.addressedReviews.length > 0;

            if (!metaChanged) {
              this.step = 'error';
              this.errorMessage = this.$t('edit.noChanges');
              return;
            }
          }

          const diffText = computeDiff(this._originalBody, newPostBody);
          // If diff is larger than full body, send full body instead
          const broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText;

          const jsonMetadata = {
            app: APP_ID,
            canonical_url: `${window.location.origin}/paper/${this.author}/${this.permlink}`,
            tags: [APP_TAG, 'science', this.discipline, ...keywords].filter(Boolean),
            [APP_TAG]: {
              ...pevoMeta,
              type: 'paper',
              version: this.nextVersion,
              authors: allAuthors,
              discipline: this.discipline,
              keywords,
              addresses_reviews: this.addressedReviews.length > 0 ? this.addressedReviews : undefined,
              citations: citationsData.length > 0 ? citationsData : undefined,
              supplementary_files: uploadedSupplementary.length > 0 ? uploadedSupplementary : undefined,
            },
          };

          this.step = 'broadcasting';
          const editOps = [
            ['comment', {
              parent_author: '',
              parent_permlink: APP_TAG,
              author: username,
              permlink: this.permlink,
              title: this.title,
              body: broadcastBody,
              json_metadata: JSON.stringify(jsonMetadata),
            }],
          ];
          await broadcastOps(username, editOps);

          await invalidatePaperCache(this.author, this.permlink);

          this.step = 'success';
          localStorage.removeItem(this.draftKey);
          setTimeout(() => {
            this.navigate(`/paper/${this.author}/${this.permlink}`);
          }, 1500);
        }
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || this.$t('common.editFailed');
      }
    },
  }));
}
