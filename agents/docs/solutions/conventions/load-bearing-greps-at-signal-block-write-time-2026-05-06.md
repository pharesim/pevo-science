---
title: "Run load-bearing greps at signal-block-write-time, not deferred to architect-followup at archive"
date: 2026-05-06
category: conventions
module: process/round-protocol
problem_type: convention
component: development_workflow
severity: medium
applies_when:
  - "A commit wraps, threads, or gates a primitive that has multiple call sites"
  - "The implementer's signal block enumerates call sites by mental inspection rather than grep output"
  - "An architect hold item adds a grep as an architect-followup-AT-ARCHIVE action"
  - "Any round's signal block claims exhaustive coverage of a code surface without showing grep output"
  - "A new call site of a wrapped primitive is introduced or suspected mid-task"
related_components:
  - wrapping-primitive-exhaustive-call-site-audit-2026-04-22
  - process/signal-block
tags:
  - grep
  - call-site-audit
  - round-protocol
  - signal-block
  - exhaustive-coverage
  - implementer-discipline
  - architect-followup
  - deferred-grep
---

# Run load-bearing greps at signal-block-write-time, not deferred to architect-followup

## Context

When an architect hold block names an exhaustive call-site grep as a required check ("before archive, the architect MUST run `grep -n '<primitive>' <file>`"), it defers the audit by one full round. The implementer lands fixes, signals review, the architect picks up the task, runs the grep at archive intake, finds another missed site, and must hold again. The gap reproduces itself.

The canonical-walker task (`BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE`, archived 2026-05-06) ran this failure mode across two consecutive rounds. Round-1 (`e2f7e1b`) threaded `HeadAuthorsMemo` through three visible call sites of `reconstructVersionsFromHaf` and `fetchHeadAuthorizedAuthors` by mental enumeration; missed a fourth site at `papers.ts:1421`. The round-2 architect review of commit `3bef3de` caught `:1421` and added hold item A2 instructing a grep audit "before round-3 archive" — architect-followup-AT-ARCHIVE timing. Round-3 implementer (`095328b`) ran the A2 grep at signal-block-write-time instead of waiting, and found a fifth site at `papers.ts:571` inside `fetchPaperDetailFromHaf` that the round-2 hold-block enumeration had also missed. Implementer threaded memo there in the same round-3 commit.

Two consecutive rounds of catches: round-2 caught `:1421`, round-3 caught `:571`. Both could have been caught one round earlier if the grep had been run at the prior round's signal-block boundary. The deferral created one-round latency per missed site.

## Guidance

**The rule:** when a hold block names a grep audit as a required check on a multi-call-site primitive, that grep runs at the implementer's signal-block-write-time — the moment the implementer is preparing to `git mv pending/ → review/` after completing the round. It does not defer to architect-followup-at-archive.

**For the architect writing a hold block:** do not tag the grep as `architect-followup-AT-ARCHIVE`. Instruct the implementer to run it and include the output in the signal block.

Instead of:

> **A2 (architect-followup-AT-ARCHIVE):** Before round-3 archive, the architect MUST run `grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts` and confirm every call site that has `headAuthorsMemo` in scope passes it.

Write:

> **A2 (implementer-MUST-at-signal-block):** Before `git mv` to `review/`, run:
> ```bash
> grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts | grep -v 'async function\|@param\|//'
> grep -n 'fetchHeadAuthorizedAuthors' backend/src/routes/papers.ts | grep -v 'async function\|@param\|//'
> ```
> Include the full output in the signal block. Every matched call site must pass `headAuthorsMemo`. If a site is missing the argument, thread it before signaling.

**For the implementer responding to a hold block:** when the hold names a grep audit on a primitive being threaded (memo, abort token, options bag, signal), the audit output belongs in the signal block. The grep is part of the round. Running it at a later stage defeats its purpose.

Shape of a compliant signal block section:

```
## Grep audit (A2)

$ grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts \
    | grep -v 'async function\|@param\|//'
  571:    const versions = await reconstructVersionsFromHaf(author, permlink, chain, memo);
  1425:   const versions = await reconstructVersionsFromHaf(author, permlink, undefined, memo);
  1550:   const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo);
  1587:   const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo);

:571 was missing the memo arg pre-this-commit — threaded in this round.
:1425, :1550, :1587 confirmed passing the memo.
```

The implementer threads any discovered gap in the same commit before signaling. The architect's intake grep at archive becomes a confirming scan, not a discovery scan.

**For any primitive newly added to an existing helper signature** (new optional parameter, new threading requirement), run the exhaustive grep at the same commit that adds the primitive — even before a hold block exists — and enumerate any sites left un-updated in the signal block with an explicit rationale for each.

## Why This Matters

The round protocol is PEvO's cross-zone coordination gating mechanism. Round-N is supposed to catch what round-(N-1) missed. When a load-bearing grep is deferred from round-N to round-(N+1) as an architect-followup, it converts a same-round catch into a next-round catch — adding a full hold-fix-re-review cycle per deferred audit item.

In the canonical-walker task, the cost was concrete: two sites missed across two rounds, each requiring a separate hold. Under grep-at-signal-block discipline, round-2 would have discovered both `:1421` and `:571`, threaded both in round-2's commit, and the task would have closed one round earlier. Instead, the task ran three rounds.

PEvO's multi-author tasks family (canonical-walker, continuation-chain, co-author publishing) touches the same primitives (`reconstructVersionsFromHaf`, `fetchHeadAuthorizedAuthors`, `extractAuthorizedContinuationAuthors`) repeatedly across different routes. Missed call sites in that family have direct correctness consequences: a call site that does not pass `headAuthorsMemo` re-fetches authorized authors from HAF on every invocation, bypassing the per-request deduplication the memo was introduced to provide. The grep is not documentation; it is the final correctness gate for the threading change.

Deferring that gate to the architect compounds in proportion to the number of call sites. Mental enumeration scales poorly against a 1,500-line route file; grep does not.

## When to Apply

- **Architect writing a hold block:** whenever the hold names any variant of "grep audit," "exhaustive call-site check," "verify all call sites pass X," or "confirm N is threaded everywhere" — tag the item `implementer-MUST-at-signal-block`, not `architect-followup-AT-ARCHIVE`.
- **Implementer completing a round:** whenever the hold block names a primitive being threaded through call sites (memo, abort token, options bag, session context, signal), run the grep before `git mv pending/ → review/` and include the output in the signal block. If the output reveals an untreaded site, thread it in the same commit.
- **Implementer adding a new optional parameter to a shared helper:** run the exhaustive grep at the same commit that modifies the helper signature. Do not wait for a hold block to mandate it.
- **Architect at archive intake:** run the confirming grep as a sanity check, not as the primary discovery scan. If the confirming grep finds a site the signal block did not enumerate, that is a signal-block protocol violation — note it in the archive entry and surface to the implementer for future rounds.

This convention applies whenever the parent discipline (`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`) applies and the primitive change spans multiple rounds. Single-round tasks that introduce and complete threading in one commit are already covered by the parent's same-commit grep rule.

## Examples

### Anti-pattern: architect defers the grep to archive

Architect hold block (round-2):

```markdown
**A2 (architect-followup-AT-ARCHIVE):** Before round-3 archive, the architect
MUST run:
  grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts
  grep -n 'fetchHeadAuthorizedAuthors' backend/src/routes/papers.ts
and confirm every call site that has `headAuthorsMemo` in scope passes it.
```

Effect: the implementer's round-3 commit goes in without running the grep. The architect runs it at archive and finds `papers.ts:571` missing the argument. Another hold is issued. Round-4 required.

### Correct pattern: architect requires grep output in the signal block

Architect hold block (round-2):

```markdown
**A2 (implementer-MUST-at-signal-block):** Before `git mv` to `review/`, run
the following and include full output in the signal block:

  grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts \
    | grep -v 'async function\|@param\|//'
  grep -n 'fetchHeadAuthorizedAuthors' backend/src/routes/papers.ts \
    | grep -v 'async function\|@param\|//'

Every matched call site must pass `headAuthorsMemo` (or the appropriate
positional placement). Thread any site that does not — in this commit,
before signaling.
```

