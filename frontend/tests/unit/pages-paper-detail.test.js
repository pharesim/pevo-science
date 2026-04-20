import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api.js', () => ({
  fetchPaper: vi.fn(),
  fetchPaperEnrichment: vi.fn(),
  fetchCitationExport: vi.fn(),
  retractPaper: vi.fn(),
  updateBridgePaper: vi.fn(),
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
});
