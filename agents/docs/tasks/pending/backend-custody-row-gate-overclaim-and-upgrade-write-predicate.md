# The custody row-claim gate: three sentences overclaim, and /upgrade's write is not predicated

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect review of the custody routes' row-claim gate (commit c18d37cf),
approved by the user on 2026-10-05. Both items were residual risks in that review, below its
finding threshold; the gate itself is archived.

## Why

1. **Three sentences overclaim on one `/broadcast` path.** They say every route that acts on a
   light claim re-reads the row and refuses it unless `custodyClaimFor` derives `'light'`:
   - `backend/src/lib/custody-claim.ts`, the `custodyClaimFor` docblock: "Every route that ACTS
     on a light claim (...) re-reads the row itself and refuses it unless this helper derives
     `'light'` from that read."
   - the closing paragraph of the same docblock: "each of those re-reads the row the copy names
     and refuses it unless the claim derived here from that read is `'light'`."
   - `backend/src/routes/orcid.ts`, `handleLogin`: "every route that ACTS on a light claim
     re-reads the row and refuses it unless `custodyClaimFor` derives `'light'` from that read."

   `POST /api/custody/broadcast` answers an idempotency hit (`lookupCustodyBroadcastIdempotency`
   finds an op that already landed for the username and key) with 200, `outcome:
   'already_landed'` and the existing `tx_id`, before its only `accounts` read. On that path it
   neither re-reads the row nor refuses it. It signs nothing there and writes no `accounts` row,
   but it has already consumed or slid the fresh-auth proof in Redis, so a sentence that says
   the re-read precedes every write is false too.

2. **`/upgrade` gates on a snapshot.** The handler reads the row (`SELECT custody, upgraded_at`),
   refuses a row whose derived claim is not light, awaits the live `getAccounts` key-set lookup,
   and then runs `UPDATE accounts SET ... custody = 'self', upgraded_at = NOW() ... WHERE
   username = $1`. The UPDATE carries no state predicate and its row count is not checked. If
   the light row is deleted and a G row of the same username inserted during that await, the
   UPDATE moves the G row to D, a transition § 6.3 does not list (§ 6.5 invariant #4). Only the
   holder of the account's on-chain keys can reach this, by racing their own account deletion
   and Keychain re-add against their own upgrade request, and it gains them nothing.

## Scope

1. Narrow the three sentences (root CLAUDE.md, narrow-or-delete) to what the code does: each of
   these routes re-reads the row before it signs, mints a proof or opens a session window, or
   writes the `accounts` row, and refuses it there unless `custodyClaimFor` derives `'light'`
   from that read. Do not add an exception list for the idempotency path. Do not move the
   `/broadcast` row read ahead of the idempotency lookup: a D row presenting a light JWT and a
   key that already landed gets 200 `already_landed` today and would get the upgraded-account 403
   instead.
2. In `/upgrade`, add `AND custody = 'light' AND upgraded_at IS NULL` to the UPDATE's `WHERE`.
   When it matches no row, answer with the route's existing non-light 403 (the `refuseNonLight`
   closure), and run none of the steps after the UPDATE (the session-proof sweep, the audit log
   entry, the token reissue). Update the handler comment that says the UPDATE matches on the
   username alone.
3. Tests: a spec where the UPDATE matches no row gets the 403, and the post-UPDATE steps do not
   run. A real-path interleave is impractical here (the race window is inside the live-chain
   lookup), so a targeted mock under the root CLAUDE.md carve-out is acceptable, with its header
   justification and a clause (c) companion. The existing `/upgrade` light-row, D-row and
   G-row cases keep passing unchanged.

## Acceptance criteria

1. The three sentences claim only the ordering in Scope 1 and are true against the code,
   including on the `/broadcast` idempotency-hit path.
2. An `/upgrade` whose UPDATE matches no row answers the non-light 403, writes nothing, sweeps no
   session proof and reissues no token.
3. A/B/C and D answers on all four routes are unchanged (same statuses, codes and messages).
4. Comment-anchor conventions hold (root CLAUDE.md "Comment anchors").
