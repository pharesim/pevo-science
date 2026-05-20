# BACKEND-COMMENT-ANCHOR-SWEEP-BRIDGE-TS — drop Round-N citations + one task-slug from bridge.ts comments

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by architect re-review of `backend-bridge-write-haf-lag-and-retry-amplification` round-5 — three reviewers (correctness, maintainability, project-standards) cross-corroborated the sibling-rot residual)
**Priority:** P3

## Problem

Round-5 of `backend-bridge-write-haf-lag-and-retry-amplification` (commit `549d99f0`) dropped one `Round-3 hold item #4: ` prefix from a comment block in `backend/src/routes/bridge.ts`. Per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, a convention-enforcing fix should audit the surrounding file for the same rot class. Round-5 was scoped narrowly to ~1 LOC per the architect's hold prescription; the wider sweep was deferred. Three reviewers (correctness, maintainability, project-standards) surfaced the pre-existing sibling rot in their round-5 reviews.

Two convention docs govern:

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — slug/round-N citations rot when the cited task archives
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — replacement text must not introduce new rot

Sibling sweep tasks for the same rot class are in flight on other files:
- `agents/docs/tasks/review/backend-comment-anchor-rot-sweep-accreditation-ts.md`
- `agents/docs/tasks/review/backend-comment-anchor-sweep-supersession-cluster.md`

This task closes the bridge.ts surface in the same cluster.

## Affected sites

All in `backend/src/routes/bridge.ts`. Line numbers are approximate (anchor on the function name + behavioral content, not the line number, when rewriting):

| Line | Current text (excerpt) | Anchor for replacement |
|---|---|---|
| 96 | `// re-acquired). Round-2 hold item #7: surface the 0-return as a structured` | Anchor on the `releaseBridgeLock` Lua CAS no-op semantics — the 0-return signals TTL expiry or sibling re-acquisition; the structured warn lets operators detect TTL-exceeded broadcast cascades. |
| 204 | `// Round-3 hold item #3: required (not optional). Both callers always pass` | Anchor on the `callerLabel` literal-union type's compile-time enforcement of explicit labeling — the parameter is required so a third caller is forced by the compiler to pass a label, preventing silent default-label false alerts. |
| 209 | `// Round-2 hold item #4: thread the caller label so the HAF-failure warn log` | Anchor on the structured `route` field's purpose — it discriminates `/register` vs `/check` HAF blips on operator dashboards. |
| 213 | `// false-alerts on every /check HAF blip. Round-3 hold item #3: no default` | Same anchor as line 204; this is the trailing half of the same docblock. Merge or simplify. |
| 301 | `// Round-2 hold item #2: resolve checkExistingBridge OUTSIDE getOrSet so` | Anchor on the cache-skip invariant — resolving the discriminated union outside `getOrSet` ensures `haf_unavailable` never lands in the 30s cache and poisons subsequent `/check` calls. |
| 324 | `// broadcast. Round-2 hold item #3: assertNever guards the discriminated` | Anchor on `assertNever`'s exhaustiveness guarantee — a future variant added to `BridgeCheckResult` fails the compile, preventing silent fall-through to the `'ok'` branch. |
| 388 | `// Round-2 hold item #6: hoist lookupPreprint OUT of the lock critical` | Anchor on the in-lock wall-clock budget — `lookupPreprint` is external HTTP (CrossRef/PubMed/DOI scrape, ~15-25s) and would push the in-lock time past the 35s `BRIDGE_LOCK_TTL_SECONDS`. Hoisting keeps in-lock work to HAF (~100ms) + broadcast (~30s). |
| 420 | `// Round-2 hold item #1: 409 LOCK_HELD (NOT DUPLICATE). Discriminates` | Anchor on the SPA-contract discrimination — `LOCK_HELD` vs `DUPLICATE` are two distinct 409 cases (in-flight registration vs already-registered); the SPA branches on `err.code`. |
| 458 | `// Round-2 hold item #3: exhaustiveness guard on BridgeCheckResult so a` | Same anchor as line 324; sibling occurrence of the `assertNever` rationale in the `/register` handler. |
| 512-513 | `// guaranteed populated when we reach here. Round-3 hold #6` / `// (BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT) replaced` | Anchor on the `getRequiredBridgePostingKey()` invariant — the accessor throws `BridgeKeyCacheUnpopulated` if the cache desyncs from the config-truthiness check, surfacing as a recognizable shape instead of a silent `null!.toString()` TypeError. Drop both the round-N citation AND the all-caps task slug. |

## Acceptance

1. **Each cited site rewritten on stable behavioral anchors** (function name, invariant, behavioral condition, structured-field semantics) — no task slugs, no round numbers, no line numbers, no SHAs in the replacement text.
2. **Self-violation audit pass:** after the rewrites, grep the diff's own added lines for `round-\d`, slug citations (all-caps with hyphens), line-number anchors (`:\d+`), and SHA-like 7+ hex patterns. None should appear in production source.
3. **No behavioral changes.** Pure comment edits. Scoped vitest (`bridge-haf-lag-locks.test.ts` + `bridge.test.ts` + `bridge-paper-author-gate.test.ts`) passes identically before and after.
4. **Whole-file audit.** After rewriting the listed sites, re-scan `bridge.ts` end-to-end for additional rot the inventory missed (task-slug citations, round-N references, line-number anchors, SHAs). Document any intentional exclusions inline in the commit message.

## Out of scope

- Comment cleanup in other files. The sibling sweep tasks (`backend-comment-anchor-rot-sweep-accreditation-ts`, `backend-comment-anchor-sweep-supersession-cluster`) cover their own surfaces. If the whole-file audit at acceptance step 4 surfaces rot outside `bridge.ts`, file separately.
- Refactoring the comments' substance. The behavioral framing in each comment is correct and load-bearing; only the round-N/slug prefix is being removed.
- Re-flowing comment widths beyond what the prefix-drop naturally requires.

## Cross-references

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — primary convention.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — secondary convention (self-audit obligation).
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — replacement-text anchoring rules.
- Sibling tasks already in review: `backend-comment-anchor-rot-sweep-accreditation-ts`, `backend-comment-anchor-sweep-supersession-cluster`.
- Architect re-review of `backend-bridge-write-haf-lag-and-retry-amplification` round-5 (2026-05-20) — surfaced this sweep as cross-corroborated residual.
