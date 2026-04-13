import Alpine from 'alpinejs';
import { fetchPaper, fetchPaperEnrichment, invalidatePaperCache, uploadToIpfs } from '../api.js';
import { broadcastOps } from '../signer.js';
import { sha256File, slugify } from '../crypto.js';
import { createEditor } from '../editor.js';
import { getAppTag, getAppId } from '../config.js';
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
      const isOriginalAuthor = this.username === this.paper.author;
      const isCoAuthor = (this.paper.authors || []).some(a => a.hive === this.username);
      return !isOriginalAuthor && !isCoAuthor;
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
      const pevo = p.json_metadata?.pevo || p.json_metadata?.[getAppTag()] || {};
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
        try { localStorage.removeItem(this.draftKey); } catch { /* */ }
      }
    },

    _mountEditors() {
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
        try {
          const draft = {
            title: this.title, abstract: this.abstract, body: this.body,
            keywordsText: this.keywordsText, authorName: this.authorName,
            authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
            newCoAuthors: this.newCoAuthors, citations: this.citations, savedAt: Date.now(),
          };
          localStorage.setItem(this.draftKey, JSON.stringify(draft));
        } catch { /* storage full */ }
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
        if (file.size > 10 * 1024 * 1024) {
          Alpine.store('toast').show(this.$t('publish.fileTooLarge', { name: file.name }), 'error');
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
        try {
          const key = 'pevo-citation-collection';
          const raw = localStorage.getItem(key);
          if (raw) {
            const collection = JSON.parse(raw).filter(c => !(c.author === removed.author && c.permlink === removed.permlink));
            if (collection.length > 0) localStorage.setItem(key, JSON.stringify(collection));
            else localStorage.removeItem(key);
          }
        } catch { /* ignore */ }
      }
    },

    _mergeCitationCollection() {
      const key = 'pevo-citation-collection';
      try {
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
      } catch { /* ignore */ }
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

        const pevoMeta = this.paper.json_metadata?.pevo || this.paper.json_metadata?.[APP_TAG] || {};

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
          try { await invalidatePaperCache(canonicalAuthor, canonicalPermlink); } catch { /* best effort */ }

          this.step = 'success';
          try { localStorage.removeItem(this.draftKey); } catch { /* */ }
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

          try { await invalidatePaperCache(this.author, this.permlink); } catch { /* best effort */ }

          this.step = 'success';
          try { localStorage.removeItem(this.draftKey); } catch { /* */ }
          setTimeout(() => {
            this.navigate(`/paper/${this.author}/${this.permlink}`);
          }, 1500);
        }
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || 'Edit failed';
      }
    },
  }));
}
