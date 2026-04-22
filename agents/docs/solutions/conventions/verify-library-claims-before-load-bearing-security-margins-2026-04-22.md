---
title: Verify third-party library claims before baking them into security margins
date: 2026-04-22
category: conventions
module: backend
problem_type: convention
component: security_review
severity: high
applies_when:
  - A security margin (lock TTL, timeout, retry budget, circuit-breaker threshold) is justified by "library X has behavior Y"
  - A hold block, commit message, or inline code comment cites a specific library timeout or guarantee
  - `dhive`, `ioredis`, `pg`, `node-fetch`, `axios`, `undici`, or any library whose timeout semantics vary by operation type
  - A re-review signal block repeats a claim from the prior round's hold block without independent verification
  - Upgrading a library on a security-critical path
tags:
  - security-review
  - library-verification
  - chain-of-reasoning
  - dhive
  - ce-code-review
---

## Rule

Any claim about third-party library behavior that load-bears on a security margin MUST be grounded in a direct source citation, a documented API contract, or a test that fails if the claim becomes false. Accepting a prior reviewer's claim without re-verification propagates cascade failures.

Prefer application-layer bounds to library-layer bounds. The application layer is auditable from your own source; library behavior can change across versions without your review.

## Why

`BE-ORCID-TOCTOU-LOCK` raised the ORCID binding lock TTL from 10s to 35s on the stated rationale of "above the 30s dhive broadcast timeout." The 30s timeout does not exist.

Trail: round-1 architect hold block → round-2 backend commit message → inline code comment at `orcid.ts:29-32` → round-2 re-review signal. Four propagation points across three review passes. Every participant accepted the claim on prior-reviewer authority without reading dhive source.

Actual dhive behavior (`@hiveio/dhive/lib/client.js:166-170`): `fetchTimeout` is assigned only when `!isBroadcast`. For broadcast calls it stays undefined; `node-fetch` defaults `timeout` to 0 (no timeout). The `Client.timeout: 10_000` is a retry-loop wall-clock guard for READ ops only. Broadcasts have no enforced timeout.

A slow Hive node can hold `broadcast.json` open indefinitely. The lock's 35s TTL expires; holder B acquires; A's broadcast eventually completes; both A and B broadcast the same `custom_json`. The Redlock nonce closes DEL-stomp; the 5-second margin was supposed to close execution-stomp, but it rests on an imagined guarantee. Follow-up task `backend-orcid-broadcast-abort-timeout.md` replaces the assumed library bound with an explicit `AbortSignal.timeout(30_000)` — an application-owned bound that keeps the margin real.

The failure mode is a **plausibility cascade**: a claim reads plausible, gets repeated, becomes background, eventually becomes infrastructure later decisions build on. When the claim is wrong, everything on top is structurally unsafe but looks correct at every intermediate layer.

## How to apply

1. **Cite the source.** Security-margin comments include the library file:line or documented API contract. Example: `/* 35s TTL above the app-enforced 30s broadcast abort (see src/lib/broadcast-timeout.ts). dhive itself has no effective broadcast timeout — client.js:166-170 leaves fetchTimeout undefined for isBroadcast=true. */`
2. **Prefer application-owned bounds.** Wrap library calls in `AbortSignal.timeout(N)` or equivalent when safety depends on a timeout. The constant lives in your codebase; the citation is one file away.
3. **Break the cascade at re-review.** When repeating a claim from the prior round's hold block, verify it yourself and state the grounding in the re-review signal ("verified by reading X at `<file:line>`"). "Per architect's hold block" is not verification.
4. **Audit at library upgrades.** When bumping any library on the security-critical path, grep the codebase for comments citing its behavior; re-verify each against the new version.
5. **On adversarial code review**, treat "library X does Y" as a claim requiring citation, not an axiom.

## Related

- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — structurally analogous failure class ("fix looks complete but rests on an unexamined premise"). Different mechanism, same meta-pattern.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — sibling from the same review pass. Both are cheap point-in-time verifications that break cascade failures at authorship.
