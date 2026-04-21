# BE-DISCIPLINE-LENGTH-CAP — Bound `?discipline=` input length before SQL LOWER()

**Owner:** backend
**Created:** 2026-04-21 (surfaced by BE-DISCIPLINE-CANONICALIZE security review 2026-04-21)
**Priority:** P3

## Context

BE-DISCIPLINE-CANONICALIZE (commit `d6c2bb1`) added `LOWER()` wrapping to both sides of the `?discipline=` filter in `backend/src/routes/search.ts:67-68` (and the sibling sites fixed in the hold-block: `papers.ts:226`, `stats.ts:59`). The value is properly pg-parameterized (`$N` placeholder), so SQL injection is not a concern.

What is a concern: there is no length or character-set guard on `?discipline=` before `discipline.toLowerCase()` and the pg bind. A request with a 1 MB Unicode string in `?discipline=` causes V8 to run `String.prototype.toLowerCase()` on the full blob, then PostgreSQL to run locale-aware `LOWER()` on the same value (once per candidate row in the search loop, not once total — the WHERE clause applies LOWER() on every row the outer predicate admits, though Postgres may short-circuit if the LOWER(...) does not equal the bound $N). Per-request CPU cost scales linearly with input size; distributed enumeration can tie up backend workers without ever hitting the `callbackLimiter` (60 req/min/IP).

`backend/src/types/disciplines.ts` exports a `DISCIPLINE_TAXONOMY` — an allowlist that would close this entirely. Alternatively a simple length cap (e.g. ≤100 chars — the longest taxonomy value is "Languages and Literature" at 23 chars) plus an ASCII-safe charset guard handles the DoS concern without binding the API to a static taxonomy.

## Goal

Add an input validation guard at the entry of each route that accepts `?discipline=`:
- `backend/src/routes/search.ts`
- `backend/src/routes/papers.ts`
- `backend/src/routes/disciplines.ts` (no `?discipline=`, but `/:discipline` path segment if any)

Emit `400 BAD_REQUEST` with a clear message when the guard fails. Constants kept as module-private or exported from `types/disciplines.ts`.

**Shape options (pick one):**
1. **Length cap only** — `if (discipline.length > 100) return sendError(res, 400, 'BAD_REQUEST', 'Discipline filter too long')`. Simple; leaves garbage values to fall through to a 0-hit response (current behavior).
2. **Length + charset guard** — same + `^[\p{L}\p{N} \-]+$` (Unicode letters/numbers/space/hyphen). Tighter, matches expected real-world discipline names.
3. **Allowlist via `DISCIPLINE_TAXONOMY`** — `if (!DISCIPLINE_TAXONOMY.includes(discipline.toLowerCase())) return sendError(res, 400, 'BAD_REQUEST', 'Unknown discipline')`. Tightest but binds the API to the taxonomy. Risk: users who tag papers with a discipline not yet in the taxonomy can never filter by it until the list is updated.

Recommendation: **option 2** (length + charset). Rejects clearly-malicious input without forcing a taxonomy lockstep.

## Non-goals

Adding `?discipline=` length caps to HAF SQL layer (not PEvO-owned). Normalizing Unicode forms (NFC/NFD) — separate concern.

## [TODO Architect]

1. Pick a shape (1/2/3 above) before implementer starts.
2. Decide whether to add a regression test that the malicious input yields 400, or let the API-contract reviewer flag it as residual gap.
