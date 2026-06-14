---
title: "Mechanizing the comment-anchor convention: a prefix-scoped pre-commit DIFF gate"
date: 2026-06-14
category: conventions
module: .githooks pre-commit gate + comment-hygiene convention + backend/src vitest canary
problem_type: convention
component: development_workflow
severity: medium
related_components:
  - testing_framework
  - documentation
applies_when:
  - "Extending, tuning, or debugging the .githooks/pre-commit comment-anchor gate"
  - "Designing any commit/CI gate that must distinguish rot slug tokens from legit hyphenated-uppercase tokens in source"
  - "Deciding diff-gate vs whole-tree-clean for a convention that the existing tree already violates pervasively"
  - "Reconciling the pre-commit gate with the backend/src no-stale-comment-anchors.test.ts vitest canary"
  - "A contributor hits the gate on a legitimate fixture line and needs the escape hatch"
tags:
  - comment-anchor
  - anchor-rot
  - pre-commit-hook
  - diff-gate
  - allowlist
  - false-positive
  - slug-prefix
  - githooks
---

# Mechanizing the comment-anchor convention: a prefix-scoped pre-commit DIFF gate

## Context

The root `CLAUDE.md` "Comment anchors" convention (no task-slug citations, round/hold
ordinals, `Option X.N` labels, source line-number cites, or `tasks-archive`/`see task`
redirects in production/test source) was enforced only by manual review-time grep plus a
narrow standing vitest canary. The recurring failure, documented in
[[sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08]], is that a sweep
greps one slug-prefix family (`BACKEND-` only) and reports false-clean while rot under other
prefixes (`BE-`, `SEC-`, `JFR-`, `UI-`) survives. The architect task to mechanize this had
genuinely-unsettled design decisions — that is *why* it was not already automated — centered
on one hard problem: a gate that fires on real rot but is too noisy to keep enabled is worse
than no gate.

`backend/tests/eslint/no-stale-comment-anchors.test.ts` already existed as a standing
whole-tree-clean canary, but it scans **`backend/src/` only** and covers only the
`{backend,ui,architect}` slug families (plus round-hold, `Option X.N`, and line-cites). The
gap: `backend/tests/` and `frontend/**` are unscanned and carry ~600 pre-existing accepted
anchors, and the wider slug families are uncovered everywhere.

## Guidance

Add a `.githooks/pre-commit` gate that fails on **newly-added** rot under
`frontend/{src,tests}` and `backend/{src,tests}`, built on three decisions that resolve the
hard parts:

**1. Scope detection to known task-slug PREFIX families, never a generic `[A-Z]+-[A-Z]`.**
This is the decision that makes the gate viable. The source trees mix rot slugs with many
legitimate hyphenated-uppercase tokens: `SHA-256`, `AES-256-GCM`, `HMAC-SHA512`, `ISO-8601`,
`ECMA-262`, `BCP-47`, `CASE-WHEN`, `LIMIT-1`, `SET-NX`, `LEFT-JOIN`, the base58 WIF character
class `[1-9A-HJ-NP-Za-km-z]` (the `HJ-NP` fragment), prose hyphenations (`CARVE-OUT`,
`ALL-CAPS`). A generic uppercase-hyphen matcher would flag all of them and force a huge,
fragile allowlist — and the moment it is too noisy, someone disables it. Because **none of
those legit tokens begin with a task-slug prefix**, matching only `backend|ui|architect` (case-
insensitive, 2+ kebab segments so `ui-button` is spared), `BE-`/`JFR-` (uppercase shout form),
and `SEC-` (only `SEC-<n>-<ALPHA>` / `SEC-<ALPHA>-<ALPHA>`, sparing bare `SEC-<n>` header IDs)
sidesteps the allowlist minefield entirely. Verified: zero false positives over the current
tree (601 detections, all genuine rot; empty residue after subtracting recognizable rot
tokens).

**2. Make it a DIFF gate (added lines only), not whole-tree-clean.** `backend/tests` and
`frontend/**` are saturated with ~600 accepted pre-existing anchors. A whole-tree gate would
block every unrelated commit until a full sweep lands, so it is **deferred** until those trees
are swept clean. A diff gate is the only shape that can be enabled *today*.

