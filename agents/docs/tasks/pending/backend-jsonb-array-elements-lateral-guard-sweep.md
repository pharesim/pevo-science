# BACKEND-JSONB-ARRAY-ELEMENTS-LATERAL-GUARD-SWEEP — migrate WHERE-clause `jsonb_typeof='array'` guards to CASE-WHEN at SRF argument position

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced during `/ce-code-review` of `backend-self-review-exclusion-everywhere` round-4)
**Priority:** P2

## Context

The round-3 architect hold on `backend-self-review-exclusion-everywhere` flagged that `reputation.ts:paper_resolved_votes` had unguarded `jsonb_array_elements(... -> 'authors')` and would cascade-fail the daily reputation cycle on a single chain post with non-array `pevo.authors`. The round-4 implementer fix wrapped the argument in a CASE-WHEN `jsonb_typeof = 'array'` guard at the SRF argument position. Subsequent `/ce-code-review` revealed that **Postgres evaluates `CROSS JOIN LATERAL` BEFORE the WHERE filter** — meaning sibling sites that defend with a `WHERE jsonb_typeof(...) = 'array'` clause after `CROSS JOIN LATERAL jsonb_array_elements(...)` are NOT actually protected. The SRF expansion raises before the WHERE filter can short-circuit.

The reputation-cycle cascade-fail sites (`citing_papers` CTE + `authorsWithSupersessionSelect` helper) are covered by the round-4 hold on `backend-self-review-exclusion-everywhere`. This task covers the **per-user-fail sibling sites** that have smaller blast radius (per-request crash, not cycle-wide) but the same diagnosis.

## Affected sites (per audit of HEAD)

Grep `jsonb_array_elements` across `backend/src/` and verify each call uses CASE-WHEN at SRF argument position. Sites discovered during the round-4 review:

### WHERE-clause guard, ineffective for LATERAL (must migrate)

1. **`backend/src/routes/profile.ts:143`** — `CROSS JOIN LATERAL jsonb_array_elements(... -> 'citations')` with WHERE-clause `jsonb_typeof=='array'` guard. Per-user citations fetch crash on non-array `pevo.citations`.
2. **`backend/src/routes/stats.ts:72`** — same pattern, same `citations` field, same per-user blast radius.

### No guard at all (must add)

3. **`backend/src/notification-queries.ts:329`** — notification arm 6a, unguarded `jsonb_array_elements(... -> 'citations')`. Per-user notification GET fails for the recipient. Pre-existing per round-3 architect's deferred-to-triage flag.
4. **`backend/src/notification-queries.ts:358`** — notification arm 6b, same.

### Already correct (CASE-WHEN at SRF argument position — no action, reference shape)

- `backend/src/hafsql.ts:371` (helper `excludeSelfReviewWhere` — the reference implementation, hardened in round-1 + round-2 of `backend-self-review-exclusion-everywhere`).
- `backend/src/reputation.ts:607-614` (paper_resolved_votes — landed in round-4 of the same task).

### Audit step

Run `grep -rn 'jsonb_array_elements' backend/src/` and confirm each site is either in the "already correct" list above, in this task's migrate-list, or is exempt with documented reasoning. Any new sites discovered get added to this task before the implementer commits.

## Goal

Migrate the 4 enumerated sites to the canonical CASE-WHEN-at-SRF-argument-position pattern, mirroring the reference implementation in `excludeSelfReviewWhere`:

```sql
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(<row>.json_metadata -> $tag -> '<field>') = 'array'
       THEN <row>.json_metadata -> $tag -> '<field>'
       ELSE '[]'::jsonb
  END
) AS <alias>
```

The now-redundant WHERE-clause `jsonb_typeof` guards at sites 1 + 2 can be removed (they were doing no work pre-fix and continue to do no work post-fix; deleting them tightens the SQL).

Sites 3 + 4 add the same shape from scratch.

## Acceptance

