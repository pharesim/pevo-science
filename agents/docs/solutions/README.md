# Solutions store catalog

This file is the catalog for `agents/docs/solutions/`. It is not a learning. `/ce-compound-refresh` excludes it from staleness review and rewrites its rows mechanically whenever an action renames, moves, consolidates, replaces or deletes an entry it lists. `/ce-compound` does not know it exists, so the row for a new entry is added by hand (see "Maintenance" below).

## Shape of the store

- Category directories stay flat. `conventions/` holds most entries and is searched by grep, by frontmatter (`module`, `component`, `tags`) and by filename. No sub-directories are opened under a category: entries cross-link by relative path, and code files under `backend/` and `frontend/` cite `agents/docs/solutions/` paths that the refresh does not rewrite when a file moves, so a move costs more than it returns.
- One artifact attracting many entries is normal in a flat store of this size and is not by itself a category-shape problem. `backend/src/routes/papers.ts` is named in more entries than any test file. A catalog section below is opened only for an artifact whose entries are about the artifact's own machinery, so that a reader who opens it needs the set rather than one entry, and only once that set is large enough that grep alone returns a wall (roughly eight or more).
- The refresh's category-shape observation about the canary cluster below is settled by this file. It will still appear in a refresh report, because such observations are report-only; the person running the refresh dismisses it against this section.
- Filenames of new entries carry no date suffix. `/ce-compound` says so explicitly, and the `date:` frontmatter field is the canonical creation date. Entries created before that rule took hold keep their dated names and are not renamed, because a rename touches citations the refresh does not rewrite. Both spellings are correct for their own file: cite an entry by the name it has, never by the name a rule would give it.

## Maintenance

- A `/ce-compound` run that writes an entry naming a catalogued artifact appends the row in the same commit, whatever role runs it. The store is architect zone, so a backend or ui run commits with `[skip-zone-audit]`, as it already does for the entry itself.
- The architect reconciles each section at every `/ce-compound-refresh`: grep for the artifact, add any entry the catalog misses, drop any row whose file is gone.
- A row is the entry's relative path and the question it answers, one line. Rows are ordered by the entry's `date:`, so a section reads as the ladder a maintainer climbs.

## backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts

A source-scanning canary: it reads the tree as text and asserts that `accounts.updated_at` is written by exactly two statements. Its reader is a program of its own, and these entries are about that program rather than about the column. Read them together when the canary is red for a line that looks innocent, green for a line that should have reddened, or slow.

Query keys: frontmatter `module` containing `backend/tests/eslint` (wider than this set, it also covers sibling canaries and the shared enclosing-symbol helper), tag `canary-tests` (wider still), or `grep -l no-accounts-updated-at-write-outside-signup-finalize conventions/*.md` (exactly this set).

| Entry | Answers |
|---|---|
| [source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md](conventions/source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md) | Why the licensed writer set is tallied per `file#symbol` rather than per file: a licensed file would absorb its own second writer. |
| [source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md](conventions/source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md) | Why every scan reads comment-blanked text, why a doubtful span is read rather than blanked, and why a prescribed mutation-probe list confirms only the items it names. |
| [new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md](conventions/new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md) | Why a new give-up path in the reader gets a sentinel of its own: reusing one that means the opposite lands the damage at the untouched consumer, which reads it as reaching. |
| [shared-constant-unification-is-not-membership-coverage-2026-09-16.md](conventions/shared-constant-unification-is-not-membership-coverage-2026-09-16.md) | Why the live arm and its fixture helper sharing one constant does not verify the constant's membership. |
| [sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md](conventions/sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md) | How a grammar question behind a pattern is settled: aim the statement at a relation that does not exist on the live server, and what a brief to a subagent touching that server must say. |
| [backtracking-probe-terminator-must-defeat-the-pattern-tail-2026-09-16.md](conventions/backtracking-probe-terminator-must-defeat-the-pattern-tail-2026-09-16.md) | How to read a cost probe: a zero reading may not have engaged, the terminator must defeat that pattern's own tail, and the growth curve is the signal, though a linear curve is still judged by its per-character cost. |
| [belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md](conventions/belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md) | Why a guard downstream of a rule turns that rule's mutants green, and how to keep a defence-in-depth layer inside detection logic pinnable. |
| [canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md](conventions/canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md) | Why the reader takes its TypeScript facts from the parser and is compared with it at every line end, after four hand-written fixes each proved incomplete. |
| [a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split.md](conventions/a-parsers-line-is-not-the-readers-line-unless-built-from-the-same-split.md) | Why the parser's per-line answers are re-indexed into the reader's own line array before use, and why a sibling's use of the parser's line API is not precedent. |
| [differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger.md](conventions/differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger.md) | How a base-versus-head differential's regressions are triaged after a fix removes a compensating misread, and when the chase stops. |
| [a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md](conventions/a-readers-bound-restated-at-n-sites-reads-as-sufficient-at-each.md) | How a reader's bound is described in prose: restated at N sites it reads as sufficient at each, so say where the bound actually holds, and have sites defer a multi-part condition to its definition by name rather than restate it. |
