import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  fetchPaperEnrichment: vi.fn(),
  fetchCitationExport: vi.fn(),
  retractPaper: vi.fn(),
  claimAuthorship: vi.fn(),
  approveAuthorshipClaim: vi.fn(),
  revokeAuthorshipClaim: vi.fn(),
}));

vi.mock('../../src/signer.js', () => ({
  broadcastOps: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  getAppTag: () => 'pevotest',
  getAppId: () => 'pevotest/1.0',
  getMaxUploadSize: () => 50 * 1024 * 1024,
  getMaxUploadSizeMB: () => 50,
}));

vi.mock('../../src/lib/version-diff.js', () => ({
  computeVersionDiff: vi.fn(),
}));

vi.mock('../../src/components/paper-card.js', () => ({
  formatDate: (d) => d,
}));

const mockStores = {
  router: { params: { author: 'alice', permlink: 'my-paper' }, navigate: vi.fn() },
  auth: { username: 'alice', isConnected: true, isAccredited: true, accreditation: { name: 'Alice Smith' } },
  toast: { show: vi.fn() },
  i18n: { locale: 'en' },
};

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => mockStores[name] || {}),
  },
}));

import Alpine from 'alpinejs';
import { initPaperDetailPage } from '../../src/pages/paper-detail.js';
import {
  fetchPaper,
  fetchCitationExport,
  retractPaper,
  claimAuthorship,
  approveAuthorshipClaim,
  revokeAuthorshipClaim,
} from '../../src/api.js';
import { computeVersionDiff } from '../../src/lib/version-diff.js';
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';

// Sentinel the DOM-bound field / toast must NOT contain.
const LEAK_SENTINEL = 'deadbeef-leak-sentinel';

function leakyError(code) {
  const err = new Error(`server leak: ${LEAK_SENTINEL} pg=table_not_found`);
  if (code) err.code = code;
  return err;
}

function createComponent(overrides = {}) {
  initPaperDetailPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$store = mockStores;
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  comp.$nextTick = vi.fn((fn) => fn && fn());
  Object.assign(comp, overrides);
  return comp;
}

