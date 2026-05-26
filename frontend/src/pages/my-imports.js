import Alpine from 'alpinejs';
import { formatDate } from '../components/paper-card.js';
import { fetchBridgeImports, registerBridgePaper } from '../api.js';
import { formatEta } from '../lib/format-eta.js';

// View-model shape this page renders against (post-adapter). The backend's
// queue-entry shape (GET /api/bridge/imports per agents/docs/api-contracts/
// bridge.md) is mapped into this by `adaptEntry()`; keeping the rendered shape
// stable means the template never has to know the wire field names.
//
//   {
//     id:            number,
//     identifier:    string,           // user-submitted DOI/arXiv/URL
//     title:         string | null,    // null until source metadata resolved
//     state:         'pending' | 'in_progress' | 'completed' | 'failed',
//     submitted_at:  ISO-8601 string,  // wire: created_at
//     completed_at:  ISO-8601 string | null,
//     etaSeconds:    number | null,    // worker-tick estimate; non-terminal only
//     author:        string | null,    // resolvable bridge author (completed)
//     permlink:      string | null,
//     failure_reason:string | null,    // wire: error_message
//     retriable:     boolean,          // failed entries re-POST /register
//   }

// Map a wire queue entry (bridge.md GET /api/bridge/imports) into the
// view-model the template renders. Field-name differences from the earlier
// consumer sketch are absorbed here:
//   - created_at  → submitted_at
//   - error_message → failure_reason
//   - author: the entry carries no bridge-author field; we resolve it from
//     existing_author (set only on the permlink-collision short-circuit). For
//     a freshly broadcast bridge paper existing_author is null, so the link
//     renders only when an author is resolvable (see template).
//   - retriable: the contract has no per-entry retriable flag; the retry model
//     is "a failed entry re-POSTs /register" (a failed entry is not in-flight,
//     so it re-enqueues). We therefore treat every failed entry as retriable.
function adaptEntry(wire) {
  return {
    id: wire.id,
    identifier: wire.identifier,
    title: wire.title ?? null,
    state: wire.state,
    discipline: wire.discipline ?? null,
    keywords: Array.isArray(wire.keywords) ? wire.keywords : [],
    language: wire.language ?? null,
    submitted_at: wire.created_at ?? null,
    completed_at: wire.completed_at ?? null,
    etaSeconds: typeof wire.eta_seconds === 'number' ? wire.eta_seconds : null,
    author: wire.existing_author ?? null,
    permlink: wire.existing_permlink ?? wire.permlink ?? null,
    failure_reason: wire.error_message ?? null,
    retriable: wire.state === 'failed',
  };
}

function buildDemoEntries() {
  const now = Date.now();
  const isoMinutesAgo = (m) => new Date(now - m * 60_000).toISOString();
  // Demo rows use the WIRE shape and pass through adaptEntry() like live data,
  // so the demo affordance exercises the same adapter the real fetch uses.
  return [
    {
      id: 1,
      identifier: '10.48550/arXiv.2301.99991',
      title: 'A Demonstration Preprint That Is Still Queued',
      state: 'pending',
      created_at: isoMinutesAgo(2),
      completed_at: null,
      eta_seconds: 300,
      existing_author: null,
      permlink: 'bridge-arxiv-2301-99991',
      error_message: null,
    },
    {
      id: 2,
      identifier: '2401.12345',
      title: 'A Second Preprint Currently Being Published',
      state: 'in_progress',
      created_at: isoMinutesAgo(8),
      completed_at: null,
      eta_seconds: 0,
      existing_author: null,
      permlink: 'bridge-arxiv-2401-12345',
      error_message: null,
    },
    {
      id: 3,
      identifier: '10.1101/2024.01.05.572345',
      title: 'A Successfully Published bioRxiv Preprint',
      state: 'completed',
      created_at: isoMinutesAgo(45),
      completed_at: isoMinutesAgo(40),
      eta_seconds: null,
      existing_author: 'pevo.bridge',
      existing_permlink: 'bridge-biorxiv-2024-01-05-572345',
      permlink: 'bridge-biorxiv-2024-01-05-572345',
      error_message: null,
    },
    {
      id: 4,
      identifier: '10.1234/notreal.5678',
      title: null,
      state: 'failed',
      created_at: isoMinutesAgo(60),
      completed_at: isoMinutesAgo(58),
      eta_seconds: null,
      existing_author: null,
      permlink: 'bridge-doi-10-1234-notreal-5678',
      error_message: 'Source metadata could not be retrieved.',
      error_code: 'BAD_REQUEST',
    },
  ];
}

