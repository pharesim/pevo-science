---
title: "Carve-out clause-(a) impracticability claims are unverified prose too: check the harness pins, the sibling specs, and the guard site before asserting a real path is impossible"
date: 2026-09-22
category: conventions
module: frontend/tests
problem_type: convention
component: testing_framework
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - documentation
  - development_workflow
  - authentication
applies_when:
  - "Writing or reviewing a test-file header's clause-(a) carve-out justification that says a real path is impossible or impractical in jsdom, vitest, Playwright, or the compose test stack"
  - "Writing or reviewing a comment that names WHERE in the code a request or flow stops (a specific guard, check, or gate)"
  - "A correction lands in one header sentence and the same phrase is cited elsewhere (a fixture docblock, an inline comment, a sibling spec)"
  - "Deciding whether a stub or mock is still the only option after new test infrastructure (a sidecar, a bridge fixture) may have landed since the header was written"
  - "Reviewing such a claim under /ce-code-review or an architect hold, where the pre-commit anchor gate and the citation canary have already passed"
symptoms:
  - "A clause-(a) header asserts jsdom lacks a capability that a sibling harness spec pins as present under the same test config"
  - "The header's stated blocker is not the actual blocker; the real one is an unstated gap in the same code path that a sibling test's own header already records"
  - "A 'no real path is possible' claim predates test infrastructure (a stub sidecar, a bridge fixture) that a sibling spec now uses to exercise exactly that path"
  - "A one-spot correction to a header phrase leaves the fixture it cites, and other comments carrying the same phrase, still asserting the pre-correction claim"
  - "Every mechanical gate passes (anchor gate, citation canary, full suite green) because those gates check citation format and path resolution, not whether the prose is true"
tags:
  - docblock
  - carve-out
  - comment-rot
  - test-mocks
  - real-path
  - testing-convention
  - clause-a
  - unverified-claim
---

# Carve-out clause-(a) impracticability claims are unverified prose too: check the harness pins, the sibling specs, and the guard site before asserting a real path is impossible

## Context

Root `CLAUDE.md` "Carve-out for deterministic edge-case coverage" clause (a) requires a mocked test's header to say which real path is impractical and why. That "why" is free prose, checked by exactly one mechanism: a reader believing it. Two headers in the tree gave a reason that is false while the mock itself is justified. Both corrections have since landed, the e2e one together with the fixture sweep it dragged along.

The unit instance, `frontend/tests/unit/lib-ipfs-upload-real-window.test.js`, justifies mocking `uploadFileToIpfs` because it "reaches `crypto.subtle` before its first request, which jsdom does not provide." The capability is present under the same vitest config: `frontend/tests/unit/harness.test.js` asserts `typeof crypto.subtle.digest` is `'function'` and computes a SHA-256 there. Its provider is not jsdom, whose 25.0.1 `Crypto-impl.js` implements only `getRandomValues` and `randomUUID`; it is Node's webcrypto global, which vitest's jsdom environment leaves in place. The first draft of the correction wrote "jsdom provides it" into the header, a probe refuted that too, and the landed sentence claims presence and names no provider. The real blocker sits one call earlier. `uploadFileToIpfs` (`frontend/src/api.js`) hashes the file through `sha256File` (`frontend/src/crypto.js`) before any request, and `sha256File` calls `file.arrayBuffer()` before it touches `crypto.subtle`; jsdom's Blob does not implement `arrayBuffer()`, the gap `frontend/tests/unit/crypto.test.js` records in its own header. A review-time scratchpad probe, `sha256File(new Blob(['x']))`, rejected on `file.arrayBuffer` before `crypto.subtle` was ever reached.