describe('paperDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStores.auth.username = 'alice';
    mockStores.auth.isConnected = true;
    mockStores.auth.isAccredited = true;
    mockStores.auth.accreditation = { name: 'Alice Smith' };
    mockStores.router.params = { author: 'alice', permlink: 'my-paper' };
  });

  // Factory-exposure regression guard: the discipline badge in the page
  // template (`x-text="titleCaseDiscipline(paper.discipline)"`) fires a
  // silent ReferenceError if the helper isn't on the Alpine data factory.
  describe('factory exposes titleCaseDiscipline', () => {
    it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
      const comp = createComponent();
      expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline);
    });
  });

  describe('averageRatings', () => {
    it('returns null when no reviews', () => {
      const comp = createComponent();
      comp.paper = { reviews: [] };
      expect(comp.averageRatings).toBe(null);
    });

    it('returns null when paper has no reviews property', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.averageRatings).toBe(null);
    });

    it('returns null when reviews have no rating', () => {
      const comp = createComponent();
      comp.paper = { reviews: [{ body: 'hi' }] };
      expect(comp.averageRatings).toBe(null);
    });

    it('computes averages correctly', () => {
      const comp = createComponent();
      comp.paper = {
        reviews: [
          { rating: { methodology: 4, novelty: 3, clarity: 5, significance: 2 } },
          { rating: { methodology: 2, novelty: 5, clarity: 3, significance: 4 } },
        ],
      };
      const avg = comp.averageRatings;
      expect(avg.methodology).toBe(3);
      expect(avg.novelty).toBe(4);
      expect(avg.clarity).toBe(4);
      expect(avg.significance).toBe(3);
    });
  });

  describe('bodyWithoutAbstract', () => {
    it('returns empty string when no separator', () => {
      const comp = createComponent();
      comp.paper = { body: 'Just an abstract with no separator' };
      expect(comp.bodyWithoutAbstract).toBe('');
    });

    it('returns text after separator', () => {
      const comp = createComponent();
      comp.paper = { body: '## Abstract\n\nSome abstract\n\n---\n\nFull text here' };
      expect(comp.bodyWithoutAbstract).toBe('Full text here');
    });

    it('returns empty string when no body', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.bodyWithoutAbstract).toBe('');
    });
  });

  describe('hasFullText', () => {
    it('returns truthy when body has separator', () => {
      const comp = createComponent();
      comp.paper = { body: 'Abstract\n\n---\n\nBody text' };
      expect(comp.hasFullText).toBeTruthy();
    });

    it('returns falsy when no separator', () => {
      const comp = createComponent();
      comp.paper = { body: 'Only abstract' };
      expect(comp.hasFullText).toBeFalsy();
    });
  });

  describe('isOwnPaper', () => {
    it('returns true when username matches paper author', () => {
      const comp = createComponent();
      comp.paper = { author: 'alice', authors: [] };
      expect(comp.isOwnPaper).toBe(true);
    });

    it('returns true when username is a co-author', () => {
      mockStores.auth.username = 'bob';
      const comp = createComponent();
      comp.paper = { author: 'alice', authors: [{ hive: 'alice' }, { hive: 'bob' }] };
      expect(comp.isOwnPaper).toBe(true);
    });

    it('returns true when user has accepted authorship claim', () => {
      mockStores.auth.username = 'carol';
      const comp = createComponent();
      comp.paper = {
        author: 'alice',
        authors: [{ hive: 'alice' }],
        authorship_claims: [{ claimer: 'carol', status: 'accepted' }],
      };
      expect(comp.isOwnPaper).toBe(true);
    });

    it('returns false when not author/co-author/claimed', () => {
      mockStores.auth.username = 'dave';
      const comp = createComponent();
      comp.paper = { author: 'alice', authors: [{ hive: 'alice' }], authorship_claims: [] };
      expect(comp.isOwnPaper).toBe(false);
    });

    it('returns false when not connected', () => {
      mockStores.auth.username = null;
      const comp = createComponent();
      comp.paper = { author: 'alice', authors: [] };
      expect(comp.isOwnPaper).toBe(false);
    });
  });

  // UI-COAUTHOR-CONTINUATION-PUBLISHING round-2 item 1: the Edit-affordance
  // gate at paper-detail.js:296 reads `isOwnPaper && !paper.is_retracted &&
  // !isBridgePaper`. Bridge papers update via /api/bridge/update, NOT the
  // SPA edit flow, so suppressing the affordance for them is load-bearing.
  // Removing `!isBridgePaper` from the template would silently restore the
  // pre-fix behavior; these tests pin the getter and predicate matrix so a
  // mutation is caught at unit level.
  describe('isBridgePaper', () => {
    it('returns true when json_metadata.pevotest.type is "bridge_paper"', () => {
      const comp = createComponent();
      comp.paper = { json_metadata: { pevotest: { type: 'bridge_paper' } } };
      expect(comp.isBridgePaper).toBe(true);
    });

    it('returns false for a normal paper (type: "paper")', () => {
      const comp = createComponent();
      comp.paper = { json_metadata: { pevotest: { type: 'paper' } } };
      expect(comp.isBridgePaper).toBe(false);
    });

    it('returns false when json_metadata is missing', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.isBridgePaper).toBe(false);
    });

    it('returns false when pevotest namespace is missing', () => {
      const comp = createComponent();
      comp.paper = { json_metadata: {} };
      expect(comp.isBridgePaper).toBe(false);
    });

    it('returns false when type field is missing', () => {
      const comp = createComponent();
      comp.paper = { json_metadata: { pevotest: { discipline: 'physics' } } };
      expect(comp.isBridgePaper).toBe(false);
    });
  });

  // Affordance predicate matrix: isOwnPaper && !paper.is_retracted && !isBridgePaper.
  // Asserts at the getter-composition level (no DOM render). The four
  // dimensions: own paper Y/N, retracted Y/N, bridge paper Y/N. The
  // predicate must be FALSE on retracted, bridge, or non-own paths.
  describe('Edit affordance predicate matrix (isOwnPaper && !is_retracted && !isBridgePaper)', () => {
    it('own paper, non-bridge, not retracted -> predicate true', () => {
      const comp = createComponent();
      comp.paper = {
        author: 'alice',
        authors: [],
        is_retracted: false,
        json_metadata: { pevotest: { type: 'paper' } },
      };
      const predicate = comp.isOwnPaper && !comp.paper.is_retracted && !comp.isBridgePaper;
      expect(predicate).toBe(true);
    });

    it('own paper, bridge paper -> predicate false (bridge suppressed)', () => {
      const comp = createComponent();
      comp.paper = {
        author: 'alice',
        authors: [],
        is_retracted: false,
        json_metadata: { pevotest: { type: 'bridge_paper' } },
      };
      const predicate = comp.isOwnPaper && !comp.paper.is_retracted && !comp.isBridgePaper;
      expect(predicate).toBe(false);
    });

    it('own paper, retracted -> predicate false', () => {
      const comp = createComponent();
      comp.paper = {
        author: 'alice',
        authors: [],
        is_retracted: true,
        json_metadata: { pevotest: { type: 'paper' } },
      };
      const predicate = comp.isOwnPaper && !comp.paper.is_retracted && !comp.isBridgePaper;
      expect(predicate).toBe(false);
    });

    it('non-own paper, normal type -> predicate false', () => {
      mockStores.auth.username = 'dave';
      const comp = createComponent();
      comp.paper = {
        author: 'alice',
        authors: [{ hive: 'alice' }],
        authorship_claims: [],
        is_retracted: false,
        json_metadata: { pevotest: { type: 'paper' } },
      };
      const predicate = comp.isOwnPaper && !comp.paper.is_retracted && !comp.isBridgePaper;
      expect(predicate).toBe(false);
    });
  });

  describe('ipfsUrl', () => {
    it('returns null when no ipfs_cid', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.ipfsUrl).toBe(null);
    });

    it('constructs URL from gateway and cid', () => {
      const comp = createComponent();
      comp.paper = { ipfs_cid: 'QmTest123' };
      expect(comp.ipfsUrl).toBe('/api/ipfs/QmTest123');
    });
  });

  describe('supplementaryFiles', () => {
    it('returns paper.supplementary_files if present', () => {
      const comp = createComponent();
      const files = [{ cid: 'Qm1', filename: 'data.csv' }];
      comp.paper = { supplementary_files: files };
      expect(comp.supplementaryFiles).toEqual(files);
    });

    it('falls back to json_metadata', () => {
      const comp = createComponent();
      const files = [{ cid: 'Qm2', filename: 'fig.png' }];
      comp.paper = { json_metadata: { pevotest: { supplementary_files: files } } };
      expect(comp.supplementaryFiles).toEqual(files);
    });

    it('returns empty array when nothing present', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.supplementaryFiles).toEqual([]);
    });
  });

  describe('formatFileSize', () => {
    it('returns empty string for falsy', () => {
      const comp = createComponent();
      expect(comp.formatFileSize(0)).toBe('');
      expect(comp.formatFileSize(null)).toBe('');
    });

    it('formats bytes', () => {
      const comp = createComponent();
      expect(comp.formatFileSize(500)).toBe('500 B');
    });

    it('formats KB', () => {
      const comp = createComponent();
      expect(comp.formatFileSize(2048)).toBe('2.0 KB');
    });

    it('formats MB', () => {
      const comp = createComponent();
      expect(comp.formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });
  });

  describe('currentVersion, sortedVersions, latestVersion', () => {
    it('returns 1 when no versions', () => {
      const comp = createComponent();
      comp.paper = {};
      expect(comp.currentVersion).toBe(1);
      expect(comp.sortedVersions).toEqual([]);
      expect(comp.latestVersion).toBe(1);
    });

    it('returns last version number as current', () => {
      const comp = createComponent();
      comp.paper = { versions: [{ version_number: 1, created: '2024-01' }, { version_number: 3, created: '2024-03' }, { version_number: 2, created: '2024-02' }] };
      // currentVersion returns the last element from paper.versions (not sorted)
      expect(comp.currentVersion).toBe(2);
    });

    it('sortedVersions sorts by version_number', () => {
      const comp = createComponent();
      comp.paper = { versions: [{ version_number: 3 }, { version_number: 1 }, { version_number: 2 }] };
      expect(comp.sortedVersions.map(v => v.version_number)).toEqual([1, 2, 3]);
    });

    it('latestVersion is highest version_number', () => {
      const comp = createComponent();
      comp.paper = { versions: [{ version_number: 1 }, { version_number: 5 }, { version_number: 3 }] };
      expect(comp.latestVersion).toBe(5);
    });

    it('viewingVersion overrides currentVersion', () => {
      const comp = createComponent();
      comp.paper = { versions: [{ version_number: 1 }, { version_number: 2 }] };
      comp.viewingVersion = 1;
      expect(comp.currentVersion).toBe(1);
    });
  });

  describe('addToCollection', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('adds paper to collection in localStorage', () => {
      const comp = createComponent();
      comp.paper = { author: 'alice', permlink: 'paper-1', title: 'My Paper' };
      comp.addToCollection();
      const stored = JSON.parse(localStorage.getItem('pevo-citation-collection'));
      expect(stored).toEqual([{ author: 'alice', permlink: 'paper-1', title: 'My Paper' }]);
    });

    it('deduplicates if already in collection', () => {
      localStorage.setItem('pevo-citation-collection', JSON.stringify([{ author: 'alice', permlink: 'paper-1', title: 'My Paper' }]));
      const comp = createComponent();
      comp.paper = { author: 'alice', permlink: 'paper-1', title: 'My Paper' };
      comp.addToCollection();
      const stored = JSON.parse(localStorage.getItem('pevo-citation-collection'));
      expect(stored).toHaveLength(1);
      expect(mockStores.toast.show).toHaveBeenCalledWith('citation.alreadyInCollection', 'info');
    });
  });

  describe('selectDiffVersions / pickDiffVersion', () => {
    it('enters pick mode on first call', () => {
      const comp = createComponent();
      comp.paper = { versions: [{ version_number: 1 }, { version_number: 2 }] };
      comp.selectDiffVersions();
      expect(comp.pickingDiffVersions).toBe(true);
      expect(comp.diffVersionA).toBe(null);
      expect(comp.diffVersionB).toBe(null);
    });

    it('exits diff mode if already picking', () => {
      const comp = createComponent();
      comp.pickingDiffVersions = true;
      comp.selectDiffVersions();
      expect(comp.pickingDiffVersions).toBe(false);
      expect(comp.diffMode).toBe(false);
    });

    it('pickDiffVersion sets A then B with auto-sort', () => {
      const comp = createComponent();
      comp.pickingDiffVersions = true;
      comp.diffVersionA = null;
      comp.diffVersionB = null;
      // Mock startDiff to avoid async
      comp.startDiff = vi.fn();

      comp.pickDiffVersion(3);
      expect(comp.diffVersionA).toBe(3);

      comp.pickDiffVersion(1);
      // Auto-sort: A < B
      expect(comp.diffVersionA).toBe(1);
      expect(comp.diffVersionB).toBe(3);
      expect(comp.pickingDiffVersions).toBe(false);
      expect(comp.startDiff).toHaveBeenCalledWith(1, 3);
    });

    it('pickDiffVersion ignores same version', () => {
      const comp = createComponent();
      comp.pickingDiffVersions = true;
      comp.diffVersionA = 2;
      comp.diffVersionB = null;
      comp.startDiff = vi.fn();

      comp.pickDiffVersion(2);
      expect(comp.diffVersionB).toBe(null);
      expect(comp.startDiff).not.toHaveBeenCalled();
    });
  });

  describe('exitDiff', () => {
    it('resets all diff state', () => {
      const comp = createComponent();
      comp.diffMode = true;
      comp.diffVersionA = 1;
      comp.diffVersionB = 2;
      comp.diffResult = { title: {} };
      comp.diffLoading = true;
      comp.diffError = 'err';
      comp.pickingDiffVersions = true;

      comp.exitDiff();

      expect(comp.diffMode).toBe(false);
      expect(comp.diffVersionA).toBe(null);
      expect(comp.diffVersionB).toBe(null);
      expect(comp.diffResult).toBe(null);
      expect(comp.diffLoading).toBe(false);
      expect(comp.diffError).toBe(null);
      expect(comp.pickingDiffVersions).toBe(false);
    });
  });

  describe('claimStatusForSlot', () => {
    it('returns status when claim exists for index', () => {
      const comp = createComponent();
      comp.paper = { authorship_claims: [{ author_index: 1, status: 'pending' }] };
      expect(comp.claimStatusForSlot(1)).toBe('pending');
    });

    it('returns null when no claim for index', () => {
      const comp = createComponent();
      comp.paper = { authorship_claims: [{ author_index: 0, status: 'accepted' }] };
      expect(comp.claimStatusForSlot(1)).toBe(null);
    });
  });

  describe('canClaimSlot', () => {
    it('returns true when user hive matches slot and slot unclaimed', () => {
      mockStores.auth.username = 'bob';
      const comp = createComponent();
      comp.paper = {
        authors: [{ hive: 'alice', name: 'Alice' }, { hive: 'bob', name: 'Bob' }],
        authorship_claims: [],
      };
      expect(comp.canClaimSlot(1)).toBe(true);
    });

    it('returns false when not connected', () => {
      mockStores.auth.isConnected = false;
      const comp = createComponent();
      comp.paper = { authors: [{ hive: 'alice' }], authorship_claims: [] };
      expect(comp.canClaimSlot(0)).toBe(false);
    });

    it('returns false when user already has a claim', () => {
      mockStores.auth.username = 'bob';
      const comp = createComponent();
      comp.paper = {
        authors: [{ hive: 'bob', name: 'Bob' }],
        authorship_claims: [{ claimer: 'bob', author_index: 0, status: 'pending' }],
      };
      expect(comp.canClaimSlot(0)).toBe(false);
    });

    it('returns false when not accredited', () => {
      mockStores.auth.isAccredited = false;
      const comp = createComponent();
      comp.paper = { authors: [{ hive: 'alice' }], authorship_claims: [] };
      expect(comp.canClaimSlot(0)).toBe(false);
    });
  });

  describe('canClaimUnlisted', () => {
    it('returns true when user is not listed in authors and has no claim', () => {
      mockStores.auth.username = 'carol';
      mockStores.auth.accreditation = { name: 'Different Name' };
      const comp = createComponent();
      comp.paper = {
        authors: [{ hive: 'alice', name: 'Alice' }],
        authorship_claims: [],
      };
      expect(comp.canClaimUnlisted).toBe(true);
    });

    it('returns false when user is listed as hive author', () => {
      mockStores.auth.username = 'alice';
      const comp = createComponent();
      comp.paper = {
        authors: [{ hive: 'alice', name: 'Alice' }],
        authorship_claims: [],
      };
      expect(comp.canClaimUnlisted).toBe(false);
    });

    it('returns false when user already has a claim', () => {
      mockStores.auth.username = 'carol';
      const comp = createComponent();
      comp.paper = {
        authors: [{ hive: 'alice', name: 'Alice' }],
        authorship_claims: [{ claimer: 'carol', status: 'pending' }],
      };
      expect(comp.canClaimUnlisted).toBe(false);
    });
  });

  // Error-sanitization invariant (convention:
  // agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md).
  // Per sanitized handler: generic i18n key binds to DOM/toast, raw err reaches
  // console.warn, leak sentinel does NOT surface in the bound field/toast.
  describe('error sanitization', () => {
    let warnSpy;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('loadPaper generic branch: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      fetchPaper.mockRejectedValue(err);
      const comp = createComponent();
      await comp.loadPaper();
      expect(comp.error).toBe('paperDetail.errorLoadingTitle');
      expect(comp.error).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('loadPaper NOT_FOUND carve-out: localized title, no warn', async () => {
      // Retry loop yields 3 delayed attempts then falls to the final branch.
      // Keep delays from hanging the test by rejecting with NOT_FOUND on every attempt.
      const err = leakyError('NOT_FOUND');
      fetchPaper.mockRejectedValue(err);
      // Wrap the fake-timers block in try/finally so a mid-assertion throw
      // still restores real timers. vitest.config.js sets restoreMocks:true
      // but that does NOT restore timers — only mocks/spies.
      try {
        vi.useFakeTimers();
        const comp = createComponent();
        const p = comp.loadPaper();
        // Advance through the 3 x 2000ms retry delays.
        await vi.advanceTimersByTimeAsync(6000);
        await p;
        expect(comp.error).toBe('paperDetail.notFoundTitle');
        expect(comp.error).not.toContain(LEAK_SENTINEL);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('loadVersion: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      fetchPaper.mockRejectedValue(err);
      const comp = createComponent();
      await comp.loadVersion(2);
      expect(mockStores.toast.show).toHaveBeenCalledWith('common.loadVersionFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('handleCitationExport: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      fetchCitationExport.mockRejectedValue(err);
      const comp = createComponent();
      await comp.handleCitationExport('bibtex');
      expect(mockStores.toast.show).toHaveBeenCalledWith('citation.exportFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('handleRetract: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      retractPaper.mockRejectedValue(err);
      const comp = createComponent();
      await comp.handleRetract();
      expect(mockStores.toast.show).toHaveBeenCalledWith('retraction.failed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('startDiff: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      fetchPaper.mockRejectedValue(err);
      computeVersionDiff.mockReturnValue({ title: {} });
      const comp = createComponent();
      await comp.startDiff(1, 2);
      expect(comp.diffError).toBe('common.diffLoadFailed');
      expect(comp.diffError).not.toContain(LEAK_SENTINEL);
      expect(mockStores.toast.show).toHaveBeenCalledWith('common.diffLoadFailed', 'error');
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('handleClaimSlot: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      claimAuthorship.mockRejectedValue(err);
      const comp = createComponent();
      await comp.handleClaimSlot(0);
      expect(mockStores.toast.show).toHaveBeenCalledWith('claims.claimFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('handleApproveClaim: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      approveAuthorshipClaim.mockRejectedValue(err);
      const comp = createComponent();
      await comp.handleApproveClaim('bob', 0);
      expect(mockStores.toast.show).toHaveBeenCalledWith('claims.approveFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });

    it('handleRejectClaim: generic key, raw err to warn, no leak', async () => {
      const err = leakyError();
      revokeAuthorshipClaim.mockRejectedValue(err);
      const comp = createComponent();
      await comp.handleRejectClaim('bob');
      expect(mockStores.toast.show).toHaveBeenCalledWith('claims.rejectFailed', 'error');
      expect(mockStores.toast.show.mock.calls[0][0]).not.toContain(LEAK_SENTINEL);
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][1]).toBe(err);
    });
  });
});