const template = `
      <div x-data="myImportsPage" class="container-narrow py-8">
        <h1 class="text-3xl font-bold text-ink font-serif mb-2" x-text="$t('myImports.title')"></h1>
        <p class="text-ink-muted mb-6" x-text="$t('myImports.description')"></p>

        <!-- Not connected -->
        <template x-if="!isConnected">
          <div class="card bg-pevo-crimson-light border-pevo-crimson/30">
            <div class="flex items-start gap-3">
              <svg class="h-5 w-5 text-pevo-crimson shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>
              <div>
                <p class="font-medium text-ink text-sm" x-text="$t('myImports.signInHint')"></p>
                <button class="btn-primary text-xs mt-2" @click="handleConnect()" x-text="$t('signIn.signInButton')"></button>
              </div>
            </div>
          </div>
        </template>

        <template x-if="isConnected">
          <div>
            <!-- Loading skeleton -->
            <template x-if="loading">
              <div class="space-y-3">
                <template x-for="i in 3" :key="i">
                  <div class="card animate-pulse">
                    <div class="h-5 bg-parchment-warm rounded w-2/3 mb-2"></div>
                    <div class="h-4 bg-parchment-warm rounded w-1/3 mb-3"></div>
                    <div class="h-4 bg-parchment-warm rounded w-24"></div>
                  </div>
                </template>
              </div>
            </template>

            <!-- Error -->
            <template x-if="!loading && error">
              <div class="card text-center py-12">
                <p class="text-ink-muted mb-4" x-text="$t('myImports.loadFailed')"></p>
                <button class="btn-primary" @click="loadEntries()" x-text="$t('common.retry')"></button>
              </div>
            </template>

            <!-- Empty -->
            <template x-if="!loading && !error && entries.length === 0">
              <div class="card text-center py-12">
                <p class="text-ink-muted" x-text="$t('myImports.empty')"></p>
                <a :href="$lp('/bridge')" @click.prevent="navigate('/bridge')"
                   class="btn-primary inline-block text-sm mt-4 no-underline" x-text="$t('bridge.navLabel')"></a>
              </div>
            </template>

            <!-- List -->
            <template x-if="!loading && !error && entries.length > 0">
              <ul class="space-y-3 list-none">
                <template x-for="entry in entries" :key="entry.id">
                  <li class="card">
                    <div class="flex items-start justify-between gap-3 mb-2">
                      <div class="flex-1 min-w-0">
                        <h2 class="text-base font-semibold text-ink truncate" x-text="entry.title || entry.identifier"></h2>
                        <p class="text-xs text-ink-muted mt-0.5 font-mono truncate" x-text="entry.identifier"></p>
                      </div>
                      <span class="shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                            :class="badgeClass(entry.state)"
                            x-text="stateLabel(entry.state)"></span>
                    </div>

                    <div class="text-xs text-ink-muted space-y-1">
                      <p x-text="$t('myImports.submittedAt', { date: formatDate(entry.submitted_at) })"></p>
                      <template x-if="(entry.state === 'pending' || entry.state === 'in_progress')">
                        <p x-text="etaLabel(entry)"></p>
                      </template>
                      <template x-if="entry.state === 'completed' && entry.completed_at">
                        <p x-text="$t('myImports.completedAt', { date: formatDate(entry.completed_at) })"></p>
                      </template>
                      <template x-if="entry.state === 'failed' && entry.failure_reason">
                        <p class="text-pevo-crimson" x-text="$t('myImports.failureReason', { reason: entry.failure_reason })"></p>
                      </template>
                    </div>

                    <div class="mt-3 flex flex-wrap gap-2">
                      <template x-if="entry.state === 'completed' && entry.author && entry.permlink">
                        <a :href="$lp('/paper/' + entry.author + '/' + entry.permlink)"
                           @click.prevent="navigate('/paper/' + entry.author + '/' + entry.permlink)"
                           class="btn-secondary text-xs no-underline inline-block" x-text="$t('myImports.viewPaper')"></a>
                      </template>
                      <template x-if="entry.state === 'failed' && entry.retriable">
                        <button class="btn-secondary text-xs" @click="retryEntry(entry)" :disabled="retryingId === entry.id" x-text="$t('myImports.retry')"></button>
                      </template>
                      <template x-if="entry.state === 'failed' && !entry.retriable">
                        <span class="text-xs text-ink-muted italic" x-text="$t('myImports.cannotRetry')"></span>
                      </template>
                    </div>
                  </li>
                </template>
              </ul>
            </template>
          </div>
        </template>
      </div>
`;

