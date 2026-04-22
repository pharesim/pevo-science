# UI-ERR-MESSAGE-SANITIZE-TOAST-AND-HANDLECONNECT-SITES — Finish the err.message sanitization invariant across toast and handleConnect() call sites that FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND left unsanitized

**Owner:** ui
**Created:** 2026-04-22 (surfaced by FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND review 2026-04-22)
**Priority:** P3

## Context

`FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND` (commits `56fb4f1` → `0a20f61`) applied the generic-message + `console.warn` sanitization pattern to 29 DOM-field catch blocks across 17 files. The review surfaced an additional 8 sites where the same pattern-violation (raw `err.message` routed to DOM-visible text) persists via different rendering paths — toast calls and the `handleConnect()` copy-paste across pages. These were explicitly outside the 29-site scope of the original sweep but maintain the invariant-violation the sweep was written to close.

## In-scope sites (8)

**Toast-based (`Alpine.store('toast').show(err.message, 'error')`):**
- `frontend/src/components/vote-buttons.js:159` (vote-cancel)
- `frontend/src/components/vote-buttons.js:191` (vote-submit)
- `frontend/src/pages/accreditation.js:287` (handleOrcidVerify)

**`handleConnect()` copy-paste (keychain/auth.connect() throws routed to toast):**
- `frontend/src/components/header.js:58`
- `frontend/src/pages/publish.js:701`
- `frontend/src/pages/review.js:212`
- `frontend/src/pages/accreditation.js:242`
- `frontend/src/pages/bridge.js:259`

**DOM-field binding (missed by the 21-site test list even though it matches the sweep's exact shape):**
- `frontend/src/pages/contact.js:139` (`this.errorMessage = err instanceof Error ? err.message : this.$t('contact.errorGeneric')`)

Note: the `err instanceof Error` check in handleConnect/contact.js is not a sanitization guard — it only filters non-Error throws. Error objects from dhive or Keychain still expose their raw messages to the toast DOM.

## Goal

Apply the sanitize-sweep pattern to each site:

```js
} catch (err) {
  console.warn('[<handler>]', err);
  Alpine.store('toast').show(this.$t('<handler>.<errorKey>'), 'error');
}
```

or for contact.js:

```js
} catch (err) {
  console.warn('[contact submit]', err);
  this.errorMessage = this.$t('contact.submitFailed');
}
```

**Semantic-code carve-out:** where a handler checks `err.code === 'SOMETHING'` and renders a code-specific localized message, keep that branch; only sanitize the fallback. The settings.js handleEmailSubmit DUPLICATE pattern is the reference shape.

**i18n keys:** add 8 new keys covering each handler (e.g. `vote.voteFailed`, `vote.cancelFailed`, `header.connectFailed`, `publish.connectFailed`, etc.). Share a `common.connectFailed` where handlers genuinely want identical copy; per-handler keys otherwise for localization flexibility. Update `frontend/public/messages/en.json` + stub across 14 non-English locales + append entries to `STUBS.md`.

## Consideration — handleConnect() shared helper

`handleConnect()` is copy-pasted across 5 files with near-identical bodies. Since all 5 sites are being touched by this sanitization sweep, consider extracting a `useAuthConnect({ toastKey })` composable at `frontend/src/lib/auth-connect.js`. Tips past the "3 call sites, inline is fine" guidance the err-sanitize-sweep used; 5 sites with identical bodies crosses into duplication. If extraction happens, the sanitization pattern lives inside the helper and each call site becomes a one-liner.

Flag the extraction decision in the re-review signal — either "extracted, one commit" or "inlined, kept 5 copies per prior convention."

## Non-goals

- Auditing every toast call in the frontend. Scope is the enumerated 8 sites; if grep surfaces twins during the pass, fix inline.
- Changing toast UX (position, duration, icon).
- Replacing `err instanceof Error` checks at non-sanitization sites (some uses are legitimate type-guards, not sanitization surrogates).

## Acceptance

- All 8 sites use the sanitization pattern.
- i18n keys added in `en.json` + stubbed across 14 locales + registered in `STUBS.md` (ideally under a date-scoped header per `architect-stubs-md-sweep-headers.md` if that task has landed).
- `grep -rn '\.show(err\.message' frontend/src/` returns zero matches.
- `grep -rn 'this\.errorMessage = err' frontend/src/` returns zero matches (or only clearly-non-DOM bindings with explanatory comments).
- Full frontend unit suite passes; `npm run build` clean.

## [TODO Architect]

- Decide whether the "no raw err.message in DOM" invariant belongs in `ARCHITECTURE.md` or stays in `docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md`. Review of the parent sweep already surfaced this question; cross-link from ARCHITECTURE.md is the minimal answer if the user wants higher visibility.
