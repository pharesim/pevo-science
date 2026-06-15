/**
 * Library-level unit tests for `lib/fresh-auth.ts`.
 *
 * Properties under test:
 *  - TTL-expiry on in-memory fallback. The `cached.expiresAt > Date.now()`
 *    guard inside `consumeFreshAuthToken`'s memStore branch must return
 *    `'expired'` past the TTL; a mutation that drops the guard must fail.
 *    A fake-timer test advances `Date.now()` past the TTL and asserts
 *    `consume` returns `'expired'`.
 *  - Redis-issuance success + memStore backup write. The issuance path
 *    writes to memStore as a backup whenever Redis-issuance succeeds, so
 *    a Redis flap between issue and consume falls through cleanly via
 *    memStore.get(token) rather than spuriously returning `'expired'`.
 *    Test pins the recovery semantic by simulating a Redis.getdel throw
 *    on consume after a Redis-issuance success.
 *  - memStore-fallback compensating Redis.del. The dual-tier deletion is
 *    symmetric: the memStore-fallback success leg issues a paired
 *    `redis.del` of the canonical entry, so a Redis flap mid-getdel that
 *    didn't actually delete the entry cannot leave the canonical Redis
 *    copy alive to admit a same-process replay once Redis recovered
 *    within the TTL. Test pins the compensating del.
 *  - Per-op target binding. The proof binds to a SHA-256 of
 *    `(action, root_author, root_permlink)`, not just `(token, username)`,
 *    so a compromised SPA cannot swap action/paper between the user's
 *    auth ceremony and the consume side under the 5-min TTL. Tests pin
 *    (a) target X / target Y → mismatch, (b) target X / target X → valid,
 *    (c) consume without target → closed-default reject.
 *  - Redis-absence visibility. `it.skipIf(...)` replaces silent
 *    `if (!redis) return;` early-bails so the absence of Redis is visibly
 *    reported by the runner instead of silently passing an assertion-free
 *    body.
 *
 * Concurrent dual-consume race:
 *  - Concurrent dual-consume tests for both `consumeFreshAuthToken` and
 *    `consumeSessionFreshAuthToken`. Two variants per helper:
 *    (a) Redis-up (real Redis GETDEL atomicity + in-process lock layered
 *        defense), (b) Redis stubbed to throw on both `getdel` calls,
 *    forcing the widest race window where both consumes fall through to
 *    memStore. The in-process lock is the only thing that closes the (b)
 *    variant; the (a) variant validates that the lock layers cleanly with
 *    Redis GETDEL without false-rejecting valid sequential consumes. A
 *    no-Redis real-path companion runs without mocks for each helper to
 *    satisfy clause (c) (real-path coverage of the race class). A
 *    cross-helper Redis-stubbed test pins the shared-lock-domain
 *    invariant: a per-helper lock split would let both helpers race to
 *    memStore.get under Redis-down and both win.
 *
 * Carve-out per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - The `redis` module is partial-mocked via `vi.spyOn(getRedis())` to
 *    exercise the Redis-up-on-issue / Redis-down-on-consume race window.
 *    Inducing this race against real Redis would require coordinated
 *    fault injection mid-call (the local dev Redis is reliable; transient
 *    drops mid-call require network-level mocks). The risk class —
 *    "fresh-auth token recovery on Redis flap" — is exercised by the
 *    spy. A real-path companion exercises the no-Redis path end-to-end
 *    via the standard custody-consent-ops broadcast tests where
 *    `_resetFreshAuthMemStoreForTests` is the mode of operation. For the
 *    concurrent-consume tests, the Redis-stubbed variant exercises the
 *    widest race window (both consumes through memStore); the matching
 *    no-Redis real-path `Promise.all` test in the same describe block
 *    exercises the same race class against real infrastructure when Redis
 *    is absent.
 *  - `verifyHiveSignature` is NOT mocked anywhere in this suite (the
 *    library functions don't reach middleware).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONSENT_OP_ACTIONS,
  CREDIT_OP_ACTIONS,
  FRESH_AUTH_TTL_SECONDS,
  computeFreshAuthTargetHash,
  consentOpFreshAuthTarget,
  consumeFreshAuthToken,
  consumeSessionFreshAuthToken,
  creditOpFreshAuthTarget,
  extractConsentOpFields,
  extractCreditOpFields,
  isConsentOpAction,
  isCreditOpAction,
  isFreshAuthMechanism,
  issueFreshAuthToken,
  issueSessionFreshAuthToken,
  validFreshAuthActionsMessage,
  _getInFlightConsumesSetReferenceForTests,
  _getInFlightConsumesSizeForTests,
  _resetFreshAuthMemStoreForTests,
  _restartCleanupForTests,
  _setMemStoreEntryForTests,
  _stopCleanupForTests,
  type FreshAuthTarget,
} from '../../src/lib/fresh-auth.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';

// Fixture target reused across the suite. The (action, root_author,
// root_permlink) triple is what the proof binds to; tests that exercise
// non-binding paths reuse the same target on issue + consume so the bind
// check passes; tests that exercise binding violations vary one or more
// fields.
const T: FreshAuthTarget = {
  action: 'author_accept',
  root_author: 'alice',
  root_permlink: 'paper-1',
};
const TH = computeFreshAuthTargetHash(T);

// Hoisted to module scope: `redisAvailable` capture lets `it.skipIf(...)`
// evaluate the "Redis present?" predicate at test-registration time. A
// flat module-scoped check (rather than a per-test inline early-return)
// makes Redis absence visible in the runner output as a `skipped` count.
//
// Implementation note: `getRedis()` returns the redis instance before
// its `connect()` promise resolves; the global `setup.ts`'s beforeAll
// awaits `redis.ping()` but runs after this file's top-level evaluates.
// Same poll-for-ready pattern as `tests/support/redis-helpers.ts` —
// up to ~1s for status to become 'ready', then fall through. Without
// this, the it.skipIf read at registration time would always see the
// pre-ready state and skip on every CI run, which is the silent-skip
// pattern this item exists to remove.
const redisAvailable = await (async () => {
  const r = getRedis();
  if (!r) return false;
  for (let i = 0; i < 20 && r.status !== 'ready'; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  return Boolean(r && isRedisAvailable());
})();

beforeEach(() => {
  // Pause the cleanup interval so fake-timer tests don't race the cleaner;
  // each test gets a clean memStore.
  _stopCleanupForTests();
  _resetFreshAuthMemStoreForTests();
});

afterEach(() => {
  // Restart cleanup so module state is consistent for any sibling suite
  // running after this file.
  _restartCleanupForTests();
  vi.useRealTimers();
});

describe('CONSENT_OP_ACTIONS — wire predicate', () => {
  it('contains author_accept and author_resign', () => {
    expect(CONSENT_OP_ACTIONS.has('author_accept')).toBe(true);
    expect(CONSENT_OP_ACTIONS.has('author_resign')).toBe(true);
  });
  it('does NOT contain unrelated actions', () => {
    expect(CONSENT_OP_ACTIONS.has('vote')).toBe(false);
    expect(CONSENT_OP_ACTIONS.has('claim_authorship')).toBe(false);
    expect(CONSENT_OP_ACTIONS.has('approve_authorship')).toBe(false);
  });
});

describe('isConsentOpAction / isCreditOpAction — narrowing guards', () => {
  // These guards replace the unsound `action as ConsentOpAction` /
  // `action as CreditOpAction` casts at the route layer. They delegate to the
  // tuple-derived Sets, so the Set and the narrowed union cannot diverge.
  it('isConsentOpAction admits only the consent ops', () => {
    expect(isConsentOpAction('author_accept')).toBe(true);
    expect(isConsentOpAction('author_resign')).toBe(true);
    expect(isConsentOpAction('claim_authorship')).toBe(false);
    expect(isConsentOpAction('vote')).toBe(false);
  });
  it('isCreditOpAction admits only the credit ops', () => {
    expect(isCreditOpAction('claim_authorship')).toBe(true);
    expect(isCreditOpAction('approve_authorship')).toBe(true);
    expect(isCreditOpAction('revoke_authorship')).toBe(true);
    expect(isCreditOpAction('author_accept')).toBe(false);
    expect(isCreditOpAction('vote')).toBe(false);
  });
  it('the two predicate domains are disjoint', () => {
    for (const a of ['author_accept', 'author_resign']) {
      expect(isConsentOpAction(a) && isCreditOpAction(a)).toBe(false);
    }
    for (const a of ['claim_authorship', 'approve_authorship', 'revoke_authorship']) {
      expect(isConsentOpAction(a) && isCreditOpAction(a)).toBe(false);
    }
  });
});

describe('isFreshAuthMechanism — type guard', () => {
  it('admits the two declared mechanisms', () => {
    expect(isFreshAuthMechanism('password')).toBe(true);
    expect(isFreshAuthMechanism('orcid')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isFreshAuthMechanism(undefined)).toBe(false);
    expect(isFreshAuthMechanism(null)).toBe(false);
    expect(isFreshAuthMechanism('')).toBe(false);
    expect(isFreshAuthMechanism('PASSWORD')).toBe(false);
    expect(isFreshAuthMechanism('webauthn')).toBe(false);
    expect(isFreshAuthMechanism(42)).toBe(false);
  });
});

describe('validFreshAuthActionsMessage — tuple-derived 400 copy', () => {
  // The issuance routes' "action must be one of: ..." 400 string is derived
  // from the action tuples rather than hand-copied at each route, so a new
  // tuple member propagates to every route's error copy automatically. These
  // pin the derivation so a tuple edit that should surface in the message
  // (and a regression that drops a family) is caught.
  it('lists every consent / credit / per-user-critical / admin action', () => {
    const msg = validFreshAuthActionsMessage({ includeSetPassword: false });
    for (const a of [
      'author_accept',
      'author_resign',
      'claim_authorship',
      'approve_authorship',
      'revoke_authorship',
      'change_email',
      'delete_account',
      'ipfs_upload',
      'edit_accreditation_metadata',
      'admin_grant_role',
      'admin_revoke_role',
      'admin_grant_accreditation',
      'admin_retract_paper',
      'admin_revoke_authorship',
      'admin_approve_authorship',
      'admin_sanction',
    ]) {
      expect(msg).toContain(a);
    }
  });

  it('folds in set_password only for the ORCID path (includeSetPassword)', () => {
    expect(validFreshAuthActionsMessage({ includeSetPassword: true })).toContain('set_password');
    // The password (custody) path has no password-mechanism set_password proof.
    expect(validFreshAuthActionsMessage({ includeSetPassword: false })).not.toContain('set_password');
  });

  it('starts with the canonical prefix', () => {
    expect(validFreshAuthActionsMessage({ includeSetPassword: false })).toMatch(/^action must be one of: /);
  });
});

describe('computeFreshAuthTargetHash — content hash', () => {
  it('produces a 64-char lowercase hex digest', () => {
    const hash = computeFreshAuthTargetHash(T);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic for the same target', () => {
    expect(computeFreshAuthTargetHash(T)).toBe(computeFreshAuthTargetHash(T));
  });
  it('differs when action changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, action: 'author_accept' });
    const h2 = computeFreshAuthTargetHash({ ...T, action: 'author_resign' });
    expect(h1).not.toBe(h2);
  });
  it('differs when root_author changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, root_author: 'alice' });
    const h2 = computeFreshAuthTargetHash({ ...T, root_author: 'bob' });
    expect(h1).not.toBe(h2);
  });
  it('differs when root_permlink changes', () => {
    const h1 = computeFreshAuthTargetHash({ ...T, root_permlink: 'p1' });
    const h2 = computeFreshAuthTargetHash({ ...T, root_permlink: 'p2' });
    expect(h1).not.toBe(h2);
  });
  it('domain-separates pipe-laden permlinks (defensive — Hive permlinks restrict |, but the encoder must not collide if the constraint relaxes)', () => {
    // `'a|b' + '|c'` and `'a' + '|b|c'` would collide under naive concat.
    // The pipe is structurally a domain separator; each field is concated
    // verbatim with literal '|' between, so a permlink containing '|' is
    // not isomorphic to a different (action, root_author, root_permlink)
    // shape.
    const h1 = computeFreshAuthTargetHash({
      action: 'author_accept',
      root_author: 'a|b',
      root_permlink: 'c',
    });
    const h2 = computeFreshAuthTargetHash({
      action: 'author_accept',
      root_author: 'a',
      root_permlink: 'b|c',
    });
    expect(h1).not.toBe(h2);
  });

  // Name-only-route credit ops fold author_index into the target hash.
  it('author_index changes the hash for claim/approve', () => {
    const base = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2 });
    const other = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 3 });
    expect(computeFreshAuthTargetHash(base)).not.toBe(computeFreshAuthTargetHash(other));
  });

  it('claim target (no claimer, has index) is byte-identical to the bare index-bound triple (backward compat)', () => {
    // claim_authorship carries author_index but no claimer (the claimer IS the
    // signer). Its target hash must equal the pre-claimer encoding of an
    // (action, root_author, root_permlink, author_index) target so a
    // claim proof minted before the claimer field existed still verifies.
    const claim = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2 });
    const preClaimerForm = {
      action: 'claim_authorship' as const,
      root_author: 'bob',
      root_permlink: 'paper-1',
      author_index: 2,
    };
    expect(computeFreshAuthTargetHash(claim)).toBe(computeFreshAuthTargetHash(preClaimerForm));
  });

  it('a present author_index never collides with the absent form', () => {
    const absent = {
      action: 'claim_authorship' as const,
      root_author: 'bob',
      root_permlink: 'paper-1',
    };
    const presentZero = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 0 });
    expect(computeFreshAuthTargetHash(absent)).not.toBe(computeFreshAuthTargetHash(presentZero));
  });

  it('credit-op action changes the hash even with identical paper + index tails', () => {
    const claim = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 1 });
    const approve = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 1, claimer: 'carol' });
    expect(computeFreshAuthTargetHash(claim)).not.toBe(computeFreshAuthTargetHash(approve));
  });

  // SECURITY: the claimer binding stops a minted approve/revoke proof being
  // redirected to a DIFFERENT co-author at the same paper / slot.
  it('claimer changes the hash for approve at the same paper + index', () => {
    const carol = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2, claimer: 'carol' });
    const dave = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2, claimer: 'dave' });
    expect(computeFreshAuthTargetHash(carol)).not.toBe(computeFreshAuthTargetHash(dave));
  });

  it('claimer changes the hash for revoke at the same paper', () => {
    const carol = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'carol' });
    const dave = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'dave' });
    expect(computeFreshAuthTargetHash(carol)).not.toBe(computeFreshAuthTargetHash(dave));
  });

  it('revoke (claimer, no index) and approve (claimer + index) at the same paper hash distinctly', () => {
    // revoke encodes claimer with the index segment absent; approve encodes
    // both index and claimer. The fixed index-before-claimer order keeps the
    // two unambiguous, so a revoke proof cannot be replayed against an approve.
    const revoke = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'carol' });
    const approve = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2, claimer: 'carol' });
    expect(computeFreshAuthTargetHash(revoke)).not.toBe(computeFreshAuthTargetHash(approve));
  });
});

describe('CREDIT_OP_ACTIONS — wire predicate', () => {
  it('contains the three name-only-route credit ops', () => {
    expect(CREDIT_OP_ACTIONS.has('claim_authorship')).toBe(true);
    expect(CREDIT_OP_ACTIONS.has('approve_authorship')).toBe(true);
    expect(CREDIT_OP_ACTIONS.has('revoke_authorship')).toBe(true);
  });
  it('does NOT contain consent ops or unrelated actions (kept disjoint from CONSENT_OP_ACTIONS)', () => {
    expect(CREDIT_OP_ACTIONS.has('author_accept')).toBe(false);
    expect(CREDIT_OP_ACTIONS.has('author_resign')).toBe(false);
    expect(CREDIT_OP_ACTIONS.has('vote')).toBe(false);
  });
});

describe('extractCreditOpFields — single-source field normalization', () => {
  // This is the one validator every credit-op hash site reads through (both
  // fresh-auth issuance paths + the broadcast consume scan). Its trim + cap
  // behavior is what makes issuance and consume normalize a value identically
  // before hashing — the property that prevents a self-inflicted
  // `target_mismatch` and keeps uncapped input out of the stored target.
  it('claim: extracts paper fields + author_index, no claimer', () => {
    const r = extractCreditOpFields('claim_authorship', {
      paper_author: 'bob',
      paper_permlink: 'paper-1',
      author_index: 2,
    });
    expect(r).toEqual({
      ok: true,
      fields: { action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 2 },
    });
  });

  it('approve: requires + binds claimer alongside author_index', () => {
    const r = extractCreditOpFields('approve_authorship', {
      paper_author: 'bob',
      paper_permlink: 'paper-1',
      author_index: 3,
      claimer: 'carol',
    });
    expect(r).toEqual({
      ok: true,
      fields: { action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 3, claimer: 'carol' },
    });
  });

  it('revoke: binds claimer, ignores author_index (none on the wire)', () => {
    const r = extractCreditOpFields('revoke_authorship', {
      paper_author: 'bob',
      paper_permlink: 'paper-1',
      claimer: 'carol',
    });
    expect(r).toEqual({
      ok: true,
      fields: { action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'carol' },
    });
  });

  it('trims surrounding whitespace so issuance and consume hash the same bytes', () => {
    const padded = extractCreditOpFields('approve_authorship', {
      paper_author: '  bob  ',
      paper_permlink: ' paper-1 ',
      author_index: 1,
      claimer: '\tcarol\n',
    });
    expect(padded.ok).toBe(true);
    if (padded.ok) {
      expect(padded.fields.paperAuthor).toBe('bob');
      expect(padded.fields.paperPermlink).toBe('paper-1');
      // narrow to the approve variant that carries claimer
      if (padded.fields.action === 'approve_authorship') {
        expect(padded.fields.claimer).toBe('carol');
      }
    }
    // The trimmed extraction hashes identically to one built from clean input —
    // the property that closes the padded-field self-inflicted target_mismatch.
    const cleanTarget = creditOpFreshAuthTarget({
      action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 1, claimer: 'carol',
    });
    if (padded.ok) {
      expect(computeFreshAuthTargetHash(creditOpFreshAuthTarget(padded.fields)))
        .toBe(computeFreshAuthTargetHash(cleanTarget));
    }
  });

  it('rejects an over-cap paper_author (64-char ceiling) with field=paper_author', () => {
    const r = extractCreditOpFields('claim_authorship', {
      paper_author: 'a'.repeat(65),
      paper_permlink: 'paper-1',
      author_index: 0,
    });
    expect(r).toEqual({ ok: false, field: 'paper_author' });
  });

  it('names the first missing/ill-typed field (claimer on approve)', () => {
    const r = extractCreditOpFields('approve_authorship', {
      paper_author: 'bob',
      paper_permlink: 'paper-1',
      author_index: 3,
    });
    expect(r).toEqual({ ok: false, field: 'claimer' });
  });

  it('rejects a non-integer author_index with field=author_index', () => {
    const r = extractCreditOpFields('claim_authorship', {
      paper_author: 'bob',
      paper_permlink: 'paper-1',
      author_index: 1.5,
    });
    expect(r).toEqual({ ok: false, field: 'author_index' });
  });
});

describe('extractConsentOpFields — single-source field normalization', () => {
  // Consent-op mirror of the credit-op extractor above: the one validator
  // every consent-op hash site reads through (both fresh-auth issuance paths
  // + the broadcast consume scan). Identical trim + cap at every site is what
  // prevents a whitespace-padded field from hashing differently between
  // issuance and consume depending on the mechanism.
  it('extracts root_author + root_permlink for both consent actions', () => {
    for (const action of ['author_accept', 'author_resign'] as const) {
      const r = extractConsentOpFields(action, {
        root_author: 'alice',
        root_permlink: 'paper-1',
      });
      expect(r).toEqual({
        ok: true,
        fields: { action, rootAuthor: 'alice', rootPermlink: 'paper-1' },
      });
    }
  });

  it('trims surrounding whitespace so issuance and consume hash the same bytes', () => {
    const padded = extractConsentOpFields('author_accept', {
      root_author: '  alice  ',
      root_permlink: '\tpaper-1\n',
    });
    expect(padded.ok).toBe(true);
    // The trimmed extraction hashes identically to one built from clean input —
    // the property that closes the padded-field self-inflicted target_mismatch.
    const cleanTarget = consentOpFreshAuthTarget({
      action: 'author_accept', rootAuthor: 'alice', rootPermlink: 'paper-1',
    });
    if (padded.ok) {
      expect(computeFreshAuthTargetHash(consentOpFreshAuthTarget(padded.fields)))
        .toBe(computeFreshAuthTargetHash(cleanTarget));
    }
  });

  it('clean values hash identically to an inline-built target (pre-extractor proofs still consume)', () => {
    // Backward-compat pin: routes used to build the consent-op target inline
    // as an object literal. A well-formed (unpadded, in-cap) proof issued
    // against that shape must keep consuming — i.e. the extractor must not
    // change hash inputs for clean values.
    const extracted = extractConsentOpFields('author_accept', {
      root_author: 'alice',
      root_permlink: 'paper-1',
    });
    expect(extracted.ok).toBe(true);
    if (extracted.ok) {
      expect(computeFreshAuthTargetHash(consentOpFreshAuthTarget(extracted.fields)))
        .toBe(computeFreshAuthTargetHash({ action: 'author_accept', root_author: 'alice', root_permlink: 'paper-1' }));
    }
  });

  it('rejects an over-cap root_author (64-char ceiling) with field=root_author', () => {
    const r = extractConsentOpFields('author_accept', {
      root_author: 'a'.repeat(65),
      root_permlink: 'paper-1',
    });
    expect(r).toEqual({ ok: false, field: 'root_author' });
  });

  it('names the first missing/ill-typed field (root_permlink)', () => {
    const r = extractConsentOpFields('author_resign', {
      root_author: 'alice',
      root_permlink: 42,
    });
    expect(r).toEqual({ ok: false, field: 'root_permlink' });
  });
});

describe('creditOpFreshAuthTarget — credit-op target builder + consume round-trip', () => {
  it('claim target validly consumes when issued and consumed at the same (action, paper, index)', async () => {
    const target = creditOpFreshAuthTarget({ action: 'claim_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 4 });
    const issued = await issueFreshAuthToken('alice', 'password', target);
    const result = await consumeFreshAuthToken(
      issued.token,
      'alice',
      computeFreshAuthTargetHash(target),
    );
    expect(result.valid).toBe(true);
  });

  it('approve proof minted for index 4 rejects a consume bound to index 5 → target_mismatch', async () => {
    const minted = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 4, claimer: 'carol' });
    const issued = await issueFreshAuthToken('alice', 'password', minted);
    const wrongIndex = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 5, claimer: 'carol' });
    const result = await consumeFreshAuthToken(
      issued.token,
      'alice',
      computeFreshAuthTargetHash(wrongIndex),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('target_mismatch');
  });

  it('approve proof minted for claimer carol rejects a consume bound to claimer dave → target_mismatch', async () => {
    // The core threat the claimer binding defeats: a proof minted to credit
    // carol at a slot must not authorize crediting dave at the same slot.
    const minted = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 4, claimer: 'carol' });
    const issued = await issueFreshAuthToken('alice', 'password', minted);
    const wrongClaimer = creditOpFreshAuthTarget({ action: 'approve_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', authorIndex: 4, claimer: 'dave' });
    const result = await consumeFreshAuthToken(
      issued.token,
      'alice',
      computeFreshAuthTargetHash(wrongClaimer),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('target_mismatch');
  });

  it('revoke proof minted for claimer carol rejects a consume bound to claimer dave → target_mismatch', async () => {
    const minted = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'carol' });
    const issued = await issueFreshAuthToken('alice', 'orcid', minted);
    const wrongClaimer = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'dave' });
    const result = await consumeFreshAuthToken(
      issued.token,
      'alice',
      computeFreshAuthTargetHash(wrongClaimer),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('target_mismatch');
  });

  it('revoke target validly consumes at the matching paper + action + claimer', async () => {
    const target = creditOpFreshAuthTarget({ action: 'revoke_authorship', paperAuthor: 'bob', paperPermlink: 'paper-1', claimer: 'carol' });
    const issued = await issueFreshAuthToken('alice', 'orcid', target);
    const result = await consumeFreshAuthToken(
      issued.token,
      'alice',
      computeFreshAuthTargetHash(target),
    );
    expect(result.valid).toBe(true);
  });
});

describe('TTL-expiry on in-memory fallback', () => {
  // The TTL-guard test scenario only fires on the in-memory fallback
  // path. When Redis is available, Redis's own server-side EX TTL is
  // authoritative and the in-memory `cached.expiresAt > Date.now()`
  // guard is bypassed. The mutation-kill targets the in-memory guard at
  // consume time, so these tests force the Redis-down-on-consume path
  // via a spy: issuance writes the memStore backup; consume sees Redis
  // unavailable and falls through to memStore where the TTL guard fires.

  it('returns valid before the TTL boundary on the memStore fallback', async () => {
    // Force fake timers BEFORE issuance so the memStore-backup expiresAt
    // is computed against the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);

    const issued = await issueFreshAuthToken('alice', 'password', T);

    // Force Redis-down on consume so the path exercises the in-memory
    // TTL guard (memStore backup is written at issuance, so the entry
    // is recoverable from memStore).
    const redis = getRedis();
    const spy = redis && isRedisAvailable()
      ? vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced flap for TTL test'))
      : null;
    try {
      // Advance just before the TTL boundary (issuance time + TTL - 1s).
      // Token still valid via memStore fallback.
      vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS - 1) * 1000);
      const within = await consumeFreshAuthToken(issued.token, 'alice', TH);
      expect(within.valid).toBe(true);
    } finally {
      spy?.mockRestore();
    }
  });

  it('memStore TTL guard is the only thing distinguishing expired from valid (mutation kill)', async () => {
    // Pin the guard's behaviour: at exactly TTL+1 second, the entry is
    // present in memStore but `expiresAt > Date.now()` returns false.
    // A mutant that removed the guard would return the entry as valid,
    // so this test fails on that mutation. Forces Redis-down-on-consume
    // to exercise the in-memory branch.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const issued = await issueFreshAuthToken('bob', 'orcid', T);

    const redis = getRedis();
    if (redis && isRedisAvailable()) {
      const spy = vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced flap for TTL test'));
      try {
        vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
        const result = await consumeFreshAuthToken(issued.token, 'bob', TH);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe('expired');
        }
      } finally {
        spy.mockRestore();
      }
    } else {
      vi.setSystemTime(t0 + (FRESH_AUTH_TTL_SECONDS + 1) * 1000);
      const result = await consumeFreshAuthToken(issued.token, 'bob', TH);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
      }
    }
  });
});

describe('Redis-flap recovery via memStore backup', () => {
  // `it.skipIf` replaces the silent `if (!redis) return;` bail-out so a
  // Redis-less CI surface explicitly reports these as skipped instead of
  // silently passing an assertion-free body.
  it.skipIf(!redisAvailable)('Redis-issuance success + Redis.getdel throws on consume → memStore backup recovers the token', async () => {
    // Under fake Redis-flap shape: issue against a healthy Redis, then
    // make `redis.getdel` throw on consume. Issuance writes a backup to
    // memStore on Redis-issuance success; consume recovers via the
    // fallback rather than returning `'expired'`.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('carol', 'password', T);
    // Force the consume-side getdel to throw. Single-call mock: the
    // consume falls through to memStore (which has the backup written
    // at issuance) and recovers.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap'));
    try {
      const result = await consumeFreshAuthToken(issued.token, 'carol', TH);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mechanism).toBe('password');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('Redis-issuance success + healthy Redis.getdel on consume → memStore backup is also deleted (no replay window)', async () => {
    // Mutation-kill: a regression that wrote the memStore backup at
    // issuance but did NOT clear it on a successful Redis GETDEL would
    // admit a replay attack via the fallback path. Pin the symmetric
    // delete: after a successful Redis consume, a follow-up consume
    // (now Redis-down) MUST not find the entry in memStore.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('dave', 'orcid', T);
    const first = await consumeFreshAuthToken(issued.token, 'dave', TH);
    expect(first.valid).toBe(true);

    // Now simulate Redis flapping out and check that the memStore copy
    // is gone (a successful Redis GETDEL deletes the memStore backup,
    // so the symmetric-deletion pin holds).
    const getdelSpy = vi.spyOn(redis, 'getdel').mockResolvedValueOnce(null);
    try {
      const replay = await consumeFreshAuthToken(issued.token, 'dave', TH);
      expect(replay.valid).toBe(false);
      if (!replay.valid) {
        expect(replay.reason).toBe('expired');
      }
    } finally {
      getdelSpy.mockRestore();
    }
  });
});

describe('Symmetric dual-tier deletion', () => {
  // The pre-fix asymmetric variant deleted memStore on the Redis-success
  // leg but did not issue a compensating `redis.del` on the
  // memStore-fallback leg. A Redis blip mid-getdel that threw BEFORE
  // Redis actually deleted the entry left the canonical Redis copy alive
  // — the user's consume succeeded via memStore, but a same-process
  // replay within the TTL hit Redis getdel and returned valid AGAIN.
  // The symmetric design: the memStore-fallback success path issues a
  // best-effort `redis.del` of the canonical entry to close the replay
  // window.
  it.skipIf(!redisAvailable)('memStore-fallback success path issues a compensating redis.del so a subsequent Redis-recovered consume cannot replay', async () => {
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('eve', 'password', T);

    // Step 1: stub Redis to throw on the first getdel. This forces the
    // fallback to memStore on consume — which succeeds via the memStore
    // backup written at issuance.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated Redis flap on getdel'));
    // We allow the compensating del to land — the test asserts replay
    // rejection by the canonical `redis.del`'s effect on the next consume.

    let firstResult;
    try {
      firstResult = await consumeFreshAuthToken(issued.token, 'eve', TH);
    } finally {
      getdelSpy.mockRestore();
    }
    expect(firstResult.valid).toBe(true);

    // Step 2: Redis is "recovered" (default behavior, no spy). A second
    // consume with the same token must return `expired` because:
    //   (a) memStore was deleted at the start of the fallback path (the
    //       fallback path itself burns the memStore copy),
    //   (b) the compensating redis.del cleared the canonical Redis entry
    //       so the Redis branch returns nil → 'expired'.
    // A pre-fix variant (no compensating del) would have left the Redis
    // entry alive: this second consume's Redis.getdel would have
    // returned the entry → the narrowing would have parsed it →
    // returned `valid: true` → DOUBLE-CONSUME. The test fails on that
    // mutation.
    const replay = await consumeFreshAuthToken(issued.token, 'eve', TH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('memStore-fallback compensating del is best-effort (a throwing redis.del does not break the consume)', async () => {
    // The compensating `redis.del` runs inside a try/catch in
    // consumeFreshAuthToken: if Redis is still flaky on the del side,
    // the user's broadcast must still proceed (we already consumed the
    // memStore copy). Pin that the consume reports valid even when the
    // compensating del also throws.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('frank', 'password', T);

    const getdelSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('flap on getdel'));
    const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('flap persists on del'));
    try {
      const result = await consumeFreshAuthToken(issued.token, 'frank', TH);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.mechanism).toBe('password');
      }
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });
});

describe('Per-op target binding', () => {
  it('issue with target X, consume with target X (same hash) → valid', async () => {
    const issued = await issueFreshAuthToken('grace', 'password', T);
    const result = await consumeFreshAuthToken(issued.token, 'grace', TH);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('password');
    }
  });

  it('issue with target X, consume with a DIFFERENT target hash → target_mismatch', async () => {
    const issued = await issueFreshAuthToken('hank', 'password', T);
    const otherTarget: FreshAuthTarget = {
      action: 'author_resign',
      root_author: 'mallory',
      root_permlink: 'paper-2',
    };
    const otherHash = computeFreshAuthTargetHash(otherTarget);
    const result = await consumeFreshAuthToken(issued.token, 'hank', otherHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('1-fold substitution: issue for (author_accept, paper-1), consume for (author_resign, paper-1) → target_mismatch (action swap)', async () => {
    // Closes the 1-fold cross-action substitution attack: a compromised
    // SPA could authenticate the user mentally for `author_accept` then
    // submit `author_resign` under the same proof.
    const issued = await issueFreshAuthToken('iris', 'orcid', T);
    const swappedTarget: FreshAuthTarget = { ...T, action: 'author_resign' };
    const swappedHash = computeFreshAuthTargetHash(swappedTarget);
    const result = await consumeFreshAuthToken(issued.token, 'iris', swappedHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('1-fold substitution: issue for paper-1, consume for paper-2 → target_mismatch (paper swap)', async () => {
    // Closes the cross-paper substitution attack: same action, different
    // paper. Distinct test from the action-swap case to lock both axes
    // of the binding independently.
    const issued = await issueFreshAuthToken('jules', 'password', T);
    const swappedTarget: FreshAuthTarget = { ...T, root_permlink: 'paper-2' };
    const swappedHash = computeFreshAuthTargetHash(swappedTarget);
    const result = await consumeFreshAuthToken(issued.token, 'jules', swappedHash);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with empty-string expectedTargetHash → target_mismatch (legacy callers cannot bypass the bind)', async () => {
    // The hold block says: "consume without expected target (legacy
    // callers) → reject (closed-default policy)." A legacy caller that
    // somehow passes an empty string (or any non-hex value) MUST be
    // rejected rather than allowed to bypass the bind.
    const issued = await issueFreshAuthToken('kate', 'password', T);
    const result = await consumeFreshAuthToken(issued.token, 'kate', '');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with malformed (non-hex / wrong-length) expectedTargetHash → target_mismatch', async () => {
    const issued = await issueFreshAuthToken('luca', 'password', T);
    // Length-63 hex (one short) — fails the `^[0-9a-f]{64}$` shape.
    const malformed = 'a'.repeat(63);
    const result = await consumeFreshAuthToken(issued.token, 'luca', malformed);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });

  it('closed-default: consume with uppercase-hex expectedTargetHash → target_mismatch (the guard is strict-lowercase)', async () => {
    // The validator at `isValidTargetHash` is strict lowercase
    // (`/^[0-9a-f]{64}$/`). Uppercase hex from a future caller that
    // does not normalize is rejected — pins the strict-lowercase
    // contract so a future relaxation is intentional rather than
    // accidental.
    const issued = await issueFreshAuthToken('maya', 'password', T);
    const upper = TH.toUpperCase();
    const result = await consumeFreshAuthToken(issued.token, 'maya', upper);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('target_mismatch');
    }
  });
});

// ─── session-kind primitives — issue + consume + cross-kind acceptance ───

describe('session-kind issue / consume — issueSessionFreshAuthToken + consumeSessionFreshAuthToken', () => {
  beforeEach(() => {
    _resetFreshAuthMemStoreForTests();
  });

  it('issue then consume session-kind → valid + mechanism preserved', async () => {
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    const result = await consumeSessionFreshAuthToken(issued.token, 'alice');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('password');
    }
  });

  it('session-kind via ORCID mechanism → valid + mechanism=orcid', async () => {
    const issued = await issueSessionFreshAuthToken('carl', 'orcid');
    const result = await consumeSessionFreshAuthToken(issued.token, 'carl');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('orcid');
    }
  });

  it('single-use semantic on session consume: second consume → expired', async () => {
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    const first = await consumeSessionFreshAuthToken(issued.token, 'alice');
    expect(first.valid).toBe(true);
    const second = await consumeSessionFreshAuthToken(issued.token, 'alice');
    expect(second.valid).toBe(false);
    if (!second.valid) {
      expect(second.reason).toBe('expired');
    }
  });

  it('cross-account: session token for bob consumed with alice → username_mismatch', async () => {
    const issued = await issueSessionFreshAuthToken('bob', 'password');
    const result = await consumeSessionFreshAuthToken(issued.token, 'alice');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('username_mismatch');
    }
  });

  it('missing token → missing reason', async () => {
    const result = await consumeSessionFreshAuthToken(undefined, 'alice');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('missing');
    }
  });

  // ─── Cross-kind acceptance / isolation ──────────────────────────────

  it('cross-kind accept: consent_op-kind proof works on session consume', async () => {
    // Strictly more proof: a consent_op-kind proof carries target binding
    // AND proves recent re-auth. Non-consent broadcast doesn't need the
    // binding, so the proof is acceptable on the session surface.
    const issued = await issueFreshAuthToken('alice', 'password', T);
    const result = await consumeSessionFreshAuthToken(issued.token, 'alice');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('password');
    }
  });

  it('kind isolation: session-kind proof on consent_op consume → kind_mismatch', async () => {
    // The reverse direction is NOT accepted: session proofs don't carry
    // the per-op binding the consent surface requires. Pre-fix, the
    // session consume's "no target check" might tempt a refactor to drop
    // the target check on the consent consume too. This test pins the
    // strict-isolation property.
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    const result = await consumeFreshAuthToken(issued.token, 'alice', TH);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('kind_mismatch');
    }
  });
});

// ─── concurrent dual-consume race — in-process lock ───

describe('concurrent dual-consume produces exactly one winner (in-process lock)', () => {
  // The race: a `Promise.all` dual-consume on the same token could authorize
  // TWO broadcasts because Redis GETDEL is atomic but the memStore fallback's
  // `get` + `delete` window admits interleaving on a single-instance JS event
  // loop (and widens on Redis-down, where both callers fall through to
  // memStore). The in-process lock closes the door with a module-scoped
  // `Set<string>` of in-flight tokens guarded by a synchronous `has` → `add`
  // critical section before any awaits.
  //
  // Acceptance: both helpers must serialize concurrent dual-consume to
  // exactly one winner under both Redis-up GETDEL atomicity and Redis-
  // stubbed in-process-lock conditions. Two variants per helper exercise
  // each tier independently — the Redis-up variant validates that the
  // lock layers cleanly with Redis GETDEL without false-rejecting valid
  // sequential consumes; the Redis-stubbed variant forces both consumes
  // onto the memStore fallback path where the lock is the only thing
  // closing the race.

  it.skipIf(!redisAvailable)('consumeFreshAuthToken Redis-up: Promise.all dual consume → exactly one winner', async () => {
    const issued = await issueFreshAuthToken('race-alice', 'password', T);
    const [a, b] = await Promise.all([
      consumeFreshAuthToken(issued.token, 'race-alice', TH),
      consumeFreshAuthToken(issued.token, 'race-alice', TH),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    expect(winners).toHaveLength(1);
    const losers = [a, b].filter((r) => !r.valid);
    expect(losers).toHaveLength(1);
    // Loser is reported as `expired` — same wire shape as a stale replay,
    // no new reason code on the union. The `inFlightConsumes` docblock in
    // `lib/fresh-auth.ts` explains the loser-reason rationale.
    if (!losers[0].valid) {
      expect(losers[0].reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('consumeFreshAuthToken Redis-stubbed-to-throw (memStore fallback): Promise.all dual consume → exactly one winner', async () => {
    // Force the widest race window — both consumes fall through to memStore.
    // Pre-fix, both callers would synchronously read the entry before either
    // reached `memStore.delete`, returning two valids.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('race-bob', 'password', T);
    // Stub getdel to throw on BOTH calls. mockImplementation, not
    // mockRejectedValueOnce — Promise.all may fire both calls before either
    // resolves.
    const getdelSpy = vi.spyOn(redis, 'getdel').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for race test'));
    });
    // Also stub the compensating `redis.del` so the test isolates the
    // race-window assertion (the del is best-effort and tested elsewhere).
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    try {
      const [a, b] = await Promise.all([
        consumeFreshAuthToken(issued.token, 'race-bob', TH),
        consumeFreshAuthToken(issued.token, 'race-bob', TH),
      ]);
      const winners = [a, b].filter((r) => r.valid);
      expect(winners).toHaveLength(1);
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });

  it('consumeFreshAuthToken no-Redis: Promise.all dual consume → exactly one winner', async () => {
    // Real no-Redis-path companion (carve-out clause c): if Redis is absent
    // in the suite environment, the consume already runs through the
    // memStore-only branch. This test exercises that path directly without
    // mocks when redisAvailable is false; when Redis IS available, it still
    // runs (the memStore-fallback shape is achievable by skipping the Redis
    // populate at issue time — but `issueFreshAuthToken` writes to BOTH
    // tiers, so the memStore branch only fires when Redis read fails).
    // For the Redis-available case, this test is functionally equivalent to
    // the Redis-up test above (Redis GETDEL is atomic and the lock is
    // additionally enforced); under no-Redis it is the real-path companion.
    const issued = await issueFreshAuthToken('race-carol', 'password', T);
    const [a, b] = await Promise.all([
      consumeFreshAuthToken(issued.token, 'race-carol', TH),
      consumeFreshAuthToken(issued.token, 'race-carol', TH),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    expect(winners).toHaveLength(1);
  });

  it.skipIf(!redisAvailable)('consumeSessionFreshAuthToken Redis-up: Promise.all dual consume → exactly one winner', async () => {
    const issued = await issueSessionFreshAuthToken('race-dave', 'password');
    const [a, b] = await Promise.all([
      consumeSessionFreshAuthToken(issued.token, 'race-dave'),
      consumeSessionFreshAuthToken(issued.token, 'race-dave'),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    expect(winners).toHaveLength(1);
    const losers = [a, b].filter((r) => !r.valid);
    expect(losers).toHaveLength(1);
    if (!losers[0].valid) {
      expect(losers[0].reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('consumeSessionFreshAuthToken Redis-stubbed-to-throw: Promise.all dual consume → exactly one winner', async () => {
    const redis = getRedis()!;
    const issued = await issueSessionFreshAuthToken('race-eve', 'orcid');
    const getdelSpy = vi.spyOn(redis, 'getdel').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for race test'));
    });
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    try {
      const [a, b] = await Promise.all([
        consumeSessionFreshAuthToken(issued.token, 'race-eve'),
        consumeSessionFreshAuthToken(issued.token, 'race-eve'),
      ]);
      const winners = [a, b].filter((r) => r.valid);
      expect(winners).toHaveLength(1);
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });

  it('consumeSessionFreshAuthToken no-Redis real-path: Promise.all dual consume → exactly one winner', async () => {
    // No-Redis real-path companion to the stubbed-Redis variant above.
    const issued = await issueSessionFreshAuthToken('race-frank', 'password');
    const [a, b] = await Promise.all([
      consumeSessionFreshAuthToken(issued.token, 'race-frank'),
      consumeSessionFreshAuthToken(issued.token, 'race-frank'),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    expect(winners).toHaveLength(1);
  });

  it('lock cleanup: a thrown consume releases the in-flight set entry (structural pin)', async () => {
    // Pin the try/finally cleanup discipline structurally via the
    // in-flight set size, not via wire codes. The lock-held branch and
    // the consumed-token branch both return `expired`, so a wire-shape
    // assertion is mutation-blind to removing the `finally` block. The
    // set-size assertion isn't: a mutation that replaces
    // `finally { inFlightConsumes.delete(token) }` with plain post-await
    // cleanup leaks the lock entry on the throw path.
    //
    // Mechanism: plant a memStore entry whose `entry` field has a circular
    // reference so `JSON.stringify(cached.entry)` throws inside the locked
    // critical section. Force Redis-down on consume so the helper falls
    // through to memStore. The throw propagates out of the inner
    // `consumeFreshAuthTokenLocked` and the outer `finally` MUST fire.
    const token = 'lock-cleanup-throw-token';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = { username: 'lock-cleanup', mechanism: 'password' };
    circular.self = circular;
    _setMemStoreEntryForTests(token, circular, Date.now() + 60_000);

    // Sanity precondition — the set is clean before the test acts.
    expect(_getInFlightConsumesSizeForTests()).toBe(0);

    const redis = getRedis();
    const getdelSpy =
      redis && isRedisAvailable()
        ? vi.spyOn(redis, 'getdel').mockRejectedValue(new Error('forced Redis-down for cleanup test'))
        : null;
    try {
      await expect(
        consumeFreshAuthToken(token, 'lock-cleanup', TH),
      ).rejects.toThrow();
      // Mutation kill: removing the `finally { inFlightConsumes.delete }`
      // would leave the entry behind. The wire-shape assertion above only
      // confirms the throw propagated; this confirms cleanup ran.
      expect(_getInFlightConsumesSizeForTests()).toBe(0);
    } finally {
      getdelSpy?.mockRestore();
    }
  });

  it('shared-lock-domain invariant: both helpers consult the same inFlightConsumes Set (identity anchor)', async () => {
    // Structural identity anchor for the shared-lock-domain design — pins
    // that `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` both
    // call `.has` / `.add` on the SAME `Set<string>` instance. A mutation
    // that splits the lock into per-helper Sets (e.g.,
    // `inFlightConsumesByConsentHelper` + `inFlightConsumesBySessionHelper`)
    // would cause one of the two helpers' invocations to bypass the spied
    // Set, failing the "both helpers touched this Set" assertion.
    //
    // Independent of microtask ordering and Redis availability — runs in
    // every environment (no skipIf) because the assertion examines only
    // the lock-set call surface, not the Redis fallback path. The wire-
    // shape cross-helper test below complements this with end-to-end
    // coverage when Redis is available.
    const sharedSet = _getInFlightConsumesSetReferenceForTests();
    const hasSpy = vi.spyOn(sharedSet, 'has');
    try {
      const issuedA = await issueFreshAuthToken('lock-identity-a', 'password', T);
      await consumeFreshAuthToken(issuedA.token, 'lock-identity-a', TH);
      const consentHelperCalls = hasSpy.mock.calls.length;
      expect(consentHelperCalls).toBeGreaterThan(0);

      const issuedB = await issueSessionFreshAuthToken('lock-identity-b', 'password');
      await consumeSessionFreshAuthToken(issuedB.token, 'lock-identity-b');
      const sessionHelperCalls = hasSpy.mock.calls.length - consentHelperCalls;
      // Mutation kill: a per-helper Set split would route the session
      // helper's `has` check to a sibling Set; sessionHelperCalls would
      // stay at 0 even though the helper ran.
      expect(sessionHelperCalls).toBeGreaterThan(0);
    } finally {
      hasSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('cross-helper Redis-stubbed Promise.all → exactly one winner (shared-lock-domain invariant)', async () => {
    // Pins the shared-lock-domain design: `inFlightConsumes` is a single
    // module-scoped set spanning both consume helpers. A mutation that
    // splits the set per helper (e.g., `inFlightConsumesByConsentHelper`
    // and `inFlightConsumesBySessionHelper`) would let a `Promise.all`
    // across both helpers race to the memStore fallback under Redis-down
    // and both win — silently regressing the cross-kind race protection.
    //
    // The session-helper accepts both kinds (cross-kind accept — see
    // `consumeSessionFreshAuthToken` docstring), so a consent_op-kind
    // token consumed via the session helper returns valid: true if it
    // wins. Either helper as winner is acceptable; the load-bearing
    // claim is "exactly one winner."
    //
    // Redis-stubbed (not Redis-up) because Redis GETDEL atomicity alone
    // would also produce exactly one winner under the mutation — the
    // mutation kill requires forcing both helpers onto the memStore
    // fallback path.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('race-cross', 'password', T);
    const getdelSpy = vi.spyOn(redis, 'getdel').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for cross-helper race test'));
    });
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    try {
      const [a, b] = await Promise.all([
        consumeFreshAuthToken(issued.token, 'race-cross', TH),
        consumeSessionFreshAuthToken(issued.token, 'race-cross'),
      ]);
      const winners = [a, b].filter((r) => r.valid);
      expect(winners).toHaveLength(1);
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });
});
