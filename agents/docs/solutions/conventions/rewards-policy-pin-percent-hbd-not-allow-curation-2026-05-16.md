---
title: Rewards-policy test pin asserts percent_hbd === 0 not allow_curation_rewards or max_accepted_payout
date: 2026-05-16
last_updated: 2026-05-16
category: conventions
module: "frontend/tests, frontend/src/pages"
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing or reviewing a test that pins comment_options broadcast by a publish, edit, or review-submission flow
  - Reviewing architect feedback that references PEvO rewards policy in the context of allow_curation_rewards or max_accepted_payout
  - Auditing any test assertion that touches allow_curation_rewards, max_accepted_payout, or allow_votes on a Hive broadcast
  - Onboarding a new agent instance where root CLAUDE.md's "no Hive rewards as a value proposition" line might be misread
tags:
  - rewards
  - comment_options
  - hive
  - test-mock
  - percent_hbd
  - policy-misread
related_components:
  - hive-broadcast
---

## Context

Root `CLAUDE.md` states "No Hive rewards as a value proposition." This sentence is the natural-language anchor for PEvO's rewards stance, and it is structurally easy to misread as "rewards are disabled entirely." It is not. The policy is nuanced:

- Users CAN earn Hive rewards from their publications.
- The UI does not surface rewards as a feature or selling point.
- All posts are broadcast with `comment_options.percent_hbd: 0`, routing 100% of any payout to Hive Power rather than splitting between HBD and HP.
- `allow_curation_rewards: true` and `allow_votes: true` — curation is fully enabled.
- `max_accepted_payout: '1000000.000 HBD'` — effectively unlimited, not a zero cap.

The architect (in two separate review sessions of the `ui-e2e-edit-paper-flow` task) wrote hold-block items framed as "PEvO no-Hive-rewards principle is enforced via `comment_options.allow_curation_rewards: false`." Both framings contradicted production. The correctness and testing reviewer subagents in the round-3 review independently cross-corroborated the correct understanding by reading `frontend/src/pages/edit.js:998-1010`. The failure mode is structural: the natural-language CLAUDE.md line gets read as a literal feature-disable instead of a UI-surfacing posture, and without a concrete code anchor the mistake recurs across sessions and agents.

## Guidance

**The load-bearing field is `percent_hbd: 0`.**

When writing or reviewing a `comment_options` op in any PEvO broadcast context (publish, edit, review submission, continuation post), verify:

1. `percent_hbd` is `0` — this is the policy-enforcing field.
2. `allow_curation_rewards` is `true` (or absent, since `true` is the default) — do NOT assert `false`.
3. `max_accepted_payout` is `'1000000.000 HBD'` (or absent) — do NOT assert `'0.000 HBD'`.

**Canonical code comment shape** (place adjacent to the `comment_options` assembly):

```js
// All PEvO posts are broadcast with comment_options.percent_hbd: 0
// (100% Hive Power payout). Rewards are allowed; the UI doesn't
// surface them as a value proposition. A regression dropping this
// op would let the default 50/50 HBD/HP split apply.
```

**Canonical test assertion shape** (for any spec that pins the `comment_options` op):

```js
// CORRECT — mutation-kills the rewards-policy regression class:
const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
expect(optionsOp).toBeTruthy();
expect(optionsOp[1].percent_hbd).toBe(0);

// WRONG — does NOT match production, do not write these:
// expect(optionsOp[1].allow_curation_rewards).toBe(false);
// expect(optionsOp[1].max_accepted_payout).toBe('0.000 HBD');
```

When reviewing hold-block items or test assertions that reference `allow_curation_rewards: false` or `max_accepted_payout: '0.000 HBD'`, treat them as incorrect framings of PEvO policy — reject and replace with `percent_hbd: 0`.

## Why This Matters

A reviewer (or author) writing a `comment_options` test without this anchor has two intuitive but wrong priors to draw from:

