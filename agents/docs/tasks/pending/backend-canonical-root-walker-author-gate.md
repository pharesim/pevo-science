# BACKEND-CANONICAL-ROOT-WALKER-AUTHOR-GATE — Gate `findCanonicalRoot` against attacker-controlled `pevo.continues` pointers

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by ε `/ce-code-review` cluster B)
**Priority:** P2 (security + reliability)

## Why now

ε's continuation-author-consent gate closes the FORWARD content-spoof: an outsider posting `pevo.continues = {alice, paper-v1}` cannot surface as alice's apparent v(N+1). Cluster-B review surfaced a residual surface: the BACKWARD walker `findCanonicalRoot` at `routes/papers.ts:805-852` walks attacker-controlled `pevo.continues` pointers WITHOUT an author check.

### Two attack vectors

#### 1. URL-redirect phishing pretext (security correctness #3, conf 55)

Attacker posts `attacker/fake-paper` with `pevo.continues = {alice, paper-v1}` and `pevo.type = 'paper'`. When a user navigates to `/api/papers/attacker/fake-paper`, `findCanonicalRoot` walks the `continues` pointer backward to `alice/paper-v1`, redirects, displays alice's content. The attacker's URL pretends to be alice's paper.

This is a phishing pretext — share `https://beta.pevo.science/papers/attacker/fake-paper` in a phishing message; victim clicks, sees alice's legitimate paper, builds trust, then attacker harvests credentials via a second-stage redirect or social-engineering follow-up.

The forward gate (continuation-author-consent) doesn't block this because the walk is BACKWARD: alice's paper IS the displayed content; the URL just SHOULDN'T resolve to alice's paper from an unrelated attacker post.

#### 2. DoS amplifier via 51-query walk

`findCanonicalRoot` walks UP TO 51 SQL queries per request, fully attacker-induced. An attacker can post a chain of 51 continuation posts pointing at each other, then navigate to the deepest one — the walker does 51 SQL queries before reaching the (non-existent) root. Repeated requests amplify into 51× DB load per request.

## Goal

Add author-consent gating to `findCanonicalRoot` mirroring the forward gate, AND bound the walker depth to a small constant.

## Acceptance

### 1. Author-consent gate on the backward walker

`routes/papers.ts:805-852` `findCanonicalRoot`:
- BEFORE walking each `continues` pointer back, fetch the candidate predecessor's `pevo.authors[]`.
- Apply the same `isAuthorizedContinuationAuthor(currentPost.author, predecessor.metadata, predecessor.author)` check used in the forward gate.
- If the current post's author is NOT in the predecessor's authorized set: STOP walking. Return the current post as its own canonical root (i.e., the chain is broken at the unauthorized hop).