1. **All 4 sites migrated** to CASE-WHEN-at-SRF-argument-position with the canonical shape above.
2. **Behavioral test per blast-radius class.** Add at least one synthetic-VALUES + real-Postgres test per file (one for the citations-array shape across profile/stats, one for the notification-queries arm) under `backend/tests/` exercising the cascade-fail-defense — assert that the route or query does NOT raise on a malformed `citations` shape (null, string, integer, object) and returns the expected empty result. Reuse the carve-out clause-(c) header pattern from `hafsql.test.ts:661+`.
3. **Audit document.** Add a brief comment at the top of the test file (or a markdown note in the task's re-review signal) enumerating the audit results — every `jsonb_array_elements` site in `backend/src/` and its disposition (migrated / already correct / exempt with reasoning).
4. **`tsc --noEmit` clean. `npm run lint` clean. Targeted tests pass against real Postgres.**

## Out of scope

- Cycle-cascade sites (`citing_papers` CTE + `authorsWithSupersessionSelect`) — covered by the round-4 hold on `backend-self-review-exclusion-everywhere`. Coordinate so this task's audit step doesn't double-count or block on the sibling's fixes.
- Changes to upstream broadcast validation (e.g., reject malformed `pevo.citations` at publish time). The chain is the source of truth; defense lives at read time.
- Reputation-algorithm doc-sync — architect-zone, lands at archive.

## Coordination

- Sequencing: this task can land BEFORE the round-5 of `backend-self-review-exclusion-everywhere` (the sites are disjoint), OR after (cleaner — the audit step then includes the round-5 fixes as "already correct" references).
- Risk class: same as round-4 hold #1 on `backend-self-review-exclusion-everywhere`. Per `defense-in-depth-canary-must-pin-each-layer-2026-05-07`, each migrated site needs its own per-layer canary.

## Source

- `/ce-code-review` of `backend-self-review-exclusion-everywhere` commit `ba95a4a` (2026-05-16, architect re-review round-4):
  - reliability R-1 (P1, conf 90) — `citing_papers` CTE
  - adversarial #1 (P1, conf 85) — `authorsWithSupersessionSelect`
  - adversarial #2 (P1, conf 80) — notification-queries citations
  - learnings researcher — LATERAL evaluation order trap catalogued in `pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md`

## Cross-references

- `agents/docs/solutions/conventions/pg-jsonb-null-vs-sql-null-use-jsonb-typeof-2026-05-12.md` — the canonical convention this task instantiates.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — per-layer canary requirement.
- `backend-self-review-exclusion-everywhere` round-4 hold items 1 + 2 (sibling cycle-cascade fixes).

## Backend implementation signal (2026-05-16, worktree-agent-a63c3c89c4ff8ebf2)

All 4 migration sites + audit landed. Parent re-took over after worker subagent was killed mid-flight (before the notification-queries canary file landed); the parent finished the notification-queries canary, fixed a JS template-literal terminator bug introduced by backticks inside SQL comments at the migrated profile.ts and stats.ts sites, and committed.

**Sites migrated (WHERE-clause guard → CASE-WHEN at SRF argument position):**

- `backend/src/routes/profile.ts` citations CTE — pre-fix WHERE-clause `jsonb_typeof = 'array'` (placebo, fires after LATERAL) replaced with CASE-WHEN at the `jsonb_array_elements(...)` argument; redundant WHERE clause removed.
- `backend/src/routes/stats.ts` total_citations subquery — same shape, same fix.
- `backend/src/notification-queries.ts` arm 6a CROSS JOIN LATERAL (formerly line 329) — pre-fix had NO guard at all; added CASE-WHEN at SRF arg.
- `backend/src/notification-queries.ts` arm 6b CROSS JOIN LATERAL (formerly line 358) — same.

**New behavioral canaries (synthetic VALUES + real Postgres, per carve-out clause-(c)):**

- `backend/tests/routes/citations-lateral-guard-canary.test.ts` — covers profile.ts + stats.ts citations CTE shapes. 5 specs: 4 malformed-shape negatives (jsonb null, string, integer, object), 1 well-formed positive control, 1 mixed-batch (well-formed + malformed) regression guard.
- `backend/tests/notification-queries-lateral-guard-canary.test.ts` — covers arm 6a + arm 6b shapes. 5 specs of the same structure as the citations canary.

**Audit (per acceptance #3, full enumeration of `jsonb_array_elements` in `backend/src/`):**

- `backend/src/hafsql.ts:371` (`excludeSelfReviewWhere` NOT EXISTS) → already correct, reference implementation.
- `backend/src/hafsql.ts:732` (`authorsWithSupersessionSelect`) → OUT OF SCOPE; tracked by `backend-self-review-exclusion-everywhere` round-4 item 2.
- `backend/src/reputation.ts:607` (`paper_resolved_votes` NOT EXISTS) → already correct (landed round-4 of sibling task).
- `backend/src/reputation.ts:793` (`citing_papers` CTE CROSS JOIN LATERAL) → OUT OF SCOPE; tracked by `backend-self-review-exclusion-everywhere` round-5 item 1.
- `backend/src/notification-queries.ts` arm 6a + arm 6b → MIGRATED in this task.
- `backend/src/routes/profile.ts` citations CTE → MIGRATED.
- `backend/src/routes/stats.ts` total_citations → MIGRATED.
- `backend/src/routes/ipfs.ts:265` (`jsonb_array_elements_text` on `c.json_metadata -> 'image'`) → EXEMPT (different SRF on the IPFS pinner path; non-pevo-namespaced field; per-pinner blast radius rather than user read path).
- `backend/src/ipfs-cleanup.ts:38` (same SRF as above) → EXEMPT, same disposition.

The full audit is duplicated as a docblock comment at the top of `backend/tests/routes/citations-lateral-guard-canary.test.ts` and `backend/tests/notification-queries-lateral-guard-canary.test.ts` so future maintainers can find it from either test entry-point.

**Verification gates:**

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only the 2 pre-existing `@typescript-eslint/no-explicit-any` warnings in `seed-phrase.ts`, unrelated).
- Targeted vitest deferred to the parent's serialized run after all in-flight backend tasks merge back.

**Notes:**

- The initial worker edit on profile.ts and stats.ts wrapped SQL identifier names with backticks inside the JS template-literal comments, prematurely terminating the JS template. Parent dropped the backticks in favor of bare identifier names (matching the convention already established by the round-3 fix on `backend-self-review-exclusion-everywhere` item #8).
- No `git mv` from `pending/` to `review/` was performed in this worktree; parent serializes that after all in-flight workers merge.

---

## Architect re-review (2026-05-18) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `6fdb460` with 9 personas (correctness/adversarial on Opus; testing/maintainability/project-standards/performance/reliability/kieran-typescript/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md). The 4-site CASE-WHEN-at-SRF-arg migration is mechanically sound: every malformed JSONB shape (jsonb null, SQL null, string, integer, object) falls through to `'[]'::jsonb` and produces zero LATERAL rows; canary mutation-kill verified (remove CASE-WHEN → `jsonb_array_elements` raises on non-array argument → tests fail); carve-out clause-(c) compliance confirmed in both canary headers. User-triaged 2026-05-18; 3 docblock-quality items bundled below (all touch the same canary headers in the same edit pass).

### Items held (must fix before archive)

1. **(P2 maintainability+learnings, cross-reviewer anchor 100)** Docblock line-number rot in both canary test file headers. Both `backend/tests/routes/citations-lateral-guard-canary.test.ts` and `backend/tests/notification-queries-lateral-guard-canary.test.ts` duplicate a 9-site audit table with absolute line-number anchors (`hafsql.ts:371`, `reputation.ts:607`, `routes/profile.ts:147`, `routes/stats.ts:82`, `routes/ipfs.ts:265`, `ipfs-cleanup.ts:38`, etc.) plus tilde-approximations (`now ~337`, `now ~373`) that acknowledge the rot but do not resolve it. Per `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, anchor on stable symbol/CTE/function names.

   Fix: rewrite the audit table to use stable anchors only. Suggested replacements: `excludeSelfReviewWhere` (hafsql.ts), `paper_resolved_votes NOT EXISTS` (reputation.ts), `authorsWithSupersessionSelect` (hafsql.ts, out-of-scope sibling), `citing_papers CTE CROSS JOIN LATERAL` (reputation.ts, out-of-scope sibling), `citations CTE` (routes/profile.ts), `total_citations subquery` (routes/stats.ts), `arm 6a / arm 6b of fetchNotificationsFromHaf` (notification-queries.ts), `jsonb_array_elements_text on c.json_metadata -> 'image'` (ipfs.ts + ipfs-cleanup.ts, EXEMPT). No line numbers, no `~N` approximations.

2. **(P2 maintainability M1, anchor 75)** Audit table duplicated across both canary file headers. The 9-site enumeration appears verbatim in two places, doubling rot exposure and forcing every future audit update to land in two files. Pick one canonical home (`citations-lateral-guard-canary.test.ts` is the natural pick since it covers more migrated sites) and replace the duplicate in the sibling file with a one-line cross-reference: `// See citations-lateral-guard-canary.test.ts header for the full jsonb_array_elements audit.`

3. **(P3 learnings, anchor 50, bundled because zero-marginal-cost in the same edit pass)** Round-N citations referencing sibling tasks rot on archive. Both canary headers contain references like "landed round-4 of the sibling task", "tracked by `backend-self-review-exclusion-everywhere` round-4/5 item 2", "round-5 item 1". When the sibling task archives, the round numbers lose meaning and the slug becomes a dead pointer (archive truncates from the bottom at 250 lines). Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`.

   Fix: replace round-N + slug references with behavioral descriptions. Suggested: "covered by the `excludeSelfReviewWhere` reference implementation", "tracked alongside the reputation-cycle cascade audit", "the cycle-cascade `citing_papers` CTE is fixed separately", etc. Drop the round-N qualifiers and slug pointers; keep the behavioral content.

### Items dismissed during architect triage (recorded for transparency)

- (P3 adversarial #1, anchor 35) Array-of-primitives (`[1, 2, 3]`) passes the array guard then relies on downstream `->>` null-tolerance — dismissed: no constructible exploit, theoretical.
- (P3 adversarial #2, anchor 40) Silent swallow of malformed-row signal in stats.ts (post-fix, malformed rows contribute 0 silently) — dismissed per `feedback_pevo_logging_minimal`: PEvO log volume is too high; adding an observability hook here is preemptive.
- (P2 performance, anchor 60) CASE-WHEN double-traversal of the `-> 'citations'` path — dismissed: same complexity as the prior WHERE-guard placebo; cached behind hafCache (5-min stats, 30s profile/notifications); not introduced by this diff; below confidence gate.
- (P3 testing T1, anchor 75) arm-6b canary structurally identical to arm-6a — dismissed per `feedback_dismiss_preemptive_test_hardening`; both canaries pin per-call-site mutation, no behavioral risk class is missed by re-using the spec shape across the two arms.
- (P3 learnings) IPFS exemption is structural-rationale-only rather than mechanical-audit-anchored — dismissed below confidence gate: structural rationale (different SRF function `jsonb_array_elements_text`, non-pevo-namespaced `image` field, IPFS-pinner blast radius rather than user read path) is already stronger than enumeration-only; adding a `grep -rn jsonb_array_elements_text` invariant statement would be preemptive.

### Items handed to separate architect actions (still on the architect's backlog)

- (Architect carry-forward, cluster-D) Convention-recurrence: surface `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15` and `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15` in `agents/backend/CLAUDE.md` so they reach implementer write-time context per `conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md`. Lands in a separate architect commit during cluster archive.

### Re-review signal

When items 1–3 land, `git mv` this file back to `tasks/review/`. Round-2 architect re-review scopes `/ce-code-review` to commits since `6fdb460`. Anchor: header-only edits to the two new canary test files; single commit reasonable.

---

## Backend re-review signal (2026-05-18, worktree-agent-a1cfdf4c8b511ac21 cherry-picked to main)

Round-1 hold items 1-3 landed in a single header-only commit on the two canary test files.

- **Item 1 (P2 anchor 100):** Audit table in `backend/tests/routes/citations-lateral-guard-canary.test.ts` rewritten to use stable symbol/CTE/arm anchors only — `excludeSelfReviewWhere`, `paper_resolved_votes NOT EXISTS`, `authorsWithSupersessionSelect`, `citing_papers CTE CROSS JOIN LATERAL`, `citations CTE`, `total_citations subquery`, `arm 6a / arm 6b of fetchNotificationsFromHaf`, `jsonb_array_elements_text on c.json_metadata -> 'image'`. All `file.ts:NNN` line refs and `~N` tilde-approximations removed.
- **Item 2 (P2 anchor 75):** Duplicated 9-site audit in `backend/tests/notification-queries-lateral-guard-canary.test.ts` replaced with the one-line cross-reference: `// See citations-lateral-guard-canary.test.ts header for the full jsonb_array_elements audit.` The canonical-home header notes the cross-reference relationship so future maintainers find the canonical pointer from either entry-point.
- **Item 3 (P3 anchor 50):** Round-N + sibling-slug references dropped from both files (`round-4 of the sibling task`, `round-4/5 item 2`, `round-5 item 1` all gone). Replaced with behavioral descriptions: "the cycle-cascade `citing_papers` CTE is fixed separately alongside the reputation-cycle cascade audit", etc.

**Verification:**

- `cd backend && npx tsc --noEmit -p tests/tsconfig.json` — clean (0 errors total — the 249-error backlog the task body referenced was cleared by the `backend-tests-typecheck-residual-drift` archive on 2026-05-18; both canary files are 0 errors specifically).
- `cd backend && npm run lint` — clean (lints `src/` only; test files not in lint scope).
- Targeted vitest deferred to the parent's serialized post-fan-out run.

**Notes:**

- Header-only edits; no test body specs, no production code, no task-file hold-block edits.
- Worker subagent in worktree `worktree-agent-a1cfdf4c8b511ac21` produced the commit; parent cherry-picked onto main.

---

## Architect re-review (2026-05-19) — HELD PENDING FIXES (round 2)

`/ce-code-review` on commit `f1f5410` with 6 personas (correctness on Opus; testing, maintainability, project-standards, kieran-typescript, learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md). The three round-1 hold items landed verbatim: stable-symbol audit table, canonical-home + cross-reference, dropped round-N qualifiers. Self-violation audit passes — no new line-numbers, slug citations, SHAs, or round-N markers in the rewritten text. User-triaged 2026-05-19; one substantive item held below; reliability/maintainability soft observations recorded under "dismissed."

### Items held (must fix before archive)

1. **(P3 testing, cross-reviewer anchor 75)** Audit-table dispositions for `citing_papers` CTE and `authorsWithSupersessionSelect` are stale. The canonical-home audit table in `backend/tests/routes/citations-lateral-guard-canary.test.ts` marks both as:

   ```
   - reputation.ts `citing_papers` CTE CROSS JOIN LATERAL
       → OUT OF SCOPE here; the cycle-cascade `citing_papers` CTE is
         fixed separately alongside the reputation-cycle cascade audit.
   - hafsql.ts `authorsWithSupersessionSelect`
       → OUT OF SCOPE here; the cycle-cascade `authorsWithSupersession`
         helper is fixed separately alongside the reputation-cycle
         cascade audit.
   ```

   Verified false against HEAD: the SQL at `reputation.ts` `citing_papers` CTE (in the `CROSS JOIN LATERAL` clause) and `hafsql.ts` `authorsWithSupersessionSelect` (in the `jsonb_array_elements(... WITH ORDINALITY)` SRF argument) both already use the canonical CASE-WHEN-at-SRF-arg form: `CASE WHEN jsonb_typeof(...) = 'array' THEN ... ELSE '[]'::jsonb END`. The fixes landed via the cycle-cascade sibling task (since archived). The audit-table commentary was never re-synced when the cycle-cascade fixes archived, leaving the canonical home telling maintainers these sites are pending when they're actually correct.

   Fix: re-sync both entries to the `already correct` disposition (matching the existing `excludeSelfReviewWhere` and `paper_resolved_votes NOT EXISTS` entries' form). Suggested shape:

   ```
   - reputation.ts `citing_papers` CTE CROSS JOIN LATERAL
       → already correct (CASE-WHEN at SRF arg).
   - hafsql.ts `authorsWithSupersessionSelect`
       → already correct (CASE-WHEN at SRF arg).
   ```

   The sibling cross-reference at `backend/tests/notification-queries-lateral-guard-canary.test.ts` is just a pointer to the canonical home, so it inherits the fix without separate edit.

### Items dismissed during architect triage (recorded for transparency)

- (P3 kieran-typescript / maintainability, anchor 50) Two audit-table anchors (`paper_resolved_votes`, `citing_papers`) cite SQL CTE labels that are invisible to the type system — a rename in the production SQL template literal would silently stale the docblock entry. Dismissed: CTE label names are stable across the recent reputation/hafsql churn, and the test bodies themselves embed these labels in their own SQL strings, so a rename surfaces as a test-breakage signal even if the docblock anchor goes stale. Below confidence gate for action.
- (P3 project-standards, informational) "reputation-cycle cascade audit" used as the behavioral anchor for the two stale entries reads as a semantic label for in-progress work rather than a stable exported symbol. Subsumed by item 1's resolution — both entries flip to `already correct` and the dangling forward-reference disappears.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-3 architect re-review scopes `/ce-code-review` to commits since `f1f5410`. Anchor: 2 audit-table-entry edits in a single test file's docblock; single commit reasonable.
