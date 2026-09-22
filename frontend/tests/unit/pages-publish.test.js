import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Uploads go through `uploadFile` in lib/ipfs-upload.js, which acquires the
// shared session window itself; route every upload through one controllable fn
// so tests set per-case resolve/reject.
const mockSessionUpload = vi.fn();
vi.mock('../../src/lib/ipfs-upload.js', () => ({
  uploadFile: (...a) => mockSessionUpload(...a),
  UPLOAD_SESSION_TORN_DOWN: 'UPLOAD_SESSION_TORN_DOWN',
  // Mirrors the real mapper, including the null contract for the
  // already-reported teardown code (the teardown's own toast is the message).
  describeUploadError: (err) =>
    err?.code === 'UPLOAD_SESSION_TORN_DOWN' ? null
      : err?.code === 'UPLOAD_CANCELLED' ? 'common.uploadCancelled'
        : err?.code === 'UPLOAD_REAUTH_FAILED' ? 'settings.reauthFailed'
          : 'common.uploadFailed',
}));

// The real lib/fresh-auth.js runs in these tests (only its api.js dependencies
// are stubbed), so the acquire-before-commit ordering the page relies on is
// exercised end to end rather than asserted against a stubbed gate.
const mockFetchEmailStatus = vi.fn(() => Promise.resolve({ data: { hasPassword: true } }));
const mockMintSessionAuthProof = vi.fn();
const mockStartOrcid = vi.fn();
vi.mock('../../src/api.js', () => ({
  fetchDisciplines: vi.fn(() => Promise.resolve({ data: [] })),
  fetchAccreditations: vi.fn(() => Promise.resolve({ data: [] })),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  mintSessionAuthProof: (...a) => mockMintSessionAuthProof(...a),
  startOrcid: (...a) => mockStartOrcid(...a),
  consentOpRequestFields: (t) => t,
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
  reauthModal: { request: vi.fn(() => Promise.resolve('hunter2')) },
  i18n: { messages: {} },
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
    it('extracts file info', async () => {
      const comp = createComponent();
      const file = { name: 'paper.pdf', size: 2 * 1024 * 1024 };
      await comp.handlePdfChange({ target: { files: [file] } });
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
      // Drain microtasks until the flow reaches broadcastOps rather than
      // counting ticks: the number of awaits ahead of the broadcast (window
      // acquisition, confirm dialog, upload legs) is an implementation detail
      // this assertion does not care about.
      for (let i = 0; i < 50 && !rejectFn; i += 1) await Promise.resolve();
      expect(rejectFn).toBeTypeOf('function');
      comp.destroy();
      rejectFn(new Error('post-teardown boom'));
      await pending;
      expect(comp.step).not.toBe('error');
      expect(comp.errorMessage).toBe('');
    });
  });

  // Acquire-before-commit (ARCHITECTURE.md § 6.4.1). The ORCID factor acquires
  // by full-page navigation, so a light account must hold a re-auth window
  // BEFORE it attaches a file or enters the submit sequence. Acquiring after
  // either point throws away the attached file and any completed upload, which
  // is what made "attach a PDF and publish" unreachable for a passwordless
  // account and what forced the retired per-batch plaintext password hold.
  describe('re-auth window ordering', () => {
    function lightComponent() {
      const comp = createComponent();
      comp.title = 'My Paper';
      comp.abstract = 'Paper abstract';
      comp.body = 'Body text';
      comp.discipline = 'Physics';
      comp.authorName = 'Alice';
      return comp;
    }

    beforeEach(() => {
      mockStores.auth.custody = 'light';
      mockStores.auth.isConnected = true;
      mockStores.auth.isAccredited = true;
      mockStores.auth.username = `user-${Math.random().toString(36).slice(2)}`;
      mockStores.reauthModal.request.mockResolvedValue('hunter2');
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
      mockMintSessionAuthProof.mockResolvedValue({
        fresh_auth_proof: 'window-proof',
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
        mechanism: 'password',
      });
      sessionStorage.clear();
    });

    afterEach(() => {
      delete mockStores.auth.custody;
      sessionStorage.clear();
    });

    it('acquires the window before recording a selected PDF', async () => {
      const comp = lightComponent();
      const file = { name: 'paper.pdf', size: 1024 };

      await comp.handlePdfChange({ target: { files: [file] } });

      expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
      expect(comp.pdfFile).toBe(file);
    });

    it('does not record a selected PDF when acquisition is declined', async () => {
      // A dismissed modal (or, for a passwordless account, a redirect in
      // flight) leaves the form untouched rather than half-committed. The
      // input is cleared alongside: browsers fire no `change` for an unchanged
      // selection, so a refused file left sitting in the input is unpickable —
      // the UI shows nothing attached and re-choosing it does nothing.
      mockStores.reauthModal.request.mockResolvedValue(null);
      const comp = lightComponent();
      const target = { files: [{ name: 'paper.pdf', size: 1024 }], value: 'C:\\fakepath\\paper.pdf' };

      await comp.handlePdfChange({ target });

      expect(comp.pdfFile).toBeNull();
      expect(target.value).toBe('');
    });

    it('confirms the publish before paying for any upload', async () => {
      // The dialog confirms an intent to publish, not an intent to upload, and
      // asking first spares the user paying for pins on a publish they cancel.
      // It also keeps a long dwell on the dialog from closing the window after
      // the uploads have already been paid for.
      const order = [];
      mockStores.broadcastConfirm.request.mockImplementation(async () => {
        order.push('confirm');
        return true;
      });
      mockSessionUpload.mockImplementation(async () => {
        order.push('upload');
        return { data: { cid: 'bafy', filename: 'paper.pdf' } };
      });
      broadcastOps.mockImplementation(async () => {
        order.push('broadcast');
        return { tx_id: 'tx' };
      });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      expect(order).toEqual(['confirm', 'upload', 'broadcast']);
    });

    it('a declined confirmation costs no upload at all', async () => {
      mockStores.broadcastConfirm.request.mockResolvedValue(false);
      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };

      await comp.handleSubmit();

      expect(mockSessionUpload).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    });

    it('disables the submit button before the first await, not after it', async () => {
      // `isSubmitting` derives from `step` and drives the button's :disabled.
      // Taking the re-auth await while still 'idle' leaves the button live, and
      // a second click re-enters handleSubmit: both calls coalesce onto one
      // acquisition, both resolve, and the user pays for two uploads and two
      // broadcasts.
      mockSessionUpload.mockResolvedValue({ data: { cid: 'bafy', filename: 'paper.pdf' } });
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });
      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };

      const pending = comp.handleSubmit();
      expect(comp.isSubmitting).toBe(true);

      await pending;
      expect(comp.step).toBe('success');
    });

    it('a declined submit gate returns the form to idle', async () => {
      mockStores.reauthModal.request.mockResolvedValue(null);
      const comp = lightComponent();

      await comp.handleSubmit();

      expect(comp.step).toBe('idle');
      expect(broadcastOps).not.toHaveBeenCalled();
    });

    it('re-auths before the broadcast when the uploads outlasted the window', async () => {
      // The margin is applied at the gates, and the broadcast is the last one.
      // Uploads are already paid for, so a window that closed while they ran is
      // worth one deliberate re-auth rather than a 401 mid-broadcast.
      mockSessionUpload.mockImplementation(async () => {
        // Stand in for a slow upload: leave the window with seconds on it.
        const raw = JSON.parse(sessionStorage.getItem('pevo_fresh_auth_session_proof'));
        raw.expiresAt = new Date(Date.now() + 5_000).toISOString();
        sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify(raw));
        return { data: { cid: 'bafy', filename: 'paper.pdf' } };
      });
      mockMintSessionAuthProof
        .mockResolvedValueOnce({
          fresh_auth_proof: 'window-1',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
          mechanism: 'password',
        })
        .mockResolvedValueOnce({
          fresh_auth_proof: 'window-2',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
          mechanism: 'password',
        });
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(2);
      expect(broadcastOps.mock.calls[0][2]).toMatchObject({ freshAuthProof: 'window-2' });
    });

    it('a passwordless window closing during the uploads refuses without navigation', async () => {
      // The pre-broadcast gate sits AFTER the IPFS legs, and the CIDs live in
      // handleSubmit locals the draft does not carry. For the password factor
      // a deliberate re-auth there costs a modal; for the ORCID factor it
      // would cost the completed pins, so the navigating factor is suppressed
      // and the user gets the re-authenticate toast with the form intact.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
        token: 'live-window',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        idlePeriodMs: 900_000,
      }));
      mockSessionUpload.mockImplementation(async () => {
        // Stand in for a slow upload: leave the window with seconds on it.
        const raw = JSON.parse(sessionStorage.getItem('pevo_fresh_auth_session_proof'));
        raw.expiresAt = new Date(Date.now() + 5_000).toISOString();
        sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify(raw));
        return { data: { cid: 'bafy', filename: 'paper.pdf' } };
      });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      // The pins were paid for, and neither a navigation nor a broadcast
      // followed; the refusal was told to the user and the form is intact.
      expect(mockSessionUpload).toHaveBeenCalledTimes(1);
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
      expect(mockStores.toast.show).toHaveBeenCalledWith(
        'Please confirm your identity again, then try once more.',
        'error',
      );
    });

    it('acquires the window before the upload leg, not after it', async () => {
      const order = [];
      mockMintSessionAuthProof.mockImplementation(async () => {
        order.push('acquire');
        return {
          fresh_auth_proof: 'window-proof',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
          mechanism: 'password',
        };
      });
      mockSessionUpload.mockImplementation(async () => {
        order.push('upload');
        return { data: { cid: 'bafy', filename: 'paper.pdf' } };
      });
      broadcastOps.mockImplementation(async () => {
        order.push('broadcast');
        return { tx_id: 'tx' };
      });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      expect(order).toEqual(['acquire', 'upload', 'broadcast']);
    });

    it('the whole submit sequence runs on one window with no second mint', async () => {
      mockSessionUpload.mockResolvedValue({ data: { cid: 'bafy', filename: 'paper.pdf' } });
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      comp.supplementaryFiles = [
        { file: { name: 's1.csv', size: 10 }, fileName: 's1.csv', description: '', uploading: false, cid: null, error: null },
        { file: { name: 's2.csv', size: 10 }, fileName: 's2.csv', description: '', uploading: false, cid: null, error: null },
      ];

      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      expect(mockSessionUpload).toHaveBeenCalledTimes(3);
      expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
    });

    it('one re-auth act covers both the upload and the broadcast', async () => {
      mockSessionUpload.mockResolvedValue({ data: { cid: 'bafy', filename: 'paper.pdf' } });
      broadcastOps.mockResolvedValue({ tx_id: 'tx' });

      const comp = lightComponent();
      await comp.handlePdfChange({ target: { files: [{ name: 'paper.pdf', size: 1024 }] } });
      await comp.handleSubmit();

      expect(comp.step).toBe('success');
      // Selecting the file opened the window; the submit, the upload and the
      // broadcast all rode it. One prompt, one mint.
      expect(mockStores.reauthModal.request).toHaveBeenCalledTimes(1);
      expect(mockMintSessionAuthProof).toHaveBeenCalledTimes(1);
    });

    it('never navigates on the password factor', async () => {
      const comp = lightComponent();
      await comp.handlePdfChange({ target: { files: [{ name: 'paper.pdf', size: 1024 }] } });

      // The whole point of adopting the password factor: no ORCID round-trip
      // out of the page the user is working on.
      expect(mockStartOrcid).not.toHaveBeenCalled();
    });

    it('leaves an unaccredited visitor alone', async () => {
      // They can fill the form but never submit it, so a re-auth act at file
      // selection would buy nothing and cost a passwordless one a round-trip.
      mockStores.auth.isAccredited = false;
      const comp = lightComponent();

      await comp.handlePdfChange({ target: { files: [{ name: 'paper.pdf', size: 1024 }] } });

      expect(mockFetchEmailStatus).not.toHaveBeenCalled();
      expect(mockStores.reauthModal.request).not.toHaveBeenCalled();
    });

    it('a torn-down session during the PDF upload shows exactly one toast and no error panel', async () => {
      // uploadFile's session teardown has already disconnected and shown the
      // re-login toast by the time its already-reported rejection reaches the
      // page (the mock stands in for both). The PDF catch must add nothing on
      // top: no generic upload-failure toast, no error panel, just a clean
      // unwind to idle with the form intact.
      mockSessionUpload.mockImplementation(async () => {
        Alpine.store('toast').show('Session inconsistency detected. Please sign in again.', 'error');
        const err = new Error('Session torn down. Sign in again.');
        err.code = 'UPLOAD_SESSION_TORN_DOWN';
        throw err;
      });

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      expect(mockStores.toast.show).toHaveBeenCalledTimes(1);
      expect(mockStores.toast.show).toHaveBeenCalledWith(
        'Session inconsistency detected. Please sign in again.',
        'error',
      );
      expect(comp.step).toBe('idle');
      expect(comp.errorMessage).toBe('');
      expect(broadcastOps).not.toHaveBeenCalled();
    });

    it('a torn-down session during a supplementary upload leaves no inline retry row', async () => {
      mockSessionUpload.mockImplementation(async () => {
        Alpine.store('toast').show('Session inconsistency detected. Please sign in again.', 'error');
        const err = new Error('Session torn down. Sign in again.');
        err.code = 'UPLOAD_SESSION_TORN_DOWN';
        throw err;
      });

      const comp = lightComponent();
      comp.supplementaryFiles = [
        { file: { name: 's1.csv', size: 10 }, fileName: 's1.csv', description: '', uploading: false, cid: null, error: null },
      ];
      await comp.handleSubmit();

      // The teardown's toast is the only message: no inline row inviting a
      // retry that cannot succeed until re-login, no error panel on top.
      expect(mockStores.toast.show).toHaveBeenCalledTimes(1);
      expect(comp.supplementaryFiles[0].error).toBeNull();
      expect(comp.supplementaryFiles[0].uploading).toBe(false);
      expect(comp.step).toBe('idle');
      expect(comp.errorMessage).toBe('');
      expect(broadcastOps).not.toHaveBeenCalled();
    });

    it('a passwordless remintable 401 at the broadcast leg refuses with the toast instead of navigating', async () => {
      // The pre-broadcast gate passed on a live window, the uploads are paid
      // for, and the broadcast finds the window closed server-side (another
      // tab's password reset or custody upgrade ends open windows). The 401
      // retry's re-acquisition must inherit the suppressed posture the page
      // passes to broadcastWithFreshAuth: a re-authenticate toast with the
      // pins in handleSubmit locals intact, never a full-page ORCID
      // navigation that would discard them.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
        token: 'live-window',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        idlePeriodMs: 900_000,
      }));
      mockSessionUpload.mockResolvedValue({ data: { cid: 'bafy', filename: 'paper.pdf' } });
      broadcastOps.mockRejectedValueOnce(Object.assign(new Error('FRESH_AUTH_REQUIRED'), {
        status: 401, code: 'FRESH_AUTH_REQUIRED', details: { reason: 'expired' },
      }));

      const comp = lightComponent();
      comp.pdfFile = { name: 'paper.pdf', size: 1024 };
      await comp.handleSubmit();

      // One attempt, no navigating retry, and the refusal was told.
      expect(broadcastOps).toHaveBeenCalledTimes(1);
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
      expect(mockStores.toast.show).toHaveBeenCalledWith(
        'Please confirm your identity again, then try once more.',
        'error',
      );
    });

    // Whether the form holds a file decides whether a gate may navigate. Files
    // live in component state, never in the draft, so a full-page ORCID
    // round-trip discards them. A gate reached while nothing is attached keeps
    // the navigating factor (the worst case is re-picking the one file being
    // chosen); once a file is held, every gate refuses a passwordless account
    // non-destructively and says so.
    it('a passwordless account resubmitting with a file attached is asked, and keeps the file on a decline', async () => {
      // The entry gate must not fire the navigation that wipes the attached
      // file. It must not dead-end either: a passwordless account has no other
      // factor, so a refusal with only a toast behind it leaves this form
      // unsubmittable for good. Ask, and honour a no by changing nothing.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);
      const comp = lightComponent();
      const file = { name: 'paper.pdf', size: 1024 };
      comp.pdfFile = file;

      await comp.handleSubmit();

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
      );
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(mockSessionUpload).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.pdfFile).toBe(file);
      expect(comp.step).toBe('idle');
      // A decline is the user's own choice to stop. Toasting the way through
      // on top of the dialog that just offered it is noise.
      expect(mockStores.toast.show).not.toHaveBeenCalled();
    });

    it('a passwordless account that accepts the cost navigates, with the draft already written', async () => {
      // The draft save is debounced by two seconds, so the words typed just
      // before Submit live only in component state. Confirming sends the tab
      // to ORCID, and the copy promises the text will be there on the way
      // back, so the write has to happen before the round-trip starts, not on
      // the timer that the navigation cancels.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      let draftAtOrcid = null;
      mockStartOrcid.mockImplementation(async () => {
        draftAtOrcid = localStorage.getItem('pevo-draft-publish');
        return { redirect_url: 'https://orcid.org/oauth/authorize?x=1' };
      });
      mockStores.broadcastConfirm.request.mockResolvedValueOnce(true);
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/publish' } });
      try {
        const comp = lightComponent();
        comp._initialLoadDone = true;
        comp.pdfFile = { name: 'paper.pdf', size: 1024 };

        await comp.handleSubmit();

        expect(mockStores.broadcastConfirm.request).toHaveBeenCalledTimes(1);
        expect(mockStartOrcid).toHaveBeenCalledTimes(1);
        expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
        expect(JSON.parse(draftAtOrcid)).toMatchObject({ title: 'My Paper', body: 'Body text' });
        // Nothing was spent on the way out: the upload legs sit past the gate.
        expect(mockSessionUpload).not.toHaveBeenCalled();
        expect(broadcastOps).not.toHaveBeenCalled();
        expect(comp.step).toBe('idle');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('asks a passwordless account that attached files before accreditation landed', async () => {
      // The file-selection gate returns true ungated while unaccredited, so
      // this account reaches its first submit holding a file and having never
      // held a window. The copy must not presume a previous one, and the offer
      // must still be made: without it the first thing accreditation buys is a
      // form that cannot be submitted.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      mockStores.auth.isAccredited = false;
      const comp = lightComponent();
      const target = { files: [{ name: 'paper.pdf', size: 1024 }], value: 'C:\\fakepath\\paper.pdf' };

      await comp.handlePdfChange({ target });

      // Ungated while unaccredited: the file attached with no acquisition.
      expect(comp.pdfFile).toEqual({ name: 'paper.pdf', size: 1024 });
      expect(mockStores.broadcastConfirm.request).not.toHaveBeenCalled();

      mockStores.auth.isAccredited = true;
      mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);

      await comp.handleSubmit();

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
      );
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
    });

    it('with nothing attached, the entry gate still navigates a passwordless account', async () => {
      // The permissive default is deliberate where nothing would be lost: the
      // text fields are drafted, so the round-trip costs the user nothing.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      vi.stubGlobal('window', { ...globalThis.window, location: { href: '', pathname: '/publish' } });
      try {
        const comp = lightComponent();

        await comp.handleSubmit();

        expect(mockStartOrcid).toHaveBeenCalledTimes(1);
        expect(window.location.href).toBe('https://orcid.org/oauth/authorize?x=1');
        expect(mockSessionUpload).not.toHaveBeenCalled();
        expect(broadcastOps).not.toHaveBeenCalled();
        expect(comp.step).toBe('idle');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('picking a supplementary file with a PDF already attached refuses without navigation and keeps the PDF', async () => {
      // The file-selection gate is permissive only while nothing is attached:
      // with a PDF held, navigating to acquire for the second file would
      // discard the first.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      const comp = lightComponent();
      const pdf = { name: 'paper.pdf', size: 1024 };
      comp.pdfFile = pdf;
      const target = { files: [{ name: 'data.csv', size: 10 }], value: 'C:\\fakepath\\data.csv' };

      mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);

      await comp.handleSupplementaryFiles({ target });

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
      );
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(comp.pdfFile).toBe(pdf);
      expect(comp.supplementaryFiles).toEqual([]);
      expect(target.value).toBe('');
      expect(mockStores.toast.show).not.toHaveBeenCalled();
    });

    it('picking a PDF with a supplementary file already attached refuses without navigation and keeps it', async () => {
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      const comp = lightComponent();
      const attached = { file: { name: 'data.csv', size: 10 }, fileName: 'data.csv', description: '', uploading: false, cid: null, error: null };
      comp.supplementaryFiles = [attached];
      const target = { files: [{ name: 'paper.pdf', size: 1024 }], value: 'C:\\fakepath\\paper.pdf' };

      mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);

      await comp.handlePdfChange({ target });

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
      );
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(comp.pdfFile).toBeNull();
      expect(comp.supplementaryFiles).toEqual([attached]);
      expect(target.value).toBe('');
      expect(mockStores.toast.show).not.toHaveBeenCalled();
    });

    it('picking a PDF over one already attached asks, like every other gate reached with a file held', async () => {
      // The PDF slot carries no special posture. What is held decides, and a
      // held PDF is held work: the pick is gated the same way a supplementary
      // pick is, and the way through is the same question rather than a
      // hidden move only a reader of the source would find.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      mockStores.broadcastConfirm.request.mockResolvedValueOnce(false);
      const comp = lightComponent();
      const held = { name: 'paper.pdf', size: 1024 };
      comp.pdfFile = held;
      const target = { files: [{ name: 'paper-v2.pdf', size: 2048 }], value: 'C:\\fakepath\\paper-v2.pdf' };

      await comp.handlePdfChange({ target });

      expect(mockStores.broadcastConfirm.request).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'confirm.reauthNavigateTitle' }),
      );
      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(comp.pdfFile).toBe(held);
      expect(target.value).toBe('');
    });

    it('with nothing attached, a window closing while the confirm dialog is open refuses at the pre-broadcast gate without navigation', async () => {
      // The entry gate passed on a live window with no file held, so the
      // posture the predicate computes would allow navigation. The
      // pre-broadcast gate overrides it unconditionally: past the confirm a
      // round-trip buys nothing, and a long dwell on the dialog is exactly how
      // a window closes between the two gates. With a file held the predicate
      // alone would refuse, so this is the one arrangement that pins the
      // override itself.
      mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: false } });
      mockStartOrcid.mockResolvedValue({ redirect_url: 'https://orcid.org/oauth/authorize?x=1' });
      sessionStorage.setItem('pevo_fresh_auth_session_proof', JSON.stringify({
        token: 'live-window',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        idlePeriodMs: 900_000,
      }));
      mockStores.broadcastConfirm.request.mockImplementationOnce(async () => {
        sessionStorage.removeItem('pevo_fresh_auth_session_proof');
        return true;
      });

      const comp = lightComponent();
      await comp.handleSubmit();

      expect(mockStartOrcid).not.toHaveBeenCalled();
      expect(broadcastOps).not.toHaveBeenCalled();
      expect(comp.step).toBe('idle');
      expect(mockStores.toast.show).toHaveBeenCalledWith(
        'Please confirm your identity again, then try once more.',
        'error',
      );
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
