# UI-ERR-MESSAGE-SANITIZE-PAPER-DETAIL-SURVIVORS — Extend the err-sanitize invariant to the `err?.message` patterns in paper-detail.js

**Owner:** ui
**Created:** 2026-04-22 (surfaced by UI-ERR-MESSAGE-SANITIZE-TOAST-AND-HANDLECONNECT-SITES first-review)
**Priority:** P2

## Context

The err-sanitize sweep closed raw `err.message` binding across 29 sites in `FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND` and 8 more toast/handleConnect sites in the follow-up. The acceptance grep was `grep -rn '= err\.message' frontend/src/` — which misses **optional-chained** patterns like `err?.message || $t(...)`.

Review of the toast/handleConnect sweep surfaced `frontend/src/pages/paper-detail.js` with **7+ live `err?.message || $t(...)` toast and DOM-field bindings** that semantically violate the invariant but pass the grep gate due to the optional-chain syntax.

F6.2, maintainability M6-4 0.90 (info). See `.context/compound-engineering/ce-code-review/aggregated/06-ui-err-message-sanitize-toast-and-handleconnect-sites.md` § F6.2.

## Goal

Apply the standard sanitize pattern (`console.warn + $t(<key>)`, with semantic-code carve-outs per `handleEmailSubmit`'s DUPLICATE example) to the 7+ sites in `paper-detail.js`.

Also widen the acceptance grep across the repo: `grep -rnE '= err\??\.message|err\??\.message \|\|' frontend/src/` should return zero matches (or only semantic-code-branch carve-outs with inline justification comments).

## Non-goals

- Adding new i18n keys beyond what each site needs. Reuse existing keys where possible.
- Refactoring the page structure.
- Changing the error shape or API surface.

## Acceptance

- All 7+ sites in `paper-detail.js` use `console.warn + $t(<key>)`.
- Semantic-code carve-outs preserved (e.g., `if (err?.code === 'SOMETHING')` branches that render code-specific localized messages).
- Widened grep pattern returns zero matches across `frontend/src/`.
- Unit test per sanitized handler asserting: (a) generic i18n key bound, (b) raw `err` reaches `console.warn`, (c) sentinel (e.g., 'deadbeef') absent from bound field.
- New i18n keys added to `en.json`, stubbed across 14 non-English locales, registered in STUBS.md under a fresh sweep sub-heading per `agents/ui/CLAUDE.md` § Internationalization.

## [TODO Architect]

- Update the acceptance-grep pattern in `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md` to include optional-chained forms (`err?.message`). The current doc's acceptance pattern is the literal-assignment shape; this task exposes that gap.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `0ee5bfe` (correctness persona). All 9 `err?.message` patterns in paper-detail.js correctly sanitized (including the NOT_FOUND carve-out). Widened acceptance grep `grep -rnE '= err\??\.message|err\??\.message \|\|' frontend/src/` returns zero matches. Pre-existing i18n keys used correctly; no new keys → no STUBS.md churn. Two hold items on test coverage.

1. **P2 — 3 of 5 sibling-page handlers sanitized in diff have no corresponding unit test** (correctness F13-C1 0.88). Task acceptance explicitly requires *"Unit test per sanitized handler asserting: (a) generic i18n key bound, (b) raw err reaches console.warn, (c) sentinel absent from bound field."* Tests updated for `paper-detail.js` handlers; `profile.js loadProfile`, `edit.js loadPaper`, `editor.js handleImageUpload` were sanitized but received no tests. `pages-profile.test.js`, `pages-edit.test.js`, `editor.test.js` not modified. Fix: add 3 tests mirroring the `paper-detail.js` handler pattern (one per sibling handler). ~30 LoC per test; can parametrize across the 3 handlers.

2. **P3 — NOT_FOUND carve-out test uses `vi.useFakeTimers()` without try/finally** (correctness F13-C2 0.65). If an assertion inside the async block throws, `vi.useRealTimers()` is skipped; `restoreMocks: true` in `vitest.config.js` doesn't restore timers. Subsequent tests run under fake timers. Fix: wrap in `try { vi.useFakeTimers(); ...existing block... } finally { vi.useRealTimers(); }`.

**Dismissed from round-1 findings:**
- `loadEnrichment` bare `catch {}` pre-existing (no err binding, no raw message leak possible): out of scope, different failure class.
- `handleBridgeSync` stale-mount guard short-circuits console.warn entirely: intentional per teardown-guard sweep.

**Path to re-archive:** (1) UI applies items #1-2 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.
