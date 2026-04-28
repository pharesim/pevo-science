---
title: "PEvO object identity is author vouching, not metadata claim — every carve-out gate must terminate in an identity predicate"
date: 2026-04-28
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
applies_when:
  - "Adding a carve-out, exemption, or special-case admit rule that keys off a metadata flag, type, or role on a Hive post or comment"
  - "Defining what counts as a PEvO object (paper, review, bridge_paper, continuation, moderator_post, etc.) at any read or write surface"
  - "Reviewing a 404 vs hide-vs-confidential decision on PEvO endpoints — whether the gate is enforcing object identity or hiding confidentiality"
  - "Triaging asymmetric retention of an `accredited_only` opt-out across surfaces during a hard-gate hardening pass"
  - "Auditing any `(c.json_metadata -> $appTag ->> 'type') = '...'` branch in route handlers, search, stats, or filters"
  - "Reviewing a SQL WHERE clause whose OR-arm right-hand side has no `c.author = ...` or `c.author IN (...)` predicate"
  - "Reviewing a JS/TS conditional that grants special handling based on a metadata-derived discriminant"
  - "Adding a new content type to PEvO's object set (e.g. `bridge_review`, `moderator_post`, future syndication types) — the gate must treat the new type as identity-anchored from day one"
related_components:
  - backend-papers-routes
  - backend-search
  - backend-reviews-routes
  - accreditation-service
  - hive-bridge-account
  - architecture-doc
tags:
  - pevo-object-identity
  - accreditation-gate
  - bridge-paper
  - author-vouching
  - hive-metadata
  - hard-gate
  - ontological-framing
  - carve-out-audit
  - self-asserted-role-escalation
  - identity-predicate
  - read-gate
  - write-gate
---

# PEvO object identity is author vouching, not metadata claim

## Context

The accreditation gate across `backend/src/routes/papers.ts`, `search.ts`, and `stats.ts` was tightened during a `/ce-doc-review` triage on the `backend-papers-filter-accreditation.md` task. The task started as a tests-only canary, expanded twice, and went through three architect-resolution passes:

1. Round 1 picked option (d) "hard-gate the reviews surface only."
2. Round 2 (after user pushback on retained `accredited_only=false` opt-out asymmetry) expanded to "hard-gate everywhere."
3. Round 3 (after user pushback again — *"We don't need to protect accreditation status, that's public"*) reframed the entire stance from privacy/curatorial to **ontological**.

The reframe surfaced a concrete bypass that had been latent in the codebase. The bridge-paper carve-out at `backend/src/routes/papers.ts:263` (and parallel sites at `search.ts:82` and `stats.ts:46`) trusted a self-asserted `json_metadata.type === 'bridge_paper'` flag with no author check:

```sql
(c.author IN (SELECT account FROM active_accreditations)
 OR (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper')
```

Any unaccredited Hive account could post a comment with `parent_permlink = 'pevotest'`, `parent_author = ''`, and `json_metadata.pevotest.type = 'bridge_paper'` to bypass the gate entirely. The post would land on `/api/papers`, `/api/search`, and the disciplines/stats aggregates without any author-side enforcement. `agents/docs/ARCHITECTURE.md:87` already promised author-pinning *"by the system bridge account"* — but the SQL didn't enforce it. Doc-vs-code drift hiding a P0 attack surface.

This learning captures the generalizable rule the reframe revealed.

## Guidance

**The metadata field is *what*; the author is *who*. Authorization is *who*, not *what*.**

Any carve-out in an authorization gate (SQL `OR`-arm, JS `if`-branch, middleware exemption) must admit content based on **author vouching**, not on metadata flags the content asserts about itself. A type tag, role label, or category flag is a claim by the content; it is not evidence of identity. If your exemption rests on `metadata.type === 'X'` without an `author = <pinned-identity>` conjunct, an unauthenticated writer can mint the exemption for themselves.

**Before** (`backend/src/routes/papers.ts:263`):
```sql
(c.author IN (SELECT account FROM active_accreditations)
 OR (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper')
```
The right arm of the OR has no author predicate. Any account can self-declare `type = 'bridge_paper'` and pass.

