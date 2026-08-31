/**
 * Library-level unit tests for `lib/fresh-auth.ts`.
 *
 * The module serves two proof kinds with deliberately different lifetimes, and
 * most of what is pinned here is the boundary between them.
 *
 * Consent-op kind (target-bound, single-use):
 *  - TTL-expiry on the in-memory tier. The `cached.expiresAt > Date.now()` guard
 *    must report `'expired'` past the TTL; a mutation that drops the guard must
 *    fail. A fake-timer test advances `Date.now()` past the boundary.
 *  - Redis-issuance success + in-memory backup write, so a Redis flap between
 *    issue and consume recovers from the backup rather than spuriously
 *    reporting `'expired'` on a proof the user just minted.
 *  - Symmetric burn across both tiers. A consume served from the backup tier
 *    still clears the canonical Redis entry, so a replay once Redis recovers
 *    inside the TTL cannot succeed.
 *  - Per-op target binding over `(action, root_author, root_permlink)`, so a
 *    compromised client cannot swap action or paper between the user's auth
 *    ceremony and the consume. Tests pin target X/Y mismatch, X/X valid, and the
 *    closed-default reject when no well-formed target is supplied.
 *
 * Session kind (target-less, multi-use inside a bounded window):
 *  - Multi-use: three consecutive consumes all succeed. Two would only prove
 *    "double-use".
 *  - Sliding idle deadline: a consume moves the deadline forward, so a working
 *    stretch is never interrupted. The mutation this kills is a consume that
 *    validates the window without sliding it.
 *  - Absolute cap: the window dies at the cap no matter how often it was slid,
 *    and the slide is clamped to the cap rather than pushed past it. Because the
 *    storage TTL normally expires such an entry on its own, the cap is easy to
 *    implement so it silently never fires — so planted entries exercise the
 *    check directly, in both directions (cap passed with idle in the future, and
 *    idle passed with the cap far away).
 *  - Persistence rules for a slide: written back to Redis with `XX` when Redis
 *    answered the read, and NOT written to Redis at all when the in-memory tier
 *    answered, since writing there would recreate a key Redis has dropped.
 *  - The persist is DETACHED from the authorization decision, and the in-memory
 *    write inside it lands before the network call. A Redis write that never
 *    settles is the only way to separate that from an awaited persist: the
 *    consume must still resolve, and the slid deadline must still be readable
 *    from the in-memory tier. Both halves are invisible to outcome-only
 *    assertions, so re-attaching an `await` in `consumeSessionWindow` (a stall
 *    on every vote, comment, post, and review) or deferring the in-memory write
 *    until the network write confirms (windows that stop sliding whenever Redis
 *    is slow) would otherwise leave the suite green.
 *  - The revocation epoch: a window whose `issued_at` is at or before the
 *    account's `sessions_invalidated_at` is dead, the boundary is inclusive, a
 *    null or absent epoch applies no cut-off, and the slide carries `issued_at`
 *    through unchanged so a revoked window cannot age out of its revocation.
 *  - Closed-default stored shapes: a session entry without deadlines is
 *    malformed rather than unbounded, and a consent-op entry that acquired
 *    deadlines is malformed rather than a window.
 *  - Cross-kind direction. A consent-op proof is accepted on the session surface
 *    and is still SPENT there, never converted into a window; a session proof on
 *    the consent surface is `kind_mismatch` and is NOT spent, because burning it
 *    would let anyone holding the token close the owner's window.
 *  - `invalidateSessionFreshAuthTokens` closes every window for one user,
 *    leaves other accounts and the same user's consent-op proofs alone, and
 *    never throws, so a Redis failure cannot turn a completed password reset
 *    into a 500.
 *
 * Concurrency, which the two kinds also invert:
 *  - Consent-op dual-consume must produce exactly ONE winner. Two variants per
 *    path: Redis-up (the delete-reply count arbitrates, with the in-process lock
 *    layered on) and Redis stubbed down (both callers reach the in-memory tier,
 *    where the lock is what closes the race), plus a no-mock companion. A
 *    cross-helper variant pins that the lock domain is the TOKEN, not the
 *    calling helper: a consent-op proof reaches the session surface through the
 *    cross-kind accept, so both helpers can burn the same entry at once.
 *  - Session dual-consume must produce TWO winners. Serializing them would turn
 *    ordinary client behaviour (two votes in one tick, an upload-token mint
 *    racing a broadcast) into a spurious 401. Structural pins sample the
 *    in-flight lock set from inside the burn and from inside the slide, because
 *    a dropped `add` and a reinstated lock are both invisible to outcome
 *    assertions on a single call.
 *  - Redis-absence visibility. `it.skipIf(...)` replaces silent early-bails so
 *    the absence of Redis is reported by the runner instead of quietly passing
 *    an assertion-free body.
 *
 * Carve-out per root CLAUDE.md "Carve-out for deterministic edge-case
 * coverage" clause (a):
 *  - The `redis` module is partial-mocked via `vi.spyOn(getRedis())` to exercise
 *    the Redis-up-on-issue / Redis-down-on-consume race window. Inducing that
 *    race against real Redis would require coordinated fault injection mid-call.
 *    The risk class, "fresh-auth proof recovery on Redis flap", is exercised by
 *    the spy; the matching no-Redis real-path tests in the same describe blocks
 *    exercise the same class against real infrastructure when Redis is absent,
 *    and the custody broadcast route tests cover it end-to-end.
 *  - The invalidation sweep's batching is additionally pinned at an index size
 *    no fixture can plant for real: `smembers` is stubbed to return a synthetic
 *    200k-member index and `del` is stubbed to a no-op, so only the batching
 *    arithmetic runs and no Redis traffic is issued. The argument spread the
 *    batching exists to avoid does not throw until roughly 125k arguments, so a
 *    real-key fixture cannot reach the regime; the real-path companion for the
 *    same risk class, "the sweep deletes every indexed window", is the
 *    1202-member real-Redis test in the same describe block, which runs the real
 *    DELs end to end.
 *  - A `set` mocked to a promise that never settles stands in for a
 *    connected-but-stalled server, which is the only way to separate a detached
 *    slide persist from an awaited one. There is no way to hold a real server's
 *    reply open from inside the test, and a command timeout long enough to
 *    observe would dominate the suite's runtime.
 *  - Fake timers stand in for wall-clock waits on the window boundaries. The
 *    idle deadline is 15 minutes out and the cap is 2 hours out, so real waits
 *    are impractical; only `Date.now()` is faked, and Redis stays real, so the
 *    persistence leg is still exercised for every slide.
 *  - `verifyHiveSignature` is NOT mocked anywhere in this suite (the library
 *    functions don't reach middleware).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONSENT_OP_ACTIONS,
  CREDIT_OP_ACTIONS,
  FRESH_AUTH_TTL_SECONDS,
  SESSION_FRESH_AUTH_ABSOLUTE_SECONDS,
  SESSION_FRESH_AUTH_IDLE_SECONDS,
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
  invalidateSessionFreshAuthTokens,
  issueSessionFreshAuthToken,
  validFreshAuthActionsMessage,
  _getInFlightConsumesSizeForTests,
  _resetFreshAuthMemStoreForTests,
  _restartCleanupForTests,
  _setMemStoreEntryForTests,
  _stopCleanupForTests,
  type FreshAuthTarget,
} from '../../src/lib/fresh-auth.js';
import { getRedis, isRedisAvailable } from '../../src/redis.js';
import { config } from '../../src/config.js';

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
      ? vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced flap for TTL test'))
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
      const spy = vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced flap for TTL test'));
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
  it.skipIf(!redisAvailable)('Redis-issuance success + Redis read throws on consume → memStore backup recovers the token', async () => {
    // Under fake Redis-flap shape: issue against a healthy Redis, then make the
    // consume-side Redis read throw. Issuance writes a backup to memStore on
    // Redis-issuance success; consume recovers via the fallback rather than
    // returning `'expired'`.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('carol', 'password', T);
    // Single-call mock: the consume falls through to memStore (which has the
    // backup written at issuance) and recovers.
    const getdelSpy = vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis flap'));
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

  it.skipIf(!redisAvailable)('Redis-issuance success + healthy Redis consume → memStore backup is also deleted (no replay window)', async () => {
    // Mutation-kill: a regression that wrote the memStore backup at issuance
    // but did NOT clear it on a successful Redis burn would admit a replay
    // attack via the fallback path. Pin the symmetric delete: after a
    // successful Redis consume, a follow-up consume whose Redis read comes back
    // empty MUST not find the entry in memStore either.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('dave', 'orcid', T);
    const first = await consumeFreshAuthToken(issued.token, 'dave', TH);
    expect(first.valid).toBe(true);

    // Now simulate the Redis read coming back empty and check that the memStore
    // copy is gone too (a successful Redis burn deletes the memStore backup, so
    // the symmetric-deletion pin holds).
    const getdelSpy = vi.spyOn(redis, 'get').mockResolvedValueOnce(null);
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
  // A consent-op burn must clear BOTH tiers, not just the one that answered the
  // read. A variant that burned only the tier it read from would leave the other
  // copy alive: a consume served from the memStore backup during a Redis blip
  // would leave the canonical Redis entry standing, and a same-process replay
  // once Redis recovered inside the TTL would return valid AGAIN.
  it.skipIf(!redisAvailable)('a memStore-served consume still clears the canonical Redis entry, so a Redis-recovered replay cannot succeed', async () => {
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('eve', 'password', T);

    // Step 1: stub the Redis read to throw once. This forces the fallback to
    // memStore on consume — which succeeds via the memStore backup written at
    // issuance. The burn is NOT stubbed, so it still reaches Redis.
    const getdelSpy = vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis flap on read'));

    let firstResult;
    try {
      firstResult = await consumeFreshAuthToken(issued.token, 'eve', TH);
    } finally {
      getdelSpy.mockRestore();
    }
    expect(firstResult.valid).toBe(true);

    // Step 2: Redis is "recovered" (default behavior, no spy). A second consume
    // with the same token must return `expired` because the burn cleared both
    // tiers: the memStore copy AND the canonical Redis entry. A variant that
    // burned only the answering tier would have left the Redis entry alive, so
    // this second consume's read would have returned it, the narrowing would
    // have parsed it, and the result would be `valid: true` — a DOUBLE-CONSUME.
    // The test fails on that mutation.
    const replay = await consumeFreshAuthToken(issued.token, 'eve', TH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('a burn whose Redis leg fails still clears the canonical entry, so a replay after recovery is refused', async () => {
    // The burn's Redis leg is the one that can silently half-apply: the read
    // that discovered the entry already succeeded, so a rejecting delete leaves
    // the canonical copy alive while the in-memory delete still reports a win.
    // The consume returns valid, and the SAME proof authorizes a second critical
    // action once the client reconnects inside the TTL. A compensating delete is
    // what closes that, and the key-absence assertion below is its mutation-kill:
    // the replay assertions after it are NOT, because the spent-proof ledger
    // refuses a replayed consent-op proof whether or not that delete ever runs.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('flap-burn', 'password', T);
    const key = `${config.appTag}:fresh_auth:token:${issued.token}`;
    expect(await redis.exists(key)).toBe(1);

    const burnSpy = vi
      .spyOn(redis, 'getdel')
      .mockRejectedValueOnce(new Error('simulated flap on the burn'));
    let first;
    try {
      first = await consumeFreshAuthToken(issued.token, 'flap-burn', TH);
    } finally {
      burnSpy.mockRestore();
    }
    expect(first.valid).toBe(true);

    // Taken before the replay, so it attributes the removal to the compensating
    // delete. This is the real-path arm of that class: `isRedisAvailable()` is
    // genuinely true here and only the `GETDEL` was made to reject.
    expect(await redis.exists(key)).toBe(0);

    // Redis is "recovered": the entry must be gone from it, not merely from the
    // in-memory backup.
    const replay = await consumeFreshAuthToken(issued.token, 'flap-burn', TH);
    expect(replay.valid).toBe(false);
    if (!replay.valid) {
      expect(replay.reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('a throwing Redis del does not break the consume — the in-memory tier arbitrates the burn', async () => {
    // The Redis leg of the burn runs inside a try/catch: if Redis is flaky on
    // the del side too, the in-memory delete's return value decides whether this
    // caller won, and the user's broadcast must still proceed. Pin that the
    // consume reports valid even when both Redis legs throw.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('frank', 'password', T);

    const getdelSpy = vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('flap on read'));
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

/** Session consume with no revocation epoch to supply. These specs exercise the
 *  fresh-auth store directly, with no `accounts` row behind them, so there is no
 *  `sessions_invalidated_at` to read and `undefined` is the honest value: it is
 *  exactly what `verifyHiveSignature` leaves on the request when no app-DB pool
 *  is configured. The specs that DO drive the cut-off pass an epoch to
 *  `consumeSessionFreshAuthToken` directly. */
