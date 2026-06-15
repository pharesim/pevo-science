---
title: "Synthetic INTERNAL_ERROR is a transport string, not a backend reason: exclude it when surfacing err.message"
date: 2026-06-15
category: conventions
module: frontend/src
problem_type: convention
component: frontend_stimulus
severity: medium
applies_when:
  - "Writing or reviewing a frontend error-display helper that surfaces err.message when err.code is present"
  - "Adding a surface that shows backend error reasons to the user or operator, rather than mapping err.code to a localized key"
  - "Reviewing a catch block that treats a present err.code as proof the message is backend-authored"
tags:
  - frontend
  - error-handling
  - api-client
  - internal-error
  - info-disclosure
  - i18n
---

# Synthetic INTERNAL_ERROR is a transport string, not a backend reason

## Context

PEvO's frontend API client (`frontend/src/api.js` `request()`) throws an `ApiRequestError` on every non-2xx response. For a response carrying the standard error envelope (`{ status: 'error', error: { code, message, details } }`) it threads the backend's real `code` and `message` through. But for any NON-enveloped error (a bare 404, a 502 / proxy error, a non-JSON gateway body, or a stale-deploy route 404), it synthesizes a fallback: `new ApiRequestError('INTERNAL_ERROR', 'Request failed with status N')`. That `message` is an untranslated English transport string the client made up, not anything the backend authored.

Most pages never trip on this because they follow the `frontend-error-sanitization` convention: branch on `err.code` to pick a localized i18n key, and never surface `err.message` to the DOM at all. The trap is specific to surfaces that DO surface backend messages (operator/admin consoles, lookup helpers): a helper that reasons "this error has a `code`, so it is a structured backend reason, therefore show `err.message`" will render "Request failed with status 404" to the user for every non-enveloped failure.

## Guidance

When a display helper surfaces `err.message` conditioned on `err.code` being present, EXCLUDE the synthetic `INTERNAL_ERROR` code: treat it as unstructured/transport and fall through to a localized fallback key.

```js
// admin.js _errorMessage (a sanctioned message-surfacing helper)
if (err?.details?.outcome === 'uncertain') return this.$t('admin.broadcastUncertain');
if (typeof err?.code === 'string' && err.code !== 'INTERNAL_ERROR' && err?.message) return err.message;
return this.$t(fallbackKey);
```

A present `err.code` is NOT proof of a backend-authored message: `INTERNAL_ERROR` is the one code the client mints itself. Genuine backend codes (`NOT_FOUND`, `VALIDATION_ERROR`, `SERVICE_UNAVAILABLE`, and the `details.outcome:'uncertain'` 504 broadcast-timeout) carry real, operator-meaningful messages and still surface. An enveloped error whose `code` is literally `INTERNAL_ERROR` is also suppressed by this guard, which is acceptable: such envelopes carry generic, non-actionable messages by convention.

## Why This Matters

The rule lives in `api.js`'s error-synthesis path (the `!res.ok` block in `request()`), far from the consuming display helpers. A developer writing a new message-surfacing surface sees only an `ApiRequestError` with a `.code` and a `.message` and reasonably assumes both came from the backend; nothing at the call site signals that one specific code value is a client-minted transport fallback. So the leak stays invisible until a non-enveloped failure happens in production, and the common triggers are mundane: a stale backend image 404ing a newly-added route, a reverse-proxy 502, a network blip. The user then sees raw English "Request failed with status 502" instead of a localized message.

This has recurred twice independently, which is the signal that it is a general trap and not a one-off: `frontend/src/bridge.js` `handleLookup` maps `INTERNAL_ERROR` to a localized key, and `frontend/src/pages/admin.js` `_errorMessage` shipped the leak (surfacing the synthetic string when its roster route 404'd against a stale image) and was fixed by adding the `err.code !== 'INTERNAL_ERROR'` exclusion, mirroring `bridge.js`.

## When to Apply

- Any frontend helper that decides whether to show `err.message` based on `err.code` being present (the `typeof err.code === 'string' && err.message` shape).
- Any new operator/admin surface that surfaces backend error reasons, rather than the default `err.code`-to-localized-key mapping most user-facing pages use.
- Reviewing a `catch` that treats "is an `ApiRequestError`" as "has a trustworthy backend message".

Not applicable to the default sanitization shape (branch on `err.code`, emit a localized key, never touch `err.message`): that already never surfaces the synthetic string.

## Examples

Before (leaks the synthetic transport string):

```js
// any error with a code is treated as a backend reason
if (typeof err?.code === 'string' && err?.message) return err.message;
return this.$t(fallbackKey);
// On a bare 404/502: err.code === 'INTERNAL_ERROR', err.message === 'Request failed with status 404'
//   -> renders "Request failed with status 404" to the DOM
```

After (excludes the synthetic code):

```js
if (typeof err?.code === 'string' && err.code !== 'INTERNAL_ERROR' && err?.message) return err.message;
return this.$t(fallbackKey);
// On a bare 404/502: falls through to the localized fallback (e.g. admin.loadFailed)
// On a genuine NOT_FOUND / VALIDATION_ERROR / SERVICE_UNAVAILABLE: still surfaces the backend message
```

## Related

- `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md` — the end-user prohibition (never surface raw `err.message` to a DOM field; map `err.code` to a localized key). Its operator-admin-console exemption is where surfacing backend messages is sanctioned at all; this doc is the general `INTERNAL_ERROR` exclusion that any such message-surfacing helper must apply.
- `agents/docs/solutions/conventions/test-fabricated-error-shape-masks-dead-branch-2026-06-09.md` — `ApiRequestError`'s authoritative field set (`code` is the discriminator; there is no `err.status`) and confirms `request()` is the canonical throw site that mints `INTERNAL_ERROR`.
