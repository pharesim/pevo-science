# /verify deletes the token on a transport error the node may already have accepted

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Found while grounding `architect-accreditation-mailbox-binding-design`. Triage: user, "as
recommended".

## Why

In `POST /api/accreditation/verify` (`backend/src/routes/accreditation.ts`) `handleBroadcastError`
returns `'timeout'` only for a `BroadcastTimeoutError`; every other throw is `'failure'`, answers
502 `BROADCAST_FAILED` and deletes the token. dhive's `send` retries a broadcast only on
pre-connection errors (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `EAI_AGAIN`); a socket error
after the POST body was sent (`ECONNRESET`, `EPIPE`), an HTTP 429/503 without a JSON-RPC body, or a
`response.json()` failure on a 200 throws a plain `Error` even though the node may have accepted
the transaction. The token is then gone; a fresh `/request` plus `/verify` inside the HAF indexing
lag re-broadcasts a second accredit op, because the per-token idempotency key differs and the
account gate reads HAF. `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome
-2026-04-22.md` names this class for the ORCID path only.

## Scope

1. Classify a throw that is not a node refusal (not a dhive `RPCError` carrying a JSON-RPC error
   body) as ambiguous on `/verify`: keep the token, decrement the attempt counter, answer 504
   `BROADCAST_TIMEOUT` with `outcome: 'uncertain'` as the timer path does, so the SPA's retry path
   re-reads HAF before any new broadcast.
2. The same classification for the other callers of `handleBroadcastError` that delete a single-use
   credential on `'failure'` (signup finalize, ORCID callback); list each in the signal block with
   its before and after behaviour.
3. A test with a post-send socket error fixture (`ECONNRESET` after the request was written) on
   `/verify`.
4. `backend-mailbox-binding-registry` keeps its claim row on this class already; align the two.
5. Comments follow root `CLAUDE.md` "Comment anchors".

## Acceptance criteria

1. A simulated `ECONNRESET` from the broadcast leaves the token and answers 504 with
   `outcome: 'uncertain'`; a node refusal (`RPCError`) still answers 502 and deletes it.
2. Existing timeout and refusal specs stay green; real HAF in tests; no emdash in response text.

## [TODO Architect] at archive

- `api-contracts/accreditation.md`: the `BROADCAST_FAILED` versus `BROADCAST_TIMEOUT` split;
  `chain-write-timeout-ambiguous-outcome-2026-04-22.md` refreshed for `/verify`.