export { template as myImportsPageTemplate };

export function initMyImportsPage() {
  Alpine.data('myImportsPage', () => ({
    entries: [],
    loading: false,
    error: false,
    // Id of the entry whose retry re-POST is in flight; disables that row's
    // retry button so a double-click does not enqueue twice.
    retryingId: null,

    formatDate,

    navigate(path) { Alpine.store('router').navigate(path); },

    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },

    init() {
      if (this.isConnected) {
        this.loadEntries();
      }
    },

    async handleConnect() {
      try {
        await Alpine.store('auth').connect();
        if (this.isConnected) await this.loadEntries();
      } catch (err) {
        console.warn('[my-imports connect]', err);
        Alpine.store('toast').show(this.$t('common.connectionFailed'), 'error');
      }
    },

    async loadEntries() {
      this.loading = true;
      this.error = false;
      try {
        // Demo affordance for design review: /my-imports?demo=1 renders
        // representative entries spanning all four states without hitting
        // the backend. The demo rows use the wire shape and pass through the
        // same adaptEntry() seam as live data.
        const params = new URLSearchParams(window.location.search);
        const wireEntries = params.has('demo')
          ? buildDemoEntries()
          : (await fetchBridgeImports()).data?.entries ?? [];
        this.entries = wireEntries.map(adaptEntry);
      } catch (err) {
        console.warn('[my-imports load]', err);
        this.error = true;
      } finally {
        this.loading = false;
      }
    },

    // Retry a failed import. The contract has no dedicated retry endpoint: a
    // failed entry is not in-flight, so re-POSTing /register re-enqueues it.
    // On success we reload the list so the new pending entry replaces the
    // failed row.
    async retryEntry(entry) {
      if (!entry || this.retryingId === entry.id) return;
      this.retryingId = entry.id;
      try {
        await registerBridgePaper({
          identifier: entry.identifier,
          discipline: entry.discipline || undefined,
          keywords: entry.keywords && entry.keywords.length > 0 ? entry.keywords : undefined,
          language: entry.language || undefined,
        });
        Alpine.store('toast').show(this.$t('bridge.queuedTitle'), 'success');
        await this.loadEntries();
      } catch (err) {
        console.warn('[my-imports retry]', err);
        Alpine.store('toast').show(this.$t('common.error'), 'error');
      } finally {
        this.retryingId = null;
      }
    },

    // ETA line for a non-terminal entry. Pending/in-progress entries carry a
    // best-effort eta_seconds; formatEta buckets it to ~minutes / ~hours, or
    // the etaUnknown string when the backend omitted the estimate.
    etaLabel(entry) {
      return formatEta(entry?.etaSeconds, this.$t.bind(this));
    },

    stateLabel(state) {
      switch (state) {
        case 'pending':     return this.$t('myImports.statePending');
        case 'in_progress': return this.$t('myImports.stateInProgress');
        case 'completed':   return this.$t('myImports.stateCompleted');
        case 'failed':      return this.$t('myImports.stateFailed');
        default:            return state;
      }
    },

    badgeClass(state) {
      switch (state) {
        case 'pending':     return 'bg-parchment-warm text-ink-muted';
        case 'in_progress': return 'bg-pevo-teal-light text-pevo-teal-dark';
        case 'completed':   return 'bg-green-100 text-green-800';
        case 'failed':      return 'bg-pevo-crimson-light text-pevo-crimson';
        default:            return 'bg-parchment-warm text-ink-muted';
      }
    },
  }));
}
