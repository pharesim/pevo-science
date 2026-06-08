# BACKEND-ANCHOR-ROT-SWEEP-SIGNUP-VERIFY — sweep pre-existing comment-anchor rot in signup-verify.ts + 4 test files

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect, surfaced by `/ce-code-review` of `backend-signup-activation-failure-recovery-and-pool-hold` round-1)
**Priority:** P3

## Problem

Pre-existing comment-anchor rot in the signup-verify subsystem. The 2026-05-30 review of commit `e48b1d60` (signup-activation redesign) confirmed via diff that the rot is **carry-over from the prior file content, not net-new** — the redesign substantively rewrote `signup-verify.ts` but did not sweep adjacent rot in the surrounding comments. Per CLAUDE.md "Comment anchors" all of (a) task-slug citations, (b) round-N markers, (c) line-number anchors into other files, and (d) soft `§ N.N` schema-section anchors are forbidden in production/test source — line numbers drift on insertion, task slugs become dead pointers on archive (250-line `tasks-archive.md` cap), round numbers lose meaning.

The existing `backend-anchor-rot-sweep-2026-05-21` task established the pattern for this kind of cluster sweep (it carries Cluster A for migration headers, Cluster B for `hafsql.test.ts`, and a later-added Cluster C for `§ 2.10`/`§ 2.11` reanchoring on the authorship signer-gate). This task is the signup-verify sibling cluster — same convention, different files, separate scope because the rot is concentrated in signup-verify and was missed by the redesign's "rewrite the file" pass.

## Scope — sweep the following sites

### Production source

- `backend/src/routes/signup-verify.ts` ~10 sites flagged at the 2026-05-30 review:
  - **Task-slug citations**: `BACKEND-REPUTATION-SSOT`, `BACKEND-SIGNUP-VERIFY-STUCK-ACCOUNT-RECOVERY` (and any other slug-shaped labels — grep for `BACKEND-[A-Z]`).
  - **Round-N markers**: `round-1 hold #8`, `round-2 hold #1` and similar (grep for `round-[0-9]`).
  - **Line-number anchors into other files**: `broadcast-error.ts:47-55`, `orcid.ts:886` (grep for `\.ts:[0-9]+`).

### Test source

- `backend/tests/routes/signup-verify-postbroadcast-severity.test.ts` — round-N hold markers in the file header and inline comments.
- `backend/tests/routes/signup-verify.test.ts` — task-slug citations (`SEC-004-BE deliverable` style invocations, others); the file-header carve-out clauses (a)/(b)/(c) currently lean on a slug citation rather than inline documentation per the round-1 review's testing-gap TG-1 (re-anchor on inline rationale rather than the slug).
- `backend/tests/routes/signup-verify-stuck-recovery.test.ts` — task-slug citations.
- `backend/tests/routes/signup-verify-resume-argon-error-translation.test.ts` — **most fragile**: branch names embed `signup-verify.ts` line numbers (`:119`, `:130`, `:140`, `:146`, `:129` per the round-1 review). Replace with branch names keyed on the guard condition ("unknown-email path", "non-confirmed-token path", "ORCID-only no-password path", "confirmed-with-password path").

## Acceptance

1. **Sweep every cited site.** Replace task-slug citations with behavioral descriptions of the invariant being annotated (the guard semantics, the route's purpose, the `PostBroadcastWriteError` cascade, etc.). Replace round-N markers with the behavioral statement they're commenting on. Replace line-number anchors into other files with stable-symbol references (the function name, the exported error class, the route-handler path) per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15`. Replace `:NN` test-branch labels with guard-condition descriptions.

2. **Audit-own-replacement** per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17`: the replacement text must NOT introduce a slug citation, round-N marker, line-number anchor, SHA reference, or `§ N.M` schema-section anchor.

3. **Exhaustive in-file grep** after the sweep — for each touched file, run `grep -nE "BACKEND-[A-Z]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|see the task|task acceptance"` and verify zero hits (or only hits the architect explicitly elects to keep, recorded in the re-review signal).

4. **`signup-verify.test.ts` carve-out header refresh** — the file-header clauses (a)/(b)/(c) currently invoke slug citations (per the round-1 review testing-gap). Rewrite to inline-document: clause (a) explicitly states why real-Hive broadcast is impractical per-test (30s latency, claim-token burn, non-deterministic outcome); clause (b) explicitly states which auth/crypto middleware runs real vs is bypassed; clause (c) cites the real-path companion test file by its current name (e.g., `signup-verify-real-path-broadcast-companion.test.ts` if one exists, or note that the clause-(c) coverage lives in a sibling like `signup-verify-concurrent-activation.test.ts` — verify the cited file exists at write time).

5. **Verification:** `npm run typecheck` clean; `npm run lint` clean; touched test files pass at parity with HEAD before the sweep (the rewrite is comment-only; no behavior changes).

## Out of scope

- **Net-new rot in `e48b1d60`**: this task is for the carry-over rot only. The signup-activation redesign's hold (`backend-signup-activation-failure-recovery-and-pool-hold`) covers net-new findings separately.
- **Other test files in the signup cluster** not in the scope list (`signup-verify-session-binding.test.ts`, etc.) — if the sweep surfaces adjacent rot in those, fold it in opportunistically OR file separately per the implementer's judgment (the audit-own-replacement boundary stays at the SAME function/file being touched; cross-file sweeps are out of scope).
- **Schema-section `§ N.M` anchors** — none currently in the signup-verify cluster per the 2026-05-30 review; if any surface during the sweep, fold them in per the same convention.

## References

- Root `CLAUDE.md` "Comment anchors" section
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- Sibling task `backend-anchor-rot-sweep-2026-05-21` (Clusters A, B, C — already archived) for the canonical pattern.
- 2026-05-30 architect `/ce-code-review` of `e48b1d60` — maintainability persona flagged the cluster (rated P1 net-rot) and project-standards confirmed the rot is pre-existing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-08) — HELD PENDING FIXES:

