import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked createEditor for the dynamic `await import('../editor.js')` inside
// _mountEditors. The test for the teardown-during-init guard asserts that
// the FACTORY is not invoked when the component is destroyed before the
// dynamic import resolves — i.e. that the `if (!this._mounted) return;` is
// reached before createEditor runs. The mock is hoisted by vi.mock and
// applied to both static and dynamic imports.
const mockCreateEditor = vi.fn(() => ({
  destroy: vi.fn(),
  setContent: vi.fn(),
}));

vi.mock('../../src/editor.js', () => ({
  createEditor: (...args) => mockCreateEditor(...args),
}));

// Upload now goes through the batch session in lib/ipfs-upload.js. The page
// drives `createUploadSession().upload(file)`; route every upload through one
// controllable fn so tests set per-case resolve/reject.
const mockSessionUpload = vi.fn();
vi.mock('../../src/lib/ipfs-upload.js', () => ({
  createUploadSession: () => ({ upload: (...a) => mockSessionUpload(...a), dispose: vi.fn() }),
  uploadFile: (...a) => mockSessionUpload(...a),
  describeUploadError: (err) =>
    err?.code === 'UPLOAD_REAUTH_UNAVAILABLE' ? 'common.uploadReauthRequired'
      : err?.code === 'UPLOAD_CANCELLED' ? 'common.uploadCancelled'
        : 'common.uploadFailed',
}));

vi.mock('../../src/api.js', () => ({
  fetchDisciplines: vi.fn(() => Promise.resolve({ data: [] })),
  fetchAccreditations: vi.fn(() => Promise.resolve({ data: [] })),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: vi.fn(),
}));