The e2e instance, `frontend/tests/e2e/non-consent-fresh-auth.spec.js`, said its ORCID test stubbed `/api/orcid/callback` because "(no real ORCID OAuth handshake is possible in Playwright)". That parenthetical dates from 2026-05-16, before the in-network `orcid-stub` sidecar in `docker-compose.test.override.yml` (2026-06-09) and the `routeOrcidStubBridge` fixture in `frontend/tests/e2e/fixtures/orcid.js` (2026-06-14). `frontend/tests/e2e/settings-orcid-factor.spec.js` now drives that bridge to a genuine token exchange at the real `/api/orcid/callback`, and the same docblock's clause (c), three paragraphs down, says so. The commit "the header said decrypt, the handler stops a guard earlier" re-emitted the parenthetical while correcting a neighbouring sentence: "refuses at ... the posting-key decrypt" became "the posting-key availability guard that fronts the decrypt; the decrypt itself never runs", which matches `backend/src/routes/custody.ts`, where `if (!account.posting_key_enc || !account.iv_posting)` returns 500 `Posting key not available` before `decryptKey` is called. The correction stopped at the header. The fixture it cites, `frontend/tests/e2e/fixtures/light-account.js`, went on saying the handler "hits the posting-key decrypt" in its module docblock and that `expectPostGateStop` proves the request "reached the posting-key decrypt" at "the first post-gate step", and two inline comments in the spec went on saying the broadcast "stopped at the posting-key decrypt". The same phrase also survived in `frontend/tests/e2e/consent-op-fresh-auth.spec.js` and `frontend/tests/unit/fresh-auth-401-retry.test.js`, which cite the fixture; the hold that routed the correction named only the first two sites, so even the sweep that found the gap under-swept. A follow-up commit reworded all seven sites and replaced the parenthetical. The prescribed fixture wording carried one more slip of the same class into the tree: it said the handler's generic 500 envelope "would mean a step past the guard threw", while the account-row read sits inside the same `try` ahead of the guard, so a row-read throw produces that envelope too. A correction written from memory of the handler is the same unverified prose as the claim it replaces.

This is the third member of one family. `universal-mock-inventory-must-be-re-derived-not-incrementally-patched-2026-06-11.md` covers clause (a)'s enumeration (is the list of what is mocked complete); `carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md` covers clause (c)'s citation (does the named companion exist and carry the risk class); this entry covers clause (a)'s reason (is the stated impracticability true). An enumeration can be exhaustively correct while the one-sentence reason for why an item must be mocked is false.

The week's session history holds the same shape outside carve-outs (session history): across four rounds of a backend canary review, every docblock overclaim was of the form "these two are equivalent" or "any change that breaks X also breaks Y", none was caught by re-reading the prose, and each fell only to an execution probe (a regex mutation matrix, a grammar probe against a non-existent relation). One round's own adversarial pass refuted a claim that still shipped in the final docblock, because the refutation never propagated back into the prose. Re-reading is not verification.

## Guidance

A clause-(a) impracticability claim, and any sentence naming where the code stops, is a claim about the harness or the handler. Run it against the harness's own pins before writing it, and again before accepting it:

1. **Grep the harness and smoke specs for the capability named.** `harness.test.js` pins `crypto.subtle`; `crypto.test.js` pins the `Blob.arrayBuffer()` gap. If a smoke spec asserts present the thing you are about to call absent, the reason is wrong. A pin proves presence under that config, not provenance: say the capability is present, and attribute it to a library only after reading that library's implementation.
2. **Check sibling specs for one that already does the "impossible" thing.** `git grep -n routeOrcidStubBridge -- frontend/tests` finds `settings-orcid-factor.spec.js` completing the round-trip the parenthetical rules out.
3. **When naming where the code stops, read the handler and name the guard that fires**, not the step behind it. In `custody.ts` the seeded row stops at the availability guard; `decryptKey` never runs. The same reading applies to a sentence saying what a different envelope would mean: list everything the enclosing `try` covers, ahead of the guard as well as past it, before attributing the catch's envelope to one side.
4. **When a correction lands in a header, grep the phrase across the file, the fixtures the header cites, and the citers.** `git grep -n "posting-key decrypt" -- frontend/tests` returned the fixture's two docblocks, the spec's two inline comments, and the two citing suites while the sweep was open, and returns nothing now that it has landed; the empty result is the evidence the sweep is complete. A header fix that leaves the cited fixture saying the opposite creates a contradiction the citation now leads to.

Reviewer step: treat a clause-(a) reason like a clause-(c) citation, as unverified prose to resolve, and probe it once in a scratchpad copy when it is checkable in seconds. A plausible reason existing is not that reason being true. When the fix lands, scope the replacement to what was actually checked rather than asserting a fresh unverified reason in its place.

## Why This Matters

