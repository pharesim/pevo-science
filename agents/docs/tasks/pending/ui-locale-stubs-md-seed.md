# UI-LOCALE-STUBS-MD-SEED — Create `frontend/public/messages/STUBS.md` per new convention

**Owner:** ui
**Created:** 2026-04-21 (originated as architect-owned `docs-locale-stub-convention`; architect portion landed in `agents/ui/CLAUDE.md` § Internationalization on 2026-04-21. Remaining work is UI-owned since the file lives under `frontend/`.)
**Priority:** P3

## Context

The architect landed an i18n stub-tracking convention in `agents/ui/CLAUDE.md` § Internationalization. The convention:

- Stubs are raw English text in non-English locale files (no `[UNTRANSLATED]` brackets, no sentinel prefix).
- `frontend/public/messages/STUBS.md` is the single source of truth for pending translation work — one line per locale/key pair, shape `<locale>: <key>`.
- Translators remove the matching line when a real translation lands.
- Retrofit posture: forward-only. Stubs predating 2026-04-21 are not retroactively enumerated.

The remaining work is creating the `STUBS.md` file itself and seeding it with the known recent stub (`upgrade.failed` from commit `fd116e4`, stubbed across 15 non-English locales). The architect cannot create the file per the root-CLAUDE.md boundary rule ("NEVER create or edit files in `frontend/`"), so this lands as UI-agent work.

## Goal

Create `frontend/public/messages/STUBS.md` with:

1. A short header explaining the file's purpose + a pointer to `agents/ui/CLAUDE.md` § Internationalization.
2. A `## Format` block showing `<locale>: <key>` shape with one example.
3. A `## Pending` block enumerating the 15 known stubs for `upgrade.failed`:

```
ar: upgrade.failed
cs: upgrade.failed
da: upgrade.failed
de: upgrade.failed
es: upgrade.failed
fa: upgrade.failed
fr: upgrade.failed
he: upgrade.failed
it: upgrade.failed
nl: upgrade.failed
pl: upgrade.failed
pt: upgrade.failed
sv: upgrade.failed
tr: upgrade.failed
zh: upgrade.failed
```

Keep the file small — it's a ledger, not prose. Header + format block + pending list. No other content.

## Non-goals

- Enumerating other stubs that may exist in the 15 non-English locales (forward-only per the convention).
- Writing tooling or CI enforcement.
- Translating the 15 pending `upgrade.failed` entries — that is ongoing translator work, not this task's scope.

## Acceptance

- `frontend/public/messages/STUBS.md` exists with the 15 `upgrade.failed` entries.
- Header references the convention in `agents/ui/CLAUDE.md`.
- No changes to the 16 locale `.json` files (the convention is retroactive-compatible; the stubs are already there verbatim).

## [TODO Architect]

None — self-contained doc-file creation.