**3. Complement, do not duplicate, the existing canary.** The `backend/src/` vitest canary
stays the whole-tree-clean guarantee for that one tree; the hook extends *new-rot* coverage to
`backend/tests` + `frontend/**` and the wider `BE-/SEC-/JFR-` families, intentionally
overlapping on `backend/src` for defense in depth (the hook catches a new anchor at commit
time, before the canary would catch it at test time).

Escape hatches (never `--no-verify`, which is forbidden for agents without authorization):
a per-line `anchor-allow` marker exempts a single legitimate line (a regex self-test fixture
— including the canary's own `LINE_CITE_RE.test(...)` lines — or an intentional stack-trace
assertion), and `PEVO_ANCHOR_GATE=off git commit ...` skips a whole commit. The `.githooks`
precedent is [[commit-zone-audit-hook-2026-04-30]]; activation is the same one-time
`git config core.hooksPath .githooks`, and the gate ships with a mirrored
`.githooks/tests/test-pre-commit.sh` (26 cases).

## Why This Matters

The gate ends the manual-sweep cycle for the rot classes it covers: the next author who reaches
for a slug citation or a `auth.ts:401` line cite in a scanned dir gets a red commit, not a clean
grep they never ran. The prefix-scoping insight is the reusable lesson — when a gate must
separate a "bad" token family from "good" siblings that share a surface shape, scoping by the
bad family's *distinctive prefix* is far more robust than enumerating an allowlist of every good
token, because the allowlist is unbounded and drifts while the prefix set is small and stable.
A noisy gate is a deleted gate; designing for near-zero false positives is what keeps it enabled.

## When to Apply

- Extending the gate to a new slug family: add it to the prefix set in `anchor_violation()`,
  add a planted-positive and an FP-neighbor case to `test-pre-commit.sh`, and re-run the
  tree residue sweep to confirm zero new false positives before committing.
- Two classes are intentionally **not** gated and must stay that way unless re-justified: the
  terminal `~<n>` tilde line-approximation (its FP tuning against `~50ms` / `~28,800` /
  `~3.5 days` is intricate and lives in the canary's `LINE_CITE_RE`), and bare `SEC-<n>`
  security-requirement / E2E coverage-matrix header IDs (`E2E-AUTH-N`, `READ-N`, ...), which
  are legitimate stable references.
- Promoting to a whole-tree-clean gate: only after the `backend/tests` + `frontend/**` sweeps
  land; until then the diff shape is mandatory.

## Examples

A generic matcher floods on legit tokens; the prefix-scoped matcher does not:

```bash
# Naive (unusable): flags SHA-256, AES-GCM, CASE-WHEN, HJ-NP, SEC-001 header IDs ...
grep -E '\b[A-Z][A-Z0-9]+-[A-Z0-9]+'

# Prefix-scoped (zero false positives over the tree): only task-slug families.
grep -iE '\b(backend|ui|architect)-[a-z0-9]+(-[a-z0-9]+)+(\.md)?'   # 2+ segments spares ui-button
grep -E  '\bBE-[A-Z0-9]+(-[A-Z0-9]+)+|\bJFR-[A-Z0-9]+|\bSEC-([A-Z]+-[A-Z]|[0-9]+-[A-Z])'
```

Durable-store references are the convention's allowed class, so a `solutions/` or
`api-contracts/` path is exempt from the slug arm only (structural arms still apply):

```
// see agents/docs/solutions/conventions/backend-foo-bar-2026-01-01.md   → allowed
// fixed per backend-foo-bar (since archived)                            → rejected
```

## Related

- [[sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08]] — the
  under-enumeration failure this gate mechanizes; its widened pattern is the starting regex.
- [[commit-zone-audit-hook-2026-04-30]] — the `.githooks` + `core.hooksPath` precedent this gate
  follows (a second commit-time staged-diff audit alongside the zone audit).
- [[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]] — why slug citations are
  forbidden in source in the first place.
- [[docblock-anchor-stable-symbols-not-line-numbers-2026-05-15]] — the line-number-anchor rot
  class the line-cite arm screens for.
- Root `CLAUDE.md` "Comment anchors" — the convention, now pointing at this gate.