Effect: an attacker post `attacker/fake-paper` with `pevo.continues = {alice, paper-v1}` returns canonical root = `attacker/fake-paper` (since attacker is NOT in alice's authors). The URL `/api/papers/attacker/fake-paper` displays attacker's own content, not alice's.

### 2. Bound walker depth

Cap the walker at 10 hops (or whatever PEvO-realistic max chain depth is — verify against existing chains). Beyond the cap: return current post as canonical root. Logs a structured warn `event: 'canonical_root_walker_depth_exceeded'` so operators can detect attack patterns.

### 3. Memoize per-request

`findCanonicalRoot` walks the chain up; `resolveContinuationChain` walks it down. Both call `fetchHeadAuthorizedAuthors` (or the equivalent metadata fetch) — there's redundancy. Memoize the per-`(author, permlink)` metadata fetch within a request scope (Map keyed on `author/permlink`, cleared at request end).

### 4. Tests

- Phishing pretext: post attacker chain pointing at alice; assert `/api/papers/attacker/fake` returns attacker's content, not alice's.
- DoS amplifier: post 11-hop chain; assert walker stops at hop 10 + structured warn fires.
- Legitimate self-continuation: alice continues her own paper; backward walk admits up to root.
- Legitimate co-author continuation: bob (in alice's authors[]) continues alice's paper; backward walk admits.

### 5. Convention update

Update `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` to note that the gate applies to BOTH forward AND backward chain walks. Add `findCanonicalRoot` to the "Sites this convention applies to" list.

Architect-owned; backend leaves [TODO Architect] markers.

[TODO Architect] Update `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` "Sites this convention applies to" sub-section to add `findCanonicalRoot` (BACKWARD walker in `backend/src/routes/papers.ts`) alongside the existing `resolveContinuationChain` (FORWARD walker) entry. Predicate shape: at every backward hop, the child post's chain-level author must be in the predecessor's authorized-authors set (per `extractAuthorizedContinuationAuthors`); enforced JS-side only since the backward walk is per-post (no SQL ANY()-filterable candidate set). Hard depth cap at `CANONICAL_ROOT_MAX_HOPS = 10` (vs. forward walker's `MAX_HOPS = 50`) — backward walk is fully attacker-induced (anyone can post a continuation pointer chain), forward walk is bounded by who is authorized into the root's named-author set. Per-request memo (`HeadAuthorsMemo`) shared between both walkers. Canary test file: `backend/tests/routes/canonical-root-walker.test.ts`.

## Out of scope

- Restructuring `findCanonicalRoot` to use a different traversal pattern. Author-consent gating + depth cap closes the surface; structural refactor is separate.
- Caching the canonical-root result in Redis. Per-request memoization is sufficient at current scale; Redis cache adds complexity.
- Frontend SPA changes. The phishing-pretext defense lives entirely server-side.

## Coordination

- **ε's hold-block:** ε round-2 lands the FORWARD gate strengthening (type-spoof fix + locked fields + lowercase normalization + TOCTOU mitigation + cache invalidation + double-fetch dedup). After ε archives, this task closes the BACKWARD walker surface.
- **Per-request memoization:** coordinate with ε's `fetchHeadAuthorizedAuthors` double-fetch dedup so both forward + backward walkers share the same memo cache.

## Source

- ε `/ce-code-review` (cluster B, 2026-05-04): correctness #3 (P3 conf 55) + adversarial findings on attacker-controlled URL aliasing. Filed in ε's "Items deferred" → "Phishing-pretext + DoS amplifier warrant their own task scope".

## Cross-references

- ε task `backend-continuation-post-author-consent-gate.md` — sibling task; landed the FORWARD gate.
- `agents/docs/solutions/conventions/pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` — parent convention.
- `routes/papers.ts:805-852` `findCanonicalRoot` — current implementation.

---

## Architect re-review (2026-05-05, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `e2f7e1b` with 10 reviewers (correctness, testing, maintainability, project-standards, learnings-researcher, security, kieran-typescript, reliability, performance; ce-agent-native-reviewer skipped per repo CLAUDE.md). Adversarial reviewer dispatched but stalled at the 600s watchdog with a partial trace covering 10 attack constructions; its key claim (type-spoof on START post — finding #2 below) was verified by direct code inspection at `routes/papers.ts:992-1014`.

The implementation closes phishing-pretext for outsider attacks (acceptance #1-#4 land correctly for that threat). It leaves an insider-abuse URL-aliasing surface via type-spoof on the START post, plus several memo / cast / observability gaps. Round-2 bundles all into one commit at the walker entry/loop call site.

### Items to address (all bundle into one round-2 commit at the same call site cluster)

**1. (P1) Replace `as string` casts in security-critical walker with runtime narrowing.** `routes/papers.ts:1040-1041` (initial probe) and `:1086-1087` (loop continuation) cast `result.rows[0].cont_author as string` / `cont_permlink as string`. Round-2 hold item 3 of `backend-continuation-post-author-consent-gate` explicitly forbade `as` casts on the security path; the migrated pattern at `:825-833` (`fetchHeadAuthorizedAuthors`) is the template. Apply the same narrowing here:

```ts
const row = result.rows[0] as Record<string, unknown>;
if (typeof row.cont_author !== 'string' || typeof row.cont_permlink !== 'string') return null;
let currentAuthor = row.cont_author;
let currentPermlink = row.cont_permlink;
```

Same shape at the loop-continuation site (lines 1086-1087): narrow `parentResult.rows[0].cont_author` and `cont_permlink` before assignment. Today's behavior is fail-closed via parameterized SQL (a `null` cast yields no matching row in the next iteration), but the cast suppresses a detectable invariant violation. Future SQL refactor or HAF column-shape change would silently weaken the gate.

**2. (P1) Type-spoof on START post — walker entry has no `pevo.type='paper'` filter.** `routes/papers.ts:992-1014` (initial SQL probe) filters only on `parent_author=''` + `parent_permlink=appTag` + `continues IS NOT NULL`. The START post (URL-cited) is never validated as `pevo.type IN ('paper', 'bridge_paper')`. `fetchHeadAuthorizedAuthors` validates PREDECESSORS via `isPevoAnyPaper` (line 821), but the START escapes validation.

Concrete attack: vouched co-author Bob (in alice/paper-v1's `pevo.authors[].hive`) broadcasts `bob/spoof-review` with `pevo.type='review'` AND `pevo.continues={alice, paper-v1}`. URL `/api/papers/bob/spoof-review` walks back through the gate (alice's authorized set includes bob → admits) → walker returns alice/paper-v1 as canonical → bob's URL renders alice's paper content. URL aliasing for currently-vouched co-authors. Bounded by current author-set membership (revoking bob closes the surface dynamically), but for currently-vouched co-authors the surface exists.

Same threat class as round-2 hold item 1 on the FORWARD walker (closed via `validPevoPaperWhere(source: 'all')` SQL filter + JS-side `isPevoAnyPaper` re-check). Convention `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` was strengthened to require BOTH author AND type identity at every gate.

Fix:
- (a) Add `validPevoPaperWhere(source: 'all')` (or equivalent) to the initial walker SQL probe at `:992-1006`. Mirrors the SQL-side of round-2 hold item 1 on the forward walker.
- (b) JS-side: after fetching the START row, parse its metadata and call `isPevoAnyPaper(startMeta, startAuthor)`. If false, return null (no canonical-root walking). Defense-in-depth.

Canary tests:
- `'rejects type-spoof on START post (vouched co-author posts type=review continuation)'` — bob (in alice's authors) posts `bob/spoof-review` with `pevo.type='review'` + `continues={alice, paper-v1}`. Hit `/api/papers/bob/spoof-review`. Assert response carries bob/spoof-review's content (NOT alice/paper-v1's), AND assert `findCanonicalRoot` returns `bob/spoof-review` (the URL post, walker fail-closed).
- `'rejects type-spoof at intermediate hop'` — chain bob/v3 (paper, continues bob/v2) → bob/v2 (review, continues alice/v1) → alice/v1 (paper). Walker should stop at bob/v2 (type-spoof) and return bob/v3 as canonical (since bob/v3's continues pointer's predecessor bob/v2 fails the type check). NOTE: this depends on the hop-validation strategy chosen — if (a) SQL-only, walker stops because bob/v2 is filtered from the chain-walk; if (b) JS-only, walker stops on the explicit `isPevoAnyPaper` check at the hop. Either is acceptable; canary asserts the outcome.
- `'admits legitimate paper continuation (no type-spoof)'` — bob (vouched) posts `bob/v2` with `pevo.type='paper'` + `continues={alice, paper-v1}`. Walker walks back, returns alice/paper-v1 as canonical. (Regression coverage for the gate's positive case.)

**3. (P2) `reconstructVersionsFromHaf` calls don't share the per-request memo.** `routes/papers.ts:1409` (`?version=N` branch) and `:1446` (metadata-restored fallback). Both internally call `resolveContinuationChain` → `fetchHeadAuthorizedAuthors` fresh, bypassing the memo. Acceptance #3 ("per-request memoization shared between forward + backward walkers") is acceptance-incomplete on this axis.

Fix: add `memo?: HeadAuthorsMemo` parameter to `reconstructVersionsFromHaf` signature, thread through to its internal `resolveContinuationChain` call, pass `headAuthorsMemo` from route handler at lines 1409 and 1446. ~6 LOC.

Canary: extend the existing memo-dedup canary in `canonical-root-walker.test.ts` to also exercise the `?version=N` path. Assert `aliceHeadLookupCount === 1` across canonical-walker + reconstruct-versions calls in the same request.

**4. (P2) `fetchHeadAuthorizedAuthors` catch block returns null without memoising.** `routes/papers.ts:843-846`. Diverges from the documented contract on lines 796-797 ("Both null and Set results are cached"). Under degraded HAF, a single request hitting canonical-walker + second `fetchPaperDetailFromHaf` + `reconstructVersionsFromHaf` (after item 3 fix) re-fires the failing query 3+ times, each blocking for the full statement_timeout (30s).

Fix: add `memo?.set(key, null);` before `return null;` in the catch block. 1 LOC.

Canary: simulate HAF error mid-walk (mock `pool.query` to throw on first call, return rows on second). Assert the same `(author, permlink)` is fetched only once across two within-request lookups. ~30 LOC test.

**5. (P2 — observability) Outer walker catch has no structured event tag.** `routes/papers.ts:1105`. Logs at `logger.error` level with generic `'Canonical root lookup failed'` and no `event:` field. Operators can't distinguish "walker errored at hop N" from "walker completed normally". Add `event: 'canonical_root_walker_error'` plus `(startAuthor, startPermlink)` context. ~5 LOC.

The wall-clock budget concern (no `AbortController` on 10×2 sequential HAF queries; worst-case ~10 minutes per request under degraded HAF + statement_timeout=30s) is broader scope and filed separately as `backend-haf-walker-wall-clock-budget.md` — covers backward walker + forward walker + accreditation + reconstructVersionsFromHaf as one cross-cutting AbortController-threading task.

**6. (P3 — observability) Hop number missing from warn events.** The `for (let i = 0; i < CANONICAL_ROOT_MAX_HOPS; i++)` loop never references `i` in the body. Both `unauthorized_hop` (line 1063) and `depth_exceeded` (line 1097) warns omit a hop counter. Add `hopNumber: i + 1` to both warn payloads. ~2 LOC. Pairs naturally with item 5's event-tag work.

**7. Mutation-kill attestation.** Backend's round-2 signal block MUST include the explicit revert-verify attestation per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: each new canary must fail when the corresponding fix is reverted. Specifically:
- Type-spoof canary fails when `validPevoPaperWhere`/`isPevoAnyPaper` check on START is removed.
- Cast-narrowing change keeps prior canaries passing (defensive only) — note this in attestation as "no behavioral mutation expected; cast narrowing is fail-closed-already-via-SQL hardening; verified by `npx tsc --noEmit` clean and existing canaries pass unchanged".
- Memo-on-`reconstructVersionsFromHaf` canary fails when the new memo parameter isn't threaded through.
- Catch-block memoization canary fails when `memo?.set(key, null)` is removed from the catch path.

### Items dismissed during architect triage

- **(P3) Depth-cap constant style asymmetry** (forward `MAX_HOPS=50` function-local + undocumented vs backward `CANONICAL_ROOT_MAX_HOPS=10` module-level + docblock). Pure style; backward walker's choice is correct, forward walker's choice is pre-existing. Not worth the noise.
- **(P3) `makeHeadAuthorsMemo()` factory overhead** (one-line `return new Map();`). Mild premature abstraction; harmless. Not worth changing.
- **Cycle detection (visited-Set short-circuit)** — file as separate task `backend-canonical-walker-cycle-detection.md` since both forward + backward walkers benefit and the change is broader scope (~15 LOC + canaries) than the round-2 polish.
- **Wall-clock budget on walker** — file as separate task `backend-haf-walker-wall-clock-budget.md` (broader scope; AbortController threading through HAF pool callers is cross-cutting).

### Items deferred to follow-up tasks (architect files at archive)

- **`backend-haf-walker-wall-clock-budget.md`** (P2 reliability) — see item 5 above.
- **`backend-canonical-walker-cycle-detection.md`** (P3 perf hardening) — see "dismissed" above.

### Cross-cutting testing gaps to address in round-2

These multi-reviewer-corroborated gaps must be closed by the round-2 canary additions:
- **Type-spoof on START post canary** (item 2 above).
- **Bridge-paper Option-b backward case canary**: bridge_account/v2 → bridge_account/v1 admitted; attacker/v2 → bridge_account/v1 rejected. Currently the bridge-paper branch in `extractAuthorizedContinuationAuthors` is exercised only by forward-walker canaries; backward walker has no coverage. ~2 canaries.
- **Negative-cache memo canary** (item 4's canary covers the catch-path negative; also add a canary for the early-return `memo?.set(key, null)` paths at lines 793/798/803 to pin the documented "both null and Set results are cached" contract).
- **Forward-walker memo dedup canary on `?version=N` path** — exercise that the forward walker's memo dedup also fires when called via `reconstructVersionsFromHaf` after item 3's threading lands.

### Architect followups (carry forward to archive)

- **A1.** Acceptance #5: convention doc update for `pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md` "Sites this convention applies to" — must be **structural-not-enumerated** per `enumerated-exemption-lists-are-drift-vectors-2026-04-28.md`. Cite the gated helper + grep-audit surface, NOT a list of "exempt" sites. Strengthen the structural rule: "every gate enforces author + type identity together" (round-2 hold item 1 on the forward walker established this; round-2 hold item 2 on the backward walker reinforces it for symmetric coverage).
- **A2.** Two-grep call-site audit per `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` at archive: `grep -rn "pevo.continues\|parent_author" backend/src/` vs `grep -rln "findCanonicalRoot" backend/src/`. Confirm no other backward-walk sites bypass the gate.
- **A3.** Depth-cap arithmetic per `verify-resource-knob-math-before-load-bearing-security-margins-2026-04-22.md`: append a comment to the walker's docblock spelling out `10 hops × 2 SQL queries × 30s statement_timeout = 600s worst-case` (and note the `backend-haf-walker-wall-clock-budget.md` follow-up that closes this).
- **A4.** Test file header carve-out clause (c) currently references "the sibling continuation-author-gate canary file" without naming a follow-up task slug. At archive, either name the existing real-HAF follow-up or file one explicitly. Project-standards reviewer flagged the gap.

### Re-review signal

When round-2 items 1-7 land in a single commit, `git mv` this file back to `tasks/review/`. Architect's next review pass scopes `/ce-code-review` to the round-2 commit. Expected diff: ~60 LOC in `papers.ts` (cast narrowing + type-spoof gate + memo threading + catch-block memoize + event tag + hop number) + ~120 LOC of new canary tests. Item 5b (wall-clock budget) and item 6d (cycle detection) live in their separate tasks and don't gate this archive.
