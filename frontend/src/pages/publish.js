import Alpine from 'alpinejs';
import { uploadToIpfs, fetchDisciplines } from '../api.js';
import { publishPaper } from '../keychain.js';
import { sha256File, slugify } from '../crypto.js';
import { createEditor } from '../editor.js';
import { getAppTag, getAppId } from '../config.js';

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


function relativeTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function composePostBody(abstract, fullText) {
  if (!fullText) return '## Abstract\n\n' + abstract;
  return '## Abstract\n\n' + abstract + '\n\n---\n\n' + fullText;
}

function estimateTxBytes(title, postBody, metadataJson) {
  const encoder = new TextEncoder();
  return encoder.encode(title).length + encoder.encode(postBody).length + encoder.encode(metadataJson).length + 500;
}

export function initPublishPage() {
  Alpine.data('publishPage', () => ({
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
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
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
          remainingChars: TX_HARD_BYTES - this.txEstimate,
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
        const hasContent = this.title.trim() || this.abstract.trim() || this.body.trim();
        if (!hasContent) {
          try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
          return;
        }
        try {
          const draft = {
            title: this.title, abstract: this.abstract, body: this.body,
            discipline: this.discipline, keywordsText: this.keywordsText,
            coAuthors: this.coAuthors, citations: this.citations, authorName: this.authorName,
            authorAffiliation: this.authorAffiliation, authorOrcid: this.authorOrcid,
            savedAt: Date.now(),
          };
          localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
          this.draftSavedAt = draft.savedAt;
        } catch { /* storage full */ }
      }, 2000);
    },

    discardDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
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
      return relativeTime(this.draftSavedAt);
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
        if (file.size > 10 * 1024 * 1024) {
          Alpine.store('toast').show(this.$t('publish.fileTooLarge', { name: file.name }), 'error');
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
              sf.error = err.message || 'Upload failed';
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

        this.step = 'broadcasting';
        await publishPaper(username, permlink, this.title, this.postBody, jsonMetadata);

        this.step = 'success';
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
        setTimeout(() => {
          this.navigate(`/paper/${username}/${permlink}`);
        }, 1500);
      } catch (err) {
        this.step = 'error';
        this.errorMessage = err.message || 'Publishing failed';
      }
    },
  }));
}
