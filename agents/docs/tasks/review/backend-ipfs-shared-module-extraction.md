# BACKEND-IPFS-SHARED-MODULE-EXTRACTION — de-duplicate unpin helpers + the image-SRF guard fragment

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the IPFS review cluster — commits `ff708ab3` pin-durability + `3d60e9ad` srf-guard)
**Priority:** P3 (maintainability — no behavior change)

## Context

The IPFS review cluster surfaced two duplications across the same two files (`backend/src/routes/ipfs.ts` ↔ `backend/src/ipfs-cleanup.ts`), each flagged by the maintainability persona:

1. **`unpinFromKubo` is duplicated.** `routes/ipfs.ts` (added by the pin-durability task) and `ipfs-cleanup.ts` (pre-existing) carry byte-identical Kubo unpin helpers — same URL pattern, same 15s timeout, same "not pinned" benign-error tolerance. They will drift under independent edits.
2. **The image-SRF CASE-WHEN guard fragment is duplicated 3-4×.** The `CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array' THEN c.json_metadata->'image' ELSE '[]'::jsonb END` expression appears in `cidIsKnown` (`routes/ipfs.ts`), `cidReferencedInHaf` (`ipfs-cleanup.ts`), and twice in the SRF test (`guardedSrfShape` + the inline top-level-NULL case). Three-plus copies that must stay in sync by hand.

Neither is a defect — the code works — but both are sync-burden debt across the same module pair, which is why they share a natural home.

## Goal

Create a small shared module (e.g. `backend/src/lib/ipfs-shared.ts`) that earns its existence from both symbols:

1. Export `unpinFromKubo` (and, if it lands via the pin-durability hold, `unpinFromPinata` / `unpinFromIpfs`); import from both `routes/ipfs.ts` and `ipfs-cleanup.ts`.
2. Export an `IMAGE_SRF_GUARD_EXPR` string constant for the CASE-WHEN guard expression; interpolate it at both query sites and import it into the SRF test so the test fragment is definitionally in sync with production.

Do NOT extract the full queries — the surrounding query structure differs between the two call sites (different fallback/cache paths). Extract only the unpin helper(s) and the guard expression.

## Dependencies / ordering

- The pin-durability hold-block may add `unpinFromPinata` and a benign-absence tolerance; coordinate so this extraction picks up the final helper shapes rather than racing them. Land this AFTER the pin-durability and srf-guard holds clear, so the extracted symbols are stable.
- If the srf-guard task adds the source-level guard-presence canary first, update that canary to assert against the shared constant after extraction (the canary must still pin the live call sites, not just the constant).

## Acceptance

- One shared module imported by `routes/ipfs.ts` and `ipfs-cleanup.ts`; no duplicated `unpinFromKubo` body remains.
- `IMAGE_SRF_GUARD_EXPR` is the single source for the CASE-WHEN guard at both query sites and in the SRF test.
- No behavior change; existing IPFS tests (pin-durability, srf-guard, cleanup) stay green.
- `typecheck:src` + lint clean.

## Non-goals

- Reworking query structure, the cleanup job's scan, or the gateway cache.
- Migrating `jsonb_array_elements_text` to a different SRF API.

## Backend completion signal (2026-05-26)

New module `backend/src/lib/ipfs-shared.ts` created, exporting `PinBackend`, `IMAGE_SRF_GUARD_EXPR`, `unpinFromKubo`, `unpinFromPinata`, `unpinFromIpfs`. No behavior change.

- **Unpin helpers de-duplicated.** `unpinFromKubo` / `unpinFromPinata` / `unpinFromIpfs` (and the `PinBackend` type) moved out of `routes/ipfs.ts`; `ipfs-cleanup.ts`'s byte-identical `unpinFromKubo` deleted. `routes/ipfs.ts` imports `{ type PinBackend, IMAGE_SRF_GUARD_EXPR, unpinFromIpfs }`; `ipfs-cleanup.ts` imports `{ IMAGE_SRF_GUARD_EXPR, unpinFromKubo }`. `PinResult` stays in `routes/ipfs.ts` (references the imported `PinBackend`); the `pinToKubo`/`pinToPinata`/`pinToIpfs` helpers stay there too (not duplicated, out of scope). The shared `unpinFromKubo` keeps the Kubo benign-absence ("not pinned") tolerance; the shared `unpinFromPinata` keeps the round-3 benign-absence tolerance from the pin-durability hold.
- **Guard expression centralized.** `IMAGE_SRF_GUARD_EXPR` is the single source of the `CASE WHEN jsonb_typeof(c.json_metadata->'image') = 'array' … ELSE '[]'::jsonb END` fragment. Both query sites now interpolate `jsonb_array_elements_text(${IMAGE_SRF_GUARD_EXPR})`; the constant's docblock notes it assumes the comment relation is aliased `c` (both call sites + the test satisfy this).
- **SRF test consumes the constant.** `tests/lib/ipfs-image-srf-guard.test.ts` imports `IMAGE_SRF_GUARD_EXPR` and composes it in `guardedSrfShape` and the top-level-NULL case, so the behavioral fragment is definitionally in sync with production (no more hand-copied shape). The source-level guard-presence canary added by `backend-ipfs-image-srf-guard` is updated per this task's ordering note: it now asserts (1) the constant still carries the CASE-WHEN guard, and (2) each call site (`cidIsKnown` / `cidReferencedInHaf`) interpolates the shared constant at every `jsonb_array_elements_text(` call — so a gutted constant OR an inlined/unguarded SRF argument at either site fails red. The canary still pins the live call sites, not just the constant.

**Verification.** `npm run typecheck` clean (src + tests). `npx eslint` clean on `src/lib/ipfs-shared.ts`, `src/routes/ipfs.ts`, `src/ipfs-cleanup.ts`, `tests/lib/ipfs-image-srf-guard.test.ts`. Scoped `npx vitest run` over the four affected IPFS test files (srf-guard, pin-durability, real-path-verifyhivesignature, ipfs) → 23/23 green (parent's authoritative serial run remains the gate). Self-audit on changed lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in the source/test files.

**Dependency note.** This landed after the `backend-ipfs-pin-inside-db-transaction` and `backend-ipfs-image-srf-guard` holds were addressed (both now in `review/`), so the extracted unpin-helper + guard shapes are the final ones. It is independent of `backend-ipfs-cidisknown-haf-scan-scope` (moved to `blocked/` for an architect re-scope decision); when that task is unblocked, its rewritten `cidIsKnown` / `cidReferencedInHaf` queries should continue to compose `IMAGE_SRF_GUARD_EXPR` for the image branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
