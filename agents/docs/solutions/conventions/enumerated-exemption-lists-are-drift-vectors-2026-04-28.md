---
title: "Convention-doc audit lists must be structural, not enumerated — hand-curated exemption lists are drift vectors"
date: 2026-04-28
category: conventions
module: agents/docs + code-review process
problem_type: convention
component: documentation
severity: high
applies_when:
  - "Authoring or revising a convention doc that establishes a security gate, data-integrity rule, or always-wrap/never-direct-use rule"
  - "Tempted to enumerate site-by-site exemptions where the rule supposedly does not apply (non-gating, read-only, type-routing, aggregation)"
  - "Reviewing a convention whose audit list is hand-maintained rather than derived from a structural property"
  - "Code review surfaces unguarded sites that the convention had explicitly marked exempt"
  - "Considering whether a privileged predicate should be inlined per call site or wrapped in a centralized helper"
related_components:
  - tooling
  - testing_framework
  - development_workflow
tags:
  - conventions
  - convention-authoring
  - drift-vectors
  - exemption-lists
  - structural-invariants
  - audit-completeness
  - centralized-helpers
  - grep-guards
---

# Convention-doc audit lists must be structural, not enumerated

## Context

PEvO had a fresh convention doc — `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`, written roughly six hours before this learning emerged — that codified an unambiguous structural rule: **every OR-arm in an authorization gate must terminate in an identity predicate**. The rule was correct. The bypass it closed was real (a self-asserted `json_metadata.type === 'bridge_paper'` on the read-gate at `backend/src/routes/papers.ts:263`, with parallel sites in `search.ts` and `stats.ts`). The doc was thorough.

But the doc's "When to Apply" section then named six call sites it claimed were exempt from the author pin because they served "non-gating purposes":

- `backend/src/routes/papers.ts:227-228` — `source` query-param routing
- `backend/src/lib/helpers.ts:47` — `isPevoBridgePaper()` helper
- `backend/src/routes/comments.ts:38` — parent-paper-type filter
- `backend/src/routes/bridge.ts:90, 107` — bridge-only routes
- `backend/src/routes/search.ts:59, 61` — type-routing when `?source=...` is set
- `backend/src/routes/stats.ts:60` — count-by-type aggregation

The carve-out felt natural at the time: those sites weren't gating *who can read what* in the accreditation sense — they were routing, filtering, and aggregating. The author pin appeared to be a gate-time concern, not a routing-time concern, so the doc enumerated the routing-side sites as safe.

The bypass surfaced during the architect review of the implementation task `backend-bridge-paper-author-gate.md`. Commit `497795e` had pinned the three originally-identified gate sites (`papers.ts:263`, `search.ts:82`, `stats.ts:46`). The adversarial reviewer in `/ce-code-review` ran the full grep — `grep -rn "bridge_paper" backend/src/ --include="*.ts"` — instead of trusting the convention doc's list, and found **twelve additional sites** that branched on the `bridge_paper` type without binding `c.author = config.hiveBridgeAccount`. Several of the twelve were sites the convention had explicitly named as exempt.

The user's reframe was decisive:

> Our filters should always gate our system from invalid data. A paper imported by anyone else than bridge account is not relevant in any part of our systems. It shouldn't be displayed anywhere, and not be taken into account for reputation calculations.

A non-bridge-account `bridge_paper` is not a "non-gated routing input" with a benign downstream. It is **invalid data, full stop** — and any code path that processes it pollutes some downstream surface (search, stats, comment threads, sitemap, reputation, notifications, duplicate-checks). The convention's enumerated exemption list wasn't a safe carve-out; it was a hand-drawn perimeter around sites the author thought through, missing the sites the author hadn't.

The convention was corrected to strike the exemption list, restate the rule structurally ("any expression that branches on `'bridge_paper'` MUST also bind `c.author = <pinned-identity>`"), and recommend a centralized `validPevoPaperWhere()` helper in `backend/src/lib/hafsql.ts`. The implementation task was held back to `pending/` with a P0 hold block migrating all 15 sites (the original 3 plus the 12 newly-discovered) to use the helper.

