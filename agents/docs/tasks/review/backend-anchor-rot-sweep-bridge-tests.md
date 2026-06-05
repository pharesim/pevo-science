# BACKEND-ANCHOR-ROT-SWEEP-BRIDGE-TESTS — sweep pre-existing slug/round-N rot in bridge-haf-lag-locks.test.ts

**Owner:** backend
**Created:** 2026-06-05 (architect, surfaced as pre-existing by three personas during the round-2 re-review of the bridge check-cache task)
**Priority:** P3

## Problem

`backend/tests/routes/bridge-haf-lag-locks.test.ts` carries comment-anchor rot from earlier task cycles, forbidden in test source per root `CLAUDE.md` "Comment anchors": describe labels embedding task slugs plus emdashes (the `BE-BRIDGE-WRITE-HAF-LAG` fail-open block, which also carries a round-N qualifier in its label) and inline `Round-2 hold item N` / `Round-3 hold item #1` comments. The check-cache re-review fixed the one slugged describe label in its own scope; the adjacent rot is carry-over from other cycles and was left untouched to keep that change focused.

## Scope

- Reword every describe/it label in the file that embeds a task slug or round-N marker to a behavioral description. The already-fixed shared-cache describe label in this file ("bridge /check + /register shared HAF cache: ...") is the pattern to follow.
- Replace inline round-N hold-item comments with the behavioral statement they annotate (keep the mutation-kill rationale; drop the coordination context).
- Audit-own-replacement per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: the replacement text must introduce no new slugs, round-N markers, line-number anchors, or SHAs. Positional anchors are acceptable when they meet the stable-named-container carve-out (`agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md`).
- Post-sweep grep over the file for slug-shaped labels and round-N markers returns zero hits.

## Acceptance

- Comment-only / label-only change; test behavior at parity (file green before and after the sweep).
- `npm run typecheck` + `npm run lint` clean.

## Backend signal (2026-06-05, commit on main)

Swept the pre-existing slug/round-N rot from `tests/routes/bridge-haf-lag-locks.test.ts`: the file header and the three `BE-BRIDGE-WRITE-HAF-LAG — ...` describe labels (one also carrying a `round-2 hold item #8` qualifier) re-anchored on behavioral descriptions; the three inline `Round-2/Round-3 hold item N` comments reworded to state the invariant they annotate (the no-status-leak shape, the `route: 'bridge.check'` warn-log field, and the `haf_unavailable`-never-cached mutation-kill). Replacements introduce no new slug/round/line/SHA anchors. Post-sweep grep for slug-shaped labels and round-N markers returns zero hits; comment-only/label-only change, test behavior at parity (5 tests green before and after). `npm run typecheck` + `npm run lint` clean.
