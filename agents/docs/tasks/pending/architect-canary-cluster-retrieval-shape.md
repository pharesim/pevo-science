# Eleven learnings name one canary, and the cite graph between them is partial

**Owner:** architect
**Created:** 2026-09-23

Filed by backend out of the `/ce-compound-refresh` pass over the `backend/tests/eslint`
cluster, at the user's direction. Two investigation batches raised it independently and
neither would recommend a shape, because neither had evidence for one. The refresh applied
its per-doc edits and left this open.

## Why

Eleven entries under `agents/docs/solutions/conventions/` name
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`. That
is the most-documented artifact in the store, out of 224 convention entries, and it is
still accreting at roughly one entry per review round.

Each entry is individually well-differentiated. The refresh tested every merge candidate
against the retrieval-value test and every one failed it: the entries answer genuinely
different questions about the same file (should this fact be hand-lexed, how are the
parser's per-line answers consumed, how is a cost probe read, how is a bound described in
prose, what does a differential's regression list mean, which assertion shape is
fail-closed, and so on). Consolidation is the wrong instrument here and the refresh did
not apply it.

What is weak is retrieval and the cross-reference graph, not the content:

- A maintainer who arrives with "why is my canary green" meets eleven doors into one room,
  and the door they pick decides which siblings they learn about, because each entry
  cross-references a different subset.
- The graph is partial in both directions. The refresh closed two gaps it had evidence
  for, and left others standing: the fail-closed sentinel entry and the restated-bound
  entry describe the same reader's machinery and are mutually silent.
- Three of the eleven landed within the last week, so whatever shape is chosen has to
  survive the next round rather than describe this one.

## Scope

1. Decide whether this cluster wants a shape beyond per-entry cross-links, and say which
   on the evidence rather than on taste. The two candidates the refresh surfaced are a hub
   entry for the file's learning ladder, and a standing "read these together" block in the
   canary's own header. They are not equivalent: a hub is one more entry that can itself go
   stale, while a header block sits in the file every implementer already opens and is
   maintained by whoever edits the canary.
2. If the answer is neither, say so in a form later refreshes can read, so the question is
   not re-raised every pass. The category-shape observation is report-only for a refresh,
   which means it returns until something settles it.
3. Whichever shape is chosen, decide who maintains it when entry twelve lands, and where
   that obligation is written down.
4. Consider whether this is a category-shape signal rather than a per-file one. If one
   artifact can accrete eleven entries in a directory of 224, the question of when
   `conventions/` wants sub-structure is the general form, and it is the architect's to
   answer.

## Acceptance criteria

1. A decision is recorded where the next refresh will meet it, naming which shape was
   chosen and why the alternatives were not.
2. If a shape is adopted, it exists: the hub entry, or the header block, with the eleven
   entries reachable from it.
3. The decision says what happens when the next entry on this file lands.

## Notes

The eleven at filing time:

- `a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split`
- `a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each`
- `backtracking-probe-terminator-must-defeat-the-pattern-tail`
- `belt-and-braces-guard-absorbs-upstream-mutation-pins`
- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer`
- `differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger`
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel`
- `shared-constant-unification-is-not-membership-coverage`
- `source-discipline-canaries-must-assert-at-call-site-not-file-granularity`
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage`
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation`

A related observation, same pass, that may or may not belong with this decision: five of
the 224 convention entries carry no date suffix in their filename, all written on
2026-09-22, by all three roles. The `/ce-compound` skill instructs no suffix while the
corpus overwhelmingly carries one, nothing enforces either, and each run's context
analyzer resolves the conflict on its own. Cross-links are by filename, so the store now
has two spellings a citation can take.
