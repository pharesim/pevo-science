# BACKEND-BUILDWITH-ADOPTION-PROFILE-ACCREDITATION — convert remaining manual `WITH ${body.sql}` spellings to buildWith

**Owner:** backend
**Created:** 2026-06-05 (spun off from the activeaccreditations-wrapper-dedup review; pre-existing finding, P3)
**Priority:** P3

## Problem

The wrapper-dedup task removed the third spelling of the single-CTE WITH builder, but two files still hand-roll the template: `backend/src/routes/profile.ts` (three sites) and `backend/src/accreditation.ts` (one site) interpolate `WITH ${body.sql}` manually instead of calling `buildWith(1, body)`. Hand-rolled spellings resist grep-based convention sweeps and can drift from buildWith's params/nextIdx contract.

## Goal

Convert the four manual sites to `buildWith`. Do NOT touch the `WITH RECURSIVE` query in the comments path — `buildWith` does not emit the `RECURSIVE` keyword.

## Acceptance

- The four sites use `buildWith`; emitted SQL, params, and nextIdx are identical to pre-change (same equivalence class as the archived wrapper-dedup conversion: single-builder `buildWith` emits `WITH ${body.sql}` verbatim).
- A grep for manual `WITH ${` template spellings over `backend/src` finds no remaining non-RECURSIVE single-CTE uses.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/hafsql.ts` (`buildWith`), `backend/src/routes/profile.ts`, `backend/src/accreditation.ts`.
- Same dedup class as the archived `BACKEND-ACTIVEACCREDITATIONS-WRAPPER-DEDUP` (see `agents/docs/tasks-archive.md`).
