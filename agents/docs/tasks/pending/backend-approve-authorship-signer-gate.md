# BACKEND-APPROVE-AUTHORSHIP-SIGNER-GATE — gate the approve_authorship auto-accept on the post-author/bridge signer

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` adversarial during the `backend-claimer-orcids-accreditation-authority-gate` review; verified at the code level by the architect against `hive-schemas.md` § 2.10)
**Priority:** P1 (reputation integrity — live forgery path)

## Problem

The "Explicitly approved" arm of the authorship-claim resolver does NOT verify who signed the `approve_authorship` op. Per `hive-schemas.md` § 2.10, an `approve_authorship` op's `required_posting_auths` MUST be `["<post_author>"]` or `["<HIVE_BRIDGE_ACCOUNT>"]` — the post author (or bridge admin) approves a co-author's claim. But both the reputation cycle and the read surface match the approve op only on its broadcaster-controlled JSON fields, with no signer check:

- `backend/src/reputation.ts` `computeReputationBatch` → `accepted_claims` "Explicitly approved" `EXISTS` arm matches `ap.action = 'approve_authorship' AND ap.claimer = ce.claimer AND ap.paper_author = ce.paper_author AND ap.paper_permlink = ce.paper_permlink AND ap.block_num > ce.block_num`. The `claim_events` CTE that feeds it carries no approver/signer column and applies no `required_posting_auths` filter.
- `backend/src/hafsql.ts` `authorshipClaimsCteBody` → `authorship_claims` `WHEN EXISTS (… approvals ap …) THEN 'accepted'` has the same shape and the same gap. Its `approvals` CTE is `SELECT … FROM claim_events WHERE action = 'approve_authorship'` with no signer gate.

### Exploit (verified reachable at the code level)

1. Attacker is already accredited (required to enter `target_users`).
2. Attacker self-broadcasts `custom_json { id: <appTag>, json: { action: 'claim_authorship', claimer: <self>, paper_author: <victim>, paper_permlink: <p>, author_index: <i> } }` signed with their own posting key.
3. Attacker self-broadcasts `custom_json { id: <appTag>, json: { action: 'approve_authorship', claimer: <self>, paper_author: <victim>, paper_permlink: <p> } }` signed with their own posting key. Per § 2.10 this op is only valid when signed by `<victim>` or the bridge account, but the SQL never checks the signer.
4. The "Explicitly approved" arm matches (`ap.claimer = <self>`, `ap.paper_author = <victim>`, …), so the claim resolves to `accepted` → the attacker accrues co-author reputation credit on the victim's paper every cycle, and shows as an accepted co-author on the read surface.

Both ops are permissionless on Hive and bypass the backend route guard entirely (`routes/claims.ts` enforces the signer for API-driven approvals, but a direct chain broadcast never touches the route). This is the SAME invariant class `backend-claimer-orcids-accreditation-authority-gate` just closed on the ORCID arm — a user must never be able to send a *valid* trust-granting op — reachable here via the approve arm instead. The hive-username auto-accept arm is NOT affected (it requires `authors[i].hive = ce.claimer`, which the attacker cannot forge on a victim's paper).

## Goal

Gate the `approve_authorship` trust read on the op signer in BOTH surfaces, mirroring § 2.10:

1. **Carry the approver/signer through the approve source.** Project `cj.required_posting_auths ->> 0 AS approver` (the on-chain signer) alongside the existing fields in `claim_events` (and thus into `hafsql.ts`'s `approvals` CTE).
2. **Constrain the approved arm** so an approve counts only when `approver` is the post author or the configured bridge account: `AND ap.approver IN (ap.paper_author, $<bridgeParam>)`. Apply this in `reputation.ts` `accepted_claims` (both the approved `EXISTS` and the `MAX(approve_block)` subquery inside the revoke-override) and in `hafsql.ts` `authorshipClaimsCteBody`'s `approvals` source, so the cycle and read surface stay consistent. Confirm the bridge approved-co-author flow (bridge admin endpoint, § 2.10 field note) still resolves to `accepted`.
3. **Behavioral regression** (real Postgres, synthetic VALUES, no-mock-DB stance + clause-(c) header): seed a self-signed approve (signer = claimer, not paper_author) → claim NOT accepted; an approve signed by `paper_author` → accepted (control); an approve signed by the bridge account → accepted (control). A targeted revert of the new signer predicate must turn the self-signed assertion red. Mirror the synthetic-fragment approach in `reputation-orcid-auto-accept-authority-gate.test.ts`.

## Acceptance criteria

- The `approve_authorship` arm in both `reputation.ts` and `hafsql.ts` admits an approve only when its `required_posting_auths[0]` is the post author or the bridge account.
- The exploit above no longer resolves to `accepted`; legitimate author-signed and bridge-signed approves still do.
- The revoke-override `MAX(approve_block)` subquery uses the same signer constraint (a self-signed approve must not be able to out-rank a legitimate revoke and silently re-accept a revoked claim).
- Reputation remains reproducible from public on-chain data; no off-chain state introduced.
- Comments anchor on stable symbols (no task slugs, round numbers, line numbers, or SHAs in production/test source).

## Notes

- `config.hiveBridgeAccount` is the bridge account already threaded through `validPevoPaperWhere('bridge')` and the notifications query; reuse it rather than introducing a new config field.
- The sibling `claim_approved` / `claim_pending` notification arms in `notification-queries.ts` were flagged by the same adversarial pass as also signer-ungated (P2 nuisance-spam, not a trust grant). Surface for triage; out of this task's reputation-integrity scope unless trivially covered by the same change.
- `revoke_authorship` is intentionally permissive on its signer per § 2.11 (the claimer may self-revoke, and author/bridge/admin may revoke). Do NOT add a post-author-only gate to the revoke arm; revoke only removes credit.

## Architect review (2026-05-27) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `595a8c6e` (correctness, adversarial, security, testing, maintainability, project-standards; `ce-agent-native-reviewer` skipped per PEvO). The gate itself is CORRECT and COMPLETE: security and adversarial both confirm the exploit is closed on BOTH surfaces — `approver` derives from the Hive-consensus-enforced `required_posting_auths ->> 0` (unspoofable; a crafted `[victim, attacker]` auths array never lands without the victim's signature), `IN (ap.paper_author, $bridge)` admits only author-/bridge-signed approves and is fail-closed on a NULL approver, the revoke-override MAX subquery carries the same gate (a self-signed approve cannot out-rank a revoke), and the auto-accept arms (gated on `author_index IS NOT NULL` against the victim's own `authors[]`) stay unforgeable. The architect verified `$18 = config.hiveBridgeAccount` in `computeReputationBatch`'s params array, and `bridgeIdx = startIdx+3` with the scope-param shift threaded correctly through `nextIdx`. The notification `claim_approved`/`claim_pending` arms remain signer-ungated but are nuisance-spam only (no trust/reputation consequence) — correctly out of scope. One P1 coverage gap holds:

1. **(P1, conf 100 — testing, corroborated by correctness/adversarial/security/maintainability) The reputation-cycle surface of the gate is untested.** The new `authorship-approve-signer-gate.test.ts` exercises only `authorshipClaimsCteBody` (the read surface in `hafsql.ts`). The mirrored `ap.approver IN (ap.paper_author, $18)` predicate in `computeReputationBatch`'s inline `accepted_claims` CTE (both the approved-EXISTS arm and the revoke-override MAX subquery) has no behavioral or structural test — and the cycle is the surface where the forged co-author reputation credit actually accrues, behind a hardcoded `$18` kept in sync with the read surface only by mirrored comments. A param insertion before `$18`, or a predicate removal in `reputation.ts` alone, would silently re-open the forgery on the cycle while the read-surface test stays green. Add a HAF-free SQL-shape canary asserting the `approver IN (ap.paper_author, $18)` predicate appears in the cycle's emitted SQL for BOTH arms (mirror the existing `chainOrcidAutoAcceptMatchSql` / hive-username SQL-shape canary pattern), so predicate-removal and param-drift on the cycle surface are caught independently of the read surface and of whether HAF is configured.

Folded elsewhere, NOT held here: the `§ 2.10`/`§ 2.11` section-number comment anchors in `hafsql.ts`, `reputation.ts`, and the new test file (project-standards: line-number-equivalent rot) are added to `backend-anchor-rot-sweep-2026-05-21`'s scope so the section-number-anchor class is swept uniformly rather than as a one-off in this commit. A matching read-surface SQL-shape canary (corroborating testing residual) is welcome but not required.

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 review scopes to the fix commit(s) only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-28, working tree)

Round-1 hold item 1 landed. New HAF-free SQL-shape canary for the reputation-cycle surface: `tests/routes/reputation-approve-signer-gate-cycle-sql-shape.test.ts`. It mocks `getPool` with a capturing pool, drives `computeReputationBatch(['some-target-user'], {}, 12345)` (cycleEndBlock + prevScores provided so the run reaches the inline `accepted_claims` query without the head-block / prev-score reads), captures the emitted SQL, and asserts `ap.approver IN (ap.paper_author, $18)` appears EXACTLY TWICE — once in the "Explicitly approved" EXISTS arm and once in the revoke-override `MAX(approve_block)` subquery. Pinning the exact `$18` catches a bridge-param insertion/drift; requiring two occurrences catches a predicate removal from either arm alone. Runs regardless of HAF configuration (carve-out (a)(b)(c) header documents the mocked getPool).

Placement deviation from the hold's filing assumption: the canary landed in a NEW file rather than `authorship-approve-signer-gate.test.ts`. That file's existing synthetic-VALUES tests use the REAL `getPool` against real Postgres, so a file-level `getPool` mock for the cycle canary is incompatible with them; the new file isolates the mock. A side effect is that `authorship-approve-signer-gate.test.ts` is no longer touched by this task, so the `backend-anchor-rot-sweep` Cluster-C §-anchor reanchor of that file proceeds with no clobber.

Test-only change (no production source touched). Verification: `npm run typecheck` (src + tests) clean; the new canary green; the existing read-surface synthetic-VALUES tests in `authorship-approve-signer-gate.test.ts` are untouched and green.

## Architect re-review (2026-05-28) — HELD PENDING FIXES (round 2)

`/ce-code-review` on the round-1 fix commit (testing, correctness, project-standards). Round-1 hold item 1 is CONFIRMED FIXED: the new cycle-surface SQL-shape canary drives `computeReputationBatch` to the real inline `accepted_claims` SQL emission (captured at the pool boundary, not stubbed — `prevScores`/`cycleEndBlock` provided so it reaches the query without short-circuiting), and asserts `ap.approver IN (ap.paper_author, $18)` appears EXACTLY TWICE (the "Explicitly approved" EXISTS arm + the revoke-override `MAX(approve_block)` subquery). A predicate removal from either arm drops the count to 1 → red; a bridge-param drift off `$18` drops it to 0 → red; the assertion cannot pass vacuously. Carve-out (a)(b)(c) satisfied (mocked `getPool` documented in the header; the read-surface synthetic-VALUES test is the real-path companion). One P2 holds:

1. **(P2, conf 100 — project-standards) The new canary file introduces a fresh `§2.10` section-number anchor.** Its header docblock opens with "HAF-free SQL-shape canary for the §2.10 approve_authorship signer gate…". The CLAUDE.md "Comment anchors" convention forbids `§ N.N` section-number citations in production/test source — they rot when the schema doc is renumbered. This is the exact rot class the sibling `backend-anchor-rot-sweep` task exists to eliminate, introduced in a file created after that sweep's cluster ran (so it escaped the sweep). Reanchor on the behavioral name: drop the `§2.10` prefix, leaving "approve_authorship signer gate" (the op-action string is self-sufficient and stable). Sweep the whole new file for any other `§` citation while in there, and confirm no replacement reintroduces a slug/round/line/SHA anchor.

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-3 review scopes to the fix commit(s) only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
