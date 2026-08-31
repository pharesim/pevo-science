---
title: "Widening an outcome vocabulary is a consumer audit, not a new member — the fix for a silent failure can reintroduce it through its own new outcomes"
date: 2026-08-31
category: conventions
module: frontend/src/lib/fresh-auth.js + its consumers
problem_type: convention
component: frontend_stimulus
severity: high
applies_when:
  - "Adding a member to a result, outcome, or error vocabulary returned by a shared helper that more than one call path branches on"
  - "Fixing a 'the caller never saw this outcome' or 'fails open into silence' finding by introducing a new outcome state rather than by hardening an existing one"
  - "Working in plain JS, where nothing mechanical flags a consumer whose branch ladder is missing a member"
  - "Auditing call sites after a shared gate's return contract changes, where the finding named only one of them"
related_components:
  - authentication
  - development_workflow
tags:
  - conventions
  - outcome-vocabulary
  - exhaustiveness
  - consumer-audit
  - silent-failure
  - fresh-auth
---

# Widening an outcome vocabulary is a consumer audit, not a new member

## Context

`ensureSessionWindow` in `frontend/src/lib/fresh-auth.js` returns one of six shapes:
`{ready}`, `{redirect}`, `{cancelled}`, `{failed}`, `{busy}`, `{reauthRequired}`. Three
independent consumers branch on that vocabulary: the page-level gate
`freshAuthWindowReady`, the broadcast unwinder `acquisitionAborted` behind eight call
sites, and `windowProof` in `frontend/src/lib/ipfs-upload.js`.

An architect review held the first round of this work for a gate that failed open into
silence: an error escaped past the caller's own `try`, the step machine never left idle,
and the user re-clicked a dead button with no feedback.

The second round fixed that, and in fixing it added two members to the vocabulary, `busy`
and `reauthRequired`, so callers could distinguish a refusal from a cancellation. The
members were added. The consumers were not re-audited. The same defect reappeared through
the new members at two of the three sites:

- `freshAuthWindowReady` branches on `failed` and `busy` and has no `reauthRequired`
  branch, so it returns false with no message at all.
- `acquisitionAborted` has the same gap.
- `windowProof` does branch on `reauthRequired`, because that is the site the round was
  written for, and instead falls through on `busy` into a generic cancellation, telling the
  user they cancelled an action they were never prompted for.

Four of the eleven items in the next hold block were this one pattern.

Two of the three gaps are latent rather than live: every current caller takes the default
that makes `reauthRequired` unreachable. They are landmines for the next caller that asks
for the non-navigating acquisition the member exists to express, which is the same reason
the member was added in the first place.

Worth noting what is *not* a defect here: `redirect` and `cancelled` are deliberately
silent in `freshAuthWindowReady`, because an in-flight navigation and a user's own dismissal
need no toast. A default is fine when it is a decision. The failure is an unconsidered
default that happens to swallow a member the vocabulary added specifically so it would be
visible.

## Guidance

When a change widens a result, outcome, or error vocabulary, the new member is not the
deliverable. The deliverable is an exhaustiveness re-audit of every existing consumer,
each ending with either an explicit branch or a comment stating why it deliberately falls
through.

Treat "grep every place this vocabulary is branched on" as a step of the same change that
adds the member, not a follow-up. Grep the sentinel or flag names, not the one call site
the bug report named: a finding filed against one consumer naturally gets fixed at that
consumer, and a vocabulary consumed from several independent paths gives the omission that
many places to hide.

In a language with no compiler-enforced exhaustiveness, prefer a structure that makes the
audit unnecessary over one that makes it careful:

- **One shared mapping from outcome to handling**, looked up by every consumer, instead of
  N independently maintained branch ladders. Adding a member to the table adds it
  everywhere at once, and a consumer that needs to special-case one outcome overrides a
  single entry rather than duplicating the ladder.
- **A test driven from the vocabulary's own constants** asserting that every non-success
  member produces user-visible feedback at each consumer, or reaches a line explicitly
  marked as an intentional silent case. Enumerate the constants in the test rather than
  hand-copying the list, so the test grows when the vocabulary does. The concrete mutation
  it catches is precisely the one that occurred here: a member added without a matching
  branch at one of the consumers.

## Why This Matters

This is a fix reintroducing the defect it was written to close, which makes it expensive
twice: once in the second round's review and again in the third. The reviewer who found it
had to notice the same symptom in a new disguise, at sites the original finding never
named.

The user-facing outcomes differ per miss and are both the class this layer exists to
prevent: an action refused with no explanation, or an explanation naming the wrong cause.
Because the re-auth design is about making failures legible rather than absorbed, a
swallowed outcome defeats the layer's whole purpose rather than merely degrading it.

The structural lesson is that a vocabulary consumed by N independent branch ladders is an
N-times-repeatable place to drop a member, and the count grows silently as new consumers
are added. A shared dispatch table has one place to forget.

## When to Apply

Any additive change to a shared outcome or error vocabulary in a codebase without
exhaustiveness checking. Apply with extra weight when:

- the change responds to a finding about an outcome the caller failed to handle, since the
  new member is then load-bearing for user-visible behaviour by construction;
- the vocabulary is consumed from more than one independent path;
- the new member is currently unreachable at some consumers. Unreachable today is the
  normal state for a member added ahead of the caller that needs it, and it is exactly the
  condition under which a missing branch survives review.

## Examples

The gate, after the round that added two members:

```js
if (outcome.ready) return true;
if (outcome.failed) showReauthFailedToast();
if (outcome.busy) showPromptBusyToast();
return false;               // reauthRequired lands here, silently
```

The upload pre-flight, in the same round, missing the other member:

```js
if (outcome.ready) return outcome.proof;
if (outcome.reauthRequired) throw new UploadSessionError(UPLOAD_REAUTH_REQUIRED, ...);
if (outcome.failed) throw new UploadSessionError(UPLOAD_REAUTH_FAILED, ...);
throw new UploadSessionError(UPLOAD_CANCELLED, 'Upload cancelled');   // busy lands here
```

Each ladder is individually reasonable and locally complete against the vocabulary its
author had in mind. Neither is complete against the vocabulary as it now exists, and
nothing in the toolchain says so.

## Related

- `conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the same
  cross-product audit for thrown error classes on a backend wrapping primitive. There, TS
  narrowing catches part of the gap; here there is no such backstop, which is why the audit
  has to be explicit and why a shared table beats a careful sweep.
- `conventions/helper-contract-flip-untouched-adopter-audit-2026-05-16.md` — the
  defaulting-semantics-flip instance of "the audit set is every call site, not just the
  diff-touched ones". Its scope note explicitly excludes purely additive changes, which is
  the case this entry covers, so a reader who hits that exclusion should land here.
- `conventions/satisfies-record-for-mapped-type-and-set-completeness-2026-05-17.md` — the
  mechanism that turns this class of bug into a compile error where types are available.
  Unavailable in this tree, which is the gap the test-from-constants recommendation fills.
- `conventions/contract-field-removal-sweep-consumers-and-fixtures-2026-05-26.md` — the
  removal-direction sibling of the same contract-changed-shape family.
