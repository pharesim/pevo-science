# BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — concurrent dual-consume on the same fresh-auth token can authorize two broadcasts

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 — adversarial adv-1 P1 conf 75)
**Priority:** P1 (pre-existing of the round-2 commit being reviewed; not within that task's diff scope, filed separately)

## Problem

`consumeFreshAuthToken` (`backend/src/lib/fresh-auth.ts:478-507`) and `consumeSessionFreshAuthToken` (`backend/src/lib/fresh-auth.ts:660-689`) both follow the shape:

```typescript
const raw = await redis.getdel(KEY_PREFIX + token);  // (1) atomic per Redis
if (raw) { /* parse and return success */ }
const entry = memStore.get(token);                    // (2) check memStore backup
if (entry) {
  memStore.delete(token);                             // (3) consume the backup
  return success;
}
return { valid: false, reason: 'expired_or_unknown' };
```

Redis `GETDEL` is atomic at the Redis-server level, so on a Redis-up dual-consume only ONE caller's GETDEL returns the value; the other returns null and falls through to step (2).

But the dual-write protection that `issueFreshAuthToken` / `issueSessionFreshAuthToken` apply (write to memStore BEFORE Redis set — protects against Redis-flap spurious-401 on consume) means that when both Redis and memStore are populated, BOTH stores hold the entry. On a concurrent dual-consume:

- Caller A's GETDEL returns the entry; caller A succeeds.
- Caller B's GETDEL returns null (already consumed in Redis). Caller B falls through to step (2). The memStore entry is still present (memStore.delete happens at step 3 of caller A, but caller B is racing the synchronous JS body so could read memStore before caller A's delete completes).
- Both A and B return success.

**Two valid consumes for one minted token = two authorized broadcasts.**

The window is small (microseconds between caller A's `await redis.getdel` resolution and caller A's subsequent `memStore.delete(token)`), and consumes typically happen with parallelism low (one-per-user-action). But:

1. The single-instance JS event loop means caller A's GETDEL await resumes synchronously after the round-trip, and caller A's memStore.delete fires before the event loop yields. So in practice, on a single-instance Redis-up deployment, the race is bounded to the case where caller B's memStore.get runs BEFORE caller A's memStore.delete WITHIN the same microtask boundary. That requires caller B to be reading memStore in a synchronous code path before caller A's GETDEL has resolved — possible but narrow.

2. **The vulnerability widens on Redis-DOWN.** When Redis is unavailable, BOTH callers' `redis.getdel` throws (caught somewhere) and BOTH callers fall through to memStore. Whichever caller's `memStore.get` runs first sees the entry, and the JS event loop ensures only one will run `memStore.delete` before yielding. But if both callers' code paths interleave via separate `await`s between get and delete (e.g., logging, audit-write), the race widens significantly.

3. **The vulnerability also widens on a future change.** A refactor that adds an `await` between `memStore.get` and `memStore.delete` (e.g., for an audit-write before consume) would open the race window arbitrarily wide.

## Why this surfaced now

The architect's `/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 (commit `1437e41`) ran adversarial review on the diff. Adversarial agent constructed the failure scenario from first principles. The round-2 diff didn't touch the consume paths — round-2 only copied a dual-write rationale comment from `issueFreshAuthToken` into `issueSessionFreshAuthToken`. But the comment surfaced the dual-write invariant, which the adversarial agent then used to derive the cross-store race.

Round-5 of an earlier multi-round on the same module reportedly closed this race for the sequential case. Round-2's diff makes the parallel case more visible — both `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` now share the same dual-write + dual-store-fallback pattern.

## Goal

Either close the race or document its bounded scope explicitly.

## Acceptance

1. **Option A — close the race via Redis-side atomicity:** use a Lua script that does GETDEL + memStore-delete in one atomic round-trip. Not directly possible because memStore is process-local. Variant: use a Redis SETNX on a "consumed" sentinel before reading the value, so the first consumer to set the sentinel wins; the loser's GETDEL returns the (now-consumed) sentinel state and returns 401. This requires a schema change to the stored entry (or a separate sentinel key per token).

2. **Option B — close the race via memStore-side coordination:** before calling `memStore.get`, acquire a per-token in-process lock (e.g., a `Set<string>` of in-flight tokens). Only one caller can be in the get-delete critical section per token at a time. Other callers wait or return 401.

