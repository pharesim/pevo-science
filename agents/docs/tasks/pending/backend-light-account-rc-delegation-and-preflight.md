# Light accounts get resource credits at creation, and a broadcast they cannot afford is refused up front

**Owner:** backend
**Created:** 2026-10-01

Implements `agents/docs/ARCHITECTURE.md` § 1 "Light-Account Resource Credits" (decided
2026-10-01). Read it first.

## Why

Measured on 2026-10-01 with read-only RPC calls.

- A comment transaction costs about `717,299,047 + 496,155 × transaction bytes` RC (fitted to
  45 real transactions from 164 B to 44.6 KB; the live `rc_api` parameters give the same slope).
  `json_metadata` is billed like the body.
- The five light accounts created by `pevo.onboarding` (the onboarding account the deployment
  very likely uses; the local `.env` leaves `HIVE_ONBOARD_ACCOUNT` empty) have `max_rc` of 4.83e9
  to 4.89e9, no Hive Power and no delegation. `createClaimedAccount` in
  `backend/src/account-creation.ts` broadcasts a single `create_claimed_account` op, and nothing
  in `backend/src` delegates RC or HP. None of the five has posted yet.
- So an undelegated light account can broadcast at most about an 8.3 KB transaction, about a
  7 KB paper body with PEvO's metadata, while `publish.js` allows 60 KB (`TX_HARD_BYTES`). A
  larger publish is refused by the node with `not_enough_rc`, which the custody route reports as
  the generic 502 and the composer as "Publishing failed". Waiting does not help: the cost is
  above the full bar. This becomes reachable as soon as light-account publishing works (the
  custody `comment_options` fix in review).
- RC an account received by delegation cannot be delegated on (`rc_utility.cpp`, the delegate
  path takes `get_maximum_rc( true )` of the delegator's own vesting). `pevo.onboarding` holds
  about 4.2e15 received RC but only about 8.15e9 of its own.
- The anonymous-review proxy (`config.hiveAnonAccount`, `pevo.anon` by default) authors every
  anonymous review and has the same ceiling: roughly one 1.5 KB review per day and a half.

## Scope

1. **Delegation at creation.** After `createClaimedAccount` succeeds, delegate RC to the new
   account from a configured delegator (new config: the delegator account, its posting key, and
   the amount per account; document them in `.env.example`, which the architect commits). Use
   Hive's `delegate_rc` (`custom_json` id `rc`, posting authority of the delegator). The
   delegator is a dedicated account: do not fall back to the admin, onboarding, anonymous-review
   or bridge account the way other platform-account settings in `backend/src/config.ts` do. When
   it is unset, delegation is off and the backend logs that once at startup. Only its posting key
   is configured. A failed delegation must not fail the signup: log it and leave the account to
   the Scope 2 backfill, which is the retry path (the operator reruns it). Suggested default
   amount: 50e9 RC, which covers a maximum-size publish (about 31.7e9) with room for edits, and
   costs the delegator about 50,000 VESTS of its own per account. Native edits of a body that
   contains a character outside the Basic Multilingual Plane are full-body sends (§ 8), up to
   about 31.5e9 RC each, so the amount also bounds how often such a paper can be edited. The
   operator sets the real value.
2. **Backfill.** A one-off, operator-run command that delegates to existing light accounts that
   have no delegation from the delegator yet. Idempotent.
3. **Deleted accounts.** When a light account is deleted, remove its delegation (`max_rc: 0`).
   An upgrade to self-custody keeps it.
4. **Pre-flight.** In `POST /api/custody/broadcast` and the anonymous-review broadcast, before
   signing: estimate the transaction's RC cost from its serialized size (keep the formula's
   parameters in one place, read from `rc_api.get_resource_params` or configured, and say which)
   and read the signing account's current mana with `rc_api.find_rc_accounts`. When it falls
   short, refuse with a new error code (suggested `INSUFFICIENT_RC`, 422) whose details carry the
   needed and available RC and whether the cost exceeds the account's maximum (in which case
   waiting cannot help). A failed RC read proceeds to the broadcast (the node is the backstop).
5. **The node's own RC refusal** (`not_enough_rc_exception` in the broadcast error) maps to the
   same code instead of the generic 502. Nothing was broadcast in either case.

## Out of scope

- Funding the delegator, and delegating to the platform accounts (`pevo.anon`, `pevo.admin`,
  `pevo.bridge`): operator actions. Say in the signal block what the operator must do before
  deploy.
- The ui message for the new code (a separate ui task waits on this one).
- The architect updates `api-contracts/custody.md`, the Data Source Policy table and the root
  `CLAUDE.md` "Account Creation" paragraph at review, from the signal block.

## Acceptance criteria

1. A new light account receives the configured delegation; a delegation failure does not fail
   the signup.
2. The backfill delegates once per account and is a no-op on a second run.
3. Account deletion removes the delegation.
4. A broadcast whose estimated cost exceeds the account's mana is refused before signing with the
   new code and the documented details, on both routes; one within budget proceeds.
5. A node `not_enough_rc` refusal maps to the same code.
6. Specs per behaviour, each probed by reverting its own site. Mocking the Hive client for the
   RC reads and the broadcast is acceptable under the CLAUDE.md carve-out (no live chain tests);
   state it in the test headers.
7. In the signal block: the final error shape, the config keys, and the operator steps.
