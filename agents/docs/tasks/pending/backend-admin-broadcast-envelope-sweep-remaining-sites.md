# BACKEND-ADMIN-BROADCAST-ENVELOPE-SWEEP-REMAINING-SITES — migrate the remaining inline admin custom_json envelope sites to broadcastAdminCustomJson

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect decision on `backend-admin-broadcast-helper-extraction`: accept the 3/5 adoption, finish the dedup)
**Priority:** P3 (maintainability dedup; no defect — all sites are correct inline today)

## Background

`broadcastAdminCustomJson` (`backend/src/hive.ts`) centralizes the admin custom_json envelope (`id: appTag`, `required_auths: []`, `required_posting_auths: [config.hiveAdminAccount]`, `json`) + `PrivateKey.fromString(config.pevoAdminPostingKey)` + the `AdminKeyNotConfiguredError` guard. It was adopted at 3 sites (`wot.ts` `broadcastWotAccreditation` + `cascadeRevocation`, `routes/claims.ts` admin revoke). The architect accepted that 3/5 and asked for the remaining sites to be swept (decision recorded on the parent task, 2026-06-09).

A review-time grep (`required_posting_auths` + `config.hiveAdminAccount` + `PrivateKey.fromString(config.pevoAdminPostingKey)`) confirmed the complete set of remaining inline sites:

