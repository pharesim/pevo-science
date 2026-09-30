# The ORCID-factor e2e cache assertion compares five keys against a seven-key entry

**Owner:** ui
**Created:** 2026-09-14

Surfaced by the implementer of the consent-op eviction parity task as a residual,
deliberately not fixed there, and verified at architect review. Pre-existing and
independent of that change; this is not a hold on it.

## Why

In `tests/e2e/settings-orcid-factor.spec.js`, the stubbed-callback case reads the
consent-op slot back and asserts it with `toEqual` against a five-key object:
`token`, `expiresAt`, `action`, `rootAuthor`, `rootPermlink`. `cacheConsentOpProof`
has written seven keys since the credit-op extension, normalizing the two optional
fields to `authorIndex: null, claimer: null`. `toEqual` treats a missing key as equal
to `undefined` but not to `null`, so the assertion cannot pass. It fails on any e2e
run of that file and will be read as fallout from whatever landed last.

## Scope

1. Make the assertion match the writer's real shape. Preferred: add
   `authorIndex: null, claimer: null` to the expected object, so the spec keeps
   pinning the exact entry shape. Do not loosen to `toMatchObject`; that would stop
   catching an extra key.
2. Check the other e2e specs that read this slot back for the same five-key shape
   and fix any that share it.
3. A ui session has an untracked `tests/e2e/consent-op-fresh-auth.spec.js` in
   flight. If that work lands first and touches the same assertion, fold this fix
   into it and say so here; otherwise fix in place.

## Acceptance criteria

1. The stubbed-callback case in `settings-orcid-factor.spec.js` passes against the
   real writer.
2. No e2e spec asserts the consent-op entry with the five-key shape.
3. That e2e file is green under the E2E recipe in `agents/ui/CLAUDE.md`; any
   pre-existing failures elsewhere in the run are noted, not chased.

## UI implementation signal (2026-09-30, commit 660f2703)

- **Scope 1.** `660f2703` adds `authorIndex: null, claimer: null` to the expected
  object in the stubbed-callback case of `tests/e2e/settings-orcid-factor.spec.js`.
  The assertion stays `toEqual`, so an extra key still fails it.
- **Scope 2.** Re-enumerated from the code: `CONSENT_OP_KEY` is read back at three
  sites, all in that one file. The stubbed-callback case was the only five-key
  `toEqual`. The real-backend case uses `toMatchObject` on the triple plus a token
  type check (the token and deadline are backend-minted, so an exact match is not
  available there), and the mismatch case asserts `toBeNull`. No other e2e spec
  reads the slot.
- **Scope 3.** `tests/e2e/consent-op-fresh-auth.spec.js` has landed and does not
  read the slot, so there was nothing to fold into; fixed in place.
- **Verification.** Under the E2E recipe (restart, test-db-up, test-up):
  `npx playwright test tests/e2e/settings-orcid-factor.spec.js` ran 4 passed,
  exit 0. Only that file was run, so there are no elsewhere-failures to note. The
  pre-fix red was not re-observed in this session; it follows from `toEqual`
  not equating a missing key with `null`. Dev routing restored with
  `./deploy.sh up`.
- SHA self-verified: `git merge-base --is-ancestor 660f2703 main` exits 0.