const consumeSessionNoEpoch = (token: string | undefined, username: string) =>
  consumeSessionFreshAuthToken(token, username, undefined);

describe('session-kind issue / consume — issueSessionFreshAuthToken + consumeSessionFreshAuthToken', () => {
  beforeEach(() => {
    _resetFreshAuthMemStoreForTests();
  });

  it('the revocation epoch is a required parameter, not an omissible one', () => {
    // Type-level pin, never invoked. An epoch reached by omission disables the
    // authoritative half of session invalidation while the best-effort sweep
    // keeps the failure invisible, so the signature must refuse a two-argument
    // call. If the parameter is ever widened back to optional this directive
    // becomes unused and `typecheck:tests` fails on it, which is the only thing
    // in the repo that notices: the widening changes no runtime behaviour and
    // breaks no assertion.
    const twoArgumentCall = () =>
      // @ts-expect-error the account revocation epoch must be passed explicitly
      consumeSessionFreshAuthToken('unreachable-token', 'unreachable-user');
    expect(typeof twoArgumentCall).toBe('function');
  });

  it('issue then consume session-kind → valid + mechanism preserved', async () => {
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    const result = await consumeSessionNoEpoch(issued.token, 'alice');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('password');
    }
  });

  it('session-kind via ORCID mechanism → valid + mechanism=orcid', async () => {
    const issued = await issueSessionFreshAuthToken('carl', 'orcid');
    const result = await consumeSessionNoEpoch(issued.token, 'carl');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.mechanism).toBe('orcid');
    }
  });

  it('multi-use inside the window: three consecutive consumes all succeed', async () => {
    // Three, not two: two consumes prove "double-use", which a regression that
    // spends the proof on its SECOND use would also satisfy.
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    for (let i = 0; i < 3; i++) {
      const result = await consumeSessionNoEpoch(issued.token, 'alice');
      expect(result.valid).toBe(true);
    }
  });

  it('issuance reports both deadlines as ISO-8601 strings', async () => {
    const before = Date.now();
    const issued = await issueSessionFreshAuthToken('alice', 'password');
    const idleMs = new Date(issued.expires_at).getTime();
    const capMs = new Date(issued.absolute_expires_at).getTime();
    // ISO-8601 strings, not epoch numbers: the SPA reads these with
    // `new Date(...).getTime()`, and an epoch-seconds number would be read as
    // milliseconds and resolve to 1970, making the client-side cache useless.
    expect(typeof issued.expires_at).toBe('string');
    expect(typeof issued.absolute_expires_at).toBe('string');
    expect(issued.expires_at).toBe(new Date(idleMs).toISOString());
    expect(issued.absolute_expires_at).toBe(new Date(capMs).toISOString());
    // The idle deadline is the one the client treats as authoritative, and at
    // mint time it is the nearer of the two.
    expect(idleMs).toBeLessThan(capMs);
    expect(idleMs - before).toBeGreaterThan((SESSION_FRESH_AUTH_IDLE_SECONDS - 5) * 1000);
    expect(idleMs - before).toBeLessThanOrEqual(SESSION_FRESH_AUTH_IDLE_SECONDS * 1000);
    expect(capMs - before).toBeGreaterThan((SESSION_FRESH_AUTH_ABSOLUTE_SECONDS - 5) * 1000);
    expect(capMs - before).toBeLessThanOrEqual(SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000);
  });

  it('cross-account: session token for bob consumed with alice → username_mismatch', async () => {
    const issued = await issueSessionFreshAuthToken('bob', 'password');
    const result = await consumeSessionNoEpoch(issued.token, 'alice');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('username_mismatch');
    }
  });

  it('missing token → missing reason', async () => {
    const result = await consumeSessionNoEpoch(undefined, 'alice');
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
    const result = await consumeSessionNoEpoch(issued.token, 'alice');
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
    // Stub the Redis read to throw on BOTH calls. mockImplementation, not
    // mockRejectedValueOnce — Promise.all may fire both calls before either
    // resolves.
    const getdelSpy = vi.spyOn(redis, 'get').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for race test'));
    });
    // Stub the Redis leg of the burn to report "removed nothing" so the
    // in-memory tier is the only arbiter — that is the window the lock closes.
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
    // For the Redis-available case, this test is functionally equivalent to the
    // Redis-up test above (the Redis delete-reply count arbitrates and the lock
    // is additionally enforced); under no-Redis it is the real-path companion.
    const issued = await issueFreshAuthToken('race-carol', 'password', T);
    const [a, b] = await Promise.all([
      consumeFreshAuthToken(issued.token, 'race-carol', TH),
      consumeFreshAuthToken(issued.token, 'race-carol', TH),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    expect(winners).toHaveLength(1);
  });

  // The session kind inverts the acceptance above: a window is multi-use, so
  // serializing concurrent consumes would turn ordinary SPA behaviour (two votes
  // fired in the same tick, an upload-token mint racing a broadcast) into a
  // spurious 401 the client reads as "re-auth needed". Both callers must win.

  it.skipIf(!redisAvailable)('consumeSessionFreshAuthToken Redis-up: Promise.all dual consume → BOTH succeed', async () => {
    const issued = await issueSessionFreshAuthToken('race-dave', 'password');
    const [a, b] = await Promise.all([
      consumeSessionNoEpoch(issued.token, 'race-dave'),
      consumeSessionNoEpoch(issued.token, 'race-dave'),
    ]);
    const winners = [a, b].filter((r) => r.valid);
    // Mutation kill for a regression back to a destructive read: a GETDEL-shaped
    // session consume would still produce exactly one winner here, which is
    // precisely the behaviour this assertion forbids.
    expect(winners).toHaveLength(2);
    expect([a, b].filter((r) => !r.valid)).toHaveLength(0);
  });

  it.skipIf(!redisAvailable)('consumeSessionFreshAuthToken Redis-stubbed-to-throw: Promise.all dual consume → BOTH succeed', async () => {
    // Widest window: both consumes fall through to the in-memory tier. Mutation
    // kill for a stray `memStore.delete` surviving on the session path — the
    // second caller would find nothing and report `expired`.
    const redis = getRedis()!;
    const issued = await issueSessionFreshAuthToken('race-eve', 'orcid');
    const getdelSpy = vi.spyOn(redis, 'get').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for race test'));
    });
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    try {
      const [a, b] = await Promise.all([
        consumeSessionNoEpoch(issued.token, 'race-eve'),
        consumeSessionNoEpoch(issued.token, 'race-eve'),
      ]);
      expect([a, b].filter((r) => r.valid)).toHaveLength(2);
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });

  it('consumeSessionFreshAuthToken no-Redis real-path: Promise.all dual consume → BOTH succeed', async () => {
    // No-mock companion to the stubbed-Redis variant above, so the concurrency
    // claim is covered against real infrastructure and not only through a spy.
    const issued = await issueSessionFreshAuthToken('race-frank', 'password');
    const [a, b] = await Promise.all([
      consumeSessionNoEpoch(issued.token, 'race-frank'),
      consumeSessionNoEpoch(issued.token, 'race-frank'),
    ]);
    expect([a, b].filter((r) => r.valid)).toHaveLength(2);
  });

  it('lock hygiene: a consume that throws while reading leaves the in-flight set clean', async () => {
    // The lock is acquired AFTER the store read, so a throw during the read must
    // never leave a lock entry behind. Pin that structurally via the set size
    // rather than via wire codes: the lock-held branch and the already-burned
    // branch both return `expired`, so a wire-shape assertion cannot see a leak.
    //
    // Mechanism: plant an in-memory entry whose value has a circular reference
    // so `JSON.stringify` throws while the read is serializing it, and force the
    // Redis read to fail so the helper reaches that entry.
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
        ? vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced Redis-down for cleanup test'))
        : null;
    try {
      await expect(
        consumeFreshAuthToken(token, 'lock-cleanup', TH),
      ).rejects.toThrow();
      expect(_getInFlightConsumesSizeForTests()).toBe(0);
    } finally {
      getdelSpy?.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('the lock is held across the consent-op burn and released after it (structural pin)', async () => {
    // Complements the hygiene test above by pinning the acquire side. Sampling
    // the set size from inside the Redis burn is the only way to distinguish
    // "the lock was taken" from "the burn happened to be atomic anyway": both
    // shapes produce the same wire result for a single consume, which is what
    // makes a dropped `inFlightConsumes.add` invisible to outcome assertions.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('lock-window', 'password', T);
    const sizesDuringBurn: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delSpy = vi.spyOn(redis, 'getdel').mockImplementation((async () => {
      sizesDuringBurn.push(_getInFlightConsumesSizeForTests());
      return '{}';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    try {
      const result = await consumeFreshAuthToken(issued.token, 'lock-window', TH);
      expect(result.valid).toBe(true);
      expect(sizesDuringBurn).toEqual([1]);
    } finally {
      delSpy.mockRestore();
    }
    expect(_getInFlightConsumesSizeForTests()).toBe(0);
  });

  it('the session slide runs WITHOUT the lock, which is what lets concurrent consumes both win', async () => {
    // The inverse structural pin: sampling the set size from inside the slide
    // write proves the session path never enters the critical section. A
    // mutation that reinstated a shared lock would still pass the "both win"
    // race assertions whenever the event loop happened to serialize them, so
    // the observation has to be made from inside the call.
    const redis = getRedis();
    if (!redis || !isRedisAvailable()) {
      // No Redis: the slide only touches the in-memory tier, and the lock claim
      // is then covered by the no-Redis dual-consume test above.
      const issued = await issueSessionFreshAuthToken('slide-nolock', 'password');
      await consumeSessionNoEpoch(issued.token, 'slide-nolock');
      expect(_getInFlightConsumesSizeForTests()).toBe(0);
      return;
    }
    const issued = await issueSessionFreshAuthToken('slide-nolock', 'password');
    const sizesDuringSlide: number[] = [];
    const setSpy = vi.spyOn(redis, 'set').mockImplementation((() => {
      sizesDuringSlide.push(_getInFlightConsumesSizeForTests());
      return Promise.resolve('OK');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    try {
      const result = await consumeSessionNoEpoch(issued.token, 'slide-nolock');
      expect(result.valid).toBe(true);
      expect(sizesDuringSlide).toEqual([0]);
    } finally {
      setSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('cross-helper Redis-stubbed Promise.all on a consent-op token → exactly one winner', async () => {
    // The lock domain is the TOKEN, not the calling helper. A consent-op proof
    // reaches the session surface through the cross-kind accept, so both helpers
    // can be burning the same entry at once; a lock split per helper would let a
    // `Promise.all` across the two race to the in-memory tier under Redis-down
    // and both win, double-spending a single-use proof.
    //
    // Either helper as winner is acceptable; the load-bearing claim is "exactly
    // one winner". Redis-stubbed rather than Redis-up because the delete-reply
    // count alone would also produce one winner under the mutation — the kill
    // requires forcing both helpers onto the in-memory tier.
    const redis = getRedis()!;
    const issued = await issueFreshAuthToken('race-cross', 'password', T);
    const getdelSpy = vi.spyOn(redis, 'get').mockImplementation(() => {
      return Promise.reject(new Error('forced Redis-down for cross-helper race test'));
    });
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    try {
      const [a, b] = await Promise.all([
        consumeFreshAuthToken(issued.token, 'race-cross', TH),
        consumeSessionNoEpoch(issued.token, 'race-cross'),
      ]);
      const winners = [a, b].filter((r) => r.valid);
      expect(winners).toHaveLength(1);
    } finally {
      getdelSpy.mockRestore();
      delSpy.mockRestore();
    }
  });
});


// ─── session-proof window: sliding idle deadline + absolute cap ───

describe('session-proof window', () => {
  // Fake timers are the carve-out class root CLAUDE.md names for deterministic
  // edge cases: the sliding deadline is 15 minutes out and the cap is 2 hours
  // out, so exercising either against the wall clock is impractical. Redis, when
  // present, is REAL here — only `Date.now()` is faked. That is deliberate: the
  // stored deadlines are what the consume compares against, so a real Redis
  // round-trip still exercises the persistence leg while the clock moves.
  beforeEach(() => {
    _resetFreshAuthMemStoreForTests();
  });

  it('the window values are what the contract says they are', () => {
    // Every other assertion in this file and in the two route suites derives its
    // expected bounds from these same constants, so all of them stay green if
    // the production values move. 15 minutes of inactivity and a 2-hour cap are
    // stated requirements, not implementation details — pin them literally, or
    // widening the cap by a factor of ten is a one-character change no test
    // notices.
    expect(SESSION_FRESH_AUTH_IDLE_SECONDS).toBe(15 * 60);
    expect(SESSION_FRESH_AUTH_ABSOLUTE_SECONDS).toBe(2 * 60 * 60);
  });

  /** Plant a session entry directly in the in-memory tier with chosen deadlines,
   *  and optionally a chosen `issued_at`. Used for the boundary cases where
   *  minting cannot produce the shape under test (a window already past its cap,
   *  a cap nearer than the idle deadline, an `issued_at` that lands exactly on a
   *  revocation instant). The token is absent from Redis, so the read falls
   *  through to this tier. */
  function plantSessionEntry(
    token: string,
    username: string,
    idleExpiresAt: number,
    absoluteExpiresAt: number,
    // Defaults to what a real mint would have written for this cap, so the
    // deadline-boundary callers stay as they were. The revocation-epoch cases
    // pass it explicitly: `issued_at` is the field the epoch comparison reads,
    // and deriving it from the cap would make the comparison's own input an
    // artifact of the chosen deadlines instead of the subject of the test.
    issuedAt: number = absoluteExpiresAt - SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000,
  ): void {
    _setMemStoreEntryForTests(
      token,
      {
        username,
        mechanism: 'password',
        issued_at: issuedAt,
        kind: 'session',
        idle_expires_at: idleExpiresAt,
        absolute_expires_at: absoluteExpiresAt,
      },
      Math.max(idleExpiresAt, absoluteExpiresAt) + 60_000,
    );
  }

  it('idle beyond the window with no intervening use → expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const issued = await issueSessionFreshAuthToken('idle-user', 'password');

    vi.setSystemTime(t0 + (SESSION_FRESH_AUTH_IDLE_SECONDS + 1) * 1000);
    const result = await consumeSessionNoEpoch(issued.token, 'idle-user');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('a consume slides the idle deadline forward, so a working stretch is never interrupted', async () => {
    // Mutation kill for a consume that validates the window but does not slide
    // it: the second consume lands well past the ORIGINAL idle deadline and
    // would report `expired`.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const issued = await issueSessionFreshAuthToken('slide-user', 'password');
    const idleMs = SESSION_FRESH_AUTH_IDLE_SECONDS * 1000;

    vi.setSystemTime(t0 + idleMs - 60_000);
    expect((await consumeSessionNoEpoch(issued.token, 'slide-user')).valid).toBe(true);

    // Past the original deadline, inside the slid one.
    vi.setSystemTime(t0 + idleMs + 60_000);
    expect((await consumeSessionNoEpoch(issued.token, 'slide-user')).valid).toBe(true);
  });

  it('the window dies at the absolute cap no matter how often it was slid', async () => {
    // Slide repeatedly across the cap. The loop is the shape the cap exists to
    // defend against: an attacker holding the proof keeps it alive by using it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const issued = await issueSessionFreshAuthToken('cap-user', 'password');

    const stepMs = (SESSION_FRESH_AUTH_IDLE_SECONDS - 60) * 1000;
    const capMs = SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000;
    let elapsed = 0;
    let lastValidElapsed = 0;
    let deniedElapsed: number | null = null;
    // One step past the cap so the loop is guaranteed to cross it.
    while (elapsed <= capMs + stepMs) {
      elapsed += stepMs;
      vi.setSystemTime(t0 + elapsed);
      const result = await consumeSessionNoEpoch(issued.token, 'cap-user');
      if (result.valid) {
        lastValidElapsed = elapsed;
      } else {
        expect(result.reason).toBe('expired');
        deniedElapsed = elapsed;
        break;
      }
    }
    expect(deniedElapsed).not.toBeNull();
    // Fails closed AT the cap, not merely eventually: the last accepted consume
    // was inside the cap and the first denial is at or past it.
    expect(lastValidElapsed).toBeLessThan(capMs);
    expect(deniedElapsed as number).toBeGreaterThanOrEqual(capMs);
  });

  it('a window already past its cap is rejected even when its idle deadline is in the future', async () => {
    // Mutation kill aimed squarely at the cap check. The storage TTL normally
    // expires such an entry on its own, which is exactly why the cap can be
    // implemented so that it silently never fires; planting the shape directly
    // is the only way to observe the check itself.
    const now = Date.now();
    plantSessionEntry('cap-past-token', 'cap-past-user', now + 600_000, now - 1_000);
    const result = await consumeSessionNoEpoch('cap-past-token', 'cap-past-user');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('a window past its idle deadline is rejected even when the cap is far away', async () => {
    // The mirror-image mutation kill: dropping the idle check would leave a
    // proof usable for the full two hours after a single use.
    const now = Date.now();
    plantSessionEntry('idle-past-token', 'idle-past-user', now - 1_000, now + 3_600_000);
    const result = await consumeSessionNoEpoch('idle-past-token', 'idle-past-user');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('the slide is clamped to the cap rather than pushed past it', async () => {
    // A cap nearer than one idle period. The consume must succeed, and the
    // window must still end at the cap. Without the clamp the slide would set
    // the idle deadline a full idle period out and outlive the cap.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    plantSessionEntry('clamp-token', 'clamp-user', t0 + 10_000, t0 + 60_000);

    expect((await consumeSessionNoEpoch('clamp-token', 'clamp-user')).valid).toBe(true);

    vi.setSystemTime(t0 + 61_000);
    const afterCap = await consumeSessionNoEpoch('clamp-token', 'clamp-user');
    expect(afterCap.valid).toBe(false);
    if (!afterCap.valid) {
      expect(afterCap.reason).toBe('expired');
    }
  });

  it.skipIf(!redisAvailable)('a slide served from Redis is written back with XX so it cannot resurrect a lapsed key', async () => {
    // `XX` is the guard for the gap between this consume's read and its write:
    // the key can lapse in between, and a plain SET would recreate it for
    // another full window.
    const redis = getRedis()!;
    const issued = await issueSessionFreshAuthToken('xx-user', 'password');
    const setSpy = vi.spyOn(redis, 'set');
    try {
      expect((await consumeSessionNoEpoch(issued.token, 'xx-user')).valid).toBe(true);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(setSpy.mock.calls[0]).toContain('XX');
    } finally {
      setSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('a slide whose Redis write never settles neither delays the decision nor loses the slid deadline', async () => {
    // Two properties of the same two statements, neither visible to an
    // outcome-only assertion.
    //
    // The persist is detached from the authorization decision on purpose: the
    // decision is already final, and a lost slide fails closed (the window keeps
    // its earlier idle deadline). Re-attaching an `await` to the
    // `persistSessionSlide` call in `consumeSessionWindow` puts a
    // connected-but-stalled Redis on the critical path of every vote, comment,
    // post, and review, up to the client's command timeout — and no assertion on
    // the consume's OUTCOME can see that, because a write that resolves produces
    // the identical result either way. Only a write that never settles separates
    // the two shapes, so that is what is injected here.
    //
    // The second half pins what makes that detachment safe: the in-memory write
    // inside `persistSessionSlide` runs BEFORE its first await, so the slid
    // deadline is already observable while the canonical write is still in
    // flight. Moving that write behind the network call passes every other
    // assertion in this file (Redis answers the read on the happy path, so the
    // backup is never consulted) and would silently stop windows sliding
    // whenever Redis is slow, closing every active user's window at its
    // mint-time idle deadline.
    //
    // Redis-served leg required throughout: a consume answered by the in-memory
    // tier returns from `persistSessionSlide` before it ever issues the write,
    // which is also why no Redis-free variant of this pin exists.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const redis = getRedis()!;
    // Minted BEFORE the spy: issuance writes through the same `set`.
    const issued = await issueSessionFreshAuthToken('stalled-slide-user', 'password');
    const idleMs = SESSION_FRESH_AUTH_IDLE_SECONDS * 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setSpy = vi.spyOn(redis, 'set').mockImplementation((() => new Promise(() => {})) as any);
    let sentinel: ReturnType<typeof setTimeout> | undefined;
    try {
      vi.setSystemTime(t0 + idleMs - 60_000);
      const outcome = await Promise.race([
        consumeSessionNoEpoch(issued.token, 'stalled-slide-user').then((r) =>
          r.valid ? 'valid' : 'invalid',
        ),
        new Promise<string>((res) => {
          // Generous against the one real Redis GET on the read leg
          // (sub-millisecond against the local server) while still bounding the
          // awaited shape, which can never settle. The race is for a readable
          // failure, not for correctness: without it the awaited shape fails as
          // a file timeout instead, once per retry attempt.
          sentinel = setTimeout(() => res('stalled'), 2_000);
        }),
      ]);
      clearTimeout(sentinel);
      expect(outcome).toBe('valid');
      // Non-vacuity: the stalled write really was reached. `redis.set` is
      // invoked before `persistSessionSlide`'s first await, so the call is
      // recorded even though it never completes, and a read that had fallen
      // through to the in-memory tier would leave this at zero.
      expect(setSpy).toHaveBeenCalledTimes(1);

      const getSpy = vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced Redis-down'));
      try {
        // Past the mint-time idle deadline, inside the slid one. Redis still
        // holds the unslid entry (its write is hanging), so this can only
        // succeed if the in-memory tier already carries the slide.
        vi.setSystemTime(t0 + idleMs + 60_000);
        expect((await consumeSessionNoEpoch(issued.token, 'stalled-slide-user')).valid).toBe(true);
        // The in-memory-served consume issues no write of its own, so the
        // stalled one above is still the only `set` on this token.
        expect(setSpy).toHaveBeenCalledTimes(1);
      } finally {
        getSpy.mockRestore();
      }
    } finally {
      if (sentinel) clearTimeout(sentinel);
      setSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('a slide served from the in-memory tier is NOT written back to Redis', async () => {
    // The in-memory tier answers precisely when Redis did not. Writing the slid
    // entry to Redis from there would recreate a key Redis has already dropped.
    const redis = getRedis()!;
    const issued = await issueSessionFreshAuthToken('nowrite-user', 'password');
    const getSpy = vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced Redis-down'));
    const setSpy = vi.spyOn(redis, 'set');
    try {
      expect((await consumeSessionNoEpoch(issued.token, 'nowrite-user')).valid).toBe(true);
      expect(setSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it.skipIf(!redisAvailable)('a slide whose write is declined removes the in-memory copy instead of resurrecting the window', async () => {
    // The race this closes: an invalidation (a password reset) sweeps both tiers
    // while a consume is already in flight, having read the entry from Redis
    // microseconds earlier. That consume then validates and slides, and its
    // unconditional in-memory write re-plants the entry the sweep had just
    // removed. Every later consume reads Redis (miss), falls through to the
    // re-planted copy, succeeds, and slides again, so the window outlives the
    // reset that was supposed to close it.
    //
    // Simulated precisely: the read returns the real stored value while the key
    // vanishes underneath it, which is what the sweep does. The `XX` flag on the
    // write is then declined, and that declined reply is the signal that the
    // canonical tier is gone.
    const redis = getRedis()!;
    const issued = await issueSessionFreshAuthToken('sweep-race', 'password');
    const raw = await redis.get(`${config.appTag}:fresh_auth:token:${issued.token}`);
    expect(raw).toBeTruthy();

    const getSpy = vi.spyOn(redis, 'get').mockImplementationOnce(async () => {
      await redis.del(`${config.appTag}:fresh_auth:token:${issued.token}`);
      return raw;
    });
    try {
      // The in-flight consume still succeeds; it was authorized before the sweep
      // landed. What must not happen is the window surviving it.
      expect((await consumeSessionNoEpoch(issued.token, 'sweep-race')).valid).toBe(true);
    } finally {
      getSpy.mockRestore();
    }

    const afterSweep = await consumeSessionNoEpoch(issued.token, 'sweep-race');
    expect(afterSweep.valid).toBe(false);
    if (!afterSweep.valid) {
      expect(afterSweep.reason).toBe('expired');
    }
  });

  it('a slide served from the in-memory tier is not lost — the next consume sees it', async () => {
    // The flap-recovery property has to survive the window change: a consume
    // that recovers from the backup tier must still move the deadline, or a
    // Redis outage would silently shorten every window to a single use.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t0 = new Date('2026-03-01T00:00:00Z').getTime();
    vi.setSystemTime(t0);
    const issued = await issueSessionFreshAuthToken('memslide-user', 'password');
    const idleMs = SESSION_FRESH_AUTH_IDLE_SECONDS * 1000;

    const redis = getRedis();
    const getSpy =
      redis && isRedisAvailable()
        ? vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced Redis-down'))
        : null;
    try {
      vi.setSystemTime(t0 + idleMs - 60_000);
      expect((await consumeSessionNoEpoch(issued.token, 'memslide-user')).valid).toBe(true);
      vi.setSystemTime(t0 + idleMs + 60_000);
      expect((await consumeSessionNoEpoch(issued.token, 'memslide-user')).valid).toBe(true);
    } finally {
      getSpy?.mockRestore();
    }
  });

  it('a stored session entry without window deadlines is malformed, not unbounded', async () => {
    // Closed-default for a shape written by a deploy that predates the window.
    // Reading it as "no deadlines, therefore no expiry" is the failure mode this
    // pins against; one extra re-auth during a deploy is the correct trade.
    _setMemStoreEntryForTests(
      'legacy-session-token',
      { username: 'legacy-user', mechanism: 'password', issued_at: Date.now(), kind: 'session' },
      Date.now() + 600_000,
    );
    const result = await consumeSessionNoEpoch('legacy-session-token', 'legacy-user');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('a stored session entry with no issued_at is malformed, not reconstructed from the cap', async () => {
    // `issued_at` is the anchor the revocation-epoch comparison in
    // `consumeSessionWindow` reads. Reconstructing it from
    // `absolute_expires_at` minus the cap is a fail-open, and the epoch below is
    // what shows it: a revocation stamped at the current instant covers every
    // window minted so far, yet the planted cap is two full windows out, so the
    // reconstruction lands a full window in the FUTURE and escapes it. The entry
    // has to be refused at the structural guard instead.
    const now = Date.now();
    const anchorless: Record<string, unknown> = {
      username: 'anchorless-user',
      mechanism: 'password',
      kind: 'session',
      idle_expires_at: now + 600_000,
      absolute_expires_at: now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000 * 2,
    };
    _setMemStoreEntryForTests('anchorless-session-token', anchorless, now + 600_000);
    const result = await consumeSessionFreshAuthToken(
      'anchorless-session-token',
      'anchorless-user',
      now,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('a stored session entry whose issued_at is not an epoch is malformed', async () => {
    // A non-number anchor is the shape a hand-edited or foreign-serializer entry
    // takes. Coercing it, or falling back to a reconstruction, would put a value
    // this module invented on the revocation comparison's left-hand side; the
    // guard refuses the entry instead. Distinct from the case above: a guard
    // that only checked for presence would pass this one.
    const now = Date.now();
    const stringyAnchor: Record<string, unknown> = {
      username: 'stringy-anchor-user',
      mechanism: 'password',
      issued_at: String(now),
      kind: 'session',
      idle_expires_at: now + 600_000,
      absolute_expires_at: now + 3_600_000,
    };
    _setMemStoreEntryForTests('stringy-anchor-token', stringyAnchor, now + 600_000);
    const result = await consumeSessionNoEpoch('stringy-anchor-token', 'stringy-anchor-user');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('the revocation comparison reads the stored anchor, never one derived from the cap', async () => {
    // The two cases above only prove a bad anchor is refused. This one proves
    // the surviving anchor is the STORED value: a guard that rejects and THEN
    // still hands `consumeSessionWindow` `absolute_expires_at` minus the cap
    // passes both of them. The planted entry is deliberately cap-inconsistent
    // (mint time an hour ago, cap only ninety minutes out) because that is the
    // only shape that separates the two readings: the stored anchor is inside
    // the revocation, the cap-derived one is thirty minutes clear of it. Every
    // real mint sets the cap to the mint instant plus the window, where the two
    // coincide, so no test built on a real mint can see the difference.
    const now = Date.now();
    plantSessionEntry(
      'stored-anchor-token',
      'stored-anchor-user',
      now + 600_000,
      now + 5_400_000,
      now - 3_600_000,
    );
    const result = await consumeSessionFreshAuthToken(
      'stored-anchor-token',
      'stored-anchor-user',
      now - 2_700_000,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('a stored consent-op entry carrying window deadlines is malformed', async () => {
    // The inverse shape guard. A consent-op entry that acquired deadlines is a
    // kind/field combination this module never mints, and treating it as valid
    // would be the exact route by which the strictest proof kind turns into the
    // loosest one.
    const now = Date.now();
    _setMemStoreEntryForTests(
      'hybrid-token',
      {
        username: 'hybrid-user',
        mechanism: 'password',
        issued_at: now,
        kind: 'consent_op',
        target_hash: TH,
        idle_expires_at: now + 600_000,
        absolute_expires_at: now + 3_600_000,
      },
      now + 600_000,
    );
    const result = await consumeFreshAuthToken('hybrid-token', 'hybrid-user', TH);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('a cross-kind-accepted consent-op proof is still spent on the session surface, never turned into a window', async () => {
    // The cross-kind accept is the path by which a single-use target-bound proof
    // reaches the multi-use surface. If the slide ran unconditionally it would
    // rewrite that entry with deadlines and hand the caller a two-hour window.
    const issued = await issueFreshAuthToken('crosskind-user', 'password', T);
    const first = await consumeSessionNoEpoch(issued.token, 'crosskind-user');
    expect(first.valid).toBe(true);
    const second = await consumeSessionNoEpoch(issued.token, 'crosskind-user');
    expect(second.valid).toBe(false);
    if (!second.valid) {
      expect(second.reason).toBe('expired');
    }
  });

  it('a session proof on the consent surface is rejected without being spent', async () => {
    // Burning it there would let anyone holding the token close the owner's
    // window by presenting it on the wrong surface.
    const issued = await issueSessionFreshAuthToken('kindmiss-user', 'password');
    const rejected = await consumeFreshAuthToken(issued.token, 'kindmiss-user', TH);
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) {
      expect(rejected.reason).toBe('kind_mismatch');
    }
    expect((await consumeSessionNoEpoch(issued.token, 'kindmiss-user')).valid).toBe(true);
  });

  // ─── revocation epoch: the comparison boundary, the drop, the no-epoch posture ───

  describe('the revocation-epoch cut-off', () => {
    // Every case plants deadlines a real mint would have written for `now`, so
    // an `expired` verdict can only have come from the epoch comparison. All
    // three rejection paths in the consume report the same reason, and a
    // boundary case that let a deadline answer instead would pass while proving
    // nothing.

    it('a window issued in the SAME millisecond as the epoch is dead', async () => {
      // The realistic race, and the whole reason the comparison is "at or
      // before" rather than strictly before: the reset stamps
      // `sessions_invalidated_at` from SQL `NOW()`, the transaction-start
      // instant, while the window it must kill was minted from `Date.now()` in
      // the same instant. Equality is the only input that separates the two
      // operators, and minting and then reading the clock cannot produce it,
      // which is why the entry is planted with an exact `issued_at`.
      const now = Date.now();
      const issuedAt = now - 60_000;
      plantSessionEntry(
        'epoch-eq-token',
        'epoch-eq-user',
        now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000,
        now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000,
        issuedAt,
      );

      const result = await consumeSessionFreshAuthToken('epoch-eq-token', 'epoch-eq-user', issuedAt);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
      }
    });

    it('the window it rejects is dropped from the tier that served it', async () => {
      // The rejection and the eviction are separable: returning `expired`
      // without dropping the entry looks identical on the wire, and the
      // in-memory tier is precisely the one that answers when the Redis sweep
      // could not run, so a dead window would sit there re-deciding itself until
      // its cap. The second consume carries NO epoch, so it can only fail if the
      // entry is gone.
      const now = Date.now();
      const issuedAt = now - 60_000;
      plantSessionEntry(
        'epoch-drop-token',
        'epoch-drop-user',
        now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000,
        now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000,
        issuedAt,
      );

      expect(
        (await consumeSessionFreshAuthToken('epoch-drop-token', 'epoch-drop-user', issuedAt)).valid,
      ).toBe(false);

      const afterDrop = await consumeSessionNoEpoch('epoch-drop-token', 'epoch-drop-user');
      expect(afterDrop.valid).toBe(false);
      if (!afterDrop.valid) {
        expect(afterDrop.reason).toBe('expired');
      }
    });

    it('a window issued one millisecond after the epoch survives', async () => {
      // The tight-margin control. A comparison that rounded either side to whole
      // seconds would reject here while passing every coarser test, and it would
      // revoke windows minted legitimately in the same second as a completed
      // reset. The epoch is snapped to a whole second so that one millisecond
      // later is always inside the same second: with an arbitrary epoch, one
      // millisecond-remainder in a thousand puts the two on opposite sides of a
      // second boundary and the rounding mutation escapes.
      const now = Date.now();
      const epochMs = Math.floor((now - 60_000) / 1000) * 1000;
      plantSessionEntry(
        'epoch-after-token',
        'epoch-after-user',
        now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000,
        now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000,
        epochMs + 1,
      );

      const result = await consumeSessionFreshAuthToken(
        'epoch-after-token',
        'epoch-after-user',
        epochMs,
      );

      expect(result.valid).toBe(true);
    });

    it('neither a null nor an absent epoch applies a cut-off', async () => {
      // `null` is what `verifyHiveSignature` publishes for an account whose
      // `sessions_invalidated_at` column is NULL, which is nearly every account
      // on nearly every request; absent is the no-app-pool branch, where the
      // middleware skipped its own revocation lookup for the same reason.
      // Reading either as "revoke everything" would lock the product out of
      // broadcasting, so the fail-open direction is a deliberate posture and is
      // pinned as one. Both producers are named here because a hardening edit
      // that fails only the explicitly-null case closed would otherwise hide
      // behind the absent case, which the rest of this suite already exercises
      // everywhere.
      const now = Date.now();
      const idle = now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000;
      const cap = now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000;
      plantSessionEntry('epoch-null-token', 'epoch-null-user', idle, cap, now - 60_000);
      plantSessionEntry('epoch-absent-token', 'epoch-absent-user', idle, cap, now - 60_000);

      expect(
        (await consumeSessionFreshAuthToken('epoch-null-token', 'epoch-null-user', null)).valid,
      ).toBe(true);
      expect((await consumeSessionNoEpoch('epoch-absent-token', 'epoch-absent-user')).valid).toBe(
        true,
      );
    });

    it('a slide leaves issued_at alone, so a revoked window cannot outlive its revocation', async () => {
      // `issued_at` is the anchor the epoch comparison reads, and the slide
      // rewrites every other field on the stored entry. A slide that refreshed
      // it as well would let a window minted before a reset walk forward past
      // the epoch on ordinary use and come back to life on the next consume. The
      // epoch here is one millisecond AFTER the planted `issued_at`, so this
      // case turns on strict-less and stays independent of the same-millisecond
      // boundary above.
      const now = Date.now();
      const issuedAt = now - 60_000;
      plantSessionEntry(
        'epoch-slide-token',
        'epoch-slide-user',
        now + SESSION_FRESH_AUTH_IDLE_SECONDS * 1000,
        now + SESSION_FRESH_AUTH_ABSOLUTE_SECONDS * 1000,
        issuedAt,
      );

      // No epoch: an ordinary successful consume, which slides the idle deadline
      // and rewrites the stored entry.
      expect((await consumeSessionNoEpoch('epoch-slide-token', 'epoch-slide-user')).valid).toBe(
        true,
      );

      const afterSlide = await consumeSessionFreshAuthToken(
        'epoch-slide-token',
        'epoch-slide-user',
        issuedAt + 1,
      );
      expect(afterSlide.valid).toBe(false);
      if (!afterSlide.valid) {
        expect(afterSlide.reason).toBe('expired');
      }
    });
  });
});

// ─── session invalidation closes open windows ───

describe('invalidateSessionFreshAuthTokens', () => {
  beforeEach(() => {
    _resetFreshAuthMemStoreForTests();
  });

  it('closes every open window for the named user', async () => {
    const first = await issueSessionFreshAuthToken('invalidate-me', 'password');
    const second = await issueSessionFreshAuthToken('invalidate-me', 'orcid');

    await invalidateSessionFreshAuthTokens('invalidate-me');

    for (const issued of [first, second]) {
      const result = await consumeSessionNoEpoch(issued.token, 'invalidate-me');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
      }
    }
  });

  it('leaves another account’s window alone', async () => {
    // Blast-radius pin: a sweep keyed on something other than the username (or a
    // sweep that clears the whole store) would take out unrelated sessions.
    const victim = await issueSessionFreshAuthToken('bystander', 'password');
    const target = await issueSessionFreshAuthToken('invalidate-me-too', 'password');

    await invalidateSessionFreshAuthTokens('invalidate-me-too');

    expect((await consumeSessionNoEpoch(target.token, 'invalidate-me-too')).valid).toBe(false);
    expect((await consumeSessionNoEpoch(victim.token, 'bystander')).valid).toBe(true);
  });

  it('leaves the same user’s consent-op proofs alone', async () => {
    // Deliberately scoped to the session kind. Consent-op proofs are
    // target-bound, single-use, and outlive the reset by at most their own short
    // TTL, so sweeping them would add churn without adding a guarantee.
    const consentProof = await issueFreshAuthToken('mixed-kinds', 'password', T);
    const sessionProof = await issueSessionFreshAuthToken('mixed-kinds', 'password');

    await invalidateSessionFreshAuthTokens('mixed-kinds');

    expect((await consumeSessionNoEpoch(sessionProof.token, 'mixed-kinds')).valid).toBe(false);
    expect((await consumeFreshAuthToken(consentProof.token, 'mixed-kinds', TH)).valid).toBe(true);
  });

  it('never throws when Redis fails, so a password reset cannot be turned into a 500', async () => {
    const redis = getRedis();
    if (!redis || !isRedisAvailable()) {
      await expect(invalidateSessionFreshAuthTokens('no-redis-user')).resolves.toBeUndefined();
      return;
    }
    const smembersSpy = vi
      .spyOn(redis, 'smembers')
      .mockRejectedValue(new Error('forced Redis failure during invalidation'));
    try {
      const issued = await issueSessionFreshAuthToken('redis-down-user', 'password');
      await expect(invalidateSessionFreshAuthTokens('redis-down-user')).resolves.toBeUndefined();
      // The in-memory sweep still ran even though the Redis leg failed. Reading
      // with Redis forced down is how that is observed: the canonical Redis copy
      // does survive a failed sweep, and the honest statement of the guarantee
      // is that the tier this process owns is always cleared.
      const getSpy = vi.spyOn(redis, 'get').mockRejectedValue(new Error('forced Redis-down'));
      try {
        const result = await consumeSessionNoEpoch(issued.token, 'redis-down-user');
        expect(result.valid).toBe(false);
      } finally {
        getSpy.mockRestore();
      }
    } finally {
      smembersSpy.mockRestore();
    }
  });
});

// ─── session-proof window: the per-user invalidation index ───

describe('the per-user session index stays bounded', () => {
  const INDEX_PREFIX = `${config.appTag}:fresh_auth:user_sessions:`;
  const TOKEN_PREFIX = `${config.appTag}:fresh_auth:token:`;

  beforeEach(() => {
    _resetFreshAuthMemStoreForTests();
  });

  it.skipIf(!redisAvailable)('a later mint does not push the index TTL forward', async () => {
    // The unbounded-growth mechanism this closes: with a plain EXPIRE, every
    // mint re-arms the full absolute cap, so an account that re-authenticates
    // at least once per window keeps the index key alive forever while its
    // members only accumulate. The TTL that was meant to bound the index is
    // then never reached by exactly the accounts whose index grows.
    const redis = getRedis()!;
    const username = `idx-ttl-${Date.now()}`;
    const indexKey = INDEX_PREFIX + username;
    try {
      await issueSessionFreshAuthToken(username, 'password');
      // Age the key so a re-arm would be unmistakable rather than a rounding
      // difference: a plain EXPIRE would restore the full cap.
      await redis.expire(indexKey, 60);
      await issueSessionFreshAuthToken(username, 'password');
      const ttl = await redis.ttl(indexKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      // Both windows are indexed; only the TTL is left alone.
      expect(await redis.scard(indexKey)).toBe(2);
    } finally {
      const members = await redis.smembers(indexKey);
      if (members.length > 0) await redis.del(...members.map((t) => TOKEN_PREFIX + t));
      await redis.del(indexKey);
    }
  });

  it.skipIf(!redisAvailable)('an index far past one DEL argument batch is swept in bounded batches, losing nothing', async () => {
    // The sweep used to spread every member into a single `del(...members)`.
    // Past roughly 125k members that reaches the engine argument limit and
    // throws RangeError, so the sweep BROKE rather than degrading — and it
    // broke for the accounts with the most open windows. Testing at 125k is
    // impractical; testing across several chunk boundaries pins the property
    // that matters, which is that chunking happens at all and loses nothing.
    //
    // Survivor counting alone is blind to the batch WIDTH: a sweep whose batch
    // was raised back above the member count deletes every member in one call
    // and still leaves zero survivors, which is the RangeError regression
    // walking back in unobserved. The pass-through spy below records the
    // per-call argument widths so that mutation fails here instead of passing.
    // The widths are written as literals rather than derived from the module's
    // batch constant: an expectation computed from the value under test moves
    // with it and pins nothing.
    const redis = getRedis()!;
    const username = `idx-chunk-${Date.now()}`;
    const indexKey = INDEX_PREFIX + username;
    const planted = Array.from({ length: 1201 }, (_, i) => `chunkprobe${i}`);
    try {
      await redis.sadd(indexKey, ...planted);
      // A real entry behind EVERY member. Spot-checking a few would be
      // mutation-blind: SMEMBERS returns hash order, so a sweep that processed
      // only the first batch and dropped the rest could leave any given sample
      // deleted by luck. Counting survivors across the whole set cannot.
      const pipeline = redis.pipeline();
      for (const t of planted) pipeline.set(TOKEN_PREFIX + t, '{}', 'EX', 300);
      await pipeline.exec();
      const live = await issueSessionFreshAuthToken(username, 'password');
      // 1201 planted members plus the one real window. Asserted before the
      // sweep so a stale index, or a mint whose best-effort index write did not
      // land, fails with a legible cause rather than as a mystery
      // argument-width mismatch below.
      expect(await redis.scard(indexKey)).toBe(1202);

      // Pass-through spy (no mock implementation): the real DELs still run, so
      // the survivor count below stays a real-Redis assertion. The widths are
      // read out before `mockRestore()`, which clears the recorded calls.
      const delSpy = vi.spyOn(redis, 'del');
      let delWidths: number[] = [];
      try {
        await expect(invalidateSessionFreshAuthTokens(username)).resolves.toBeUndefined();
        delWidths = delSpy.mock.calls.map((call) => (call as unknown[]).length);
      } finally {
        delSpy.mockRestore();
      }

      let survivors = 0;
      for (let i = 0; i < planted.length; i += 500) {
        survivors += await redis.exists(
          ...planted.slice(i, i + 500).map((t) => TOKEN_PREFIX + t),
        );
      }
      expect(survivors, 'every indexed window must be deleted, not just the first batch').toBe(0);
      expect(await redis.exists(indexKey)).toBe(0);
      expect(await redis.exists(TOKEN_PREFIX + live.token)).toBe(0);
      // 500 + 500 + 202 = 1202 members in three batches, then the index key's
      // own single-argument DEL. Order and length are both pinned, so this one
      // assertion carries the call count too: a widened bound collapses it to
      // two calls, a narrowed one explodes it, and a bound of 600 (which happens
      // to yield the same call count) still lands a different shape.
      expect(delWidths).toEqual([500, 500, 202, 1]);
    } finally {
      await redis.del(indexKey);
      for (let i = 0; i < planted.length; i += 500) {
        await redis.del(...planted.slice(i, i + 500).map((t) => TOKEN_PREFIX + t));
      }
    }
  });

  it.skipIf(!redisAvailable)('the DEL batch stays bounded at index sizes no fixture can plant for real', async () => {
    // Every assertion in the test above is a function of its member count, so a
    // sweep that batched only ABOVE some size threshold and kept a "one
    // round-trip" fast path below it would pass all of them while reinstating
    // the unbounded spread for exactly the accounts the batching protects: the
    // spread does not throw until roughly 125k arguments, which no fixture can
    // plant as real keys. Stubbing SMEMBERS to a synthetic index at that scale
    // and DEL to a no-op exercises the batching arithmetic there with no Redis
    // traffic and no keys to clean up.
    const redis = getRedis()!;
    const synthetic = Array.from({ length: 200_000 }, (_, i) => `scaleprobe${i}`);
    const smembersSpy = vi.spyOn(redis, 'smembers').mockResolvedValue(synthetic);
    const delSpy = vi.spyOn(redis, 'del').mockResolvedValue(0);
    let widths: number[] = [];
    try {
      await expect(
        invalidateSessionFreshAuthTokens(`scale-probe-${Date.now()}`),
      ).resolves.toBeUndefined();
      widths = delSpy.mock.calls.map((call) => (call as unknown[]).length);
    } finally {
      delSpy.mockRestore();
      smembersSpy.mockRestore();
    }
    // 400 member batches of exactly 500, plus the index key's own
    // single-argument DEL. Literals, not a recomputation from the module's batch
    // constant, which would move with the value under test. An unbounded spread
    // at this size throws inside the sweep's own catch, so it records no batches
    // at all and fails the count first.
    expect(widths.length).toBe(401);
    expect(Math.max(...widths)).toBe(500);
    expect(widths.reduce((sum, w) => sum + w, 0)).toBe(200_001);
  });

  it.skipIf(!redisAvailable)('a window found dead at consume is removed from the index', async () => {
    // Without an SREM anywhere in the module the index only ever grows for an
    // account that keeps re-authenticating. A consume that has just decided a
    // window is dead is the one moment the module knows a specific member is
    // worthless, so that is where the member is dropped.
    const redis = getRedis()!;
    const username = `idx-srem-${Date.now()}`;
    const indexKey = INDEX_PREFIX + username;
    try {
      const issued = await issueSessionFreshAuthToken(username, 'password');
      expect(await redis.scard(indexKey)).toBe(1);

      // Revoked by an epoch after the mint: the window is dead, but nothing has
      // swept it.
      const result = await consumeSessionFreshAuthToken(issued.token, username, Date.now());
      expect(result.valid).toBe(false);

      // Fire-and-forget cleanup, so poll rather than assume it landed inline.
      for (let i = 0; i < 50 && (await redis.scard(indexKey)) > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await redis.scard(indexKey)).toBe(0);
      expect(await redis.exists(TOKEN_PREFIX + issued.token)).toBe(0);
    } finally {
      const members = await redis.smembers(indexKey);
      if (members.length > 0) await redis.del(...members.map((t) => TOKEN_PREFIX + t));
      await redis.del(indexKey);
    }
  });
});
