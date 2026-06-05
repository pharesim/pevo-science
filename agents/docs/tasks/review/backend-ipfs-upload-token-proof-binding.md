# BACKEND-IPFS-UPLOAD-TOKEN-PROOF-BINDING — decide: session-class proof vs per-action target binding for /upload-token

**Owner:** Backend Agent (with architect ruling on the § 6.5 posture)
**Created:** 2026-05-30 (architect review of `backend-ipfs-upload-bind-file-to-signature`)
**Priority:** P2 (cross-surface fresh-auth-proof reuse; requires a captured session proof + stolen JWT)

## Problem

`POST /api/ipfs/upload-token` (JWT path) consumes a fresh-auth proof via `consumeSessionFreshAuthToken(proofToken, username)` — a **target-less, session-kind** proof. The same session-proof primitive is minted for and consumed by the non-consent custody surface (votes, comments via `/api/custody/broadcast`). Because session proofs carry no `(action, target)` binding, a session proof the victim generated for a vote/comment is byte-for-byte interchangeable at `/upload-token`.

Attack (malicious SPA or proof-capture adversary): with the victim's stolen JWT plus a captured session proof, redirect the proof to `/upload-token`, mint an upload token, and pin attacker content under the victim's account — the "pin arbitrary content under a victim" outcome the upload-token task set out to close, reached without the victim authorizing an upload. Bounded by the single-use, short-TTL nature of the proof (the attacker must capture one), and a stolen-JWT-only attacker is still correctly blocked.

The consent-op surface (`author_accept`/`author_resign`) already defends this class with per-op target binding (§ 6.4). Upload-token issuance was folded into the deliberately target-less session class; pinning content (with illegal-content-liability stakes) may warrant the stronger binding.

## Decision needed

- **(a) Document as session-class.** Accept that any session proof for the user authorizes an upload-token mint, and record that decision explicitly against ARCHITECTURE.md § 6.5 alongside vote/comment. Update the § 6.4 row (currently flagged "under review"). Cheapest; defensible if pinning-by-already-accredited-user is judged low-stakes.
- **(b) Bind per-action.** Mint upload-token proofs as consent_op-kind with a per-action target (e.g. `action='ipfs_upload'`, scoped to the account), via the existing `issueFreshAuthToken`/`consumeFreshAuthToken` + `computeFreshAuthTargetHash` path, so a vote/comment session proof cannot be redirected here.

Architect note: lean toward (b) given the content-liability stakes the parent task itself cited, but this is a posture decision, not an obvious default. Resolve before building the SPA round-trip (`ui-ipfs-upload-token-roundtrip`) so the client mints the right proof kind.

## Acceptance

1. The chosen posture is recorded in ARCHITECTURE.md § 6.4/§ 6.5 and the § 6.4 "under review" note is removed.
2. If (b): `/upload-token` consumes a per-action proof; a test confirms a session proof minted for the custody surface is REJECTED at `/upload-token`, and the legitimate mint-then-upload flow still works.
3. If (a): a test/doc note pins that session-proof reuse across upload-token and vote/comment is intentional.

## References

- `backend/src/routes/ipfs.ts` — `/upload-token` (`consumeSessionFreshAuthToken` call).
- `backend/src/lib/fresh-auth.ts` — session vs consent-op proof kinds; `computeFreshAuthTargetHash`.
- `backend/src/routes/custody.ts` — the consent-op per-target binding to mirror.
- ARCHITECTURE.md § 6.4 (upload-token row) and § 6.5 invariant #1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend implementation note (2026-06-04)

