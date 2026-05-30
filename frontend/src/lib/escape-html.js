// HTML-escape for values interpolated into innerHTML template strings.
// Escapes the five characters that are unsafe in element-content OR
// attribute context (`"` and `'` included), so a caller interpolating into
// `attr="${escapeHtml(x)}"` is protected against attribute-quote breakout,
// not only `<`/`>`/`&` element-content breakout. The earlier DOM
// textContent->innerHTML form omitted the quote escapes, leaving the helper
// a latent landmine for any future attribute-context caller.
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
