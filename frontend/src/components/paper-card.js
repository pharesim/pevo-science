// Shared-fragment convention:
// Export HTML fragments as template-literal string constants (e.g. `fooTemplate`).
// Pages import and interpolate: `${fooTemplate}` inside their own template.
// If the fragment has state, the same file also registers `Alpine.data('foo', () => ({...}))`
// and exports `initFoo()` for main.js. Purely presentational fragments (data comes from
// the parent's x-for / scope) skip the factory — like this one.
//
// Escaping note: `${...}` inside the template is escaped as `\${...}` so it's emitted
// literally and then evaluated by Alpine, not by the importing page's template literal.

export const paperCardTemplate = `
  <article class="card hover:shadow-sm transition-shadow">
    <!-- Header: discipline + source badge + date -->
    <div class="flex items-center justify-between text-xs text-ink-muted mb-3">
      <div class="flex items-center gap-2">
        <span class="badge-discipline capitalize" x-text="paper.discipline"></span>
        <template x-if="paper.source_type && paper.source_type !== 'native'">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-pevo-teal-light text-pevo-teal-dark border border-pevo-teal/20"
                x-text="paper.source_type === 'arxiv' ? 'arXiv' : 'DOI'"></span>
        </template>
      </div>
      <time :datetime="paper.created" x-text="formatDate(paper.created)"></time>
    </div>

    <!-- Title -->
    <h3 class="text-paper-title leading-snug mb-2">
      <a :href="$lp('/paper/' + paper.author + '/' + paper.permlink)"
         @click.prevent="navigate('/paper/' + paper.author + '/' + paper.permlink)"
         class="text-ink hover:text-pevo-teal no-underline" x-text="paper.title"></a>
    </h3>

    <!-- Authors -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mb-3 text-sm text-ink-light">
      <template x-for="(a, i) in paper.authors" :key="a.hive || a.name">
        <span class="inline-flex items-center">
          <template x-if="a.hive && (paper.accredited_authors || []).includes(a.hive)">
            <span class="inline-flex items-center">
              <a :href="$lp('/profile/' + a.hive)" @click.prevent="navigate('/profile/' + a.hive)" class="no-underline hover:underline text-ink-light" x-text="a.name"></a>
              <svg class="ml-0.5 h-3 w-3 text-pevo-green" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" :title="$t('badge.accreditedTitle')">
                <path fill-rule="evenodd" d="M16.403 12.652a3 3 0 010-5.304 3 3 0 00-3.75-3.751 3 3 0 00-5.305 0 3 3 0 00-3.751 3.75 3 3 0 000 5.305 3 3 0 003.75 3.751 3 3 0 005.305 0 3 3 0 003.751-3.75zm-2.546-4.46a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" />
              </svg>
            </span>
          </template>
          <template x-if="!a.hive || !(paper.accredited_authors || []).includes(a.hive)">
            <span x-text="a.name"></span>
          </template>
          <span x-show="i < paper.authors.length - 1" class="mr-1">,</span>
        </span>
      </template>
    </div>

    <!-- Abstract preview -->
    <p class="text-sm text-ink-muted leading-relaxed mb-4" x-text="truncateText(paper.abstract)"></p>

    <!-- Keywords -->
    <template x-if="paper.keywords && paper.keywords.length > 0">
      <div class="flex flex-wrap gap-1.5 mb-4">
        <template x-for="kw in paper.keywords" :key="kw">
          <span class="text-xs px-2 py-0.5 rounded-full bg-parchment-warm text-ink-muted" x-text="kw"></span>
        </template>
      </div>
    </template>

    <!-- Metrics -->
    <div class="flex items-center gap-5 text-xs text-ink-muted pt-3 border-t border-parchment-dark">
      <span class="flex items-center gap-1" :title="$t('aria.votes')">
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l-7 7h4v7h6v-7h4L10 3z" /></svg>
        <template x-if="paper.net_votes != 0">
          <span x-text="$t('vote.votesWithStrength', { count: paper.net_votes ?? 0, strength: $t('vote.strength.' + paper.vote_strength) })"></span>
        </template>
      </span>
      <span class="flex items-center gap-1" :title="$t('aria.reviews')">
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-5 0H8v2h2V9z" clip-rule="evenodd" /></svg>
        <span x-text="(paper.review_count ?? 0) + (paper.avg_rating ? ' (' + paper.avg_rating + '/5)' : '')"></span>
      </span>
      <span class="flex items-center gap-1" :title="$t('aria.citations')">
        <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V14a1 1 0 11-2 0V4.804z" /></svg>
        <span x-text="paper.citation_count ?? 0"></span>
      </span>
      <template x-if="paper.ipfs_cid">
        <span class="flex items-center gap-1 ml-auto rtl:ml-0 rtl:mr-auto" :title="$t('aria.pdf')">
          <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clip-rule="evenodd" /></svg>
          <span x-text="$t('paperCard.pdf')"></span>
        </span>
      </template>
    </div>
  </article>
`;

/**
 * Truncate text to maxLength, breaking at word boundary.
 */
export function truncateText(text, maxLength = 280) {
  if (!text || text.length <= maxLength) return text || '';
  return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

/**
 * Format an ISO date string for display.
 */
export function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