- `routes/papers.ts` (retraction broadcast) — straightforward.
- `routes/accreditation.ts` — straightforward.
- `routes/signup-verify.ts` (`broadcastAccreditationAndSeed`'s admin broadcast) — straightforward, BUT preserve its existing `if (config.pevoAdminPostingKey)` skip-guard (it silently skips the broadcast when the key is unset; do not turn that skip into a thrown `AdminKeyNotConfiguredError`).
- `routes/orcid.ts` ×2 (`handleAccredit`, `handleLink`) — REQUIRES CARE, see below.

## The orcid constraint (do NOT migrate naively)

Both orcid sites keep `PrivateKey.fromString(config.pevoAdminPostingKey)` **OUTSIDE** the inner `try`, so a key-construction throw escapes synchronously to the `withOrcidBindingLock` wrapper → **504 ambiguous-outcome + lock release**. The `SEC-002-TOCTOU-LOCK` describe block pins exactly this shape (verified at the helper-extraction review). Folding the async helper in parses the key INSIDE the `try`, converting that synchronous throw into an inner-catch rejection → **502 BROADCAST_FAILED on the lock-acquired branch** — a security-tested failure-shape change.

To migrate orcid safely: validate/parse the admin key OUTSIDE the inner `try` before the helper call (or re-map `AdminKeyNotConfiguredError` / key-parse errors back onto the wrapper-escape path), AND update the matching `SEC-002-TOCTOU-LOCK` specs deliberately. If this proves heavier than the three straightforward sites, **split orcid into its own task** and land `papers` / `accreditation` / `signup-verify` first.

## Acceptance

1. Each migrated site calls `broadcastAdminCustomJson`; the envelope literal exists only in `hive.ts`. No `required_posting_auths: [config.hiveAdminAccount]` inline construction remains except any deliberately-exempt orcid path (documented if so).
2. Each site's response-on-failure shape is preserved. For orcid specifically, the 504+lock-release boundary holds: `SEC-002-TOCTOU-LOCK` specs stay green, or are updated as a conscious, reviewed change.
3. `signup-verify`'s `config.pevoAdminPostingKey` skip-guard semantics are preserved (no new throw on the unset-key path).
4. **`AdminKeyNotConfiguredError` becomes live with this work.** For each migrated site, confirm it either pre-guards the key (skip path, like wot/claims/signup-verify) or maps the helper's throw to a correct response. Update the `broadcastAdminCustomJson` docblock to reflect that the throw is now reachable from any non-pre-guarded adopter (the docblock was reworded under the parent task to describe the pre-sweep, all-callers-pre-guard state — see `backend-admin-broadcast-helper-extraction`).
5. Comment anchors clean (stable symbols only; no slug/line/SHA/§). `npm run typecheck` + `npm run lint` clean; affected suites green (incl. the orcid `SEC-002-TOCTOU-LOCK` suite).

## References

- `backend/src/hive.ts` — `broadcastAdminCustomJson`, `AdminKeyNotConfiguredError`.
- Inline sites: `routes/papers.ts` (retraction), `routes/accreditation.ts`, `routes/signup-verify.ts` (`broadcastAccreditationAndSeed`), `routes/orcid.ts` (`handleAccredit` + `handleLink`).
- Grep to confirm the residual set before/after: `grep -rn "PrivateKey.fromString(config.pevoAdminPostingKey)" backend/src` and `grep -rn "required_posting_auths.*hiveAdminAccount" backend/src` (`hafsql.ts` hits are HAF validity-rule doc comments, not broadcast sites — exclude).
- Parent: `backend-admin-broadcast-helper-extraction` (the 3/5 extraction this finishes).
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (grep both directions to confirm the migration is exhaustive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend completion + re-review signal (2026-06-09, commit `abaf65a5`)

Landed the three straightforward sites; **split orcid** into its own task per this task's "split orcid into its own task" provision.

- **`papers.ts` retraction:** now calls `broadcastAdminCustomJson(payload)`; the existing `if (!config.pevoAdminPostingKey) → 500` pre-guard stays, so `AdminKeyNotConfiguredError` is unreachable. Dropped the now-unused `PrivateKey` import (grep: 0 `PrivateKey` refs remain in the file).
- **`accreditation.ts` verify:** now calls `broadcastAdminCustomJson(customJsonPayload)`; pre-guarded at the route head (`if (!config.pevoAdminPostingKey) → deleteToken + 500`). Dropped the unused `PrivateKey` import; updated the two comments that named `broadcastJsonWithTimeout` → `broadcastAdminCustomJson`.
- **`signup-verify.ts` `broadcastAccreditationAndSeed`:** now calls `broadcastAdminCustomJson(...)`; the top-level `if (!config.pevoAdminPostingKey)` skip-guard is preserved (broadcast SKIPPED, no thrown `AdminKeyNotConfiguredError` on the unset-key path — acceptance #3). `PrivateKey` import kept (still used for posting-key auth at the upgrade-proof site).
- **`hive.ts` docblock (acceptance #4):** reworded the `AdminKeyNotConfiguredError` class docblock — the throw is now a LIVE failure mode reachable from any non-pre-guarded adopter (replaced the closed, now-stale caller enumeration with the contract: pre-guard at the call site whenever the unset-key path needs a response shape more specific than the generic 502).
- **Acceptance #1 (partial → deferred remainder):** no `required_posting_auths: [config.hiveAdminAccount]` inline construction remains in `papers.ts` / `accreditation.ts` / `signup-verify.ts`. The two orcid sites (`handleAccredit`, `handleLink`) still construct it inline — **deliberately deferred** to `backend-admin-broadcast-orcid-sites` (the envelope literal will live only in `hive.ts` once that lands). Documented here per acceptance #1's "deliberately-exempt orcid path (documented if so)".

**Tests:** added `broadcastAdminCustomJson` to the 10 affected suites' `hive.js` mock factories (retract, retract-rate-limit-skip-failed, accreditation, accreditation-idempotency, signup-verify + the 5 signup-verify-* variants), routing through each suite's existing `broadcastJsonMock` so staged results/rejections and the `findAccreditOp` `.json`-payload inspection carry over unchanged.

**Verification:** `npm run typecheck` (src + tests) + `npm run lint` clean (one pre-existing unrelated `author-supersession.ts` warning). All migrated-route suites green EXCEPT **two PRE-EXISTING failures** in `accreditation.test.ts` — the per-token broadcast-attempts-cap concurrency tests ("504 timeout outcomes DECREMENT the counter" + "concurrent retries claim slots atomically"). **Confirmed pre-existing: both fail identically on a clean tree (this change stashed)**, so they are NOT introduced by this migration (surfaced, not fixed — out of scope; likely the documented full-suite concurrency/load flakiness).

**Re-review scope:** commit `abaf65a5` only. orcid migration tracked separately in `backend-admin-broadcast-orcid-sites` (`pending/`).

---

## Architect re-review (2026-06-10) — HELD PENDING FIXES (3 items)

`/ce-code-review` fan-out on commit `abaf65a5` (correctness + security + adversarial on the session model; testing/maintainability/project-standards/reliability/kieran-typescript/learnings on Sonnet; ce-agent-native skipped per PEvO). **The migration is verified CORRECT at all three sites:** envelope parity byte-exact vs the removed inline forms (id, json serialization, auths, 30s default timeout threading); papers/accreditation catch scopes unchanged (their key-parse already sat inside the try); pre-guards confirmed intact so `AdminKeyNotConfiguredError` stays unreachable at all three sites; the broadcast-attempts cap's timeout-decrement semantics preserved (`BroadcastTimeoutError` propagates the helper unchanged; the decrement keys on the timeout outcome); signup-verify best-effort semantics preserved; exhaustiveness grep at HEAD shows the envelope literal only in `hive.ts`. Architect-verified suites green vs real Postgres/Redis: signup-verify 14/14, hive-broadcast-timeout 26/26, orcid 102/102 (combined 142/142 run).

**Accepted deviation (user triage, documented, no code change):** the set-but-malformed admin-key edge in `broadcastAccreditationAndSeed` moved from a pre-inner-try synchronous throw (old 500 escape) to an inner-catch 502 BROADCAST_FAILED — an acceptance #2 deviation found at conf 100 by three reviewers and accepted as the better shape: the account row is already finalized at that point, the 502 envelope matches the stuck-recovery design, the edge is reachable only via operator misconfig (set-but-invalid WIF), and nothing pins the old shape. Recorded here so the eventual archive entry carries it.

**Dismissed at triage:** the fabricated mock envelope in the route suites' `hive.js` factories (`required_posting_auths: []`, no `id`) — compensated by the real-helper envelope pin in `hive-broadcast-timeout.test.ts` (the F2 pin from `backend-pin-shared-broadcast-values`, archived); factory comments already state routing-only intent; preemptive-hardening default. The 10-suite mock-factory duplication (the `vi.hoisted` per-file binding makes consolidation infeasible — verified). Route-level `AdminKeyNotConfiguredError` injection tests (unreachable behind verified pre-guards; the helper-level throw is pinned in `hive-broadcast-timeout.test.ts`).

Items before archive (all comment-only):

1. **(P2) `hive.ts` `AdminKeyNotConfiguredError` docblock: the WoT bullet is factually wrong.** It claims "A WoT-style caller catches it inline and reports a `skipped` result" — but all three `wot.ts` call sites pre-guard `if (!config.pevoAdminPostingKey)` BEFORE calling the helper and return their skipped result without the helper ever throwing; a helper throw reaching their catch would surface as a chain-error result, not skipped. This rewrite (acceptance #4 of this task) replaced one stale adopter enumeration with another inaccurate one. Reword OFF the per-adopter enumeration entirely: state the contract (pre-guard at the call site whenever the unset-key path needs a response shape more specific than `handleBroadcastError`'s generic 502; otherwise let the throw fall through) without enumerating adopter types — the enumeration form is what has now rotted twice. Anchor on stable symbols (`wot.ts` pre-guards, `handleBroadcastError`); no slug/round/line/SHA.
2. **(P3) `signup-verify.test.ts` `findAccreditOp` comment names only the two pre-helper seams** (`hiveClient.broadcast.json`, `broadcastJsonWithTimeout`) backed by `broadcastJsonMock`; `broadcastAdminCustomJson` is now a third. Update the seam enumeration (every seam's `call[0]` is an envelope carrying the stringified op in `.json`).
3. **(P3) `signup-verify-session-binding.test.ts` header: the "only mocks" enumeration omits `broadcastAdminCustomJson`.** Make the stated mock set match the factory contents.

When the three items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit only. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
