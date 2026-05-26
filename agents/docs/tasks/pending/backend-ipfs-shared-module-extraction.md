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
