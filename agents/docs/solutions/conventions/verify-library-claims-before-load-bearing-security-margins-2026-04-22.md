---
title: Verify third-party library claims before baking them into load-bearing security margins — the "30s dhive broadcast timeout" propagated across 4 review surfaces without anyone reading the library source
date: 2026-04-22
category: conventions
module: backend
problem_type: convention
component: security_review
severity: high
applies_when:
  - A security margin (lock TTL, rate limit, timeout, retry budget) is justified by "library X has behavior Y"
  - A hold block, commit message, or inline comment cites a specific library timeout or guaranteed behavior
  - Redlock-style locks, circuit breakers, or any safety mechanism whose correctness depends on a bounded third-party operation
  - `dhive`, `ioredis`, `pg`, `node-fetch`, `axios`, `undici`, or any library where timeout semantics vary by operation type (read vs. write, idempotent vs. not, broadcast vs. subscribe)
  - Multiple review passes reference the same library behavior without a citation to the library source
  - A re-review signal block repeats a claim from the previous round's hold block without independent verification
tags:
  - security-review
  - library-verification
  - chain-of-reasoning-failure
  - lock-safety-margins
  - dhive
  - ce-code-review
  - adversarial-review
---

# Verify third-party library claims before baking them into load-bearing security margins

## Context

The 2026-04-22 architect review pass on `BE-ORCID-TOCTOU-LOCK` round-2 surfaced a P1 finding: **the 30-second dhive broadcast timeout that justified the ORCID binding lock's 35-second TTL does not exist.** The claim propagated unchallenged across four review surfaces before a reliability reviewer read the dhive source.

The propagation trail:

1. **Round-1 architect hold block** (2026-04-21): "raise EX to **35s** (above the 30s dhive timeout) for belt-and-suspenders." Cited as SEC-LOCK-004 rationale. No source citation.
2. **Round-2 backend commit message** (`ee29c99`): "TTL raised 10s → 35s so a slow-but-alive dhive broadcast (30s timeout) does not lose its lock mid-flight." Repeated the claim from the hold block.
3. **Round-2 inline code comment** (`orcid.ts:29-32`): `/* ... rationale referencing the 30s dhive broadcast timeout ... */`. Baked the claim into production source.
4. **Round-2 backend re-review signal**: "Lock TTL 10s → 35s ... comment referencing the 30s dhive timeout rationale" — asserted the fix was correct on the claim's premise.

Four propagation points. Three review passes. The claim was plausible at first reading (libraries conventionally have timeouts), internally consistent (10s → 35s with a 5s margin is a reasonable delta), and cross-referenced (the hold-block cited a margin against the commit cited a timeout against the comment cited a rationale). Nobody pulled up the dhive source until round-2's reliability reviewer did.

The actual dhive behavior (`@hiveio/dhive/lib/client.js:166-170`):

```js
let fetchTimeout;
if (!isBroadcast) {
    // bit of a hack to work around some nodes high error rates
    // only effective in node.js (until timeout spec lands in browsers)
    fetchTimeout = (tries) => (tries + 1) * 500;
}
const { response, currentAddress } = yield utils_1.retryingFetch(
  this.currentAddress,
  this.address,
  opts,
  this.timeout,
  this.failoverThreshold,
  this.consoleOnFailover,
  this.backoff,
  fetchTimeout,
  /* ... */
);
```

For broadcast calls (`isBroadcast = true`), `fetchTimeout` is never assigned — it's `undefined` when passed to `retryingFetch`. `node-fetch` defaults `timeout` to `0` (no timeout) when absent. The `Client`'s `timeout: 10_000` at `backend/src/hive.ts:9` is used as a retry-loop wall-clock guard for READ operations only; broadcasts have no per-request fetch timeout.

