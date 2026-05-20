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

## Backend re-review signal (2026-05-20)

### Per-site summary of the 10 enumerated rewrites

All 10 cited sites in `backend/src/routes/bridge.ts` rewritten on stable behavioral anchors per the task table. No round numbers, task slugs, line numbers, or SHAs in replacement text.

1. **Line ~96 (`releaseBridgeLock` Lua CAS warn).** Dropped `Round-2 hold item #7:` prefix. Anchored on the Lua CAS no-op semantics (0-return signals TTL expiry or sibling re-acquisition) + the operator-detection purpose (TTL-exceeded broadcast cascades).
2. **Line ~204 (`checkExistingBridge` `resolvedParsed` parameter docblock).** Dropped `Round-3 hold item #3:` prefix. Anchored on the required-positional + strict-TS parse + `??` fallback invariant.
3. **Line ~209 (`callerLabel` parameter docblock).** Dropped `Round-2 hold item #4:` prefix. Anchored on the route-keyed dashboard discrimination (`/check` vs `/register` HAF blips).
4. **Line ~213 (trailing half of `callerLabel` docblock).** Merged with site #3 (single docblock). The `Round-3 hold item #3` repeat is replaced with "literal-union type is required with no default" behavioral framing.
5. **Line ~268 (HAF-catch warn block).** Dropped `BE-BRIDGE-WRITE-HAF-LAG fail-closed signal` slug. Anchored on the fail-closed/fail-open caller-policy split + dashboard-filter behavior.
6. **Line ~301 (`/check` cache-skip block).** Dropped `Round-2 hold item #2:` prefix. Anchored on the cache-skip invariant (haf_unavailable never lands in the 30s cache, prior `getOrSet` poisoning).
7. **Line ~324 (`/check` `assertNever` guard).** Dropped `Round-2 hold item #3:` prefix. Anchored on `assertNever`'s compile-time exhaustiveness guarantee against future `BridgeCheckResult` variants.
8. **Line ~388 (`lookupPreprint` hoist).** Dropped `Round-2 hold item #6:` prefix. Anchored on the in-lock wall-clock budget (HAF ~100ms + broadcast ~30s) vs the 35s `BRIDGE_LOCK_TTL_SECONDS`.
9. **Line ~420 (LOCK_HELD 409 response).** Dropped `Round-2 hold item #1:` prefix AND the "existing-duplicate 409 below" relative anchor. Replaced "below" with "emitted on `BridgeCheckResult.exists === true`" structured anchor.
10. **Line ~458 (`/register` `assertNever` guard).** Dropped `Round-2 hold item #3:` prefix. Anchored on `assertNever` + `BridgeCheckResult` exhaustiveness guarantee.

### Whole-file audit (acceptance step 4) — additional sites surfaced and rewritten

The broadened-pattern grep at intake surfaced six additional rot sites beyond the enumerated 10. All rewritten in the same commit on the same convention basis:

- **Line 27 file-header banner** — `BE-BRIDGE-WRITE-HAF-LAG` task-slug citation removed; banner renamed to "Bridge read-then-write race protection" (behavioral description).
- **Line 39 (`BRIDGE_LOCK_TTL_SECONDS` rationale block)** — replaced "above the 30s broadcast timeout" with "exceeds the 30s broadcast timeout" (the original is a magnitude comparison, but the grep flags `\babove\b`; rewrote to remove ambiguity). Also rewrote "orcid's A.1" coordination-section reference to "ORCID lock's timeout-extension path" (behavioral description).
- **Line 410 (`/register` lock-acquisition comment)** — `BE-BRIDGE-WRITE-HAF-LAG:` slug citation removed; preserved behavioral framing (per-permlink lock claim sequencing + Redis-outage degrade).
- **Line 479 (`logBroadcastAttempt` factory call site)** — `BACKEND-BROADCAST-ATTEMPT-HELPER-EXTRACTION` slug citation removed; preserved behavioral framing (per-attempt audit signal, custody-site symmetry, `attempt_n` omission rationale).
- **Lines 510-513 (`getRequiredBridgePostingKey` use site)** — both rot classes purged: `Round-3 hold #6` round-citation AND `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` all-caps task-slug. Also replaced relative anchor "`assertBridgeKeyConfigured` above" with "`assertBridgeKeyConfigured` already returned 503 earlier in the handler" (function-name-anchored, not positional).

#### Verbatim broadened-pattern grep output

Before edits (baseline rot surface):

```
27:BE-BRIDGE-WRITE-HAF-LAG
39:above
96:Round-2
204:Round-3
206:below
209:Round-2
213:Round-3
268:BE-BRIDGE-WRITE-HAF-LAG
301:Round-2
324:Round-2
388:Round-2
410:BE-BRIDGE-WRITE-HAF-LAG
420:Round-2
421:below
458:Round-2
479:BACKEND-BROADCAST-ATTEMPT-HELPER-
510:above
512:Round-3
512:hold #
513:BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT
```

After edits (run command: `grep -inoE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|F[0-9]+[: ]|\babove\b|\bbelow\b|\bnext test\b|\bprevious test\b)" backend/src/routes/bridge.ts`):

```
(no output — clean)
```

### Self-audit per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`

Grepped the diff's own added lines (`git diff backend/src/routes/bridge.ts | grep '^+'`) against the broadened pattern AND additional rot classes (`:[0-9]+\b` line-number anchors, `\b[a-f0-9]{7,40}\b` SHA-shape hex, ALL-CAPS hyphenated slug shapes, ISO date anchors). All checks return zero hits.

No round-N markers, no task-slug citations, no line-number anchors, no SHA-shape refs, no date anchors, no "above"/"below" relative positional anchors in the replacement text.

### Scoped vitest pass output

Command: `npx vitest run tests/routes/bridge.test.ts tests/routes/bridge-haf-lag-locks.test.ts tests/routes/bridge-paper-author-gate.test.ts` with Docker IP env-var overrides per `Running Tests` in root `CLAUDE.md`.

Result:

```
 Test Files  3 passed (3)
      Tests  33 passed (33)
```

Identical to pre-edit baseline. Pure comment edits, no behavioral changes.