User chose **Option (b): per-action binding** (the architect's lean, given the content-liability stakes).

**What shipped (backend):**
- `lib/fresh-auth.ts`: new `'ipfs_upload'` member of `FreshAuthTargetAction` + an `ipfsUploadFreshAuthTarget(username)` helper binding to `(ipfs_upload, <username>, '')` (per-user, empty `root_permlink` collision-free against consent-op proofs, distinct `action` blocks redirect of a vote/comment session proof or a wrong-action consent-op proof). Docblock updated.
- `routes/ipfs.ts` `/upload-token` JWT path now consumes via `consumeFreshAuthToken(proof, username, computeFreshAuthTargetHash(ipfsUploadFreshAuthTarget(username)))` instead of `consumeSessionFreshAuthToken`. A session proof fails the consent-op `kind` check (`kind_mismatch`); a wrong-action proof fails the target-hash compare (`target_mismatch`); both surface as 401 `FRESH_AUTH_REQUIRED`. The signature path is unchanged (per-request signature is itself fresh). Route docblock updated.
- **Issuance side extended so the proof can actually be minted:** `routes/custody.ts` `/fresh-auth` (password mechanism, states A/B) and `routes/orcid.ts` `mode='fresh_auth'` (ORCID mechanism, states B/C) both accept `action: 'ipfs_upload'` (no `root_*` fields; target derived from the authenticated username). Validator + handler error messages updated to include the new action.

**Tests:**
- `ipfs-upload-token.test.ts` no longer mocks fresh-auth — it mints REAL proofs and asserts a `kind: 'session'` proof is REJECTED at `/upload-token` (`reason: 'kind_mismatch'`) while an `ipfs_upload`-targeted proof is ACCEPTED (the acceptance-#2 pair).
- `custody-fresh-auth-null-hash.test.ts` gains an issuance test: `POST /api/custody/fresh-auth { action: 'ipfs_upload' }` with a valid password → 200, and the minted proof consumes valid against the `ipfs_upload` target hash (proves the issuance branch binds the right target).
- No regression: custody (`-non-consent-fresh-auth`, `-fresh-auth-null-hash`, `-consent-ops`), `orcid.test.ts` (94), and `fresh-auth.test.ts` all green.

**[TODO Architect] ARCHITECTURE.md § 6.4/§ 6.5 (architect-owned).** Record posture (b) and **remove the "under review" note** from the § 6.4 "Issue IPFS upload token" row: the JWT path now requires a per-action `ipfs_upload`-targeted fresh-auth proof (not a target-less session proof), so a vote/comment session proof can no longer be redirected to `/upload-token`. The issuance factor is still per-account (password for A/B via `/api/custody/fresh-auth { action: 'ipfs_upload' }`, ORCID for B/C via `/api/orcid/start { mode: 'fresh_auth', action: 'ipfs_upload' }`).

**[TODO UI] `ui-ipfs-upload-token-roundtrip` must mint the `ipfs_upload` proof kind.** The SPA's light-account/JWT upload flow must now obtain a fresh-auth proof minted for `action: 'ipfs_upload'` (via custody `/fresh-auth` or ORCID `fresh_auth`), NOT a session proof, before `POST /api/ipfs/upload-token`. (Architect to relay to the UI agent / annotate the existing `ui-ipfs-upload-token-roundtrip` task.)

## Architect re-review (2026-06-05) — HELD PENDING FIXES:

`/ce-code-review` (10-persona fan-out; correctness/security/adversarial at Opus tier) on commit `0c25a772` confirmed the per-action proof binding is sound: the `ipfs_upload` target hash is collision-free vs session proofs (kind_mismatch), consent-op proofs (distinct `action` + non-empty `root_permlink`), and the other per-user actions (set_password/change_email/delete_account); the empty `root_permlink` cannot collide with a real permlink; issuance is wired through both custody `/fresh-auth` (password) and orcid `/start` (ORCID, `action` admitted via `z.string()`). Four items before archive:

1. **Status-code inconsistency vs the sibling consent-op consume (P2).** `POST /api/ipfs/upload-token` maps the consume result with `result.reason === 'username_mismatch' ? 403 : 401`, so `kind_mismatch`/`target_mismatch` return 401. But the parallel `consumeFreshAuthToken` site on the custody consent-op broadcast path deliberately maps `username_mismatch`/`target_mismatch`/`kind_mismatch` all → 403 (a binding violation is "forbidden", not "no proof present"). The upload-token 2-way form is the leftover from the old `consumeSessionFreshAuthToken` (whose only binding reason was `username_mismatch`); now that it consumes a per-action proof it should adopt the same 3-way 403 discrimination as the custody consent-op handler. Align the two, and update the `/upload-token` test that asserts the session-proof rejection status from 401 to 403 (the body still carries `FRESH_AUTH_REQUIRED` + `details.reason`).

2. **Anchor-rot: task-slug citation in a test header.** The header comment this commit added to `backend/tests/routes/custody-fresh-auth-null-hash.test.ts` names this task's slug. Per root `CLAUDE.md` "Comment anchors", replace it with a behavioral description of what the added test pins (the `ipfs_upload`-targeted issuance branch), no slug.

3. **Anchor-rot: task-option coordinates in test titles.** The test titles `... (per-action binding, option b)` in `ipfs-upload-token.test.ts` and `... (option b issuance side)` in `custody-fresh-auth-null-hash.test.ts` embed the task's option-enumeration label ("option b"), which loses meaning once the task archives. Reword to behavioral descriptions (e.g. "per-action ipfs_upload binding", "password-mechanism issuance side").

4. **Test gap: ORCID-mechanism `ipfs_upload` issuance is untested.** The password-mechanism issuance branch is pinned in `custody-fresh-auth-null-hash.test.ts`, but the ORCID-mechanism branch (`routes/orcid.ts` `/start` `mode='fresh_auth' action='ipfs_upload'`) has no coverage. A mutation routing `ipfs_upload` into the `change_email` else-arm would mint a wrong-target proof and slip the issuance suite (caught only downstream at consume). Add an issuance test exercising the ORCID `fresh_auth` path and asserting the minted proof consumes valid against `ipfsUploadFreshAuthTarget(username)`; a targeted ORCID-callback mock with a documented carve-out is acceptable given the state-C seeding difficulty.

Architect-owned, not your work: I will update `ARCHITECTURE.md` §6.4/§6.5 (record posture (b), remove the "under review" note on the upload-token row) at final archive of this task.

## Backend re-review signal (2026-06-05, commit on main)

All four 2026-06-05 hold items landed:
1. `/upload-token` JWT-path consume-failure mapping aligned to the custody consent-op 3-way 403 (`username_mismatch || target_mismatch || kind_mismatch → 403`, else 401) in `routes/ipfs.ts`; the redirected-session-proof test now expects 403.
2. Removed the task-slug citation from the `custody-fresh-auth-null-hash.test.ts` header docblock.
3. Stripped the "(per-action binding, option b)" / "(option b issuance side)" anchor-rot from the two test titles.
4. Added ORCID-mechanism `ipfs_upload` issuance coverage in `orcid.test.ts` (the `fresh_auth mode` describe block).
`npm run typecheck` + `npm run lint` clean.
