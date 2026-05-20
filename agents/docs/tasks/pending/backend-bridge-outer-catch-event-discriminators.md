# BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — refine outer-catch event tagging in bridge.ts to distinguish failure classes

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive")
**Priority:** P3

## Problem

`backend/src/routes/bridge.ts` outer-catch blocks on the `/register` and (formerly) `/update` handlers emit `logger.error` with a single event tag covering multiple failure classes (broadcast errors, HAF cascade throws, key-fetch throws, JSON-metadata construction errors, post-broadcast write throws). The single tag conflates failure modes that have different operational meanings:

- Broadcast timeout vs. broadcast rejection vs. pre-broadcast SYNC throw (admin key malformed) vs. post-broadcast cascade throw
- HAF unavailable on the duplicate-check path (round-2 fail-closed 503) vs. unrecoverable HAF query error on the version-counter path
- Lock-held conflict (409 LOCK_HELD) vs. duplicate-permlink conflict (409 DUPLICATE)

The round-2 work (commit `8f81492`) introduced `BridgeCheckResult` discriminated union for one failure class but the outer-catch still folds the remainder into one event tag. Pre-existing pattern that task #3's custody change made visible during the round-2 `/ce-code-review` pass.

## Goal

Refine the outer-catch event taxonomy in `bridge.ts` so SOC dashboards can distinguish failure classes by structured-field discriminator. Mirror the orcid.ts outer-catch pattern (separate event tags for broadcast vs. cache vs. cascade throw classes).

## Acceptance

1. **Inventory the failure classes** the outer-catch currently swallows. Walk through each throw site reachable in `/register` (and any remaining bridge handlers) and assign a structured event tag.
2. **Update the outer-catch** to emit distinct `event:` values per failure class. Operator dashboards keying on `event` get one signal per class.
3. **Cross-reference orcid.ts** for the established event-tag taxonomy on the equivalent flow (`bridge.ts` and `orcid.ts` share the chain-write-broadcast-with-lock pattern).
4. **No behavioral changes** beyond log structure. Same HTTP responses, same broadcasts.

## Out of scope

- Rewriting the outer-catch's actual handling (which 4xx/5xx envelope it emits) — that's covered by `handleBroadcastError` + the existing `sendError` flow.
- Adding new failure classes. This task documents and tags what already exists.

## Cross-references

- `backend/src/routes/orcid.ts` — equivalent outer-catch event taxonomy that this task aligns to.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11) — original architect-zone followup prescription.
