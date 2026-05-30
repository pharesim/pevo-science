# BACKEND-SSR-JSONLD-SCRIPT-BREAKOUT — stored/reflected XSS via JSON-LD `</script>` breakout in SSR head

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P1 (stored XSS, same-origin script execution, no auth required to trigger reflected variant)

## Problem

The SSR HTML-head builder in `backend/src/app.ts` interpolates user-controlled strings into `<script type="application/ld+json">` blocks via raw `JSON.stringify`, e.g.

```js
const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
```

`JSON.stringify` does not escape `<` or `>`. Any string value inside the JSON-LD object that contains the literal byte sequence `</script>` terminates the script block in HTML-parser context, allowing arbitrary `<script>…</script>` injection that runs same-origin as the SPA.

Affected interpolation sites (both paper and profile SSR paths):

- Paper SSR JSON-LD object construction and inline emit in `backend/src/app.ts` (`/paper/...` route handler — the `jsonLd` and `breadcrumb` objects, around the `application/ld+json` script element).
- Profile SSR JSON-LD construction in `backend/src/app.ts` (`/profile/<username>` route handler — same JSON-LD pattern, with username flowing from the URL path segment).

Stored XSS: any field carried into JSON-LD that is attacker-controlled in the source — paper title, abstract/description, discipline, keywords (from chain `json_metadata`); profile display name, bio (from profile `json_metadata`) — is a stored sink.

Reflected XSS: the profile route reads username from the URL path segment and reflects it into JSON-LD. An attacker-crafted link `https://pevo.app/profile/<payload>` (URL-encoded) triggers the breakout without needing to publish anything on chain. No accreditation gate; no auth gate.

Same-origin execution under `pevo.app` reads `localStorage`/`sessionStorage` (light-account posting/memo keys are stored there per `frontend/src/hive-keys.js`) and can call `/api/*` with the victim's cookies. This is the highest-impact XSS surface in the codebase.

## Goal

Escape `<`, `>`, and `&` to their `\uXXXX` JSON-string forms before embedding the stringified JSON inside an HTML `<script>` block, on every JSON-LD emit. The escape preserves JSON semantics (schema.org crawlers see the same string values) while preventing the `</script>` byte sequence from reaching the HTML parser.

## Fix sketch

Add a `jsonLdSafe` (or `escJsonForScript`) helper next to the existing `escHtml` / `escAttr` helpers, e.g.

```ts
function jsonLdSafe(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');
}
```

Then replace every `JSON.stringify(jsonLd)` / `JSON.stringify(breadcrumb)` (and any sibling JSON-LD payloads emitted inline) with `jsonLdSafe(...)`.

Verify by grep that no `JSON.stringify(...)` survives inside a `<script` template-literal anywhere in `backend/src/app.ts` (or any other SSR builder if one is added later).

## Acceptance

1. Every JSON-LD emit in `backend/src/app.ts` flows through `jsonLdSafe`. Grep confirms no surviving `JSON.stringify` inside a `<script` template-literal in the SSR builder.
2. Test exercising the breakout payload: a paper title (or profile username path segment) of `</script><script>window.__pwned=1</script>` is rendered into the SSR HTML, and a parser-level assertion confirms the JSON-LD `<script>` element's text content still contains the literal `</script>` substring (i.e., the script block did NOT close prematurely). Equivalent: assert the served HTML contains exactly the expected number of `</script>` tags (the JSON-LD ones plus any unrelated ones), not one extra.
3. Mutation-kill: revert the `<`-to-`<` replacement in `jsonLdSafe` → the test goes RED.
4. Same coverage for both paper SSR and profile SSR routes — at least one test per route. Profile test uses the URL-path-segment reflection (no chain state needed).
5. JSON-LD output remains valid JSON when parsed back (a round-trip `JSON.parse(scriptElement.textContent)` succeeds in the test).
6. No other escaping/sanitization regression: the existing `escHtml(title)` in the `<title>` and the existing `escAttr(desc)` in `<meta name="description">` continue to work; this task adds a third sibling helper, does not modify the existing two.

## Out of scope

- A broader audit of *all* `<script>` blocks (inline-config and the bootstrap script handled by the existing CSP hash discipline are out of scope; the bug is specifically in dynamic-payload JSON-LD emits).
- Refactoring the SSR builder beyond adding the helper and replacing the stringify call sites.
- Adding a per-route CSP override (covered by the IPFS gateway task; orthogonal here).

## References

- `backend/src/app.ts` — `/paper/...` and `/profile/<username>` SSR handlers; `escHtml` / `escAttr` helpers; `jsonLdScript` template-literal emit.
- Frontend storage of Hive keys: `frontend/src/hive-keys.js` and `frontend/src/api.js` (localStorage/sessionStorage usage; the blast-radius justification).
- OWASP XSS Prevention Cheat Sheet, "JSON value in a script context" rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