`/ce-code-review` over the sweep commit (project-standards + testing + correctness + maintainability + learnings personas). The bulk of the sweep is correct and behavior-parity is established (comment/label-only diff). Two in-scope items remain — both P3, comment/label-only, no behavior impact:

1. **Two `SEC-004-BE`-prefixed describe titles survive in `backend/tests/routes/signup-verify.test.ts`** — the `describe('SEC-004-BE: ORCID signup + confirm without password', …)` and `describe('SEC-004-BE: ORCID signup + confirm WITH password', …)` blocks. `SEC-004-BE` is a task-slug citation, and this task's Scope explicitly named "`SEC-004-BE deliverable` style invocations" as a target. The sweep removed the `SEC-004-BE deliverable` mention in the carve-out header but left these two block titles. Reword both to behavioral titles (e.g., "ORCID signup + confirm without password (email+ORCID path)" / "ORCID signup + confirm WITH password (ORCID-match then password-confirm path)").

2. **Carve-out clause (c) overclaims `/confirm` signature verification.** The rewritten file-header carve-out clause (c) states the real-path companion exercises signed-request signature verification "against the same `/confirm` + `/link` routes." Only `/link` carries `verifyHiveSignature` middleware; `/confirm` does not (its resume-path auth is the in-handler `verifyPostingKeyAuthorized` posting-key check, a different mechanism), and the companion file `signup-verify-concurrent-activation.test.ts`'s own header scopes its real-`verifyHiveSignature` claim to `/link`. Reword clause (c) to scope the signed-request signature-verification claim to `/link`, and (if useful) note that `/confirm`'s real-auth coverage in this file is the argon2 + pg path of clause (b), not middleware signature verification.

**Audit-own-replacement (per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17`):** the replacement titles/prose must introduce no new slug, round-N, line-number, SHA, or `§ N.M` anchor.

**Why this slipped — widen the acceptance grep:** the task's acceptance grep (`BACKEND-[A-Z]|round-[0-9]|…`) does not match the `SEC-`/`BE-` slug-prefix family, so its "zero hits" was a false-clean. Before moving back to `review/`, re-grep each touched file with the widened pattern `BACKEND-[A-Z]|BE-[A-Z]|UI-[A-Z]|SEC-[0-9]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|project_[a-z_]+|see the task|task acceptance` and confirm zero hits. (A `/ce-compound` entry capturing this widened canonical pattern is being written at archive of the sibling sweep tasks.)

Move back to `tasks/review/` once both items land; the move is the re-review signal.

## Backend re-review signal (2026-06-08, working tree):

Both round-2 hold items landed in `tests/routes/signup-verify.test.ts`:
1. Reworded the two `SEC-004-BE`-prefixed describe titles to behavioral titles ("ORCID signup + confirm without password (email+ORCID path, password_hash = NULL)" / "ORCID signup + confirm WITH password (ORCID-match then password-confirm path)").
2. Carve-out clause (c) reworded: scopes the signed-request signature-verification (real `verifyHiveSignature` middleware) claim to `/link` only, and notes `/confirm` carries no `verifyHiveSignature` middleware (its resume-path auth is the in-handler posting-key check), so `/confirm`'s real-auth coverage in this file is the argon2 + pg path of clause (b).

Audit-own-replacement: no new slug/round-N/line-number/SHA/§ anchor. Widened-pattern in-file grep returns zero hits. `npm run typecheck` + `npm run lint` clean; label/comment-only, behavior parity.
