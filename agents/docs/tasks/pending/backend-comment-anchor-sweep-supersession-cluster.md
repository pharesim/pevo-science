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

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` on round-2 commit `9fdf48b0` confirms all 4 architect-cited hold-block items landed cleanly. The implementer's self-audit on the added lines is honest (zero hits on round-N, slug citations, line-number anchors, SHA refs, date anchors, relative positional anchors). However, the cluster-review's maintainability persona — applying the whole-file audit per this task's existing acceptance criterion #4 — surfaced 12 pre-existing coordination-state rot sites in `backend/tests/routes/continuation-author-gate.test.ts` that the round-1 whole-file audit did not enumerate AND that round-2 therefore did not address.

These sites are in-scope per this task's existing acceptance criterion #4 ("Whole-file audit of the touched files — after rewriting cited sites, re-scan each touched file for additional rot the audit missed."). The same task-slug-citation convention at `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` applies: the cited task `backend-multi-author-cumulative-union.md` archived 2026-05-16; once it falls off the `tasks-archive.md` bottom (250-line cap), these citations become dead pointers, and the `Acceptance #N:` prefixes lose their referent entirely.

### Items

1. **`backend/tests/routes/continuation-author-gate.test.ts` ~L625** — section-banner comment cites an archived task slug:
   ```
   // ────────────────────────────────────────────────────────────────
   // Cumulative-union display canaries
   // (`backend-multi-author-cumulative-union.md` acceptance #9)
   // ────────────────────────────────────────────────────────────────
   ```
   **Fix:** rewrite the banner to anchor on the behavioral invariant the section pins, dropping the slug+acceptance-number citation. Suggested shape: `// Cumulative-union display canaries — verify detail.authors[] is the running union of every hive ever named across the chain, in first-occurrence order.` (anchors on the cumulative-union invariant, which is the load-bearing semantic of every spec in the section).

2. **`backend/tests/routes/continuation-author-gate.test.ts` 11 `Acceptance #N:` prefixes** at L715 #1, L731 #2, L758 #3, L782 #4, L800 #5, L850 #6, L898 #7, L922 #8, L1007 #9, L1045 #10, L1073 #12 (numbering skips #11, likely a deleted spec). Each prefix references the now-archived task's acceptance-criteria list and rots once that archive entry falls off `tasks-archive.md`. The behavioral description in each comment's body already stands alone — the `Acceptance #N:` prefix carries no remaining behavioral signal.
   **Fix:** strip the `Acceptance #N:` prefix from each of the 11 comments; the surrounding text (e.g., `chain [root, bob/v2]. Root has [alice, bob]; bob/v2 adds carol. Display authors[] = [alice, bob, carol] in first-occurrence order.`) is self-contained and survives without the prefix.

### Acceptance for re-review

- **Broadened acceptance grep (verbatim in signal block, not prose-claimed):**
  ```
  grep -inoE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|F[0-9]+[: ]|acceptance #|backend-[a-z0-9-]+\.md|\babove\b|\bbelow\b|\bnext test\b|\bprevious test\b)" \
    backend/src/lib/author-supersession.ts \
    backend/src/types/domain.ts \
    backend/tests/helpers.test.ts \
    backend/tests/routes/continuation-author-gate.test.ts
  ```
  Zero real rot hits expected. Acceptable surviving hits: durable backticked references to solution-doc paths (e.g., `cascade-fns-rethrow-permanent-errors-2026-05-16.md`), and any `\babove\b`/`\bbelow\b` substring matches inside string-literal log content or operator-visible discriminators (not in code comments). Every `backend-*.md`, `acceptance #`, `above`, `below` hit in a comment must be replaced with a behavioral anchor or stable-symbol reference.
- **Whole-file audit scope expansion**: the round-1 whole-file audit's enumeration was incomplete (it caught the 5 sites in the original scope table but missed the section banner at L625 and 11 `Acceptance #N:` markers below it). The round-3 audit must extend to the full ~2000-line file and surface any other coordination-state markers, slug citations, or relative positional anchors of the same class. Report the full audit's findings verbatim in the round-3 signal block.
- **Self-audit per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` (broadened)**: the suggested-fix replacements must not themselves introduce new round-N markers, slug citations, line-number anchors, SHA refs, date anchors, partial-strip stubs, orphan single-letter prefixes, dangling determiners, bare possessives, dangling prepositions, or relative positional anchors. The doc was just broadened to enumerate relative positional anchors explicitly.
- `npx vitest run tests/routes/continuation-author-gate.test.ts tests/helpers.test.ts tests/routes/papers-canonical-orcid-resolution.test.ts tests/routes/profile-papers-supersession.test.ts` with Docker IP env-var overrides per CLAUDE.md "Running Tests". Comment-only edits should not change any test outcome.

### Out of scope

- Findings the cluster-review surfaced but the architect dismissed at triage: the JS/SQL surface key-presence divergence on non-object author entries (the widened JS branch emits 2 keys; SQL emits 5), the helpers.ts double-cast `name: undefined` exposure when the non-object branch fires, and the related missing test coverage for the widened branch. The widening as prescribed (supersession-key alignment) was delivered correctly; the broader full-shape SQL/JS alignment is realization-blocked by the same malformed-author-entry scenario and is not in scope for this comment-hygiene task.
- The `orcid_verified` docblock's trailing `affiliation`-stripping note structural concern (single-reviewer, confidence 50, pre-dates this commit). Not part of this hold cycle.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

## Backend re-review signal (2026-05-20, round 3)

Round-3 hold items 1-2 landed. Whole-file audit expanded scope per the hold block surfaced 6 additional sites beyond the 12 cited; all 6 fixed in the same commit.

### Per-item summary

1. **Section banner at L625 (slug citation).** Rewrote the cumulative-union display canaries banner to anchor on the behavioral invariant: detail.authors[] is the running union of every hive ever named across the chain in first-occurrence order, with sub-fields resolved via most-recent self-claim (fallback to most-recent third-party claim), server-overridden ORCID for accredited hives, and drops silently retained by construction. The archived task slug + acceptance-number citation removed entirely.

2. **11 `Acceptance #N:` prefixes.** Stripped the `Acceptance #N:` prefix from each of the 11 cited comments (L715, L731, L758, L782, L800, L850, L898, L922, L1007, L1045, L1073; numbering skipped #11). The surrounding behavioral text in every site was self-contained — chain shape, expected display authors[], expected ORCID/name resolution, expected audit-event behavior — and survived the prefix removal without rewriting.

