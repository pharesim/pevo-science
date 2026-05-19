# BACKEND-COMMENT-ANCHOR-SWEEP-SUPERSESSION-CLUSTER — drop slug/round-N/line-number citations across the supersession-cluster files + stale docblock claims

**Owner:** Backend Agent
**Created:** 2026-05-19 (architect, surfaced by combined `/ce-code-review` of the supersession cluster — task 3 round-3 + task 4 round-2 + task 1 round-3; cross-corroborated)
**Priority:** P2

## Problem

Three concurrent cluster reviews surfaced surviving and newly-introduced rot anchors in the supersession-cluster source files. Two convention docs govern:

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — slug/round-N/"see task X" anchors rot when the cited task archives
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — the fix that removes rot must not add new rot in the same commit

Cluster review found:
- 2 NEW round-N citations introduced by task 3 round-3 (`ed7dfa9`) — direct convention-enforcing-fix-must-audit-its-own-new-code violation
- 1 pre-existing round-N citation in task 1 round-3 (`7b109a9`) at line 930 of the same test file the round-3 fix substantially modified — the sweep should have caught the surrounding context per the convention's "audit the whole modified file" reading
- 4 pre-existing round-N citations in the same task 1 file at lines 515, 563, 930, 1966 — flagged for the broader sweep
- 2 task-slug citations in the task 1 test file header (lines 4-5) — including the slug of a task being archived
- Slug citations in production source: `helpers.ts:348-351` (two slug+round-N), `profile.ts:96` (round-N), `helpers.test.ts:164, 230, 322, 326, 350` (5 round-N markers)
- 1 stale docblock claim on `PaperAuthor.orcid_verified` in `types/domain.ts:17-18` after `toPaperSummary`'s `orcidMap` became required (the docblock still says "absent when the caller didn't wire the orcid map")

All collected in one sweep task to avoid scope drift across multiple tiny rounds.

## Affected sites

### Self-violations introduced by task 3 round-3 (2026-05-17, commit `ed7dfa9`)

| File | Line | Current text | Replacement (anchor on behavior) |
|---|---|---|---|
| `backend/tests/routes/papers-canonical-orcid-resolution.test.ts` | 390 | `// The architect's round-3 hold prescribed this parity test.` | `// Pins the per-input parity between JS normalizeHiveAccount and the SQL JOIN's LOWER(TRIM(...)) regex guard.` |
| `backend/tests/routes/papers-canonical-orcid-resolution.test.ts` | 413 | `// Round-3 item 2: the list-endpoint 'accredited_authors' row builder and ...` | `// Pins the wrapping-primitive adoption at the list-endpoint accredited_authors row builder and the non-chain-detail branch.` (drop the `Round-3 item 2:` prefix, keep the rest) |

### Pre-existing rot in task 1's test file (cluster-review surfaced)

| File | Line | Current text | Replacement |
|---|---|---|---|
| `backend/tests/routes/continuation-author-gate.test.ts` | 4-5 (header) | `Pins the gate added in BACKEND-CONTINUATION-POST-AUTHOR-CONSENT-GATE and extended in BACKEND-MULTI-AUTHOR-CUMULATIVE-UNION` | `Pins the consent gate for continuation-chain admission, extended to cumulative-union author tracking.` |
| `backend/tests/routes/continuation-author-gate.test.ts` | 515 | `// Item 1 (round-2 hold): a named co-author ...` | `// Pins the chain-walk SQL's named-co-author admit-set against the cumulative union.` |
| `backend/tests/routes/continuation-author-gate.test.ts` | 563 | `// Item 1 (round-2 hold): the chain-walk SQL ...` | `// Pins the chain-walk SQL's parameter binding to the cumulative-union admit-set.` |
| `backend/tests/routes/continuation-author-gate.test.ts` | 930 | `... exactly the spoof surface the round-2 hold identifies.` | `... exactly the spoof surface this test pins.` |
| `backend/tests/routes/continuation-author-gate.test.ts` | 1966 | `... round-2 hold item 2.` | `... per the per-hive ORCID rule's accredited-vs-claim mismatch branch.` |

### Pre-existing rot in production source (cluster-review surfaced by maintainability M3 + M4)

| File | Line | Current text | Replacement |
|---|---|---|---|
| `backend/src/helpers.ts` | 348-351 | `by BACKEND-PAPER-DETAIL-CID-VALIDATE-ON-EMIT round-1 ... See task round-2 hold item 1.` | Anchor on the validate-on-emit invariant; drop slug + round-N references; describe behavior. |
| `backend/src/routes/profile.ts` | 96 | `and the round-2 hold #1 convention from reviews.ts` | Replace with the convention name or the behavioral invariant; drop the round-N + sibling-file reference. |
| `backend/tests/helpers.test.ts` | 164 | `Round-4 hold item 1` | Behavioral statement. |
| `backend/tests/helpers.test.ts` | 230 | `Round-2 hold item 1` | Behavioral statement. |
| `backend/tests/helpers.test.ts` | 322 | `Round-4 hold item 4(b)` | Behavioral statement. |
| `backend/tests/helpers.test.ts` | 326 | `the round-3 spoofed/legitimate bridge_paper specs above` | Behavioral statement referencing the bridge-paper canary's invariant. |
| `backend/tests/helpers.test.ts` | 350 | `Round-3 hold item 3` | Behavioral statement. |

### Stale docblock on PaperAuthor.orcid_verified

| File | Lines | Current text | Replacement |
|---|---|---|---|
| `backend/src/types/domain.ts` | 17-18 | `The supersession fields are optional on both PaperSummary and PaperDetail (absent when the caller didn't wire the orcid map; populated otherwise).` | `Always populated at runtime; collapses to null/false (case-1 of the supersession lattice) when the caller passes an empty accreditation map (e.g., test fixtures). Type-optional for partial-fixture construction.` |

## Acceptance

1. **Each cited site rewritten on stable behavioral anchors** (function name, invariant, behavioral condition) — no task slugs, no round numbers, no line numbers, no SHAs in the replacement text.
2. **Self-violation audit pass:** after the rewrites, grep the diff's own added lines for `round-\d`, slug citations (all-caps with hyphens), line-number anchors (`:\d+`), and SHA-like 7+ hex patterns. None should appear in production or test source.
3. **No behavioral changes to tests** — pure comment edits. Tests pass before and after with identical run output.
4. **Whole-file audit of the touched files** — after rewriting cited sites, re-scan each touched file for additional rot the audit missed. Document any intentional exclusions inline.

## Out of scope

- Rewriting `agents/docs/solutions/*` entries that themselves cite task slugs (those persist intentionally as historical anchors per the convention doc's body — slugs there are documentation, not code-rotting comments).
- Comment cleanup in files NOT listed above. If the grep audit at step 2 surfaces rot in other files, file separately rather than expanding this task's scope.

## Cross-references

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — primary convention.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — secondary convention (self-audit obligation).
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — replacement-text anchoring rules.
- Cluster review 2026-05-19 (architect-context): maintainability M1+M3+M4 + project-standards PS-001+PS-002+PS-01 + correctness residual + testing residual = cross-corroborated anchor 100 across all 3 reviews.
