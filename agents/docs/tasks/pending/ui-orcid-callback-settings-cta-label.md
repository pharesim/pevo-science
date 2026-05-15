# UI-ORCID-CALLBACK-SETTINGS-CTA-LABEL — replace "Try Again" with a settings-specific CTA label on the orcid-callback error template

**Owner:** UI Agent
**Created:** 2026-05-15 (architect, surfaced by `/ce-code-review` of `ui-orcid-callback-post-broadcast-failed-handler` round-1)
**Priority:** P2

## Problem

`frontend/src/pages/orcid-callback.js` template at lines 44-46 renders the `errorAction === 'settings'` CTA as:

```html
<template x-if="errorAction === 'settings'">
  <a :href="$lp('/settings')" @click.prevent="navigate('/settings')" class="btn-primary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
</template>
```

`common.tryAgain` translates to "Try Again." That label is wrong for both of the error codes that route to `errorAction === 'settings'`:

- **`BROADCAST_TIMEOUT`** ("Broadcast is pending. Verify your ORCID linkage in Settings before retrying."). The intended action is to look at Settings to confirm chain state before re-running the OAuth flow. "Try Again" implies clicking it retries the operation, not navigates to Settings to verify.
- **`POST_BROADCAST_FAILED` with `outcome === 'confirmed'`** ("Your ORCID is linked. Some account details may take a moment to sync. Verify your linkage in Settings before retrying."). The user's ORCID IS linked. There is nothing to "try again" — they should verify in Settings.

The mismatch was inherited (the BROADCAST_TIMEOUT branch already used this slot before the POST_BROADCAST_FAILED branch landed), and `/ce-code-review` flagged it during the `ui-orcid-callback-post-broadcast-failed-handler` round-1 review as a maintainability concern (conf 75, P2). The cleanup was deferred to this task because it's an orthogonal i18n+template change that benefits both `errorAction === 'settings'` callers, not just the new POST_BROADCAST_FAILED branch.

When the held POST_BROADCAST_OPERATOR_REQUIRED follow-up lands (see `tasks/review/ui-orcid-callback-post-broadcast-failed-handler.md` HELD block — that branch is also expected to use `errorAction = 'settings'`), this CTA label will be wrong for three error codes instead of two.

## Acceptance

### 1. New i18n key

Add a new common-namespace key to `frontend/public/messages/en.json`. Suggested name: `common.verifyInSettings` (UI agent owns the exact key name and wording). Suggested copy: "Verify in Settings" or "Go to Settings."

Stub the key in the other 15 locale files (`ar`, `cs`, `da`, `de`, `es`, `fa`, `fr`, `he`, `it`, `nl`, `pl`, `pt`, `sv`, `tr`, `zh`) with the English text. Append a row to `frontend/public/messages/STUBS.md` under a fresh sweep heading.

### 2. Template

Replace `$t('common.tryAgain')` with `$t('common.verifyInSettings')` (or whatever key name you settle on) on the `errorAction === 'settings'` template block at `frontend/src/pages/orcid-callback.js:44-46`. Do NOT change the `:href` or the `@click.prevent="navigate('/settings')"` — only the label.

The `errorAction === ''` / `null` and `errorAction === 'recover'` template paths still render `common.tryAgain` correctly (those are genuine retry affordances). Leave them alone.

### 3. No backend change required

This is a frontend label cleanup. Backend contract is unaffected.

### 4. Tests

The existing unit tests for `BROADCAST_TIMEOUT` and `POST_BROADCAST_FAILED with outcome:'confirmed'` assert `errorAction === 'settings'` and the rendered error message, but do not assert on the CTA label string. No test changes are strictly required — the template change is a copy edit, not a behavior change. If the UI agent wants to pin the CTA label, a single shallow render-level test against the template would suffice; not required.

## Out of scope

- Changing the `errorAction === ''` / `null` / `'recover'` template paths. Those still mean "try the operation again."
- Renaming `errorAction === 'settings'` itself (e.g., to `'verify'`) — the semantic discriminator is fine; only the label rendered by the template needs work.
- Coordination with the held `POST_BROADCAST_OPERATOR_REQUIRED` task: the two are orthogonal. This task can land before or after that one without conflict.

## Source

`/ce-code-review` of `ui-orcid-callback-post-broadcast-failed-handler` round-1 (commit `9fe875d`):
- maintainability reviewer M1, P2, conf 75.
