# ARCHITECT-COMMENT-ANCHOR-CONVENTIONS-LOAD-BEARING-SURFACE — surface comment-rot rules where implementer agents load them

**Owner:** Architect
**Created:** 2026-05-18 (architect, surfaced by `/ce-code-review` on `ui-papers-orcid-null-fallback-verification` round 4)
**Priority:** P2

## Problem

Four `agents/docs/solutions/conventions/` entries codify load-bearing rules implementer agents need to apply when writing source-comment cross-references:

- `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` — `(see task <slug>)` framing in source comments is a rot class. Task files delete on archive (root CLAUDE.md rule #7), then fall off `tasks-archive.md` after the 250-line trim. The slug grep eventually returns nothing.
- `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — line-numbers, file-paths-with-line, and coordination artifacts in docblocks drift. Anchor on symbol names or behavioral descriptions instead.
- `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — a fix that purges anti-pattern X must verify the replacement form does not violate the same convention class. The architect's own hold-block writing is in scope.
- `hold-block-must-not-contradict-convention-docs-2026-04-22.md` — meta-rule: hold-block prescriptions are themselves subject to the conventions they reference.

`conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md` documents the structural cause: implementer agents (UI, backend, pinner) do not load `agents/docs/solutions/` at startup. The rules surface only via:

1. The architect's `/ce-code-review` invocations, where `ce-learnings-researcher` is always-on.
2. Architect hold-blocks that explicitly cite the convention path.

Both paths are reactive — the violation must already exist for the rule to surface, and the implementer pays for it via an extra round-trip. The 2026-05-18 round-4 review on `ui-papers-orcid-null-fallback-verification` was a textbook instance: the architect's own round-3 hold-block prescribed `(see task <slug>)` as the fix shape, contradicting the 2026-05-15 convention that had landed three days earlier. The implementer faithfully executed the prescription. `ce-learnings-researcher` caught it on round-4; nothing else would have.

`agents/backend/CLAUDE.md` already carries a `## Comment anchors` section codifying these rules in-zone for backend code (architect commit `1d3e4a1`, 2026-05-18). The UI agent has no equivalent. The root CLAUDE.md has no project-wide surface. The pinner agent has no surface.

## Goal

Lift the comment-anchor rules into the load-bearing CLAUDE.md surface so implementer agents apply them at write time, not after a hold-block round-trip.

Two reasonable shapes (architect picks during implementation):

- **(a) Mirror the backend `Comment anchors` section into `agents/ui/CLAUDE.md`** (and `agents/pinner/CLAUDE.md`). Copy the existing section, optionally swap zone-relevant examples (Alpine bindings, Vitest comments for UI; IPFS pin metadata for pinner). Pro: localized, no project-wide reading-cost increase. Con: triple maintenance — three CLAUDE.mds need to stay in lockstep when the rule evolves.
- **(b) Lift the rules into root `CLAUDE.md`** so all four agents load them at startup. Pro: single load-bearing surface, no triple-mirror drift risk. Con: root CLAUDE.md is already large; one more cross-cutting section adds reading cost for every agent on every startup.

A hybrid is reasonable: short summary in root pointing at the canonical `solutions/` entries; in-zone agent CLAUDE.mds carry the actionable rules with zone-relevant examples. Architect picks shape during implementation, not now.

## Acceptance

1. Pick (a), (b), or hybrid. Document the rationale in the implementation commit.
2. The chosen surface(s) cite the canonical `solutions/` paths as durable cross-references (and itself does not violate the conventions it documents — no SHA references, no task-slug citations to ephemeral artifacts; cite the convention file paths, which are durable).
3. If shape (a) or hybrid: update `agents/ui/CLAUDE.md` and `agents/pinner/CLAUDE.md`. If shape (b) or hybrid: update root `CLAUDE.md`. Verify the `.githooks/commit-msg` `allowed_for_agent()` architect zone still covers the touched paths (it does: architect already owns root CLAUDE.md and all `agents/*/CLAUDE.md`).
4. Smoke-test by re-reading the chosen CLAUDE.md surface and confirming the rule is actionable at-write — an implementer reading it cold should know not to write `(see task <slug>)` or `commit <SHA>` in source comments.

## Out of scope

- Lifting non-comment-anchor `solutions/` conventions into CLAUDE.md surfaces. This task is scoped to the comment-rot cluster only. Other categories (test-mock carve-outs, staging discipline, Hive schemas) have separate triage paths.
- `/ce-compound-refresh` to consolidate the cited `solutions/` entries — they are complementary (each closes a distinct rot class), not overlapping.
- Retro-applying the rule to pre-existing comments in `frontend/` / `backend/` / `agents/` source. The rule is forward-looking. Existing violations get fixed when their surrounding code is next touched.

## Source

- `/ce-code-review` on `ui-papers-orcid-null-fallback-verification` round 4 (2026-05-18), commit `dd6d2ad`. Learnings-researcher persona flagged the architect-prescription error and pointed at the four cited conventions.
- Architect round-4 hold-block on the same task at commit `8d0eddd` (this commit).
- `agents/backend/CLAUDE.md` `## Comment anchors` section at commit `1d3e4a1` (2026-05-18) — existing in-zone surface used as the prior-art reference for shape (a).

## Cross-references

- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md`
- `agents/docs/solutions/conventions/conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md`
- `agents/backend/CLAUDE.md` `## Comment anchors` section.
