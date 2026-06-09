---
title: "i18n STUBS.md: the Updated heading applies only to previously-translated keys, not merely existing key names"
date: 2026-06-09
category: conventions
module: frontend/public/messages/STUBS.md + agents/ui/CLAUDE.md
problem_type: convention
component: documentation
severity: low
applies_when:
  - Rewording an i18n key's English value when the key was never translated (still pending under a STUBS.md `### Added` heading)
  - A code review flags a missing `### Updated` heading on a key already listed under `### Added`
  - Deciding whether to move a key from `### Added` to `### Updated` after an English reword
tags: [i18n, stubs-md, translation-tracking, added-vs-updated, convention-scope, code-review-false-positive]
---

# i18n STUBS.md: the Updated heading applies only to previously-translated keys, not merely existing key names

## Context

`frontend/public/messages/STUBS.md` is the pending-translation queue for PEvO's i18n workflow. The sweep-heading rule in `agents/ui/CLAUDE.md` §Internationalization recognizes two heading variants for grouping stub entries:

- `### Added <date> (<TASK-SLUG>)` — new keys landing as stubs because translation capacity has not yet caught up.
- `### Updated <date> (<TASK-SLUG>)` — keys whose English value was reworded *after a prior translation existed*; the non-English locales are re-stubbed so translators know their translation memory may be stale.

The rule's terse imperative reads "Use `Updated` instead of `Added` when the key already existed," and its rationale clause says the distinction "tells translators that translation memory from the prior text may mislead and the value needs fresh review."

The trap: a `project-standards` code-review persona flagged, at 100% confidence, a *missing* `### Updated` heading when an i18n key's English was reworded. But that key had been born as a stub earlier in the same sprint and had never been translated. It still sat under its original `### Added` heading with all per-locale lines intact. The literal "when the key already existed" reading produced the wrong call, because it keyed on the existence of the key *name* rather than the existence of a prior *translation*.

## Guidance

The `### Updated` heading is determined by **translation status, not by whether the key name existed before**. Apply it only when a key has a prior *translated* value — meaning it once escaped the pending queue (its STUBS.md lines were removed because real translations landed in the locale files) and its English was later reworded.

Decision rule:

1. **Key still pending** — a STUBS.md line is present under a `### Added` block; no real translation exists in the locale files (the locales still hold the English stub). Reword the English **in place** under the existing `### Added` heading. Do **not** add a `### Updated` entry.
2. **Key already translated** — no STUBS.md line; real translations live in the locale JSON. English is later reworded. Add a `### Updated <date> (<TASK-SLUG>)` block and re-stub all non-English locales under it.

When re-stubbing locale JSON in place (either case), use a textual `fs` replace rather than a JSON parse-and-serialize round-trip, to avoid corrupting `\uXXXX` escapes in the locale files (see Related).

## Why This Matters

STUBS.md enforces a per-key grep invariant (`agents/ui/CLAUDE.md` §Internationalization): `grep <key> STUBS.md` must yield exactly one line per still-pending locale. The key already has its lines under `### Added`. Adding a `### Updated` block for a still-pending key **double-lists** it (e.g., 30 lines for 15 locales instead of 15), breaking the invariant — a translator or an automated pending-work scan would process the key twice and the per-key count would lie.

Beyond the count invariant, the `### Updated` heading's semantic purpose is to warn translators that *prior translation memory may mislead*. A never-translated key has no translation memory to mislead, so the warning is vacuous and dilutes the signal for genuinely stale translations. Moving the entry from `### Added` to `### Updated` would also falsely reclassify a brand-new key as previously-translated, corrupting the historical record embedded in STUBS.md.

This is why a code-review finding of "missing `### Updated`" on a reworded key is a **false positive when the key is still pending**: the literal rule text contradicts both the rule's own rationale and the grep invariant, and the correct resolution is to keep the key under `### Added`.

## When to Apply

- English value reworded for a key that is **still pending** (`grep <key> STUBS.md` returns lines): keep it under `### Added`, reword in place.
- English value reworded for a key that is **already translated** (`grep <key> STUBS.md` returns nothing, but the key carries non-stub values in the locale files): add a `### Updated` block and re-stub.
- A code-review finding that flags a "missing `### Updated`" for a reworded key: dismiss it when the key is still pending; the heading variant is set by translation status, not by key-name existence.
- Any in-place locale re-stub: use textual replacement, not a JSON round-trip.

## Examples

**Case 1 — key still pending: reword in place, no `### Updated`.**

`ui.publish.submitButton` was added as a stub recently and is not yet translated. STUBS.md holds its `### Added` lines and the locales still carry the English stub. The English copy changes from "Submit" to "Publish paper". Correct action: change the stub value in the locale files in place; the STUBS.md entry stays exactly as is under its existing `### Added <date> (<task-slug>)` block. `grep ui.publish.submitButton STUBS.md` still yields one line per locale.

**Case 2 — key already translated: add `### Updated`.**

`ui.publish.submitButton` was translated sprints ago; its STUBS.md lines were removed when real translations landed (`de: "Einreichen"`, `fr: "Soumettre"`). The English is later changed to "Publish paper". Correct action: add a fresh `### Updated <date> (<task-slug>)` block and re-stub the non-English locales with the new English. `grep ui.publish.submitButton STUBS.md` again yields one line per locale (the prior translated lines were already gone). Translators see the `### Updated` heading and know to discard translation memory from the previous English.

## Related

- `agents/ui/CLAUDE.md` §Internationalization — the authoritative source for the `### Added`/`### Updated` distinction and the per-key single-source-of-truth grep invariant. Keep that rule and this clarification consistent.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — the same family of trap: a convention-enforcing edit (here, adding `### Updated`) can itself introduce a new violation (here, breaking the grep invariant). Audit the replacement, not just the flagged site.
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` and `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — anchor-rot conventions; this doc deliberately anchors on the behavioral rule (translation status) and the stable references (`STUBS.md`, the CLAUDE.md section) rather than on the originating task slug or round.
- The Edit/Write `\uXXXX` corruption hazard for locale JSON (tracked in the agent memory store) is why in-place re-stubs use textual `fs` replacement rather than a JSON round-trip.
