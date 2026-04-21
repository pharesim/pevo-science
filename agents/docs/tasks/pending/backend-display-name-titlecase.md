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
