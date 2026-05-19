# BACKEND-COMMENT-ANCHOR-ROT-SWEEP-FRESH-AUTH-AND-REVIEW-TESTS — sweep pre-existing coordination-state anchors from 3 backend test files

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by cluster review of `259498a` + `5fc0cae` + `6c4c604` + `5705a99`)
**Priority:** P3 (no functional defect; convention compliance)

## Problem

Cluster review of the four cluster commits (fresh-auth-race round-3, verifyhive-authmethod round-3, validate-middleware round-1, flush-and-exit round-3) surfaced substantial pre-existing comment-anchor rot in three backend test files. None of the rot was introduced by the four reviewed commits — multiple persona reviewers (correctness, maintainability, project-standards) flagged the residual sites and the architect deferred them to a focused sweep so the rot is closed without bloating an in-flight hold cycle. Per root `CLAUDE.md` "Comment anchors": production and test code must not embed task slugs, round numbers, line-number anchors, or commit SHAs because those citations rot when the originating task archives (`tasks-archive.md` trims from the bottom at 250 lines; older entries drop off entirely).

The highest-visibility rot is in `fresh-auth.test.ts` — round-N qualifiers appear in describe-block labels (`describe('isFreshAuthMechanism — type guard (round-4 hold #8)', …)` etc.) that print in every vitest runner output indefinitely.

## Known rot sites (anchored on stable symbols, not line numbers — line numbers drift with every edit)

### `backend/tests/lib/fresh-auth.test.ts` (~19 sites)

Grep target: `grep -nE "(round[- ]?[0-9]|hold #|BACKEND-[A-Z_-]+|Acceptance criterion #)" backend/tests/lib/fresh-auth.test.ts` returns ~19 hits at task-file-creation time.

Shapes to clean:
1. **Round-N qualifiers in describe labels.** Examples to anchor on:
   - `describe('isFreshAuthMechanism — type guard (round-4 hold #8)', …)` → drop the parenthetical; label becomes `'isFreshAuthMechanism — type guard'`.
   - `describe('computeFreshAuthTargetHash — content hash (round-5 hold #3)', …)` → drop parenthetical.
   - `describe('TTL-expiry on in-memory fallback (round-4 hold #17)', …)` → drop parenthetical.
   - `describe('Redis-flap recovery via memStore backup (round-4 hold #3)', …)` → drop parenthetical.
   - `describe('Symmetric dual-tier deletion (round-5 hold #1)', …)` → drop parenthetical.
   - `describe('Per-op target binding (round-5 hold #3)', …)` → drop parenthetical.
   - `describe('BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — session-kind issue / consume', …)` (line ~501) → rewrite to a behavioral label (`'session-kind issue / consume — issueSessionFreshAuthToken + consumeSessionFreshAuthToken'`).
2. **Round-N qualifiers in inline comments.** Examples:
   - `// Round-5 hold #8: hoist the "Redis present?" check to module scope so …` → rewrite to behavioral framing ("Module-scope `redisAvailable` capture lets `it.skipIf(...)` evaluate before beforeAll runs, …").
   - `// guard is bypassed. Round-4 hold #17's mutation-kill is specifically …` → drop "Round-4 hold #17's" prefix; the surrounding prose names the invariant.
   - `// TTL guard (the round-4 fix writes a memStore backup at issuance, …)` → "(memStore backup is written at issuance; `cached.expiresAt > Date.now()` gates lookup.)" or similar — drop the "round-4 fix" attribution.
3. **File-header docblock** (line ~14, line ~26): `round-4 fix writes …`, `Item 3: per-op target binding. The round-4 proof bound only to …`. Rewrite to behavioral framing ("the memStore backup is written at issuance" / "per-op target binding requires the proof to bind to a `(action, root_author, root_permlink)` tuple").
4. **Section-band comment** (line ~499): `// ─── BACKEND-CUSTODY-BROADCAST-ORCID-FRESH-AUTH — session-kind primitives ───`. Rewrite to behavioral band ("session-kind primitives — issue + consume + cross-kind acceptance"), drop the slug.

### `backend/tests/routes/settings-email-fresh-auth.test.ts` (3 sites)

Pre-existing rot that survived the round-3 sweep of sibling sites (round-3 sweep targeted specific architect-listed hold-block items, did not extend to other rot in the same file):