This learning captures the meta-rule the reframe revealed: **the convention doc itself was the drift vector**.

## Guidance

**Convention docs that establish security or data-integrity invariants MUST NOT enumerate site-by-site exemptions. The audit list must be derivable from a structural property — a grep, a type, a wrapper import — not from a hand-curated list of "safe" sites.**

When you write a rule of the form "every X must be wrapped in Y" or "every site that does Z must also bind W", the correctness of the rule has two layers:

1. **The invariant itself** — is it the right rule? (For the bridge-paper case: yes, every `'bridge_paper'` branch must bind the bridge author.)
2. **The audit surface** — when someone asks "is this codebase compliant?", what mechanical procedure answers that question?

If the answer to (2) is "consult the enumerated list in the convention doc and check those sites," the convention has built itself into the failure mode. New sites added after the doc shipped are invisible to the list. Sites the doc's author missed at write-time are invisible to the list. The list ages out the moment anyone touches the affected files.

**Before** (drift-vector shape — the original "When to Apply" section):

```markdown
### Sites that don't need the author pin

The following sites branch on `bridge_paper` for non-gating purposes
and are therefore exempt from the author conjunct:

- papers.ts:227-228 — source routing
- helpers.ts:47 — type-check helper
- comments.ts:38 — parent-type filter
- bridge.ts:90, 107 — bridge-only routes
- search.ts:59, 61 — type-routing
- stats.ts:60 — count-by-type aggregation
```

This shape fails three ways: it freezes a snapshot of "sites we thought through"; it implicitly licenses new sites to be added without the pin (because the doc says "non-gating is fine"); and it conflates two different audit questions ("does this site enforce the gate?" vs "is this site processing valid data?") into a single hand-curated table.

**After** (structural-rule shape):

```markdown
### Audit rule

Any expression that branches on `(json_metadata -> $appTag ->> 'type') = 'bridge_paper'`
(or analogous role types) MUST also bind `c.author = <pinned-identity>`. There are
no read-side exemptions. A bridge_paper from a non-bridge author is invalid data
and must not influence any PEvO surface.

### Mechanical audit

  # Every branch on the bridge_paper literal:
  grep -rn "'bridge_paper'" backend/src/ --include="*.ts"

  # Every site that imports the canonical helper:
  grep -rln "validPevoPaperWhere|isPevoBridgePaper" backend/src/ --include="*.ts"

Sites in the first grep but not the second are violations. The list of violations
is derived from the code at audit time, not from this doc.
```

The structural shape pushes the audit surface into the code itself. The grep is the source of truth; the doc explains the rule; the helper makes the rule impossible to write incorrectly.

**The complementary move: centralize the predicate so the rule cannot be re-violated by spelling.** The bridge-paper convention's correction added a `validPevoPaperWhere()` SQL fragment helper in `backend/src/lib/hafsql.ts`. Once every existing site is migrated to the helper, a CI grep guard for direct `'bridge_paper'` literals outside the helper file makes future drift loud — any new site has to either go through the helper (correct by construction) or trip the guard (caught at PR time).

## Why This Matters

**The convention doc was the drift vector.** The original `pevo-object-identity-is-author-vouching` doc was written carefully, by the same agent that had just resolved the underlying bypass, with the user explicitly engaged in three rounds of reframing. It still produced a defective audit surface. Six hours later, the adversarial reviewer found twelve additional sites — *several of which the doc itself had named as exempt*. The doc's exemption list wasn't a proofreading miss. It was a category error: enumerating sites is not the same kind of artifact as stating a rule.

The pattern compounds across three failure modes:

**1. The list is incomplete at write-time.** Every author of a convention doc has a working set — the files they were investigating, the search results they happened to run, the call sites they happened to remember. The exemption list reflects the working set, not the codebase. The doc ships claiming "these six sites are safe." It actually means "the author thought about these six and didn't think about the other twelve."

**2. The list ages out.** New code is added to a codebase every day. A convention doc that says "these are the gating sites; the rest are routing-only and exempt" implicitly tells future contributors that adding a new routing-only site is fine without the pin. The doc has frozen the codebase's state at write-time and licensed all future additions to bypass the rule.

