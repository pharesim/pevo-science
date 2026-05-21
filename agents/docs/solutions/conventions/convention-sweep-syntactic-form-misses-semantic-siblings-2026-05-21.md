---
title: "Convention sweeps scoped by syntactic form miss semantic siblings in different constructs"
date: 2026-05-21
category: conventions
module: backend/src + audit workflow
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Fixing a convention violation discovered via a planner-shape bug, data-shape bug, or any cross-cutting issue that manifests at multiple callsites"
  - "A sweep touches multiple sites and you are tempted to defer the rest as out-of-scope or `not on the hot path`"
  - "The convention has historically been idiomatic — most existing code already uses the now-bad shape"
  - "The failure mode is hard to test (performance, data-dependent, planner-dependent, environment-specific)"
  - "Proposing a structural test or ESLint rule to enforce a SQL-shape convention"
related_components:
  - database
  - tooling
tags:
  - sql
  - bitmapand
  - haf
  - audit-discipline
  - semantic-siblings
  - eslint-custom-rule
  - convention-sweep
---

# Convention sweeps scoped by syntactic form miss semantic siblings in different constructs

## Context

This entry exists because of an observed recurrence within a single working day. Commit `285e7c14` (2026-05-21) fixed a PostgreSQL BitmapAnd planner pathology in `activeAccreditationsCteBody` (backend/src/hafsql.ts): combining `cj.custom_id = $appTag` with `cj.block_num >= $genesis` against `hafsql.operation_custom_json_view` makes the planner choose a BitmapAnd plan that scans 49M+ operation rows on Mahdi's HAF instance. Per-call latency was 3.2s; the per-request walker budget (3000ms) was exhausted and every paper-detail request returned 503. The fix dropped the `block_num >= $genesis` floor.

The commit message named `activeVouchesCteBody` and `retractedPapersCteBody` as having the same shape but deferred them as "not on the paper-detail hot path." That audit was scoped to **CTE-body builder functions** — the syntactic form of the original offender. It missed two **inline `pool.query`** instances of the same SQL shape in `backend/src/routes/papers.ts`:

- The sequential `revoteResult` in `fetchEnrichmentFromHaf` (production-503 site)
- The revote query inside `Promise.all` in `batchResolveVotes`

Within hours, the `revoteResult` instance surfaced as a production 503 on `/api/papers/.../enrichment` — same "HAF walker budget exceeded; please retry" symptom as the paper-detail bug, on a sibling endpoint. The follow-up fix in commit `e31c984f` closed both inline instances plus the deferred `activeVouchesCteBody`.

The same toxic SQL combination bit production three times in under 24 hours: the original paper-detail bug, the enrichment-endpoint recurrence, and the two preventive sites swept by `e31c984f`. User-facing observation surfaces were "paper enrichment broken" and "reviews not loading on paper-detail" — both caused by the same root cause, because reviews on the detail page are populated exclusively by the lazy enrichment fetch.

HAF indexes are fixed external infrastructure managed by the HAF operator; adding or modifying an index to avoid the planner pathology is not available to PEvO. Dropping the floor filter is the only viable mitigation on the PEvO side.

## Guidance

### 1. Audit by semantic pattern, not syntactic form

When fixing a convention violation, enumerate every callsite that expresses the same **semantic pattern**, regardless of the code construct it lives in. The natural failure mode is to scope the search to whatever syntactic form the original bug lived in (e.g., "CTE-body builder functions"), miss every instance that expresses the same semantics via a different construct (inline `pool.query`, `Promise.all`-wrapped pool calls, helper-wrapped fragments), and ship an incomplete fix.

For SQL pattern audits: search for the *dangerous SQL combination* across all SQL string fragments, not for the *function shape* that happened to contain the original instance. For the BitmapAnd pathology specifically, the right enumeration shape is:

```bash
grep -rn "cj.custom_id" backend/src/ --include="*.ts" -A5
```

Then visually inspect every hit for the toxic co-occurrence with `cj.block_num >=`. Do not trust a sweep that only examined CTE-body builder functions — inline `pool.query` calls, `Promise.all`-wrapped query fragments, and helper wrappers all carry the same query bytes and trigger the same planner pathology.

General discipline: enumerate the dangerous **SQL combination**, not the **call-graph shape**. When in doubt, grep wider and triage the hits, rather than assuming the syntactic scope of the original bug covers the semantic scope of the pattern.

### 2. Back conventions with structural enforcement when feasible

A docstring on the original offender that explains the BitmapAnd reasoning is not load-bearing. A developer adding a new custom_json query in a different file will not open the originally-fixed function to read the warning. The same applies to notes in task files, architecture docs, and commit messages — they are visible only to someone who is already looking.

The cure shape that scales is an ESLint rule or a vitest structural test that fires on the toxic pattern at write-time, before the code ships. The existing precedent in this codebase is `pevo/no-bridge-paper-literal` in `backend/eslint.config.mjs`, tested by `backend/tests/eslint/no-bridge-paper-literal.test.ts`. A BitmapAnd-pathology guard would:

- Match `cj.custom_id` and `cj.block_num >=` co-occurring in the same SQL template literal (or string concatenation) across all `.ts` files under `backend/src/`
- Fail with a clear message pointing to the BitmapAnd documentation on `activeAccreditationsCteBody` and the known-safe remediation (drop the `block_num >=` floor)
- Be tested by the same structural-test pattern used for `no-bridge-paper-literal`

Convention prose without enforcement is an audit-tax on every future contributor and every future sweep. Structural enforcement converts the one-time discovery into a permanent gate.

## Why This Matters

The recurrence shipped within hours of the fix that documented the pattern. The blast radius was production 503s on two separate endpoints, visible to users as both broken enrichment and missing reviews on paper-detail pages. Without a structural guard, every new custom_json query authored by any agent or contributor is a fresh re-occurrence opportunity — and the failure mode is hard to catch in tests (performance-only, data-volume-dependent, planner-dependent on the operator's specific HAF statistics; local Postgres in CI is too small to trigger the BitmapAnd plan).

The asymmetry is stark: the toxic pattern was previously idiomatic. It appears in `consent-ops.ts`, several `reputation.ts` queries, and elsewhere — it was the conventional way to write a scoped custom_json query. Yesterday's convention is today's anti-pattern, and every existing callsite is a latent time bomb until swept. Convention documentation alone cannot track that.

This entry instantiates the structural-enforcement theorem from `[[enumerated-exemption-lists-are-drift-vectors-2026-04-28]]` at the SQL-pattern domain: hand-maintained enumerations (whether of exemption sites or "siblings to defer") drift and miss instances; structural enforcement does not.

## When to Apply

Apply this discipline when:

- Fixing a convention violation discovered via a planner-shape bug, a data-shape bug, or any cross-cutting issue that manifests at multiple callsites.
- The fix touches multiple sites and you are tempted to "defer" the rest as out-of-scope or "not on the hot path."
- The convention has historically been idiomatic — most existing code already uses the now-bad shape, meaning every new callsite authored without awareness will repeat it.
- The failure mode is hard to test (performance, data-dependent, planner-dependent, environment-specific).
- The fix requires a change that future contributors would not naturally know to make without having seen the failure.

## Examples

**Audit-by-syntax (wrong):**

> "I grepped for CTE-body builder functions in `backend/src/hafsql.ts`. Found 3 — fixed one, deferred two as out-of-scope."

Result: missed the two inline `pool.query` siblings in `backend/src/routes/papers.ts` entirely. Both went to production. One surfaced as a 503 within hours.

**Audit-by-semantics (right):**

> "I grepped for `cj.custom_id` and `cj.block_num >=` co-occurrence across all `.ts` files under `backend/src/`. Found 5 instances: 3 CTE bodies and 2 inline `pool.query` calls. Fixed all 5 in commit `e31c984f`."

Result: no further production recurrence from this shape.

**Convention-as-docstring (wrong):**

Docstring on `activeAccreditationsCteBody` explains the BitmapAnd reasoning and names the floor filter as unsafe. Reading the docstring requires opening that specific function. New code added in `papers.ts` or `consent-ops.ts` never sees the warning; the author has no signal until the 503 lands.

**Convention-as-structural-test (right):**

ESLint rule matching `cj.custom_id` and `cj.block_num >=` co-occurrence in the same SQL template literal fires at write-time in any `.ts` file under `backend/src/`. The violation surfaces in the editor and fails CI before the code ships. Precedent: `pevo/no-bridge-paper-literal` in `backend/eslint.config.mjs`, tested by `backend/tests/eslint/no-bridge-paper-literal.test.ts`. New violations cannot silently reach production.

## Related

- `[[enumerated-exemption-lists-are-drift-vectors-2026-04-28]]` — the structural-enforcement theorem (centralized helper + grep guard + lint/test rule). This entry is the SQL-pattern-domain instance of that theorem.
- `[[wrapping-primitive-exhaustive-call-site-audit-2026-04-22]]` — sibling discipline: grep by semantic property (the underlying primitive) across all source files, not by the wrapper that happened to be in the original finding.
- `[[cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14]]` — "widen your enumeration rings" complement. That entry widens by module/file; this one widens by syntactic construct.
- `[[sql-semantic-shift-cross-surface-audit-2026-05-12]]` — a different axis of SQL-audit completeness (semantics propagation when a gate changes meaning). Read alongside this entry to cover both failure modes.
- `[[eslint-custom-rule-unwrap-arms-need-compound-form-canary-2026-05-16]]` — in-repo precedent for structural enforcement (the canary-test pattern protecting an ESLint rule against accidental scope regression).
- `[[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]]` — sibling on audit completeness, different axis: that entry catches new violations the fix itself introduces; this one catches pre-existing violations the fix did not enumerate. Both are needed.
- Commits: `285e7c14` (initial fix, scoped to one CTE body, deferred two) and `e31c984f` (recurrence-driven sweep closing all remaining instances).
