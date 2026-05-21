# BACKEND-RATELIMIT-TEST-ANCHOR-CLEANUP — strip round-number coordination markers from `tests/middleware/rateLimit.test.ts`

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by /ce-code-review maintainability reviewer at archive review of `backend-register-rate-limit-byip-skipfailed` round-2)
**Priority:** P3 (comment-anchor convention rot; pre-existing; recently made more permanent by a cross-file citation that now anchors on the rot-bearing text)

## Problem

`backend/tests/middleware/rateLimit.test.ts` line 151 contains a section header comment with prohibited round-number coordination markers:

```ts
// ─── skipFailedRequests + atomic Lua check (round-3 hold items 1+2) ───
```

The body below it also contains round-number prose:

```ts
// Round-2 left two coupled bugs ...
// ... Round-3 replaces both ...
```

Per PEvO root `CLAUDE.md` "Comment anchors" and `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`: round numbers are coordination state that belongs in commit messages and task files, not in production test source. The parent tasks have long since archived; the `(round-3 hold items 1+2)` and `Round-2`/`Round-3` references no longer point at recoverable context.

The recently-archived `backend-register-rate-limit-byip-skipfailed` task's round-2 fix included a clause-(c) citation in `bridge-register-rate-limit-skip-failed.test.ts` that anchored on the text `skipFailedRequests + atomic Lua check` — the clean prefix of the rot-bearing line. The citation is correct as-written (it quotes only the clean prefix and the convention permits comment-header anchoring) but it makes the rot-bearing text more durable: any rewrite of `rateLimit.test.ts:151` that drops the `skipFailedRequests + atomic Lua check` phrasing would silently break the citation. So this cleanup needs to be coordinated with the citation.

## Goal

Remove the round-number coordination markers from `backend/tests/middleware/rateLimit.test.ts` without breaking the existing clause-(c) citation from `bridge-register-rate-limit-skip-failed.test.ts`.

## Acceptance

### 1. Strip round-number markers from the section header

Rewrite the section header at `backend/tests/middleware/rateLimit.test.ts:151` (or wherever it lives at the time of the fix — anchor on the existing `skipFailedRequests + atomic Lua check` text, not the line number) to drop `(round-3 hold items 1+2)`. The new form should preserve `skipFailedRequests + atomic Lua check` exactly so the sibling citation continues to resolve.

Suggested new shape:

```ts
// ─── skipFailedRequests + atomic Lua check ───
```

### 2. Strip round-number prose from the body comments

Any `Round-N` references in the prose immediately below the section header should be rewritten to behavioral anchors (what the test is pinning, why it matters) — NOT what round they were filed in. Anchor on stable symbols (`incr`, `decr`, atomic Lua script names, `statusCode >= 400` refund branch, etc.).

### 3. Sibling-file audit

Grep `backend/tests/middleware/rateLimit.test.ts` for OTHER round-N markers, task-slug citations, line-number anchors, or SHA references. Apply the same rewrite pattern to any that surface. The file may have accumulated similar rot across prior rounds.

### 4. Verify the existing citation still resolves

After the rewrite, run:

```
grep -n 'skipFailedRequests + atomic Lua check' backend/tests/middleware/rateLimit.test.ts
```

Confirm at least one hit. Then verify the citation in `bridge-register-rate-limit-skip-failed.test.ts` header still anchors meaningfully (the cited section still exists and still covers the cited behavior).

### 5. Verification gates

- `npm run typecheck` clean.
- `npm run lint` clean.
- `npx vitest run tests/middleware/rateLimit.test.ts` passes (no behavior change; only comments rewritten).

## Out of scope

- Other test files with similar rot — file separately or fold into the existing `backend-anchor-rot-sweep-2026-05-21` umbrella sweep task in `tasks/pending/`. (This task's surface is `rateLimit.test.ts` specifically.)
- Restructuring the test file itself (no spec adds, removes, or renames).
- Production source code review (this task is comment-rewriting only).

## References

- `backend/tests/middleware/rateLimit.test.ts` — the file to clean up.
- `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — the sibling file whose clause-(c) citation anchors on `skipFailedRequests + atomic Lua check` in this file's section header; the rewrite must preserve that anchor text.
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — the self-violation audit rule that applies to the replacement text.
- `agents/docs/tasks/pending/backend-anchor-rot-sweep-2026-05-21.md` — the umbrella sweep task; this task is a focused sibling. If the sweep ends up scope-creeping, fold this in instead of running both.
