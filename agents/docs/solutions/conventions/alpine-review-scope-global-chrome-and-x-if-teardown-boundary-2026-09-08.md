---
title: "An Alpine x-if flip is not the destroy() boundary, and a page file does not render the global chrome"
date: 2026-09-08
category: conventions
module: frontend/src/pages/settings.js + frontend/index.html
problem_type: convention
component: frontend_stimulus
severity: medium
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
related_components:
  - code-review
  - development_workflow
applies_when:
  - "Reviewing a diff under frontend/src/pages that changes control availability, recovery copy, or flow sequencing"
  - "A finding says a control is the only affordance on screen, or that the user is stranded"
  - "A finding says component state is reset, cleared, or destroyed when an x-if branch flips"
  - "A finding says a behavior is untested, on the evidence of a describe block name rather than a grep"
  - "An architect is about to accept a multi-persona consensus whose cited evidence is one page file"
symptoms:
  - "Two reviewer personas and the architect independently reach the same wrong conclusion from a page-file-only read"
  - "The control a finding calls unreachable is rendered in the global shell, outside every page template"
  - "x-data sits outside both x-if branches, yet a finding assumes flipping the branch runs destroy() and wipes pinned fields"
  - "A companion finding claims a control is untested when a unit spec and an e2e spec already exercise it"
tags:
  - alpine-lifecycle
  - code-review
  - false-positive
  - global-chrome
  - component-scope
  - review-verification
---

# An Alpine x-if flip is not the destroy() boundary, and a page file does not render the global chrome

## Context

This frontend is Alpine.js, not a component framework where a page owns its whole
viewport. `frontend/index.html` is a single persistent shell. It renders the header,
including the sign-in control (once for desktop, once for the mobile menu), the global
sign-in modal, and a page-mount region that swaps in whichever page template is active.
Pages are template strings in `frontend/src/pages/*.js`, each with its own `x-data` root
and internal `x-if` branches for local state.

Two structural facts follow, and both are invisible to a reader who opens only the page
file:

1. Chrome rendered by the shell is on screen for the whole session, whichever page-local
   `x-if` branch is active. A page never renders its own sign-in affordance because a
   global one already exists.
2. `x-data` establishes the Alpine component's lifecycle boundary. `x-if` is a
   conditional render *inside* that boundary. Flipping the condition tears down and
   rebuilds the DOM subtree under the `template`, but the enclosing component and
   everything in its data object survive. Only a real route change unmounts the component
   and runs `destroy()`.

The correct model had already been derived twice on this surface and never written down
(session history). An implementer grepped the `x-if` gates directly rather than trust a
multi-lens finding, and an architect separately confirmed that the sign-in modal is
mounted in `frontend/index.html`, outside the page-mount tree, so its success path
preserves the settings component. Both readings were right, both stayed in session
transcripts, and neither became durable. A later review of a custody-upgrade copy change
then re-derived the question from scratch and got it wrong: two reviewer personas and the
architect orchestrating them all concluded the same false thing, and an independent
validation pass was the only thing that caught it. That is the gap this entry closes.

Nothing in the product was broken and nothing was fixed. The learning is entirely
procedural.

## Guidance

Before accepting any of these three claim shapes about page markup, run the matching
check. Each is one grep.

**1. "This control is the only affordance on screen" or "the user is stranded."**

A page-file read shows only controls defined in that page's template. Grep the shell for
chrome that renders unconditionally, or under a condition that still holds in the state
under discussion:

```bash
grep -n "signIn.signInButton\|handleSignIn" frontend/index.html
```

If the shell renders a control that meets the same need the finding says is missing, the
claim is false whatever the page file shows. A control can be the only one in the page
*body* without being the only one on *screen*.

**2. "This state is reset, cleared, or destroyed when the condition changes."**

Locate the `x-data` boundary relative to the `x-if` under discussion:

```bash
grep -n 'x-data=\|x-if=' frontend/src/pages/<page>.js | head -20
```

If `x-data` encloses the `x-if` templates being discussed, flipping that condition
remounts only the subtree inside the template. It does not run teardown and does not
re-run the data function. State in the component's data object survives the flip and is
unchanged when the branch re-renders. The claim holds only when a real navigation or
route change occurs, which is what unmounts the component.

**3. "This behavior is untested" or "nothing pins this."**

Do not infer coverage from a `describe` block's name or from skimming nearby titles. Grep
the actual symbol, the handler name, the i18n key, or the visible label, across both test
trees:

```bash
grep -rn "<symbol>" frontend/tests/unit frontend/tests/e2e
```

A block named for one behavior can contain assertions that also pin another, because the
author grouped related setup. The name describes intent, not the full set of things the
assertions catch.

## Why This Matters

