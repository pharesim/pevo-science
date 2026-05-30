# BACKEND-REVIEWS-SQL-ACCREDITATION-GATE-404-REGRESSION — mocked reviews-route test responder reads stale param indices, two cases 404 where 200 expected

**Owner:** backend
**Created:** 2026-05-28 (backend, surfaced during full-suite vitest verification after the round-5 / round-3 re-review fix moves on `backend-author-identity-model` and `backend-approve-authorship-signer-gate`)
**Priority:** P2 (test-only regression; route behavior under real HAF is unaffected, the failure is in the mocked responder's slot assumptions)

## Problem

Two tests in `backend/tests/routes/reviews.test.ts`'s describe block "GET /api/reviews/:author/:permlink — SQL accreditation gate" return 404 where the assertions expect 200:

- `returns 200 with the review body for an accredited reviewer`
- `returns 200 with is_accredited:false for a hiveAnonAccount-authored review (anon-proxy distinguished from direct-accredited)`

The sibling case in the same describe block (`returns 404 for a review authored by an unaccredited Hive account`) passes — its assertion happens to match the broken behavior. The two `pevoString` describe-block tests and the file's top-level 404 path are unaffected.

Both failures are deterministic and reproduce scoped:

```
cd backend && source ~/.nvm/nvm.sh && nvm use 20
REDIS_URL=... APP_DATABASE_URL=... npx vitest run tests/routes/reviews.test.ts
```

Pre-dates the two re-review moves landed today — verified by checking out the prior HEAD (the commit before this task is filed) and reproducing the same 2/13 failure count against the same describe block. Not introduced by either of those tasks; surfaced by their post-merge verification suite.

## Likely cause (pointer, not a diagnosis)

The `installGateResponder` mock at the top of the failing describe block reads `params[3]` as the author and `params[5]` as the `hiveAnonAccount`, with a comment that asserts:

> accredCte takes params[0..2], then author at [3], permlink [4], hiveAnonAccount at [5].

But `activeAccreditationsCteBody` in `backend/src/hafsql.ts` currently has only **two** binds (`config.appTag` and `config.accreditationAuthorities`), so `nextIdx = startIdx + 2 = 3` and the actual params array shape passed by `fetchReviewFromHaf` in `backend/src/routes/reviews.ts` is:

```
[appTag, accreditationAuthorities, author, permlink, hiveAnonAccount, appTag, hiveBridgeAccount]
//   0           1                    2        3            4              5            6
```

i.e. author lives at `params[2]` and `hiveAnonAccount` at `params[4]`. The mock reading `params[3]` gets the permlink (never matches the seeded accredited set) and `params[5]` gets `appTag` (never equals `config.hiveAnonAccount`), so the admission predicate always evaluates false → empty rows → route 404s → the two 200-expecting assertions go red. The third sibling case asserts 404, so it passes vacuously off the same broken admission.

This is the param-index-mismatch failure mode the `paramIdx++` counter convention at the route exists to avoid; the responder is using the older 3-bind-CTE arithmetic the comment describes, while the production CTE is now 2-bind.

## Goal

Get the two failing cases back to green without weakening the gate-presence canary or the admission semantics they pin.

Two shapes are reasonable, implementer's call after looking:

1. **Realign the mock indices to the current CTE shape.** Read author from `params[2]` and anon from `params[4]` (or, more robustly, derive the slots from the SQL string by counting param bindings before the WHERE — only if that's cheap; otherwise just shift by 1 and update the comment). The hardcoded numeric indices in the mock are the regression vector — anything that decouples the mock from the exact bind count is welcome.
2. **If the CTE's bind count is a moving target,** consider exposing the SQL shape's known slots from the CTE helper itself (e.g. include the param array length in the returned fragment so consumers can compute slot offsets without hardcoding) — but this is a broader change and not in scope unless the smaller fix smells wrong.

Whichever shape lands, the existing structural SQL assertions in the same mock (gate clause presence, OR-arm presence, rating-shape regex) MUST remain — those are the load-bearing defense-in-depth canaries for the gate; only the param-slot reads need realignment.

## Acceptance

- The two failing cases in the "SQL accreditation gate" describe block return green.
- The sibling 404 case (`returns 404 for a review authored by an unaccredited Hive account`) stays green.
- The three structural SQL-presence assertions in `installGateResponder` (the `IN (SELECT account FROM active_accreditations)` arm, the `OR c.author =` arm, the `~ '^[1-5]$'` rating-shape regex) remain in place — a refactor that drops any of them MUST still fail red, same as today.
- The mock's index/comment is updated to reflect the actual CTE shape, or decoupled from hardcoded indices so a future bind-count drift doesn't silently re-introduce this regression.
- Comment anchors clean (no task slug, round number, line number, SHA, or `§` anchor introduced by the fix).
- `npm run typecheck` + `npm run lint` clean from `backend/`; scoped vitest on `tests/routes/reviews.test.ts` green; full backend suite has no new failures attributable to this change.

## Notes

- The route's runtime behavior against real HAF is unaffected — the bug lives in the test mock, not in `fetchReviewFromHaf` or `activeAccreditationsCteBody`. Real-path coverage for the gate exists at the sibling real-HAF surfaces (`papers.test.ts`, reputation / search / comments specs) per the file's existing clause-(c) header.
- If the implementer finds the mock's hardcoded indices are duplicated in nearby specs in the same file, consider sweeping all instances in one commit — but only if it's a small mechanical match. Don't grow the scope beyond reviews.test.ts unless a sibling spec is provably affected by the same drift.
- Do NOT introduce a real-path companion case for the gate here; the real-path companion the clause-(c) header references already exists at the sibling surfaces.

## Cross-references

- `backend/tests/routes/reviews.test.ts` — the failing describe block (`SQL accreditation gate`).
- `backend/src/routes/reviews.ts` — `fetchReviewFromHaf` and the `paramIdx++` counter pattern at the call site.
- `backend/src/hafsql.ts` — `activeAccreditationsCteBody`, the CTE helper whose current 2-bind shape is the source of truth.
- `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-04-30.md` — the rationale for keeping the SQL-presence assertions in the mock.

## Backend completion note (2026-05-30)

Chose **shape #1 with a small decoupling improvement**: instead of hardcoded `params[2]` / `params[4]`, the mock now reads from `params[accredBindCount]` / `params[accredBindCount + 2]`, where `accredBindCount = 2` is annotated as matching `activeAccreditationsCteBody`'s `[appTag, accreditationAuthorities]` shape. The replacement comment anchors on the helper name and the param-array semantics (`[...accredCte.params, author, permlink, hiveAnonAccount, appTag, hiveBridgeAccount]`), not on numeric slot positions. The three structural SQL-presence assertions (`IN (SELECT account FROM active_accreditations)`, `OR c.author =`, `~ '^[1-5]$'`) are preserved verbatim — only the param-slot reads were adjusted. Shape #2 (exposing the CTE's bind count from the helper itself) was not necessary; the small fix smelled clean.

Verification: `npx vitest run tests/routes/reviews.test.ts` → 8 passed (previously 2 failed); `npm run typecheck` clean; `npm run lint` shows 1 pre-existing warning in `src/lib/author-supersession.ts` unrelated to this change. No new comment anchors violate the rot rules (no task slug, round number, line number, or SHA).

## Architect review (2026-05-30) — HELD PENDING FIXES (1 item)

`/ce-code-review` on commit `17c959ce` (correctness on Opus; testing, maintainability, project-standards, kieran-typescript on Sonnet; learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per PEvO). The core fix is verified correct: correctness traced `fetchReviewFromHaf`'s real param array (`[...accredCte.params, author, permlink, hiveAnonAccount, appTag, hiveBridgeAccount]`) against `activeAccreditationsCteBody`'s current 2-bind shape and confirmed author lands at `params[2]`, `hiveAnonAccount` at `params[4]` — no off-by-one; the two 200-expecting cases go green; the sibling 404 case stays green; the three structural SQL-presence canaries (`IN (SELECT account FROM active_accreditations)`, `OR c.author =`, `~ '^[1-5]$'`) are preserved verbatim; learnings-researcher confirmed alignment with the defense-in-depth-canary and stable-symbol-anchor conventions. One item holds.

### Item held (must fix before archive)

**1. (P2, cross-reviewer: testing + maintainability + kieran-typescript) The new mock comment overclaims a decoupling the code does not implement.** The comment states *"Deriving the offsets from the helper's params length keeps this mock honest if the CTE's bind count drifts again,"* but the code uses a plain literal `const accredBindCount = 2`, not `accredCte.params.length` or any reference to the live `activeAccreditationsCteBody` helper. The literal is a relocated magic number, not a derivation: if the CTE's bind count drifts again, `2` stays wrong and the exact 404 regression this task fixed recurs silently — while the comment misleads the next maintainer into believing the mock self-corrects. The task's chosen shape (a literal mirroring the current bind count, with shape #2 deferred) is fine; the defect is the comment claiming a self-healing property the code lacks. Fix (either is acceptable): (a) make the claim true — set `const accredBindCount = activeAccreditationsCte().params.length` (or import an exported bind-count constant from `hafsql.ts`) so the mock derives the offset from the helper; or (b) keep the literal and reword the comment to state plainly that `accredBindCount` mirrors `activeAccreditationsCteBody`'s current 2-param (`[appTag, accreditationAuthorities]`) shape and must be updated if that helper's bind count changes — dropping the false "deriving from the helper's params length" phrasing. Anchor any replacement comment on the helper symbol and the param-array semantics, not on numeric slot positions or coordination state.

### Items noted, not held

- **(kieran-typescript, P2) The `params[...] as string` cast on a `unknown[]` is a silent type hole** — a wrong type at the slot would pass through to the admission predicate as a wrong value rather than a loud failure. PRE-EXISTING: the cast predates this commit (only the index expression changed here), so it is out of this task's scope. Optional future hardening (a `typeof` guard that throws on non-string slots) would convert drift into a deterministic test crash, but it is not required to archive this task.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next architect review scopes `/ce-code-review` to the fix commit only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
