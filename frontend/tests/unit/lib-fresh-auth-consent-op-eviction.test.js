import { describe, it, expect, vi, beforeEach } from 'vitest';

// The consent-op proof cache refusing a token that is not a string, driven
// through BOTH of its consumers.
//
// `getCachedConsentOpProof` drops a falsy token and, before this suite existed,
// returned any truthy one without type-testing it; the `/orcid/callback`
// fresh-auth handler writes the response's `fresh_auth_proof` into that slot
// while type-checking the echoed target fields of the same response. So a
// truthy non-string could reach the slot and be handed straight to the guarded
// call. `consentOpFreshAuthRetryGate` would normally heal that, but it
// rethrows a validation rejection before its `clearProofCache` hook runs: on a
// route whose request schema declares the proof as a bounded string, a
// non-string draws a validation rejection instead and nothing drops the entry. The
// accreditation-metadata edit and the admin authority actions are that class;
// the settings and custody routes coerce a non-string to undefined and answer
// FRESH_AUTH_REQUIRED with reason `missing`, which the gate does clear on.
//
// `evictUnnamedAcquisition` closed the same shape one slot over, for the
// session window, at the producer rather than at each consumer. These cases pin
// the consent-op half of that parity: the drop lives in the single reader, so
// both orchestrators' cache legs inherit it.
//
// Why a file of its own rather than cases in lib-settings-fresh-auth.test.js or
// lib-authorship-consent.test.js: both of those replace
// `getCachedConsentOpProof` and `clearCachedConsentOpProof` with vi.fn through a
// partial mock of fresh-auth.js. vi.mock is hoisted and applies to the whole
// file, so a case added there would exercise the stub and pass whatever the
// real reader does. Here fresh-auth.js is not mocked in any form and runs
// against jsdom's sessionStorage.
//
// Mocking justification (project-CLAUDE.md "Carve-out for deterministic
// edge-case coverage", clause-a): the two mints (`mintSettingsActionProof` and
// `mintAuthorshipFreshAuthProof`, real fetch() of POST /custody/fresh-auth), the
// status read (`fetchEmailStatus`, real fetch() of /settings/email), the ORCID
// start (`startOrcid`) and the broadcast carrier (signer.js `broadcastOps`) are
// mocked. What these cases stage is a cache entry whose token is not a string,
// which no backend response produces on purpose and which no account can be
// provisioned into; and observing whether that value reaches the guarded call
// has to happen without spending a real settings mutation or a real chain
// broadcast on it. Everything the behaviour lives in stays real: the cache
// writer and reader, both orchestrators, the shared password-factor mint, the
// retry gate, the outcome sentinels, and the browser storage the entry sits in.
//
// Clause-b: no auth or permission middleware is mocked and no cryptographic
// verification is bypassed. The proof's binding, its single-use consumption and
// its subject check are all server-side; the question here is which VALUE the
// client hands to a guarded call, not whether a proof is valid.
//
// Clause-c real-path companion: the risk class is a cached proof of the wrong
// type being handed on or left in the slot for the next attempt.
// tests/e2e/settings.spec.js drives the password factor against the real stack,
// minting at the real POST /api/custody/fresh-auth through the reauth modal and
// asserting the proof that rides into the action request is a non-empty string.
// tests/e2e/settings-orcid-factor.spec.js completes the ORCID factor's full
// start / callback / resume round-trip, and its real-backend case removes both
// route stubs so a genuine backend-minted proof is written into this same slot
// by the real `/orcid/callback` handler and consumed by the real settings
// submit. tests/e2e/consent-op-fresh-auth.spec.js drives a light-account
// authorship broadcast carrying a consent-op proof for real, on the password
// factor, which never writes this slot; no e2e spec lands an ORCID-minted
// consent-op proof in the slot and then broadcasts it, so the eviction of a
// wrong-type entry on that surface is pinned here only.

// Every mock handle is reached through an arrow inside its vi.mock factory: a
// factory runs during the static-import phase, before these consts
// initialize, so naming one directly inside a factory is a TDZ error.
const mockMintSettingsActionProof = vi.fn();
const mockMintAuthorshipFreshAuthProof = vi.fn();
const mockFetchEmailStatus = vi.fn();
const mockStartOrcid = vi.fn();
const reauthRequest = vi.fn();
const toastShow = vi.fn();
const authDisconnect = vi.fn();