1. **Line 2** (file-header docblock first line): `* BACKEND-SETTINGS-EMAIL-REAUTH-FRESH-AUTH — pin the JWT-path fresh-auth gate` → rewrite to behavioral ("Pin the JWT-path fresh-auth gate on POST /api/settings/email's change-email branch: body-proof required, bound to user + target, single-use, mechanism-correct.").
2. **Lines 501-503** (inline comment in a Keychain-path test): `// proceeds. With no Bearer header it sets req.hiveAuthMethod = 'signature' …  Acceptance \n // criterion #5: Keychain-signature-authenticated requests do NOT require …` → drop the "Acceptance criterion #5:" prefix; the surrounding prose ("Keychain-signature-authenticated requests do NOT require a body proof") already names the invariant.
3. **Line 609** (block-comment band): `// BACKEND-CHANGE-EMAIL-MINT-PATH-AND-FOLLOWUPS — end-to-end mint→consume` → rewrite to a behavioral band naming what the section tests (e.g., "end-to-end mint→consume happy path: SMTP send + verify_token row + `/verify-email` consume + `email = pending_email` commit").

### `backend/tests/routes/review-parity-invariant.test.ts` (3 sites)

1. **Line 5** (file-header docblock): `* Acceptance criterion #4 of …` → rewrite to behavioral framing of what the test pins.
2. **Line 38** (header docblock, deeper paragraph): `* **Synthetic-VALUES fallback (BACKEND-SELF-REVIEW-EXCLUSION round-1 hold …)**` → rewrite to behavioral framing; the synthetic-VALUES fallback shape is documentable without the task-slug + round-N attribution.
3. **Line 157** (inline comment): `// Per BACKEND-SELF-REVIEW-EXCLUSION round-1 hold #7: when the live HAF …` → drop the slug+round prefix; "When the live HAF returns zero matching rows, the synthetic-VALUES fallback …" stands on its own.

## Acceptance

1. Run the following grep across the three files and confirm the only surviving hits are either:
   - Inside string literals that are themselves operator-visible discriminators (e.g., a log-event string that contains an underscore but is NOT a round-N reference), OR
   - Inside backticked references to solution-doc paths (e.g., `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`), which are durable:
   ```
   grep -nE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|Acceptance criterion #|F[0-9]+ )" \
     backend/tests/lib/fresh-auth.test.ts \
     backend/tests/routes/settings-email-fresh-auth.test.ts \
     backend/tests/routes/review-parity-invariant.test.ts
   ```
2. Every comment block and describe-label that previously carried coordination-state context now carries a stable-symbol or behavioral anchor. The intent of the comment is preserved; the citation rot is removed.
3. Test files still pass: `npx vitest run tests/lib/fresh-auth.test.ts tests/routes/settings-email-fresh-auth.test.ts tests/routes/review-parity-invariant.test.ts` (per CLAUDE.md "Running Tests" Docker IP env-var overrides).
4. Self-audit per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: the replacement prose must not itself introduce new round-N citations, task slugs, line-number anchors, or SHA references.

## Out of scope

- Comment anchors in files OTHER than the three named above. Pre-existing rot exists elsewhere in `backend/` (see also the sibling `backend-comment-anchor-rot-sweep-accreditation-ts.md` task in `pending/` for that area); a wider sweep is a separate task if it ever becomes worth scoping.
- Refactoring the test bodies or assertions. This task is purely comment hygiene; behavior and assertions must not change.
- `src/lib/fresh-auth.ts` production docblock — the round-3 architect re-review of `backend-flush-and-exit-auth-converge` surfaced a sibling-file residual (`Round-4 hold #1 (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT)` citation in `src/lib/flush-and-exit.ts`). That file is in a different cluster's surface; if the backend agent wants to bundle the production-side cleanup of `src/lib/fresh-auth.ts` and `src/lib/flush-and-exit.ts` docblocks into this sweep, that's a defensible scope expansion — otherwise leave for a follow-up.
- Updating `agents/docs/solutions/` entries that themselves cite the same archived task slugs — those rot too, but their cleanup belongs to `/ce-compound-refresh`, not this task.

## References

- Root `CLAUDE.md` § "Comment anchors"
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- Sibling sweep task: `agents/docs/tasks/pending/backend-comment-anchor-rot-sweep-accreditation-ts.md` (same shape, different files)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
