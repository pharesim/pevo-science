---
title: A test case modelled on a sibling copies its framing along with its structure, and the framing can invert the fact it states
date: 2026-09-21
category: conventions
module: frontend/src/lib/fresh-auth.js + the consent-op orchestrators (settings-fresh-auth.js, authorship-consent.js)
problem_type: convention
component: frontend_stimulus
severity: medium
resolution_type: workflow_improvement
applies_when:
  - "Writing a new test case, docblock, or comment by modelling it on an adjacent sibling that pins a related but distinct value (null vs empty string, undefined vs zero, absent vs present-but-falsy)"
  - "The sibling's comment explains an asymmetry specific to ITS value, and the new case inherits that sentence rather than re-deriving it from the new value's own path"
  - "A twin-parity requirement is in play, so whatever sentence is written lands on two or more surfaces at once"
  - "Reviewing a diff that adds cases beside existing ones with visibly parallel prose"
  - "The rot gates and the full suite are both green, because the inherited sentence is well-formed, correctly anchored, and sits above passing assertions"
related_components:
  - authentication
  - development_workflow
tags:
  - fresh-auth
  - comment-rot
  - sibling-composition
  - twin-case
  - prose-accuracy
  - test-comments
  - analogy-transfer
---

# A test case modelled on a sibling copies its framing along with its structure, and the framing can invert the fact it states

## Context

The two consent-op fresh-auth orchestrators are deliberate twins. `withSettingsFreshAuth` (`frontend/src/lib/settings-fresh-auth.js`) and `withAuthorshipFreshAuth` (`frontend/src/lib/authorship-consent.js`) each bind the password factor through a local `mintViaPassword`, each run the same outcome ladder over the result, and each hand their `FRESH_AUTH_REQUIRED` fallout to the one shared `consentOpFreshAuthRetryGate`. Their unit suites are twins too, case for case.

A narrowing task tightened both mint callbacks from `typeof proof === 'string'` to `typeof proof === 'string' && proof`, because `''` is a string and was being handed onward as a usable proof. Its scope asked for four new cases, one initial-leg and one retry-leg per suite, and it asked for them in the twins' idiom: the retry-leg case was to be modelled on the existing non-string RETRY case, and the prose audit item ended "Keep the twins saying the same thing."

Both instructions are correct and both were followed. Copying that neighbour's **structure** is what the task wanted. Copying its **explanation** produced a sentence that is false for the new input, on both surfaces at once, with the whole suite green and the comment-anchor gate reporting nothing.

This is the third instance in this code family inside a week, all of them hand-written characterisations of which leg pays more on retry, none caught by tests or by a gate. A round earlier, prose on the password-factor-memo surface claimed the mint route always retires the memo when dismissing the second prompt short-circuits before the mint, and separately understated the retry cost in the rate-limited regime. The parent task that fixed the session-kind twin of this same predicate logged its own newly-written test-comment defect in the same way. (session history) Every one was caught by a review pass re-measuring behaviour, never by the suite.

## Guidance

When a new test case, docblock, or comment is modelled on an adjacent twin, **copy the shape and re-derive the explanation.**

Shape is transferable: arrange/act/assert layout, mock call-order, the assertion set, the naming, the register of the prose. Explanation is not, because a "why this case exists" sentence is a claim about how one specific **value** moves through the code, and the new case exists precisely because the new value is not a member of the old value's class.

The discriminator to check is one question: **which fact about the ORIGINAL case made the sentence true, and does the new case share it?** Here the answer was sentinel membership, and it is exactly what the two values do not share. Whatever makes a value need its own case is the first candidate for what breaks the copied explanation.

Then, per sentence:

- still true for the new value: keep it;
- true but for a different reason: restate the reason;
- inverted: say so outright rather than deleting it quietly, because the neighbouring case is right there inviting the same wrong inference from the next reader.

The sentences that need this are the comparative and cost claims: "the leg with more to lose", "merely abandons the action", "spends a second write", "the expensive one". Those turn on the value. Sentences about the mechanism ("both legs mint through the same callback", "a fix applied to the initial resolution alone leaves this leg uncovered") turn on the shape and usually do transfer intact.

**Prose is not an axis parity should hold on.** A twin-parity requirement propagates whatever it is handed. Mirror the structure across surfaces; re-derive each surface's explanation separately, even when the two end up saying the same thing.

