# ARCHITECT-CUMULATIVE-UNION-DOC-EDITS — land the 4 [TODO Architect] doc edits inherited from BACKEND-MULTI-AUTHOR-CUMULATIVE-UNION

**Owner:** Architect Agent
**Created:** 2026-05-19 (architect, deferred at archive of `backend-multi-author-cumulative-union` round-3)
**Priority:** P1

## Context

`backend-multi-author-cumulative-union` (archived 2026-05-19 round-3 clean) prescribed 4 architect-owned doc edits at the round-1 backend signal under `[TODO Architect]`:

1. **`agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — REWRITE.** Currently describes the round-3 no-shrink rule + `headAuthorsCoverRoot` cover-check (superseded). Replace with cumulative-union semantics: display construction (cumulative union of `pevo.authors[].hive` across all chain posts, first-occurrence order, sub-field resolution rule — most-recent self-claim wins, else most-recent fallback); ORCID server-override for accredited hives + `orcid_claim_mismatch` audit event for divergent claims; chain-walk admit-set per-hop cumulative; "Drops are forbidden by construction" framing; Phase 2 layering (`author_accept` / `author_resign`); bridge-paper subsection. Round-2 hold also added: per-request scope of "drops forbidden by construction" invariant (explicit time-bounded scope so a future reader doesn't infer across-time permanence). Spans current lines 172-288 of `ARCHITECTURE.md`.

2. **`agents/docs/api-contracts/papers.md` — UPDATE the PaperDetail Notes section** for cumulative-union semantics on `authors[]`, ORCID server-override + audit event behavior, `accredited_authors` rebuild semantics.

3. **`agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — UPDATE the "Sites this convention applies to" section.** Continuation-post gate's predicate shifted from "set membership in root's authorized set" to "set membership in the cumulative chain authors[]"; structural rule preserved.

4. **`agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` rule #4 — APPEND a paragraph** noting that "Authors list is monotonic" is now reinforced by the cumulative-union construction (the union enforces monotonicity by construction; the rule no longer relies on a check-and-reject mechanism).

## Why deferred (not landed at archive of the parent task)

`backend-cumulative-union-listing-surfaces-parity` is in `tasks/pending/` (architect ratified Option 4 design 2026-05-19) and a sibling backend agent is actively implementing it in the working tree at commit `259d9cb`. That task extends the cumulative-union invariant from the **detail surface** (where the parent task closed it) to **listing / profile** surfaces via a shared `resolveChainCumulativeAuthors` helper + per-root Redis chain cache.

§ 2's rewrite should describe the cross-surface invariant in its final shape — not the detail-only intermediate state. Rewriting now would require a second rewrite when listing-surfaces lands; rewriting once after both tasks ship captures the full picture with no churn.

[BLOCKED by Backend] — Gated on archive of `backend-cumulative-union-listing-surfaces-parity` (currently in `tasks/pending/`). When that task archives, the sibling backend agent or architect `git mv`s this file from `tasks/blocked/` to `tasks/pending/` per CLAUDE.md rule #6.

## Acceptance

When unblocked:

1. `ARCHITECTURE.md` § 2 rewrite covers: cumulative-union (detail) + listing-surfaces parity (the new task's invariant) + per-request invariant scope + Phase 2 layering + bridge-paper carve-out + audit event schema.
2. `api-contracts/papers.md` PaperDetail Notes + PaperSummary Notes (listing-surfaces extends to PaperSummary too) cover the cumulative semantics.
3. The 2 convention-doc updates land (small paragraph-level edits).
4. Cross-references between the 4 docs are consistent.
5. After the doc edits land, re-check whether any production code comments cite `agents/docs/ARCHITECTURE.md § 2` against text that the rewrite removed; update or remove those comments per the comment-anchor conventions.

## Cross-references

- Parent task: `backend-multi-author-cumulative-union` (archived 2026-05-19 round-3 clean — see `tasks-archive.md`)
- Sibling task: `agents/docs/tasks/pending/backend-cumulative-union-listing-surfaces-parity.md` (architect ratification block landed 2026-05-19 commit `b5a0f92`)
- `agents/docs/ARCHITECTURE.md` lines 172-288 — § 2 Multi-Author Trust Model
- `agents/docs/api-contracts/papers.md` — PaperDetail / PaperSummary schemas
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — convention update
- `agents/docs/solutions/architecture-patterns/pevo-paper-version-chain-and-edit-semantics-2026-04-30.md` — rule #4 update