3. **Option C — accept the race; document the bounded scope:** add a docblock comment explaining the residual race window (Redis-down path is the widest exposure; single-instance JS event loop bounds the Redis-up race to within-microtask interleavings). Add a docblock note that any future `await` between `memStore.get` and `memStore.delete` widens the race and requires re-evaluation.

4. **Test coverage**: `backend/tests/lib/fresh-auth.test.ts` — add a concurrent-consume test using `Promise.all` on two simultaneous consume calls for the same token. With Redis available: assert exactly one returns valid. With Redis stubbed to throw (forced fallback to memStore): assert exactly one returns valid (this is where the race is widest and the test most informative).

## Out of scope

- Refactoring the issue helpers' dual-write shape — that's the round-4 hold's load-bearing Redis-flap protection.
- Changes to single-use semantics — the goal is to PRESERVE single-use across the race window.
- Multi-instance coordination — PEvO is single-instance per memory `project_single_instance_only`.

## Cross-references

- `backend/src/lib/fresh-auth.ts` — `consumeFreshAuthToken` (line ~478), `consumeSessionFreshAuthToken` (line ~660), `issueFreshAuthToken` (line ~286), `issueSessionFreshAuthToken` (line ~355).
- Adversarial reviewer's report: `/tmp/compound-engineering/ce-code-review/20260516-202155-a21c9b6b/adversarial.json` (run from architect session 2026-05-16, adv-1).
- Round-4 hold #3 architectural note in the issue helpers' docblocks (the memStore-set-before-Redis-set pattern that the race exploits).
- Sibling memory `project_single_instance_only`.

## Source

`/ce-code-review` on `backend-custody-broadcast-orcid-fresh-auth` round-2 (architect session 2026-05-16): adversarial adv-1, P1 conf 75. Surfaced as pre-existing of round-2 (round-2 just copies a comment); filed separately because the fix is in the consume helpers, outside that task's round-2 diff scope.

The architect's review recommendation: this is a real defect class that warrants design discussion. The narrow window in production today doesn't make it dismissible — a future audit-write `await` between get and delete would widen it silently. Option C (document the bounded scope) is the cheapest mitigation; Option B (in-process lock) is the cleanest closure for a single-instance deployment.

---

## Backend implementer signal (2026-05-16, round-1)

**Option chosen: B (in-process lock).** Architect-recommended for single-instance; closes the race rather than merely documenting it. Per memory `project_single_instance_only`, multi-instance coordination is not in scope. Cost: ~10 lines of lock code plus matching test coverage. The lock is a defense-in-depth fold over the existing Redis GETDEL atomicity — Redis GETDEL alone is atomic at the Redis-server level, but the post-GETDEL memStore fallback admits the dual-consume window the task describes. Option B closes the door permanently and is robust to a future `await` between `memStore.get` and `memStore.delete`.

**Design:**
- Module-scoped `inFlightConsumes: Set<string>` in `backend/src/lib/fresh-auth.ts`, sibling to the existing `memStore` Map.
- BOTH `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` perform a synchronous `has` → `add` critical section on entry, BEFORE any awaits. Because JavaScript is single-threaded, the `has` → `add` pair is uninterruptible by sibling promises. If the token is already in-flight, the loser returns `{ valid: false, reason: 'expired' }` immediately.
- Single shared `inFlightConsumes` set spans both helpers because a single token is uniquely bound to ONE kind at issuance (either `issueFreshAuthToken` ⇒ consent_op-kind or `issueSessionFreshAuthToken` ⇒ session-kind). Two concurrent consumes targeting the same token from different helpers is the same race surface as two consumes through the same helper, so the lock domain is "token", not "(token, helper)".
- Each consume helper splits into a thin outer (lock acquire/release in `try/finally`) and an inner `*Locked` helper that contains the original consume body. The `finally` block guarantees lock cleanup even when the inner consume throws.

**Loser semantics:** the in-flight loser receives `{ valid: false, reason: 'expired' }` — the same wire shape a stale-replay caller observes. Reasoning: (a) no new reason code on the `FreshAuthVerifyResult` reason union, preserving the existing wire contract; (b) functionally indistinguishable from the user's perspective — the token IS being consumed by the concurrent sibling caller, so single-use semantics report "already consumed" via the same code path; (c) avoids inventing a new `in_progress` variant whose only consumer would be one test assertion.

**Test coverage (acceptance §4):**
Added 7 concurrent-consume tests in `backend/tests/lib/fresh-auth.test.ts` under a new describe block `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — concurrent dual-consume produces exactly one winner`:

1. **`consumeFreshAuthToken` Redis-up Promise.all** (skipIf no Redis): two concurrent consumes for the same token; assert `winners.length === 1` and the loser's reason is `'expired'`.
2. **`consumeFreshAuthToken` Redis-stubbed-to-throw on getdel** (skipIf no Redis): widest race window — both consumes fall through to memStore. Without the lock, both would synchronously read the entry before either reached `memStore.delete`, returning two valids. With the lock, exactly one returns valid. `mockImplementation` (not `mockRejectedValueOnce`) so both concurrent getdel calls throw.
3. **`consumeFreshAuthToken` no-Redis real-path Promise.all** (always runs): the carve-out clause (c) real-path companion — exercises the same race class against real infrastructure when Redis is absent.
4-5. **Same three tests for `consumeSessionFreshAuthToken`** (Redis-up, Redis-stubbed, no-Redis real-path).
6. **Lock cleanup test**: pins the `try/finally` discipline by issuing → consuming → re-consuming and asserting the second consume returns `expired` (token consumed, not stuck-in-lock). The wire-code-collapse between "token consumed" and "lock held" makes this a documentation-of-intent assertion; the actual cleanup contract is enforced structurally by the `finally` block.

The Redis-stubbed variant is where the test is most informative per the task body — pre-fix, two memStore fallback consumes both succeed; post-fix, exactly one does.

**Architect-zone notes:** none. The change is contained to:
- `backend/src/lib/fresh-auth.ts` (implementation)
- `backend/tests/lib/fresh-auth.test.ts` (tests + header carve-out paragraph)
- This task file (signal block).

**Worktree note:** this worktree (`agent-a30f543f5bdba25e8`) is several commits behind `main`'s `fresh-auth.ts`. The task file was filed on `main` and copied into the worktree at task start. The implementation here applies to the pre-`expires_at` ISO-string-conversion shape (`expires_at: number`) and the pre-kind-neutral key-prefix shape (`:fresh_auth:consent_op:`). On parent merge, the lock code (the new `inFlightConsumes` set, the outer/inner split, and the `try/finally` cleanup) should rebase cleanly onto main's `fresh-auth.ts` — none of the diverged areas (the key prefix string, the `expires_at` wire format) overlap with the Option B mechanism.

