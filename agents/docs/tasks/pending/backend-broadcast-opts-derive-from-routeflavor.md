# BACKEND-BROADCAST-OPTS-DERIVE-FROM-ROUTEFLAVOR — derive evidenceSuffix/routeLabel/recoveryHint from routeFlavor in broadcastAccreditationAndSeed

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect, surfaced by `/ce-code-review` of the signup-verify scaffold-extraction; maintainability + kieran-typescript, 2-reviewer corroborated, P2)
**Priority:** P3 (maintainability hardening — no current defect; both call sites are correct today)

## Problem

`broadcastAccreditationAndSeed` in `backend/src/routes/signup-verify.ts` takes a `routeFlavor: 'confirm' | 'link'` discriminator AND three free-form string fields that are each a pure function of `routeFlavor`:

- `evidenceSuffix` — `'signup'` for confirm, `'link'` for link (domain-separation suffix in the SHA-256 evidence hash).
- `routeLabel` — `'signup_verify.confirm'` / `'signup_verify.link'` (log/error prefix).
- `recoveryHint` — the per-route user-facing retry instruction.

Because the caller supplies all four independently, a future caller (or a copy-paste of one call site to seed a third) can pass a **mismatched pair** — e.g. `routeFlavor: 'confirm'` with `evidenceSuffix: 'link'` — which compiles cleanly and produces a **wrong evidence hash silently** (the hash is `${account.email}:${username}:${evidenceSuffix}`, so a wrong suffix yields a different on-chain `evidence_hash` than the route intends, with no error). The `postBroadcastSuccessCopy` helper already derives its copy from `routeFlavor`, so the precedent for deriving-from-the-discriminator exists in the same function.

This is a latent footgun, not a live bug: the two current call sites (`/confirm` and `/link`) pass matching values, verified byte-parity in the extraction review.

## Goal

Remove `evidenceSuffix`, `routeLabel`, and `recoveryHint` from `BroadcastAccreditationOpts` and derive all three from `routeFlavor` inside `broadcastAccreditationAndSeed` (a small lookup map or `switch`). After this, the two call sites pass only the discriminator plus the genuinely per-call fields (`res`, `username`, `account`, `isResume`, `resumeStuck`); a mismatched pair becomes unrepresentable.

Map to encode:
- `confirm` → `evidenceSuffix: 'signup'`, `routeLabel: 'signup_verify.confirm'`, `recoveryHint: 'You may retry POST /api/auth/confirm with the same auth_token, username, and keys to recover this session.'`
- `link` → `evidenceSuffix: 'link'`, `routeLabel: 'signup_verify.link'`, `recoveryHint: 'You may retry POST /api/auth/link with the same auth_token and signed request to recover this session.'`

## Acceptance

1. **No behavioral change.** The evidence hash, log/error labels, and recovery-hint copy emitted at runtime are byte-identical to the current values for both `/confirm` and `/link`. This is the load-bearing property — the existing signup-verify suites must stay green unchanged (any test touching the evidence hash or the 502 recovery copy is the regression net).
2. **Mismatch unrepresentable.** `evidenceSuffix`/`routeLabel`/`recoveryHint` are no longer fields on `BroadcastAccreditationOpts`; they are derived from `routeFlavor` at one site inside the function.
3. **No flag-arg regression.** The derivation is a single map/switch keyed on `routeFlavor`, not a new parameter or boolean.
4. **Comment anchors clean** per root `CLAUDE.md` "Comment anchors": any new docstring anchors on stable symbols (the `routeFlavor` discriminator, the function name) — no slug/SHA/line/round-N/§ anchors.
5. **Verification:** `npm run typecheck` (src + tests) + `npm run lint` clean; the signup-verify suite passes.

## Out of scope

- Any change to `/confirm` or `/link` HTTP behavior. Pure internal tightening.
- The other extraction-review findings that were dismissed (the `'ok' | 'handled'` exhaustiveness observation, the `account` inline-structural-type drift, the `onError` prose-only contract). They were triaged as dismiss; do not fold them in here.
- The pre-existing `${account.email}` null→`'null'` evidence-hash behavior for ORCID-only signups (changing it would invalidate existing on-chain evidence — explicitly NOT in scope).

## References

- `backend/src/routes/signup-verify.ts` — `broadcastAccreditationAndSeed` + its `BroadcastAccreditationOpts` interface and the two call sites in `/confirm` and `/link`.
- The `postBroadcastSuccessCopy` helper in the same file — existing precedent for deriving copy from `routeFlavor`.
- Parent (archived) task `backend-signup-verify-activation-scaffold-extraction` — the extraction this hardens.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
