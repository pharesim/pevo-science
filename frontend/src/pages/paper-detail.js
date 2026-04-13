import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, fetchCitationExport, retractPaper, fetchDoi, assignDoi, updateBridgePaper, fetchPaperComments } from '../api.js';
import { computeVersionDiff } from '../lib/version-diff.js';
import { formatDate } from '../components/paper-card.js';

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

    // DOI
    doiData: null,
    doiLoading: false,

    // PubPeer
    pubpeerData: null,

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
        this.loadDoi();
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
        this.paper.citation_count = d.citation_count ?? this.paper.citation_count;
        this.paper.is_accredited = d.is_accredited ?? this.paper.is_accredited;
        if (d.versions) this.paper.versions = d.versions;
        if (d.is_retracted !== undefined) {
          this.paper.is_retracted = d.is_retracted;
          this.paper.retraction_reason = d.retraction_reason;
          this.paper.retraction_timestamp = d.retraction_timestamp;
        }
        this.enrichmentLoaded = true;
      } catch {
        // Enrichment is non-critical; paper still shows without it
      }
    },

    async loadDoi() {
      if (!this.paper) return;
      try {
        const data = await fetchDoi(this.author, this.permlink);
        this.doiData = data;
        this.loadPubPeer();
      } catch {
        // DOI is optional
      }
    },

    async loadPubPeer() {
      if (!this.doiData?.doi) return;
      try {
        const res = await fetch('https://pubpeer.com/v3/publications?devkey=PubPeerPEvO', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dois: [this.doiData.doi] }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.feedbacks?.length) {
          this.pubpeerData = data.feedbacks[0];
        }
      } catch {
        // PubPeer is optional enrichment
      }
    },

    get isOwnPaper() {
      const username = this.$store.auth.username;
      if (!username || !this.paper) return false;
      if (username === this.paper.author) return true;
      const authors = this.paper.authors || [];
      return authors.some(a => a.hive === username);
    },

    get authorNames() {
      if (!this.paper?.authors) return '';
      return this.paper.authors.map(a => a.name).join(', ');
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
      return this.paper?.json_metadata?.pevo?.type === 'bridge_paper';
    },

    get bridgeSource() {
      if (!this.isBridgePaper) return null;
      return this.paper.json_metadata.pevo.source || null;
    },

    get ipfsGateway() {
      return (window.__PEVO_CONFIG__?.ipfsGateway) || '/api/ipfs/';
    },

    get ipfsUrl() {
      if (!this.paper?.ipfs_cid) return null;
      return `${this.ipfsGateway}${this.paper.ipfs_cid}`;
    },

    get supplementaryFiles() {
      return this.paper?.supplementary_files || this.paper?.json_metadata?.pevo?.supplementary_files || [];
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
        this.$store.toast.show(err?.message || 'Failed to load version', 'error');
      } finally {
        this.loading = false;
      }
    },

    // Add to citation collection
    addToCollection() {
      if (!this.paper) return;
      const key = 'pevo-citation-collection';
      let collection = [];
      try {
        const raw = localStorage.getItem(key);
        if (raw) collection = JSON.parse(raw);
      } catch { collection = []; }

      const entry = { author: this.paper.author, permlink: this.paper.permlink, title: this.paper.title };
      const exists = collection.some(c => c.author === entry.author && c.permlink === entry.permlink);
      if (exists) {
        this.$store.toast.show(this.$t('citation.alreadyInCollection'), 'info');
        return;
      }
      collection.push(entry);
      try {
        localStorage.setItem(key, JSON.stringify(collection));
        this.$store.toast.show(this.$t('citation.addedToCollection'), 'success');
      } catch {
        this.$store.toast.show('Storage full', 'error');
      }
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

    // DOI
    async handleAssignDoi() {
      if (!this.$store.auth.username) return;
      this.doiLoading = true;
      try {
        const result = await assignDoi(this.author, this.permlink);
        this.doiData = result;
        this.$store.toast.show(this.$t('doi.assignSuccess'), 'success');
      } catch (err) {
        this.$store.toast.show(err?.message || this.$t('doi.assignFailed'), 'error');
      } finally {
        this.doiLoading = false;
      }
    },

    async copyDoi() {
      if (this.doiData?.doi) {
        await navigator.clipboard.writeText(this.doiData.doi);
        this.$store.toast.show(this.$t('doi.doiCopied'), 'success');
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
      return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    },

    selectDiffVersions() {
      if (this.diffMode) {
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
        this.diffError = err?.message || 'Failed to load versions for comparison';
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