// A module-load dependency of fresh-auth.js; nothing here broadcasts.
vi.mock('../../src/signer.js', () => ({ broadcastOps: vi.fn() }));

// Every api.js name the three real modules dereference has to appear here:
// vitest throws "No <name> export is defined on the mock" at first access, not
// at import, so a missing one surfaces as a failure in whichever case reaches
// it first.
vi.mock('../../src/api.js', () => ({
  mintSettingsActionProof: (...a) => mockMintSettingsActionProof(...a),
  mintAuthorshipFreshAuthProof: (...a) => mockMintAuthorshipFreshAuthProof(...a),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
  startOrcid: (...a) => mockStartOrcid(...a),
  consentOpRequestFields: (target) => target,
  mintSessionAuthProof: vi.fn(),
}));

vi.mock('alpinejs', () => ({
  default: {
    store: vi.fn((name) => {
      if (name === 'reauthModal') {
        return { request: (...a) => reauthRequest(...a), cancel: () => {} };
      }
      // The username matches the `LIGHT` ctx these cases pass, so the shared
      // resolver's username-keyed memo behaves as it does in production.
      if (name === 'auth') {
        return { username: 'alice', disconnect: (...a) => authDisconnect(...a) };
      }
      if (name === 'toast') return { show: (...a) => toastShow(...a) };
      if (name === 'i18n') return { messages: null };
      return null;
    }),
  },
}));

// fresh-auth.js is deliberately not mocked, in any form. That is the whole
// reason this file exists.
import { withSettingsFreshAuth } from '../../src/lib/settings-fresh-auth.js';
import { withAuthorshipFreshAuth } from '../../src/lib/authorship-consent.js';
import {
  cacheConsentOpProof,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
} from '../../src/lib/fresh-auth.js';
// The storage key from its single source of truth, never a literal.
import { CONSENT_OP_PROOF_KEY } from '../../src/lib/subject-bound-keys.js';

const LIGHT = { custody: 'light', username: 'alice' };

// The settings action whose request schema declares the proof as a bounded
// string. A non-string token draws a validation rejection there rather than a
// fresh-auth one, which is the production path `consentOpFreshAuthRetryGate`
// rethrows before it reaches `clearProofCache`.
const SETTINGS_ACTION = 'edit_accreditation_metadata';

// An approve target binds the richest set: paper, slot and subject.
const TARGET = {
  action: 'approve_authorship',
  rootAuthor: 'dave',
  rootPermlink: 'a-paper',
  authorIndex: 2,
  claimer: 'bob',
};

// A number and an object are the two shapes a poisoned entry can actually
// carry: both survive JSON.stringify into sessionStorage and both read as
// truthy, which together are what let one reach the guarded call and stay
// cached afterwards. A Symbol is the tidier illustration and the wrong pin,
// because JSON.stringify omits a Symbol-valued field: the entry comes back
// tokenless, the pre-existing falsy branch drops it unaided, and a check
// narrowed to one member would still look covered.
const POISON_ROWS = [
  { label: 'a numeric token', token: 4242 },
  { label: 'an object token', token: { not: 'a proof' } },
];

const future = () => new Date(Date.now() + 3_600_000).toISOString();

// The api.js ApiRequestError shape as the orchestrators see it: a code, and
// details only when the server sent them. A zod-rejected body answers
// BAD_REQUEST with no details, which is what makes it non-remintable.
const codedError = (code, reason) =>
  Object.assign(new Error(code), { code, details: reason ? { reason } : undefined });

function storedEntry() {
  const raw = sessionStorage.getItem(CONSENT_OP_PROOF_KEY);
  return raw ? JSON.parse(raw) : null;
}