vi.mock('../../src/crypto.js', () => ({
  sha256File: vi.fn(() => Promise.resolve('abc123')),
  slugify: vi.fn((s) => s.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d,
}));

const mockStores = {
  router: { params: {}, navigate: vi.fn(), query: {} },
  auth: { isConnected: true, isAccredited: true, username: 'alice', accreditation: { name: 'Alice', institution: 'MIT' } },
  toast: { show: vi.fn() },
  broadcastConfirm: { request: vi.fn(() => Promise.resolve(true)) },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { broadcastOps } from '../../src/signer.js';
import { initPublishPage } from '../../src/pages/publish.js';

function createComponent(overrides = {}) {
  initPublishPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  comp.$refs = { abstractEditor: null, bodyEditor: null };
  // Skip init side effects
  Object.assign(comp, overrides);
  return comp;
}

describe('publishPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('filteredTaxonomy', () => {
    it('returns full taxonomy when search is empty', () => {
      const comp = createComponent();
      comp.disciplineSearch = '';
      expect(comp.filteredTaxonomy.length).toBeGreaterThan(0);
      expect(comp.filteredTaxonomy[0].field).toBe('Natural Sciences');
    });

    it('filters subfields by partial match', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'phys';
      const result = comp.filteredTaxonomy;
      expect(result.length).toBeGreaterThan(0);
      const allSubfields = result.flatMap(g => g.subfields);
      expect(allSubfields.every(sf => sf.toLowerCase().includes('phys'))).toBe(true);
    });

    it('returns empty array when no match', () => {
      const comp = createComponent();
      comp.disciplineSearch = 'xyznonexistent';
      expect(comp.filteredTaxonomy).toEqual([]);
    });
  });

  describe('postBody', () => {
    it('composes abstract only when no full text', () => {
      const comp = createComponent();
      comp.abstract = 'My abstract';
      comp.body = '';
      expect(comp.postBody).toBe('## Abstract\n\nMy abstract');
    });

    it('composes abstract + full text with separator', () => {
      const comp = createComponent();
      comp.abstract = 'Abstract text';
      comp.body = 'Full paper content';
      expect(comp.postBody).toBe('## Abstract\n\nAbstract text\n\n---\n\nFull paper content');
    });
  });

  describe('txWarn and txBlock', () => {
    it('txWarn is false for small content', () => {
      const comp = createComponent();
      comp.title = 'Hi';
      comp.abstract = 'Short';
      comp.body = '';
      comp.discipline = '';
      comp.keywordsText = '';
      comp.coAuthors = [];
      expect(comp.txWarn).toBe(false);
    });

    it('txWarn is true when estimate >= 55000', () => {
      const comp = createComponent();
      comp.title = 'A'.repeat(1000);
      comp.abstract = 'B'.repeat(54000);
      comp.body = '';
      comp.discipline = '';
      comp.keywordsText = '';
      comp.coAuthors = [];
      // txEstimate = title(1000) + postBody("## Abstract\n\n"+54000) + meta(~200) + 500 > 55000
      expect(comp.txWarn).toBe(true);
    });

    it('txBlock is true when estimate >= 60000', () => {
      const comp = createComponent();
      comp.title = 'A'.repeat(100);
      comp.abstract = 'B'.repeat(60000);
      comp.body = '';
      comp.discipline = '';
      comp.keywordsText = '';
      comp.coAuthors = [];
      expect(comp.txBlock).toBe(true);
    });
  });

  describe('isSubmitting', () => {
    it.each([
      ['idle', false],
      ['success', false],
      ['error', false],
      ['hashing', true],
      ['broadcasting', true],
    ])('step=%s -> isSubmitting=%s', (step, expected) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.isSubmitting).toBe(expected);
    });
  });

  describe('stepClass', () => {
    it.each([
      ['success', 'pevo-green'],
      ['error', 'pevo-crimson'],
      ['uploading', 'pevo-teal'],
      ['hashing', 'pevo-teal'],
    ])('step=%s -> contains %s', (step, cls) => {
      const comp = createComponent();
      comp.step = step;
      expect(comp.stepClass).toContain(cls);
    });
  });

  describe('addCitation / removeCitation / toggleCitationRelevance', () => {
    it('adds a citation with reputation_relevant=true', () => {
      const comp = createComponent();
      comp.citations = [];
      comp.addCitation();
      expect(comp.citations).toHaveLength(1);
      expect(comp.citations[0].reputation_relevant).toBe(true);
    });

    it('removes citation at index', () => {
      const comp = createComponent();
      comp.citations = [
        { author: 'a', permlink: 'p1', title: '', reputation_relevant: true },
        { author: 'b', permlink: 'p2', title: '', reputation_relevant: true },
      ];
      comp.removeCitation(0);
      expect(comp.citations).toHaveLength(1);
      expect(comp.citations[0].author).toBe('b');
    });

    it('toggles reputation_relevant', () => {
      const comp = createComponent();
      comp.citations = [{ author: 'a', permlink: 'p1', title: '', reputation_relevant: true }];
      comp.toggleCitationRelevance(0);
      expect(comp.citations[0].reputation_relevant).toBe(false);
      comp.toggleCitationRelevance(0);
      expect(comp.citations[0].reputation_relevant).toBe(true);
    });
  });

  describe('dragCitationDrop', () => {
    it('reorders citations by drag', () => {
      const comp = createComponent();
      comp.citations = [
        { author: 'a', permlink: 'p1' },
        { author: 'b', permlink: 'p2' },
        { author: 'c', permlink: 'p3' },
      ];
      comp.dragIndex = 0;
      comp.dragCitationDrop(2);
      expect(comp.citations.map(c => c.author)).toEqual(['b', 'c', 'a']);
      expect(comp.dragIndex).toBe(null);
    });

    it('no-op when dragIndex equals target', () => {
      const comp = createComponent();
      comp.citations = [{ author: 'a' }, { author: 'b' }];
      comp.dragIndex = 1;
      comp.dragCitationDrop(1);
      expect(comp.citations.map(c => c.author)).toEqual(['a', 'b']);
    });
  });

  describe('handlePdfChange', () => {
    it('extracts file info', () => {
      const comp = createComponent();
      const file = { name: 'paper.pdf', size: 2 * 1024 * 1024 };
      comp.handlePdfChange({ target: { files: [file] } });
      expect(comp.pdfFile).toBe(file);
      expect(comp.pdfFileName).toBe('paper.pdf');
      expect(comp.pdfFileSize).toBe('2.00');
    });
  });

  describe('discardDraft', () => {
    it('resets all form state', () => {
      const comp = createComponent();
      comp.title = 'Some title';
      comp.abstract = 'Some abstract';
      comp.body = 'Some body';
      comp.discipline = 'Physics';
      comp.keywordsText = 'key1,key2';
      comp.coAuthors = [{ name: 'Bob' }];
      comp.citations = [{ author: 'x', permlink: 'y' }];
      comp.supplementaryFiles = [{ file: {} }];
      comp.draftRestored = true;
      comp.draftSavedAt = 123;

      comp.discardDraft();

      expect(comp.title).toBe('');
      expect(comp.abstract).toBe('');
      expect(comp.body).toBe('');
      expect(comp.discipline).toBe('');
      expect(comp.keywordsText).toBe('');
      expect(comp.coAuthors).toEqual([]);
      expect(comp.citations).toEqual([]);
      expect(comp.supplementaryFiles).toEqual([]);
      expect(comp.draftRestored).toBe(false);
      expect(comp.draftSavedAt).toBe(null);
    });
  });

  describe('handleSubmit', () => {
    function validComponent() {
      const comp = createComponent();
      comp.title = 'My Paper';
      comp.abstract = 'Paper abstract';
      comp.body = 'Body text';
      comp.discipline = 'Physics';
      comp.keywordsText = 'quantum, optics';
      comp.authorName = 'Alice';
      comp.authorAffiliation = 'MIT';
      comp.authorOrcid = '';
      return comp;
    }

    beforeEach(() => {
      mockStores.auth.isConnected = true;
      mockStores.auth.isAccredited = true;
      mockStores.auth.username = 'alice';
      mockStores.broadcastConfirm.request.mockResolvedValue(true);
    });

    it('aborts when not accredited', async () => {
      mockStores.auth.isAccredited = false;
      const comp = validComponent();
      await comp.handleSubmit();
      expect(broadcastOps).not.toHaveBeenCalled();
    });

    it('aborts when title is empty', async () => {
      const comp = validComponent();
      comp.title = '   ';
      await comp.handleSubmit();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(mockStores.toast.show).toHaveBeenCalledWith('publish.missingRequiredFields', 'error');
    });

    it('aborts when abstract is empty', async () => {
      const comp = validComponent();
      comp.abstract = '';
      await comp.handleSubmit();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(mockStores.toast.show).toHaveBeenCalledWith('publish.missingRequiredFields', 'error');
    });

    it('aborts when discipline is empty', async () => {
      const comp = validComponent();
      comp.discipline = '';
      await comp.handleSubmit();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(mockStores.toast.show).toHaveBeenCalledWith('publish.missingRequiredFields', 'error');
    });

    it('aborts when user cancels the confirmation dialog', async () => {
      mockStores.broadcastConfirm.request.mockResolvedValue(false);
      const comp = validComponent();
      await comp.handleSubmit();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    });

    it('broadcasts comment and comment_options with expected shape', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx1' });
      const comp = validComponent();
      await comp.handleSubmit();

      expect(broadcastOps).toHaveBeenCalledTimes(1);
      const [username, operations] = broadcastOps.mock.calls[0];
      expect(username).toBe('alice');
      expect(operations).toHaveLength(2);

      const [commentOp, optionsOp] = operations;
      expect(commentOp[0]).toBe('comment');
      expect(commentOp[1].parent_author).toBe('');
      expect(commentOp[1].parent_permlink).toBe('pevotest'); // APP_TAG
      expect(commentOp[1].author).toBe('alice');
      expect(commentOp[1].title).toBe('My Paper');

      expect(optionsOp[0]).toBe('comment_options');
      expect(optionsOp[1].percent_hbd).toBe(0);
      expect(optionsOp[1].max_accepted_payout).toBe('1000000.000 HBD');
    });

    it('includes discipline, app tag, and keywords in json_metadata tags', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = validComponent();
      await comp.handleSubmit();

      const meta = JSON.parse(broadcastOps.mock.calls[0][1][0][1].json_metadata);
      expect(meta.tags).toContain('pevotest');
      expect(meta.tags).toContain('science');
      expect(meta.tags).toContain('Physics');
      expect(meta.tags).toContain('quantum');
      expect(meta.tags).toContain('optics');
      // Falsy tags should not slip in
      expect(meta.tags).not.toContain('');
      expect(meta.tags).not.toContain(undefined);
    });

    it('filters invalid citations (missing author or permlink)', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = validComponent();
      comp.citations = [
        { author: 'alice', permlink: 'p1', title: 'Valid', reputation_relevant: true },
        { author: '', permlink: 'p2', title: 'No author', reputation_relevant: true },
        { author: 'bob', permlink: '', title: 'No permlink', reputation_relevant: true },
      ];
      await comp.handleSubmit();

      const meta = JSON.parse(broadcastOps.mock.calls[0][1][0][1].json_metadata);
      const citationPermlinks = meta.pevotest.citations.map((c) => c.permlink);
      expect(citationPermlinks).toEqual(['p1']);
    });

    it('writes ipfs_cid and document_hash to metadata when a PDF is attached', async () => {
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      mockSessionUpload.mockResolvedValue({ data: { cid: 'bafyPDF', filename: 'paper.pdf' } });

      const comp = validComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1000, type: 'application/pdf' };

      await comp.handleSubmit();

      const meta = JSON.parse(broadcastOps.mock.calls[0][1][0][1].json_metadata);
      expect(meta.pevotest.ipfs_cid).toBe('bafyPDF');
      expect(meta.pevotest.document_hash).toBe('abc123');
    });

    // Broadcast failure surfaces a generic localized message; raw err
    // reaches console.warn (never leaks into user-facing errorMessage).
    it('sanitizes broadcast failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('broadcast boom hex=deadbeefcafebabe');
      broadcastOps.mockRejectedValueOnce(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = validComponent();

      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      expect(comp.errorMessage).toBe('common.publishingFailed');
      expect(comp.errorMessage).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });

    // Supplementary-file upload failure sets the file's sf.error to the
    // generic localized message and logs the raw err via console.warn. The
    // handler then throws a separate i18n'd Error for the outer catch to surface.
    it('sanitizes supplementary upload failure: generic message to sf.error, raw err to console.warn', async () => {
      const leaky = new Error('ipfs boom hex=deadbeefcafebabe');
      mockSessionUpload.mockRejectedValueOnce(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = validComponent();
      comp.supplementaryFiles = [{
        file: new Blob(['x'], { type: 'text/plain' }),
        fileName: 'data.txt',
        description: 'test',
        cid: null,
        error: null,
        uploading: false,
      }];

      await comp.handleSubmit();

      expect(comp.step).toBe('error');
      const sf = comp.supplementaryFiles[0];
      expect(sf.error).toBe('common.uploadFailed');
      expect(sf.error).not.toContain('deadbeef');
      expect(warnSpy).toHaveBeenCalled();
      // The raw err reaches console.warn (first handler) even though a
      // second thrown Error is caught by the outer handleSubmit catch.
      const warnedFirst = warnSpy.mock.calls.find((call) => call[1] === leaky);
      expect(warnedFirst).toBeDefined();
      warnSpy.mockRestore();
    });

    // The post-success redirect timer must be cancelable. If the user
    // navigates away during the wait, destroy() clears the pending timer
    // and navigate MUST NOT fire.
    it('destroy() cancels the post-success redirect timer (no navigate after teardown)', async () => {
      vi.useFakeTimers();
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = validComponent();

      await comp.handleSubmit();
      expect(comp.step).toBe('success');
      expect(mockStores.router.navigate).not.toHaveBeenCalled();

      comp.destroy();
      vi.advanceTimersByTime(3000);
      expect(mockStores.router.navigate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    // Post-destroy() async continuation catches must not write
    // step/errorMessage. A broadcast that rejects after Alpine tears the
    // component down would otherwise mutate a destroyed reactive scope.
    it('handleSubmit catch does not write step=error / errorMessage after destroy()', async () => {
      let rejectFn;
      broadcastOps.mockImplementationOnce(() => new Promise((_, reject) => { rejectFn = reject; }));
      const comp = validComponent();
      const pending = comp.handleSubmit();
      // Let the flow progress past the broadcastConfirm await into broadcastOps.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      comp.destroy();
      rejectFn(new Error('post-teardown boom'));
      await pending;
      expect(comp.step).not.toBe('error');
      expect(comp.errorMessage).toBe('');
    });
  });

  describe('_mergeCitationCollection', () => {
    it('merges citations from localStorage without duplicates', () => {
      const comp = createComponent();
      comp.citations = [{ author: 'a', permlink: 'p1', title: 'T1', reputation_relevant: true }];
      localStorage.setItem('pevo-citation-collection', JSON.stringify([
        { author: 'a', permlink: 'p1', title: 'T1' },
        { author: 'b', permlink: 'p2', title: 'T2' },
      ]));
      comp._mergeCitationCollection();
      expect(comp.citations).toHaveLength(2);
      expect(comp.citations[1].author).toBe('b');
      expect(comp.citations[1].reputation_relevant).toBe(true);
      // Collection cleared after merge
      expect(localStorage.getItem('pevo-citation-collection')).toBe(null);
    });

    it('does nothing when no collection in localStorage', () => {
      const comp = createComponent();
      comp.citations = [];
      comp._mergeCitationCollection();
      expect(comp.citations).toEqual([]);
    });
  });

  // Page-integration of the ORCID prefill flow. The lib unit tests pin the
  // helper semantics; these tests pin the page-state wiring around them (the
  // methods publish.js exposes to its Alpine template).
  describe('co-author ORCID prefill (page integration)', () => {
    const directory = {
      alice: { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
      bob: { username: 'bob', orcid: '0000-0002-2222-2222', name: 'Bob' },
      carol: { username: 'carol', name: 'Carol' }, // accredited but no orcid in record
    };

    it('updateCoAuthor: typing accredited hive prefills ORCID + locks the input', () => {
      const comp = createComponent();
      comp.accreditedDirectory = directory;
      comp.coAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
      comp.updateCoAuthor(0, 'hive', 'alice');
      expect(comp.coAuthors[0].hive).toBe('alice');
      expect(comp.coAuthors[0].orcid).toBe('0000-0001-1111-1111');
      expect(comp.isCoAuthorAccredited(0)).toBe(true);
    });

    it('updateCoAuthor: typing non-accredited hive leaves ORCID editable', () => {
      const comp = createComponent();
      comp.accreditedDirectory = directory;
      comp.coAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
      comp.updateCoAuthor(0, 'hive', 'mallory');
      expect(comp.coAuthors[0].orcid).toBe('');
      expect(comp.isCoAuthorAccredited(0)).toBe(false);
    });

    // Accredited→non-accredited hive transition must clear the prefilled ORCID.
    it('updateCoAuthor: accredited→non-accredited hive transition clears prefilled ORCID', () => {
      const comp = createComponent();
      comp.accreditedDirectory = directory;
      comp.coAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
      // Step 1: type accredited hive → ORCID prefilled
      comp.updateCoAuthor(0, 'hive', 'alice');
      expect(comp.coAuthors[0].orcid).toBe('0000-0001-1111-1111');
      // Step 2: change to non-accredited hive → ORCID cleared, input editable
      comp.updateCoAuthor(0, 'hive', 'mallory');
      expect(comp.coAuthors[0].orcid).toBe('');
      expect(comp.isCoAuthorAccredited(0)).toBe(false);
    });

    it('updateCoAuthor: stay-accredited hive change rewrites ORCID to the new accreditation', () => {
      const comp = createComponent();
      comp.accreditedDirectory = directory;
      comp.coAuthors = [{ name: 'A', hive: '', orcid: '', affiliation: '' }];
      comp.updateCoAuthor(0, 'hive', 'alice');
      expect(comp.coAuthors[0].orcid).toBe('0000-0001-1111-1111');
      comp.updateCoAuthor(0, 'hive', 'bob');
      expect(comp.coAuthors[0].orcid).toBe('0000-0002-2222-2222');
    });

    // Accredited but no orcid in record → don't blow away existing value.
    it('updateCoAuthor: accredited hive with no orcid in directory leaves typed orcid intact', () => {
      const comp = createComponent();
      comp.accreditedDirectory = directory;
      comp.coAuthors = [{ name: 'A', hive: '', orcid: '0000-9999-9999-9999', affiliation: '' }];
      comp.updateCoAuthor(0, 'hive', 'carol');
      expect(comp.coAuthors[0].orcid).toBe('0000-9999-9999-9999');
      // Still locked — the field is owned by the accreditation row.
      expect(comp.isCoAuthorAccredited(0)).toBe(true);
    });

    // Reapplication after directory loads must protect user-typed
    // ORCID. Test the `_loadAccreditedDirectory` path by stubbing the lib
    // module's loader.
    it('_loadAccreditedDirectory: reapplication preserves user-typed ORCID', async () => {
      // Reset the cached directory so loadAccreditedDirectory hits the mock
      // fresh, then seed a draft-restored coAuthors[] with a user-typed ORCID.
      const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
      _resetAccreditedDirectoryForTests();
      const { fetchAccreditations } = await import('../../src/api.js');
      fetchAccreditations.mockResolvedValueOnce({
        data: [
          { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
        ],
      });

      const comp = createComponent();
      // Simulate a draft-restored row: hive=alice (accredited), ORCID
      // already populated by the user before the fetch returned.
      comp.coAuthors = [
        { name: 'A', hive: 'alice', orcid: '0000-9999-9999-9999', affiliation: '' },
      ];

      await comp._loadAccreditedDirectory();

      // User intent preserved — reapplication did NOT clobber.
      expect(comp.coAuthors[0].orcid).toBe('0000-9999-9999-9999');
      // Directory populated for autocomplete + lock signals.
      expect(comp.accreditedDirectory.alice).toBeDefined();
      expect(comp.isCoAuthorAccredited(0)).toBe(true);
    });

    it('_loadAccreditedDirectory: reapplication fills blank ORCID on an accredited row', async () => {
      const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
      _resetAccreditedDirectoryForTests();
      const { fetchAccreditations } = await import('../../src/api.js');
      fetchAccreditations.mockResolvedValueOnce({
        data: [
          { username: 'alice', orcid: '0000-0001-1111-1111', name: 'Alice' },
        ],
      });

      const comp = createComponent();
      comp.coAuthors = [
        { name: 'A', hive: 'alice', orcid: '', affiliation: '' },
      ];

      await comp._loadAccreditedDirectory();

      expect(comp.coAuthors[0].orcid).toBe('0000-0001-1111-1111');
    });

    it('_loadAccreditedDirectory: bails out if component teardown happened mid-fetch', async () => {
      const { _resetAccreditedDirectoryForTests } = await import('../../src/lib/accredited-directory.js');
      _resetAccreditedDirectoryForTests();
      const { fetchAccreditations } = await import('../../src/api.js');
      let resolveFn;
      fetchAccreditations.mockReturnValueOnce(new Promise((r) => { resolveFn = r; }));

      const comp = createComponent();
      comp.coAuthors = [{ name: 'A', hive: 'alice', orcid: '', affiliation: '' }];

      const pending = comp._loadAccreditedDirectory();
      comp._teardownTimers(); // flips _mounted to false
      resolveFn({ data: [{ username: 'alice', orcid: '0000-0001-1111-1111' }] });
      await pending;

      // Teardown happened before the directory resolved — the page must
      // NOT touch its reactive state. accreditedDirectory stays at its
      // initial empty-object value.
      expect(comp.accreditedDirectory).toEqual({});
    });
  });

  describe('handleConnect sanitize invariant', () => {
    // Representative test for the 4 handleConnect copies (publish, review,
    // accreditation, bridge). Bodies are literal copies; one test proves the
    // pattern. If copies diverge later, add per-file coverage.
    it('shows i18n key in toast (never raw err.message) and warns with the real err', async () => {
      const leaky = new Error('keychain-reject-sentinel');
      mockStores.auth.connect = vi.fn().mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.handleConnect();
      expect(mockStores.toast.show).toHaveBeenCalledWith('common.connectionFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain('sentinel');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
    });
  });

  // _mountEditors awaits a dynamic import
  // of editor.js. If the component is destroyed (Alpine teardown) between
  // the $nextTick dispatch and the import resolving, $refs are stale and
  // any editor instances created post-await leak (destroy() already nulled
  // _abstractEditor / _bodyEditor, so it cannot tear down what we assign
  // afterwards). The guard is a `if (!this._mounted) return;` immediately
  // after the dynamic import.
  describe('_mountEditors teardown-during-init guard', () => {
    beforeEach(() => {
      mockCreateEditor.mockClear();
    });

    it('is a no-op when the component was destroyed before the import resolved', async () => {
      const comp = createComponent();
      // Simulate teardown that races with the in-flight dynamic import:
      // destroy() flips _mounted to false. The guard inside _mountEditors
      // must short-circuit before calling createEditor.
      comp.destroy();
      expect(comp._mounted).toBe(false);

      // Stale $refs are what destroy() would have left behind. The guard
      // must fire BEFORE these are touched.
      comp.$refs = { abstractEditor: null, bodyEditor: null };
      comp._abstractEditor = null;
      comp._bodyEditor = null;

      await comp._mountEditors();

      expect(mockCreateEditor).not.toHaveBeenCalled();
      expect(comp._abstractEditor).toBe(null);
      expect(comp._bodyEditor).toBe(null);
      // Mutation-kill for `if (!this._mounted) { ...; return; }`: the reset of
      // _editorsInitialized to false is reachable ONLY via the mounted-guard
      // early-return branch (the synchronous prefix sets it to true; the
      // null-ref guards in production return BEFORE any reset). If the
      // mounted-guard block is removed, _editorsInitialized stays true and
      // this assertion fails.
      expect(comp._editorsInitialized).toBe(false);
    });

    it('still mounts editors when the component is alive at import resolution', async () => {
      const comp = createComponent();
      // Simulate live refs after $nextTick.
      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };

      await comp._mountEditors();

      // Guard does NOT fire — createEditor runs for both refs.
      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      expect(comp._abstractEditor).toBeTruthy();
      expect(comp._bodyEditor).toBeTruthy();
    });

    // Mount-during-mount idempotency: a second _mountEditors call scheduled
    // before the first dynamic import resolves must short-circuit so the
    // same $refs are not re-bound and the first instance pair is not
    // orphaned-and-replaced. The `_editorsInitialized` guard at the top of
    // _mountEditors fires synchronously, before the await.
    it('is idempotent when invoked concurrently before the first import resolves', async () => {
      const comp = createComponent();
      const abstractEl = {};
      const bodyEl = {};
      comp.$refs = { abstractEditor: abstractEl, bodyEditor: bodyEl };

      const p1 = comp._mountEditors();
      const p2 = comp._mountEditors();
      await Promise.all([p1, p2]);

      expect(mockCreateEditor).toHaveBeenCalledTimes(2);
      expect(comp._abstractEditor).toBe(mockCreateEditor.mock.results[0].value);
      expect(comp._bodyEditor).toBe(mockCreateEditor.mock.results[1].value);
    });

    // The idempotency flag must clear on destroy so a later legitimate remount
    // (live-reload, navigation back to the page) can re-mount editors fresh.
    it('releases the idempotency flag on destroy so a later remount can re-init', async () => {
      const comp = createComponent();
      comp.$refs = { abstractEditor: {}, bodyEditor: {} };

      await comp._mountEditors();
      expect(comp._editorsInitialized).toBe(true);

      comp.destroy();
      expect(comp._editorsInitialized).toBe(false);
    });
  });
});
