---
title: Tests must fail when the code under test is mutated — four vacuous-pass patterns surfaced in one review pass
date: 2026-04-22
category: conventions
module: backend
problem_type: convention
component: testing
severity: high
applies_when:
  - Writing or reviewing a test that claims to prove a specific safety property (cache-key dedup, lock CAS correctness, timing oracle closure, hydration race fix)
  - A test uses a filter predicate (e.g. `mock.calls.filter(c => sql.includes('FRAGMENT'))`) to narrow the assertion surface
  - A test uses `expect(x).toBeLessThanOrEqual(N)` where `x` can legitimately be 0
  - A test uses Playwright `.first().toHaveCount(1)` or similar predicates that self-tautologize
  - A test uses `mockImplementation(...)` (not `mockImplementationOnce`) to install a blocking behavior the test is trying to detect only the first occurrence of
  - Reviewing a hold-block item that depends on a test for regression protection — the test's ability to DETECT the regression must be verified, not assumed
  - Adding a new spec to protect against a specific code-level mutation (e.g. "without this LOWER(), the dedup breaks")
tags:
  - testing
  - mutation-soundness
  - vacuous-pass
  - test-grounding
  - regression-protection
  - ce-code-review
---

# Tests must fail when the code under test is mutated — four vacuous-pass patterns surfaced in one review pass

## Context

The 2026-04-22 architect review pass over 5 tasks surfaced **four independent tests that pass today but would also pass if the code under test were reverted or broken**. The tests claim to prove specific safety properties; each one's predicate / filter / assertion shape made the proof vacuous. None would catch the regressions they exist to protect against.

The four instances, across three tasks and three reviewers, all passed initial author review, all passed backend/ui re-review-signal self-certification, and all were caught only by adversarial or testing `/ce-code-review` personas asking "what would a revert of the code do to this test?"

**Instance 1 — BE-DISCIPLINE-CANONICALIZE vacuous cache-key filter** (`backend/tests/routes/disciplines-canon-mocked.test.ts:442-446`). The test was the sole regression protection for Hold #1c (search.ts cache-key lowercasing fix). It filtered `hafQueryMock.mock.calls` to calls whose SQL contained `ts_rank`, `plainto_tsquery`, or `websearch_to_tsquery` — and asserted the filtered count was `≤ 1`. The actual search SQL uses `ILIKE` exclusively. None of the three filter tokens appear in the source. The filter always matches **zero** calls; `≤ 1` trivially passes at 0 matches. Reverting `search.ts:296`'s lowercasing — the exact regression the test exists to catch — leaves the test green.

**Instance 2 — BE-ORCID-TOCTOU-LOCK Lua CAS multi-holder correctness** (`backend/tests/routes/orcid.test.ts`). The round-2 fix replaced plain `DEL` with a Lua CAS keyed on a per-acquisition nonce — the stated primary safety property of the commit. The 8 `describe.each` specs prove: (a) self-release works when holder A calls release with its own nonce, (b) TTL auto-expiry works when PX elapses. No spec proves the **inverse**: holder A's stale nonce does NOT delete holder B's live lock. A regression reverting the Lua script to plain `DEL` passes all 8 specs. The safety property is untested.

**Instance 3 — BE-ORCID-TOCTOU-LOCK race-spec mockImplementation shape** (`orcid.test.ts:784-817`). The spec parks broadcast calls on a `broadcastGate` to force two concurrent requests to race the lock. It uses `broadcastJsonMock.mockImplementation(...)` — applies to every call. If the lock were removed entirely (the regression the spec claims to catch), both requests reach broadcast and both park on the gate; `Promise.race` waits for the first settle, neither settles, the spec times out opaquely rather than failing with a "broadcast called twice" assertion. Test timeout reads as infrastructure flake in CI logs, not as a regression signal.

**Instance 4 — FE-PAPERS-BROWSE Playwright `toHaveCount(1)` on `.first()`** (`frontend/tests/e2e/papers-browse.spec.js:50`). `.first()` already scopes the locator to a single element; `.toHaveCount(1)` on a `.first()` locator is tautological — the wait resolves as soon as ≥ 1 element matches, regardless of how many total exist. The task spec explicitly preferred `toBeVisible()` (Option A). The tautological predicate compounds with a 30-second timeout on empty corpus (no disciplines tagged), producing opaque timeouts that hide whether the race is fixed.

The pattern binds together: **author writes a test that reads like proof of a property; reviewer accepts at shape-level; the predicate silently admits the regression case through a filter-matches-nothing or scope-already-narrowed-to-1 hole.**

## Guidance

**Rule: every test added to protect a specific code-level safety property MUST be verified to fail when that property is reverted. Writing the test without running it against the mutated code is how vacuous-pass tests ship.**

