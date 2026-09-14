# The ORCID callback's session-window leg caches a proof it never type-checks

**Owner:** ui
**Created:** 2026-09-14

Routed out of the round-4 re-review of the shared-dispatch task (an adversarial
residual, confirmed at HEAD by the architect). Low priority: pre-existing,
reachable only through a backend contract violation, and nothing is
misclassified. Filed for consistency with the mint-leg null coercion that round
closed, so the window slot's two writers hold the same standard.

## Why

The window slot has two writers. `acquireSessionProof`'s mint callback
(`lib/fresh-auth.js`) now narrows a non-string `fresh_auth_proof` to `undefined`
so the fail-closed guard refuses it, says so, and the acquisition-level drop
evicts the entry it wrote. The other writer is `_handleSessionAuth` in
`pages/orcid-callback.js`: it calls
`cacheSessionProof(data.fresh_auth_proof, data.expires_at, data.absolute_expires_at)`
with the response value unexamined, toasts `orcid.reauthSuccess`, and navigates
to the return path. Its sibling in the same component, `_handleFreshAuth`
(the consent-op leg), refuses a non-string or empty `fresh_auth_proof` BEFORE it
caches, by setting the page's error state and returning; the session-window leg
has no such check.

What a malformed response does on that leg depends on its shape, and neither
outcome is one the user is told about. A `null` (or absent) proof writes a
tokenless entry that `readSessionWindow` drops on the next read, so the next
gate on a passwordless account starts cold and begins another ORCID round-trip:
a success-toasted redirect loop with no refusal anywhere. A truthy non-string (a
number, an object) survives the JSON round-trip through `sessionStorage`, and the
next gate's fail-closed guard refuses, toasts and evicts it, after which that
gate also starts cold. Neither is a lockout; both are a re-auth act the user is
told succeeded and is then charged again.

## Scope

1. In `_handleSessionAuth`, mirror the consent-op leg's guard: when
   `typeof data.fresh_auth_proof !== 'string' || !data.fresh_auth_proof`, set
   `this.status = 'error'` and `this.errorMessage` to the same
   `orcid.verificationFailed` copy the sibling uses, and return before
   `cacheSessionProof`, the return-path clear, the success toast and the
   navigation. The deadlines need no check here: `cacheSessionProof` already
   fails closed on a non-finite deadline by dropping the slot.
2. Pin it through the page component with one case per shape the wire can
   produce (`null`, a number): nothing cached, no success toast, the error state
   shown, no navigation. Model the cases on whatever spec already drives
   `_handleFreshAuth`'s guard; if none does, that is a pre-existing gap to note
   in the signal block, not to close here.
3. No change to `cacheSessionProof`: its contract is to write what it is handed
   (the readers own the corruption checks and the writers own the wire), and
   the mint-leg coercion deliberately kept the raw write for the same reason.

## Acceptance criteria

1. A session-auth callback response whose `fresh_auth_proof` is not a non-empty
   string caches nothing, shows no success toast, does not navigate, and lands
   the page in the same error state a malformed consent-op response does.
2. The string-proof path is unchanged; its existing specs pass unmodified.
3. Suite green; deleting the new guard reddens exactly the new specs and
   nothing else (measured in a private copy, not this checkout).

## Notes

Comment text must stay free of line numbers, SHAs, task slugs and bare
positional anchors. The one docblock sentence that names the mint callback as
"the only coercion the wire needs" (in `ensureSessionWindow`'s fail-closed
guard) is scoped to the sentinel space and stays true after this lands, since
this writer never returns into the vocabulary; do not edit it for this task.
