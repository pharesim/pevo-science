import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, invalidatePaperCache } from '../api.js';
import { uploadFile, describeUploadError } from '../lib/ipfs-upload.js';
import {
  broadcastWithFreshAuth,
  freshAuthWindowReady,
  FRESH_AUTH_REDIRECT_PENDING,
} from '../lib/fresh-auth.js';
import { sha256File, slugify } from '../crypto.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { loadAccreditedDirectory, lookupAccredited, applyHiveChangePrefill, applyAccreditedPrefill } from '../lib/accredited-directory.js';
import {
  editDraftKey,
  removeLegacyDrafts,
  readDraftEntry,
  draftHasText,
  composeDraftEntry,
  snapshotFields,
  fieldsMatchSnapshot,
  headMarkerOf,
} from '../lib/composer-drafts.js';
import { relativeTime } from '../lib/relative-time.js';

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

        <!-- Edit form. Its root mounts the editors on every render, so a form
             that left the DOM and came back gets them again. -->
        <template x-if="!loadingPaper && !loadError && isAuthorized && paper">
          <div x-init="$nextTick(() => _mountEditors())">
            <a :href="$lp('/paper/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
               @click.prevent="navigate('/paper/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
               class="text-sm text-pevo-teal hover:text-pevo-teal-dark no-underline">&larr; <span x-text="$t('common.backToPapers')"></span></a>

            <h1 class="text-3xl font-bold text-ink mt-4 mb-2" x-text="$t('edit.title')"></h1>
            <p class="text-ink-muted mb-8" x-text="$t('edit.description')"></p>

            <!-- Draft restored banner -->
            <template x-if="draftRestored && draftSavedAt && !_landed">
              <div class="card bg-pevo-teal-light border-pevo-teal/30 mb-6" data-testid="draft-restored-card">
                <div class="flex items-center justify-between">
                  <p class="text-sm text-ink" x-text="$t('publish.draftRestored', { time: draftTimeAgo() })"></p>
                  <button type="button" class="text-sm font-medium text-pevo-teal hover:text-pevo-teal-dark" @click="discardDraft()" x-text="$t('common.discard')"></button>
                </div>
              </div>
            </template>

            <!-- A draft written against another version, or one the page could not check: the form stays read-only until the user picks -->
            <template x-if="draftChoice">
              <div class="card bg-pevo-gold-light border-pevo-gold/30 mb-6" data-testid="draft-choice-card">
                <p class="text-sm text-ink" x-text="draftChoiceMessage"></p>
                <div class="flex items-center gap-4 mt-3">
                  <button type="button" class="btn-primary text-xs" @click="restorePendingDraft()" x-text="$t('common.restore')"></button>
                  <button type="button" class="text-sm font-medium text-pevo-teal hover:text-pevo-teal-dark" @click="discardPendingDraft()" x-text="$t('common.discard')"></button>
                </div>
              </div>
            </template>

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

            <form @submit.prevent="handleSubmit()">
              <fieldset class="space-y-6 min-w-0" :disabled="formLocked">
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
                               :checked="isReviewAddressed(rev.author, rev.permlink)"
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
                <button type="submit" class="btn-primary w-full sm:w-auto shrink-0" :disabled="isSubmitting || _landed"
                        x-text="isSubmitting ? $t('edit.saving') : (isContinuation ? $t('edit.publishRevision') : $t('edit.saveButton'))"></button>
              </div>
              </fieldset>
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
    // Bumped by every _mountEditors call, so a mount whose import resolves
    // after a later one started creates nothing.
    _editorMountGeneration: 0,
    _draftTimer: null,

    draftRestored: false,
    draftSavedAt: null,
    // 'newer' or 'unchecked' while the choice card stands: the stored draft was
    // written against another head marker than the one this load returned, or
    // one of the two markers is null. Null otherwise. The form is read-only
    // and nothing is drafted until the user restores or discards the draft
    // (_pendingDraft).
    draftChoice: null,
    _pendingDraft: null,
    // What the instance drafts for, captured once when the load lands
    // (ARCHITECTURE.md § 8, "Composer Drafts"): the account signed in then
    // (null for a signed-out visitor), and the head marker of the paper the
    // form was loaded from. The key also names the paper's canonical pair. It
    // stays null for an account that cannot edit the paper, which drafts
    // nothing.
    _accountCaptured: false,
    _draftAccount: null,
    _draftKey: null,
    _loadedHeadMarker: null,
    // The route params the instance was mounted for. A history jump between
    // two edit entries changes them without a route change.
    _routeAuthor: null,
    _routePermlink: null,
    // The form as loaded, in two halves: the plain fields once the prefill is
    // done, the editor fields once both editors have normalised their content.
    // Nothing is drafted until both exist, and a form equal to them holds no
    // user work.
    _baselineFields: null,
    _baselineEditors: null,
    // Set when another account signed in or the route named another paper.
    // The instance is replaced once no submit is in flight, and never once it
    // has landed.
    _remountRequested: false,
    // True from the moment a broadcast resolves with a result. Set only by
    // _markLanded and never reset: a landed instance is finished.
    _landed: false,
    _loadInFlight: false,
    _originalBody: '',
    _storageListener: null,
    // Every entry _mergeCitationCollection took out of the citation
    // collection, less any the user removed since. The collection is gone once
    // merged, so the restored card's Discard puts these back rather than
    // dropping the only copy.
    _mergedCitations: [],

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

    // Exclusion against the three resting states, mirroring publish.js. The
    // exclusion form fails closed: a step name added later and not registered
    // anywhere still reads as in-progress and keeps the Submit button
    // disabled, where an inclusion list would silently re-enable it
    // mid-flight.
    get isSubmitting() {
      return this.step !== 'idle' && this.step !== 'success' && this.step !== 'error';
    },

    get stepMessage() {
      const msgs = {
        idle: '',
        authorizing: this.$t('edit.stepAuthorizing'),
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

    get draftChoiceMessage() {
      if (!this._pendingDraft) return '';
      const time = relativeTime(this._pendingDraft.savedAt, this.$t);
      return this.draftChoice === 'newer'
        ? this.$t('edit.draftNewerVersion', { time })
        : this.$t('edit.draftVersionUnchecked', { time });
    },

    get _hasBaseline() {
      return !!(this._baselineFields && this._baselineEditors);
    },

    // The form takes no input until the baseline exists, so nothing typed
    // while the editors load can be taken for the loaded form or be replaced
    // by the restore that follows, and none while the choice card stands.
    get formLocked() {
      return !!this.draftChoice || !this._hasBaseline;
    },

    // Whether both editors still hold the text they normalised the served
    // body to.
    get editorsAtBaseline() {
      return !!this._baselineEditors && fieldsMatchSnapshot(this._editorFields(), this._baselineEditors);
    },

    init() {
      this._routeAuthor = this.author;
      this._routePermlink = this.permlink;
      // Reactive bindings register exactly once. loadPaperData() must stay
      // re-entrant: the Retry button re-invokes it, and registering $watch
      // / storage listeners inside that path duplicated handlers per retry
      // (Alpine's $watch returns an unsubscribe handle the previous code
      // discarded, and the storage listener was overwritten without
      // removeEventListener). A draft write needs the baseline, which no
      // load has taken yet, so a $watch firing before the first successful
      // load writes nothing.
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
      this.$watch('newCoAuthors', () => this._scheduleDraftSave());
      this.$watch('citations', () => this._scheduleDraftSave());
      this.$watch('addressedReviews', () => this._scheduleDraftSave());

      this.$watch('$store.auth.username', (next) => this._onAccountChange(next));
      this.$watch('$store.router.params', (params) => this._onRouteParamsChange(params));
      this.$watch('step', () => this._remountWhenSettled());
    },

    // The account in the store changed (ARCHITECTURE.md § 8, "The instance
    // is bound to the account and the paper it loaded for"). The form was
    // loaded for the captured account (its author entry, its key), so any
    // other account that signs in gets a fresh instance and a load of its
    // own, including when the load captured no account because the visitor
    // was signed out, unless the instance has landed: it then navigates to the
    // paper itself. A change to no account (a sign-out, a session teardown)
    // changes nothing: the instance keeps drafting under the key it captured,
    // and the same account signing back in finds it as it left it. A custody
    // upgrade keeps the username and never reaches this. Before the load
    // lands there is nothing to replace, since the load captures whoever is
    // signed in when it lands.
    _onAccountChange(next) {
      if (!this._accountCaptured || !next || next === this._draftAccount) return;
      this._remountRequested = true;
      this._remountWhenSettled();
    },

    // The edit route started naming another paper while this instance stayed
    // mounted, as a history jump between two edit entries does: pageMount
    // re-renders on a route name change only.
    _onRouteParamsChange(params) {
      if (Alpine.store('router').route !== 'edit') return;
      if (params.author === this._routeAuthor && params.permlink === this._routePermlink) return;
      this._remountRequested = true;
      this._remountWhenSettled();
    },

    // A submit in flight finishes before the instance is replaced: whether an
    // account change between its legs may still send anything is the upload
    // batch guard's decision, not this one's. The pending debounce is flushed
    // first, under the key this instance captured. A landed instance is never
    // replaced and the request is dropped: the instance navigates to the paper
    // itself, and a replacement would cancel that navigation, leaving a fresh
    // form with no word that the edit was saved.
    _remountWhenSettled() {
      if (this._landed) { this._remountRequested = false; return; }
      if (!this._remountRequested || this.isSubmitting || !this._mounted) return;
      this._remountRequested = false;
      this._flushDraftSave();
      Alpine.store('router').remount();
    },

    async loadPaperData() {
      // In-flight guard against double-click Retry races. The Retry
      // button on the load-error card re-invokes loadPaperData(); without
      // this guard a slow network plus rapid retries would race two fetches,
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

        // Both halves are load-blocking. The enrichment half is the
        // non-obvious one: its reviews are what _restoreDraft reconciles the
        // saved ticks against, and an empty list there means "could not be
        // fetched", not "the paper has none". Degrading instead would prune
        // every saved tick, take a baseline so the next watched change
        // rewrites the pruned set to storage, and render no checklist card to
        // show the loss. Failing to the Retry card costs the draft nothing:
        // no baseline is taken, so nothing is pruned and nothing is written.
        if (paperRes.status === 'rejected' || enrichmentRes.status === 'rejected') {
          this.loadError = this.$t('edit.loadError');
          return;
        }

        this.paper = paperRes.value.data;

        const enrichment = enrichmentRes.value.data || {};
        this.reviews = enrichment.reviews || [];
        this.paper.authorship_claims = enrichment.authorship_claims || [];

        if (!this._accountCaptured) this._captureDraftTarget();
        this._prefillForm();
        // The plain half of the baseline. The editors mount when the form
        // renders (its root calls _mountEditors), and the draft is restored
        // only once they have taken the editor half, so neither half sees it.
        this._baselineFields = snapshotFields(this._plainFields());
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
      } else {
        // Empty, as a fresh load leaves them, so a prefill run again over a
        // restored draft (its Discard) does not keep the draft's entry.
        this.authorName = '';
        this.authorAffiliation = '';
        this.authorOrcid = '';
      }
      const rest = selfIdx !== -1
        ? authors.filter((_, i) => i !== selfIdx)
        : authors.slice();
      // Project each prior author down to only the chain-claimed fields the
      // form re-broadcasts: {name, hive, orcid, affiliation}. The API detail
      // surface attaches read-time projection fields (orcid_verified,
      // orcid_discrepancy) to each authors[] entry; spreading them through
      // would persist read-time projections onto the chain as author-claimed
      // data and would defeat handleSubmit's no-change (metaChanged)
      // comparison against the raw head-post claim. The name fallback mirrors
      // the backend read-time order (resolveAuthorName: name -> hive ->
      // orcid) and is trim-aware: a read-only existing row can't be edited to
      // supply a missing name, and a whitespace-only name would otherwise
      // survive the truthy check yet fail the per-entry name requirement,
      // dead-ending an un-revisable paper. orcid normalizes null -> '' on the
      // data side, consistent with the primary author (authorOrcid) and new
      // co-authors (addCoAuthor seeds '').
      this.existingCoAuthors = rest.map(a => ({
        name: String(a.name || '').trim() || a.hive || a.orcid || '',
        hive: a.hive ?? null,
        orcid: a.orcid || '',
        affiliation: a.affiliation || '',
      }));
    },

    // Called once, when the first load lands. The legacy entries go on the
    // first load that has an account, whether or not it can edit this paper.
    _captureDraftTarget() {
      const account = this.username || null;
      this._accountCaptured = true;
      this._draftAccount = account;
      this._loadedHeadMarker = headMarkerOf(this.paper);
      if (!account) return;
      removeLegacyDrafts();
      if (!this.isAuthorized) return;
      this._draftKey = editDraftKey(
        account,
        this.paper.canonical_author || this.paper.author,
        this.paper.canonical_permlink || this.paper.permlink,
      );
    },

    _plainFields() {
      return {
        title: this.title, keywordsText: this.keywordsText, authorName: this.authorName,
        authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
        newCoAuthors: this.newCoAuthors, citations: this.citations,
        addressedReviews: this.addressedReviews,
      };
    },

    _editorFields() {
      return { abstract: this.abstract, body: this.body };
    },

    // The text fields a draft stores.
    _draftFields() {
      return {
        title: this.title, abstract: this.abstract, body: this.body,
        keywordsText: this.keywordsText, authorName: this.authorName,
        authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
        newCoAuthors: this.newCoAuthors, citations: this.citations,
        addressedReviews: this.addressedReviews,
      };
    },

    _formAtBaseline(fields) {
      return fieldsMatchSnapshot(fields, { ...this._baselineFields, ...this._baselineEditors });
    },

    // Restore the captured draft, bound to the head (ARCHITECTURE.md § 8,
    // "Restore is bound to the account and, on the edit page, to the head").
    // Silently, with the "draft restored" card, only when the draft was
    // written against the head marker this load returned. Otherwise nothing
    // is restored yet: the choice card says the paper has a newer version
    // than the draft or, when either marker is null, that the page could not
    // check, and the form stays read-only until the user picks.
    _restoreDraft() {
      if (!this._draftKey) return;
      const draft = readDraftEntry(this._draftKey);
      if (!draftHasText(draft)) return;
      const draftMarker = draft.head_marker ?? null;
      if (this._loadedHeadMarker !== null && draftMarker === this._loadedHeadMarker) {
        this._applyDraft(draft);
        return;
      }
      this._pendingDraft = draft;
      this.draftChoice = this._loadedHeadMarker === null || draftMarker === null ? 'unchecked' : 'newer';
      this._syncEditorsEditable();
    },

    // The draft replaces the form. An author field the draft holds as an
    // empty string is the user's own value (the draft belongs to this account
    // and was written over this paper's entry for it), so it replaces the
    // loaded one too. The form as restored is stored at once under the
    // draft's own time and the loaded head marker: what the restore itself
    // does to the text (ticks put in checklist order, an accredited
    // co-author's ORCID filled in) is not new work, and on the choice card's
    // Restore this write is what binds the draft to the version the form was
    // loaded from.
    _applyDraft(draft) {
      this.title = draft.title;
      this.abstract = draft.abstract || '';
      this.body = draft.body || '';
      this.keywordsText = draft.keywordsText || '';
      if (typeof draft.authorName === 'string') this.authorName = draft.authorName;
      if (typeof draft.authorAffiliation === 'string') this.authorAffiliation = draft.authorAffiliation;
      if (typeof draft.authorOrcid === 'string') this.authorOrcid = draft.authorOrcid;
      this.newCoAuthors = draft.newCoAuthors || [];
      if (Array.isArray(draft.citations)) this.citations = draft.citations;
      this.addressedReviews = this._reconcileAddressedReviews(draft.addressedReviews);
      applyAccreditedPrefill(this.newCoAuthors, this.accreditedDirectory);
      this._loadEditorsFromFields();
      this.draftSavedAt = draft.savedAt ?? null;
      this.draftRestored = true;
      this._writeDraft(draft.savedAt);
    },

    // Load the editors from the editor fields, then take the fields back
    // from what the editors hold. setContent reports nothing through
    // onChange, and the editors rewrite some markdown they are given (a
    // list's spacing), so a field set from the text passed in would not be
    // the text in the editor, and a baseline taken over it would read the
    // next keystroke's rewrite as work.
    _loadEditorsFromFields() {
      if (this._abstractEditor) {
        this._abstractEditor.setContent(this.abstract);
        this._abstractEditor.normalize();
        this.abstract = this._abstractEditor.getMarkdown();
      }
      if (this._bodyEditor) {
        this._bodyEditor.setContent(this.body);
        this._bodyEditor.normalize();
        this.body = this._bodyEditor.getMarkdown();
      }
    },

    // The choice card's Restore: the draft replaces the version the form was
    // loaded from, and is bound to that version's marker, so the next load
    // restores it silently.
    restorePendingDraft() {
      if (this._landed || !this._pendingDraft) return;
      const draft = this._pendingDraft;
      this._clearDraftChoice();
      this._applyDraft(draft);
      this._mergeCitationCollection();
    },

    // The choice card's Discard: the draft goes, and the form keeps the
    // version it was loaded from.
    discardPendingDraft() {
      if (this._landed || !this._pendingDraft) return;
      this._clearDraftChoice();
      localStorage.removeItem(this._draftKey);
      this._mergeCitationCollection();
    },

    _clearDraftChoice() {
      this.draftChoice = null;
      this._pendingDraft = null;
      this._syncEditorsEditable();
    },

    _syncEditorsEditable() {
      const editable = !this.draftChoice;
      if (this._abstractEditor) this._abstractEditor.setEditable(editable);
      if (this._bodyEditor) this._bodyEditor.setEditable(editable);
    },

    // The "draft restored" card's Discard. Refused once landed, when the card
    // is gone and the instance writes nothing. The form returns to the paper
    // as loaded: the prefill runs again, the rows and ticks only a draft adds
    // are emptied, the editors take the loaded text, and the baseline is taken
    // again over it. The citations the collection merge brought in then go
    // back in after the baseline, so they are drafted as work, and at once:
    // they have no other copy left, and an instance destroyed before the
    // debounce fires saves nothing.
    discardDraft() {
      if (this._landed) return;
      this._prefillForm();
      this.newCoAuthors = [];
      this.addressedReviews = [];
      this._loadEditorsFromFields();
      this._baselineFields = snapshotFields(this._plainFields());
      this._baselineEditors = snapshotFields(this._editorFields());
      localStorage.removeItem(this._draftKey);
      this.draftRestored = false;
      this.draftSavedAt = null;
      this._appendMissingCitations(this._mergedCitations);
      this._writeDraft();
    },

    draftTimeAgo() {
      if (!this.draftSavedAt) return '';
      return relativeTime(this.draftSavedAt, this.$t);
    },

    // A tick only means something while the checklist still offers its review,
    // so the saved set is intersected with the reviews the paper carries rather
    // than trusted. loadPaperData assigns `reviews` from the enrichment
    // response before it calls _restoreDraft, and fails the load outright when
    // that response rejected, so the intersection always has the paper's
    // reviews in hand and never runs against an empty list that only means
    // they could not be fetched. Iterating `reviews` rather than the saved array
    // also rebuilds each surviving entry as {author, permlink} (collapsing a
    // duplicate) and orders the result like the rendered checklist.
    _reconcileAddressedReviews(saved) {
      if (!Array.isArray(saved)) return [];
      return this.reviews
        .filter(rev => saved.some(entry => entry && entry.author === rev.author && entry.permlink === rev.permlink))
        .map(rev => ({ author: rev.author, permlink: rev.permlink }));
    },

    // Bound to the form's x-if, not to the component: the form's root calls
    // this on every render. A form that left the DOM and came back (a sign-out
    // hides it, the same account signing back in shows it) has new elements,
    // so the pair left on the old ones is destroyed and a new pair is built on
    // the new ones, from the text the form holds.
    async _mountEditors() {
      // Only the latest call builds. Two calls whose imports are in flight at
      // once would otherwise both call createEditor on the same $refs and leak
      // the first pair.
      const generation = ++this._editorMountGeneration;
      const { createEditor } = await import('../editor.js');
      // Teardown-during-init guard. If the component was destroyed while the
      // dynamic import was in flight, $refs are stale and any editor we
      // create now leaks (destroy() already nulled the previous instance
      // refs, so it won't tear down anything we assign here).
      if (!this._mounted || generation !== this._editorMountGeneration) return;
      this._destroyEditors();
      const abstractEl = this.$refs.abstractEditor;
      const bodyEl = this.$refs.bodyEditor;
      // The form left the DOM while the import was in flight (a sign-out
      // hides it), taking the elements with it. No pair is built, and the
      // baseline and the restore wait for a render that mounts one: taken
      // now, the baseline would hold text the editors have not normalised.
      if (!abstractEl || !bodyEl) return;

      this._abstractEditor = createEditor(abstractEl, {
        variant: 'abstract',
        maxLength: ABSTRACT_MAX_CHARS,
        placeholder: this.$t('publish.abstractPlaceholder'),
        onChange: (md) => { this.abstract = md; },
        initialMarkdown: this.abstract,
      });
      this._bodyEditor = createEditor(bodyEl, {
        variant: 'full',
        placeholder: this.$t('editor.placeholderBody'),
        onChange: (md) => { this.body = md; },
        username: this.username,
        initialMarkdown: this.body,
      });
      this._onEditorsMounted();
    },

    // Both editors are up. Normalise them first: the editor half of the
    // baseline is the text they hold after the rewrite their first transaction
    // makes, not the served text. The first mount then takes that half and
    // only then restores, since the baseline is the form without the draft and
    // taken after a restore it would make a draft that only touched the
    // editors look like no work at all. The citation collection merges last,
    // so a restored draft cannot replace what it adds. A later render keeps
    // the baseline and whatever was restored, and only re-applies the lock a
    // standing choice card holds.
    _onEditorsMounted() {
      this._abstractEditor.normalize();
      this._bodyEditor.normalize();
      this._syncEditorsEditable();
      if (this._baselineEditors) return;
      this._baselineEditors = snapshotFields(this._editorFields());
      this._restoreDraft();
      this._mergeCitationCollection();
    },

    _destroyEditors() {
      if (this._abstractEditor) { this._abstractEditor.destroy(); this._abstractEditor = null; }
      if (this._bodyEditor) { this._bodyEditor.destroy(); this._bodyEditor = null; }
    },

    destroy() {
      this._teardownTimers();
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      this._destroyEditors();
      if (this._storageListener) { window.removeEventListener('storage', this._storageListener); this._storageListener = null; }
    },

    _scheduleDraftSave() {
      if (this._draftTimer) clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => this._writeDraft(), 2000);
    },

    // The broadcast resolved with a result, so this composer instance is
    // finished (ARCHITECTURE.md § 8, "Landing is terminal"). One call does the
    // three things that follow from that, and it is the only place a landed
    // draft is removed:
    //
    // - the flag, which _writeDraft and handleSubmit read from then on. It
    //   goes first so nothing here can end with the draft gone and the
    //   instance still writing;
    // - the debounce cancel. The form stays interactive through the broadcast,
    //   so a change made after _windowReady's flush has a save armed. It would
    //   fire into _writeDraft's refusal anyway; cancelling it leaves no timer
    //   behind on an instance that may already be unmounted;
    // - the removal, once. The form stays interactive after it too, and every
    //   later writer is answered by the refusal in _writeDraft, not by a
    //   second removal. A removal repeated past a later await would run by key
    //   after the component is gone, where the entry under that key can be a
    //   draft a later visit to the same paper wrote.
    //
    // The key is passed in from handleSubmit, which reads the captured key
    // before its first await.
    _markLanded(key) {
      this._landed = true;
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      localStorage.removeItem(key);
    },

    // Everything past a broadcast that resolved with a result, shared by the
    // continuation and same-author arms of handleSubmit. Nothing in here may
    // end in the failure state: the post is on chain, so the user is told it
    // succeeded.
    //
    // The order is the contract. _markLanded runs first and ahead of any
    // `_mounted` check, because the draft outlives the component. The cache
    // invalidation comes next and is also ahead of the `_mounted` check: the
    // paper's readers need the eviction whether or not this component is
    // still there to see it. It is best effort, caught where it is called, and
    // a rejection is logged and changes nothing the user sees. It stays
    // awaited so the navigate cannot outrun the eviction. Only the
    // `step` write and the navigate timer belong to the component, so only
    // they sit behind the guard.
    //
    // The canonical target is passed in, captured by handleSubmit ahead of the
    // broadcast, so nothing here reads `this.paper` on an instance that may
    // already be unmounted.
    async _finishLanded(draftKey, canonicalAuthor, canonicalPermlink) {
      this._markLanded(draftKey);
      try {
        await invalidatePaperCache(canonicalAuthor, canonicalPermlink);
      } catch (err) {
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[edit invalidate]', err);
      }
      if (!this._mounted) return;
      this.step = 'success';
      this._setTimer(() => {
        this.navigate(`/paper/${canonicalAuthor}/${canonicalPermlink}`);
      }, 1500);
    },

    // Persist the draft now and cancel any pending debounce. Called before an
    // acquisition that may navigate: the debounce above means the keystrokes
    // just before a submit are still only in component state, and a full-page
    // round-trip would take them with it. Idempotent, so flushing when nothing
    // is pending costs a write and nothing else.
    _flushDraftSave() {
      if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
      this._writeDraft();
    },

    // The one function every draft write passes through: the debounced save
    // and every gate's flush both end here, so each of its refusals holds for
    // both. It writes only user work, under the captured key and bound to the
    // head marker the form was loaded against (ARCHITECTURE.md § 8, "A draft
    // holds user work only"):
    //
    // - nothing after the landing. A refusal at the scheduler alone would
    //   leave every gate's flush writing the spent draft back, and the
    //   scheduler is deliberately left alone: a timer armed after the landing
    //   fires into this refusal;
    // - nothing without a key, which a signed-out visitor and an account that
    //   cannot edit the paper never get;
    // - nothing before the baseline exists. A flush can fire from a gate
    //   before the restore has run, and writing then would replace a real
    //   draft with a form that does not hold it yet;
    // - nothing while the choice card stands, so the loaded version cannot
    //   overwrite the stored draft before the user has seen it.
    //
    // A form back at its baseline drops the stored text instead of storing it.
    // `now` is the time a text change is stored under: the present, except
    // for the write that stores a restore.
    _writeDraft(now = Date.now()) {
      if (this._landed) return;
      if (!this._draftKey || !this._hasBaseline || this.draftChoice) return;
      const fields = this._draftFields();
      const entry = composeDraftEntry(readDraftEntry(this._draftKey), fields, {
        atBaseline: this._formAtBaseline(fields),
        now,
        headMarker: this._loadedHeadMarker,
      });
      if (!entry) {
        localStorage.removeItem(this._draftKey);
        return;
      }
      localStorage.setItem(this._draftKey, JSON.stringify(entry));
      if (draftHasText(entry)) this.draftSavedAt = entry.savedAt;
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

    // Acquire-before-commit (ARCHITECTURE.md § 6.4.1). A light account needs a
    // re-auth window before work whose loss would cost the user, and for a
    // passwordless account acquiring one is a full-page navigation. Doing it at
    // file-selection time means the worst case is re-picking a file, instead of
    // discarding an attached file and a completed IPFS upload at broadcast time.
    //
    // Whether a gate may navigate follows from what the form holds, decided
    // here once rather than at each call site (the publish page carries the
    // same rule). The navigating factor is allowed only while no new file is
    // attached: the worst case is then re-picking the one file being chosen,
    // and the text fields are drafted. Once a file is held, no gate may
    // navigate unasked. New supplementary files live in component state the
    // draft does not carry, so a round-trip fired to acquire for a resubmit,
    // or for a further file, would discard what is attached.
    //
    // Refusing there is not the end of it. A passwordless account has no other
    // factor, and nothing else in the tab can open a window for it, so a
    // refusal with only a toast behind it leaves that account unable to submit
    // an edit at all while a new file is attached. Removing the files is not
    // the way out either: on an edit whose only change IS those files, taking
    // them off makes the form unchanged, and the no-changes check ahead of
    // this gate stops the submit before it. `onReauthRequired` hands the
    // refusal back here as a question instead. `opts` overrides both
    // decisions, and the pre-broadcast gates override both, because past the
    // uploads the pins are paid for and their CIDs live in handleSubmit
    // locals.
    //
    // The flush is unconditional and sits ahead of every branch. Any gate here
    // may end in a navigation, the draft save is debounced, and what the user
    // typed in the seconds before clicking is exactly what a round-trip would
    // otherwise take with it.
    async _windowReady(opts = {}) {
      this._flushDraftSave();
      return freshAuthWindowReady({
        allowRedirect: !this.holdsAttachedFiles,
        onReauthRequired: () => this._confirmNavigationCost(),
        ...opts,
      });
    },

    // The cost of the one way through, stated before it is taken. Shares the
    // publish page's copy through the i18n keys, not the code: the two pages
    // hold no common component. Worded without reference to a prior window,
    // because the account may never have held one.
    //
    // `request()` resolves false both when the user declines and when another
    // action's dialog already owns the modal; both mean no navigation, which
    // is what the caller does with a false either way.
    //
    // A yes is honoured only while the page is still mounted, the same rule
    // as the publish page's copy of this method: a yes arriving after the
    // user has left degrades to the silent refusal a decline produces, rather
    // than sending a page that no longer exists to ORCID. A yes that is
    // honoured flushes again because the flush in `_windowReady` ran before
    // the dialog opened, and the copy promised that the text survives the
    // round-trip.
    async _confirmNavigationCost() {
      const confirmed = await Alpine.store('broadcastConfirm').request({
        title: this.$t('confirm.reauthNavigateTitle'),
        message: this.$t('confirm.reauthNavigateMessage'),
        confirmLabel: this.$t('confirm.reauthNavigate'),
      });
      if (!confirmed || !this._mounted) return false;
      this._flushDraftSave();
      return true;
    },

    // A new supplementary file waiting to be uploaded. Files already on chain
    // (`existingSupplementaryFiles`) survive a navigation; these do not, which
    // is what makes this the discriminator for `_windowReady`'s redirect
    // posture.
    get holdsAttachedFiles() {
      return this.supplementaryFiles.length > 0;
    },

    // Supplementary files
    async handleSupplementaryFiles(event) {
      const files = Array.from(event.target.files || []);
      if (files.length > 0 && !await this._windowReady()) {
        event.target.value = '';
        return;
      }
      if (!this._mounted) return;
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
        // A removal is the user declining the citation, which is also why it
        // leaves the collection: the restored card's Discard does not put it
        // back.
        this._mergedCitations = this._mergedCitations.filter(c => !(c.author === removed.author && c.permlink === removed.permlink));
        const key = 'pevo-citation-collection';
        const raw = localStorage.getItem(key);
        if (raw) {
          const collection = JSON.parse(raw).filter(c => !(c.author === removed.author && c.permlink === removed.permlink));
          if (collection.length > 0) localStorage.setItem(key, JSON.stringify(collection));
          else localStorage.removeItem(key);
        }
      }
    },

    // Merging takes the collection out of storage, so the citations it adds
    // live only in the form from then on. Held back until the baseline exists
    // and no choice card stands: the merged citations then count as user work
    // and are drafted, neither a restore, the choice nor the restored card's
    // Discard can replace them, and a visitor who cannot edit the paper (no
    // form, so no baseline) leaves the collection where it is.
    _mergeCitationCollection() {
      if (!this._hasBaseline || this.draftChoice) return;
      const key = 'pevo-citation-collection';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const collection = JSON.parse(raw);
      if (!Array.isArray(collection) || collection.length === 0) return;
      this._mergedCitations.push(...collection);
      this._appendMissingCitations(collection);
      localStorage.removeItem(key);
    },

    // Append each entry the form does not cite yet, counting for reputation.
    _appendMissingCitations(entries) {
      for (const entry of entries) {
        const exists = this.citations.some(c => c.author === entry.author && c.permlink === entry.permlink);
        if (!exists) {
          this.citations.push({ author: entry.author, permlink: entry.permlink, title: entry.title || '', reputation_relevant: true });
        }
      }
    },

    dragCitationStart(index) {
      this.dragIndex = index;
    },

    dragCitationOver(event, index) {
      event.preventDefault();
    },

    dragCitationDrop(index) {
      // A dragged row is not a form control, so the locked fieldset does not
      // stop it.
      if (this.formLocked || this.dragIndex === null || this.dragIndex === index) { this.dragIndex = null; return; }
      const item = this.citations.splice(this.dragIndex, 1)[0];
      this.citations.splice(index, 0, item);
      this.dragIndex = null;
    },

    isReviewAddressed(author, permlink) {
      return this.addressedReviews.some(r => r.author === author && r.permlink === permlink);
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
      // A landed instance accepts no further submit, and the refusal is ahead
      // of every gate and of the `step` write so it leaves no trace. A native
      // edit still holds the pre-edit body as its diff base, so a second one
      // would send a patch against a body the chain no longer holds. A
      // continuation mints its permlink further down in this function, so a
      // second one would be a second post.
      if (this._landed) return;
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
      // The key the landing removes the draft by, read ahead of the first
      // await like isContinuation and userPostInChain.
      const draftKey = this._draftKey;

      // Leave 'idle' synchronously, before the first await. `isSubmitting`
      // derives from `step`, and it is what disables the submit button — across
      // an await taken while still idle the button stays live, a second click
      // re-enters here, both calls coalesce onto one acquisition, and the user
      // pays for two uploads and two broadcasts. The flip doubles as the
      // spinner the user watches during re-auth.
      this.step = 'authorizing';
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
        const assembledAuthors = [...this.existingCoAuthors];
        if (this._primaryIndex >= 0) {
          assembledAuthors.splice(this._primaryIndex, 0, editedSelf);
        } else {
          assembledAuthors.push(editedSelf);
        }
        assembledAuthors.push(...this.newCoAuthors.filter(ca => ca.name));

        // Drop duplicate-hive entries before broadcast (keep first occurrence,
        // preserve order). Two paths produce a duplicate: a prior author set
        // already carrying the same hive twice, or a new co-author row whose
        // hive collides with an existing author. Either persists a redundant
        // entry in json_metadata.authors. Hive-less (display-only) credits
        // carry no account identity, so they are never deduped against each
        // other. A non-string hive (e.g. a number or object reachable via the
        // broadcaster-controlled raw json_metadata author fallback) carries no
        // usable account identity either, so it is treated as hive-less:
        // preserved, never collapsed, and never run through string methods
        // (which would throw and abort the whole broadcast). The backend
        // re-dedups on read; this is a write-path cleanliness guard, not a
        // correctness fix.
        const seenHive = new Set();
        const allAuthors = assembledAuthors.filter((a) => {
          const h = typeof a.hive === 'string' ? a.hive.trim().toLowerCase() : '';
          if (!h) return true;
          if (seenHive.has(h)) return false;
          seenHive.add(h);
          return true;
        });

        const citationsData = this.citations.filter(c => c.author && c.permlink);

        const pevoMeta = this.paper.json_metadata?.[APP_TAG] || {};

        // Chain head, and the post a native edit targets. ownPost MAY be null
        // when isContinuation took the sparse-versions fallback path: the
        // getter returns false for a single-post paper the user authored even
        // though the version walk found no entry (versions[] entries lack
        // author/permlink in some HAF-replay-not-run states). The `ownPost ?`
        // guard is load-bearing for that case — DO NOT remove it.
        const headAuthor = this.paper.head_author || this.paper.author;
        const headPermlink = this.paper.head_permlink || this.paper.permlink;
        const targetAuthor = ownPost ? ownPost.author : this.paper.author;
        const targetPermlink = ownPost ? ownPost.permlink : this.paper.permlink;
        const targetIsHead = targetAuthor === headAuthor && targetPermlink === headPermlink;
        // Where the cache invalidation and the post-success navigate point,
        // whichever arm runs: the paper-detail endpoint resolves any chain
        // entry to its canonical root before reading. Captured here with the
        // other targets so _finishLanded reads nothing from `this.paper`.
        const canonicalAuthor = this.paper.canonical_author || this.paper.author;
        const canonicalPermlink = this.paper.canonical_permlink || this.paper.permlink;

        // Detect a submit that would change nothing BEFORE paying for the
        // re-auth window. Everything it reads is already in hand and costs
        // nothing; running the gate first would charge a password prompt, or
        // for a passwordless account a full-page round-trip, only to come back
        // and say the form is unchanged.
        if (
          !isContinuation
          && targetIsHead
          && newPostBody === this._originalBody
          && this.title === this.paper.title
          && JSON.stringify(keywords) === JSON.stringify(pevoMeta.keywords || [])
          && JSON.stringify(allAuthors) === JSON.stringify(pevoMeta.authors || [])
          && JSON.stringify(citationsData) === JSON.stringify(pevoMeta.citations || [])
          && this.supplementaryFiles.length === 0
          && this.addressedReviews.length === 0
        ) {
          this.step = 'error';
          this.errorMessage = this.$t('edit.noChanges');
          return;
        }

        // Enter the rest of the sequence with a window already in hand, and
        // with enough of it left that an upload + broadcast run does not race
        // the closing deadline. Discovering the window closed after the upload
        // has been paid for is exactly the loss this ordering prevents.
        if (!await this._windowReady()) { this.step = 'idle'; return; }
        if (!this._mounted) return;

        this.step = 'diffing';

        // Upload new supplementary files
        const uploadedSupplementary = [...this.existingSupplementaryFiles];
        if (this.supplementaryFiles.length > 0) {
          this.step = 'uploading';
          // Every file rides the session window acquired above, so a whole batch
          // costs no re-auth act of its own.
          for (const sf of this.supplementaryFiles) {
            sf.uploading = true;
            try {
              const res = await uploadFile(sf.file);
              if (!this._mounted) return;
              sf.cid = res.data.cid;
              uploadedSupplementary.push({
                cid: res.data.cid,
                filename: sf.fileName,
                size: sf.file.size,
                description: sf.description,
                type: sf.file.type,
              });
            } catch (err) {
              // Inline error shows the specific reason for a cancelled or
              // failed re-auth and the generic per-file message otherwise; the
              // thrown Error (swallowed by the outer catch) just aborts.
              // A null key is an already-reported failure (a torn-down
              // session, a subject change abandoning the batch): its own
              // toast has spoken. No inline row (it would invite a retry
              // that cannot succeed for this session) and no error surface
              // on top.
              const uploadErrorKey = describeUploadError(err);
              if (uploadErrorKey === null) {
                this.step = 'idle';
                return;
              }
              sf.error = this.$t(uploadErrorKey);
              throw new Error(this.$t('publish.supplementaryUploadFailed', { name: sf.fileName }));
            } finally {
              sf.uploading = false;
            }
          }
        }

        if (isContinuation) {
          // Continuation post: new post with full body
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

          // The margin is applied at the gates, never inside a leg — and the
          // broadcast is the last gate. Uploads are already paid for, so a
          // window that closed while they ran is worth one deliberate re-auth
          // here rather than a 401 discovered mid-broadcast. Worth it only for
          // the password factor, which costs a modal: the ORCID factor is a
          // navigation that would discard the completed pins, so it is
          // suppressed and a passwordless account gets a re-authenticate toast
          // with the form intact instead. No offer is threaded with it: the
          // earlier gates can ask because a yes costs re-picking files, while
          // a yes here would spend pins the user has already paid for.
          if (!await this._windowReady({ allowRedirect: false, onReauthRequired: null })) { this.step = 'idle'; return; }
          if (!this._mounted) return;

          this.step = 'broadcasting';
          // The suppression holds through the broadcast leg: its 401-retry
          // re-acquires, and a navigating re-acquisition from this
          // post-upload position would discard the completed pins exactly
          // like a navigating gate would.
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
          const continuationResult = await broadcastWithFreshAuth(username, continuationOps, { allowRedirect: false });
          if (continuationResult === FRESH_AUTH_REDIRECT_PENDING) {
            // FRESH_AUTH_REDIRECT_PENDING covers the ORCID redirect-in-flight
            // case (the page navigates away) and the 403 username_mismatch
            // disconnect+toast case (no navigation). Reset the step so the UI
            // does not hang at 'broadcasting' in the latter. A pending redirect
            // is not a landing, so it keeps its draft and the instance stays
            // submittable: the round-trip is exactly what the draft exists to
            // survive.
            if (!this._mounted) return;
            this.step = 'idle';
            return;
          }

          // The broadcast resolved with a result: the instance is finished.
          await this._finishLanded(draftKey, canonicalAuthor, canonicalPermlink);
        } else {
          // Same-author native edit against the post resolved above.
          //
          // Diff base correctness: the form pre-fills from the chain head
          // (paper.body), but Hive applies diffs against the post's own
          // current body. The diff is only correct when the target IS the
          // chain head (or when no chain exists, head ≡ root). Otherwise
          // we broadcast full body — Hive accepts it, just uses more chain
          // space than a diff would.
          let broadcastBody;
          if (targetIsHead) {
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

          // See the continuation branch: the margin belongs at the gates, the
          // broadcast is the last one, past the uploads the navigating factor
          // is suppressed so completed pins are never discarded, and no offer
          // is threaded with the suppression for the same reason.
          if (!await this._windowReady({ allowRedirect: false, onReauthRequired: null })) { this.step = 'idle'; return; }
          if (!this._mounted) return;

          this.step = 'broadcasting';
          // See the continuation branch: the suppression holds through the
          // broadcast leg so the 401-retry cannot navigate either.
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
          const editResult = await broadcastWithFreshAuth(username, editOps, { allowRedirect: false });
          if (editResult === FRESH_AUTH_REDIRECT_PENDING) {
            // See continuationResult branch above for rationale; same
            // semantics on the in-place edit path, draft included.
            if (!this._mounted) return;
            this.step = 'idle';
            return;
          }

          // See the continuation branch: the instance is finished.
          await this._finishLanded(draftKey, canonicalAuthor, canonicalPermlink);
        }
      } catch (err) {
        // Everything that reaches this catch threw before a broadcast call
        // resolved, for example a failed upload or a broadcast that rejected.
        // Nothing past the landing can get here, since _finishLanded catches
        // its own one fallible step. What the code knows is only that the call did
        // not resolve, and a broadcast can reject with the transaction on
        // chain (ARCHITECTURE.md § 8, Limits). The draft is kept either way,
        // and the instance keeps drafting and stays submittable, because
        // losing typed work is the worse outcome.
        if (!this._mounted) return;
        this.step = 'error';
        // Sanitization pattern (see executeUpgrade() in settings.js).
        console.warn('[edit submit]', err);
        this.errorMessage = this.$t('common.editFailed');
      }
    },
  }));
}