// Seed through the real writer, which is what the `/orcid/callback` fresh-auth
// handler calls, and with a live TTL in the field the reader parses: an entry
// seeded past its expiry is dropped by the expiry branch instead, and every
// poisoned-entry case would pass without the type drop. The read-back is the
// non-vacuity
// check, so a write-side guard growing over this shape fails loudly here rather
// than quietly leaving an empty slot behind.
function seedSettingsProof(token) {
  cacheConsentOpProof(token, future(), SETTINGS_ACTION, LIGHT.username, '');
  expect(storedEntry()?.token).toEqual(token);
}

function seedAuthorshipProof(token) {
  cacheConsentOpProof(
    token, future(), TARGET.action, TARGET.rootAuthor, TARGET.rootPermlink,
    TARGET.authorIndex, TARGET.claimer,
  );
  expect(storedEntry()?.token).toEqual(token);
}

let run;

beforeEach(() => {
  sessionStorage.clear();
  // Module state in the real fresh-auth.js outlives a case: the per-username
  // password-factor memo would otherwise skip the status read, and a flight
  // left installed by a failing case would be joined by the next one. Both
  // clears belong here and nowhere else. `abandonInFlightAcquisitions` bumps the
  // teardown generation, so calling it mid-case would make every open guard read
  // torn-down and the work under test would unwind as a cancel.
  clearPasswordFactorMemo();
  abandonInFlightAcquisitions();

  // restoreMocks is on repo-wide, so every default is installed here rather than
  // at declaration.
  mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
  reauthRequest.mockResolvedValue('hunter2');
  mockMintSettingsActionProof.mockResolvedValue('minted-settings-proof');
  mockMintAuthorshipFreshAuthProof.mockResolvedValue('minted-authorship-proof');
  // No case here takes the ORCID factor: a refused entry falls through to the
  // ordinary password mint. A start that fires anyway fails loudly instead of
  // assigning window.location under jsdom.
  mockStartOrcid.mockRejectedValue(new Error('unexpected ORCID start'));
  run = vi.fn().mockResolvedValue({ ok: true });
});

describe('withSettingsFreshAuth over the real consent-op cache', () => {
  it('a cached STRING proof at this target is still reused', async () => {
    // Target-alignment control. Every poisoned-entry case rests on the seeded
    // target being the one `resolveProof` looks up, (action, username, ''); a
    // mis-keyed seed would miss on the target comparison rather than on the
    // token, and the whole describe would go green for the wrong reason.
    cacheConsentOpProof('cached-proof', future(), SETTINGS_ACTION, LIGHT.username, '');

    const out = await withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run);

    expect(out).toEqual({ ok: { ok: true } });
    expect(run).toHaveBeenCalledWith('cached-proof');
    expect(reauthRequest).not.toHaveBeenCalled();
    expect(mockMintSettingsActionProof).not.toHaveBeenCalled();
  });

  it.each(POISON_ROWS)(
    'never hands $label to the guarded call; the action mints instead',
    async ({ token }) => {
      seedSettingsProof(token);

      const out = await withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run);

      expect(out).toEqual({ ok: { ok: true } });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('minted-settings-proof');
      expect(run).not.toHaveBeenCalledWith(token);
      // An ordinary mint, not a cache hit: the prompt opened and the password
      // factor answered.
      expect(reauthRequest).toHaveBeenCalledTimes(1);
      expect(mockMintSettingsActionProof).toHaveBeenCalledWith(SETTINGS_ACTION, 'hunter2');
      expect(mockStartOrcid).not.toHaveBeenCalled();
    },
  );

  it.each(POISON_ROWS)(
    '$label is gone after a rejection the retry gate rethrows',
    async ({ token }) => {
      // The non-remintable path, and the one the gate's own clear cannot reach:
      // the gate rethrows this rejection before `clearProofCache` runs. The
      // accreditation-metadata edit declares its proof as a bounded string, so a
      // non-string draws this rejection rather than a fresh-auth one and nothing
      // downstream heals the slot.
      seedSettingsProof(token);
      run.mockRejectedValueOnce(codedError('BAD_REQUEST'));

      await expect(withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('minted-settings-proof');
      expect(storedEntry()).toBeNull();
    },
  );

  it.each(POISON_ROWS)(
    'the attempt after the drop is an ordinary mint, not a second refusal: $label',
    async ({ token }) => {
      // A refusal that leaves its own cause readable is a lockout: every later
      // attempt on the target re-reads the same entry and fails the same way,
      // with retrying no way out, until the TTL arrives or a sign-out scrubs the
      // slot.
      seedSettingsProof(token);
      run.mockRejectedValueOnce(codedError('BAD_REQUEST'));
      await expect(withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run)).rejects.toThrow();

      const out = await withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run);

      expect(out).toEqual({ ok: { ok: true } });
      expect(mockMintSettingsActionProof).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, 'minted-settings-proof');
      expect(run).not.toHaveBeenCalledWith(token);
    },
  );

  it('a fresh-auth rejection still reaches the remintable ladder', async () => {
    // The complement, and the reason the poisoned-entry cases stage BAD_REQUEST
    // rather than a fresh-auth code: on the routes that coerce a non-string to
    // undefined the backend answers FRESH_AUTH_REQUIRED with reason `missing`,
    // the gate clears and re-mints, and a slot-empty assertion there would pass
    // with or without the drop. Keeping that path exercised here is what shows
    // the drop did not swallow the ladder.
    cacheConsentOpProof('cached-proof', future(), SETTINGS_ACTION, LIGHT.username, '');
    run.mockRejectedValueOnce(codedError('FRESH_AUTH_REQUIRED', 'missing'));

    const out = await withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run);

    expect(out).toEqual({ ok: { ok: true } });
    expect(run).toHaveBeenNthCalledWith(1, 'cached-proof');
    expect(run).toHaveBeenNthCalledWith(2, 'minted-settings-proof');
    expect(storedEntry()).toBeNull();
  });
});

