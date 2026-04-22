# FE-SAVESESSION-API-MISUSE-SWEEP — Sweep remaining `_saveSession(6 args)` call sites

**Owner:** UI Agent
**Priority:** P2
**Created:** 2026-04-21
**Surfaced by:** FE-ORCID-CALLBACK-FIXES archive review (2026-04-21d).

## Context

FE-ORCID-CALLBACK-FIXES (commit `0951fef`) fixed the 6-arg `_saveSession(...)` misuse at `orcid-callback.js:148` and `login.js:152`. The same pattern still exists at three other call sites:

- `signup-verify.js:412`
- `signup-verify.js:457`
- `settings.js:636` — additionally passes `null` as old `expires_at` arg

## Goal

Convert all three call sites to the no-arg `_saveSession()` form, with explicit state resets beforehand where the 6-arg form hard-coded `isAccredited=false`, `accreditation=null`, etc. Match the pattern landed in FE-ORCID-CALLBACK-FIXES re-review (once that task's fixes land).

## Non-goals

Redesigning `_saveSession`'s signature. Centralizing the pre-save state-reset into a helper (fold if/when a fourth user surfaces).

## Deliverable

Move to Review with per-site regression tests asserting the safe-default fields land in localStorage.
