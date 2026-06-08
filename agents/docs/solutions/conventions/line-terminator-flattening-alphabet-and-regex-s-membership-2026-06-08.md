---
title: "Line-terminator flattening: verify regex `\\s`-membership empirically, and size the alphabet to splitlines()-class consumers (not UAX#14)"
date: 2026-06-08
category: conventions
module: backend/src/lib/line-terminators.ts + backend/src/routes/papers.ts + backend/src/digest.ts
problem_type: convention
component: text-escaping
severity: medium
applies_when:
  - Editing the `LINE_TERMINATORS` constant or either `singleLine` helper
  - Adding a new citation export format (BibTeX/RIS/APA/CSL-JSON) or a new email-digest interpolation of a chain field
  - Writing or reviewing a docblock/comment that claims a codepoint is or is not a regex `\s` member
  - Flattening any broadcaster-controlled chain field (paper title, author names) for line-oriented output
tags: [line-terminators, file-format-injection, unicode, cite-export, email-digest, regex-whitespace, docblock-accuracy]
---

# Line-terminator flattening: verify regex `\s`-membership empirically, and size the alphabet to splitlines()-class consumers (not UAX#14)

## Context

PEvO flattens broadcaster-controlled chain fields (paper title, author names) to a single line before interpolating them into citation exports (`bibtexEscape`/`risEscape`/`singleLine` in `routes/papers.ts`, feeding BibTeX/RIS/APA) and the email digest (`singleLine` in `digest.ts`). This is a file-format-injection defense: a raw line break inside a title forges a record boundary in a citation manager or a forged line in the digest. The separator alphabet is a single shared constant, `LINE_TERMINATORS` in `lib/line-terminators.ts`, so the cite-export and digest paths cannot drift to different alphabets.

Two recurring traps in this defense surfaced during an architect cluster re-review (cite-export escaping + digest unification). Both are invisible from the code/git history once the fix lands, so they are recorded here.

## Guidance

### Rule 1 — verify `\s`-membership empirically; only NEL (U+0085) is a non-`\s` line terminator

The helpers run an explicit `LINE_TERMINATORS` strip pass and then (in `digest.ts`) a `/\s+/` collapse pass. The docblocks justify why the explicit pass is needed by asserting which line terminators are "not `\s` members in V8." That claim was written WRONG across two consecutive review rounds — and the second wrong version was itself a correction of an earlier overclaim (so the same docblock got the `\s` fact wrong, fixed, then wrong again).

The verified fact (run it, do not reason about it): among the line terminators CR, LF, VT (U+000B), FF (U+000C), NEL (U+0085), LS (U+2028), PS (U+2029), **only NEL (U+0085) is a non-`\s` member.** VT, FF, LS, and PS all match `/\s/` in V8 and would be caught by a downstream `/\s+/` collapse anyway. The explicit `LINE_TERMINATORS` pass earns its keep on NEL (and on getting CR/LF flattened to a space rather than collapsed away). The intuition "LS/PS are exotic, surely not `\s`" is exactly backwards — that is what misled the docblock twice.

Rule: never state a codepoint's `\s`-membership from intuition in a comment or docblock. Verify with `/\s/.test(String.fromCharCode(cp))` first. The regex catches all seven regardless, so a wrong `\s` claim is a documentation-accuracy defect, not a behavior bug — but it is in the canonical shared-constant docblock, so it misleads every future maintainer who reads it to understand why the explicit pass exists.

### Rule 2 — size the alphabet to what downstream consumers treat as a break, not to UAX#14

`LINE_TERMINATORS` was first scoped to the Unicode UAX#14 mandatory-break set (CR, LF, VT, FF, NEL, LS, PS). That boundary is too narrow for a format-injection defense: `splitlines()`-class tokenizers (Python `str.splitlines()` and the many citation importers built on that family) ALSO break on the C0 information separators FS/GS/RS (U+001C–U+001E), which a UAX#14-only class lets survive. An adversarial review reproduced an RIS record-forgery through the real `generateRis`: a crafted title containing FS/GS/RS fractures one `TI  - ` line into a forged `ER  - ` plus a phantom record with an attacker-chosen `AU  - `.

