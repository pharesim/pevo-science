# BACKEND-COMMENT-ANCHOR-ROT-SWEEP-ACCREDITATION-TS — sweep pre-existing coordination-state anchors from accreditation.ts and its test files

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by cluster review of f30a2d1 + 1e2609a + a678463)
**Priority:** P3 (no functional defect; convention compliance)

## Problem

The cluster review of the three round-2 verify-route commits surfaced substantial pre-existing comment-anchor rot in `backend/src/routes/accreditation.ts` and its sibling test files. None of the rot was introduced by the three reviewed commits — but it was visible to multiple persona reviewers and would have been the natural fix surface for a previous commit-zone-aware sweep. Per root `CLAUDE.md` "Comment anchors": production and test code must not embed task slugs, round numbers, line-number anchors, or commit SHAs because task files archive (tasks-archive.md trims from the bottom at 250 lines, dropping older entries) and those citations rot to dead pointers.

This task collects the known sites into one focused sweep so the rot is closed without bloating an in-flight hold cycle.

## Known rot sites (anchored on stable symbols, not line numbers — line numbers drift with every edit)

### Production: `backend/src/routes/accreditation.ts`

Search the file for each phrase below and rewrite to a behavioral anchor.

1. `round-3 hold #2` (multiple occurrences in the `incrementBroadcastAttempts` docblock — "limit-exceeded envelope (round-3 hold #2 chose soft-block: token is NOT consumed)"). The behavioral content survives if you say "soft-block: the token is preserved on cap exhaustion so the user can retry within the 24h TTL window" without naming the round.
2. `round-3 hold #7` (multiple occurrences in `incrementBroadcastAttempts` docblock and in the broadcast-success block around the `seedAccreditationBonus` wrap). Replace with the behavioral statement (e.g., "After a pre-INCR + DECR-on-timeout cycle the counter is bounded by ..." — the round-N attribution adds nothing).
3. `Round-2 F1 / round-3 hold #7` in the HAF-hit branch comment. Replace with the behavioral statement.
4. `Round-2 F3` in the seedAccreditationBonus wrap-site comment. Replace with the semantic anchor: "the severity is explicit at this wrap site so handleBroadcastError emits 502 POST_BROADCAST_OPERATOR_REQUIRED rather than POST_BROADCAST_FAILED" (or similar — drop the attribution clause).
5. `round-3 hold #3` in the same wrap-site comment. Replace with a behavioral note (e.g., "user-facing copy says 'please contact support' because no alerting backend exists yet; the 502 is the operator's pager").
6. `(token preserved per round-3 hold #2)` in the `broadcast attempt cap exceeded; soft-blocking` log message — operator-log strings are exempt from emdash rules but the round-N qualifier is still rot-prone. Replace with "(token preserved)" or drop the parenthetical entirely.
7. Two backtick-quoted slug-style markers ``BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS`` — these reference a now-archived task slug that has been replaced by the convention doc at `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md`. Replace each citation with the doc path (the convention doc itself notes at its bottom: "Production docblocks that previously cited the missing slug `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` should be updated to reference this convention by path when they next see edits.").

### Tests: `backend/tests/routes/accreditation.test.ts`

The file header (the first ~60 lines, before the first `describe(`) contains multiple coordination-state citations:

- Task-slug citations: `BE-ORCID-BROADCAST-ABORT-TIMEOUT`, `BE-HANDLE-BROADCAST-ERROR-HELPER`, `BE-VERIFY-BROADCAST-ATTEMPTS-CAP`, and likely others — grep the header for `BE-` and rewrite each to either a doc-path reference (when a `solutions/conventions/` doc covers the same convention) or to a behavioral anchor describing what the test guards.
- Round-N references: `round 3`, `round-3 hold #5`, `round-4 hold #2`, `Round-4 hold item 1` — each should be replaced with a behavioral description of the invariant being tested.

The describe-block bodies below the header may also contain stale citations; sweep the whole file.

### Tests: `backend/tests/routes/accreditation-idempotency.test.ts`

At least one occurrence of `Round-3 hold #3` exists in a docblock-style comment (cited by `learnings-researcher` during the cluster review). Sweep the whole file for round-N references and task-slug citations.

## Acceptance

1. Run `grep -nE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|F[0-9]+ )" backend/src/routes/accreditation.ts backend/tests/routes/accreditation.test.ts backend/tests/routes/accreditation-idempotency.test.ts` and confirm the only surviving hits are either:
   - Inside string literals that are themselves operator-visible discriminators (e.g., a renamed log event string that contains an underscore but is NOT a round-N reference), OR
   - Inside backticked references to solution-doc paths (e.g., `helper-extraction-express5-response-ordering-2026-04-28.md`), which are durable.
2. Every comment block that previously carried coordination-state context now carries a stable-symbol or behavioral anchor. The intent of the comment is preserved; the citation rot is removed.
3. Test files still pass: `npx vitest run tests/routes/accreditation.test.ts tests/routes/accreditation-idempotency.test.ts` (per CLAUDE.md "Running Tests" Docker IP env-var overrides).
4. Self-audit per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: the replacement prose must not itself introduce new round-N citations, line-number anchors, or SHA references.

