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

---

**UI implementer note (2026-04-22, working on main post-composable-and-teardown-sweep):**

All 8 sites sanitized. Full frontend unit suite: **902/902 pass**; `npm run build` clean. Both acceptance greps clean: `grep -rn '\.show(err\.message' frontend/src/` → empty, `grep -rn 'this\.errorMessage = err' frontend/src/` → empty.

**Per-site summary:**

- **`vote-buttons.js` vote-submit + vote-cancel** — replaced `err.message || this.$t('vote.voteFailed')` with `console.warn + $t('vote.voteFailed' / 'vote.cancelFailed')`. New key `vote.cancelFailed`.
- **`accreditation.js` handleOrcidVerify** — sanitized `err.message || 'ORCID verification failed'` → `console.warn + $t('accreditation.orcidVerifyFailed')`. New key `accreditation.orcidVerifyFailed`. Killed the English literal fallback.
- **`accreditation.js`, `bridge.js`, `publish.js`, `review.js` handleConnect (4 copies)** — replaced `err.message || this.$t('common.connectionFailed')` with `console.warn + $t('common.connectionFailed')`. Existing i18n key reused. Also added `if (!this._mounted) return;` guards to the publish/review copies that were missing them (the 1-A teardown sweep focused on broadcast catches and left handleConnect catches untouched in publish/review; accreditation/bridge already had the guard).
- **`header.js` handleSignIn** — replaced `const msg = err instanceof Error ? err.message : this.$t('common.connectionFailed')` with `console.warn + $t('common.connectionFailed')`. Existing i18n key reused.
- **`contact.js` submit** — replaced `err instanceof Error ? err.message : this.$t('contact.errorGeneric')` with `console.warn + $t('contact.errorGeneric')`. Existing i18n key reused.

**Extraction decision (per task's "Consideration" section):** **Inlined, kept the 4 handleConnect copies.** Rationale: of the 5 candidate sites, 4 (accreditation/bridge/publish/review) share an identical 3-line body but the 5th (header.js handleSignIn) has a slightly different shape (uses `$store.toast` via Alpine's magic rather than `Alpine.store('toast')`, plus the pre-existing `err instanceof Error` branch). Extracting a `useAuthConnect()` factory for 4 sites while header remains inline doesn't cross the duplication threshold cleanly. The 4 remaining copies are literal and auditable; extraction can land as a follow-up if they drift.

**i18n:** 2 new keys added to `en.json`: `vote.cancelFailed` + `accreditation.orcidVerifyFailed`. Stubbed across 14 non-English locales with English placeholders via JSON-aware edit (initial sed-based pass matched 4 unintended `signInHint` anchors across different blocks — reverted and redone via Python/JSON). 30 `STUBS.md` entries appended (2 keys × 15 non-English locales). The 7 reused keys (`vote.voteFailed`, `common.connectionFailed`, `contact.errorGeneric`) were NOT added to STUBS — they already carry real translations in every locale.

**Test coverage added:**
- 2 sanitize tests in `tests/unit/components-vote-buttons.test.js` (one per site) replacing the pre-existing `'Broadcast failed'` raw-assertion test.
- 2 sanitize tests in `tests/unit/pages-accreditation.test.js` handleOrcidVerify describe (replacing pre-existing `'Invalid ORCID redirect URL'` / `'Network error'` raw-assertion tests).
- 1 sanitize test in `tests/unit/pages-publish.test.js` — representative for the 4 handleConnect copies (comment explains the coverage scope).
- 1 sanitize test in `tests/unit/components-header.test.js` for handleSignIn.
- 1 updated sanitize test in `tests/unit/pages-contact.test.js` replacing the pre-existing `'Rate limited'` raw-assertion.

**Path to re-archive:** (1) Architect reviews with `/ce-code-review`. (2) Archives on clean. No hold items expected — the invariant is now fully enforced and the grep criteria are empty.