1. "No rewards" → assert `allow_curation_rewards: false` or `max_accepted_payout: '0.000 HBD'`. Production sets neither field that way, so the assertion fails on the unmutated code (or, worse, the assertion is shaped against an absent field and passes vacuously regardless of code shape).
2. "Some rewards cap" → assert a non-zero `max_accepted_payout`. Misses the point entirely; the cap is functionally unlimited.

Both wrong assertions also pass green in a regressed codebase that drops the `comment_options` op entirely — making them useless as regression guards. Only `percent_hbd: 0` mutation-kills the actual policy regression (the default 50/50 HBD/HP split silently applying).

The architect's failure mode here is particularly expensive because hold-block corrections block task progress for a full round-trip (hold → pending → implementer fixes → review again). Two consecutive sessions with the same wrong framing means two wasted round-trips on the same task. Documenting the correct anchor breaks the cycle by giving the next reviewer a concrete production reference to check before writing or approving any rewards-policy hold item.

## When to Apply

- Writing any test that asserts on a `comment_options` operation: publish, edit, review submission, or continuation post.
- Reviewing a `comment_options` test assertion written by another agent or author.
- Writing or reviewing architect hold-block items that reference PEvO's rewards stance.
- Onboarding a new agent instance where root `CLAUDE.md`'s "no value proposition" line might be misread.
- Any `comment_options` change to `publish.js`, `edit.js`, or a review-submission route — confirm `percent_hbd: 0` is present and the other fields are not regressed to zero-cap.

## Examples

**Production reference — `frontend/src/pages/edit.js:998-1010`** (canonical `comment_options` assembly on edit / continuation broadcast):

```js
const commentOptions = {
  author,
  permlink,
  max_accepted_payout: '1000000.000 HBD',
  percent_hbd: 0,
  allow_votes: true,
  allow_curation_rewards: true,
  extensions: [],
};
```

The operative line is `percent_hbd: 0`. `allow_curation_rewards` and `allow_votes` are both `true`.

**Production parity — `frontend/src/pages/publish.js`** — search `percent_hbd` to confirm the same shape on new publications. Both publish and edit must broadcast `percent_hbd: 0` for the policy to hold uniformly.

**Accepted round-3 test — `frontend/tests/e2e/edit-paper.spec.js`** (accepted-claimer test added in round-3 of `ui-e2e-edit-paper-flow`). The assertion block reads:

```js
const optionsOp = broadcast.operations.find((op) => op[0] === 'comment_options');
expect(optionsOp).toBeTruthy();
expect(optionsOp[1].percent_hbd).toBe(0);
```

This is the template for all future `comment_options` pins in the test suite.

**Wrong framing (from the architect's round-2 and round-3 hold blocks on the same task; both subsequently corrected):**

> "PEvO no-Hive-rewards principle is enforced via `comment_options.allow_curation_rewards: false`; a regression dropping this op enables curation rewards on continuations."

Both fields named in that framing are wrong. Production sets `allow_curation_rewards: true`. The regression class the hold item was trying to guard against is real (a regression dropping the `comment_options` op entirely DOES enable the default 50/50 split), but the correct guard for that regression is `percent_hbd: 0`, not `allow_curation_rewards`.

## Cross-references

- Root `CLAUDE.md` "No Hive rewards as a value proposition" — the sentence that gets misread. The doc clarifies: UI does not display rewards and rewards are not a product feature; posts are NOT broadcast with `allow_curation_rewards: false` or `max_accepted_payout: 0`. The correct invariant is `percent_hbd: 0` (100% HP payout); rewards ARE enabled at the chain level.
- `frontend/src/pages/edit.js:998-1010` — `comment_options` op assembly on the edit path.
- `frontend/src/pages/publish.js` — publish-side parity.
- `frontend/tests/e2e/edit-paper.spec.js` — round-3 canonical test assertion pinning `percent_hbd === 0`.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — adjacent convention. The rewards-policy mis-anchor is a specific instance of the broader "assertion anchored on the wrong field" class; the root cause here is a policy misread rather than a corpus-conditional kill issue, so the two docs cover non-overlapping ground.