This is defense-in-depth, not a universal exploit — the major named importers (Zotero/Mendeley/JabRef) and mainstream mail clients do not break on C0, so a security lens correctly notes the boundary at UAX#14 is "not exploitable in the named consumers." But the constant's stated purpose is "the complete set any downstream consumer treats as a break," and C0 controls have no legitimate place in a paper title or author name, so the widening is free insurance and makes the docblock's completeness claim true.

Rule: the floor for `LINE_TERMINATORS` is the splitlines()-class break set, NOT UAX#14. Do not "simplify" the constant back to the Unicode mandatory-break set. When adding a new export format, audit the target consumer's line-tokenizer before assuming the existing alphabet covers it.

### Test discipline that ties both rules

- Keep at least one test that pins specific codepoints as **literals** (e.g. `expect(singleLine('ab')).toBe('a b')`), independent of importing `LINE_TERMINATORS`. A test that derives both its corpus and its expectation from the constant shrinks in lockstep with the constant, so removing a codepoint passes green (the dedup-value-pin trap). The two extended-alphabet suites (`digest-title-strip.test.ts`, `papers-cite-escape.test.ts`) keep `String.fromCharCode`-built literal pins for exactly this reason.
- When you correct a docblock to enforce a convention, audit your own replacement prose: the round that fixed the earlier `\s` overclaim re-introduced the same error class in its new wording (see Related).

## Why This Matters

The constant is the single source of truth for a security defense consumed by two paths. A wrong docblock propagates a false rationale to every maintainer; a trimmed alphabet re-opens a format-injection vector across both consumers at once. The `\s` fact recurred across rounds precisely because it is counterintuitive and was never verified empirically — a 5-second `/\s/.test()` check would have stopped both occurrences.

## When to Apply

- Any edit to `LINE_TERMINATORS` or either `singleLine`: verify every `\s`-membership claim in the docblock and keep the alphabet at least as wide as the splitlines()-class break set.
- Adding a citation export format or a new digest field: confirm the consumer's tokenizer cannot break on a codepoint the alphabet omits.
- Reviewing any comment that asserts regex `\s`-membership anywhere in the codebase.

## Examples

Empirical check (Node 20) — the authoritative source for any `\s` claim:

```js
for (const cp of [0x0b, 0x0c, 0x85, 0x2028, 0x2029]) // VT FF NEL LS PS
  console.log(cp.toString(16), /\s/.test(String.fromCharCode(cp)));
// 0b true  0c true  85 FALSE  2028 true  2029 true   → only NEL (U+0085) is non-\s
```

Wrong docblock (shipped twice): "NEL (U+0085), LS (U+2028), and PS (U+2029) are NOT `\s` members in V8."
Correct: "Only NEL (U+0085) is a non-`\s` member; VT/FF/LS/PS match `\s` and would be caught by the `/\s+/` collapse. The explicit pass earns its keep on NEL."

RIS forgery payload that a UAX#14-only alphabet permits (FS = U+001C as the record break a `splitlines()`-class importer honors):

```
title = "InnocentER  - TY  - JOURAU  - Attacker, A."
// survives a CR/LF/VT/FF/NEL/LS/PS-only flatten → forges a second record
```

## Related

- `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — direct instance: the round that purged the `\s` overclaim re-introduced the same error class in its own replacement prose. Audit the fix's new code, not just the cited sites.
- `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` — the docblock expansion made a false behavioral claim about `\s`; the behavioral-accuracy companion to the self-violation audit.
- `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — the `\s`-membership claim was an unverified runtime/engine fact baked into a security-margin docblock; verify before relying.
- `enumerated-exemption-lists-are-drift-vectors-2026-04-28.md` — structural form of Rule 2: a UAX#14-minimal enumerated alphabet is a drift vector; cover what consumers actually break on.
- `dedup-shared-constant-defeats-test-value-pin-2026-05-26.md` — why the escape tests keep literal-codepoint pins independent of `LINE_TERMINATORS`.
- `json-metadata-raw-map-use-safepevometa-2026-06-06.md` — co-dated cite-export sibling (`generateBibtex`/`generateRis`/`generateApa`); the silent-wrong-output failure class.
- `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — behavioral facts about the engine belong in the empirical test, anchored on the `LINE_TERMINATORS` symbol, not narrated in a drift-prone docblock.
- `sql-trim-vs-js-trim-whitespace-character-set-asymmetry-2026-05-19.md` — sibling "character-set membership differed from what the comment claimed," same empirical-verification cure.