Clause (a) exists so the next reader knows what actually makes the real path impractical. A false reason sends them the wrong way: polyfilling WebCrypto on the unit header's word changes nothing, because `arrayBuffer()` throws first; believing the e2e parenthetical would stop someone from driving the bridge that already exists. A "where it stops" sentence is also the assertion's own meaning: `expectPostGateStop` pins a 500 whose message matches `/posting key/i`, the guard's envelope, and the docblock explaining that pin names a step that never executes.

Nothing mechanical catches this. The `.githooks/pre-commit` anchor gate and `backend/tests/eslint/no-stale-comment-anchors.test.ts` match citation shapes (slugs, ordinals, line cites, positional anchors); `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` resolves clause-(c) paths and tokens, and only under `backend/tests/`. None checks whether a prose claim about jsdom or Playwright is true. Both instances passed every gate and a green suite, and the second survived a task whose whole purpose was fixing overclaims in that docblock.

## When to Apply

- Writing or editing any clause-(a) sentence that says a path is impossible or impractical in jsdom, vitest, Playwright, or the compose test stack.
- Writing any sentence that names the handler step a request stops at.
- Landing a correction in a header: sweep the fixture it cites and every citer of the same phrase before committing, and name every site in the hold or the commit so the sweep can be checked.
- Review intake on a diff touching a carve-out header: resolve the reason the way you would resolve a companion path.
- A harness capability change (a new sidecar, a new bridge fixture, a jsdom upgrade): grep test headers for the impossibility claims it just falsified.

## Examples

Unit header, before (as held):

> `uploadFileToIpfs` reaches `crypto.subtle` before its first request, which jsdom does not provide.

After (landed; the appended citation makes the presence claim checkable where it is read):

> `uploadFileToIpfs` hashes the file through `sha256File` before its first request, and `sha256File` calls `file.arrayBuffer()`, which jsdom's Blob does not implement (`crypto.test.js` records the same gap); `crypto.subtle` itself is present, as `harness.test.js` asserts.

E2e clause (a), before (as held):

> the ORCID test stubs `/api/orcid/callback` (no real ORCID OAuth handshake is possible in Playwright)

After (landed):

> the ORCID test stubs `/api/orcid/callback` at the network layer rather than driving the in-network ORCID stub, so the window it caches is test-authored and nothing it asserts is backend-issued.

Cited fixture, before (as held): the handler "then hits the posting-key decrypt and refuses". After (landed): the handler "then refuses at the posting-key availability guard that fronts the decrypt, with the posting-key-unavailable envelope; the decrypt itself never runs." The same rewording landed in the `expectPostGateStop` JSDoc, the two inline comments in the spec, and the two citing suites.

One clause of that JSDoc is not yet accurate. It says the outer catch's generic envelope "would mean a step past the guard threw". The accurate condition is wider: the generic envelope means something inside the handler's `try` threw, which is the account-row read ahead of the guard or a step past it.

## Related

- `agents/docs/solutions/conventions/carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`: the clause-(c) sibling; same thesis, different clause. Its Related section names the inventory entry as "the clause-(a) sibling"; this entry is the second one.
- `agents/docs/solutions/conventions/universal-mock-inventory-must-be-re-derived-not-incrementally-patched-2026-06-11.md`: clause (a)'s enumeration half.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`: the carve-out framework this entry refines; its header template names clause (a) as "the real path that is impractical and why" without saying the "why" is pre-verified.
- `agents/docs/solutions/conventions/coverage-claim-downgrade-requires-codebase-search-2026-05-21.md`: a correction to one false header claim producing a second falsehood nearby; the same search-before-replacing discipline, applied here at correction time.
- `agents/docs/solutions/conventions/sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md`: one site corrected while a sibling site keeps the old claim; its rule (state the fact precisely at every site, add no reconciling sentence) is the fix shape for the fixture and the inline comments.
- `agents/docs/solutions/conventions/modeling-a-sibling-test-case-copies-its-framing-not-its-facts-2026-09-21.md`: the same failure family from a different cause (inherited framing rather than an unchecked reason).
- `agents/docs/solutions/conventions/e2e-external-provider-stub-backend-only-real-fidelity-2026-06-09.md`: why the ORCID parenthetical became false; the sidecar it describes is what made the real callback drivable.
- `agents/docs/solutions/conventions/comment-anchor-rot-precommit-diff-gate-2026-06-14.md`: the gate that passes both instances, by design; it checks shape, not truth.
