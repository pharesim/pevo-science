# ARCHITECT-STUBS-MD-SWEEP-HEADERS — Add date-scoped group headers to frontend/public/messages/STUBS.md so translators can prioritize batches and stale entries become detectable

**Owner:** architect
**Created:** 2026-04-22 (surfaced by FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND review 2026-04-22)
**Priority:** P3

## Context

`frontend/public/messages/STUBS.md` has accumulated 335 lines of per-locale per-key entries across several i18n-stubbing sweeps (FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP, FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND, plus earlier upgrade.failed + login + signup + seedPhrase + resetPassword + recover + orcid-callback entries). All entries live under a single `## Pending` heading.

With no sweep grouping or date annotations:
- Translators can't prioritize a batch (which entries are freshest? which are blocking a specific user-visible flow?).
- Stale-entry detection is manual — keys removed from source but left in STUBS.md sit indefinitely.
- Future sweeps append to the bottom, further eroding structure.

## Goal

Retroactively segment `frontend/public/messages/STUBS.md` into date-scoped sections:

```markdown
## Pending

### Added 2026-04-18 (FE-UPGRADE-ERROR-SANITIZE)
- en: upgrade.failed: "Upgrade failed. Please try again."
- de: upgrade.failed: "Upgrade failed. Please try again."
...

### Added 2026-04-21 (FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP)
- en: settings.passwordUpdateFailed: "..."
...

### Added 2026-04-22 (FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND)
- en: login.loginFailed: "..."
...
```

Steps:

1. Survey the existing 335 lines. Group by the sweep that introduced the key (visible via `git log --follow frontend/public/messages/en.json`).
2. Re-segment the file with date + task slug headers per group.
3. Write a brief "How to use this file" paragraph at the top explaining the grouping convention and the expected translator workflow: pick a section, translate English value into the target locale, strike through or remove the entry when done.
4. Document the convention in `agents/ui/CLAUDE.md` Internationalization section so future UI sweeps add their own dated header on append rather than merging into the bottom.

## Non-goals

- Doing the actual translation of stub entries. Translators own that; this task is structural hygiene only.
- Renaming or consolidating i18n keys. Pure file-structure task.
- Removing entries whose keys no longer exist in source. Separate stale-detection pass if wanted.

## Acceptance

- `STUBS.md` has a dated sub-heading per sweep that contributed entries.
- Top-of-file note describes the convention.
- `agents/ui/CLAUDE.md` Internationalization section documents the append-with-header expectation.
- Git history preserved via sensible commit structure (ideally one commit per archeological sweep group, so `git log` tells the re-segmentation story).

## Coordination note

This is architect-owned because STUBS.md hygiene is an i18n-coordination concern that spans all UI sweeps over time. Light lift — a single architect commit is sufficient.

## [TODO Architect]

None — self-contained.