The verification is cheap — usually a one-line revert + `npx vitest run <file>` (or `npx playwright test <spec>`). The cost of skipping it is hidden: a green test suite that silently lets the regression ship. The cost shows up later, when the regression lands in production and the "we have a test for that" claim turns out to be false.

The four instances above all share the same skipped step: **the author did not run the test against the broken code.** If any of them had, the vacuous-pass would have surfaced immediately.

The concrete verification step for each of the four patterns:

### 1. Filter-predicate tests

If a test asserts on a filtered subset of mock calls — e.g. `mock.calls.filter(c => sql.includes('FRAGMENT'))` — grep the production code for `FRAGMENT` and confirm it actually appears. If it doesn't, the filter is broken and the assertion is vacuous.

```js
// WRONG: filter matches zero calls; any assertion on `searchCalls.length` is vacuous.
const searchCalls = hafQueryMock.mock.calls.filter((call) => {
  const sql = String(call[0] || '');
  return sql.includes('ts_rank') || sql.includes('plainto_tsquery');  // ← not in source
});
expect(searchCalls.length).toBeLessThanOrEqual(1);

// CORRECT: verify the filter fragment is actually in the code under test.
const searchCalls = hafQueryMock.mock.calls.filter((call) => {
  const sql = String(call[0] || '');
  return sql.includes('ILIKE');  // ← grep-confirmed in search.ts
});
expect(searchCalls.length).toBe(1);  // ← not ≤ 1; exactly 1 is the claim
```

Combine with: prefer `.toBe(N)` over `.toBeLessThanOrEqual(N)` when the spec proves "exactly N" — the latter passes at 0 and cannot distinguish "zero calls" from "one call."

### 2. Inverse-path correctness tests

When a safety property is "operation X has no effect on input Y" (e.g. "release with wrong nonce doesn't delete the lock"), the test MUST exercise the inverse path with a concrete counterexample. Self-release + TTL-expiry tests do not prove CAS correctness; a test that calls release with a foreign nonce and asserts the lock is intact is the only proof.

```js
// Example: prove Lua CAS refuses to delete when nonce doesn't match.
// Pre-seed the lock with a foreign nonce, call release with a stale nonce,
// assert the lock is still intact. This is the EXACT scenario RELEASE_LOCK_LUA
// was written for; without this test, the CAS is asserted only by code review.

it('release is a no-op when the caller nonce does not match the stored lock', async () => {
  const lockKey = `${appTag}:orcid_binding_lock:${orcidId}`;
  await redis.set(lockKey, 'nonce-B', 'EX', 35);  // foreign holder

  await releaseBindingLock(orcidId, 'nonce-A');  // stale nonce

  expect(await redis.get(lockKey)).toBe('nonce-B');  // foreign lock survives
});
```

### 3. Mock shape vs. detection target

When a test installs a mock to force a specific interleaving, the mock's shape must allow the regression case to be detected. `mockImplementation(...)` applies to every call; `mockImplementationOnce(...)` applies to the first only.

If the test wants to catch "second call happened when it shouldn't have," use `mockImplementationOnce` for the first (parked/gated behavior) and a default resolver for subsequent calls — so the second call's call count increments the mock and an assertion can fire.

```js
// WRONG: every broadcast parks on the gate. If lock is removed and both
// requests reach broadcast, Promise.race waits for neither, test hangs.
broadcastJsonMock.mockImplementation(() => broadcastGate);

// CORRECT: first call parks; subsequent calls resolve immediately and bump
// the mock's call count. If lock is removed, both requests reach broadcast,
// the second returns immediately, the assertion fails loudly.
broadcastJsonMock
  .mockImplementationOnce(() => broadcastGate)
  .mockResolvedValue(/* result shape */);

// ...after the race resolves...
expect(broadcastJsonMock).toHaveBeenCalledTimes(1);  // tightens the proof
```

### 4. Playwright locator scoping vs. assertion shape

`.first()` already narrows to a single-element view; `.toHaveCount(N)` on a `.first()` locator is tautological (matches 1 iff ≥ 1 element exists). Use the assertion that matches intent:

```js
// WRONG: tautological; passes as soon as ≥ 1 option exists, hides empty-corpus timeout.
const firstRealOption = selectLocator.locator('option:not([value=""])').first();
await expect(firstRealOption).toHaveCount(1);

// CORRECT (Option A per task spec): wait for visibility of the first real option.
// Matches the Playwright auto-wait semantic the test actually needs.
const firstRealOption = selectLocator.locator('option:not([value=""])').first();
await expect(firstRealOption).toBeVisible();

// ALTERNATIVE: if the test genuinely wants "exactly N options," drop .first()
// and assert on the unnarrowed locator.
const realOptions = selectLocator.locator('option:not([value=""])');
await expect(realOptions).toHaveCount(3);  // meaningful
```

## Why This Matters