A slow Hive node can hold `broadcast.json` open indefinitely. The ORCID binding lock's 35-second TTL expires; holder B acquires a new lock with a new nonce and broadcasts; holder A's broadcast eventually completes; A's `finally` runs a Lua CAS (nonce mismatch, no-op); but **both A and B broadcast the same `custom_json`** for the same `orcid_id`. The Redlock nonce closed the DEL-stomp window; it does not close the execution-stomp window, which is what the 5-second margin was supposed to cover. The margin is fictional because the guarantee it rests on is fictional.

This is not a bug in any one agent's work. Round-1 architect, round-2 backend implementer, round-2 backend re-reviewer, and three round-2 review personas (correctness, security, testing) all accepted the claim without citation. The chain-of-reasoning failure propagated because each participant was reasoning within the frame the prior participant established.

The failure mode has a name in security review: **plausibility cascade**. A claim reads as plausible, is repeated, becomes part of the background, and eventually becomes infrastructure that later decisions build on. When the claim is wrong, everything on top of it is structurally unsafe but looks correct at every intermediate layer.

## Guidance

**Rule: any claim about third-party library behavior that load-bears on a security margin (TTL, timeout, retry budget, lock expiration, circuit-breaker threshold) MUST be grounded in a direct source citation or a test that fails if the claim becomes false. Accepting the claim on the basis that a prior reviewer accepted it propagates the chain-of-reasoning failure.**

The citation can be one of:

1. **Source-file link.** `@hiveio/dhive/lib/client.js:166-170` — the specific lines in the library source that demonstrate the behavior. Copy-paste the snippet into the hold block or commit message so future reviewers don't have to re-hunt for it.
2. **Documented API contract.** `dhive Client options.timeout` documented at `<url>` — the library's own docs specify the behavior. Quote the relevant sentence.
3. **Test that breaks on behavior change.** A unit or integration test that asserts the claimed behavior. If the library upgrades and breaks the claim, the test fails loud and the security property is re-audited before the upgrade lands.

A claim **without** any of these three groundings is unverified and should not be used to justify a margin. The fallback posture when the library's behavior cannot be cheaply confirmed: **do not rely on it**. Either test it directly (observe in a unit test that the library fails at the claimed window) or use an application-layer bound that you control (e.g. `AbortSignal.timeout(N)` wrapping the library call).

**Application-layer bounds are preferable to library bounds for security margins.** The application layer is auditable from your own source; the library layer is a moving target that can change across versions without your review. For the dhive broadcast case, the correct fix is an explicit `AbortSignal.timeout(30_000)` around `hiveClient.broadcast.json` — a bound the application owns, expressed in your own code, with the 35-second TTL aligned against that owned constant rather than against an assumed library behavior.

**Rule corollary for re-review signals**: when a re-review signal block repeats a claim from the previous round's hold block, that repetition is not verification. The re-review should include its own grounding for any load-bearing claim — either "verified by reading X at <line>" or "test added at <path> that asserts Y." A re-review that only cites "per architect's hold block" chains the failure rather than breaking it.

## Why This Matters

The ORCID binding lock is a textbook Redlock implementation — the algorithmic skeleton is correct. The 35-second TTL choice was the architect's attempt to add a safety margin, and the mechanism (nonce + Lua CAS) is correct for the DEL-stomp class of failure the margin was designed to close. What failed was not the algorithm; it was the parameter choice, and the parameter choice was wrong because the library behavior it rested on was imagined.

This specific instance is recoverable — the follow-up task `backend-orcid-broadcast-abort-timeout.md` replaces the assumed library bound with an application-layer `AbortSignal`. The broader lesson is structural: a plausible chain of reasoning is not evidence. In security review particularly, the cost of grounding a claim at authorship time is minutes; the cost of chasing a plausibility cascade after it ships into production is open-ended.

Adversarial review personas are the current mechanism for catching these cascades. The `/ce-code-review` adversarial persona's round-2 instance on `BE-ORCID-TOCTOU-LOCK` flagged this class. But adversarial review is expensive; catching plausibility cascades before they become background is cheaper.