Implementer signal block (round-3):

```markdown
## A2 — grep audit (at signal-block-write-time)

$ grep -n 'reconstructVersionsFromHaf' backend/src/routes/papers.ts \
    | grep -v 'async function\|@param\|//'
  571:  const versions = await reconstructVersionsFromHaf(author, permlink, chain, memo);
  1425: const versions = await reconstructVersionsFromHaf(author, permlink, undefined, memo);
  1550: const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo);
  1587: const versions = await reconstructVersionsFromHaf(author, permlink, undefined, headAuthorsMemo);

$ grep -n 'fetchHeadAuthorizedAuthors' backend/src/routes/papers.ts \
    | grep -v 'async function\|@param'
  955:  const authorizedAuthors = await fetchHeadAuthorizedAuthors(pool, author, permlink, memo);
  1156: const authorizedAuthors = await fetchHeadAuthorizedAuthors(pool, currentAuthor, currentPermlink, memo);

:571 was missing the memo arg pre-this-commit — threaded in this round.
All other sites confirmed.
```

Effect: the gap is caught and closed within round-3. Architect's archive-intake confirming grep finds nothing new. Task closes.

### Concrete canonical-walker evidence

The round-2→round-3 hold for canonical-walker contained both phrasings of A2 in adjacent paragraphs:

> **A2 (initial framing — anti-pattern):** before round-3 archive, the architect MUST run `grep -n "reconstructVersionsFromHaf" backend/src/routes/papers.ts` ...

> **A2 (load-bearing escalation):** A2 is now load-bearing; running the two-grep audit at round-3 commit time is mandatory to confirm no fourth call site remains undiscovered.

The escalation paragraph supersedes the initial phrasing. The implementer interpreted the corrected version, ran the grep at signal-block-write-time, and discovered `papers.ts:571`. This convention codifies the corrected version directly: hold blocks should write the implementer-at-signal-block phrasing first, without an anti-pattern phrasing that needs subsequent escalation.

## Related

- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — Parent discipline: run the grep, do not perform the audit mentally. This document strengthens its temporal axis: WHEN the grep runs matters as much as WHETHER it runs. The parent doc's "When to Apply" section is currently silent on timing; expect a refresh that adds an implementer-at-signal-block-write-time rule pointing here.
- [`per-request-memo-catch-block-negative-cache-contract-2026-05-06.md`](per-request-memo-catch-block-negative-cache-contract-2026-05-06.md) — Domain-specific contract from the canonical-walker task family. The `:571` discovery that motivates this convention also surfaced in that contract's audit-grep section; the two cover different axes of the same threading work (catch-path enforcement vs round-protocol timing).
- [`symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md`](symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md) — Sibling meta-rule from the same task family: read full prototype hold history before mirroring a convention to a symmetric walker. Different failure mode (incomplete prototype-doc reading), same canonical-walker substrate.
- [`enumerated-exemption-lists-are-drift-vectors-2026-04-28.md`](enumerated-exemption-lists-are-drift-vectors-2026-04-28.md) — Methodological ancestor: audit surfaces must be structural (grep-derivable), not hand-curated. This convention's temporal rule is downstream of that principle: structural derivation is necessary but not sufficient — when in the round cycle the derivation runs is also load-bearing.
- [`object-shape-fix-every-reset-site-2026-04-21.md`](object-shape-fix-every-reset-site-2026-04-21.md) — Meta-pattern ancestor: audit the full surface, not just the reported site. Applied historically to Alpine reset sites; applies here to call-site enumeration of wrapped primitives.
- Root `CLAUDE.md` rule #8 (review → held-pending-fixes → re-review cycle) — The round protocol context this convention operates within. The signal-block is the artifact at the boundary of each round; this convention specifies what load-bearing audit work belongs inside it.
