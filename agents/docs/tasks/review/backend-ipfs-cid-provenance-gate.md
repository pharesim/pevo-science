# BACKEND-IPFS-CID-PROVENANCE-GATE — gateway should gate on CID provenance, not just an accredited reference

**Owner:** Backend Agent
**Created:** 2026-05-30 (architect review of `backend-ipfs-gateway-content-type-and-cid-scope`)
**Priority:** P2 (content-spoofing under trusted origin + gateway bandwidth abuse; XSS already closed by CSP sandbox)

## Problem

The gateway's `cidIsKnown` (via `cidReferencedByAppTag(pool, cid, { requireAccreditedAuthor: true })`) proves only that *some currently-accredited author referenced the CID* in an APP_TAG comment. It does NOT prove the CID was ever pinned through PEvO. Because the chain is the SSoT and comments are broadcast client-side with fully attacker-authored `json_metadata`, any accredited account can self-whitelist an arbitrary externally-pinned CID by naming it in their own post, most cheaply via the image-markdown substring branch of the containment query (`img LIKE '%' || cid || '%'`), which matches a CID appearing anywhere in any `image[]` URL.

Effect: `GET /api/ipfs/<cid>` will proxy attacker-pinned bytes under the app origin. The per-route `Content-Security-Policy: sandbox` + `nosniff` close the same-origin script-execution chain, so the residual is **content-spoofing / phishing-under-trusted-origin** plus **unbounded gateway bandwidth-and-cache abuse** (the gateway proxies and caches arbitrarily large external blobs the uploader never sent through the size-limited upload path).

The gateway hardening task achieved its stated narrower goal (a *free unaccredited* account can no longer whitelist a CID). This task is the follow-up to decide whether the gateway should additionally require provenance.

## Options (architect/user to confirm before implementing)

1. **Accept + document the residual.** The CSP sandbox is the load-bearing control; treat trusted-origin content hosting by an accredited actor as an accepted residual and note it in `api-contracts/ipfs.md`. Cheapest. Pin the CSP-sandbox directive with a test that asserts it carries NO allow-tokens, since it becomes the only barrier.
2. **Gate the gateway on provenance.** Require the served CID to ALSO appear in `pending_ipfs_uploads` (i.e. it was actually pinned via `POST /api/ipfs/upload` by an accredited user), in addition to (or instead of) the chain-reference check.
3. **Drop the substring branch from the gateway predicate only.** Keep `img LIKE '%cid%'` on the cleanup path (over-inclusive is safe there) but remove it from the gateway's `requireAccreditedAuthor` query so a free-text markdown URL cannot whitelist a CID; require the structured `ipfs_cid` / `supplementary_files[].cid` position.

## Hard constraint

**Do NOT tighten the cleanup-job path.** `cidReferencedByAppTag` is shared with `ipfs-cleanup.ts`, where under-inclusiveness unpins a live on-chain-referenced file irreversibly. Any provenance gate must remain gateway-only (the existing `requireAccreditedAuthor` opt-in parameter is the model); the cleanup call must keep emitting the byte-identical, over-inclusive `$1..$4` query.

## Acceptance

1. The chosen posture is implemented gateway-only; the cleanup path's emitted SQL + params are unchanged (the existing default-path shape test still passes).
2. If option 2/3: a real-HAF test seeds an accredited author's comment whose ONLY reference to the attacker CID is via the image-substring branch, and asserts `cidIsKnown` returns false (gateway 404). Plus a positive test that a genuinely-uploaded/structured-reference CID still serves.
3. If option 1: the residual is documented in `api-contracts/ipfs.md` and a test pins that the `/api/ipfs/*` CSP header is exactly `sandbox` with no allow-tokens.

## References

- `backend/src/lib/ipfs-shared.ts` — `cidReferencedByAppTag` (the three OR-branches; the image-substring branch).
- `backend/src/routes/ipfs.ts` — `cidIsKnown`, the pending-row short-circuit.
- `backend/src/ipfs-cleanup.ts` — the over-inclusive cleanup consumer (must stay byte-identical).
- Archived task `ipfs-gateway-content-type-and-cid-scope` (tasks-archive.md) for the control-3 rationale.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend implementation note (2026-06-04)

User chose **Option 3 + the CSP pin** (the question batched the three options; option 2 was flagged as broken-as-written because `ipfs-cleanup.ts` DELETEs the `pending_ipfs_uploads` row once a CID is confirmed on-chain, so gating the gateway on that table would 404 every published paper after 24h — it would need a new persistent provenance store).

