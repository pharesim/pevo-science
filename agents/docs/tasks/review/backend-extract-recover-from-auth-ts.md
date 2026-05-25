# BACKEND-EXTRACT-RECOVER-FROM-AUTH-TS — Split recover/verify/dispute handlers + helpers into routes/recover.ts

**Owner:** backend
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify; kieran-typescript + maintainability persona)
**Priority:** P3 (organizational; deferred from recover-email closure)

## Problem

`backend/src/routes/auth.ts` grew substantially after the recover-email landing — the file is now ~1700 lines. The `/recover`, `/recover/verify`, `/recover/dispute` handlers form a coherent ~565-line subdomain that shares its own constants (`RECOVERY_VERIFY_TOKEN_EXPIRY_MS`, `RECOVERY_DISPUTE_TOKEN_EXPIRY_MS`), schemas (`RecoverBodySchema`, `RecoverTokenBodySchema`), rate limiter (`recoverLimiter`), helpers (`forensicDigest`, `emailDomain`), and the new `pending_recovery` DB shape.

A `routes/recover.ts` split would cap `auth.ts` size, keep the recovery state machine co-located with the code that enforces it, and reduce navigation cost in `auth.ts`.

## Goal

Extract the recovery trio + their owned helpers / schemas / constants into a new module `backend/src/routes/recover.ts`. Mount under the same `/api/auth/` path prefix in the route registration.

## Acceptance

- `backend/src/routes/recover.ts` contains the three handlers (`/recover`, `/recover/verify`, `/recover/dispute`) + recover-specific schemas + expiry constants + `recoverLimiter`.
- `backend/src/routes/auth.ts` no longer contains recover-specific code or helpers; imports nothing from `recover.ts`.
- Wherever routes are registered, both files mount under `/api/auth/`.
- Existing test files (`recover.test.ts`, `recover-two-phase.test.ts`) pass without modification — the wire-shape is identical.
- No behavior change. Verified by full test run on the affected suites + typecheck + lint clean.

## Dependencies / coordination

- Best done AFTER `backend-log-pii-helper-consolidation` lands (so `forensicDigest` is already in `lib/log-pii.ts`). The order is not strict — both can land in either sequence — but `recover.ts` inherits the consolidated import path cleanly if log-pii lands first.

## Non-goals

- Behavioral changes inside the handlers. Any defect repairs are out of scope; file as separate tasks.
- Renaming the routes or response shapes.
- Splitting tests further. Existing test files stay where they are.

## References

- `backend/src/routes/auth.ts` — extraction source (the recover trio is the bottom third of the file)
- `backend/migrations/012_pending_recovery.sql` — companion schema (unchanged by this work)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-25, → round-1) — HELD PENDING FIXES

`/ce-code-review` ran with the always-on personas (skipping `ce-agent-native-reviewer` per project CLAUDE.md) plus `kieran-typescript`. Acceptance criteria all land: `recover.ts` houses the three handlers + schemas + expiry constants + `recoverLimiter`; `auth.ts` no longer registers any `/recover*` path; `app.ts` mounts both routers under `/api/auth/` with `authRouter` first and disjoint path sets between the three routers there (`authRouter`, `recoverRouter`, `signupVerifyRouter`); test files unmodified; HTTP-driven tests have no import surface on the moved symbols; the moved code is byte-identical modulo a cosmetic local `token2` → `sessionJwt` rename in `/recover/verify` (response wire-shape preserved). `decryptKey` and `sha256HexDigest` imports correctly moved out of `auth.ts` (no remaining callers there). No correctness, security, or test-coverage findings.

Two stale-comment items in `auth.ts` that the diff touched but did not fully clean. Both are one-line text fixes; bundling in a single round.

### Items held (must fix before archive)

**1. (P2, conf 100, cross-reviewer — maintainability + project-standards) `backend/src/routes/auth.ts` — round-number coordination citation in `BE-ZOD-MIGRATION-EXTENSION` docblock.**

