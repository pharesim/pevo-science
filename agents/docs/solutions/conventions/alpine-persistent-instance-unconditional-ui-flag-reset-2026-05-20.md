---
title: "Alpine persistent instance across sibling-page navigation: reset UI-only state flags unconditionally in `finally` (do NOT identity-guard the reset)"
date: 2026-05-20
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: medium
applies_when:
  - "Writing an Alpine handler in a page component mounted via frontend/src/components/page-mount.js"
  - "The handler captures identity-bearing fields (author, permlink, username, id) into local closures at entry for use after await"
  - "A captured-identity guard is being added to defend against stale-response races"
  - "The handler's finally (or success) block resets a UI-only loading/disabled/open state flag on the component instance"
  - "The component is reachable via a route whose params change without the route name changing (e.g. /paper/:author/:permlink, /profile/:username)"
tags:
  - frontend
  - alpine
  - paper-detail
  - identity-guard
  - page-mount
  - ui-flag
  - captured-closure
  - persistent-instance
related_components:
  - frontend/src/pages/paper-detail.js
  - frontend/src/pages/profile.js
  - frontend/src/components/page-mount.js
---

# Alpine persistent instance across sibling-page navigation: reset UI-only state flags unconditionally in `finally`

## Context

PEvO uses Alpine.js pages mounted through `frontend/src/components/page-mount.js`, which re-renders Alpine component instances **only when the route NAME changes**, not when route params change. This means a single Alpine component instance (e.g. `paperDetailPage`) persists across sibling-page navigation like `/paper/A` → `/paper/B` — same x-data scope, no destroy/recreate, no `init()` re-run, no automatic params-watcher to reset transient UI flags.

Handlers in these pages commonly defend against the resulting identity-race surface by **capturing identity at entry** (`const author = this.author; const permlink = this.permlink;`) and using two defenses inside the handler:

1. Passing the captured identifiers to all side-effect calls (network, file naming, navigation, toasts).
2. Post-await identity guards (`if (this.author !== author || this.permlink !== permlink) return;`) inside retry/backoff loops to bail when the user has navigated to a sibling page mid-flight.

The gap this learning closes: when reviewers reach the `finally` block that resets UI-only state flags (e.g. `this.citeLoading = false`), there is a reflex to add the same identity guard "for symmetry." That reflex is wrong, and it produces a wedged-UI bug that is easy to miss in review because the identity-guard pattern looks idiomatic everywhere else in the handler.

Surfaced by 4-way reviewer corroboration (correctness, julik-frontend-races, reliability, adversarial) during `/ce-code-review` fan-out on the paper-detail retriable-503 handling work — independent agreement on a non-obvious shape strongly indicates the trap is hard to dismiss as obvious.

## Guidance

In any PEvO Alpine handler that captures identity at entry, **distinguish three orthogonal defenses** and apply each correctly:

### 1. Captured-closure defense on side-effect arguments (DO)

Pass the captured `author` / `permlink` / `username` (not `this.author` etc.) to every side-effect call inside the handler: network fetches, download filenames, post-await navigation targets, toast strings that name the entity. This is the load-bearing defense against data-integrity races: corrupt downloads, wrong-paper toasts, broadcasts against stale ids.

### 2. Post-await identity guards inside retry/backoff loops (DO)

After every `await` inside a retry/backoff loop body, check whether the current `this.*` identity still matches the captured identity, and bail if not:

```js
await new Promise(r => setTimeout(r, backoffMs));
if (this.author !== author || this.permlink !== permlink) return;
```

This prevents the loop from continuing to drive side effects against a stale entity after the user has navigated to a sibling page.

### 3. UI-only state-flag resets in `finally`: reset UNCONDITIONALLY (DO NOT identity-guard)

UI-only state flags (`citeLoading`, `submitting`, `*Open`, etc.) that template-bind to `:disabled="xxx"` or `:class="{ ... : xxx }"` belong to the **persistent component instance**, not to a per-entity scope. They MUST be reset unconditionally in `finally`:

```js
} finally {
  this.citeLoading = false;  // unconditional reset
}
```

Do NOT wrap UI-flag resets in an identity check. The captured-closure defense (rule 1) and post-await guards (rule 2) already prevent the corrupt-side-effect race; an identity-conditional reset here only introduces a wedged-flag bug.

**Edge case.** If a UI-only flag IS legitimately scoped per-entity (rare — the question to ask is "should the loading indicator from paper A persist as visible on paper B?" and the answer is almost always NO), the correct shape is to scope per-entity via a Map keyed by `${author}/${permlink}`, NOT to use identity-conditional reset on a shared scalar flag.

## Why This Matters

`frontend/src/components/page-mount.js` only re-renders Alpine components on route NAME change. Sibling-page navigation (same route name, different params) reuses the same component instance and its x-data scope. There is no per-param destroy/recreate, no built-in params watcher, no `init()` re-run. Any transient UI flag set during a handler outlives the navigation unless the handler resets it.

When an identity-conditional reset is applied to a UI-only flag, the following sequence wedges the UI:

1. User triggers an action on paper A. Handler captures `author=A, permlink=pA`, sets `citeLoading=true`.
2. Network call hits a retriable 503; handler enters its backoff `await`.
3. User navigates to paper B mid-backoff. `this.author=B, this.permlink=pB`, but `author=A, permlink=pA` in the captured closure.
4. Post-await guard correctly bails — no second fetch, no wrong-paper download. (Defenses 1 and 2 work.)
5. `finally` runs. The identity check `this.author === author && this.permlink === permlink` is **false** (B ≠ A). `citeLoading` is NOT reset.
6. Paper B inherits the persistent component instance with `citeLoading=true`. Every template binding `:disabled="citeLoading"` (citation format buttons, dropdown toggle) is now permanently disabled. The UI is wedged until full reload.

The impact: a silent, hard-to-reproduce UI dead-end on a navigation pattern users actually exercise (paper-to-paper browsing). It does not throw, does not log, does not surface in any backend metric. It also passes naive code review because the identity check "matches the pattern" of the post-await guards above it.

## When to Apply

Apply this rule to every PEvO Alpine handler that satisfies **all three** of these conditions:

- Lives in a page managed by `frontend/src/components/page-mount.js` and is reachable via sibling-page navigation where the route NAME does not change but params do (`paper-detail.js`, `profile.js`, `review-detail.js`, and any future page in the same shape).
- Captures identity at entry (`const author = this.author`, `const username = this.username`, etc.) for use across one or more `await` boundaries.
- Sets UI-only state flags during the handler that template-bind to `:disabled="..."`, `:class="{ ... : flag }"`, or similar render-gating bindings.

When reviewing such a handler:

- For every side-effect call, confirm captured identifiers (not `this.*`) are passed.
- For every `await` inside a retry/backoff loop, confirm a post-await identity guard exists.
- For every `finally` (or success-path) reset of a UI-only state flag, confirm the reset is **unconditional**. Flag any identity check around such a reset.

The rule does NOT apply to:

- Per-entity state that legitimately belongs to a paper/user/review (use a Map keyed by identity instead).
- Backend or non-Alpine handlers (no persistent-component-across-params lifecycle).
- Pages where `page-mount.js` already destroys and recreates the component on the navigation in question.

## Examples

### Before (wrong — wedged-flag bug)

`frontend/src/pages/paper-detail.js`, `handleCitationExport`:

```js
async handleCitationExport(format) {
  const author = this.author;        // identity capture at entry
  const permlink = this.permlink;
  this.citeLoading = true;
  this.citeOpen = false;
  const serviceUnavailableRetryDelaysMs = [1500, 2500];
  let serviceUnavailableAttempt = 0;
  try {
    while (true) {
      try {
        const data = await fetchCitationExport(author, permlink, format);  // captured closure (correct)
        if (this.author !== author || this.permlink !== permlink) return;  // post-await guard (correct)
        // ...
        a.download = `${permlink}.${ext}`;  // captured closure (correct)
        // ...
      } catch (err) {
        if (isRetriable503(err) && serviceUnavailableAttempt < serviceUnavailableRetryDelaysMs.length) {
          await new Promise(r => setTimeout(r, serviceUnavailableRetryDelaysMs[serviceUnavailableAttempt]));
          if (this.author !== author || this.permlink !== permlink) return;  // post-await guard (correct)
          serviceUnavailableAttempt++;
          continue;
        }
        if (this.author !== author || this.permlink !== permlink) return;
        // surface error toast
        break;
      }
    }
  } finally {
    if (this.author === author && this.permlink === permlink) {  // WRONG: conditional reset
      this.citeLoading = false;
    }
  }
}
```

Defect: three citation format buttons plus the dropdown toggle bind `:disabled="citeLoading"`. On tab-switch mid-503-backoff, the post-await guard correctly bails (no second fetch, no wrong-paper download) but the `finally`'s identity check fails, `citeLoading` stays `true`, and paper B's citation UI is permanently disabled until full reload.

### After (correct — unconditional reset)

```js
} finally {
  this.citeLoading = false;  // unconditional reset; captured closures already defend the corrupt-side-effect race
}
```

The captured-closure arguments (`fetchCitationExport(author, permlink, format)`, `a.download = \`${permlink}.${ext}\``) and the post-await guards inside the loop already prevent every data-integrity race that the identity-conditional `finally` was reaching for. The `finally` only needs to release the UI flag, and that release belongs to the persistent component instance unconditionally.

## Related

- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md` — post-await `_mounted` teardown-guard pattern. That covers teardown-during-init re-entry within one mount cycle; this learning covers a different lifecycle dimension (persistent instance surviving param changes with no re-init at all). The two stack: teardown guards collapse re-init races; unconditional UI-flag reset collapses persistent-instance wedges.
- `agents/docs/solutions/conventions/alpine-init-handler-deregister-before-reassign-2026-05-17.md` — three documented re-init paths (x-data scope change, SPA route re-mount, HMR). This learning adds the fourth lifecycle path: **no re-init at all** — same instance survives sibling-page navigation. The implicit framing "these are the lifecycle paths to defend against" is now known incomplete; this entry completes the enumeration.
- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — every-reset-site grep for component-state objects. Adjacent meta-pattern: that doc covers enumeration completeness of reset sites; this entry covers the **conditional-vs-unconditional shape** of those resets when identity capture is in play.
