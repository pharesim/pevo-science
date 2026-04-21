# DOCS-LOCALE-STUB-CONVENTION — Document the i18n locale-stub convention

**Owner:** architect
**Created:** 2026-04-21 (surfaced by FE-UPGRADE-CREDENTIAL-WIPE round-2 project-standards review 2026-04-21)
**Priority:** P3

## Context

Multiple recent UI commits add new i18n keys to `frontend/public/messages/en.json` and then stub the same English string across 15 non-English locale files (`ar, cs, da, de, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`) as a placeholder pending translation. Examples: FE-UPGRADE-CREDENTIAL-WIPE commit `fd116e4` added `upgrade.failed` this way.

Neither root `CLAUDE.md` nor `agents/ui/CLAUDE.md` documents this convention. Future contributors have no written signal that:
1. English-in-non-English-locale strings are stubs, not final translations.
2. There's a tracking mechanism for which strings still need real translation.
3. When translations ARE landed, they should replace the stubs atomically per locale.

Without a convention, these questions recur on every i18n-touching commit.

## Goal

Add a short `## Internationalization` section (or subsection within an existing one) to `agents/ui/CLAUDE.md` documenting:

1. **Stub format.** Pick one:
   - **Raw English** (current practice) — simplest, but hard to grep for "unstubed strings" later.
   - `[UNTRANSLATED] <English text>` — greppable, but ships user-visible brackets until replaced. Requires a build-time stripping step.
   - `<English text>` with a sibling `_stubbed: true` marker object — greppable, ships clean, but complicates the JSON schema.
   - Recommended: **raw English + a tracked stub-list file** (`frontend/public/messages/STUBS.md` listing `<locale>: <key>` pairs pending translation, updated on every i18n-touching commit).

2. **When to stub vs. block.** Stubbing is acceptable for new features landing ahead of translation capacity. For renamed or restructured keys, update all locales atomically (translation memory carries over).

3. **Translation handoff.** Where does the translator find the stub list? Who owns the workflow?

## Non-goals

Implementing a translation workflow tool. Translating the existing backlog of stubs. Adding a lint step that enforces the convention (separate concern, file if needed).

## Acceptance

- `agents/ui/CLAUDE.md` has an Internationalization section with the chosen convention.
- If the "tracked stub-list file" option is chosen: `frontend/public/messages/STUBS.md` exists, seeded with the currently-stubbed strings.
- If a different option is chosen: the existing 15 locale files are brought into compliance with the chosen format.

## [TODO Architect]

1. Pick the stub format before writing the convention. Consult with the user on which tradeoffs matter (greppability vs. user-visibility vs. JSON schema complexity).
2. Decide whether to retrofit existing stubs or treat the convention as forward-only.
