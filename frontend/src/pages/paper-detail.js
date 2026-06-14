import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, fetchCitationExport, retractPaper, claimAuthorship, approveAuthorshipClaim, revokeAuthorshipClaim, buildConsentCustomJson, fetchEmailStatus, isRetriable503 } from '../api.js';
import { broadcastOps } from '../signer.js';
import { withAuthorshipFreshAuth } from '../lib/authorship-consent.js';
import { isSlotCredited, creditProfileForSlot as creditProfileForSlotFn, acceptedClaimerForSlot as acceptedClaimerForSlotFn } from '../lib/credit.js';
import { getAppTag } from '../config.js';
import { computeVersionDiff } from '../lib/version-diff.js';
import { formatDate } from '../components/paper-card.js';
import { titleCaseDiscipline } from '../lib/discipline-display.js';
import { canonicalOrcid, shouldShowDiscrepancyIndicator } from '../lib/authors.js';
import { safeExternalUrl } from '../lib/safe-url.js';
import { createTimerGuard } from '../lib/timer-guard.js';

const template = `
      <div x-data="paperDetailPage" class="container-narrow py-8">
        <!-- Loading -->
        <template x-if="loading">
          <div class="card animate-pulse">
            <div class="h-4 bg-parchment-warm rounded w-24 mb-4"></div>
            <div class="h-8 bg-parchment-warm rounded w-3/4 mb-3"></div>
            <div class="h-4 bg-parchment-warm rounded w-1/2 mb-6"></div>
            <div class="space-y-2">
              <div class="h-4 bg-parchment-warm rounded w-full"></div>
              <div class="h-4 bg-parchment-warm rounded w-5/6"></div>
              <div class="h-4 bg-parchment-warm rounded w-4/6"></div>
            </div>
          </div>
        </template>

        <!-- Error -->
        <template x-if="!loading && error">
          <div class="card text-center py-12">
            <h1 class="text-2xl font-bold text-ink mb-2" x-text="error"></h1>
            <p class="text-ink-muted mb-4" x-text="errorIs503 ? $t('paperDetail.serviceUnavailableMessage') : $t('paperDetail.notFoundDescription', { author: author, permlink: permlink })"></p>
            <div class="flex justify-center gap-3">
              <button @click="loadPaper()" class="btn-secondary" data-testid="paper-detail-retry" x-text="$t('common.retry')"></button>
              <a :href="$lp('/')" @click.prevent="navigate('/')" class="btn-primary no-underline" x-text="$t('common.backToPapers')"></a>
            </div>
          </div>
        </template>

        <!-- Paper loaded -->
        <template x-if="!loading && !error && paper">
          <div>
            <!-- Back link -->
            <a :href="$lp('/')" @click.prevent="navigate('/')" class="text-sm text-pevo-teal hover:text-pevo-teal-dark no-underline">
              &larr; <span x-text="$t('common.backToPapers')"></span>
            </a>

            <!-- Retraction banner -->
            <template x-if="paper.is_retracted">
              <div class="mt-4 rounded-lg border-2 border-pevo-crimson bg-pevo-crimson-light px-5 py-4">
                <div class="flex items-center gap-2 mb-1">
                  <svg class="h-5 w-5 text-pevo-crimson shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                  </svg>
                  <span class="text-pevo-crimson-dark font-bold text-lg uppercase tracking-wide" x-text="$t('retraction.banner')"></span>
                </div>
                <template x-if="paper.retraction_reason">
                  <p class="text-sm text-pevo-crimson-dark mt-1"><span x-text="$t('retraction.reason')"></span>: <span x-text="paper.retraction_reason"></span></p>
                </template>
                <template x-if="paper.retraction_timestamp">
                  <p class="text-xs text-pevo-crimson-dark/70 mt-1"><span x-text="$t('retraction.date')"></span>: <span x-text="formatDate(paper.retraction_timestamp)"></span></p>
                </template>
              </div>
            </template>

            <!-- Metadata restored notice (shown to author when external edit stripped PEvO data) -->
            <template x-if="paper.metadata_restored && isOwnPaper">
              <div class="mt-4 rounded-lg border-2 border-amber-400 bg-amber-50 px-5 py-4">
                <div class="flex items-center gap-2 mb-1">
                  <svg class="h-5 w-5 text-amber-600 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                  </svg>
                  <span class="text-amber-800 font-semibold" x-text="$t('metadataRestored.title')"></span>
                </div>
                <p class="text-sm text-amber-700 mt-1" x-text="$t('metadataRestored.description')"></p>
              </div>
            </template>

            <!-- Version selector -->
            <template x-if="paper.versions && paper.versions.length > 1">
              <div class="mt-4 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-medium text-ink-muted"><span x-text="$t('versions.label')"></span>:</span>
                  <template x-for="v in sortedVersions" :key="v.version_number">
                    <button class="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border cursor-pointer"
                          :class="{
                            'bg-pevo-teal text-white border-pevo-teal': !pickingDiffVersions && !diffMode && v.version_number === currentVersion,
                            'bg-parchment-warm text-ink-muted border-parchment-dark hover:border-pevo-teal': !pickingDiffVersions && !diffMode && v.version_number !== currentVersion,
                            'border-dashed border-ink-muted hover:border-pevo-teal bg-parchment-warm text-ink-muted cursor-cell': pickingDiffVersions && v.version_number !== diffVersionA && v.version_number !== diffVersionB,
                            'ring-2 ring-blue-500 bg-blue-50 text-blue-800 border-blue-300': (pickingDiffVersions || diffMode) && v.version_number === diffVersionA,
                            'ring-2 ring-green-500 bg-green-50 text-green-800 border-green-300': (pickingDiffVersions || diffMode) && v.version_number === diffVersionB
                          }"
                          :title="pickingDiffVersions
                            ? (diffVersionA === null ? $t('diff.selectFirst') : $t('diff.selectSecond'))
                            : $t('versions.versionWithDate', { number: String(v.version_number), date: formatShortDate(v.created) })"
                          @click="pickingDiffVersions ? pickDiffVersion(v.version_number) : loadVersion(v.version_number)">
                      <span x-text="'v' + v.version_number"></span>
                      <span class="hidden sm:inline text-[0.65rem] opacity-75" x-text="formatShortDate(v.created)"></span>
                      <template x-if="!v.is_content_revision">
                        <span class="text-[0.6rem] italic" :class="v.version_number === currentVersion ? 'text-white/70' : 'text-ink-muted'"
                              :title="$t('versions.metadataOnly')" x-text="$t('versions.metadataOnlyShort')"></span>
                      </template>
                      <template x-if="v.version_number === latestVersion">
                        <span class="text-[0.6rem] font-semibold uppercase tracking-wide"
                              :class="v.version_number === currentVersion ? 'text-white/80' : 'text-pevo-teal'"
                              x-text="$t('versions.latest')"></span>
                      </template>
                    </button>
                  </template>
                  <!-- Compare versions button -->
                  <button class="inline-flex items-center gap-1 text-xs px-3 py-1 rounded-full border cursor-pointer"
                        :class="diffMode || pickingDiffVersions
                          ? 'bg-ink text-white border-ink'
                          : 'bg-white text-ink-muted border-parchment-dark hover:border-ink hover:text-ink'"
                        @click="selectDiffVersions()"
                        x-text="diffMode ? $t('diff.close') : (pickingDiffVersions ? $t('diff.close') : $t('diff.compareVersions'))">
                  </button>
                </div>
                <!-- Pick mode hint -->
                <p x-show="pickingDiffVersions" x-cloak class="text-xs text-ink-muted mt-1"
                   x-text="diffVersionA === null ? $t('diff.selectFirst') : $t('diff.selectSecond')"></p>
              </div>
            </template>

            <!-- Version diff view -->
            <template x-if="diffMode || diffLoading">
              <div class="mt-6 rounded-lg border border-parchment-dark bg-white shadow-sm">
                <!-- Diff header -->
                <div class="flex items-center justify-between px-5 py-3 border-b border-parchment-dark bg-parchment-warm rounded-t-lg">
                  <h3 class="text-sm font-semibold text-ink" x-text="$t('diff.comparing', { a: String(diffVersionA), b: String(diffVersionB) })"></h3>
                  <button class="text-xs text-ink-muted hover:text-ink cursor-pointer" @click="exitDiff()" x-text="$t('diff.close')"></button>
                </div>

                <!-- Loading state -->
                <div x-show="diffLoading" class="px-5 py-8 text-center text-ink-muted text-sm">
                  <span class="animate-pulse" x-text="$t('common.loading')"></span>
                </div>

                <!-- Diff content -->
                <div x-show="!diffLoading && diffResult" class="divide-y divide-parchment-dark">
                  <!-- No changes -->
                  <template x-if="diffResult && !diffResult.title.changed && !diffResult.body.changed && !diffResult.authors.changed && !diffResult.supplementaryFiles.changed && !diffResult.citations.changed && !diffResult.keywords.changed">
                    <div class="px-5 py-6 text-center text-ink-muted text-sm" x-text="$t('diff.noChanges')"></div>
                  </template>

                  <!-- Title diff -->
                  <template x-if="diffResult && diffResult.title.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.title')"></h4>
                      <p class="text-sm leading-relaxed">
                        <template x-for="(seg, i) in diffResult.title.segments" :key="i">
                          <span :class="{
                            'bg-green-100 text-green-800': seg.type === 'insert',
                            'bg-red-100 text-red-800 line-through': seg.type === 'delete'
                          }" x-text="seg.text"></span>
                        </template>
                      </p>
                    </div>
                  </template>

                  <!-- Body diff -->
                  <template x-if="diffResult && diffResult.body.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.body')"></h4>
                      <template x-if="!diffResult.body.diffable">
                        <p class="text-sm text-ink-muted italic" x-text="$t('diff.bodyNotDiffable')"></p>
                      </template>
                      <template x-if="diffResult.body.diffable">
                        <div class="text-sm leading-relaxed whitespace-pre-wrap max-h-[60vh] overflow-y-auto">
                          <template x-for="(seg, i) in diffResult.body.segments" :key="i">
                            <span :class="{
                              'bg-green-100 text-green-800': seg.type === 'insert',
                              'bg-red-100 text-red-800 line-through': seg.type === 'delete'
                            }" x-text="seg.text"></span>
                          </template>
                        </div>
                      </template>
                    </div>
                  </template>

                  <!-- Authors diff -->
                  <template x-if="diffResult && diffResult.authors.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.authors')"></h4>
                      <ul class="space-y-1 text-sm">
                        <template x-for="a in diffResult.authors.added" :key="'add-' + a.hive">
                          <li class="text-green-700"><span class="font-mono mr-1">+</span> <span x-text="a.name"></span> <span class="text-ink-muted">(@<span x-text="a.hive"></span>)</span></li>
                        </template>
                        <template x-for="a in diffResult.authors.removed" :key="'rm-' + a.hive">
                          <li class="text-red-700"><span class="font-mono mr-1">-</span> <span x-text="a.name"></span> <span class="text-ink-muted">(@<span x-text="a.hive"></span>)</span></li>
                        </template>
                      </ul>
                    </div>
                  </template>

                  <!-- Supplementary files diff -->
                  <template x-if="diffResult && diffResult.supplementaryFiles.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.supplementaryFiles')"></h4>
                      <ul class="space-y-1 text-sm">
                        <template x-for="f in diffResult.supplementaryFiles.added" :key="'add-' + f.cid">
                          <li class="text-green-700"><span class="font-mono mr-1">+</span> <span x-text="f.filename || f.cid"></span> <span x-show="f.size" class="text-ink-muted" x-text="'(' + formatFileSize(f.size) + ')'"></span></li>
                        </template>
                        <template x-for="f in diffResult.supplementaryFiles.removed" :key="'rm-' + f.cid">
                          <li class="text-red-700"><span class="font-mono mr-1">-</span> <span x-text="f.filename || f.cid"></span> <span x-show="f.size" class="text-ink-muted" x-text="'(' + formatFileSize(f.size) + ')'"></span></li>
                        </template>
                      </ul>
                    </div>
                  </template>

                  <!-- Citations diff -->
                  <template x-if="diffResult && diffResult.citations.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.citations')"></h4>
                      <ul class="space-y-1 text-sm">
                        <template x-for="c in diffResult.citations.added" :key="'add-' + c.author + c.permlink">
                          <li class="text-green-700"><span class="font-mono mr-1">+</span> <span x-text="c.title || (c.author + '/' + c.permlink)"></span></li>
                        </template>
                        <template x-for="c in diffResult.citations.removed" :key="'rm-' + c.author + c.permlink">
                          <li class="text-red-700"><span class="font-mono mr-1">-</span> <span x-text="c.title || (c.author + '/' + c.permlink)"></span></li>
                        </template>
                      </ul>
                    </div>
                  </template>

                  <!-- Keywords diff -->
                  <template x-if="diffResult && diffResult.keywords.changed">
                    <div class="px-5 py-4">
                      <h4 class="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2" x-text="$t('diff.keywords')"></h4>
                      <div class="flex flex-wrap gap-2">
                        <template x-for="k in diffResult.keywords.added" :key="'add-' + k">
                          <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-800">+ <span x-text="k"></span></span>
                        </template>
                        <template x-for="k in diffResult.keywords.removed" :key="'rm-' + k">
                          <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800 line-through">- <span x-text="k"></span></span>
                        </template>
                      </div>
                    </div>
                  </template>
                </div>
              </div>
            </template>

            <!-- Bridge source info -->
            <template x-if="isBridgePaper && bridgeSource">
              <div class="mt-4 rounded-lg border border-pevo-teal/30 bg-pevo-teal-light/50 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                <div class="text-sm text-ink">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20"
                          x-text="bridgeSource.type === 'arxiv' ? 'arXiv' : 'DOI'"></span>
                    <span x-text="$t('bridge.sourcePanel', { source: bridgeSource.source_name || bridgeSource.type || '' })"></span>
                  </span>
                  <template x-if="bridgeSource.url">
                    <span class="ml-2">
                      <a :href="safeExternalUrl(bridgeSource.url)" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline text-sm"
                         x-text="$t('bridge.viewSource', { source: bridgeSource.source_name || bridgeSource.type || '' })"></a>
                    </span>
                  </template>
                </div>
              </div>
            </template>

            <!-- Paper header card -->
            <article class="card mt-4">
              <div class="flex items-center gap-2 text-xs text-ink-muted mb-3">
                <span class="badge-discipline" x-text="titleCaseDiscipline(paper.discipline)"></span>
                <time :datetime="paper.created" x-text="formatDate(paper.created)"></time>
                <template x-if="paper.last_update && paper.last_update !== paper.created">
                  <span class="text-ink-muted" x-text="'(' + $t('paperDetail.updated', { date: formatDate(paper.last_update) }) + ')'"></span>
                </template>
              </div>

              <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
                <h1 class="text-paper-title text-ink flex-1" x-text="paper.title"></h1>
                <div class="flex items-center gap-2 shrink-0">
                  <!-- Citation export -->
                  <div class="relative" @click.outside="citeOpen = false">
                    <button type="button" class="btn-secondary text-sm flex items-center gap-1.5" @click="citeOpen = !citeOpen" :disabled="citeLoading">
                      <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" /></svg>
                      <span x-text="$t('citation.citeButton')"></span>
                    </button>
                    <div x-show="citeOpen" x-transition class="absolute right-0 rtl:right-auto rtl:left-0 mt-1 w-44 rounded-lg border border-parchment-dark bg-parchment shadow-md z-10">
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-t-lg disabled:opacity-50 disabled:cursor-not-allowed" :disabled="citeLoading" @click="handleCitationExport('apa')" x-text="$t('citation.apaFormat')"></button>
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="citeLoading" @click="handleCitationExport('bibtex')" x-text="$t('citation.bibtexFormat')"></button>
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-b-lg disabled:opacity-50 disabled:cursor-not-allowed" :disabled="citeLoading" @click="handleCitationExport('ris')" x-text="$t('citation.risFormat')"></button>
                    </div>
                  </div>
                  <!-- Add to citation collection -->
                  <button type="button" class="btn-secondary text-sm flex items-center gap-1.5" @click="addToCollection()">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" /></svg>
                    <span x-text="$t('citation.addToCollection')"></span>
                  </button>
                  <!-- Edit button (author/co-author). Bridge papers are
                       immutable post-publish per the keystone policy
                       (Hive-side re-publish from source). The SPA edit
                       flow does not apply; the !isBridgePaper gate below
                       suppresses the Edit affordance for bridge papers. -->
                  <template x-if="isOwnPaper && !paper.is_retracted && !isBridgePaper">
                    <a :href="$lp('/edit/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
                       @click.prevent="navigate('/edit/' + (paper.canonical_author || paper.author) + '/' + (paper.canonical_permlink || paper.permlink))"
                       class="btn-secondary text-sm no-underline" x-text="$t('edit.editButton')"></a>
                  </template>
                  <!-- Retract button (author only) -->
                  <template x-if="$store.auth.isConnected && $store.auth.username === paper.author && !paper.is_retracted">
                    <button type="button" class="btn-secondary text-sm text-pevo-crimson border-pevo-crimson/30 hover:bg-pevo-crimson-light"
                            @click="retractDialogOpen = true" x-text="$t('retraction.retractButton')"></button>
                  </template>
                </div>
              </div>

              <!-- Retraction dialog -->
              <template x-if="retractDialogOpen">
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="retractDialogOpen = false">
                  <div class="card max-w-md w-full mx-4">
                    <h3 class="text-lg font-bold text-pevo-crimson mb-2" x-text="$t('retraction.confirmTitle')"></h3>
                    <p class="text-sm text-ink-muted mb-4" x-text="$t('retraction.confirmDescription')"></p>
                    <div class="mb-4">
                      <label for="retract-reason" class="block text-sm font-medium text-ink mb-1" x-text="$t('retraction.reasonLabel')"></label>
                      <textarea id="retract-reason" class="select-control w-full" rows="3" :placeholder="$t('retraction.reasonPlaceholder')" x-model="retractReason" required></textarea>
                    </div>
                    <div class="flex justify-end gap-3">
                      <button type="button" class="btn-secondary text-sm" @click="retractDialogOpen = false; retractReason = ''" :disabled="retractLoading" x-text="$t('common.cancel')"></button>
                      <button type="button" class="btn-primary text-sm bg-pevo-crimson hover:bg-pevo-crimson-dark" @click="handleRetract()" :disabled="retractLoading || !retractReason.trim()"
                              x-text="retractLoading ? $t('retraction.retracting') : $t('retraction.confirmRetract')"></button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Authors -->
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4">
                <template x-for="(a, idx) in paper.authors" :key="a.hive || a.name || idx">
                  <span class="inline-flex items-center text-sm gap-1">
                    <template x-if="a.hive && (paper.accredited_authors || []).includes(a.hive)">
                      <span class="inline-flex items-center">
                        <a :href="$lp('/profile/' + a.hive)" @click.prevent="navigate('/profile/' + a.hive)" class="no-underline hover:underline">
                          <span class="text-ink font-medium" x-text="a.name"></span>
                        </a>
                        <svg class="ml-0.5 h-3 w-3 text-pevo-green" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" :title="$t('badge.accreditedTitle')">
                          <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                        </svg>
                      </span>
                    </template>
                    <template x-if="!a.hive || !(paper.accredited_authors || []).includes(a.hive)">
                      <span class="text-ink font-medium" x-text="a.name"></span>
                    </template>
                    <template x-if="a.affiliation && a.affiliation !== 'none'">
                      <span class="text-ink-muted" x-text="'(' + a.affiliation + ')'"></span>
                    </template>
                    <!-- ORCID (canonical display: verified else chain) + discrepancy indicator -->
                    <template x-if="canonicalOrcid(a)">
                      <span class="inline-flex items-center gap-1">
                        <a :href="'https://orcid.org/' + canonicalOrcid(a)" target="_blank" rel="noopener noreferrer"
                           class="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-pevo-teal no-underline"
                           :aria-label="$t('orcid.linkAriaLabel', { id: canonicalOrcid(a) })"
                           data-testid="orcid-link">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" class="h-3.5 w-3.5 shrink-0" aria-hidden="true">
                            <circle cx="128" cy="128" r="128" fill="#A6CE39"/>
                            <path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 56.8c-5.7 0-10.3 4.6-10.3 10.3s4.6 10.3 10.3 10.3 10.3-4.6 10.3-10.3-4.6-10.3-10.3-10.3zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4z"/>
                          </svg>
                          <span class="font-mono" x-text="canonicalOrcid(a)"></span>
                        </a>
                        <template x-if="shouldShowDiscrepancyIndicator(a)">
                          <button type="button"
                                  class="inline-flex items-center text-amber-500 hover:text-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-300 rounded"
                                  :title="$t('orcid.discrepancyTitle', { claimed: a.orcid, verified: a.orcid_verified })"
                                  :aria-label="$t('orcid.discrepancyAriaLabel', { claimed: a.orcid, verified: a.orcid_verified })"
                                  data-testid="orcid-discrepancy-indicator">
                            <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                            </svg>
                          </button>
                        </template>
                      </span>
                    </template>
                    <!-- Unified credit badge (decision β): a credited author —
                         Routes 1/2 (consented) or an accepted Route-3 claim — gets a
                         single PEvO badge linking to the credited account's profile
                         (the slot's hive for 1/2, the claimer's hive for Route 3). A
                         pending claim shows NO badge; its state lives in the affordances
                         below. The badge presence is the only display distinction. -->
                    <template x-if="enrichmentLoaded && creditedForSlot(idx)">
                      <a :href="$lp('/profile/' + creditProfileForSlot(idx))"
                         @click.prevent="navigate('/profile/' + creditProfileForSlot(idx))"
                         class="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 font-medium no-underline hover:bg-green-200"
                         :title="$t('claims.creditedTitle')" data-testid="credit-badge">
                        <svg class="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" /></svg>
                        <span x-text="$t('claims.credited')"></span>
                      </a>
                    </template>
                    <!-- Claim button for logged-in accredited user on unclaimed matching slot -->
                    <template x-if="enrichmentLoaded && canClaimSlot(idx)">
                      <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-pevo-teal text-pevo-teal hover:bg-pevo-teal-light cursor-pointer"
                              @click="handleClaimSlot(idx)" :disabled="claimLoading" x-text="$t('claims.claimButton')"></button>
                    </template>
                    <!-- Approve/Reject for post author on pending claims -->
                    <template x-if="enrichmentLoaded && canManageClaims && pendingClaimerForSlot(idx)">
                      <span class="inline-flex gap-1">
                        <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-green-500 text-green-700 hover:bg-green-50 cursor-pointer"
                                @click="handleApproveClaim(pendingClaimerForSlot(idx), idx)" :disabled="claimLoading" x-text="$t('claims.approve')"></button>
                        <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-red-400 text-red-600 hover:bg-red-50 cursor-pointer"
                                @click="confirmRevoke(pendingClaimerForSlot(idx))" :disabled="claimLoading" x-text="$t('claims.reject')"></button>
                      </span>
                    </template>
                    <!-- Backstop revoke: post author strips an ACCEPTED name-only claim -->
                    <template x-if="enrichmentLoaded && canRevokeSlot(idx)">
                      <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-red-400 text-red-600 hover:bg-red-50 cursor-pointer"
                              @click="confirmRevoke(acceptedClaimerForSlot(idx))" :disabled="claimLoading" x-text="$t('claims.revokeButton')"></button>
                    </template>
                    <!-- Self-withdraw: the accepted Route-3 claimer drops their own credit -->
                    <template x-if="enrichmentLoaded && canWithdrawSlot(idx)">
                      <button type="button" class="text-[10px] px-1.5 py-0.5 rounded border border-red-400 text-red-600 hover:bg-red-50 cursor-pointer"
                              @click="confirmRevoke($store.auth.username)" :disabled="claimLoading" x-text="$t('claims.withdrawButton')"></button>
                    </template>
                  </span>
                </template>
              </div>
              <!-- Claim authorship (for users not listed as authors) -->
              <template x-if="enrichmentLoaded && canClaimUnlisted">
                <div class="mb-4">
                  <button type="button" class="text-xs px-3 py-1.5 rounded border border-pevo-teal text-pevo-teal hover:bg-pevo-teal-light cursor-pointer"
                          @click="handleClaimSlot(null)" :disabled="claimLoading"
                          x-text="claimLoading ? $t('claims.claiming') : $t('claims.claimAuthorship')"></button>
                </div>
              </template>

              <!-- Route-2 anchored-slot consent: accept (prominent) + resign ("..." menu) -->
              <template x-if="enrichmentLoaded && (canAcceptHere || canResignHere)">
                <div class="flex items-center gap-2 mb-4">
                  <template x-if="canAcceptHere">
                    <button type="button" class="text-xs px-3 py-1.5 rounded border border-pevo-teal text-pevo-teal hover:bg-pevo-teal-light cursor-pointer"
                            @click="handleAcceptAuthorship()" :disabled="claimLoading"
                            x-text="claimLoading ? $t('claims.accepting') : $t('claims.acceptAuthorship')" data-testid="accept-authorship"></button>
                  </template>
                  <template x-if="canResignHere">
                    <div class="relative" @click.outside="moreMenuOpen = false">
                      <button type="button" class="text-xs px-2 py-1.5 rounded border border-parchment-dark text-ink-muted hover:text-ink hover:border-pevo-teal cursor-pointer"
                              @click="moreMenuOpen = !moreMenuOpen" :disabled="claimLoading" :aria-label="$t('claims.moreActions')" aria-haspopup="true" :aria-expanded="moreMenuOpen">&hellip;</button>
                      <div x-show="moreMenuOpen" x-transition class="absolute left-0 rtl:left-auto rtl:right-0 top-full mt-1 w-48 rounded-lg border border-parchment-dark bg-white shadow-lg z-40">
                        <button type="button" class="w-full px-3 py-2 text-sm text-pevo-crimson hover:bg-pevo-crimson-light text-left rtl:text-right rounded-lg"
                                @click="moreMenuOpen = false; resignModalOpen = true" x-text="$t('claims.resignAuthorship')" data-testid="resign-authorship"></button>
                      </div>
                    </div>
                  </template>
                </div>
              </template>

              <!-- Resign confirmation (Route-2 self-resign) -->
              <template x-if="resignModalOpen">
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="resignModalOpen = false">
                  <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
                    <h3 class="text-lg font-bold text-pevo-crimson mb-2" x-text="$t('claims.resignConfirmTitle')"></h3>
                    <p class="text-sm text-ink-muted mb-4" x-text="$t('claims.resignConfirmDescription')"></p>
                    <div class="flex justify-end gap-2">
                      <button type="button" class="btn-secondary text-sm" @click="resignModalOpen = false" :disabled="claimLoading" x-text="$t('common.cancel')"></button>
                      <button type="button" class="btn-primary text-sm bg-pevo-crimson hover:bg-pevo-crimson-dark" @click="handleResignAuthorship()" :disabled="claimLoading"
                              x-text="claimLoading ? $t('claims.resigning') : $t('claims.confirmResign')" data-testid="confirm-resign"></button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Revoke / reject / withdraw confirmation (shared; Route-3 credit) -->
              <template x-if="revokeModalOpen">
                <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="revokeModalOpen = false; revokeTarget = null">
                  <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
                    <h3 class="text-lg font-bold text-pevo-crimson mb-2" x-text="$t('claims.revokeConfirmTitle')"></h3>
                    <p class="text-sm text-ink-muted mb-4" x-text="$t('claims.revokeConfirmDescription')"></p>
                    <div class="flex justify-end gap-2">
                      <button type="button" class="btn-secondary text-sm" @click="revokeModalOpen = false; revokeTarget = null" :disabled="claimLoading" x-text="$t('common.cancel')"></button>
                      <button type="button" class="btn-primary text-sm bg-pevo-crimson hover:bg-pevo-crimson-dark" @click="handleRevokeClaim(revokeTarget)" :disabled="claimLoading"
                              x-text="claimLoading ? $t('claims.revoking') : $t('claims.confirmRevoke')" data-testid="confirm-revoke"></button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Keywords -->
              <template x-if="paper.keywords && paper.keywords.length > 0">
                <div class="flex flex-wrap gap-1.5 mb-6">
                  <template x-for="kw in paper.keywords" :key="kw">
                    <span class="text-xs px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted" x-text="kw"></span>
                  </template>
                </div>
              </template>

              <!-- Metrics bar -->
              <div class="flex flex-wrap items-center gap-5 text-sm text-ink-muted pb-6 border-b border-parchment-dark">
                <span class="flex items-center gap-1" :title="$t('aria.reviews')">
                  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z" clip-rule="evenodd" /></svg>
                  <span x-text="$t('paperDetail.reviews', { count: paper.reviews ? paper.reviews.length : 0 })"></span>
                </span>
                <span class="flex items-center gap-1" :title="$t('aria.citations')">
                  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" /></svg>
                  <span x-text="$t('paperDetail.citations', { count: paper.citation_count ?? 0 })"></span>
                </span>
                <template x-if="ipfsUrl">
                  <a :href="ipfsUrl" target="_blank" rel="noopener noreferrer"
                     class="flex items-center gap-1 ml-auto rtl:ml-0 rtl:mr-auto text-pevo-teal no-underline hover:text-pevo-teal-dark">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd" /></svg>
                    <span x-text="$t('paperDetail.downloadPdf')"></span>
                  </a>
                </template>
              </div>

              <!-- Vote (wait for enrichment so we get accredited-only counts + voter list) -->
              <template x-if="enrichmentLoaded">
              <div class="mt-4" x-data="voteButtons({ author: paper.author, permlink: paper.permlink, netVotes: paper.net_votes, voteStrength: paper.vote_strength, voters: paper.voters || [], created: paper.created, versions: paper.versions })" @click.outside="selectorOpen = false">
                <!-- Accredited (non-author): vote strength selector. Authors
                     are excluded because the backend filters self-votes from
                     all aggregated counts (accreditedVoteCount: v.voter != author),
                     so offering the action would waste a broadcast for a
                     vote that can never be displayed. -->
                <template x-if="isAccredited && !isOwnPaper">
                  <div class="flex items-center gap-3">
                    <div class="relative">
                      <button type="button" class="btn-secondary text-sm flex items-center gap-1.5"
                              @click="selectorOpen = !selectorOpen" :disabled="isVoting">
                        <template x-if="isVoting">
                          <span class="inline-block animate-spin h-4 w-4 border-2 border-pevo-teal border-t-transparent rounded-full"></span>
                        </template>
                        <template x-if="!isVoting && voteState === 'none'">
                          <span x-text="$t('vote.evaluate')"></span>
                        </template>
                        <template x-if="!isVoting && voteState !== 'none'">
                          <span x-text="currentLevelLabel()"></span>
                        </template>
                        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                      </button>
                      <div x-show="selectorOpen" x-transition class="absolute left-0 rtl:left-auto rtl:right-0 mt-1 w-56 rounded-lg border border-parchment-dark bg-parchment shadow-md z-20">
                        <template x-for="level in voteLevels" :key="level.weight">
                          <button type="button" class="block w-full text-left px-4 py-2 text-sm border-b border-parchment-dark/30 last:border-0 transition-colors"
                                  :class="level.cls + (currentWeight === level.weight ? ' font-semibold ring-1 ring-inset ring-current' : '')"
                                  @click="handleVote(level.weight)" :disabled="isVoting">
                            <span x-text="$t(level.label)"></span>
                          </button>
                        </template>
                        <template x-if="voteState !== 'none'">
                          <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink-muted border-t border-parchment-dark/30 hover:bg-parchment-dark/10 transition-colors"
                                  @click="handleVote(0)" :disabled="isVoting">
                            <span x-text="$t('vote.retract')"></span>
                          </button>
                        </template>
                      </div>
                    </div>
                    <span class="text-sm text-ink-muted" x-text="voteCountLabel()"></span>
                  </div>
                </template>
                <!-- Non-accredited or own paper: read-only count + strength -->
                <template x-if="!isAccredited || isOwnPaper">
                  <div class="flex items-center gap-2 text-sm text-ink-muted">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                    <span x-text="voteCountLabel()"></span>
                  </div>
                </template>
                <template x-if="voteIsOutdated">
                  <p class="text-xs text-amber-600 mt-1.5" x-text="$t('vote.outdatedNotice', { votedVersion: myVotedVersion, latestVersion: _latestVersion() })"></p>
                </template>
              </div>
              </template>

              <!-- Abstract (always visible) -->
              <div class="mt-6 prose prose-ink max-w-reading text-ink-light text-[0.95rem] leading-relaxed" x-markdown="paper.abstract"></div>

              <!-- Full paper body (collapsible, only if there is text beyond abstract) -->
              <template x-if="hasFullText">
                <div class="mt-6">
                  <button type="button" class="btn-secondary text-sm mb-3" @click="bodyExpanded = !bodyExpanded"
                          x-text="bodyExpanded ? $t('paperDetail.collapseBody') : $t('paperDetail.showFullPaper')"></button>
                  <div x-show="bodyExpanded" class="prose prose-ink max-w-reading text-ink-light text-[0.95rem] leading-relaxed" x-markdown="bodyWithoutAbstract"></div>
                </div>
              </template>
            </article>

            <!-- Citations / References -->
            <template x-if="paper.citations && paper.citations.length > 0">
              <section class="mt-8">
                <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('paperDetail.referencesTitle')"></h2>
                <div class="space-y-2">
                  <template x-for="c in paper.citations" :key="c.author + '/' + c.permlink">
                    <a :href="$lp('/paper/' + c.author + '/' + c.permlink)" @click.prevent="navigate('/paper/' + c.author + '/' + c.permlink)"
                       class="card block no-underline hover:shadow-sm transition-shadow">
                      <p class="text-sm font-medium text-ink" x-text="c.title"></p>
                      <p class="text-xs text-ink-muted mt-1" x-text="'@' + c.author"></p>
                    </a>
                  </template>
                </div>
              </section>
            </template>

            <!-- Supplementary Files -->
            <template x-if="supplementaryFiles.length > 0">
              <section class="mt-8">
                <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('paperDetail.supplementaryFiles')"></h2>
                <div class="space-y-2">
                  <template x-for="sf in supplementaryFiles" :key="sf.cid">
                    <a :href="supplementaryFileUrl(sf.cid)" target="_blank" rel="noopener noreferrer"
                       class="card flex items-center gap-3 no-underline hover:shadow-sm transition-shadow">
                      <svg class="h-5 w-5 shrink-0 text-pevo-teal" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd" /></svg>
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium text-ink truncate" x-text="sf.filename"></p>
                        <p class="text-xs text-ink-muted" x-text="(sf.description ? sf.description + ' · ' : '') + formatFileSize(sf.size)"></p>
                      </div>
                    </a>
                  </template>
                </div>
              </section>
            </template>

            <!-- Enrichment-unavailable hint: shown when the lazy enrichment
                 fetch returned a retriable 503 AND no prior enrichment
                 payload has loaded. Gated on !enrichmentLoaded so a refresh
                 failure from a claim-mutation flow does not contradict the
                 still-visible reviews data below. The hint's retry path is
                 wrapped by retryEnrichment so concurrent rapid clicks
                 cannot race two fetchPaperEnrichment calls. -->
            <template x-if="enrichmentRetriable && !enrichmentLoaded">
              <div class="mt-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <p class="text-sm text-amber-800" x-text="$t('paperDetail.enrichmentUnavailable')"></p>
                <button type="button" class="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed" data-testid="enrichment-retry"
                        :disabled="enrichmentRetrying"
                        @click="retryEnrichment()" x-text="$t('common.retry')"></button>
              </div>
            </template>

            <!-- Reviews section -->
            <section class="mt-8">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <h2 class="text-section-title text-ink font-serif" x-text="$t('paperDetail.peerReviewsTitle', { count: paper.reviews ? paper.reviews.length : 0 })"></h2>
                <a x-show="!isOwnPaper"
                   :href="$lp('/review/' + paper.author + '/' + paper.permlink)"
                   @click.prevent="navigate('/review/' + paper.author + '/' + paper.permlink)"
                   class="btn-primary text-sm w-full sm:w-auto text-center shrink-0 no-underline" x-text="$t('paperDetail.writeReview')"></a>
              </div>

              <!-- Average ratings -->
              <template x-if="averageRatings">
                <div class="card mb-6">
                  <h3 class="text-sm font-semibold text-ink mb-3" x-text="$t('paperDetail.averageRatings', { count: paper.reviews.length })"></h3>
                  <div class="space-y-2">
                    <template x-for="[key, label] in [['methodology', $t('review.methodology')], ['novelty', $t('review.novelty')], ['clarity', $t('review.clarity')], ['significance', $t('review.significance')]]" :key="key">
                      <div class="flex items-center gap-3 text-sm">
                        <span class="w-28 text-ink-muted shrink-0" x-text="label"></span>
                        <div class="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
                          <div class="h-full bg-pevo-teal rounded-full transition-all" :style="\`width: \${(averageRatings[key] / 5) * 100}%\`"></div>
                        </div>
                        <span class="w-8 text-right font-medium text-ink" x-text="averageRatings[key] + '/5'"></span>
                      </div>
                    </template>
                  </div>
                </div>
              </template>

              <!-- Individual reviews -->
              <template x-if="paper.reviews && paper.reviews.length > 0">
                <div class="space-y-4">
                  <template x-for="rev in paper.reviews" :key="rev.permlink">
                    <div class="card" :id="'review-' + rev.author.replace(/[\\/\\.]/g, '-') + '-' + rev.permlink.replace(/[\\/\\.]/g, '-')">
                      <!-- Review header -->
                      <div class="flex items-start justify-between mb-4">
                        <div>
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-ink" x-text="rev.is_anonymous ? $t('review.anonymousReviewer') : ('@' + rev.author)"></span>
                            <template x-if="rev.is_accredited">
                              <span class="badge-accredited" :title="$t('badge.accreditedTitle')">
                                <svg class="mr-1 h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                  <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
                                </svg>
                                <span x-text="$t('badge.accredited')"></span>
                              </span>
                            </template>
                            <template x-if="rev.is_anonymous">
                              <span class="text-xs px-2 py-0.5 rounded bg-parchment-warm text-ink-muted" x-text="$t('review.anonymous')"></span>
                            </template>
                          </div>
                          <div class="flex items-center gap-2">
                            <time class="text-xs text-ink-muted" :datetime="rev.created" x-text="formatDate(rev.created)"></time>
                            <template x-if="rev.reviewed_version">
                              <span class="text-xs text-ink-muted" x-text="'· ' + $t('review.reviewedVersion', { version: String(rev.reviewed_version) })"></span>
                            </template>
                            <template x-if="rev.outdated">
                              <span class="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800" x-text="$t('versions.outdated', { version: String(rev.reviewed_version || 1) })"></span>
                            </template>
                            <template x-if="rev.addressed_by_version">
                              <span class="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800" x-text="$t('versions.addressedInVersion', { version: String(rev.addressed_by_version) })"></span>
                            </template>
                          </div>
                        </div>
                        <div x-data="voteButtons({ author: rev.author, permlink: rev.permlink, netVotes: rev.net_votes })" @click.outside="selectorOpen = false" class="shrink-0">
                          <template x-if="isAccredited">
                            <div class="relative">
                              <button type="button" class="flex items-center gap-1 text-xs px-2 py-1 rounded border border-parchment-dark hover:bg-parchment-warm transition-colors"
                                      @click="selectorOpen = !selectorOpen" :disabled="isVoting">
                                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                                <span x-text="displayVotes"></span>
                                <svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" /></svg>
                              </button>
                              <div x-show="selectorOpen" x-transition class="absolute right-0 rtl:right-auto rtl:left-0 mt-1 w-52 rounded-lg border border-parchment-dark bg-parchment shadow-md z-20">
                                <template x-for="level in voteLevels" :key="level.weight">
                                  <button type="button" class="block w-full text-left px-3 py-1.5 text-xs border-b border-parchment-dark/30 last:border-0 transition-colors"
                                          :class="level.cls + (currentWeight === level.weight ? ' font-semibold ring-1 ring-inset ring-current' : '')"
                                          @click="handleVote(level.weight)" :disabled="isVoting">
                                    <span x-text="$t(level.label)"></span>
                                  </button>
                                </template>
                                <template x-if="voteState !== 'none'">
                                  <button type="button" class="block w-full text-left px-3 py-1.5 text-xs text-ink-muted border-t border-parchment-dark/30 hover:bg-parchment-dark/10 transition-colors"
                                          @click="handleVote(0)" :disabled="isVoting">
                                    <span x-text="$t('vote.retract')"></span>
                                  </button>
                                </template>
                              </div>
                            </div>
                          </template>
                          <template x-if="!isAccredited">
                            <div class="flex items-center gap-1 text-xs text-ink-muted">
                              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                              <span x-text="displayVotes"></span>
                            </div>
                          </template>
                        </div>
                      </div>

                      <!-- Ratings -->
                      <div class="space-y-2 mb-4 p-4 bg-parchment rounded-lg">
                        <template x-for="[rKey, rLabel] in [['methodology', $t('review.methodology')], ['novelty', $t('review.novelty')], ['clarity', $t('review.clarity')], ['significance', $t('review.significance')]]" :key="rKey">
                          <div class="flex items-center gap-3 text-sm">
                            <span class="w-28 text-ink-muted shrink-0" x-text="rLabel"></span>
                            <div class="flex-1 h-2 bg-parchment-warm rounded-full overflow-hidden">
                              <div class="h-full bg-pevo-teal rounded-full transition-all" :style="\`width: \${(rev.rating[rKey] / 5) * 100}%\`"></div>
                            </div>
                            <span class="w-8 text-right font-medium text-ink" x-text="rev.rating[rKey] + '/5'"></span>
                          </div>
                        </template>
                      </div>

                      <!-- Review body -->
                      <div class="text-sm text-ink-light leading-relaxed prose prose-sm max-w-none" x-markdown="rev.body"></div>

                      <!-- Review comments (lazy-loaded) -->
                      <div class="mt-4 pt-3 border-t border-parchment-dark/30" x-data="{ showComments: false }">
                        <button type="button"
                                class="text-xs text-ink-muted hover:text-pevo-teal transition-colors flex items-center gap-1"
                                @click="showComments = !showComments">
                          <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H6l-4 4V5z" clip-rule="evenodd" /></svg>
                          <span x-text="$t('comments.reply')"></span>
                        </button>
                        <template x-if="showComments">
                          <div class="mt-3" x-data="threadedComments({ paperAuthor: rev.author, paperPermlink: rev.permlink })"
                               x-on:comment-posted.window="loadComments()">
                            <!-- Loading -->
                            <p x-show="loading" class="text-xs text-ink-muted" x-text="$t('comments.loading')"></p>
                            <!-- Error -->
                            <p x-show="error" class="text-xs text-pevo-crimson" x-text="error"></p>
                            <button x-show="errorRetriable" type="button" @click="loadComments()"
                                    class="btn-primary text-xs mt-2" data-testid="comments-retry"
                                    x-text="$t('common.retry')"></button>
                            <!-- Comment count -->
                            <p x-show="!loading && totalCount === 0" class="text-xs text-ink-muted" x-text="$t('review.noComments')"></p>
                            <p x-show="!loading && totalCount > 0" class="text-xs text-ink-muted mb-2" x-text="$t('review.commentsToggle', { count: totalCount })"></p>
                            <!-- Comment tree -->
                            <div x-show="!loading && totalCount > 0" x-html="commentsHtml" class="space-y-3"></div>
                            <!-- Composer -->
                            <template x-if="$store.auth.isConnected">
                              <div class="mt-3" x-data="commentComposer({ parentAuthor: rev.author, parentPermlink: rev.permlink })">
                                <textarea class="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-pevo-teal focus:outline-none focus:ring-1 focus:ring-pevo-teal resize-y"
                                          rows="2" :placeholder="$t('comments.replyTo', { author: rev.is_anonymous ? $t('review.anonymousReviewer') : rev.author })"
                                          x-model="body" :disabled="isSubmitting"></textarea>
                                <p x-show="error" class="text-xs text-pevo-crimson mt-1" x-text="error"></p>
                                <div class="flex items-center justify-end gap-2 mt-2">
                                  <button class="btn-primary text-xs" @click="handleSubmit()" :disabled="isSubmitting || !body.trim()"
                                          x-text="isSubmitting ? $t('comments.posting') : $t('comments.postComment')"></button>
                                </div>
                              </div>
                            </template>
                          </div>
                        </template>
                      </div>
                    </div>
                  </template>
                </div>
              </template>

              <!-- No reviews -->
              <template x-if="!paper.reviews || paper.reviews.length === 0">
                <div class="card text-center py-8">
                  <template x-if="!isOwnPaper">
                    <div>
                      <p class="text-ink-muted mb-3" x-text="$t('paperDetail.noReviews')"></p>
                      <a :href="$lp('/review/' + paper.author + '/' + paper.permlink)"
                         @click.prevent="navigate('/review/' + paper.author + '/' + paper.permlink)"
                         class="btn-primary text-sm no-underline" x-text="$t('paperDetail.writeReview')"></a>
                    </div>
                  </template>
                  <template x-if="isOwnPaper">
                    <p class="text-ink-muted" x-text="$t('paperDetail.noReviewsYet')"></p>
                  </template>
                </div>
              </template>
            </section>

            <!-- Discussion section -->
            <section class="mt-8" x-data="threadedComments({ paperAuthor: paper.author, paperPermlink: paper.permlink })"
                     x-on:comment-posted.window="loadComments()">
              <h2 class="text-section-title text-ink font-serif mb-4" x-text="$t('comments.titleWithCount', { count: totalCount })"></h2>

              <!-- Loading -->
              <p x-show="loading" class="text-sm text-ink-muted" x-text="$t('comments.loading')"></p>

              <!-- Error -->
              <p x-show="error" class="text-sm text-pevo-crimson" x-text="error"></p>
              <button x-show="errorRetriable" type="button" @click="loadComments()"
                      class="btn-primary text-sm mt-2" data-testid="discussion-retry"
                      x-text="$t('common.retry')"></button>

              <!-- Top-level comment composer -->
              <template x-if="$store.auth.isConnected">
                <div class="mb-4" x-data="commentComposer({ parentAuthor: paper.author, parentPermlink: paper.permlink })">
                  <textarea class="w-full rounded-md border border-parchment-dark bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-pevo-teal focus:outline-none focus:ring-1 focus:ring-pevo-teal resize-y"
                            rows="3" :placeholder="$t('comments.startDiscussion')"
                            x-model="body" :disabled="isSubmitting"></textarea>
                  <p x-show="error" class="text-xs text-pevo-crimson mt-1" x-text="error"></p>
                  <div class="flex justify-end mt-2">
                    <button class="btn-primary text-sm" @click="handleSubmit()" :disabled="isSubmitting || !body.trim()"
                            x-text="isSubmitting ? $t('comments.posting') : $t('comments.postComment')"></button>
                  </div>
                </div>
              </template>

              <!-- Connect prompt -->
              <template x-if="!$store.auth.isConnected">
                <p class="text-sm text-ink-muted mb-4" x-text="$t('comments.connectToComment')"></p>
              </template>

              <!-- No comments -->
              <template x-if="!loading && !error && totalCount === 0">
                <p class="text-sm text-ink-muted" x-text="$t('comments.noComments')"></p>
              </template>

              <!-- Threaded comments -->
              <div x-show="!loading && totalCount > 0" class="space-y-4" x-html="commentsHtml"></div>
            </section>
          </div>
        </template>
      </div>
`;
export { template as paperDetailPageTemplate };

