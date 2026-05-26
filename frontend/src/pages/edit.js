import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, invalidatePaperCache, uploadToIpfs } from '../api.js';
import { broadcastWithFreshAuth, FRESH_AUTH_REDIRECT_PENDING } from '../lib/fresh-auth.js';
import { sha256File, slugify } from '../crypto.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { loadAccreditedDirectory, lookupAccredited, applyHiveChangePrefill, applyAccreditedPrefill } from '../lib/accredited-directory.js';

import { getAppTag, getAppId, getMaxUploadSize, getMaxUploadSizeMB } from '../config.js';
import diff_match_patch from 'diff-match-patch';

// Gating: only original author + named co-authors + accepted authorship-
// claimers can edit. Accreditation is NOT the gate on this page (the
// backend continuation consent-gate filters spoofed continuations from
// chain reconstruction; the UI must not advertise a path that fails
// silently). Affordance states:
//   - !isConnected → sign-in banner with sign-in CTA.
//   - isConnected && !isAuthorized → "Who can edit this paper?" panel
//     listing the three valid paths plus a back-to-paper CTA. No
//     accreditation banner; getting accredited does not unblock editing.
//   - isAuthorized → form renders.

const ABSTRACT_MAX_CHARS = 2000;

// Step state machine. handleSubmit() walks through these in order; the
// terminal states are 'success' and 'error'. STEP_IN_PROGRESS is a
// positive-set inclusion list rather than a negative-space exclusion
// against {idle, success, error} — adding a new step name without
// updating the exclusion would have silently re-enabled the Submit
// button mid-flight (state-machine correctness smell).
const STEP_IN_PROGRESS = ['diffing', 'uploading', 'broadcasting'];

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

        <!-- Not authorized: not connected -->
        <template x-if="!loadingPaper && !loadError && !isAuthorized && !isConnected">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30 mb-6">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('edit.signInToEdit')"></p>
                <p class="text-xs text-ink-muted mt-1" x-text="$t('edit.signInHint')"></p>
                <button class="btn-primary text-xs mt-2" @click="handleConnect()" x-text="$t('signIn.signInButton')"></button>
              </div>
            </div>
          </div>
        </template>

        <!-- Not authorized: connected non-author. Single branch for both
             accredited and unaccredited users; the page renders the
             how-to-edit panel listing the three legitimate paths. -->
        <template x-if="!loadingPaper && !loadError && !isAuthorized && isConnected">
          <div class="card">
            <h2 class="text-section-title text-ink font-serif mb-3" x-text="$t('edit.howToEditTitle')"></h2>
            <p class="text-sm text-ink-light mb-3" x-text="$t('edit.howToEditIntro')"></p>
            <ul class="list-disc pl-5 space-y-1.5 text-sm text-ink-light mb-4">
              <li x-text="$t('edit.howToEditOriginalAuthor')"></li>
              <li x-text="$t('edit.howToEditCoAuthor')"></li>
              <li x-text="$t('edit.howToEditClaim')"></li>
            </ul>
            <a :href="$lp('/paper/' + author + '/' + permlink)" @click.prevent="navigate('/paper/' + author + '/' + permlink)"
               class="btn-secondary text-xs no-underline inline-block" x-text="$t('common.backToPapers')"></a>
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
                  <div data-testid="existing-coauthor-row" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 p-3 bg-parchment rounded-lg opacity-75">
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.name" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.hive || ''" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.orcid || ''" disabled />
                    <input type="text" class="select-control text-xs bg-parchment-warm cursor-not-allowed" :value="ca.affiliation || ''" disabled />
                  </div>
                </template>
                <!-- New co-authors (editable + removable) -->
                <template x-for="(ca, i) in newCoAuthors" :key="'new-' + i">
                  <div class="mt-3 p-3 bg-parchment rounded-lg">
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                      <input type="text" class="select-control text-xs" :placeholder="$t('publish.fullName')" :value="ca.name" @input="updateNewCoAuthor(i, 'name', $event.target.value)" />
                      <input type="text" class="select-control text-xs" :placeholder="$t('publish.hiveUsername')" :value="ca.hive" list="pevo-accredited-usernames" @input="updateNewCoAuthor(i, 'hive', $event.target.value)" />
                      <input type="text" data-testid="coauthor-orcid-input" class="select-control text-xs" :class="{ 'bg-parchment-warm cursor-not-allowed': isNewCoAuthorAccredited(i) }" :placeholder="$t('publish.orcidOptional')" :value="ca.orcid" :disabled="isNewCoAuthorAccredited(i)" @input="updateNewCoAuthor(i, 'orcid', $event.target.value)" />
                      <div class="flex gap-2">
                        <input type="text" class="select-control text-xs flex-1" :placeholder="$t('publish.affiliation')" :value="ca.affiliation" @input="updateNewCoAuthor(i, 'affiliation', $event.target.value)" />
                        <button type="button" class="text-ink-muted hover:text-ink shrink-0 px-1" @click="removeNewCoAuthor(i)">
                          <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                        </button>
                      </div>
                    </div>
                    <template x-if="isNewCoAuthorAccredited(i)">
                      <p class="text-[11px] text-pevo-teal-dark mt-1.5 flex items-center gap-1">
                        <svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" /></svg>
                        <span x-text="$t('publish.coAuthorAccreditedHint')"></span>
                      </p>
                    </template>
                  </div>
                </template>
                <datalist id="pevo-accredited-usernames">
                  <template x-for="acc in Object.values(accreditedDirectory)" :key="acc.username">
                    <option :value="acc.username" :label="acc.name + (acc.institution ? ' - ' + acc.institution : '')"></option>
                  </template>
                </datalist>
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
                               data-testid="address-review-checkbox"
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
    // Post-teardown setTimeout guard. See frontend/src/lib/timer-guard.js.
    ...createTimerGuard(),

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
    // Original index of the broadcaster within the prior author list, so a
    // revision can splice their edited entry back at the same position and
    // preserve author order. -1 when the broadcaster is not yet a listed
    // author (then they are appended as an addition). See _prefillForm.
    _primaryIndex: -1,
    newCoAuthors: [],
    accreditedDirectory: {},
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
    _loadInFlight: false,
    _originalBody: '',
    _storageListener: null,

    navigate(path) {
      Alpine.store('router').navigate(path);
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[edit connect]', err);
        Alpine.store('toast').show(this.$t('common.connectionFailed'), 'error');
      }
    },

    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },

    get author() { return this.$store.router.params.author; },
    get permlink() { return this.$store.router.params.permlink; },

    get isAuthorized() {
      const username = this.username;
      if (!username || !this.paper) return false;
      // Original author
      if (username === this.paper.author) return true;
      // Co-author listed in metadata
      const authors = this.paper.authors || [];
      if (authors.some(a => a.hive === username)) return true;
      // Accepted authorship claim
      const claims = this.paper.authorship_claims || [];
      if (claims.some(c => c.claimer === username && c.status === 'accepted')) return true;
      // Narrow gating: only the three positive paths above. Accreditation
      // alone is NOT sufficient — the backend continuation consent-gate
      // filters non-co-author continuations from chain reconstruction,
      // so exposing the edit form to accredited non-authors led to
      // silently-failing broadcasts.
      return false;
    },

    // The latest version entry in the chain authored by the current user, if
    // any. The reconstructed `versions[]` from /api/papers/:author/:permlink
    // includes every operation across the continuation chain with the post's
    // (author, permlink) per entry, so the user's existing post in the chain
    // (if any) is the latest entry where `author === username`. Returns null
    // when the user has not yet published anything in this chain.
    get userPostInChain() {
      if (!this.paper || !this.username) return null;
      const versions = this.paper.versions || [];
      for (let i = versions.length - 1; i >= 0; i--) {
        if (versions[i].author === this.username) return versions[i];
      }
      return null;
    },

    get isContinuation() {
      if (!this.paper || !this.username) return false;
      // Prefer the version-chain walk: native-edit when the user has any
      // post in the chain. This shape supersedes the prior "any chain →
      // always new continuation" rule, which made every chain-state edit
      // balloon into a fresh post instead of evolving the user's own
      // version.
      if (this.userPostInChain) return false;
      // Fallback when versions[] is sparse (e.g. backend's synthetic
      // single-version stub at papers.ts when HAF replay returned nothing,
      // or a brand-new paper with no chain). Rely on the chain pointers
      // exposed by /api/papers/:author/:permlink.
      const headAuthor = this.paper.head_author || this.paper.author;
      const headPermlink = this.paper.head_permlink || this.paper.permlink;
      const hasChain = headAuthor !== this.paper.author || headPermlink !== this.paper.permlink;
      if (!hasChain) {
        // Single-post paper: only the canonical author native-edits;
        // everyone else broadcasts a continuation. Matches legacy
        // semantics so single-version edits keep working when HAF replay
        // hasn't populated versions[].
        return this.username !== this.paper.author;
      }
      // Chain exists but the version walk didn't find a user post → user
      // has not contributed to this chain → new continuation.
      return true;
    },

    get nextVersion() {
      if (!this.paper?.versions?.length) return 2;
      const max = Math.max(...this.paper.versions.map(v => v.version_number));
      return max + 1;
    },

    get isSubmitting() {
      return STEP_IN_PROGRESS.includes(this.step);
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
      // Reactive bindings register exactly once. loadPaperData() must stay
      // re-entrant: the Retry button re-invokes it, and registering $watch
      // / storage listeners inside that path duplicated handlers per retry
      // (Alpine's $watch returns an unsubscribe handle the previous code
      // discarded, and the storage listener was overwritten without
      // removeEventListener). Draft auto-save guards on _initialLoadDone,
      // so $watch firing before the first successful load is a no-op.
      this._setupReactiveBindings();
      this.loadPaperData();
      this._loadAccreditedDirectory();
    },

    _setupReactiveBindings() {
      this._storageListener = (e) => {
        if (e.key === 'pevo-citation-collection' && e.newValue) {
          this._mergeCitationCollection();
        }
      };
      window.addEventListener('storage', this._storageListener);

      this.$watch('title', () => this._scheduleDraftSave());
      this.$watch('abstract', () => this._scheduleDraftSave());
      this.$watch('body', () => this._scheduleDraftSave());
      this.$watch('keywordsText', () => this._scheduleDraftSave());
      this.$watch('authorName', () => this._scheduleDraftSave());
      this.$watch('authorAffiliation', () => this._scheduleDraftSave());
      this.$watch('authorOrcid', () => this._scheduleDraftSave());
      this.$watch('citations', () => this._scheduleDraftSave());
    },

    async loadPaperData() {
      // In-flight guard against double-click Retry races. The Retry
      // button at edit.js:50 re-invokes loadPaperData(); without this
      // guard a slow network plus rapid retries would race two fetches,
      // and the slower-resolving one would overwrite _originalBody /
      // this.paper, corrupting the diff base for the next native edit.
      // The existing stale-key guard below protects against route
      // changes (different paper), not concurrent retries on the same
      // paper.
      if (this._loadInFlight) return;
      this._loadInFlight = true;

      const author = this.author;
      const permlink = this.permlink;
      this.loadingPaper = true;
      this.loadError = null;

      try {
        const [paperRes, enrichmentRes] = await Promise.allSettled([
          fetchPaper(author, permlink),
          fetchPaperEnrichment(author, permlink),
        ]);

        if (!this._mounted) return;
        if (this.author !== author || this.permlink !== permlink) return;

        if (paperRes.status === 'rejected') {
          this.loadError = this.$t('edit.loadError');
          return;
        }

        this.paper = paperRes.value.data;

        if (enrichmentRes.status === 'fulfilled') {
          const enrichment = enrichmentRes.value.data || {};
          this.reviews = enrichment.reviews || [];
          this.paper.authorship_claims = enrichment.authorship_claims || [];
        }

        this._prefillForm();
        this._restoreDraft();
        this._initialLoadDone = true;

        // Merge citation collection from localStorage
        this._mergeCitationCollection();

        this.$nextTick(() => {
          this._mountEditors();
        });
      } catch (err) {
        if (!this._mounted) return;
        if (this.author !== author || this.permlink !== permlink) return;
        console.warn('[edit load paper]', err);
        this.loadError = this.$t('edit.loadError');
      } finally {
        if (this._mounted) this.loadingPaper = false;
        this._loadInFlight = false;
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

      // Authors. Prefer the API cumulative-union-resolved authors[] (the
      // supersession- and Hive-less-carry-resolved set the detail surface
      // returns) over the raw head-post json_metadata claim, so a revision
      // carries forward the complete author set the backend computed rather
      // than re-deriving from a head post that may have dropped co-authors.
      const authors = (Array.isArray(p.authors) && p.authors.length > 0)
        ? p.authors
        : (pevo.authors || []);

      // Author order is preserved across revisions: the broadcaster edits
      // their own entry in place rather than being hoisted to the front.
      // Seat the broadcaster's prior entry into the editable primary fields
      // and keep every other author (including Hive-less display-only credits)
      // as a read-only existing row. _primaryIndex records where the
      // broadcaster sat so handleSubmit can splice the edited entry back at
      // the same position. When the broadcaster is not yet a listed author
      // (an accepted-claim co-author's first continuation), _primaryIndex
      // stays -1 and they are appended as an addition, leaving prior order
      // intact.
      const selfIdx = this.username
        ? authors.findIndex(a => a.hive === this.username)
        : -1;
      this._primaryIndex = selfIdx;
      if (selfIdx !== -1) {
        const primary = authors[selfIdx];
        this.authorName = primary.name || '';
        this.authorAffiliation = primary.affiliation || '';
        this.authorOrcid = primary.orcid || '';
      }
      const rest = selfIdx !== -1
        ? authors.filter((_, i) => i !== selfIdx)
        : authors.slice();
      // Defensive name fallback mirrors the backend read-time order
      // (name -> hive -> orcid): a read-only existing row can't be edited to
      // supply a missing name, so guarantee one here rather than dead-ending
      // the per-entry name requirement. Other fields (hive, orcid,
      // affiliation) pass through untouched.
      this.existingCoAuthors = rest.map(a => ({
        ...a,
        name: a.name || a.hive || a.orcid || '',
      }));
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
      // Mount-during-mount idempotency guard. loadPaperData's _loadInFlight
      // mutex clears in `finally` BEFORE _mountEditors actually runs (deferred
      // via $nextTick + async import). A Retry that lands between the mutex
      // clear and the import resolution can schedule a second _mountEditors;
      // both invocations call createEditor on the same $refs and leak the
      // first pair of instances. The flag short-circuits the second call
      // synchronously (before the await), so only one createEditor pair lands.
      if (this._editorsInitialized) return;
      this._editorsInitialized = true;
      const { createEditor } = await import('../editor.js');
      // Teardown-during-init guard. If the component was destroyed while the
      // dynamic import was in flight, $refs are stale and any editor we
      // create now leaks (destroy() already nulled the previous instance
      // refs, so it won't tear down anything we assign here). See
      // ui-mount-editors-destroyed-guard.
      if (!this._mounted) {
        // Release the idempotency flag so a legitimate later remount (e.g.
        // live-reload, navigation back to the page) can re-mount editors.
        this._editorsInitialized = false;
        return;
      }
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
          initialMarkdown: this.body,
        });
      }
    },

    destroy() {
      this._teardownTimers();
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      if (this._abstractEditor) { this._abstractEditor.destroy(); this._abstractEditor = null; }
      if (this._bodyEditor) { this._bodyEditor.destroy(); this._bodyEditor = null; }
      this._editorsInitialized = false;
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
      if (field === 'hive') {
        applyHiveChangePrefill(this.newCoAuthors[index], this.accreditedDirectory);
      }
    },

    removeNewCoAuthor(index) {
      this.newCoAuthors.splice(index, 1);
    },

    isNewCoAuthorAccredited(index) {
      const ca = this.newCoAuthors[index];
      if (!ca) return false;
      return !!lookupAccredited(this.accreditedDirectory, ca.hive);
    },

    async _loadAccreditedDirectory() {
      const dir = await loadAccreditedDirectory();
      if (!this._mounted) return;
      this.accreditedDirectory = dir;
      // After the directory loads, reapply prefill so any new co-author rows
      // already populated (from a draft) with currently-accredited hive
      // handles get their ORCID locked to the accreditation record. The
      // helper protects user-typed ORCIDs that were entered before the
      // directory resolved.
      applyAccreditedPrefill(this.newCoAuthors, this.accreditedDirectory);
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

    // Per-entry name requirement: a name is mandatory on every author. The
    // broadcaster's primary name and every read-only existing row must carry
    // a name; a new co-author row with any field filled but no name is an
    // incomplete entry. A wholly blank new row is an unused row, not an
    // author, and is ignored here (and filtered out at broadcast).
    _hasIncompleteAuthor() {
      if (!this.authorName.trim()) return true;
      if (this.existingCoAuthors.some(a => !String(a.name || '').trim())) return true;
      return this.newCoAuthors.some(ca => {
        const blank = !ca.name && !ca.hive && !ca.orcid && !ca.affiliation;
        return !blank && !String(ca.name || '').trim();
      });
    },

    async handleSubmit() {
      const username = this.username;
      if (!username || !this.isConnected) return;
      // Block submission if any author entry lacks a name, instead of
      // silently dropping name-less co-authors at broadcast time.
      if (this._hasIncompleteAuthor()) {
        Alpine.store('toast').show(this.$t('edit.authorNameRequired'), 'error');
        return;
      }

      // Chain-routing scope only: capture isContinuation and
      // userPostInChain as locals before the IPFS-upload await. Both are
      // getters that recompute from this.paper.versions[] on every
      // access; pinning them here prevents the broadcast target from
      // silently shifting if this.paper were mutated mid-submit.
      // NOTE: other this.paper fields (author, permlink, json_metadata,
      // title, body) below are still live-read after awaits — this
      // capture does NOT close the broader "this.paper mutates
      // mid-submit" class. Future code that adds a paper-refresh hook
      // must take a flat paper snapshot up front to be fully safe.
      const isContinuation = this.isContinuation;
      const ownPost = this.userPostInChain;

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

        // The broadcaster's own entry carries hive: username (the actual
        // signing account), never paper.author — on a co-author native edit
        // paper.author points at the canonical root (e.g. alice) while the
        // broadcaster may be a different co-author (e.g. bob).
        // Preserve prior author order: splice the broadcaster's edited entry
        // back at its original index among the existing authors (see
        // _prefillForm / _primaryIndex). A broadcaster not in the prior list
        // is an addition, appended after the preserved set. New co-authors
        // follow; blank rows (no name) are dropped — name-less rows carrying
        // data were already blocked by the _hasIncompleteAuthor guard above.
        const editedSelf = { name: this.authorName, hive: username, orcid: this.authorOrcid, affiliation: this.authorAffiliation };
        const allAuthors = [...this.existingCoAuthors];
        if (this._primaryIndex >= 0) {
          allAuthors.splice(this._primaryIndex, 0, editedSelf);
        } else {
          allAuthors.push(editedSelf);
        }
        allAuthors.push(...this.newCoAuthors.filter(ca => ca.name));

        // Upload new supplementary files
        const uploadedSupplementary = [...this.existingSupplementaryFiles];
        if (this.supplementaryFiles.length > 0) {
          this.step = 'uploading';
          for (const sf of this.supplementaryFiles) {
            sf.uploading = true;
            try {
              const res = await uploadToIpfs(sf.file);
              if (!this._mounted) return;
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

        if (isContinuation) {
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
          const continuationResult = await broadcastWithFreshAuth(username, continuationOps);
          if (!this._mounted) return;
          if (continuationResult === FRESH_AUTH_REDIRECT_PENDING) {
            // FRESH_AUTH_REDIRECT_PENDING covers the ORCID redirect-in-flight
            // case (the page navigates away) and the 403 username_mismatch
            // disconnect+toast case (no navigation). Reset the step so the UI
            // does not hang at 'broadcasting' in the latter.
            this.step = 'idle';
            return;
          }

          // Invalidate cache for the canonical paper
          const canonicalAuthor = this.paper.canonical_author || this.paper.author;
          const canonicalPermlink = this.paper.canonical_permlink || this.paper.permlink;
          await invalidatePaperCache(canonicalAuthor, canonicalPermlink);
          if (!this._mounted) return;

          this.step = 'success';
          localStorage.removeItem(this.draftKey);
          this._setTimer(() => {
            this.navigate(`/paper/${canonicalAuthor}/${canonicalPermlink}`);
          }, 1500);
        } else {
          // Same-author native edit: target the user's own post in the
          // chain (which may be the canonical root, or a continuation
          // post the user previously authored). ownPost MAY be null when
          // isContinuation took the sparse-versions fallback path: at
          // edit.js isContinuation, when the chain pointers indicate a
          // single-post paper (no chain) and username === paper.author,
          // the getter returns false even though the version walk found
          // no entry (versions[] entries lack author/permlink in some
          // HAF-replay-not-run states). The `ownPost ?` guard below is
          // load-bearing for that case — DO NOT remove it.
          const targetAuthor = ownPost ? ownPost.author : this.paper.author;
          const targetPermlink = ownPost ? ownPost.permlink : this.paper.permlink;

          // Diff base correctness: the form pre-fills from the chain head
          // (paper.body), but Hive applies diffs against the post's own
          // current body. The diff is only correct when the target IS the
          // chain head (or when no chain exists, head ≡ root). Otherwise
          // we broadcast full body — Hive accepts it, just uses more chain
          // space than a diff would.
          const headAuthor = this.paper.head_author || this.paper.author;
          const headPermlink = this.paper.head_permlink || this.paper.permlink;
          const targetIsHead = targetAuthor === headAuthor && targetPermlink === headPermlink;

          let broadcastBody;
          if (targetIsHead) {
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
            broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText;
          } else {
            // Non-head target (e.g. root author native-editing their own
            // post while a co-author's continuation is currently the head):
            // pre-fill body differs from target post body, so a diff would
            // be applied to the wrong base. Broadcast full body.
            broadcastBody = newPostBody;
          }

          const jsonMetadata = {
            app: APP_ID,
            canonical_url: `${window.location.origin}/paper/${targetAuthor}/${targetPermlink}`,
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
              author: targetAuthor,
              permlink: targetPermlink,
              title: this.title,
              body: broadcastBody,
              json_metadata: JSON.stringify(jsonMetadata),
            }],
          ];
          const editResult = await broadcastWithFreshAuth(username, editOps);
          if (!this._mounted) return;
          if (editResult === FRESH_AUTH_REDIRECT_PENDING) {
            // See continuationResult branch above for rationale; same
            // semantics on the in-place edit path.
            this.step = 'idle';
            return;
          }

          // Cache invalidation keys off the canonical root, not the
          // edit target — the paper-detail endpoint resolves any chain
          // entry to its canonical root before reading.
          const canonicalAuthor = this.paper.canonical_author || this.paper.author;
          const canonicalPermlink = this.paper.canonical_permlink || this.paper.permlink;
          await invalidatePaperCache(canonicalAuthor, canonicalPermlink);
          if (!this._mounted) return;

          this.step = 'success';
          localStorage.removeItem(this.draftKey);
          this._setTimer(() => {
            this.navigate(`/paper/${canonicalAuthor}/${canonicalPermlink}`);
          }, 1500);
        }
      } catch (err) {
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[edit submit]', err);
        this.errorMessage = this.$t('common.editFailed');
      }
    },
  }));
}
