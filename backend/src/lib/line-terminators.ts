/**
 * Single source of truth for the line-terminator separator alphabet shared by
 * every chain-field flattening path (citation export in `routes/papers.ts`'s
 * `bibtexEscape`/`risEscape`/`singleLine`, and the email-digest body builder in
 * `digest.ts`'s `singleLine`).
 *
 * Broader than `[\r\n]`: a crafted broadcaster-controlled field (paper title,
 * author name) can use form-feed (U+000C), vertical-tab (U+000B), NEL (U+0085),
 * LINE SEPARATOR (U+2028), or PARAGRAPH SEPARATOR (U+2029) to reach the same
 * line-forgery / file-format-injection class through a wider separator alphabet.
 * Many RIS importers and any text renderer (or mail client) treat these as line
 * breaks, so flattening only CR/LF leaves an attacker a wider channel. NEL, LS,
 * and PS are also not `\s` members in V8, so a downstream whitespace-collapse
 * pass would not catch them either.
 *
 * The 7-character class is CR, LF, U+000B (VT), U+000C (FF), U+0085 (NEL),
 * U+2028 (LS), U+2029 (PS). Keeping it in one module means consumers cannot
 * drift to narrower or wider alphabets independently. The `g` flag is required
 * because consumers call `.replace(LINE_TERMINATORS, ' ')` to flatten every
 * occurrence; note the resulting per-call statefulness of `lastIndex` is moot
 * for `.replace` (it resets), but do not reuse this object with `.test`/`.exec`
 * across calls.
 */
export const LINE_TERMINATORS = /[\r\n\u000b\u000c\u0085\u2028\u2029]+/g;
