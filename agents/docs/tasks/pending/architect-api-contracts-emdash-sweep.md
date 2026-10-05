# Remove the emdashes from the API contract docs

**Owner:** architect
**Created:** 2026-10-05
**Priority:** low

Filed from the accreditation and Web of Trust audit (finding 10).

## Why

Root `CLAUDE.md` forbids emdashes in the integrator-facing `agents/docs/api-contracts/*.md`.
`accreditation.md` was cleaned during the audit. A grep at filing counts 224 lines with an emdash
in the other files of that directory:

| File | Lines |
|---|---|
| `papers.md` | 59 |
| `auth.md` | 31 |
| `profiles.md` | 23 |
| `custody.md` | 22 |
| `settings.md` | 20 |
| `bridge.md` | 19 |
| `common.md` | 16 |
| `ipfs.md` | 16 |
| `orcid.md` | 10 |
| `misc.md` | 5 |
| `reviews.md` | 3 |

`me.md` and `notifications.md` have none. The index `agents/docs/api-contract.md` has 9; the rule
names the `api-contracts/` directory, so the index is optional here.

## Scope

Replace each emdash with a period, a comma, a colon or parentheses, or restructure the sentence.
In error lists use `` `CODE`: text ``. Change punctuation only: a sentence that turns out to be
wrong about the code goes in a note for its own task, not into this sweep.

## Done when

`grep -c "—" agents/docs/api-contracts/*.md` prints 0 for every file.