### Holistic full-file audit findings (additional sites beyond the cited 12)

Whole-file audit of `backend/tests/routes/continuation-author-gate.test.ts` (2339 lines) with the broadened grep surfaced 6 additional relative-positional-anchor sites not enumerated in the hold block. All 6 fixed in this commit per the hold-block acceptance ("Every `backend-*.md`, `acceptance #`, `above`, `below` hit in a comment must be replaced with a behavioral anchor or stable-symbol reference"):

- **L48 (docblock).** `(a) justification documented above` — replaced with `(a) justification: ... (per the Carve-out paragraph in this docblock)`. Anchors on the named "Carve-out" paragraph, not relative position.
- **L1195.** `The three integration canaries below pin all-null collapse ...` — replaced with `Three integration canaries in this describe block pin all-null collapse for each non-string runtime shape on head (empty-string, numeric, object).` Names the scope (describe block) and enumerates the three shapes.
- **L1730.** `(per the wall-clock test pair below: it exits silently at MAX_HOPS=50)` — replaced with `(exits silently when it hits MAX_HOPS=50)`. Drops the relative anchor; the depth-cap behavior is the behavioral statement.
- **L1792.** `// Chain-walk SQL count well below MAX_HOPS=50.` — replaced with `// Chain-walk SQL count much less than MAX_HOPS=50.` Numerical-comparison rephrase to avoid `below` substring match. (Borderline case: the original was a magnitude comparison, not a positional anchor, but rephrased proactively per the hold block's strict "every below hit in a comment" reading.)
- **L1944.** `// The chain-walk SQL count is bounded by the budget — well below MAX_HOPS=50.` — same rephrase to `much less than`.
- **L1969.** `// Suppress backward walker (same pattern as the slow-HAF canary above) ...` — replaced with `// Suppress backward walker (matching the slow-HAF wall-clock canary's responder shape) ...`. Anchors on the named canary class, not its position.
- **L2055.** `... both assertions below fail red.` — replaced with `... both the status-503 assertion and the wallClockEvents.length>0 assertion fail red.` Names the specific assertions, not a positional reference.
- **L2229.** `... per-version display canaries in the multi-version describe block above (continuation-chain seed); ...` — replaced with `... per-version display canaries in the `GET /api/papers/:author/:permlink — continuation chain-walk SQL gate` describe; ...`. Cites the actual describe-block name (verified via `grep '^describe' ...test.ts`) as a stable symbol.

Hit count = 8 lines fixed (the 6 unique sites above; L1730 contained both `below` and an implied positional anchor in one phrase; L1792+L1944 are sibling numerical-comparison rephrases).

No coordination-state markers (round-N, hold items, task slugs, SHAs, dates) remain in the file. No other relative positional anchors (`next test`, `previous test`, "spec just above", etc.) found.

### Self-audit (added lines only)

`git diff --no-color backend/tests/routes/continuation-author-gate.test.ts | grep '^+' | grep -v '^+++'` produced 39 added lines. Broadened grep against them:

- `round-\d`: 0 hits.
- All-caps-with-hyphens task slugs (`BACKEND-X-Y`, `BE-X`): 0 hits.
- Line-number anchors (`\.ts:\d+`, `\.js:\d+`): 0 hits.
- 7+ hex SHA-like patterns (`\b[0-9a-f]{7,}\b`): 0 hits.
- Date anchors (`2026-\d{2}-\d{2}`): 0 hits.
- Relative positional anchors (`\babove\b`, `\bbelow\b`, `\bnext test\b`, `\bprevious test\b`): 0 hits.
- `acceptance #`, `backend-*.md`: 0 hits.
- `hold #`, `F\d+[: ]`: 0 hits.

### Verification

Broadened acceptance grep across the four files:
```
grep -inoE "(round[- ]?[0-9]|hold #|BE-[A-Z_-]+|BACKEND-[A-Z_-]+|F[0-9]+[: ]|acceptance #|backend-[a-z0-9-]+\.md|\babove\b|\bbelow\b|\bnext test\b|\bprevious test\b)" \
  backend/src/lib/author-supersession.ts \
  backend/src/types/domain.ts \
  backend/tests/helpers.test.ts \
  backend/tests/routes/continuation-author-gate.test.ts
```
Output: empty (grep exit code 1, no matches). Clean.

- `npm run typecheck` (both `typecheck:src` and `typecheck:tests`): clean, no errors.
- Scoped vitest with Docker IP env-var overrides per CLAUDE.md "Running Tests":
  ```
  npx vitest run tests/routes/continuation-author-gate.test.ts tests/helpers.test.ts tests/routes/papers-canonical-orcid-resolution.test.ts tests/routes/profile-papers-supersession.test.ts
  ```
  Result: Test Files 4 passed (4); Tests 137 passed (137).

No behavioral changes — pure comment edits only. The vitest scope was the hold-block-specified four files; full-suite was not run per the task constraints.
