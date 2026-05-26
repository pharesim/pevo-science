# UI-DEDUP-AUTHOR-HIVE-ON-REBROADCAST — drop duplicate-hive author entries before broadcasting a revision

**Owner:** UI Agent
**Created:** 2026-05-26 (architect, split from the `ui-author-list-prefill-on-revision` review)
**Priority:** P3

## Problem

When the revision form assembles `allAuthors` for broadcast in `handleSubmit`, it does no client-side dedup by `hive`. Two paths can produce a duplicate entry:

- The prior `authors[]` already contains two entries with the same `hive` (carried forward verbatim from the resolved set into `existingCoAuthors`).
- A new co-author row's `hive` collides with an existing author's `hive`.

The result is a redundant author entry in the broadcast `json_metadata.pevotest.authors`.

## Why this is low priority

The backend re-dedups author entries on read, so display surfaces are unaffected — the only artifact is a redundant entry in the on-chain metadata. The chain is SSoT; the backend dedup is the authority. This is a write-path cleanliness guard, not a correctness fix.

## Goal

Before broadcasting, drop author entries whose normalized `hive` duplicates an earlier entry (keep first occurrence; preserve order). Hive-less entries (`hive: null`) are never deduped against each other.

## Acceptance

- A prior author set with a duplicated `hive` broadcasts a single entry for that account.
- A new co-author whose `hive` matches an existing author does not add a second entry.
- Hive-less (`hive: null`) display-only credits are all preserved (not collapsed together).
- Author order is preserved (first occurrence wins).
- Unit test covering both duplicate sources.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 2 "Multi-Author Trust Model" — additions allowed, removals only via `author_resign`.
- Backend read-time dedup is the authority; this is a write-path cleanliness guard only.

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

Code review (`/ce-code-review`, 6 personas) on the implementing commit found the
core dedup correct and all acceptance criteria met. Testing and project-standards
came back clean. The review surfaced several normalization-key edge cases; all but
one were dismissed as corrupt-data-only and neutralized by the authoritative
backend read-time dedup. One item is held — it is the only finding with a
genuinely *new* failure mode rather than theoretical hardening:

1. **Guard the dedup key against a non-string `hive` so poisoned metadata cannot abort the whole revision broadcast.**
   The dedup key derivation in `handleSubmit` does `(a.hive || '').trim()...`. When
   an assembled author entry carries a non-string truthy `hive` (e.g. a number or
   object), `.trim()` throws a `TypeError`, which propagates out of `handleSubmit`
   and aborts the entire revision broadcast — a denial-of-edit. This is reachable
   via the raw-`json_metadata` author fallback (the branch that reads the head
   post's `pevo.authors` when the API's resolved `authors[]` is empty), which is
   broadcaster-controlled and un-validated. Before this change a non-string `hive`
   was harmlessly spread into the broadcast metadata; the new code converts that
   passthrough into a crash. Coerce a non-string `hive` into the hive-less branch
   (treat it as carrying no account identity: preserved, never collapsed) rather
   than calling string methods on it — e.g. derive the key only when `hive` is a
   string, otherwise treat the entry as hive-less.

   **Acceptance:** a unit test feeds an assembled author set containing a
   non-string `hive` (e.g. a numeric value) through `handleSubmit` and asserts the
   broadcast succeeds with that entry preserved (treated as hive-less), rather than
   throwing.

   Anchor any new comment on behavioral semantics (non-string hive → treated as
   hive-less), not on this task slug, round, or line numbers.

**Dismissed (no action — recorded for the implementer's context):**
- Self-lookup vs dedup normalization mismatch (strict `===` self-match vs normalized
  dedup key) dropping an edited self-entry on a mixed-case prior self-hive: requires
  a mixed-case Hive account name, which the protocol does not produce.
- Unicode-whitespace (NBSP/tab) `hive` collapsing a backend-distinct hive-less credit:
  requires a Unicode-whitespace-bearing `hive` on chain; backend re-adds on read.
- Inline key vs the shared `normalizeUsername` helper (missing `@`-strip): the gap is
  *under*-dedup (a redundant entry survives), which is the pre-change status quo and
  harmless given backend authority. Do NOT reach for the backend `normalizeHiveAccount`
  helper — it has reject-at-boundary semantics that diverge by design.

## UI re-review signal (2026-05-26, commit a286faa8)

Held item #1 landed. The dedup key in `handleSubmit` now derives only when `hive`
is a string (`typeof a.hive === 'string' ? a.hive.trim().toLowerCase() : ''`); a
non-string truthy `hive` is treated as hive-less (preserved, never collapsed)
instead of throwing a `TypeError` that aborted the whole revision broadcast. The
new code comment is anchored on the behavioral semantics, not the slug/round/SHA.

Acceptance unit test added to `frontend/tests/unit/pages-edit.test.js`: feeds an
assembled author set with a numeric `hive` through the dedup path and asserts the
broadcast succeeds with that entry preserved. Verified load-bearing (reverting the
guard fails it with `(a.hive || "").trim is not a function`). Full suite green
(59/59); `npm run build` passes.

Note on landing path: implemented in a fan-out worktree whose harness-assigned base
was ~141 commits stale and lacked the dedup feature commit (`4c91729e`); the worker
rebased onto current `main` before applying the guard, and the parent cherry-picked
the result onto `main` as `a286faa8` (so `4c91729e` is an ancestor). The 3
`_mountEditors` unhandled rejections vitest reports are pre-existing and unrelated
to this change.