**3. The framing licenses bad reasoning.** "Non-gating purposes" sounds principled. It isn't. It encodes a distinction the data-integrity rule doesn't actually make. In the bridge-paper case, the rule is "non-bridge-account `bridge_paper`s are invalid data." That rule fires the same way at gating sites and at routing sites. The "non-gating purpose" framing built in a false carve-out that the underlying integrity rule doesn't admit. Once the doc was on disk, future reviewers had to first un-believe the doc before they could see the violations.

In the worked sequence: the convention shipped at noon; the audit ran at 6pm; twelve violations surfaced, several of them on the doc's own exempt list. The adversarial reviewer caught it because they ran the grep instead of consulting the doc. If the reviewer had trusted the doc — which is what convention docs exist for — the bypass would have shipped.

**Convention docs are load-bearing infrastructure.** A defective convention doc actively prevents future scrutiny: it terminates the audit at "consult the list" instead of "run the grep." The same property that makes a convention doc useful (it captures hard-won reasoning so the next reader doesn't have to re-derive it) makes a defective convention doc dangerous (it captures a snapshot the next reader trusts without re-derivation). The asymmetry is the same one called out in `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`'s "false security claims derived from incomplete audits are more dangerous than acknowledged gaps." The exemption-list shape is the convention-doc analogue.

## When to Apply

This rule fires whenever a convention doc establishes an invariant of the form:

- "Every X must be wrapped in Y" (e.g., "every `argon2.hash` call must go through `runWithArgon2Slot`")
- "Every site that does Z must also bind W" (e.g., "every `bridge_paper` branch must bind `c.author = bridge`")
- "Never write Q directly" (e.g., "never broadcast a Hive op without `broadcastJsonWithTimeout`")
- "Always sanitize R before S" (e.g., "always pass user input through `sanitizeForFrontend` before writing to error responses")
- "Every Hive write must be replay-protected by U" (the request-binding shape in `hive-signature-request-binding-shape-2026-04-21.md`)
- "Every nullable column must be annotated as `T | null`" (the type-honesty rule in `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`)

Any convention with that shape needs a structural audit surface — not a list.

### Trigger checklist when writing or reviewing a convention doc

1. Does the doc enumerate "exempt sites" or "sites that don't need the wrapper"? **Red flag.** Either every site needs the rule or the rule is wrong.
2. Does the doc say "the following sites already comply, audit complete"? **Red flag.** The audit surface should be runnable, not historical.
3. Is the audit-time procedure "run this grep" / "check this type" / "look for this import"? **Green flag.** Mechanical, derivable from the codebase.
4. If the rule is violated, is the violation visible at PR time (CI grep, type error, lint rule)? **Green flag.** Drift is loud.
5. Does the rule rest on a centralized helper such that the only way to violate it is to bypass the helper? **Green flag.** Correct by construction.
6. Does the doc justify exemptions with reasoning like "non-gating purpose," "read-only context," "internal use only," "test code only"? **Red flag.** Those phrases are almost always doing more work than the underlying invariant supports — re-derive the invariant and ask whether it actually admits the carve-out.

### Grep targets for self-audit of existing convention docs

```bash
# Find convention docs that enumerate exempt sites
grep -rn "exempt\|don't need\|not required for\|safe without\|non-gating" \
  agents/docs/solutions/conventions/ --include="*.md"

# Find convention docs that hard-code site lists with line numbers
grep -rnE "\.ts:[0-9]+" agents/docs/solutions/conventions/ --include="*.md"
```

Both patterns are candidates for refactor to structural form. Some line-number references are legitimate (worked examples), but lists used as audit substitutes are drift vectors.

When refactoring a convention from list-based to structural form, the migration template is:

1. Replace the exempt list with the structural rule that should hold everywhere.
2. Identify a centralized helper / wrapper / type that mechanically enforces the rule.
3. Migrate all current sites to the helper. (This step usually surfaces the sites the original list missed.)
4. Add a CI grep guard or lint rule that flags direct usage of the wrapped primitive outside the helper.
5. Update the doc's "When to Apply" to point at the grep / type / import as the audit surface, not at a snapshot list.

### Mandatory companion: do not mark a convention doc "complete" until the audit surface is mechanical

A convention with a hand-curated exemption list is at best a *first draft*. The complete form ships when:

- The rule is stated structurally (no enumeration of safe sites).
- A centralized helper makes correct-by-construction the path of least resistance.
- A grep / type / lint guard makes drift loud.
- The doc points at the guard, not at a list.

A convention with only the rule and the list is incomplete. Document it that way ("structural enforcement TODO") rather than shipping the list as if it were the audit surface.

## Examples

### Case 1: bridge-paper exemption list (the trigger)

**Before** — the original `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` "When to Apply" enumerated six exempt sites under a "non-gating purposes" heading:

```markdown
### Sites that don't need the author pin

These sites branch on `bridge_paper` but serve non-gating purposes
(type-routing, source filtering, count-by-type aggregation, parent-type joins)
and are exempt from the author conjunct:

- backend/src/routes/papers.ts:227-228 (source query-param routing)
- backend/src/lib/helpers.ts:47 (isPevoBridgePaper helper)
- backend/src/routes/comments.ts:38 (parent-paper-type filter)
- backend/src/routes/bridge.ts:90, 107 (bridge-only routes)
- backend/src/routes/search.ts:59, 61 (type-routing when source param set)
- backend/src/routes/stats.ts:60 (count-by-type aggregation)
```

The audit on commit `497795e` ran the full grep instead of trusting the list and found twelve unguarded sites — including direct counter-examples to several of the named exemptions. The "non-gating purpose" framing was a false carve-out: spoofed `bridge_paper`s flowing through routing, filtering, or aggregation still pollute search results, stats, comment threads, sitemap, notifications, reputation calculations, and bridge-register duplicate-checks.

**After** — the same section, restated structurally with a centralized helper and CI guard:

```markdown
### Audit rule

Any expression that branches on `(json_metadata -> $appTag ->> 'type') = 'bridge_paper'`
(or analogous role types) MUST also bind `c.author = config.hiveBridgeAccount`. There
are no read-side exemptions.

### Centralized helper (correct by construction)

backend/src/lib/hafsql.ts exports validPevoPaperWhere(), a SQL fragment that
emits the type-and-author predicate together. All paper-filter sites compose
against this. Direct 'bridge_paper' string literals outside the helper file
are violations.

### Mechanical audit

  # Every branch on the bridge_paper literal:
  grep -rn "'bridge_paper'" backend/src/ --include="*.ts" \
    | grep -v 'src/lib/hafsql.ts'

  # Should be empty after migration. CI lint flags any reintroduction.
```

The migration touched 15 sites (the original 3 already-pinned plus the 12 newly-discovered) and added a pre-commit grep guard. New sites added after the migration are correct by construction (they import the helper) or caught at PR time (they trip the guard).

### Case 2: hypothetical — a future "every Hive broadcast must use `broadcastJsonWithTimeout`" rule

Suppose a future task introduces `broadcastJsonWithTimeout(client, op, opts)` in `backend/src/lib/hive-broadcast.ts` to enforce timeout-and-retry semantics on every chain write, motivated by the `chain-write-timeout-ambiguous-outcome-2026-04-22.md` learning. The rule is "every `client.broadcast.*` call goes through the wrapper."

**Drift-vector convention doc** (do not write this):

```markdown
### When to apply

Wrap every chain write through broadcastJsonWithTimeout. The following sites
were updated as part of the migration and are compliant:

- backend/src/routes/auth.ts:412 (claim-account)
- backend/src/services/accreditation.ts:88 (issue attestation)
- backend/src/services/anon-proxy.ts:154 (post anonymous review)

The following sites were intentionally left unwrapped because they run on
operator-only paths or in test fixtures:

- backend/src/scripts/seed-bridge-papers.ts (operator script, not a request handler)
- backend/test/fixtures/post-helper.ts (test fixture, not production code)
```

This shape locks in two failures: any new request handler added after the doc ships is invisible to the list, and the "intentionally exempt" sub-list licenses operator scripts and test helpers to bypass the wrapper indefinitely — even though some of those scripts may later be promoted to background jobs that absolutely should be wrapped.

**Structural convention doc** (write this instead):

```markdown
### Audit rule

Every call to client.broadcast.* MUST go through broadcastJsonWithTimeout.
There are no exempt sites. If a script or test fixture genuinely needs to
bypass the wrapper, it must do so via an explicit broadcastJsonWithTimeout(...,
{ timeout: Infinity }) call documenting the bypass — not by calling the raw
client directly.

### Mechanical audit

  # Every direct call to the raw broadcast client:
  grep -rn 'client\.broadcast\.' backend/src/ --include="*.ts" \
    | grep -v 'src/lib/hive-broadcast.ts'

  # Should be empty. CI lint flags any reintroduction.

### Drift posture

If the team later decides operator scripts should be permanently exempt, that
is a change to the rule itself (e.g., "every request-handler call must be
wrapped; operator scripts may bypass") — and the audit surface must change
accordingly (e.g., "grep restricted to backend/src/routes/ and backend/src/services/").
Do NOT encode the exemption as a hand-curated list of script paths in this doc.
```

The structural shape forces a decision the list shape obscures: either the rule applies to every site (and the wrapper accommodates the operator-script use case via an explicit option), or the rule's scope is a structural subset of the codebase (a directory, a file pattern, a TypeScript type) — never a hand-curated list of "files we thought about." Drift becomes either impossible (correct-by-construction) or loud (CI grep), but never silent.

### Generalized template

For every convention doc establishing an invariant:

```
RULE:        <structural property that must hold across all sites>
SCOPE:       <a directory, file pattern, or import-graph subset, not a list>
ENFORCEMENT: <a centralized helper / wrapper / type that makes correct usage easy>
AUDIT:       <a grep / type-check / lint rule that surfaces violations mechanically>
DRIFT GUARD: <a CI check that runs the audit on every PR>
```

Never:

```
RULE:        <invariant>
EXEMPT SITES:
  - file_a.ts:123
  - file_b.ts:45
  - file_c.ts:78
```

The first form is a runnable audit surface that scales with the codebase. The second form is a snapshot of the author's working set at write-time, frozen against a moving target. The bridge-paper case demonstrated, with twelve concrete counter-examples, what happens when a convention chooses the second form.

## Related

- [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) — the convention this learning critiques and abstracts from. That doc is the concrete instance (read-side gate for `bridge_paper` must bind `c.author = config.hiveBridgeAccount`); this doc is the meta-rule abstracted from it (don't enumerate exempt sites; structural audit surface). Read both. The original doc has been corrected to follow the structural shape; this learning explains why.
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — sibling meta-rule from the same family. That doc establishes the discipline that any load-bearing universal-coverage claim must be verified by grep, never by mental enumeration; it operates at the code-implementation layer ("verify the wrapping primitive is adopted everywhere"). This doc extends the discipline to the convention-authorship layer ("don't enumerate exempt sites in the convention doc itself"). Cross-cited from the bridge-paper convention.
- [`object-shape-fix-every-reset-site-2026-04-21.md`](object-shape-fix-every-reset-site-2026-04-21.md) — same partial-enumeration failure mode at a different layer (Alpine state writes vs convention authorship). The "grep every assignment site, don't trust mental enumeration" discipline travels across layers; this learning is its convention-doc analogue.
- [`hold-block-must-not-contradict-convention-docs-2026-04-22.md`](hold-block-must-not-contradict-convention-docs-2026-04-22.md) — adjacent convention-doc-as-load-bearing-artifact concern. That doc warns hold blocks against contradicting existing conventions; this doc warns conventions against undermining themselves through enumerated exemptions. Both treat convention docs as production infrastructure, not casual documentation.
- [`cross-task-hold-block-staleness-2026-04-22.md`](cross-task-hold-block-staleness-2026-04-22.md) — analogous staleness pattern at the hold-block layer. Both share the meta-pattern "point-in-time enumerations need re-verification or structural replacement"; the failure mode at the hold-block layer is parallel work shifting the ground; the failure mode at the convention layer is the codebase shifting beneath the doc. Different artifacts, same underlying drift mechanism.
