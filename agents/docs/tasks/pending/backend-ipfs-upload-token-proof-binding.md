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