For the general discipline of verifying an added clause against the code it describes, this defers to `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` rather than restating it. Two boundaries matter. That convention's trigger is an implementer **expanding** beyond an architect's minimal prescription; here there is no prescription and nothing was invented. And its fallback, drop the clause and stay minimal, is the wrong repair for a twin-modelled case: the clause is load-bearing, since it is the only thing telling a reader why this case is not a duplicate of its neighbour. Restatement is a third disposition that convention does not offer.

## Why This Matters

The two cases' explanations are non-transferable because of one asymmetry in the sentinel vocabulary. In `frontend/src/lib/fresh-auth.js`, `FRESH_AUTH_REDIRECT_PENDING` is `null`; `FRESH_AUTH_CANCELLED`, `FRESH_AUTH_MINT_FAILED`, `FRESH_AUTH_PROMPT_BUSY`, `FRESH_AUTH_REAUTH_REQUIRED` and `FRESH_AUTH_ORCID_FALLBACK` are Symbols. `null` is therefore the one member of the outcome vocabulary a JSON mint response can produce.

The initial ladder in both orchestrators tests the resolved proof against four sentinels by strict equality, and its first rung is the redirect sentinel. `consentOpFreshAuthRetryGate` tests its re-mint result against `FRESH_AUTH_ORCID_FALLBACK`, `FRESH_AUTH_PROMPT_BUSY`, `FRESH_AUTH_CANCELLED` and `FRESH_AUTH_MINT_FAILED`, and against the redirect sentinel never.

For a **null** proof the twin's sentence is exactly right. On the initial leg the first rung matches, the orchestrator returns `{ redirect: true }`, and the caller aborts silently for a navigation that never started: zero writes. Only the retry leg falls past every comparison into `run(retry)` and spends the op's write. The retry leg genuinely is the leg with more to lose.

For an **empty string** it is backwards. `''` is `===` none of the sentinels, so it clears the ladder on both legs and arrives at `run` as a proof to act on. Past there nothing compares it against a sentinel any more, only against truthiness: the settings and admin API functions in `frontend/src/api.js` spread `...(freshAuthProof ? { fresh_auth_proof: freshAuthProof } : {})`, the paper-detail call site passes `proof ? { freshAuthProof: proof } : {}` into `broadcastOps`, and `broadcastOps` in `frontend/src/signer.js` applies `if (freshAuthProof) body.fresh_auth_proof = freshAuthProof`. So the request leaves with no proof field at all, the backend's consume reports `missing`, and `missing` is in `REMINTABLE_REASONS`. Measured against the pre-fix code:

- **initial leg: two prompts and two refused writes.** The first `run('')` draws the remintable `missing`, the gate re-resolves the factor and mints through the same callback, asking for a password the user already typed correctly, gets `''` again, and the second refusal is terminal. The probe recorded `{"out":{"freshAuthFailed":true},"runCalls":["",""],"prompts":2,"mints":2}`.
- **retry leg: one refused write**, because the first attempt carried a real proof and 401d on its own merits.

So for an empty proof the initial leg is the expensive one, the precise inversion of the sentence inherited from the null case.

**Parity manufactures agreement, which suppresses the cheapest tell.** The standing habit in this file family is to grep sibling sites for a claim that disagrees with the one being corrected. That habit keys on disagreement. Under a parity requirement the same sentence is planted at both sites, so the sites agree, and both concept-matching and phrase-matching return two hits that look mutually corroborating. Parity does not merely fail to catch this class; it removes the signal and doubles the blast radius at the same time. The corollary is symmetrical and worth keeping: one re-derivation fixes both, and the review pass found the defect on both surfaces in one look.

**A green suite and a clean gate are both non-evidence here.** Every assertion in the new cases is correct and the change is well pinned: both suites 93/93, the full frontend unit suite 86 files / 1911 tests green, and single-surface revert probes reddening exactly that surface's two new cases. The comment sits above passing assertions and says something false about the code they pass against. The anchor gate is equally blind by construction, and correctly so: its arms are regexes over added lines matching rot **shapes**, and the draft sentence named `run(retry)`, the initial resolution and the mint by behaviour, carrying no slug, no ordinal, no line number and no bare positional anchor. Anchor durability and factual truth are independent axes. No regex separates a true explanation from a false one, and a canary is not available either, since the code here is exhaustively tested; what was wrong was the prose around passing assertions. The prevention is a review-time habit, not a gate.

## When to Apply

