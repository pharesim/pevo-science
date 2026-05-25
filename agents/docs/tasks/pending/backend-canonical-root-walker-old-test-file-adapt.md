# BACKEND-CANONICAL-ROOT-WALKER-OLD-TEST-FILE-ADAPT — adapt or delete the 3-8 stale tests in `backend/tests/routes/canonical-root-walker.test.ts`

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, follow-up surfaced during `/ce-code-review` of `backend-canonical-root-walker-cumulative-aware` round-1)
**Priority:** P3

## Problem

The Alternative-3 rewrite of `findCanonicalRoot` removed the per-hop consent gate and the `canonical_root_walker_unauthorized_hop` audit event. The newer canary file `backend/tests/routes/papers-canonical-root-walker.test.ts` was added with reproducer, Pin-1 (mixed-case URL), Pin-2 (cycle-detect), and fail-CLOSED canaries pinned against the new event vocabulary `canonical_root_walker_membership_failed`.

The older canary file `backend/tests/routes/canonical-root-walker.test.ts` was NOT updated. It contains tests asserting `expect(events).toContain('canonical_root_walker_unauthorized_hop')` and per-hop-gate backward-walk shapes that no longer fire:

- L297 — `canonical_root_walker_unauthorized_hop` assertion
- L623 — wall-clock abort test whose mutation-kill comment describes removed code (`return { author: childAuthor, permlink: childPermlink }` on abort; the new code returns `null`)
- L1516, L1972 — additional `_unauthorized_hop` assertions
- Plus an unenumerated set of per-hop-gate backward-walk shape pins

`toContain` throws when the element is absent, so the failures are **loud red, not silent pass**. The implementer's round-1 signal block explicitly scoped these tests out of CI and the architect's round-2 hold accepted that scope. But the file is live in the repo; the full-suite run remains red from stale assertions until adapted, masking any future regressions in the same area.

## Goal

Bring the older canary file into alignment with the post-Alternative-3 walker. Two acceptable shapes:

- **Adapt:** rewrite each stale test to anchor on the new event vocabulary (`canonical_root_walker_membership_failed`, `canonical_root_walker_cycle_detected`) and the new three-step shape. Preserve the test intent (DoS bounding, fail-CLOSED, mixed-case parity) where it overlaps the new canary file; delete tests where the intent is fully covered by the newer file.
- **Delete:** if every stale test's intent is now covered by `papers-canonical-root-walker.test.ts` + `continuation-author-gate.test.ts`, delete the older file entirely.

Implementer chooses adapt-vs-delete per-test based on whether the new file covers the intent.

## Acceptance

- Full backend test suite (no scoped exclusions for canonical-root-walker.test.ts) passes.
- No test asserts `canonical_root_walker_unauthorized_hop` (the event no longer fires).
- Mutation-kill comments in retained tests describe live code paths, not removed ones.
- Self-audit on rewritten/added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors.

## Out of scope

- Changing `findCanonicalRoot`'s behavior — the rewrite is final per `backend-canonical-root-walker-cumulative-aware`.
- Adding NEW coverage beyond what either reconciles old intent or matches new behavior. If a gap surfaces during the adapt-vs-delete decision, file separately.

## Coordination

Backend may pick this up any time after `backend-canonical-root-walker-cumulative-aware` archives. Until then, the scoped CI exclusion in the parent task remains the workaround.

## Source

- `/ce-code-review` maintainability M1 (confidence 100), testing T1, security TG-02 — cross-corroborated during round-1 review of `backend-canonical-root-walker-cumulative-aware` (2026-05-21).

---

## Architect review (2026-05-25) — HELD PENDING FIXES (round-1)

`/ce-code-review` on commit `4b78bc5d` confirms the acceptance criteria are met: the full `canonical-root-walker.test.ts` file runs green with no scoped exclusion (22/22), no test asserts the removed `canonical_root_walker_unauthorized_hop` event, retained mutation-kill comments describe the live `null`-return paths, and comment-anchor + mock-carve-out conventions hold. Two focused test-correctness items block archive; both are in this file and small.

### Items

1. **The "negative-cache memo" test asserts deduplication vacuously.** It asserts the per-request `fetchHeadAuthorizedAuthors` lookup count for `alice/v1` equals 1 to prove the no-rows memoize-null path deduplicates. But in this fixture `alice/v1` is looked up exactly once regardless of memoization: `findCanonicalRoot` returns null (membership fails — `bob/v2` not in the chain), so the route proceeds with `bob/v2` coords and the detail-surface walk queries `bob/v2`, never re-hitting `alice/v1`. The assertion passes whether or not the memoize-null branch exists, so it does not kill the regression it claims to guard. **Fix:** change the fixture so `bob/v2` IS admitted (forward verify includes it → canonical root resolves to `alice/v1`), so the detail-surface walk also calls `fetchHeadAuthorizedAuthors` for `alice/v1`; return zero rows on that head-authors lookup to exercise the no-rows memoize-null path specifically (with the memo: count stays 1; without it: 2). Mirror the dedup shape the catch-block and version-path memo tests in the same family already use.

2. **`isForwardWalkContinuationProbe` discriminator collides with the enrichment votes sub-query, undocumented.** Its regex matches both the `resolveContinuationChain` forward-walk probe (intended) and the enrichment votes sub-query — both carry `c.author = ANY($4::text[])`. Benign today because every responder returns `{ rows: [] }` for this match, but the sibling discriminators (`isInitialBackwardProbe`, `isHeadAuthorsLookup`) carry explicit BRITTLENESS WARNING comments and this one does not; a future test seeding a non-empty votes fixture via a separate discriminator would have it silently swallowed. **Fix:** either narrow the discriminator (the forward-walk probe also joins the comment-ops table, which the votes query does not) or add a BRITTLENESS WARNING comment matching the sibling style.

### Acceptance for re-review
- Both items addressed; the full `canonical-root-walker.test.ts` file still runs green with no scoped exclusion.
- Self-audit on changed lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors.

### Dismissed at architect triage (out of scope)
- Adapt-vs-delete of the "legitimate self-continuation" / "legitimate co-author continuation" positive-path tests — the task granted adapt-vs-delete latitude; the implementer's documented choice to adapt is accepted (they pin the simplest backward→forward path from a 1-hop leaf, which the 3-link reproducer and the forward-only continuation-author-gate file do not exactly cover).
- Wall-clock fail-CLOSED test not asserting HTTP 503 status — corroborating only; the 503 is already pinned by a sibling test in this file.
- Solution-file path citation in a comment — the sanctioned anchoring form (solution docs persist), distinct from the prohibited task-slug/SHA/line-number anchors.

Next re-review scopes to commits after `4b78bc5d`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