In the review that surfaced this, the copy under review tells a user who is no longer
signed in as the account being upgraded to sign out, use the header's sign-in button to
sign back in without leaving the page, then retry. All three readers opened
`frontend/src/pages/settings.js`, saw that the not-connected branch renders only a
`navigate('/login')` button, and concluded that the copy's own first step would unmount
the retry UI and leave a seed-destroying navigation as the only way forward. The
adversarial persona rated it P1, reasonably: at that moment the user holds a freshly
rotated BIP39 seed phrase that exists nowhere else, and `navigate('/login')` is exactly
the control that discards it.

Both structural checks refute it:

- The shell renders the header sign-in button bound to `handleSignIn` and
  `signIn.signInButton`, in both desktop and mobile layouts. That is the literal control
  the copy names, and it stays on screen while the not-connected branch shows. The body's
  `navigate('/login')` was never the only control on screen.
- `x-data="settingsPage"` sits outside both the connected and not-connected templates.
  Toggling `isConnected` swaps branches without running teardown, so the in-progress
  upgrade state, the pinned subject and the generated seed phrase, survives the sign-out
  and sign-in round trip. The retry UI reappears intact.

The same review produced a second false finding from the identical habit, applied to tests
instead of markup: a claim that the header's sign-in control had nothing pinning it, so it
could be renamed or removed with the suite green. The reviewer had opened the header unit
test, found a `describe` named for error-toast sanitization, and stopped. That same file
exercises the handler through a mocked `connect()`, and the e2e suite independently clicks
the visible header control and asserts the dialog opens. The behavior was pinned twice
from different angles.

Both share one root cause. A reviewer whose mental model comes from frameworks where a
page component owns its viewport and unmounts on any conditional change will misread an
Alpine page that is a fragment inside a persistent shell, holding state that outlives its
own branches. The mismatch is structural, so it recurs on every review of this tree unless
the reviewer deliberately checks.

There is a second-order lesson from the same history. An earlier implementer pass reached
the right facts but under-called the disposition, recording a real mount-preserving
distinction as a residual rather than acting on it, and the next architect pass overturned
that as a validated defect (session history). Getting the mount facts right is necessary
but not sufficient: derive them, then decide separately what they imply.

## When to Apply

- Any review of a diff touching `frontend/src/pages/*.js`, especially user-facing copy,
  control availability, or flow sequencing.
- Any finding calling a control the sole remaining option, a state lost, or a flow a dead
  end, when its evidence is one page file.
- Any finding that a behavior is untested when its evidence is a test file's `describe`
  names rather than a grep for the symbol.
- Most load-bearing when the flow involves something irreversible behind a navigation: a
  seed phrase held only in memory, an in-progress multi-step form, unsaved input. A false
  stranding finding on that kind of flow reads as high severity and is the most expensive
  false positive to chase.

## Examples

**Before, the false-positive reasoning:**

> `settings.js` opens a not-connected branch whose only control is `navigate('/login')`,
> and a connected branch holding the retry button. The copy says to sign out first.
> Signing out flips the condition, unmounting the retry button and leaving
> `navigate('/login')`, which discards the rotated seed phrase, as the only control on
> screen. P1, the user is stranded with a destructive-only escape.

**After, with both checks applied:**

> Checked the shell: `frontend/index.html` renders a header sign-in button bound to
> `handleSignIn` and `signIn.signInButton`, desktop and mobile. That is the control the
> copy names and it stays on screen through the sign-out step, so `navigate('/login')` is
> not the only option.
>
> Checked the boundary: `x-data="settingsPage"` encloses both templates. Flipping
> `isConnected` swaps branches without running teardown, so the pinned subject and seed
> phrase survive and the retry UI returns on re-login. Does not hold, dismiss.

**Before, the coverage false positive:**

> The header's `handleSignIn` has nothing pinning its behavior or label. The only nearby
> `describe` covers error-toast sanitization, so the control could be renamed or deleted
> with the suite green.

**After, with the coverage check applied:**

> `grep -rn "handleSignIn" frontend/tests/unit frontend/tests/e2e` shows the unit suite
> exercising `handleSignIn()` against a mocked `connect()`, inside a block named for the
> sanitize invariant but asserting invocation too, and the e2e suite clicking the visible
> header control and asserting a dialog opens. Pinned from two angles. Does not hold,
> dismiss.

## Related

- `alpine-destroy-wipes-pinned-field-before-flipping-mounted-2026-09-02.md` covers the
  narrower downstream question: the ordering of statements *within* `destroy()` once it
  runs. It assumes teardown has already been invoked. This entry supplies the upstream
  precondition, whether teardown fires at all across an `x-if` flip.
- `alpine-persistent-instance-unconditional-ui-flag-reset-2026-05-20.md` is the same genre
  of lesson at a different boundary: a transition that looks like a remount is not one.
- `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` and
  `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` share the root
  cause, an enumeration that stopped one scope short.