The four sibling propagations of the "30s dhive timeout" claim are separated by days and by agents; at each step, the actor had the option to pull up dhive source and took a plausibility shortcut instead. Documenting this instance as a convention shifts the baseline expectation: the next PEvO reviewer asked to sign off on "library X has behavior Y" has a named class to appeal to when asking "where's the citation?"

## When to Apply

1. **On every security-margin commit.** Any TTL, timeout, retry budget, or lock expiration whose justification cites "library X has behavior Y" must include the citation shape above. Commit messages like "raise TTL to N so library-bounded operation fits" without a source link are incomplete.

2. **On every hold block or re-review cycle involving a library bound.** Architects authoring hold blocks include the source citation alongside the margin rationale. Re-review signals include their own grounding, not a reference to the prior hold block's claim.

3. **On adversarial review of any locking / timeout / circuit-breaker code.** Adversarial persona's standing checklist item: "is the safety margin bounded by an application-owned constant, or by a library behavior assumption? If the latter, where's the citation?"

4. **On library upgrades.** When bumping `dhive`, `ioredis`, `node-fetch`, `axios`, `undici`, or any library on the security-critical path, audit every comment in the codebase that cites a specific library behavior. Upgrades frequently change timeout defaults, error class hierarchies, or retry semantics.

5. **On introducing a new library with any safety-relevant bound.** At onboarding, either add a pinned-version constant that covers the required behavior, or add an application-layer wrapper (timeout, abort, bound) that the codebase owns — never rely on the library's default.

6. **On any comment that says "the library has a 30-second timeout" (or equivalent specific numeric claim).** The exact dhive instance. Any time a reviewer reads a comment like this, they should pull up the library source and confirm. If they don't — this convention exists precisely because that moment of skipping the verification is where cascades propagate.

## Examples

### Example 1: dhive broadcast timeout (the instance this convention documents)

**Wrong (what shipped):**

```ts
// Lock TTL aligned above dhive's 30s broadcast timeout, so a slow-but-alive
// broadcast does not lose its lock mid-flight.
const ORCID_BINDING_LOCK_TTL_SECONDS = 35;
```

**Right (post-follow-up):**

```ts
// Lock TTL aligned above our explicit broadcast abort (30s, enforced by
// broadcastWithTimeout at src/lib/broadcast-timeout.ts). dhive itself has
// no effective broadcast timeout (@hiveio/dhive/lib/client.js:166-170
// leaves fetchTimeout undefined for isBroadcast=true, and node-fetch
// defaults to 0/no-timeout). We enforce the bound ourselves so the margin
// is real.
const ORCID_BINDING_LOCK_TTL_SECONDS = 35;
```

The comment is now a source-cited fact plus an explicit ownership claim. A future reviewer can verify the dhive behavior hasn't changed by reading the cited lines; if dhive ever adds a native broadcast timeout, the explicit abort becomes belt-and-suspenders rather than load-bearing.

### Example 2: Hold block without source citation (the failure mode this convention targets)

**Wrong (actual round-1 architect hold block language):**

> **P3 — EX=10s TTL vs dhive 30s timeout** (security SEC-LOCK-004, 0.70). Lock can expire during a legitimate slow-but-alive broadcast. [...] raise EX to **35s** (above the 30s dhive timeout) for belt-and-suspenders.

The claim "dhive 30s timeout" carries the entire weight of the margin. No citation. Subsequent commit → comment → re-review accepted the claim at face value.

**Right:**

> **P3 — EX=10s TTL vs effective broadcast bound**. Lock can expire during a legitimate slow-but-alive broadcast. The backend currently has no enforced bound on `hiveClient.broadcast.json` — dhive's `Client.timeout: 10_000` at `backend/src/hive.ts:9` is the retryingFetch wall-clock guard for read ops only; for broadcasts (`isBroadcast = true` in `@hiveio/dhive/lib/client.js:131`) the `fetchTimeout` is left undefined (source: `lib/client.js:166-170`) and node-fetch defaults to no timeout. **Therefore the 5-second margin between "expected broadcast duration" and lock TTL must be enforced at the application layer, not assumed from the library.** Options: (a) wrap `broadcast.json` in `AbortSignal.timeout(30_000)` and set TTL = 35s as before, (b) accept the unbounded broadcast risk and file as a known residual, (c) replace the lock with a deterministic queue. Preferred (a). See follow-up task `backend-orcid-broadcast-abort-timeout.md`.