describe('withAuthorshipFreshAuth over the real consent-op cache', () => {
  it('a cached STRING proof at this target is still reused', async () => {
    cacheConsentOpProof(
      'cached-proof', future(), TARGET.action, TARGET.rootAuthor, TARGET.rootPermlink,
      TARGET.authorIndex, TARGET.claimer,
    );

    const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);

    expect(out).toEqual({ ok: { ok: true } });
    expect(run).toHaveBeenCalledWith('cached-proof');
    expect(mockMintAuthorshipFreshAuthProof).not.toHaveBeenCalled();
  });

  it.each(POISON_ROWS)(
    'never hands $label to the guarded broadcast; the op mints instead',
    async ({ token }) => {
      seedAuthorshipProof(token);

      const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);

      expect(out).toEqual({ ok: { ok: true } });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith('minted-authorship-proof');
      expect(run).not.toHaveBeenCalledWith(token);
      expect(reauthRequest).toHaveBeenCalledTimes(1);
      expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledWith(TARGET, 'hunter2');
      expect(mockStartOrcid).not.toHaveBeenCalled();
    },
  );

  it.each(POISON_ROWS)(
    '$label is gone after a rejection the retry gate rethrows, and the next op mints',
    async ({ token }) => {
      seedAuthorshipProof(token);
      run.mockRejectedValueOnce(codedError('BAD_REQUEST'));

      await expect(withAuthorshipFreshAuth(TARGET, LIGHT, run))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(run).toHaveBeenCalledWith('minted-authorship-proof');
      expect(storedEntry()).toBeNull();

      const out = await withAuthorshipFreshAuth(TARGET, LIGHT, run);

      expect(out).toEqual({ ok: { ok: true } });
      expect(mockMintAuthorshipFreshAuthProof).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenNthCalledWith(2, 'minted-authorship-proof');
      expect(run).not.toHaveBeenCalledWith(token);
    },
  );

  it('drops a poisoned entry bound to another target rather than leaving it for that one', async () => {
    // The single-slot cache seen from the other side. A drop that waited for a
    // target match would leave this entry cached for the op it does match, and
    // the lockout would simply move to that op.
    seedAuthorshipProof(4242);
    run.mockRejectedValueOnce(codedError('BAD_REQUEST'));

    await expect(withSettingsFreshAuth(SETTINGS_ACTION, LIGHT, run)).rejects.toThrow();

    expect(storedEntry()).toBeNull();
  });
});