A test that cannot fail when its safety property is broken is **worse than no test**: it creates false confidence. Reviewers reading the test name ("Hold #1c cache-key fix — case variants share a cache entry") trust that a regression would surface; under a vacuous-pass test, the regression ships green.

The four instances in this review pass all had reviewers flagging them only because the `/ce-code-review` skill's adversarial + testing personas explicitly ask "would a revert fail this test?" That question is cheap; running the actual revert is cheaper still. Skipping the step is how every one of these shipped from author → self-certify → initial review without catching the vacuity.

**The cost of a vacuous-pass test compounds over time.** It lives in the suite. It gets counted in "N tests pass." It anchors future reviewers' trust in the suite's regression coverage. When the regression it nominally protects against eventually lands — because the author was confident the test would catch it — the debugging trail has to work backward from production to the test, realize the test was always green, and reconstruct why. That's a multi-hour incident for a check that should have taken 30 seconds at test-authorship time.

The review pass that surfaced these was unusually high-yield because it used adversarial personas against a batch of hold-block-driven test additions — tests specifically written to protect specific properties. That context (test is load-bearing) is exactly when vacuous-pass is most costly, so the detection rate was high. But the pattern is not limited to hold-block tests; it appears anywhere a test is written to prove a specific property.

## When to Apply

1. **On every new spec that claims to protect a specific code-level property.** Before the PR, the author locally reverts the property (the single commit / LOC that the test is about) and runs the spec. If it passes, the spec is vacuous and must be fixed.

2. **On every hold-block item that asks for "add a test for X."** The implementer MUST run the mutation-verification step. The re-review signal should explicitly state "confirmed the spec fails on revert of <specific change>" so the architect doesn't have to re-verify from scratch.

3. **On any `/ce-code-review` pass touching test files.** The adversarial + testing personas should explicitly ask "would a revert of the code under test fail this test?" as a checklist item. This convention adds the check to the architect's review surface.

4. **On tests using filter predicates.** Any `mock.calls.filter(...)`, `mock.calls.find(...)`, or similar narrowing should grep-verify the filter fragment is actually in the production code before trusting the narrowed assertion.

5. **On tests using `toBeLessThanOrEqual` / `toBeGreaterThanOrEqual` where "exactly N" is the claim.** If the test proves "exactly one call," use `toBe(1)`, not `toBeLessThanOrEqual(1)` — the latter passes at 0.

6. **On Playwright `.first()` combined with any count-assertion.** `toHaveCount(1)` on `.first()` is tautological; if the assertion is about the element's state, use `.toBeVisible()` / `.toBeAttached()`. If it's about how many elements exist, drop `.first()`.

7. **On tests using `mockImplementation` (not `Once`) where the test's failure mode depends on detecting a second call that shouldn't happen.** The mock must allow the unwanted second call to be observable.

## Examples

### Example 1: Filter-predicate vacuity (disciplines-canon-mocked.test.ts)

**Before (vacuous):**

```js
// Hold #1c: prove two case-variant ?discipline= requests share a single cache entry.
it('case-variant discipline param serves from one cache entry', async () => {
  await request(app).get('/api/search?discipline=Physics');
  await request(app).get('/api/search?discipline=physics');

  const searchCalls = hafQueryMock.mock.calls.filter((call) => {
    const sql = String(call[0] || '');
    return sql.includes('ts_rank')
      || sql.includes('plainto_tsquery')
      || sql.includes('websearch_to_tsquery');
  });
  expect(searchCalls.length).toBeLessThanOrEqual(1);
});
```

**After (grounded):**

```js
it('case-variant discipline param serves from one cache entry', async () => {
  await request(app).get('/api/search?discipline=Physics');
  await request(app).get('/api/search?discipline=physics');

  // Filter fragment `ILIKE` confirmed present in searchPapersFromHaf at
  // search.ts:89, 93, 174. A revert of the search.ts:296 cache-key
  // lowercasing produces two distinct cache keys → two SQL invocations.
  const searchCalls = hafQueryMock.mock.calls.filter((call) => {
    const sql = String(call[0] || '');
    return sql.includes('ILIKE');
  });
  expect(searchCalls.length).toBe(1);  // exact, not ≤
});
```

**Verification step:** revert `search.ts:296` to `const rawKey = '...:d=' + (discipline || '') + ':...';` (drop `.toLowerCase()`), run the spec, confirm it fails. Restore the fix, confirm it passes.

### Example 2: Inverse-path CAS correctness (orcid.test.ts)

**Before (no direct CAS test):**

The 8 `describe.each` specs cover self-release and TTL expiry. No spec exercises the foreign-nonce release path that `RELEASE_LOCK_LUA` was written for. Plain-DEL regression passes all 8.

**After (add the direct inverse-path spec):**

