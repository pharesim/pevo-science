/**
 * Single source of truth for the line-terminator separator alphabet shared by
 * every chain-field flattening path (citation export in `routes/papers.ts`'s
 * `bibtexEscape`/`risEscape`/`singleLine`, and the email-digest body builder in
 * `digest.ts`'s `singleLine`).
 *
 * Broader than `[\r\n]`: a crafted broadcaster-controlled field (paper title,
 * author name) can use vertical-tab (U+000B), form-feed (U+000C), the C0
 * information separators FS/GS/RS (U+001C-U+001E), NEL (U+0085), LINE SEPARATOR
 * (U+2028), or PARAGRAPH SEPARATOR (U+2029) to reach the same line-forgery /
 * file-format-injection class through a wider separator alphabet. Many RIS
 * importers and any text renderer (or mail client) treat these as line breaks;
 * a `splitlines()`-class tokenizer additionally breaks on FS/GS/RS, so a forged
 * `TY`/`TI`/`AU`/`ER` line can be smuggled through them. Flattening only CR/LF
 * leaves an attacker the wider channel.
 *
 * Why enumerate the full class instead of riding a downstream `\s+` collapse:
 * of these separators NEL (U+0085) and FS/GS/RS (U+001C-U+001E) are NOT `\s`
 * members in V8 (verified empirically), so a whitespace-collapse pass would
 * already catch VT, FF, LS, and PS but would let NEL and FS/GS/RS survive.
 * Enumerating the full set here is what makes flattening complete and keeps the
 * alphabet from drifting per consumer.
 *
 * The 10-character class is CR, LF, U+000B (VT), U+000C (FF), U+001C (FS),
 * U+001D (GS), U+001E (RS), U+0085 (NEL), U+2028 (LS), U+2029 (PS). Keeping it
 * in one module means consumers cannot drift to narrower or wider alphabets
 * independently. The `g` flag is required because consumers call
 * `.replace(LINE_TERMINATORS, ' ')` to flatten every occurrence; note the
 * resulting per-call statefulness of `lastIndex` is moot for `.replace` (it
 * resets), but do not reuse this object with `.test`/`.exec` across calls.
 */
export const LINE_TERMINATORS = /[\r\n\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]+/g;
