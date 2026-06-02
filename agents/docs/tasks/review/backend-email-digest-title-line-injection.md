# BACKEND-EMAIL-DIGEST-TITLE-LINE-INJECTION — strip CR/LF from paper titles in email digest body

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P3 (layout corruption / line-spoofing within plain-text email; not XSS)

## Problem

The notification email digest builder in `backend/src/digest.ts` interpolates paper titles directly into the plain-text digest body lines without stripping CR/LF. A paper title containing `\n` breaks the digest layout — and worse, an attacker-crafted title containing a fabricated "line" that mimics the digest's own formatting can spoof additional entries in the recipient's inbox view.

Plain-text email, so not XSS. Impact:

- Layout corruption (UX degradation).
- Line-spoofing for phishing-within-the-digest (e.g., a title like `Innocent Paper\n\n→ Click here to reset your password: https://attacker.evil/reset` injects an additional clickable line in many webmail rendering modes).

PEvO's per-project policy treats email surfaces as integrator-facing; CR/LF inside an interpolated value is the same class as the BibTeX/RIS injection covered by the citation-export task — strip at the boundary.

## Goal

Strip CR/LF (and ideally collapse internal whitespace to single spaces) from every paper title (and any other free-form chain field) interpolated into the digest body. Apply at the digest builder, not at broadcast time — the chain is the source of truth.

## Fix sketch

```ts
function singleLine(s: string): string {
  return (s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// at every interpolation site:
const line = `• ${singleLine(item.title)} — ${humanizeAction(item.kind)}`;
```

Audit the digest builder for every chain-derived free-form field (title, author display name, abstract excerpt if used, comment body excerpt). Apply uniformly.

If the digest also has an HTML variant, the same fields need HTML-escape there. The audit only flagged the plain-text path; verify whether an HTML digest exists and extend if so.

## Acceptance

1. **CR/LF stripped.** Test: a paper with title `Innocent\n→ Phishing line` renders into the digest as a single line with the newline replaced by a space. Test asserts the digest body contains exactly the expected number of `\n` characters (the digest's own line separators, not one more).
2. **Spoofing payload neutered.** Test: a paper with title `Foo\n\n→ Click here: https://attacker/` produces a digest body where the attacker's "line" does NOT start at column 0; it is part of the title-line content.
3. **Legitimate whitespace preserved.** Test: a paper with title `Some  Long   Title` collapses internal runs of whitespace to single spaces. Edge cases (leading/trailing whitespace trimmed) handled cleanly.
4. **All free-form chain fields covered.** Grep confirms every interpolation of a chain-derived free-form string in the digest builder flows through `singleLine` (or equivalent).
5. **HTML digest variant.** If one exists, fields are HTML-escaped via the existing helper; if it doesn't, no-op.
6. **Mutation-kill:** revert the strip → test (1) goes RED.

## Out of scope

- The digest's overall design or content selection logic.
- Validating titles at broadcast (chain is the source of truth).
- A wider email-template audit (the focused audit confirmed all other email templates clean, with all chain-derived fields properly escaped via the existing pipeline).

## References

- `backend/src/digest.ts` — digest body builder; line-formatting helpers.
- The notification email send path (`nodemailer` transporter wiring; not changed by this task).
- CLAUDE.md project policy on integrator-facing surfaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` confirmed the core threat is fully closed: `paper_title` is the only free-form chain field interpolated (actor is a Hive username, target_type an enum), there is no `html:` variant, and no email-header injection path (subject is static; from/to are not chain-derived). One item before archive:

1. **`singleLine` misses U+0085 (NEL).** NEL matches neither `[\r\n]` nor `\s` in V8, so it survives both passes — a NEL-bearing title can forge a line in mail clients that render NEL as a break (client-dependent, not the dominant clients, hence bounded). Same root cause as the citation task. Add `\u0085` to the first replace, and fold in `\u2028`/`\u2029` so neutralization no longer rides on `\s` membership. Add a NEL test. If practical, share the line-terminator constant with `backend-citation-export-format-escape` — the two `singleLine` helpers are near-duplicates and should not drift.

U+2028/U+2029/VT/FF are already caught here by the second `\s+` pass (this helper has one; the citation helpers do not), so only NEL is the live gap for the digest.

## Backend re-review signal (2026-06-02, commit 976c3307)

Hold item 1 landed. The `singleLine` helper in `backend/src/digest.ts` now strips
NEL (U+0085) and the line/paragraph separators (U+2028/U+2029) explicitly in its
first replace pass, so neutralization no longer rides on whitespace membership.
Added unit cases for NEL/LS/PS plus a `describeEvent` NEL line-forgery case in
`backend/tests/digest-title-strip.test.ts`; mutation-checked (reverting the
broadened character class turns the NEL case red). The broadened class is written
as explicit escape text, with no raw invisible code points left in source.
typecheck and lint are clean on the two touched files and the suite passes (11
cases).

On the optional item (share the line-terminator constant with
backend-citation-export-format-escape): made the digest fix self-contained
instead of sharing. That sibling task is still in pending/ and its citation-export
helpers still use the narrow CR/LF class, so there is no shared constant to
consume yet; introducing one now would couple two files owned by concurrent
sessions through a new neutral lib module. Left as a future dedup for whoever
lands the citation task last. The architect phrased sharing as "if practical" and
it is not practical while that task is mid-flight.