**What shipped:**
- `cidReferencedByAppTag` (`lib/ipfs-shared.ts`) gains a second gateway-only opt-in, `excludeImageReference`. When set, the broadcaster-controlled `image[]`-substring OR-branch is dropped from the predicate (along with its sole `cid` bind param), so only the structured `metadata.<appTag>.ipfs_cid` / `supplementary_files[].cid` positions whitelist a CID into the gateway. This closes the cheapest self-whitelist vector (an accredited author embedding an external CID in any `image[]` URL).
- The gateway's `cidIsKnown` (`routes/ipfs.ts`) now passes `{ requireAccreditedAuthor: true, excludeImageReference: true }`. The **cleanup path is untouched** — it passes neither flag, keeps the over-inclusive image match (under-inclusive there = irreversible unpin of a live file), and emits the byte-identical `$1..$4` SQL + params. Verified: `ipfs-shared-cid-containment.test.ts`, `ipfs-cleanup-backend-dispatch.test.ts`, and `ipfs-image-srf-guard.test.ts` all still green.
- Tests added in `ipfs-gateway-hardening.test.ts`: `excludeImageReference` drops the SRF guard + the cid param (3 params, not 4); the gateway combination keeps the accreditation CTE + drops the image branch (5 params); and an explicit CSP-no-allow-tokens pin (the `/api/ipfs/*` CSP is exactly `sandbox`, no `allow-*` token) since the sandbox is the load-bearing barrier for the residual.

**Residual (intentional, per the chosen posture):** an accredited author can still self-whitelist an external CID via a *structured* `ipfs_cid` / `supplementary_files[].cid` reference (i.e. by publishing it as their paper's file). Option 3 narrows the vector to the deliberate structured path and removes the cheap free-text-image path; the CSP sandbox remains the load-bearing control against script execution. Full provenance (option 2) is explicitly deferred — it needs a persistent provenance store, not the transient `pending_ipfs_uploads` table.

**[TODO Architect] `api-contracts/ipfs.md` note (architect-owned).** The `GET /api/ipfs/:cid` known-CID gate now requires a STRUCTURED on-chain reference (`ipfs_cid` / `supplementary_files[].cid`) by an accredited author; a CID named only inside a free-text markdown `image[]` URL no longer resolves at the gateway. If the contract documents the CID-known gate, note the structured-reference requirement and the accepted structured-self-reference residual.

## Architect re-review (2026-06-05) — HELD PENDING FIXES:

`/ce-code-review` (10-persona fan-out; correctness/security/adversarial at Opus tier) on commit `b4a3c914` confirmed the provenance gate is correct: `excludeImageReference` drops the broadcaster-controlled `image[]`-substring OR-branch and its sole `cid` bind; the `$N` placeholder bookkeeping is correct on all three paths (cleanup `{}` → `$1..$4` with image branch; exclude-only → `$1..$3`; gateway combination → `$1..$5`); the cleanup path stays byte-identical; and the CSP-no-allow-tokens pin holds. One item before archive:

1. **Anchor-rot: task-slug citation in a test comment.** The CSP-no-allow-tokens spec this commit added to `backend/tests/routes/ipfs-gateway-hardening.test.ts` opens with a comment that names this task's slug. Per root `CLAUDE.md` "Comment anchors", task slugs must not appear in production/test code — the task archives and the citation becomes a dead pointer. Replace it with a behavioral anchor explaining WHY the CSP sandbox must carry no allow-tokens (it is the load-bearing opaque-origin barrier for the accepted structured-self-reference residual), with no slug. Confirm the replacement introduces no other rot class (no line number / SHA / round number).

Architect-owned, not your work: `api-contracts/ipfs.md` already documents the served-type allow-list, isolation headers, and the structured-reference known-CID gate — no doc update is outstanding for this task.

## Backend re-review signal (2026-06-05, working tree)

2026-06-05 hold item 1 (anchor-rot) landed: removed the task-slug citation from the CSP-no-allow-tokens test comment in `ipfs-gateway-hardening.test.ts`. The behavioral rationale (the CSP sandbox is the load-bearing opaque-origin barrier for the accepted structured-self-reference residual and must carry no allow-tokens) is preserved; no new rot class (line/SHA/round) introduced. `npm run typecheck` + `npm run lint` clean.
