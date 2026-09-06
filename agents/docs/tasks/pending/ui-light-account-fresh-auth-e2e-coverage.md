# Drive a light-account fresh-auth broadcast and upload end to end in the e2e suite

**Owner:** ui
**Created:** 2026-09-06

Routed out of the architect round-4 review of `ui-consent-op-teardown-guard`. Filed to
give the fresh-auth unit suites a clause-c real-path companion that actually exists: three
of them currently cite one that does not cover what they claim.

## Why

Root `CLAUDE.md`'s "Carve-out for deterministic edge-case coverage" permits mocking only
when, among other things, clause (c) holds: the same risk class is covered by a real-path
test elsewhere, OR a follow-up task is filed to add such coverage. Four unit suites
discharge that clause by citing `frontend/tests/e2e/non-consent-fresh-auth.spec.js`:

- `lib-ipfs-upload.test.js` — "exercises upload + broadcast against the real backend"
- `fresh-auth-401-retry.test.js` — "exercises broadcastWithFreshAuth against the real
  backend for the happy path and the window-reuse path"
- `lib-fresh-auth-session-window.test.js` — "exercises acquisition + broadcast against the
  real backend"
- `lib-fresh-auth-outcome-dispatch.test.js` — "exercises acquisition against the real
  backend"

That spec contains exactly one test. It route-stubs `/api/orcid/callback` and asserts the
`session_auth` handler caches the issued window in sessionStorage. It drives no broadcast
and no upload. Its own closing note records the second test — a real vote through the
paper-detail page — as prototyped and removed, because the production bundle does not
expose `lib/fresh-auth.js` for dynamic import and the paper-detail mount needs more
fixture surface (full enrichment shape, paper-card data, accreditation polling stubs) than
a wire-contract assertion was judged to be worth. That note closes by naming the follow-up
this task is: drive the comment-composer path with full fixture data.

So the acquisition half of those citations is defensible and the broadcast and upload
halves are not. The risk classes left with no real-path companion are the ones the mocked
suites exist to cover: a window proof actually reaching `/api/custody/broadcast`, and a
window rejected between the IPFS pre-flight and the transfer.

There is no mechanical backstop. `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
resolves citations under `backend/tests/` only, so a frontend suite can cite a spec that
does not cover it indefinitely without any check failing.

## Scope

1. Add e2e coverage that drives a light account through a fresh-auth broadcast with a
   proof attached, against the real backend. The comment-composer path is the shape the
   removed prototype's note recommends: it needs less fixture surface than paper-detail,
   and a comment is a real `custody/broadcast` with a session-window proof.
2. Add e2e coverage for the upload leg on the light-account path, where a window proof IS
   involved (`publish.spec.js` drives the upload endpoint only on self-custody, where none
   is). The window-rejected-mid-flight retry does not need to be reproduced; exercising the
   integrated path with real infrastructure is what clause (c) asks for, not mirroring the
   mocked assertion.
3. Point the four unit-suite headers at whatever this task actually lands, and drop the
   claims it does not support. Coordinate with the header corrections held on
   `ui-consent-op-teardown-guard`, which cites this task in the interim.

If either leg proves impractical for the same reason the earlier prototype was removed,
record that finding in this file and say plainly in the headers that no real-path
companion exists for that risk class. A stated gap is honest; a false citation is not.

## Acceptance criteria

1. At least one e2e spec drives a light-account operation that attaches a session-window
   fresh-auth proof to a real backend request, and asserts the request carried it.
2. At least one e2e spec drives the light-account upload leg against the real upload
   endpoint with a window proof.
3. The clause-c paragraph in each of the four suites named above resolves to a spec that
   genuinely exercises the risk class that suite mocks, or states the gap explicitly.
4. No suite's clause-c paragraph names a spec that does not cover it.

## Notes

Clause (c) does not require the companion to assert what the mocked test asserts. Root
`CLAUDE.md` is explicit: the companion "does NOT need to assert the same thing as the
mocked test, only to exercise the integrated path with real infrastructure so a different
mutation class is caught." A thin but genuine end-to-end path satisfies it; a thorough
mocked one does not.

Worth considering while in here, but not required by this task: whether the backend
citation canary should grow a frontend counterpart. Nothing currently prevents a frontend
suite from citing a spec that does not exist at all.