export function initPaperDetailPage() {
  Alpine.data('paperDetailPage', () => ({
    ...createTimerGuard(),
    titleCaseDiscipline,
    paper: null,
    loading: true,
    error: null,
    // Set true alongside `error` when the failure was a retriable 503 from
    // the backend HAF-outage translator. The template swaps the description
    // copy so the user sees "temporarily unavailable" instead of the
    // not-found phrasing while still surfacing the same retry button.
    errorIs503: false,
    enrichmentLoaded: false,
    // Set true when the enrichment fetch fails with a retriable 503. Drives
    // a small "Enrichment temporarily unavailable" hint above the reviews
    // section; cleared at the top of each (re)load. The template gates the
    // hint on !enrichmentLoaded so a refresh-time failure does not show a
    // banner above stale-but-valid review data from the initial load.
    enrichmentRetriable: false,
    // In-flight guard for the enrichment retry button. Set synchronously at
    // retryEnrichment() entry, cleared in finally, so a rapid double-click
    // cannot fire two concurrent fetchPaperEnrichment calls.
    enrichmentRetrying: false,

    // Citation export
    citeOpen: false,
    citeLoading: false,

    // Retraction
    retractDialogOpen: false,
    retractReason: '',
    retractLoading: false,


    // Version switching
    viewingVersion: null,

    // Authorship claims / consent affordances
    claimLoading: false,
    // Lazily-fetched (light accounts only) password-factor availability for the
    // fresh-auth challenge; null = not yet resolved. See _authCtx().
    _hasPassword: null,
    // Confirmation modals for the withdraw-credit actions (resign / revoke), and
    // the per-paper "..." actions menu that hosts resign.
    resignModalOpen: false,
    revokeModalOpen: false,
    revokeTarget: null,
    moreMenuOpen: false,

    // Paper body collapse
    bodyExpanded: false,

    // Version diff
    diffMode: false,
    diffVersionA: null,
    diffVersionB: null,
    diffResult: null,
    diffLoading: false,
    diffError: null,
    pickingDiffVersions: false,

    // Expose helper
    formatDate,
    canonicalOrcid,
    shouldShowDiscrepancyIndicator,
    safeExternalUrl,

    get author() {
      return this.$store.router.params.author;
    },

    get permlink() {
      return this.$store.router.params.permlink;
    },

    init() {
      this.loadPaper();
    },

    destroy() {
      // Post-await `if (!this._mounted) return;` guards in all retry loops
      // prevent state mutation after destroy; teardown here releases the
      // timer closure references those loops hold.
      this._teardownTimers();
    },

    async loadPaper() {
      const author = this.author;
      const permlink = this.permlink;
      this.loading = true;
      this.error = null;
      this.errorIs503 = false;
      // Retry on NOT_FOUND to cover the HAF indexing window right after a publish/bridge.
      const notFoundRetryDelaysMs = [2000, 2000, 2000];
      // Retry on retriable SERVICE_UNAVAILABLE (backend HAF-outage translator)
      // since the backend's `details.retriable: true` flag is an explicit invite
      // to retry. Same shape as the NOT_FOUND loop; kept as a separate constant
      // so future tuning of either window stays independent.
      const serviceUnavailableRetryDelaysMs = [2000, 2000, 2000];
      let notFoundAttempt = 0;
      let serviceUnavailableAttempt = 0;
      while (true) {
        try {
          const res = await fetchPaper(author, permlink);
          if (this.author !== author || this.permlink !== permlink) return;
          this.paper = res.data;
          if (this.paper.title) document.title = `${this.paper.title} — PEvO`;
          // Load enrichment lazily (reviews, votes, versions, DOI)
          this.loadEnrichment();
          break;
        } catch (err) {
          if (this.author !== author || this.permlink !== permlink) return;
          if (err?.code === 'NOT_FOUND' && notFoundAttempt < notFoundRetryDelaysMs.length) {
            await this._sleep(notFoundRetryDelaysMs[notFoundAttempt]);
            if (!this._mounted) return;
            if (this.author !== author || this.permlink !== permlink) return;
            notFoundAttempt++;
            continue;
          }
          if (
            isRetriable503(err)
            && serviceUnavailableAttempt < serviceUnavailableRetryDelaysMs.length
          ) {
            await this._sleep(serviceUnavailableRetryDelaysMs[serviceUnavailableAttempt]);
            if (!this._mounted) return;
            if (this.author !== author || this.permlink !== permlink) return;
            serviceUnavailableAttempt++;
            continue;
          }
          // Semantic-code carve-out: NOT_FOUND renders a dedicated localized title;
          // SERVICE_UNAVAILABLE retriable surfaces a transient-failure title plus
          // a description that reads "temporarily unavailable" rather than the
          // not-found phrasing. Every other caught error is sanitized to a
          // generic key; raw err -> console.warn.
          if (err?.code === 'NOT_FOUND') {
            this.error = this.$t('paperDetail.notFoundTitle');
          } else if (isRetriable503(err)) {
            this.error = this.$t('paperDetail.serviceUnavailableTitle');
            this.errorIs503 = true;
          } else {
            console.warn('[paper detail load]', err);
            this.error = this.$t('paperDetail.errorLoadingTitle');
          }
          break;
        }
      }
      this.loading = false;
    },

    async loadEnrichment() {
      if (!this.paper) return;
      const author = this.author;
      const permlink = this.permlink;
      this.enrichmentRetriable = false;
      try {
        const res = await fetchPaperEnrichment(author, permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        const d = res.data;
        this.paper.reviews = d.reviews || [];
        this.paper.net_votes = d.net_votes ?? this.paper.net_votes;
        this.paper.vote_strength = d.vote_strength || null;
        this.paper.voters = d.voters || [];
        this.paper.authorship_claims = d.authorship_claims || [];
        this.enrichmentLoaded = true;
        // Scroll to review if URL has a hash fragment
        this.scrollToHashReview();
      } catch (err) {
        if (this.author !== author || this.permlink !== permlink) return;
        if (isRetriable503(err)) {
          // Recognized transient failure surfaces via the enrichmentRetriable
          // banner; no log line — the user already has a UI affordance and
          // a HAF outage would otherwise multiply this warn per claim
          // mutation per user.
          this.enrichmentRetriable = true;
        } else {
          console.warn('Paper enrichment failed', err);
        }
      }
    },

    // Wraps loadEnrichment with an in-flight flag so the retry banner's
    // button can disable itself during the round-trip. Without this, a
    // rapid double-click produces two concurrent fetchPaperEnrichment
    // calls racing for last-write on this.paper.reviews and friends.
    async retryEnrichment() {
      if (this.enrichmentRetrying) return;
      this.enrichmentRetrying = true;
      try {
        await this.loadEnrichment();
      } finally {
        this.enrichmentRetrying = false;
      }
    },

    scrollToHashReview() {
      const hash = window.location.hash;
      if (!hash || !hash.startsWith('#review-')) return;
      requestAnimationFrame(() => {
        const el = document.getElementById(hash.slice(1));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },

    get isOwnPaper() {
      const username = this.$store.auth.username;
      if (!username || !this.paper) return false;
      if (username === this.paper.author) return true;
      const authors = this.paper.authors || [];
      if (authors.some(a => a.hive === username)) return true;
      const claims = this.paper.authorship_claims || [];
      return claims.some(c => c.claimer === username && c.status === 'accepted');
    },

    get averageRatings() {
      if (!this.paper?.reviews?.length) return null;
      const reviewsWithRatings = this.paper.reviews.filter(r => r.rating);
      if (!reviewsWithRatings.length) return null;
      const sum = { methodology: 0, novelty: 0, clarity: 0, significance: 0 };
      for (const r of reviewsWithRatings) {
        sum.methodology += r.rating.methodology || 0;
        sum.novelty += r.rating.novelty || 0;
        sum.clarity += r.rating.clarity || 0;
        sum.significance += r.rating.significance || 0;
      }
      const n = reviewsWithRatings.length;
      return {
        methodology: Math.round((sum.methodology / n) * 10) / 10,
        novelty: Math.round((sum.novelty / n) * 10) / 10,
        clarity: Math.round((sum.clarity / n) * 10) / 10,
        significance: Math.round((sum.significance / n) * 10) / 10,
      };
    },

    get bodyWithoutAbstract() {
      if (!this.paper?.body) return '';
      const sep = this.paper.body.indexOf('\n\n---\n\n');
      if (sep === -1) return '';
      return this.paper.body.slice(sep + 7);
    },

    get hasFullText() {
      return this.bodyWithoutAbstract.length > 0;
    },

    get isBridgePaper() {
      return this.paper?.json_metadata?.[getAppTag()]?.type === 'bridge_paper';
    },

    get bridgeSource() {
      if (!this.isBridgePaper) return null;
      return this.paper.json_metadata[getAppTag()].source || null;
    },

    get ipfsGateway() {
      return (window.__PEVO_CONFIG__?.ipfsGateway) || '/api/ipfs/';
    },

    get ipfsUrl() {
      if (!this.paper?.ipfs_cid) return null;
      return `${this.ipfsGateway}${this.paper.ipfs_cid}`;
    },

    get supplementaryFiles() {
      return this.paper?.supplementary_files || this.paper?.json_metadata?.[getAppTag()]?.supplementary_files || [];
    },

    supplementaryFileUrl(cid) {
      return `${this.ipfsGateway}${cid}`;
    },

    formatFileSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    },

    get currentVersion() {
      if (this.viewingVersion) return this.viewingVersion;
      if (!this.paper?.versions?.length) return 1;
      return this.paper.versions[this.paper.versions.length - 1]?.version_number ?? 1;
    },

    get sortedVersions() {
      if (!this.paper?.versions) return [];
      return [...this.paper.versions].sort((a, b) => a.version_number - b.version_number);
    },

    get latestVersion() {
      const sorted = this.sortedVersions;
      return sorted.length ? sorted[sorted.length - 1].version_number : 1;
    },

    async loadVersion(version) {
      if (version === this.currentVersion) return;
      const author = this.author;
      const permlink = this.permlink;
      this.loading = true;
      try {
        const res = await fetchPaper(author, permlink, version);
        if (this.author !== author || this.permlink !== permlink) return;
        this.paper = res.data;
        this.viewingVersion = version;
      } catch (err) {
        if (this.author !== author || this.permlink !== permlink) return;
        console.warn('[paper detail load version]', err);
        this.$store.toast.show(this.$t('common.loadVersionFailed'), 'error');
      } finally {
        this.loading = false;
      }
    },

    // Add to citation collection
    addToCollection() {
      if (!this.paper) return;
      const key = 'pevo-citation-collection';
      let collection = [];
      const raw = localStorage.getItem(key);
      if (raw) collection = JSON.parse(raw);

      const entry = { author: this.paper.author, permlink: this.paper.permlink, title: this.paper.title };
      const exists = collection.some(c => c.author === entry.author && c.permlink === entry.permlink);
      if (exists) {
        this.$store.toast.show(this.$t('citation.alreadyInCollection'), 'info');
        return;
      }
      collection.push(entry);
      localStorage.setItem(key, JSON.stringify(collection));
      this.$store.toast.show(this.$t('citation.addedToCollection'), 'success');
    },

    // Citation export
    async handleCitationExport(format) {
      // Capture paper identity at entry; the retry loop re-uses these
      // closures rather than reading this.author/this.permlink, so a
      // mid-backoff tab-switch to another paper does not produce a
      // download named for the new paper containing data for the prior
      // one (the post-await identity guard then bails the in-flight loop).
      const author = this.author;
      const permlink = this.permlink;
      this.citeLoading = true;
      this.citeOpen = false;
      // Read-only path; the backend's `/cite` endpoint has no rate-limiter
      // slot concern, so a small auto-retry on retriable SERVICE_UNAVAILABLE
      // is safe and saves the user a manual round-trip during a transient
      // HAF blip. Backoff stays bounded to avoid pinning the citation
      // dropdown's loading state on a long outage.
      const serviceUnavailableRetryDelaysMs = [1500, 2500];
      let serviceUnavailableAttempt = 0;
      try {
        while (true) {
          try {
            const data = await fetchCitationExport(author, permlink, format);
            if (this.author !== author || this.permlink !== permlink) return;
            if (format === 'apa') {
              await navigator.clipboard.writeText(data.content);
              this.$store.toast.show(this.$t('citation.copiedToClipboard'), 'success');
            } else {
              const ext = format === 'bibtex' ? 'bib' : 'ris';
              const mimeType = format === 'bibtex' ? 'application/x-bibtex' : 'application/x-research-info-systems';
              const blob = new Blob([data.content], { type: mimeType });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${permlink}.${ext}`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              this.$store.toast.show(this.$t('citation.downloadStarted'), 'success');
            }
            break;
          } catch (err) {
            if (
              isRetriable503(err)
              && serviceUnavailableAttempt < serviceUnavailableRetryDelaysMs.length
            ) {
              await this._sleep(serviceUnavailableRetryDelaysMs[serviceUnavailableAttempt]);
              if (!this._mounted) return;
              if (this.author !== author || this.permlink !== permlink) return;
              serviceUnavailableAttempt++;
              continue;
            }
            if (this.author !== author || this.permlink !== permlink) return;
            // Retriable 503 surfaces a distinct toast so the user knows to
            // retry the action shortly. 400 (bad format) and 404 (paper not
            // found, generator dispatch failed) fall through to the generic
            // sanitized branch.
            if (isRetriable503(err)) {
              this.$store.toast.show(this.$t('citation.serviceUnavailable'), 'error');
            } else {
              console.warn('[paper detail citation export]', err);
              this.$store.toast.show(this.$t('citation.exportFailed'), 'error');
            }
            break;
          }
        }
      } finally {
        // Reset unconditionally. The captured `author`/`permlink` closures on
        // `fetchCitationExport` and the download filename already prevent the
        // tab-switch corrupt-download race; guarding `citeLoading = false`
        // on identity additionally would leak the loading state across
        // /paper/A -> /paper/B navigation (the same paperDetailPage instance
        // persists because page-mount.js re-renders Alpine only on route NAME
        // change, not param change), permanently disabling paper B's citation
        // buttons until full reload.
        this.citeLoading = false;
      }
    },

    // Retraction
    async handleRetract() {
      const username = this.$store.auth.username;
      if (!username) return;
      this.retractLoading = true;
      try {
        await retractPaper(this.author, this.permlink, this.retractReason);
        this.$store.toast.show(this.$t('retraction.success'), 'success');
        this.retractDialogOpen = false;
        // Refresh paper
        const res = await fetchPaper(this.author, this.permlink);
        this.paper = res.data;
      } catch (err) {
        // Manual retry only on retriable SERVICE_UNAVAILABLE. Retract is a
        // destructive, irreversible write op that publishes a chain-visible
        // edit, so positive user confirmation per attempt is the right
        // posture regardless of how the backend limiter handles failures.
        // The retract dialog stays open on error so the user can re-click
        // "Confirm Retraction" themselves; the toast distinguishes the
        // transient failure from a permanent one.
        if (isRetriable503(err)) {
          this.$store.toast.show(this.$t('retraction.serviceUnavailable'), 'error');
        } else {
          console.warn('[paper detail retract]', err);
          this.$store.toast.show(this.$t('retraction.failed'), 'error');
        }
      } finally {
        this.retractLoading = false;
      }
    },

    formatShortDate(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleDateString(Alpine.store('i18n').locale, {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    },

    selectDiffVersions() {
      if (this.diffMode || this.pickingDiffVersions) {
        this.exitDiff();
        return;
      }
      this.pickingDiffVersions = true;
      this.diffVersionA = null;
      this.diffVersionB = null;
      this.diffResult = null;
      this.diffError = null;
    },

    pickDiffVersion(versionNumber) {
      if (!this.pickingDiffVersions) return;
      if (this.diffVersionA === null) {
        this.diffVersionA = versionNumber;
      } else if (this.diffVersionB === null) {
        if (versionNumber === this.diffVersionA) return;
        this.diffVersionB = versionNumber;
        // Auto-sort so A < B
        const a = Math.min(this.diffVersionA, this.diffVersionB);
        const b = Math.max(this.diffVersionA, this.diffVersionB);
        this.diffVersionA = a;
        this.diffVersionB = b;
        this.pickingDiffVersions = false;
        this.startDiff(a, b);
      }
    },

    async startDiff(vA, vB) {
      this.diffLoading = true;
      this.diffError = null;
      try {
        const [resA, resB] = await Promise.all([
          fetchPaper(this.author, this.permlink, vA),
          fetchPaper(this.author, this.permlink, vB),
        ]);
        this.diffResult = computeVersionDiff(resA.data, resB.data);
        this.diffMode = true;
      } catch (err) {
        console.warn('[paper detail diff]', err);
        this.diffError = this.$t('common.diffLoadFailed');
        this.$store.toast.show(this.diffError, 'error');
      } finally {
        this.diffLoading = false;
      }
    },

    exitDiff() {
      this.diffMode = false;
      this.diffVersionA = null;
      this.diffVersionB = null;
      this.diffResult = null;
      this.diffLoading = false;
      this.diffError = null;
      this.pickingDiffVersions = false;
    },

    // ─── Authorship claims ─────────────────────────────────────

    claimStatusForSlot(idx) {
      const claims = this.paper?.authorship_claims || [];
      const claim = claims.find(c => c.author_index === idx);
      return claim ? claim.status : null;
    },

    pendingClaimerForSlot(idx) {
      const claims = this.paper?.authorship_claims || [];
      const claim = claims.find(c => c.author_index === idx && c.status === 'pending');
      return claim ? claim.claimer : null;
    },

    canClaimSlot(idx) {
      const username = this.$store.auth.username;
      if (!username || !this.$store.auth.isConnected) return false;
      if (!this.$store.auth.isAccredited) return false;
      // Already has a non-revoked claim on this paper
      const claims = this.paper?.authorship_claims || [];
      if (claims.some(c => c.claimer === username)) return false;
      // Slot must be unclaimed
      if (this.claimStatusForSlot(idx)) return false;
      // Heuristic: slot matches user's hive username or ORCID
      const author = this.paper.authors[idx];
      if (!author) return false;
      if (author.hive === username) return true;
      // Name match heuristic: if the user's accreditation name is set, check partial match
      const accName = this.$store.auth.accreditation?.name;
      if (accName && author.name && author.name.toLowerCase().includes(accName.toLowerCase())) return true;
      return false;
    },

    get canClaimUnlisted() {
      const username = this.$store.auth.username;
      if (!username || !this.$store.auth.isConnected) return false;
      if (!this.$store.auth.isAccredited) return false;
      // Already has a claim
      const claims = this.paper?.authorship_claims || [];
      if (claims.some(c => c.claimer === username)) return false;
      // Not listed as a hive author on any slot
      const authors = this.paper?.authors || [];
      if (authors.some(a => a.hive === username)) return false;
      // Don't show if user can claim a specific slot
      for (let i = 0; i < authors.length; i++) {
        if (this.canClaimSlot(i)) return false;
      }
      return true;
    },

    get canManageClaims() {
      const username = this.$store.auth.username;
      if (!username || !this.$store.auth.isConnected) return false;
      return username === this.paper?.author;
    },

    // ── Unified credit badge (decision β) ──────────────────────────
    creditedForSlot(idx) {
      return isSlotCredited(this.paper?.authors?.[idx], this.paper?.authorship_claims, idx);
    },

    creditProfileForSlot(idx) {
      return creditProfileForSlotFn(this.paper?.authors?.[idx], this.paper?.authorship_claims, idx);
    },

    acceptedClaimerForSlot(idx) {
      return acceptedClaimerForSlotFn(this.paper?.authorship_claims, idx);
    },

    // Post author/admin backstop: revoke an ACCEPTED name-only Route-3 claim.
    // Shown only on slots credited via an accepted claim (the slot carries no
    // hive, so the credit comes from the claim, not a Route-1/2 consent).
    canRevokeSlot(idx) {
      if (!this.canManageClaims) return false;
      return this.acceptedClaimerForSlot(idx) !== null;
    },

    // The accepted Route-3 claimer drops their OWN credit on slot `idx`.
    canWithdrawSlot(idx) {
      const username = this.$store.auth.username;
      if (!username || !this.$store.auth.isConnected) return false;
      return this.acceptedClaimerForSlot(idx) === username;
    },

    // ── Route-2 anchored-slot accept / resign ──────────────────────
    // Accept eligibility is backend-authoritative: the paper appears in the
    // user's pending_consents (anchored slots awaiting their author_accept,
    // resolved by hive OR attested-ORCID anchor, already-consented excluded).
    // This avoids client-side anchor resolution, which the hive-keyed `consented`
    // flag cannot do for an ORCID-only slot.
    get canAcceptHere() {
      const auth = this.$store.auth;
      if (!auth.username || !auth.isConnected || !auth.isAccredited) return false;
      const pending = this.$store.authorships?.pendingConsents || [];
      return pending.some(c => c.paper_author === this.author && c.paper_permlink === this.permlink);
    },

    // Resign applies to a co-author currently consented via the anchored route:
    // a hive slot the user owns whose `consented` flag is set. The root
    // broadcaster (Route 1) is excluded — their consent is the post itself.
    get canResignHere() {
      const username = this.$store.auth.username;
      if (!username || !this.$store.auth.isConnected) return false;
      if (username === this.paper?.author) return false;
      const authors = this.paper?.authors || [];
      return authors.some(a => a.hive === username && a.consented === true);
    },

    confirmRevoke(claimer) {
      if (!claimer) return;
      this.revokeTarget = claimer;
      this.revokeModalOpen = true;
    },

    // Resolve the fresh-auth context. Self-custody needs none; for light accounts
    // the password-vs-ORCID factor turns on whether the account carries a
    // password, fetched lazily once (every accredited account has a linked ORCID,
    // so an unknown/failed fetch safely falls back to the ORCID factor).
    async _authCtx() {
      const auth = this.$store.auth;
      const ctx = { custody: auth.custody, username: auth.username, hasPassword: false };
      if (auth.custody === 'light') {
        if (this._hasPassword === null) {
          try {
            const res = await fetchEmailStatus();
            this._hasPassword = res?.data?.hasPassword === true;
          } catch {
            this._hasPassword = false;
          }
        }
        ctx.hasPassword = this._hasPassword;
      }
      return ctx;
    },

    async _refreshPending() {
      const store = this.$store.authorships;
      if (store && typeof store.refresh === 'function') await store.refresh();
    },

    // Shared broadcast path for every consent/credit op: mint the target-bound
    // fresh-auth proof (light accounts) or sign via Keychain (self-custody),
    // broadcast, then on success toast + refresh the badge and pending lists.
    // Returns true on a completed broadcast, false on a clean abort (ORCID
    // redirect / cancelled modal) or a surfaced re-auth failure. Throws on
    // unexpected broadcast errors for the caller's op-level handler to catch.
    async _broadcastConsentOp(target, op, successKey) {
      const username = this.$store.auth.username;
      const ctx = await this._authCtx();
      const outcome = await withAuthorshipFreshAuth(
        target,
        ctx,
        (proof) => broadcastOps(username, [op], proof ? { freshAuthProof: proof } : {}),
      );
      // sessionInconsistent: the orchestrator already tore the session down and
      // showed the re-login toast, so abort cleanly without a second toast.
      if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) return false;
      if (outcome.freshAuthFailed) {
        this.$store.toast.show(this.$t('claims.reauthFailed'), 'error');
        return false;
      }
      this.$store.toast.show(this.$t(successKey), 'success');
      await this.loadEnrichment();
      await this._refreshPending();
      return true;
    },

    async handleClaimSlot(authorIndex) {
      if (this.claimLoading) return;
      const username = this.$store.auth.username;
      if (!username) return;
      this.claimLoading = true;
      try {
        const res = await claimAuthorship(this.author, this.permlink, authorIndex);
        const op = res.data?.operation;
        if (op) {
          const target = {
            action: 'claim_authorship',
            rootAuthor: this.author,
            rootPermlink: this.permlink,
            authorIndex: authorIndex ?? null,
          };
          await this._broadcastConsentOp(target, op, 'claims.claimSubmitted');
        }
      } catch (err) {
        console.warn('[paper detail claim slot]', err);
        this.$store.toast.show(this.$t('claims.claimFailed'), 'error');
      } finally {
        this.claimLoading = false;
      }
    },

    async handleApproveClaim(claimer, authorIndex) {
      if (this.claimLoading) return;
      const username = this.$store.auth.username;
      if (!username) return;
      this.claimLoading = true;
      try {
        const res = await approveAuthorshipClaim(this.author, this.permlink, claimer, authorIndex);
        if (res.data?.tx_id) {
          // Server-side broadcast (bridge papers, signed with the bridge key) —
          // no client fresh-auth needed.
          this.$store.toast.show(this.$t('claims.approveSuccess'), 'success');
          await this.loadEnrichment();
          await this._refreshPending();
        } else if (res.data?.operation) {
          const target = {
            action: 'approve_authorship',
            rootAuthor: this.author,
            rootPermlink: this.permlink,
            authorIndex,
            claimer,
          };
          await this._broadcastConsentOp(target, res.data.operation, 'claims.approveSuccess');
        }
      } catch (err) {
        console.warn('[paper detail approve claim]', err);
        this.$store.toast.show(this.$t('claims.approveFailed'), 'error');
      } finally {
        this.claimLoading = false;
      }
    },

    // Revoke a Route-3 claim — post-author reject of a pending claim, post-author
    // backstop on an accepted claim, or the claimer's self-withdraw. Always
    // entered through the shared confirm modal (confirmRevoke → revokeTarget).
    async handleRevokeClaim(claimer) {
      if (this.claimLoading) return;
      const username = this.$store.auth.username;
      if (!username || !claimer) return;
      this.revokeModalOpen = false;
      this.claimLoading = true;
      try {
        const res = await revokeAuthorshipClaim(this.author, this.permlink, claimer, 'Revoked');
        if (res.data?.tx_id) {
          this.$store.toast.show(this.$t('claims.rejectSuccess'), 'success');
          await this.loadEnrichment();
          await this._refreshPending();
        } else if (res.data?.operation) {
          const target = {
            action: 'revoke_authorship',
            rootAuthor: this.author,
            rootPermlink: this.permlink,
            claimer,
          };
          await this._broadcastConsentOp(target, res.data.operation, 'claims.rejectSuccess');
        }
      } catch (err) {
        console.warn('[paper detail revoke claim]', err);
        this.$store.toast.show(this.$t('claims.rejectFailed'), 'error');
      } finally {
        this.revokeTarget = null;
        this.claimLoading = false;
      }
    },

    async handleAcceptAuthorship() {
      if (this.claimLoading) return;
      const username = this.$store.auth.username;
      if (!username) return;
      this.claimLoading = true;
      try {
        const op = buildConsentCustomJson('author_accept', this.author, this.permlink, username);
        const target = { action: 'author_accept', rootAuthor: this.author, rootPermlink: this.permlink };
        await this._broadcastConsentOp(target, op, 'claims.acceptSuccess');
      } catch (err) {
        console.warn('[paper detail accept authorship]', err);
        this.$store.toast.show(this.$t('claims.acceptFailed'), 'error');
      } finally {
        this.claimLoading = false;
      }
    },

    async handleResignAuthorship() {
      if (this.claimLoading) return;
      const username = this.$store.auth.username;
      if (!username) return;
      this.resignModalOpen = false;
      this.claimLoading = true;
      try {
        const op = buildConsentCustomJson('author_resign', this.author, this.permlink, username);
        const target = { action: 'author_resign', rootAuthor: this.author, rootPermlink: this.permlink };
        await this._broadcastConsentOp(target, op, 'claims.resignSuccess');
      } catch (err) {
        console.warn('[paper detail resign authorship]', err);
        this.$store.toast.show(this.$t('claims.resignFailed'), 'error');
      } finally {
        this.claimLoading = false;
      }
    },

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}
