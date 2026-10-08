# The signature replay cache keys on the header text, so a re-encoded signature replays

**Owner:** backend
**Created:** 2026-10-08
**Priority:** high

Filed at the architect review of `ui-state-d-session-settings-critical-actions`, from a security
reviewer's pre-existing residual, confirmed against dhive. User triage: "as recommended".

## Why

`verifyHiveSignature` parses `X-Hive-Signature` with dhive's `Signature.fromString`, which
decodes it with `Buffer.from(string, 'hex')`. Node's hex decoding ignores letter case and stops
at the first character that is not a hex digit, so an upper-cased copy of a signature, or one
with junk appended, decodes to the same bytes. `isReplaySignature` claims the raw header string
(the Redis key `${config.appTag}:replay:${signature}`, and the in-memory fallback). A captured
signed request can therefore be replayed within its 60 s window under a re-encoded header. Each
replay repeats the same method, path and body.

## Scope

1. Make a re-encoded copy of a used signature count as used, in both the Redis and the in-memory
   paths: either claim the replay key on the decoded signature rather than the header text, or
   refuse a header whose text is not the canonical encoding of what it decodes to. Say which in
   your signal.
2. Check whether two different signatures can both verify for the same message through dhive's
   `recover` (ECDSA `s` malleability). If they can, cover that too, or say in your signal why it
   need not be.
3. Tests: an upper-cased copy and a junk-suffixed copy of a used signature are refused as
   replays; the first use still passes.

## Acceptance criteria

1. Within the window, every re-encoding of a used signature is refused with the replay answer.
2. Backend suite green apart from the standing pre-existing failures.