The docblock currently contains the phrase `"Same flat-error pattern as the round-1 schemas"`. The diff touched this comment to remove the count `3` elsewhere in the same block but did not clear the `round-1` anchor. Per root `CLAUDE.md` "Comment anchors" (round numbers are coordination state that belongs in commit messages and task files, not in production source) and `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` (when editing a comment to remove one rot class, audit it for all other rot classes in the same pass), this instance was in scope for the diff's edit and was missed.

Fix: replace the `round-1` phrase with a stable behavioral anchor. Acceptable shapes — implementer's choice:

- **Shape A — name the referenced schemas behaviorally**, e.g. `"the /login and /signup schemas above"` or `"the earlier Zod schemas in this file"`.
- **Shape B — name the migration without a round number**, e.g. `"the initial BE-REQUEST-BODY-TYPING-ZOD migration schemas"`.

Either anchors on a stable invariant (the schemas exist for the lifetime of the file / the migration is named once and stable).

**2. (P3, conf 100, kieran-typescript, `safe_auto`) `backend/src/routes/auth.ts` — stale cross-file caller attribution for `burnSentinel`.**

The comment near the `burnSentinel` function body reads (approximately) `"Cross-file caller attribution: burnSentinel is imported from auth.ts AND custody.ts AND signup-verify.ts"` — three importers. This commit added `recover.ts` as a fourth importer (`recover.ts` calls `burnSentinel` from the moved `/recover/verify` handler) without updating the attribution comment.

Fix: append `" AND recover.ts"` to the importer list so the comment matches the actual import graph.

### Items dismissed / noted

- **`signup-verify.ts:39-40` carries duplicated `SESSION_EXPIRY` / `SESSION_EXPIRY_MS` constants** instead of importing the now-exported versions from `auth.ts`. Pre-existing — this commit did not introduce the duplication, but it did introduce the pattern divergence (recover.ts imports, signup-verify still duplicates). Not held against this task; file as a separate follow-up if the divergence matters.
- **`ARCHITECTURE.md:538` carries a pre-existing line-number anchor (`auth.ts:460-490`).** Architect-zone file, not the implementer's responsibility, and untouched by this diff. The referenced lines remain in auth.ts after the extraction so the anchor is not freshly stale here.
- **`auth-structured-log-shape-2026-04-29.md` (under `agents/docs/solutions/`) carries a stale `burnSentinel` importer inventory** (lists `auth.ts /recover` as a call site; that callsite now lives in `recover.ts`). Architect-owned (solutions/). Not held against this task; will refresh during the next `/ce-compound-refresh` pass or alongside a future learnings update.
- **Adversarial persona not dispatched** — the change is a whole-handler move (byte-identical) rather than a logic edit; the persona's failure-construction strength doesn't fit the diff shape. The correctness persona's byte-identity verification covers the equivalent guarantee.
- **No direct unit test for the newly-exported `SESSION_EXPIRY` / `SESSION_EXPIRY_MS`** — value is unchanged from pre-export, HTTP-driven tests transitively exercise it, and dismissing per `feedback_dismiss_preemptive_test_hardening`.

### Re-review signal

When items 1 and 2 land, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit(s) only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-25, working tree pre-commit)

Items 1 and 2 landed in `auth.ts`, both comment-only:

- Item 1: the `BE-ZOD-MIGRATION-EXTENSION` docblock's `"the round-1 schemas"` phrase is now `"the earlier Zod schemas in this file"` (Shape A — behavioral anchor, round number removed).
- Item 2: the `burnSentinel` cross-file caller-attribution comment now reads `"auth.ts AND custody.ts AND signup-verify.ts AND recover.ts"`. Confirmed `recover.ts` is the fourth importer: `import { burnSentinel } from './auth.js'` plus a `burnSentinel(...)` call in the moved `/recover/verify` handler.

Verification: `npm run typecheck` clean; `npm run lint` clean on `auth.ts`; comment-only edits, no behavior change. `recover.test.ts` + `recover-two-phase.test.ts` + `auth.test.ts` pass as part of the 88/88 affected-suite run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