The revised hold block is longer but carries the citation. A round-2 implementer can either land (a), (b), or (c); the choice is explicit, and whichever path ships, the assumption isn't silent.

### Example 3: Re-review signal repeating a prior-round claim (cascade propagation)

**Wrong (what the round-2 signal did):**

> **7. Lock TTL 10s → 35s.** `backend/src/routes/orcid.ts:29-32` — introduced `ORCID_BINDING_LOCK_TTL_SECONDS = 35` (with doc comment referencing the 30s dhive timeout rationale).

The signal attests "fix applied per hold-block rationale" without re-verifying the rationale.

**Right:**

> **7. Lock TTL 10s → 35s.** `backend/src/routes/orcid.ts:29-32` — introduced `ORCID_BINDING_LOCK_TTL_SECONDS = 35`. **Verified the dhive broadcast-timeout claim from the hold block:** reading `@hiveio/dhive/lib/client.js:166-170`, `fetchTimeout` is not assigned for broadcast calls, so dhive does NOT enforce a 30s timeout. The 5-second margin cited in the hold block does not exist as-implemented. I landed the TTL change as directed but believe the lock is still exposed to execution-stomp if broadcast hangs past 35s. Flagging for architect review — recommend filing a follow-up to wrap `broadcast.json` in an explicit AbortSignal.

The revised signal breaks the cascade. The implementer did their own verification and surfaced the discrepancy for architect attention. Round-3 review can then land the follow-up work with the grounding already in place, instead of discovering the failure three review passes later.

### Example 4: ioredis connection lifecycle (preventative application)

A hypothetical claim from a future task: "ioredis auto-reconnects on connection loss, so our SETNX lock acquisition will survive a Redis restart."

**Apply this convention:** the author cites `ioredis` docs (or source) showing the auto-reconnect behavior AND the specific interaction with SETNX during reconnect windows — does a SETNX attempted mid-reconnect fail fast, queue, or silently drop? The answer affects whether the lock can be safely relied on during Redis restart windows. Without the citation, the claim is an assumption and should not justify safety margins.

### Example 5: node-fetch version default shift (library-upgrade application)

A library bump from `node-fetch@2` to `node-fetch@3` changes the default timeout behavior from implicit-none to explicit-none (different error class on timeout). Any codebase that relied on the v2 implicit behavior for a safety property now has subtly different error handling.

**Apply this convention at upgrade time:** grep every comment that cites node-fetch behavior, confirm each against the v3 source, and update citations to the new version. If any was relying on an implicit default that changed, the safety property needs to be re-examined.

## Related

- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — structurally analogous: that doc teaches "a security fix that looks complete at the top-level branch may leave sub-branches open." This doc teaches "a security fix that looks complete on its stated premise may rest on an imagined premise." Both are failure modes of plausibility-at-first-reading.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — sibling convention from the same 2026-04-22 review pass. That doc teaches "verify your test fails when the property it protects is broken." This doc teaches "verify your margin's foundation is real when the library it rests on is a moving target." Both are cheap grounding checks that catch plausibility cascades at authorship time.
- `agents/docs/solutions/conventions/hive-signature-request-binding-shape-2026-04-21.md` — adjacent domain (Hive request signing). Its pattern relies on well-defined, single-version Hive chain operation semantics that are canonical by protocol. Contrast with dhive's client-side behavior, which is not protocol and can change across library versions. The lesson: protocol-grounded claims are durable; library-grounded claims require citations.
- **`/ce-code-review` skill integration:** the adversarial persona should include "library-bound-or-application-bound?" as a standing checklist item on any diff touching timeouts, locks, retries, or circuit breakers. The check is one-sentence prose: "what's the citation for the library's behavior this safety margin rests on?"