```js
it('releaseBindingLock is a no-op when the caller nonce does not match the stored lock', async () => {
  const orcidId = '0000-0001-0000-0001';
  const lockKey = `${appTag}:orcid_binding_lock:${orcidId}`;

  // Seed a foreign holder's lock.
  await redis.set(lockKey, 'nonce-B-live-holder', 'EX', 35);

  // Call release with a stale nonce. This is the exact lock-stomp scenario
  // RELEASE_LOCK_LUA closes: holder A's TTL expired, B acquired a fresh lock,
  // A's finally runs DEL — but CAS should refuse because A's nonce no longer
  // matches the stored value.
  await releaseBindingLock(orcidId, 'nonce-A-expired');

  expect(await redis.get(lockKey)).toBe('nonce-B-live-holder');
});
```

**Verification step:** revert `RELEASE_LOCK_LUA` from the CAS script to a plain `redis.call('del', KEYS[1])`, run the spec, confirm it fails with `null` (lock was stomped). Restore the CAS, confirm it passes.

### Example 3: Mock shape vs. detection target (orcid.test.ts race-spec)

**Before (vacuous under lock-absence):**

```js
let broadcastGate;
broadcastJsonMock.mockImplementation(() => broadcastGate);

const alicePromise = request(app).post('/api/orcid/callback').send({ /* ... */ });
const bobPromise = request(app).post('/api/orcid/callback').send({ /* ... */ });

const loserResponse = await Promise.race([alicePromise, bobPromise]);
expect(loserResponse.status).toBe(409);
// ... release the gate, etc.
```

**After (fails loudly under lock-absence):**

```js
let broadcastGate;
broadcastJsonMock
  .mockImplementationOnce(() => broadcastGate)
  .mockResolvedValue({ id: 'tx-that-should-never-run' });

const alicePromise = request(app).post('/api/orcid/callback').send({ /* ... */ });
const bobPromise = request(app).post('/api/orcid/callback').send({ /* ... */ });

const loserResponse = await Promise.race([alicePromise, bobPromise]);
expect(loserResponse.status).toBe(409);

// If the lock were removed, Bob would reach broadcast, mockResolvedValue
// would fire, the call count would increment, and this assertion would fail.
expect(broadcastJsonMock).toHaveBeenCalledTimes(1);
```

**Verification step:** comment out the lock-acquisition in `withOrcidBindingLock`, run the spec, confirm it fails at `toHaveBeenCalledTimes(1)`. Restore the lock, confirm it passes.

### Example 4: Playwright locator tautology (papers-browse.spec.js)

**Before (tautological + opaque timeout on empty corpus):**

```js
const firstRealOption = disciplineSelect.locator('option:not([value=""])').first();
await expect(firstRealOption).toHaveCount(1);
const firstDiscipline = await firstRealOption.getAttribute('value');
expect(firstDiscipline).toBeTruthy();
```

**After (intent-matching assertion):**

```js
// Preflight: skip when no disciplines are tagged in the corpus, so the
// spec fails readably rather than timing out at 30s.
const disciplinesResp = await page.request.get(`${baseURL}/api/disciplines`);
const disciplinesBody = await disciplinesResp.json();
if (!disciplinesBody.data?.length) {
  test.skip(true, 'No disciplines in HAF corpus; hydration spec is vacuous.');
}

const firstRealOption = disciplineSelect.locator('option:not([value=""])').first();
await expect(firstRealOption).toBeVisible();  // intent-matching auto-wait
const firstDiscipline = await firstRealOption.getAttribute('value');
expect(firstDiscipline).toBeTruthy();
```

**Verification step:** locally set `d.canon_name` to `undefined` in the paper-feed x-for binding (simulating the pre-fix contract-drift bug), run the spec, confirm it fails at `toBeVisible()`. Restore, confirm it passes.

## Related

- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — closest thematic cousin. That doc covers test-infrastructure false-greens where an `expect().toHaveBeenCalled()` assertion passes but the mock's call shape was not meaningfully asserted. This doc generalizes to the broader class of "test that cannot fail when the property under test is broken" — the mock-shape gap is one instance; filter-predicate gaps, assertion-shape gaps, and Playwright-locator-scoping gaps are others.
- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — this doc's sibling for security fixes. Both address the meta-pattern "fix looks complete until you ask 'what would a revert do?'" — in the timing doc, the question is about the code; in this doc, the question is about the test that claims to prove the code correct.
- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — shares the "fix in isolation, miss the sibling sites" pattern. Complementary: that doc is about the production code; this doc is about the test.
- **`/ce-code-review` skill integration:** the adversarial and testing personas should include "mutation-verification" as a standing checklist item for any new spec that claims to protect a specific property. The check is one-sentence prose: "confirm the spec fails when the code under test is reverted." Per-finding evidence in the review: the reviewer runs the revert locally OR flags the spec as load-bearing-but-unverified, deferring mutation-verification to the implementer.