**After**:
```sql
(c.author IN (SELECT account FROM active_accreditations)
 OR (c.author = ${bridgeParam}
     AND (c.json_metadata -> ${appTagParam} ->> 'type') = 'bridge_paper'))
```
The exemption now requires the pinned bridge author **and** the type claim. The type narrows what the bridge account is doing on this row; identity is what grants the exemption.

The general rule: **every OR-arm in an authorization gate must terminate in an identity predicate** (`author = <pinned>`, `signer IN <vouched-set>`, `actor.id = <known>`), and the metadata predicate is at most a *narrowing* conjunct on top of that identity, never a substitute for it.

### Companion architectural distinction

This convention also distinguishes two stances that PEvO's documentation previously conflated:

- **Write-gate** (integrity invariant, root `CLAUDE.md` "Accreditation is the trust layer"): publishing/reviewing/commenting/voting are restricted to accredited accounts on the *write* path. The platform itself only helps accredited users author PEvO objects.
- **Read-gate** (ontological boundary, this convention): PEvO API surfaces serve PEvO objects only. An on-chain `APP_TAG`-tagged Hive comment authored by a non-vouched account is *not a PEvO object* — it is invisible to PEvO surfaces because it isn't an object, regardless of how its metadata is shaped.

Accreditation status is itself **public** (queryable via `/api/accreditations`, the `active_accreditations` table, on-chain `custom_json` accreditation attestations). The read-gate is not hiding confidentiality; it is enforcing object identity.

## Why This Matters

**Concrete failure mode.** Without the author conjunct, the bridge-paper carve-out is a self-service exemption: an unaccredited Hive account posts a comment with `json_metadata.pevotest.type = 'bridge_paper'`, and the API serves it as a PEvO bridge paper. Listings, search, and stats all pick it up. The frontend may render misleading external-DOI links (since bridge papers display source metadata as if it came from a vetted external source). The accreditation gate is fully bypassed for that row.

**Generalizable risk class.** This is the **self-asserted role escalation** pattern. It appears whenever an authorization decision branches on a flag the requesting/authoring party controls. Every new object type, role, or category added later widens the attack surface unless the gate is written so the identity predicate is structural, not optional.

The ontological framing makes the rule load-bearing: a "bridge paper" authored by an unvouched account is *not a bridge paper at all*; it is a Hive comment cosplaying as one. Treating self-claims as authoritative collapses the boundary the platform exists to enforce.

The companion distinction matters too: the **write-gate** (only accredited accounts can broadcast publish/review/comment/vote ops) is an integrity invariant, but it does not protect *read* surfaces from arbitrary on-chain noise authored by anyone with a Hive account. The **read-gate** is the ontological boundary, and self-asserted metadata is exactly the wrong axis to draw it on.

## When to Apply

Apply this rule any time a gate has an OR-arm, fall-through branch, or middleware bypass that admits content based on a type/role/category claim the content carries.

### Grep targets in this codebase

- SQL: any `WHERE` clause with an OR whose right arm lacks an `author =` / `signer =` / `account IN` predicate.
  - Pattern: `OR (c.json_metadata`
  - Pattern: `json_metadata ... ->> 'type') =` inside a WHERE clause
- JS/TS: branches on metadata-derived discriminants followed by privilege grants.
  - Pattern: `if (... === 'bridge_paper')` or analogous role tokens (`'moderator_post'`, `'continuation'`, future types).
  - Pattern: `if (metadata.type === '<role>')`
  - Pattern: `if (post.tags.includes('<privileged>'))` followed by an admit/exempt branch
- Switch/case on a metadata-derived discriminant where one case skips an auth check.

### Trigger checklist when reviewing such code

1. Does the exempted branch run an identity predicate (`author = <pinned>`, signer-set membership, JWT-subject match)?
2. Is the identity predicate a hard conjunct, not an optional/coalesced check?
3. Is the pinned identity stored server-side (config, env, DB), not derived from the request payload?

If any answer is no, the gate is self-assertable and must be tightened.

### Mandatory grep audit before claiming "all carve-outs are author-pinned"

Mirror the discipline established by `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`: run the grep, do not perform the audit mentally. For each `bridge_paper`-class exemption type, run:

```bash
grep -rn "<exempted-type>" backend/src/ --include="*.ts"
```

For each match, verify whether the surrounding code is:

- **A gate site** (an authorization OR/IF that admits content) → must have `author = <pinned>` conjunct.
- **A non-gate site** (type-routing for source filtering, type-based rendering, count-by-type aggregation) → no author pin needed; document why in a one-line comment so future readers know the difference.

Examples in this codebase that are NOT gate sites and don't need the author pin:
- `papers.ts:227-228` — `source` query-param routing (filters by paper source for the user, not for authorization).
- `helpers.ts:47` — `isPevoBridgePaper()` — used for paper-detail rendering after the gate has already filtered.
- `comments.ts:38` — `IN ('paper', 'bridge_paper')` — parent-paper-type filter for joining comments to papers.
- `bridge.ts:90, 107` — bridge-only routes; the route's own auth check covers the identity binding.
- `search.ts:59, 61` — type-routing when `source` param is set.
- `stats.ts:60` — count-by-type aggregation.

## Examples

### Bridge paper (the case that prompted this)

See Guidance section above for the before/after.

### Hypothetical: bridge review

Suppose a future task adds a `bridge_review` type so the bridge account can mirror off-chain reviews. The naive gate:

```sql
-- WRONG: self-assertable
WHERE c.author IN (SELECT account FROM active_accreditations)
   OR (c.json_metadata -> ${appTag} ->> 'type') IN ('bridge_paper', 'bridge_review')
```

The fix is the same shape: pin to the bridge account.

```sql
-- RIGHT: identity-anchored
WHERE c.author IN (SELECT account FROM active_accreditations)
   OR (c.author = ${bridgeAccount}
       AND (c.json_metadata -> ${appTag} ->> 'type') IN ('bridge_paper', 'bridge_review'))
```

### Hypothetical: moderator post

Suppose moderation actions are surfaced as a `moderator_post` type. The wrong shape lets anyone self-mod by setting the flag:

```ts
// WRONG
if (post.json_metadata?.[appTag]?.type === 'moderator_post') {
  return post; // exempt from accreditation filter
}
```

Right shape requires the author to be in a server-side moderator set:

```ts
// RIGHT
if (
  post.json_metadata?.[appTag]?.type === 'moderator_post' &&
  config.moderatorAccounts.includes(post.author)
) {
  return post;
}
```

### Generalized template

For every carve-out:

```
admit(content) iff
  author(content) ∈ vouched_identity_set
  AND (optionally) metadata(content) narrows to expected shape
```

Never:

```
admit(content) iff
  metadata(content).type ∈ privileged_types
```

The first form is ontological — identity decides membership, metadata decides sub-kind. The second form is self-service — the content writes its own admission ticket.

## Related

- [`test-config-mock-distinct-role-accounts-2026-04-21.md`](test-config-mock-distinct-role-accounts-2026-04-21.md) — sibling rule from the same SEC-003-BE incident family. Covers the **testing-side** prevention surface (test config must distinguish role accounts so config collapse doesn't mask the same gap). This doc covers the **production-code-side** prevention surface (the gate predicate shape itself). Two rules, one root cause, two prevention surfaces.
- [`hive-signature-request-binding-shape-2026-04-21.md`](hive-signature-request-binding-shape-2026-04-21.md) — adjacent "the principal must be bound to the request, not self-asserted" pattern at the authentication layer. The canonical replay-protection doc. Same family of "self-assertion is not authorization" reasoning, applied to the request-binding axis rather than the gate-predicate axis.
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — different concern (catch-block error-class cross-product audits), but shares the **grep-not-mental-audit** discipline. The audit checklist in "When to Apply" mirrors that doc's methodology applied to gate predicates.
- `agents/docs/ARCHITECTURE.md` "Accredited-Only Data Policy" — the architectural framing this convention substantiates; the read-gate vs write-gate distinction lives there.
- `backend-bridge-paper-author-gate.md` (P0, blocks `backend-papers-filter-accreditation.md`) — the concrete fix for the bypass that triggered this learning.
- Auto-memory note `project_admin_is_singular.md` — the role-account topology (admin singular; bridge/anon/onboard distinct) the gate predicate must defend.