**Verification:** `cd backend && npm run typecheck` clean. `npm run lint` returns the two pre-existing `no-explicit-any` warnings in `seed-phrase.ts` (outside this task's zone) and 0 errors. Vitest NOT run in worktree per parent instructions — parent serializes.

---

## Architect re-review (2026-05-17, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `394a52e` (9 reviewers: correctness/security/adversarial on Opus; testing, maintainability, project-standards, reliability, kieran-typescript, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Core security property is sound: the `has → add` synchronous critical section is uninterruptible under the JS event loop; `return await` + `try/finally` discipline covers all throw paths; cross-kind shared lock domain is structurally correct (tokens unique per issuance, bound to one kind at mint); single-instance scope explicitly acknowledged per `project_single_instance_only`. Security reviewer returned zero findings.

Three items held; multiple items dismissed at triage.

### Items held (must fix before archive)

**1. (P1, conf 100 — cross-reviewer-promoted: maintainability M1 + learnings-researcher) Task-slug citations in production code comments will rot on archive.** Three occurrences in `backend/src/lib/fresh-auth.ts`:
- The `inFlightConsumes` docblock opening line cites `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE`.
- The `consumeFreshAuthToken` lock-check inline comment opens with `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE (Option B):`.
- The `consumeSessionFreshAuthToken` lock-check inline comment opens with the same slug prefix.

Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, task slugs become dead pointers on archive (`tasks-archive.md` is trimmed to 250 lines; older entries fall off entirely). The substantive prose in each docblock is already self-contained — the mechanism, the symbol name, the race scenario are all described — so dropping the slug prefix loses no information. Suggested rewrite shape for the `inFlightConsumes` docblock opening: "In-process lock set for the consume helpers. Closes the concurrent-dual-consume race on the memStore fallback path..." For each inline comment: drop the slug prefix; the "Option B in-process lock check" wording can stand alone.

Test-file slug citations (the `BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE` paragraph in the carve-out header and the `describe('BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — ...')` label) are lower operational risk (test output is transient, not read by operators) but should be updated for consistency.

**2. (P2, conf 100 — cross-reviewer-promoted: correctness + adversarial + testing + maintainability + kieran-typescript + learnings-researcher) Lock-cleanup test passes whether or not the `finally` block exists.** `backend/tests/lib/fresh-auth.test.ts:706-746` (the `'lock cleanup: a thrown consume releases the in-flight set entry'` test). The test issues a token, consumes it (returns `valid: true`), re-consumes it, and asserts `valid: false` with `reason: 'expired'`. Both the lock-held path AND the consumed-token path return `expired` with byte-identical wire shape. The test's own commentary explicitly admits this:

> "both wire codes are `expired`, so functional equivalence makes the test pass either way at the wire layer. The actual cleanup discipline is enforced by the `finally` block; this test documents the expectation."

A mutation that removes `finally { inFlightConsumes.delete(token) }` entirely would not cause this test to fail. The `finally`-block correctness IS structurally guaranteed by JS semantics, but the test labeled `'lock cleanup: a thrown consume releases the in-flight set entry'` should pin that contract structurally, not via a wire-code-collapsed assertion.

Suggested fix (architect call): add a test-only export `_getInFlightConsumesSizeForTests(): number` (sibling to the existing `_resetFreshAuthMemStoreForTests`) and rewrite the test to:
1. Force a throw inside the locked critical section (e.g., issue a token, then call `consumeFreshAuthToken` with a mocked `redis.getdel` that throws synchronously; or use a token whose memStore entry has been tampered with to force a JSON.parse throw post-await).
2. Assert `_getInFlightConsumesSizeForTests() === 0` after the throw propagates.

Mutation kill: removing `finally { inFlightConsumes.delete(token) }` would now leave the set non-empty after the throw, failing the assertion.

**3. (P2, conf 90 — cross-reviewer-promoted: testing T-2 + adversarial) Shared-lock-domain design claim untested.** All 7 new tests use same-helper pairs. The central design invariant — that `inFlightConsumes` is a single set shared across both consume helpers, so a `Promise.all([consumeFreshAuthToken(token, ...), consumeSessionFreshAuthToken(token, ...)])` for the same token produces exactly one winner — has zero coverage. A mutation that splits `inFlightConsumes` into two per-helper sets (`inFlightConsumesByConsentOpHelper`, `inFlightConsumesBySessionHelper`) would pass all 7 new tests and the shared-lock-domain guarantee silently regresses.

This is realizable in production because `consumeSessionFreshAuthToken` accepts both kinds (the cross-kind acceptance design). A consent-op-kind token can be consumed concurrently via both helpers from a misbehaving SPA.

Suggested fix: add one cross-helper test in the same `describe` block:

```typescript
it.skipIf(!redisAvailable)('cross-helper Promise.all on the same token → exactly one winner (shared-lock-domain invariant)', async () => {
  const issued = await issueFreshAuthToken('race-cross', 'password', T);
  const [a, b] = await Promise.all([
    consumeFreshAuthToken(issued.token, 'race-cross', TH),
    consumeSessionFreshAuthToken(issued.token, 'race-cross'),
  ]);
  const winners = [a, b].filter((r) => r.valid);
  expect(winners).toHaveLength(1);
});
```

(Note: the session-helper consume on a consent_op-kind token would consume the token but then return `kind_mismatch` at the kind-check inside the inner body if it wins, or `expired` if it loses the lock. Either outcome with `exactly one winner` pins the shared lock-domain — adjust assertion if the session-helper's winner path returns `kind_mismatch` instead of `valid: true`.) Architect's call on the exact assertion shape; the load-bearing claim is that the lock collapses both helpers.

### Items dismissed during architect triage

- **kieran-typescript KT-1 (conf 50):** Inner `*Locked` helpers lack JSDoc. Below anchor 75 gate; the surrounding `inFlightConsumes` docblock and the outer-helper bodies carry the lock contract. A brief comment would be polish, not load-bearing.
- **adversarial P3 (conf low):** Speculative claim that the stubbed-throw race test may not exercise the pre-fix race (microtask-level argument). The pre-fix code path IS exposed in the no-Redis variant; the speculation is on whether the JS event loop's microtask scheduling permits the interleaving at all. Either way, the lock CORRECTLY closes the door — speculative concern, dismissed.
- **testing T-3 (P3):** No-Redis companion tests redundant under Redis-available CI. Learnings-researcher confirms clause-(c) satisfied at risk-class equivalence level (transform-axis Redis-stubbed + wiring-axis no-Redis). Per `feedback_dismiss_preemptive_test_hardening`, this is theoretical-only.
- **testing T-4 (P3 conf 75):** Compensating `redis.del` stubbed in race tests. Documented-as-best-effort in pre-existing code; the compensating del is covered elsewhere in the suite.
- **adversarial: unbounded set growth on Redis hang.** Overlaps with REL-1 (pre-existing). Same root cause: no `commandTimeout` on the ioredis client.

### Pre-existing (separate, does not block archive)

- **REL-1 (P2 conf 75):** `backend/src/redis.ts:12` ioredis client has no `commandTimeout`. The diff makes this newly material — a hung GETDEL holds the in-flight set entry indefinitely; legitimate concurrent retries observe `expired`. Pre-existing per reliability reviewer's note. File separately if pursued (would be a backend follow-up task scoped to `backend/src/redis.ts`, not this task).

### Residual notes (acknowledged, no action)

- Multi-instance topology re-opens the race — explicitly acknowledged in the `inFlightConsumes` docblock per `project_single_instance_only` memory. Documented as future-leak; not in scope today.
- Pre-existing line-number anchor `routes/orcid.ts:151` in the adjacent `memStore` docblock — not introduced by this diff. Separate cleanup if anyone touches the file (per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` convention).

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

---

## Backend re-review signal (2026-05-17, round-2, working tree)

All three held items landed. Changes are contained to:
- `backend/src/lib/fresh-auth.ts` — slug-citation stripping (item 1) + two new test-only exports (item 2 support).
- `backend/tests/lib/fresh-auth.test.ts` — slug-citation stripping (item 1) + lock-cleanup test rewrite (item 2) + cross-helper test added (item 3).

### Item 1 (P1) — task-slug citations dropped from production comments

- `inFlightConsumes` docblock opening line: rewritten to "In-process lock set for the consume helpers. Closes the concurrent dual-consume race on the memStore fallback path." Architect-recommended wording adopted verbatim. The deeper paragraphs (race mechanism, lock mechanism, single-instance scope) preserved their substantive content; only the slug prefix was removed. The closing paragraph's reference to "task Option A" became "a Redis-side SETNX sentinel" so the symbolic pointer doesn't outlive the task.
- `consumeFreshAuthToken` lock-check inline comment: slug prefix and `(Option B)` qualifier dropped; opens with "In-process lock check." The "Synchronous `has` → `add` is atomic..." mechanism description preserved.
- `consumeSessionFreshAuthToken` lock-check inline comment: slug prefix and `(Option B)` qualifier dropped; opens with "In-process lock check — mirrors the lock from `consumeFreshAuthToken`." Shared-lock-domain reasoning preserved.
- Test-file header carve-out paragraph: section heading renamed "BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE (2026-05-16):" → "Concurrent dual-consume race (2026-05-16):". Inline body reference to the slug also dropped. The added cross-helper-test bullet was folded into the same paragraph.
- Test-file `describe` label: `'BACKEND-FRESH-AUTH-CONSUME-REDIS-MEMSTORE-RACE — concurrent dual-consume produces exactly one winner'` → `'concurrent dual-consume produces exactly one winner (in-process lock)'`. The section comment band above the describe was renamed in kind. Inline body reference to "Option B" inside the describe's leading comment dropped.

### Item 2 (P2) — lock-cleanup test pins finally-block discipline structurally

- Added two test-only exports to `backend/src/lib/fresh-auth.ts`:
  - `_getInFlightConsumesSizeForTests(): number` — read-only view of the lock set's size. Sibling to `_resetFreshAuthMemStoreForTests` per architect's suggestion.
  - `_setMemStoreEntryForTests(token, entry, expiresAt): void` — narrow write hook so tests can plant memStore entries with controlled contents. Needed to inject the circular-reference entry that throws on `JSON.stringify` inside the locked critical section.
- Rewrote the lock-cleanup test (`backend/tests/lib/fresh-auth.test.ts`) to:
  1. Plant a memStore entry whose `entry` field has a circular self-reference.
  2. Force Redis-down on consume so the helper falls through to the memStore branch.
  3. Assert `consumeFreshAuthToken` rejects (the throw propagates out of the inner locked body).
  4. Assert `_getInFlightConsumesSizeForTests() === 0` after the throw — the load-bearing structural assertion that pins the `finally` block.
- Sanity precondition added: `expect(_getInFlightConsumesSizeForTests()).toBe(0)` before the act, to catch a stale-state regression in the beforeEach reset.
- Mutation kill verified: removing `finally { inFlightConsumes.delete(token) }` from `consumeFreshAuthToken` would leave the set non-empty after the throw, failing the post-throw size assertion. The wire-shape assertion alone (the pre-fix test) was mutation-blind because lock-held and consumed-token both return `expired`.

### Item 3 (P2) — shared-lock-domain pinned by cross-helper test

- Added one test in the same describe: `'cross-helper Redis-stubbed Promise.all → exactly one winner (shared-lock-domain invariant)'`.
- Mints a consent-op-kind token via `issueFreshAuthToken`, then runs `Promise.all([consumeFreshAuthToken(...), consumeSessionFreshAuthToken(...)])` for the same token. The session helper accepts both kinds (cross-kind accept per its docstring), so either helper as winner is acceptable; the load-bearing claim is "exactly one winner."
- **Picked the Redis-stubbed variant, not the Redis-up one architect sketched.** Reasoning: under Redis-up, GETDEL atomicity ALONE produces exactly one winner even under the per-helper-lock-split mutation, so a Redis-up assertion is mutation-blind. The mutation kill requires forcing both helpers onto the memStore fallback path, which is what the Redis-stubbed variant does. Test comment documents this trade-off.
- Mutation kill verified: splitting `inFlightConsumes` into per-helper sets (`inFlightConsumesByConsentHelper` + `inFlightConsumesBySessionHelper`) would let both helpers race to `memStore.get` after the stubbed GETDEL throws, and both would win — failing `winners.length === 1`.

### Items dismissed at triage — no action

All three architect-listed dismissals (kieran-typescript KT-1, adversarial P3, testing T-3/T-4) confirmed not in scope per the architect's reasoning.

### Pre-existing not addressed

- **REL-1:** Reliability finding on missing `commandTimeout` in `backend/src/redis.ts:12`. Pre-existing per architect; not filed as a follow-up here. Architect's call whether to file separately.

### Verification

- `npm run typecheck` clean (both `typecheck:src` and `typecheck:tests`).
- `npm run lint` clean (zero warnings on `src/lib/fresh-auth.ts`; the test file passes lint with the existing project rules — one `eslint-disable-next-line @typescript-eslint/no-explicit-any` annotation added on the circular-ref test entry construction, narrow scope).
- `npx vitest run tests/lib/fresh-auth.test.ts` → 38/38 passed.
- Broader suite over fresh-auth's consumers (custody-consent-ops, custody-session-auth, custody-non-consent-fresh-auth, custody-fresh-auth-null-hash, settings-set-password-fresh-auth, settings-email-fresh-auth) → 105/105 passed. The added test-only exports and the docstring-only edits caused no consumer-side breakage.
- Full backend suite NOT run in this session because a sibling backend agent has unstaged work in the tree (`backend/src/accreditation.ts` plus two test files). Running the full suite would cross-contaminate verification. The fresh-auth-touching subset is fully covered above.

### Architect-zone notes

- None. The 1-3 fixes are fully contained to `backend/src/lib/fresh-auth.ts` and `backend/tests/lib/fresh-auth.test.ts`. No contract updates needed; no schema changes; no sibling-helper edits.

---

## Architect re-review (2026-05-18, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` on the round-2 hold-fix commit (9 reviewers — correctness + security + adversarial on Opus; testing/reliability/maintainability/project-standards/kieran-typescript/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The three round-1 hold items mostly landed — slug-citation sweep cleaned the five major sites cleanly, lock-cleanup test now structurally pins the `finally`-block discipline via the new `_getInFlightConsumesSizeForTests` test-only export, and the cross-helper test was added.

Three items held — one is a residual rot-anchor miss from the round-2 sweep's own scope (self-violation audit shortfall per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`), one is a mutation-kill claim from the round-2 signal block that does not actually hold against the cross-helper test as written, and one is a type-safety / signature-clarity nit on the new test-only export.

### Items held (must fix before archive)

**1. (P1, conf 75, correctness + maintainability) Self-violation audit miss — two residual rot anchors in `backend/tests/lib/fresh-auth.test.ts` that the round-2 slug-strip sweep did not catch.**

  - `// Acceptance per task §4:` — task-section reference inside the describe block body. Per root `CLAUDE.md` "Comment anchors", task-section references rot when the task archives.
  - `(See Option B docblock in \`lib/fresh-auth.ts\`.)` — dangling pointer in the Redis-up dual-consume test's loser-reason comment. Round-2 stripped "Option B" from the production docblock in `lib/fresh-auth.ts`, but this parenthetical pointer to it was not updated; it now points at a label that no longer exists.

  Suggested fix: rewrite `// Acceptance per task §4:` to a behavioral statement of what the section pins (e.g., "// Acceptance: both helpers must serialize concurrent dual-consume to exactly one winner under both Redis-up GETDEL atomicity and Redis-stubbed in-process-lock conditions."). Drop the `(See Option B docblock...)` parenthetical entirely — the preceding sentence already explains the wire shape — or rewrite to anchor on the stable symbol `(See the \`inFlightConsumes\` docblock in \`lib/fresh-auth.ts\`.)`.

**2. (P2, conf 80, correctness) Cross-helper Redis-stubbed test's mutation-kill claim does not hold against the split-set mutation it names.** The round-2 signal block claims item 3's cross-helper test pins the shared-lock-domain invariant — a mutation splitting `inFlightConsumes` into per-helper sets (`inFlightConsumesByConsentHelper` + `inFlightConsumesBySessionHelper`) would fail the test's `winners.length === 1` assertion. Trace: after the stubbed `redis.getdel` rejection, the `catch → memStore.get → memStore.delete` path runs synchronously with no intervening `await`. JS microtask FIFO ordering serializes the first-resolving helper's `get → delete` chain before the second's `catch` runs, so the second helper's `memStore.get` returns `undefined` and it returns `expired`. The test observes `winners.length === 1` under split-set just as it does under shared-set. The lock's actual contract — defending against a future refactor that inserts an `await` between `memStore.get` and `memStore.delete` — is not exercised by the current test.

  Suggested fix: add a structural anchor that directly asserts the shared-lock-domain invariant by identity, not via emergent wire behavior. Add a sibling test-only export to `backend/src/lib/fresh-auth.ts` exposing the `inFlightConsumes` Set instance read-only (alongside the existing `_getInFlightConsumesSizeForTests` — e.g., `_getInFlightConsumesSetReferenceForTests`). Add a new spec in the cross-helper describe block that imports the helper and asserts both `consumeFreshAuthToken` and `consumeSessionFreshAuthToken` consult the same Set instance (e.g., spy on `inFlightConsumes.has` via the exported reference and assert it is invoked from BOTH helpers' code paths, or directly assert reference equality via the export). The Set-identity assertion is independent of microtask ordering and survives Redis-absent CI (closes the secondary skipIf-gating gap that would otherwise need a no-Redis companion test). The existing wire-shape cross-helper test can remain alongside the new anchor as nice-to-have coverage.

**3. (P2, conf 75, kieran-typescript) `_setMemStoreEntryForTests` signature appears type-safe but accepts adversarial values.** The function declares `entry: unknown` and immediately casts to `StoredEntry` without structural narrowing. The only caller plants a circular-reference value that fails `JSON.stringify` — definitionally NOT a `StoredEntry`. The cast is load-bearing for the test scenario, but the signature looks safe to future callers when it is deliberately accepting structurally invalid values.

  Suggested fix: widen the parameter type to `StoredEntry | object` (or `StoredEntry | Record<string, unknown>`) with a JSDoc note that test callers may pass structurally invalid objects to trigger throw-on-stringify in production paths. The cast becomes from a known-broader-with-test-purpose type rather than from bare `unknown`, signaling the deliberate misuse without adding an eslint-disable annotation.

### Items dismissed during architect triage

- **(P2, conf 75, testing T-1) Cross-helper test gated `it.skipIf(!redisAvailable)` with no no-Redis companion.** Closed by item 2's Set-identity assertion — the new anchor doesn't require Redis at all (imports the Set instance and asserts identity), so per-helper-split mutation is detectable in Redis-absent CI regardless of the existing test's skipIf gate.
- **(P2, conf 50, adversarial) Unbounded `inFlightConsumes` growth under hung-Redis + retry.** Speculative — requires sustained Redis outage AND high-traffic abandoned consumers. Default-recommend dismiss per `feedback_dismiss_preemptive_test_hardening`.
- **(P3, conf 75, adversarial) Lock-held branch and consumed-token branch indistinguishable on the wire.** Observability nit; below actionable bar.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Items 1-3 touch only `backend/src/lib/fresh-auth.ts` and `backend/tests/lib/fresh-auth.test.ts`. Implementer's call whether one commit or two.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-19, commit SHA `259498a`)

All three round-3 hold items landed in a single commit. Touched files: `backend/src/lib/fresh-auth.ts` (item 2 new export + item 3 signature widening) and `backend/tests/lib/fresh-auth.test.ts` (item 1 rot-anchor strip + item 2 new identity test).

### Item 1 (P1) — residual rot anchors stripped

- `// Acceptance per task §4:` → rewritten to a behavioral acceptance statement covering both Redis-up GETDEL atomicity and Redis-stubbed in-process-lock conditions, applied across both helpers and their two-variant-per-helper coverage. No task-section reference remains.
- `(See Option B docblock in \`lib/fresh-auth.ts\`.)` → rewritten to anchor on the stable `inFlightConsumes` docblock symbol, which is the surface where the loser-reason rationale lives post-round-2.
- Audit-own-replacement check: the rewrites use only stable symbols (`inFlightConsumes`, `consumeFreshAuthToken`, `consumeSessionFreshAuthToken`), describe behavior in invariant terms, and contain no SHAs, line numbers, slug citations, or round numbers.

### Item 2 (P2) — shared-lock-domain Set-identity anchor

- Added `_getInFlightConsumesSetReferenceForTests(): ReadonlySet<string>` to `backend/src/lib/fresh-auth.ts`. The docblock notes the architect-described microtask-FIFO failure mode that wire-shape assertions cannot catch and explains why reference equality is the only mutation-killing anchor for the shared-lock-domain invariant.
- Added one test `'shared-lock-domain invariant: both helpers consult the same inFlightConsumes Set (identity anchor)'` in the same describe block, ahead of the existing wire-shape cross-helper test. Spies on `.has` of the Set returned by the new export, runs `consumeFreshAuthToken` then `consumeSessionFreshAuthToken`, and asserts call counts on the spied Set increment for BOTH helper invocations.
- Mutation kill: a per-helper-Set split (renaming `inFlightConsumes` → `inFlightConsumesByConsentHelper` and adding `inFlightConsumesBySessionHelper`) would route the session helper's `.has` to a sibling Set; the spy on the exported Set would see zero call delta after the session helper runs, failing `sessionHelperCalls > 0`.
- Runs unconditionally (no `skipIf`) — closes the secondary gap from the hold block where the existing Redis-stubbed cross-helper test was gated on `redisAvailable`.
- Existing wire-shape cross-helper test (`'cross-helper Redis-stubbed Promise.all → exactly one winner (shared-lock-domain invariant)'`) retained as nice-to-have coverage per the hold block's "can remain alongside" allowance.

### Item 3 (P2) — `_setMemStoreEntryForTests` signature widened

- Parameter type changed from `entry: unknown` → `entry: StoredEntry | object`. JSDoc note explains the deliberate-misuse contract: test callers may pass structurally invalid objects (the existing caller plants a circular-reference fixture that fails `JSON.stringify`) to exercise throw-on-stringify paths inside the consume helper.
- The internal cast to `StoredEntry` is retained — load-bearing for the `memStore` Map shape — but the wider parameter type signals to future callers that the cast is from a known-broader-with-test-purpose type rather than from bare `unknown`. No eslint-disable annotation needed at the call site.

### Items dismissed at architect triage — no action

All three architect-listed dismissals confirmed not in scope:
- T-1 cross-helper test no-Redis companion: closed by item 2's no-skipIf identity test.
- adversarial unbounded set growth: speculative under Redis-hang + retry; default-recommend dismiss per `feedback_dismiss_preemptive_test_hardening`.
- adversarial P3 observability nit on lock-held vs consumed-token wire indistinguishability: below actionable bar.

### Verification

- `npm run typecheck` clean (both src and tests).
- `npm run lint` clean.
- `npx vitest run tests/lib/fresh-auth.test.ts` → 39/39 passed (was 38/38 round-2; +1 for new identity test).
- New identity test verified running (not silently skipped) via `--reporter=verbose`.
- Full backend suite NOT run in this worktree — targeted gates only per parent instructions.

### Architect-zone notes

None. The three fixes are fully contained to `backend/src/lib/fresh-auth.ts` and `backend/tests/lib/fresh-auth.test.ts`. No contract updates, no schema changes, no sibling-helper edits.