- Writing a comment by copying an adjacent sibling, a twin surface's counterpart, or a neighbouring `it.each` block.
- The new case exists BECAUSE the new value is not a member of the neighbouring case's class. This is the strongest tell, and it was visible in this change: the scope required a separate `it` "because `''` is not a member of that class". The same sentence one paragraph earlier would have caught the retry comment.
- The copied text carries a comparative or cost claim about which leg, branch, or path pays more.
- Propagating a sentence to a parity twin: check whether it is value-specific or shape-specific first.
- At review intake on a diff adding cases beside existing ones with visibly parallel prose. Read the new comment against the code, not against its neighbour. A comment that reads smoothly BECAUSE it matches the one above it is the exact shape this check exists for.

The pass is worth running for referent accuracy too, not only logic. The same review caught a second prose defect in the same change: a docblock quoted the `api.js` spread in ES6 shorthand elision rather than as it is actually written. Copied prose degrades in both directions, in what it claims and in what it quotes.

## Examples

The pre-existing **null** RETRY case in `frontend/tests/unit/lib-settings-fresh-auth.test.js`, which is true and remains in place:

```js
// The retry gate mints through the same callback on its own leg, and never
// compares that result against FRESH_AUTH_REDIRECT_PENDING: the
// `{ redirect: true }` its ladder can return belongs to the ORCID_FALLBACK
// arm, which a null does not reach. So an uncoerced null here does not read
// as a redirect the way the initial resolution's does; it falls past every
// sentinel comparison into `run(retry)` and spends the action's write on a
// token the mint has already declined to issue. A coercion applied to only
// the first acquisition leaves that open.
```

The last sentence is the transferable half: it is about the shape (both legs mint
through one callback), and it survives into the new case intact. Everything
before it is about `null` specifically, and none of it does.

The draft **empty-string** RETRY comment, modelled on it. This is the defect. It was corrected before the commit landed, so the wording survives only here and in the task's implementation signal, never in git history:

```js
// It is also the leg with more to lose: on the initial resolution an
// empty proof merely abandons the action, here it spends a second write
// on a token the mint has already declined to issue.
```

"Merely abandons the action" is the null behaviour, inherited whole. For `''` the initial resolution is where two prompts and two refused writes are spent.

The landed **empty-string** RETRY comment, in both suites (this is the settings copy; the authorship twin differs only in "broadcasts" for "writes"):

```js
// The retry gate mints through the same callback, so a narrowing applied to
// the initial resolution alone would leave this leg handing `''` into
// `run(retry)` with the whole suite still green. That deletability is the
// whole reason this case exists, and it is the only reason: the asymmetry
// the null rows turn on does not carry over. A null reads as a redirect in
// flight on the initial resolution and costs a write only on the retry,
// where `''` clears the ladder on both legs — so for an empty proof the
// initial resolution is the expensive one (two prompts, two refused
// writes), and this leg spends one, after a first attempt that carried a
// real proof and 401d on its own.
```

It keeps the transferable half (same callback, deletability, so the case earns its place) and replaces the non-transferable half with the inversion stated outright.

## Related

- `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` — the parent rule for verifying an added clause against the code it describes. Trigger-complementary: it fires on clauses INVENTED beyond a prescription, this one on clauses INHERITED with a copied structure, where the repair is restatement rather than deletion.
- `sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md` — the inverse tell, same module family. There two sibling comments DISAGREED and the disagreement was the signal; under parity they AGREE, so its sibling-miscount grep has nothing to fire on.
- `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md` — the same thesis in the executable domain ("do not inherit it from a sibling canary that shares the resolver"). This entry is its prose instance.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — the corpus's existing home for a claim carried over by analogy instead of re-verified. Its verification triple is reusable as the re-derivation procedure: the third leg is exactly what changed between the two cases.
- `carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md` — prose in a test header is checked by exactly one mechanism, a human believing it. "Copied from an adjacent twin, true there, false here" is a vector its list does not yet carry.
- `comment-anchor-rot-precommit-diff-gate-2026-06-14.md` — why the gate was clean and must stay clean on this class. A regex arm that claimed this coverage would be worse than no arm.
- `positional-anchor-stable-named-container-carve-out-2026-05-20.md` — its criteria define when a citation RESOLVES, never when it is TRUE. The inherited sentence satisfied every durability criterion and was still false.
- `cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` — the parity-enumeration discipline the task was executing when the sentence multiplied.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md` — the domain mechanism behind the asymmetry: sentinel membership is the property a re-derivation would have had to check.
