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
