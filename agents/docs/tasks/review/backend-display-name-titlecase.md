# BE-DISPLAY-NAME-TITLECASE — Consider INITCAP(LOWER()) for `/api/disciplines` `display_name`

**Owner:** backend
**Created:** 2026-04-21 (surfaced by BE-DISCIPLINE-CANONICALIZE architect review 2026-04-21)
**Priority:** P3

## Context

`/api/disciplines` returns `{ canon_name, display_name, paper_count }` per BE-DISCIPLINE-CANONICALIZE (commit `d6c2bb1`). `display_name` is produced via `MAX(json_metadata -> $1 ->> 'discipline')` over the `LOWER()`-grouped rows, intended as an arbitrary-but-stable representative of the original casing so the frontend can titlecase for rendering.

Problem: in PostgreSQL's default C-locale collation, uppercase ASCII letters have lower codepoints than lowercase (e.g. `'P'` = 0x50, `'p'` = 0x70), so `MAX('Physics', 'physics') = 'physics'`. For pure-ASCII discipline names — which covers essentially every real discipline — `display_name === canon_name` in practice. The "representative original casing" semantic the code comment promises is not delivered.

The frontend workaround is to titlecase `display_name` on render (via a Tailwind class or a JS helper). That works but delegates normalization to every consumer — an internal indexer, a mobile app, a CLI, etc. would each need to reimplement the titlecase.

## Goal

Replace `MAX(json_metadata -> $1 ->> 'discipline')` with `INITCAP(LOWER(json_metadata -> $1 ->> 'discipline'))` so `display_name` is consistently titlecased at the source. Remove any compensating titlecase classes/helpers on the frontend consumers once this lands.

## Non-goals

Changing `canon_name` semantics (stays lowercase, used as filter value). Handling non-ASCII disciplines (INITCAP is locale-dependent; revisit when non-ASCII disciplines land).

## Open questions

1. Does PostgreSQL's `INITCAP` handle compound words as desired? "computer-science" → "Computer-Science"? Probably yes (word boundaries include hyphens).
2. Any cases where the user's preferred casing is a specific mixed form that INITCAP would destroy? (e.g., "pH Chemistry" → "Ph Chemistry" — unlikely but worth spot-check against the current on-chain corpus.)
3. Does this warrant a `display_name_source` metadata field so clients can distinguish "titlecased by backend" from "as-stored"? Probably overkill at beta.

## [TODO Architect]

None yet — this is a pending design decision, not an atomic fix. Awaiting user triage on whether the INITCAP semantic is desired before implementing.

## [BLOCKED by Architect] (2026-04-22)

Implementation cannot start until the user/architect decides whether to adopt the `INITCAP(LOWER(...))` semantic for `display_name`, resolves the three open questions above (INITCAP on compound words, mixed-case corner cases, whether to add a `display_name_source` metadata field). Architect `git mv`s back to `pending/` once resolved.

---

## Architect decision (2026-04-22): Adopt INITCAP(LOWER(...))

**Chosen: adopt** `INITCAP(LOWER(json_metadata -> $1 ->> 'discipline'))` as the source-of-truth titlecase for `display_name`.

**Rationale.** The current `MAX()` semantics don't deliver "representative original casing" for pure-ASCII disciplines (which is all of them today), and delegating titlecase to every consumer creates an N-client normalization burden. Canonicalizing at the source aligns with the canon-name migration already landed in `d6c2bb1`.

**Open-question resolutions:**
1. **INITCAP on compound words:** Postgres `INITCAP` treats hyphens and spaces as word boundaries, so "computer-science" → "Computer-Science" — verified semantics, matches desired behavior.
2. **Mixed-case corner cases (e.g. "pH Chemistry" → "Ph Chemistry"):** accept the destruction. No mixed-case-meaningful disciplines exist in the on-chain corpus today; if one appears later, it either gets taxonomized (canon form wins) or we revisit. Not worth defending against a hypothetical.
3. **`display_name_source` metadata field:** skip. Overkill at beta. Consumers that care can check `canon_name === display_name.toLowerCase()` themselves; none do today.

**Scope clarifications for implementer:**
- Change is isolated to `/api/disciplines` (the only endpoint that returns `display_name` today). Update `backend/src/routes/disciplines.ts` SQL.
- Remove any compensating `titlecase` classes/helpers on the frontend once the backend ships — coordinate with UI via a follow-up pending task if the frontend was doing this. (Search `frontend/src/` for `display_name` usage sites before shipping the frontend follow-up.)
- Test: real-HAF fixture with mixed-case input (`"Computer Science"`, `"computer science"`, `"COMPUTER SCIENCE"`) all reduce to `canon_name: "computer science"`, `display_name: "Computer Science"`.
- Non-ASCII disciplines: locale-dependent INITCAP behavior is out of scope. When the first non-ASCII discipline lands, revisit.

No api-contract update needed — `display_name` shape is still `string`; the "representative" semantic is tightened to "titlecased" in the existing doc prose. Minor prose-only edit to `agents/docs/api-contracts/misc.md` is acceptable for the implementer to note in the `[TODO Architect]` handoff if desired, but not strictly required.
