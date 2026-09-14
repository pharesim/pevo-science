// Vocabulary-driven exhaustiveness pins for the session-window outcome
// dispatch in `lib/fresh-auth.js` and its consuming sites.
//
// The outcome vocabulary (`WINDOW_OUTCOME_KEYS`) is consumed by three
// independently owned sites: the page gate `freshAuthWindowReady` and the
// broadcast unwinder (both dispatch through `showWindowOutcomeToast`), and
// the upload pre-flight in `lib/ipfs-upload.js` (dispatches through
// `UPLOAD_CODE_BY_WINDOW_OUTCOME`). A member added to the vocabulary without
// a matching entry at a consumer historically surfaced as a silent drop: the
// action refused with no message at all, or refused with the WRONG message (a
// cancel the user never made). Every loop below is driven from the
// vocabulary's own exported constants, never a hand-copied list, so the suite
// grows when the vocabulary does and fails on the consumer that ignored the
// new member.
//
// Mocking justification (clause-a of project-CLAUDE.md "Carve-out for
// deterministic edge-case coverage"): these tests exercise pure dispatch
// structures (sentinel registration, outcome classification, table lookups),
// not acquisition itself. api.js and signer.js are module-load dependencies
// of the real fresh-auth.js / ipfs-upload.js that perform real fetch(); they
// are stubbed so the real modules import, and none of their functions is
// invoked here. Alpine's stores are mocked so the toast dispatch is
// observable. No auth middleware is mocked and no cryptographic verification
// is bypassed (clause-b). Clause-c real-path companions: the behavioral
// acquisition suites (lib-fresh-auth-session-window.test.js,
// fresh-auth-401-retry.test.js, lib-ipfs-upload.test.js) pin each member's
// user-visible action at each site, and
// frontend/tests/e2e/non-consent-fresh-auth.spec.js drives the acquisition
// these outcomes describe against the real backend on its ready path: a real
// mint, and a window carried on a real broadcast and a real upload pre-flight.
// No e2e spec reaches a non-ready outcome. Every member of this vocabulary is
// a non-ready outcome (four refusals and the ORCID navigation), and none is
// induced there, so the dispatch itself is pinned here only.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockToastStore = { show: vi.fn() };

vi.mock('../../src/api.js', () => ({
  startOrcid: vi.fn(),
  consentOpRequestFields: vi.fn(),
  fetchEmailStatus: vi.fn(),
  mintSessionAuthProof: vi.fn(),
  uploadFileToIpfs: vi.fn(),
}));

vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'toast') return mockToastStore;
      if (name === 'i18n') return { messages: {} };
      return null;
    }),
  },
}));

const freshAuth = await import('../../src/lib/fresh-auth.js');
const {
  WINDOW_OUTCOME_KEYS,
  acquisitionOutcomeKey,
  windowOutcomeKey,
  showWindowOutcomeToast,
} = freshAuth;
const { UPLOAD_CODE_BY_WINDOW_OUTCOME, describeUploadError } = await import(
  '../../src/lib/ipfs-upload.js'
);

// The outcomes that deliberately stay silent at the toasting sites: an
// in-flight navigation needs no message, and a user's own dismissal warrants
// none. Silence for any OTHER member is a gap, so a new member joins this
// list only as an explicit decision made here.
const SILENT_ON_PURPOSE = ['redirect', 'cancelled'];

describe('window-outcome vocabulary', () => {
  it('carries every distinct member the sentinels can produce', () => {
    // Guards the loops below against a vocabulary that silently emptied,
    // which would make every per-member assertion vacuously green.
    expect(WINDOW_OUTCOME_KEYS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(WINDOW_OUTCOME_KEYS).size).toBe(WINDOW_OUTCOME_KEYS.length);
  });

  it('registers every exported acquisition sentinel, or pins it as internally resolved', () => {
    // The ORCID fallback never escapes acquisition: it resolves to the
    // redirect or the suppressed refusal before any window consumer sees it.
    // A NEW sentinel export that classifies to null fails here, forcing the
    // decision: register it in the vocabulary or pin it as internal.
    const INTERNALLY_RESOLVED = ['FRESH_AUTH_ORCID_FALLBACK'];
    const sentinels = Object.entries(freshAuth).filter(([name]) =>
      name.startsWith('FRESH_AUTH_'),
    );
    expect(sentinels.length).toBeGreaterThanOrEqual(6);
    for (const [name, value] of sentinels) {
      const key = acquisitionOutcomeKey(value);
      if (INTERNALLY_RESOLVED.includes(name)) {
        expect(key, `${name} is pinned as internally resolved and must not classify`).toBeNull();
      } else {
        expect(WINDOW_OUTCOME_KEYS, `${name} must classify into the vocabulary`).toContain(key);
      }
    }
  });

  it('classifies each outcome object to exactly its own member, and ready to none', () => {
    for (const key of WINDOW_OUTCOME_KEYS) {
      expect(windowOutcomeKey({ ready: false, [key]: true })).toBe(key);
    }
    expect(windowOutcomeKey({ ready: true, proof: 'p' })).toBeNull();
    expect(acquisitionOutcomeKey('a-proof-string')).toBeNull();
  });
});

describe('toast dispatch (page gate and broadcast unwinder)', () => {
  beforeEach(() => {
    mockToastStore.show.mockClear();
  });

  it('every vocabulary member either toasts or is pinned as deliberately silent', () => {
    // The page gate and the broadcast unwinder both surface non-ready
    // outcomes exclusively through this dispatch, so a member missing from
    // the toast table is a silent refusal at BOTH sites; this loop is the
    // red bar for that gap.
    for (const key of WINDOW_OUTCOME_KEYS) {
      mockToastStore.show.mockClear();
      showWindowOutcomeToast(key);
      if (SILENT_ON_PURPOSE.includes(key)) {
        expect(mockToastStore.show, `${key} is pinned silent and must not toast`).not.toHaveBeenCalled();
      } else {
        expect(mockToastStore.show, `${key} owes the user a message`).toHaveBeenCalledWith(
          expect.any(String),
          'error',
        );
      }
    }
  });

  it('a ready outcome never toasts', () => {
    showWindowOutcomeToast(null);
    showWindowOutcomeToast(windowOutcomeKey({ ready: true, proof: 'p' }));
    expect(mockToastStore.show).not.toHaveBeenCalled();
  });
});

describe('upload pre-flight dispatch (lib/ipfs-upload.js)', () => {
  it('maps every vocabulary member to an upload error code, with no phantom rows', () => {
    // Key-set equality both ways: a vocabulary member without a row would
    // silently misclassify as a cancel at the pre-flight, and a row for a
    // member that no longer exists is dead dispatch.
    expect(Object.keys(UPLOAD_CODE_BY_WINDOW_OUTCOME).sort()).toEqual(
      [...WINDOW_OUTCOME_KEYS].sort(),
    );
  });

  it('every mapped code reaches a specific description, never the generic fall-through', () => {
    // A new member routed to a new code that describeUploadError does not
    // know collapses to the generic upload-failure key, which is exactly the
    // wrong-message outcome the vocabulary exists to prevent.
    for (const key of WINDOW_OUTCOME_KEYS) {
      const code = UPLOAD_CODE_BY_WINDOW_OUTCOME[key];
      const described = describeUploadError({ code });
      expect(described, `${key} (${code}) must map to an i18n key`).toEqual(expect.any(String));
      expect(described, `${key} (${code}) must be specifically described`).not.toBe(
        'common.uploadFailed',
      );
    }
  });
});
