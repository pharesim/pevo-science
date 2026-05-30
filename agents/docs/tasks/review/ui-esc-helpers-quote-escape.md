# UI-ESC-HELPERS-QUOTE-ESCAPE — add `"`/`'` escape to `_esc`/`escapeHtml` helpers (latent landmine)

**Owner:** UI Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P3 (latent — safe today via Hive author/permlink format; future-caller landmine)

## Problem

The `_esc` / `escapeHtml` helper(s) in `frontend/src/editor.js` (and any sibling co-located helpers) escape `<`, `>`, and `&` but omit `"` and `'`. This is safe today because every current caller passes either a Hive author name (`[a-z0-9.-]{3,16}`, chain-constrained) or a permlink (`[a-z0-9-]+`, no quote chars), both of which cannot contain quote characters. But:

- A future caller that passes a free-form string (a paper title, display name, search query) into the same helper and then interpolates into HTML **attribute context** (`<a href="..." title="${escapeHtml(freeFormTitle)}">`) gets attribute-quote breakout via `"`.
- The helper's name (`escapeHtml`) reads as a general-purpose HTML escape; an unsuspecting future caller has no signal that the helper is unsafe in attribute context.

This is a latent landmine, not an exploitable bug today. The fix is a 2-line addition to the helper with zero caller changes required and zero behavior change for current callers. Worth landing in the same pass as the rest of the security cleanup so the landmine doesn't survive.

## Goal

Extend the helper(s) to also escape `"` and `'`, making them safe for both element-content and attribute contexts. No caller changes; behavior identical for any string lacking quote characters.

## Fix sketch

```js
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Apply to every `_esc` / `escapeHtml` declaration in the frontend (grep to find them; co-located copies in different files should each be updated, or factored to a single shared util module — implementer's call on consolidation).

## Acceptance

1. **Quote chars escaped.** Test: `escapeHtml('foo"bar\'baz')` returns `foo&quot;bar&#39;baz`.
2. **Existing escapes unchanged.** Test: `escapeHtml('<a>&b</a>')` returns `&lt;a&gt;&amp;b&lt;/a&gt;` (no double-escape regression on `&amp;`).
3. **Null/undefined safe.** Test: `escapeHtml(null)` returns `''`; `escapeHtml(undefined)` returns `''`.
4. **Every copy updated.** Grep confirms no `_esc` / `escapeHtml` function in the frontend retains the old 3-char-only form.
5. **No behavioral regression for current callers.** Existing tests for editor-render, profile-render, etc. continue to pass (the current inputs lack quote chars, so the output is byte-identical).
6. **Mutation-kill:** revert the `"` replacement → test (1) goes RED.

## Out of scope

- Refactoring or renaming callers; the helper change is transparent.
- A frontend-wide audit of attribute-context interpolation (the focused audit confirmed the rest of the surface is clean today via Alpine's `:attr` binding which handles attribute-quote escaping internally).
- Consolidating multiple `_esc` copies into a single shared util (nice-to-have; not required).

## References

- `frontend/src/editor.js` — current `_esc` / `escapeHtml` helper.
- OWASP XSS Prevention Cheat Sheet, "HTML attribute context" rule.
- The focused security audit (May 2026) flagged this as latent-only; current callers are all chain-constrained handles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
