import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, fetchCitationExport, retractPaper, updateBridgePaper } from '../api.js';
import { getAppTag } from '../config.js';
import { computeVersionDiff } from '../lib/version-diff.js';
import { formatDate } from '../components/paper-card.js';

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
            <p class="text-ink-muted mb-4" x-text="$t('paperDetail.notFoundDescription', { author: author, permlink: permlink })"></p>
            <div class="flex justify-center gap-3">
              <button @click="loadPaper()" class="btn-secondary" x-text="$t('common.retry')"></button>
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
                      <a :href="bridgeSource.url" target="_blank" rel="noopener noreferrer" class="text-pevo-teal hover:underline text-sm"
                         x-text="$t('bridge.viewSource', { source: bridgeSource.source_name || bridgeSource.type || '' })"></a>
                    </span>
                  </template>
                </div>
                <template x-if="$store.auth.isConnected && $store.auth.username === paper.author">
                  <button class="btn-secondary text-sm" @click="handleBridgeSync()" :disabled="syncLoading"
                          x-text="syncLoading ? $t('bridge.syncing') : $t('bridge.syncButton')"></button>
                </template>
              </div>
            </template>

            <!-- Paper header card -->
            <article class="card mt-4">
              <div class="flex items-center gap-2 text-xs text-ink-muted mb-3">
                <span class="badge-discipline capitalize" x-text="paper.discipline"></span>
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
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-t-lg" @click="handleCitationExport('apa')" x-text="$t('citation.apaFormat')"></button>
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors" @click="handleCitationExport('bibtex')" x-text="$t('citation.bibtexFormat')"></button>
                      <button type="button" class="block w-full text-left px-4 py-2 text-sm text-ink hover:bg-parchment-warm transition-colors rounded-b-lg" @click="handleCitationExport('ris')" x-text="$t('citation.risFormat')"></button>
                    </div>
                  </div>
                  <!-- Add to citation collection -->
                  <button type="button" class="btn-secondary text-sm flex items-center gap-1.5" @click="addToCollection()">
                    <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" /></svg>
                    <span x-text="$t('citation.addToCollection')"></span>
                  </button>
                  <!-- Edit button (author/co-author) -->
                  <template x-if="isOwnPaper && !paper.is_retracted">
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
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-4">
                <template x-for="a in paper.authors" :key="a.hive || a.name">
                  <span class="inline-flex items-center text-sm">
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
                      <span class="text-ink-muted ml-1" x-text="'(' + a.affiliation + ')'"></span>
                    </template>
                  </span>
                </template>
              </div>

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
                <!-- Accredited: vote strength selector -->
                <template x-if="isAccredited">
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
                <!-- Non-accredited: simple up/down -->
                <template x-if="!isAccredited">
                  <div class="flex items-center gap-2">
                    <button type="button" class="p-1.5 rounded transition-colors"
                            :class="voteState === 'up' ? 'text-pevo-teal bg-pevo-teal-light' : 'text-ink-muted hover:text-pevo-teal'"
                            @click="handleSimpleVote(10000)" :disabled="isVoting" :title="$t('vote.upvote')">
                      <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                    </button>
                    <span class="text-sm font-medium text-ink" x-text="displayVotes"></span>
                    <button type="button" class="p-1.5 rounded transition-colors"
                            :class="voteState === 'down' ? 'text-pevo-crimson bg-pevo-crimson-light' : 'text-ink-muted hover:text-pevo-crimson'"
                            @click="handleSimpleVote(-10000)" :disabled="isVoting" :title="$t('vote.downvote')">
                      <svg class="h-5 w-5 rotate-180" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                    </button>
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
                              <button type="button" class="p-0.5 rounded transition-colors" :class="voteState === 'up' ? 'text-pevo-teal' : 'hover:text-pevo-teal'"
                                      @click="handleSimpleVote(10000)" :disabled="isVoting">
                                <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                              </button>
                              <span x-text="displayVotes"></span>
                              <button type="button" class="p-0.5 rounded transition-colors" :class="voteState === 'down' ? 'text-pevo-crimson' : 'hover:text-pevo-crimson'"
                                      @click="handleSimpleVote(-10000)" :disabled="isVoting">
                                <svg class="h-4 w-4 rotate-180" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
                              </button>
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
    paper: null,
    loading: true,
    error: null,
    enrichmentLoaded: false,

    // Citation export
    citeOpen: false,
    citeLoading: false,

    // Retraction
    retractDialogOpen: false,
    retractReason: '',
    retractLoading: false,


    // Version switching
    viewingVersion: null,

    // Bridge sync
    syncLoading: false,

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

    get author() {
      return this.$store.router.params.author;
    },

    get permlink() {
      return this.$store.router.params.permlink;
    },

    init() {
      this.loadPaper();
    },

    async loadPaper() {
      const author = this.author;
      const permlink = this.permlink;
      this.loading = true;
      this.error = null;
      try {
        const res = await fetchPaper(author, permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        this.paper = res.data;
        if (this.paper.title) document.title = `${this.paper.title} — PEvO`;
        // Load enrichment lazily (reviews, votes, versions, DOI)
        this.loadEnrichment();
      } catch (err) {
        if (this.author !== author || this.permlink !== permlink) return;
        this.error = err?.message === 'Not found'
          ? this.$t('paperDetail.notFoundTitle')
          : (err?.message || this.$t('paperDetail.errorLoadingTitle'));
      } finally {
        this.loading = false;
      }
    },

    async loadEnrichment() {
      if (!this.paper) return;
      const author = this.author;
      const permlink = this.permlink;
      try {
        const res = await fetchPaperEnrichment(author, permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        const d = res.data;
        this.paper.reviews = d.reviews || [];
        this.paper.net_votes = d.net_votes ?? this.paper.net_votes;
        this.paper.vote_strength = d.vote_strength || null;
        this.paper.voters = d.voters || [];
        this.enrichmentLoaded = true;
        // Scroll to review if URL has a hash fragment
        this.scrollToHashReview();
      } catch {
        console.warn('Paper enrichment failed');
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
      return authors.some(a => a.hive === username);
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
        this.$store.toast.show(err?.message || this.$t('common.loadVersionFailed'), 'error');
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
      this.citeLoading = true;
      try {
        const data = await fetchCitationExport(this.author, this.permlink, format);
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
          a.download = `${this.permlink}.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          this.$store.toast.show(this.$t('citation.downloadStarted'), 'success');
        }
      } catch (err) {
        this.$store.toast.show(err?.message || this.$t('citation.exportFailed'), 'error');
      } finally {
        this.citeLoading = false;
        this.citeOpen = false;
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
        this.$store.toast.show(err?.message || this.$t('retraction.failed'), 'error');
      } finally {
        this.retractLoading = false;
      }
    },

    // Bridge sync
    async handleBridgeSync() {
      if (!this.$store.auth.username) return;
      const author = this.author;
      const permlink = this.permlink;
      this.syncLoading = true;
      try {
        await updateBridgePaper(permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        this.$store.toast.show(this.$t('bridge.syncSuccess'), 'success');
        const res = await fetchPaper(author, permlink);
        if (this.author !== author || this.permlink !== permlink) return;
        this.paper = res.data;
      } catch (err) {
        if (this.author !== author || this.permlink !== permlink) return;
        this.$store.toast.show(err?.message || this.$t('bridge.syncFailed'), 'error');
      } finally {
        this.syncLoading = false;
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
        this.diffError = err?.message || this.$t('common.diffLoadFailed');
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

    navigate(path) {
      this.$store.router.navigate(path);
    },
  }));
}