## Out of scope

- Comment anchors in files OTHER than the three named above. Pre-existing rot exists elsewhere in `backend/` (e.g., other routes' docblocks may have similar citations); a wider sweep is a separate task if it ever becomes worth scoping.
- Renaming the log event discriminators themselves (those landed in `backend-verify-cap-redis-flap-recovery` round-2 already).
- Refactoring the `incrementBroadcastAttempts` or `seedAccreditationBonus` code paths. This task is purely comment hygiene; behavior must not change.
- Updating `agents/docs/solutions/` entries that themselves cite the same archived task slugs — those rot too, but their cleanup belongs to `/ce-compound-refresh`, not this task.

## References

- Root `CLAUDE.md` § "Comment anchors"
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md` (the replacement target for the `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` slug-style markers)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-19)

Sweep complete on all three named files. The acceptance grep returns zero hits.

```
grep -nE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|F[0-9]+ )" \
  backend/src/routes/accreditation.ts \
  backend/tests/routes/accreditation.test.ts \
  backend/tests/routes/accreditation-idempotency.test.ts
# (empty)
```

### Sites swept

**`backend/src/routes/accreditation.ts`** — round-N qualifiers and slug citations removed from:
- `incrementBroadcastAttempts` docblock (3 round-N references: soft-block rationale, Lua-INCR-EXPIRE atomicity, transition-to-1 invariant). Behavioral content preserved.
- `decrementBroadcastAttempts` docblock + discriminator type comment (4 round-N references). The `'failed'` arm dismissal phrasing is now stable; the discriminator's purpose is described directly.
- `decrementBroadcastAttempts` Redis-unavailable branch (1 round-N reference dropped from the discriminator-return comment).
- Idempotency-key + probe-before-INCR rationale block (2 round-N references; cap-on-hit invariant kept).
- Existing-accreditation gate metadata-update comment (2 round-N references).
- Per-token broadcast-attempts cap rationale block (6+ round-N references, including the soft-block design choice). Sub-option (i)/(iii) tradeoff narrative preserved as "hard-block" and "re-auth-required were considered" phrasing.
- Cap-exceeded log message string: the "(token preserved per round-3 hold #2)" parenthetical dropped to "(token preserved)" — the discriminator is preserved.
- `seedAccreditationBonus` wrap-site comment: both `BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS` citations replaced with the canonical doc path `agents/docs/solutions/conventions/cascade-fns-rethrow-permanent-errors-2026-05-16.md`. The `Round-2 F3` and `round-3 hold #3` qualifiers dropped; the severity-discrimination behavior and the user-facing "contact support" rationale are described directly.
- Outer catch branches' compensating-decrement and cleanup-failure log comments (3 round-N references; token-hash threat model preserved).

**`backend/tests/routes/accreditation.test.ts`** — sweep of file header docblock (round-N + 4 BE-slug citations) and ~60 inline comment / describe / it-title sites. The describe blocks renamed from slug-named to behaviorally-named:
- `POST /api/accreditation/verify — BE-ORCID-BROADCAST-ABORT-TIMEOUT` → `... broadcast-timeout discrimination`.
- `POST /api/accreditation/verify — BE-VERIFY-BROADCAST-ATTEMPTS-CAP` → `... per-token broadcast-attempts cap`.
- `BE-LOG-SHAPE-CONVERGENCE — accreditation.ts structured-log emissions (Item 3 part C)` → `accreditation.ts structured-log emissions`.
- `BE-ACCRED-REQ-LIMITER — accred-req limiter refunds slot on transient SMTP failure` → `accred-req limiter refunds slot on transient SMTP failure`.

The `INTENTIONAL RED` callout in the file header was preserved with the slug citation removed — the load-bearing forcing-function language stays.

**`backend/tests/routes/accreditation-idempotency.test.ts`** — sweep of file header (1 round-N + 1 BACKEND-slug) and ~15 inline comment / it-title sites. Cascade-fns reference replaced with doc path. The revoke→re-accredit gate behavior narrative preserved verbatim minus the round-N pointer.

### Self-audit per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`

Replacement prose was spot-checked against the rot patterns. No new task-slug citations introduced (the only slug-style references in the replacements point to durable solution-doc paths). No round-N references in the replacements. No line-number anchors. No SHA references. All anchors are stable symbols (function names, branch names, behavior descriptions).

### Verification

- `npm run typecheck` (`:src` and `:tests`): clean.
- `npm run lint` (`src/`): clean.
- `npx vitest run tests/routes/accreditation.test.ts tests/routes/accreditation-idempotency.test.ts` with Docker IP env overrides: **51/52 pass**. The single failure (`pre-INCR redis.eval rejection surfaces 503 SERVICE_UNAVAILABLE with {retriable:true}` — expected 503, received 502) is a documented pre-existing flake — verified via `git stash`: the failure reproduces on a clean tree at the same SHA before this commit's edits. The flake was previously flagged in the round-2 signal block of `backend-verify-post-success-retry-idempotency`. Not caused by this task's changes.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
