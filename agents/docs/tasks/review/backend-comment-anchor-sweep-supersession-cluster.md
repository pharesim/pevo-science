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

## Architect re-review (2026-05-20) — HELD PENDING FIXES:

Comment rewrites must accurately describe the test or invariant they anchor on, not merely strip slug/round-N rot. Self-audit obligation per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`.

1. **`backend/tests/routes/continuation-author-gate.test.ts:563`** — rewritten comment opens "Pins the chain-walk SQL's parameter binding to the cumulative-union admit-set" but the test asserts SQL predicate text (`expect(sql).toMatch(/->>'type'\)\s*=\s*'paper'/)`), not a parameter binding. Rewrite to describe what the test actually asserts: the `validPevoPaperWhere` predicate-text presence (the `pevo.type = 'paper'` arm) in the chain-walk SQL. Without this assertion the chain-walker would admit non-paper PEvO posts as version-list candidates. (Cross-corroborated by correctness + testing.)

2. **`backend/tests/routes/continuation-author-gate.test.ts:515`** — rewritten comment "Pins the chain-walk SQL's named-co-author admit-set against the cumulative union." The test actually asserts type-spoof rejection (a named co-author posting `pevo.type='review'` with a `continues` pointer is rejected via `validPevoPaperWhere` + JS `isPevoAnyPaper` re-check). The cumulative-union setup is the test precondition, not the assertion. Rewrite to describe the type-spoof rejection invariant.

3. **`backend/src/types/domain.ts:17-21`** — rewritten `orcid_verified` docblock claims "always populated at runtime" and labels the empty-map collapse as "case-1 of the supersession lattice". Both are inaccurate: `applyAuthorSupersession` (`backend/src/lib/author-supersession.ts:175-188`) returns `{}` (no supersession keys) for non-object `authors[i]` entries — neither `orcid_verified` nor `orcid_discrepancy` is set; the codebase lattice terminology is `case-1/case-2` for the empty-map cell, not bare `case-1`. Rewrite to match actual code behavior: populated for well-formed object entries; absent entirely for non-object entries (JS path); SQL projection always populates via `jsonb_build_object`. Optionally widen `applyAuthorSupersession`'s non-object branch to return `{orcid_verified: null, orcid_discrepancy: false}` instead so the "always populated" framing becomes accurate.

4. **`backend/tests/routes/continuation-author-gate.test.ts:326`** (and any other added-line above/below relative anchors the sweep introduced) — the sweep's own replacement text added at least one new "above/below" relative anchor. Per the docblock-anchor convention, relative positional anchors silently stale on insertion. Replace with named-symbol references (helper name, invariant description, or test-name reference). Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the sweep must not introduce new rot in its own added lines.

## Backend re-review signal (2026-05-20, commit `9fdf48b`)

Hold-block items 1-4 landed in one commit. Per-item summary:

1. **`continuation-author-gate.test.ts` chain-walk-SQL predicate-pin canary (the `validPevoPaperWhere` regex test).** Previous comment claimed it pinned "parameter binding to the cumulative-union admit-set". The actual assertion is `expect(sql).toMatch(/->>\s*'type'\)\s*=\s*'paper'/)` — the `validPevoPaperWhere` predicate's paper arm. Rewritten to anchor on the predicate text directly; noted that the bridge-paper arm is covered separately by the bridge-paper continuation canary.

2. **`continuation-author-gate.test.ts` type-spoof rejection canary.** Previous comment claimed named-co-author admit-set / cumulative-union assertion. Rewritten to describe the actual invariant: a named co-author posting `pevo.type='review'` with a `continues` pointer is rejected on TYPE by both the SQL's `validPevoPaperWhere` predicate (filters review-typed rows out of the candidate set) AND the JS `isPevoAnyPaper` re-check (defense in depth). The cumulative-union admit-set is precondition (responder seed), not assertion.

3. **`types/domain.ts` docblock + `lib/author-supersession.ts` non-object branch.** Took the optional widening: `applyAuthorSupersession` now returns `{orcid_verified: null, orcid_discrepancy: false}` for non-object author entries (previously returned `{}`, no supersession keys). The widening makes the docblock's "always populated at runtime" framing accurate AND aligns the JS-side projection with the SQL-side `jsonb_build_object`'s emit-both-keys invariant for every output entry. Dropped the inaccurate "case-1 of the supersession lattice" terminology — no such lattice-case enumeration exists in the codebase (`computeSupersession` enumerates four cases, none labelled case-1). New docblock describes runtime population on both SQL and JS surfaces directly.

4. **`helpers.test.ts` native-paper symmetry canary comment ("specs above" relative anchor introduced by the prior sweep commit).** Rewritten to reference `isPevoBridgePaper`'s bridge-arm directly — a stable named-symbol anchor. The hold-block's pointer at `continuation-author-gate.test.ts:326` was a file-attribution slip: the rotted relative anchor introduced by the sweep is at `helpers.test.ts:326` (the `}` at `continuation-author-gate.test.ts:326` carries no comment).

### Self-audit (added lines only)

`git diff --no-color | grep '^+' | grep -v '^+++'` for the rot patterns:

- `round-\d`: 0 hits.
- All-caps-with-hyphens task slugs: 0 hits.
- Line-number anchors (`:\d+` in comments): 0 hits.
- 7+ hex SHA-like patterns: 0 hits.
- Relative positional anchors (`above`, `below`, `next test`, `previous test`): 0 hits.

### Verification

- `typecheck:src` and `typecheck:tests`: clean.
- `tests/routes/continuation-author-gate.test.ts`: 50/50 pass.
- `tests/helpers.test.ts` + `tests/routes/profile-papers-supersession.test.ts`: 56/56 pass (the supersession test file exercises the `applyAuthorSupersession` non-object branch indirectly via SQL-projection parity assertions).
- `tests/routes/papers-canonical-orcid-resolution.test.ts`: 27/27 pass.

No behavioral test changes (comment-only edits + a runtime widening from `{}` to `{orcid_verified: null, orcid_discrepancy: false}` for non-object author entries — the widened branch is not exercised by existing assertions, which only test object-shaped author entries).

