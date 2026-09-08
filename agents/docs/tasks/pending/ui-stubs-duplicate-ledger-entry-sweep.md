# Collapse the remaining duplicate STUBS.md ledger entries

**Owner:** ui
**Created:** 2026-09-08

Surfaced while clearing the same defect for `upgrade.sessionChangedBeforeCleanup`
under the custody-upgrade subject-pin task. That fix was scoped to its own key by
the hold that prescribed it; these five are the rest of the class, in blocks that
task never edited.

## Why

`frontend/public/messages/STUBS.md` enforces a per-key grep invariant: one line
per locale still awaiting translation. Five keys break it by being listed under
more than one sweep heading, so a grep returns two or three times the lines it
should and a translator or a pending-work scan processes the key repeatedly.

All five are still pending, and the resolution follows directly from
`agents/docs/solutions/conventions/i18n-stubs-added-vs-updated-scope-never-translated-keys-2026-06-09.md`:
a never-translated key whose English is reworded is reworded **in place** under
its original `### Added` heading. It does not earn a second entry, and it does
not earn an `### Updated` heading, because there is no prior translation for the
reword to invalidate.

Verified 2026-09-08 against all sixteen locale files: every one of the five keys
holds a value byte-identical to `en.json` in all fifteen non-English locales, so
none has ever been translated.

## Current state

| Key | Lines | Headings |
|---|---|---|
| `upgrade.keychainImportWarning.posting` | 30 | `Added 2026-04-28 (UI-KEYCHAIN-API-MISUSE)`, `Added 2026-05-16 (UI-KEYCHAIN-WARNING-COPY)` |
| `upgrade.keychainImportWarning.active` | 30 | same two |
| `upgrade.keychainImportWarning.memo` | 30 | same two |
| `upgrade.keychainImportFailed` | 30 | `Added 2026-05-04 (UI-KEYCHAIN-API-MISUSE)`, `Added 2026-05-16 (UI-KEYCHAIN-WARNING-COPY)` |
| `upgrade.backendTimeout` | 45 | `Added 2026-05-15 (ui-keychain-api-misuse)`, `Added 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)`, `Updated 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)` |

165 lines where 75 belong. 90 surplus.

## Scope

1. Collapse each of the five keys to a single set of fifteen per-locale lines
   under its **earliest** `### Added` heading, which is the one that recorded the
   key first: `Added 2026-04-28` for the three `keychainImportWarning.*` keys,
   `Added 2026-05-04` for `keychainImportFailed`, `Added 2026-05-15` for
   `backendTimeout`. Drop the later duplicate runs.

2. Two headings go empty and should be deleted with their duplicate lines, per
   the file's own "A section with no remaining lines can be deleted entirely":
   `### Added 2026-05-16 (UI-KEYCHAIN-WARNING-COPY)` (holds nothing but the four
   duplicates) and `### Updated 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)`
   (holds nothing but `backendTimeout`). Two headings survive with their other
   keys intact and must not be disturbed otherwise: `Added 2026-05-17` keeps
   `upgrade.proofRejected`, and every unaffected heading keeps everything.

3. `backendTimeout` carries narrative prose under two of its three headings, and
   the surviving entry must keep the substance of both. The `Updated 2026-05-17`
   block is the one that matters: it records that the English names the **new,
   post-rotation** recovery phrase explicitly, because the prior copy left users
   at risk of retrying with their original phrase. That instruction is
   translation-relevant and must not be lost when the heading is deleted. The
   other four keys carry no narrative and are a pure mechanical de-dup.

4. Rewrite the surviving `backendTimeout` narrative as a standing brief rather
   than a changelog. Both existing blocks are revision histories, and one of them
   ("Translators who already started on the round-2 `Added` entry should
   retranslate") is vacuous for a key nobody has translated, as well as carrying
   a round-number citation. The `Added 2026-05-15` block is self-contradictory on
   its face: it sits under a 2026-05-15 heading and describes a revision made
   "after the initial 2026-05-15 stub". State what the English says and what must
   survive translation; do not narrate how it got there.

## Acceptance criteria

1. For each of the five keys, `grep -cE '^[a-z]{2}: <key>$' STUBS.md` returns
   exactly 15. Report all five counts.
2. No locale-key pair appears twice anywhere in the file. A full-file check
   (`grep -E '^[a-z]{2}: ' STUBS.md | sort | uniq -d`) returns nothing.
3. No locale JSON file is modified. This is a ledger-only change; every English
   value stays exactly as it is.
4. Total ledger lines drop by exactly 90, from 3615 to 3525, and the set of
   distinct keys is unchanged at 235.
5. Every heading not named in Scope 2 keeps its exact prior contents, verified by
   comparing per-heading key composition before and after rather than by reading
   the diff.
6. The surviving `backendTimeout` entry still tells a translator that the copy
   names the new post-rotation phrase and why.

## Notes

Scope deliberately stops at the duplicate-entry class. Two adjacent classes were
measured on 2026-09-08 and are both clean, so there is no wider ledger sweep
hiding behind this one: no ledger key is missing from `en.json` (zero stale
entries from renames or removals), and no ledger line names a locale that has
actually been translated (zero lines a translator forgot to delete). A single
`### Updated` heading with one set of lines is not evidence of this defect and
should be left alone; a re-stub overwrites the locale value with English, so a
legitimately-updated key is indistinguishable by value from a never-translated
one, and only the duplication is diagnosable.

No test reads `STUBS.md`, so the acceptance criteria above are the only
verification available. Run them as commands, not by eye.
