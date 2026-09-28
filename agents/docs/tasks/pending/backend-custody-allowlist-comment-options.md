# Admit the comment_options op on the custody broadcast, bound to its comment

**Owner:** backend
**Created:** 2026-09-28

Filed from the architect review of `ui-light-account-fresh-auth-e2e-coverage`, which
pinned this defect as a known-defect e2e assertion. The defect itself was surfaced by
that task's implementation session and has been awaiting triage since 2026-09-14; the
user approved filing it on 2026-09-28.

## Why

`backend/src/routes/custody.ts` admits only `comment`, `vote`, and `custom_json` on
`POST /api/custody/broadcast`, while every NEW post the SPA builds (comment composer,
publish page, review page, edit-page continuation post) bundles a `comment_options` op
alongside the `comment` for the rewards policy (`percent_hbd: 0`; rewards allowed, not
displayed). The handler refuses the bundle with 403 FORBIDDEN, "Operation
'comment_options' is not allowed for custodial accounts", BEFORE the fresh-auth gate.
Both sides date from the initial light-accounts commit (92c2e6b6), so a light account's
comment, review, and publish have never worked through custody. Votes and the edit
page's same-author native edit (a lone `comment` op) are unaffected.

Reproduced outside Playwright with a minted JWT: comment plus comment_options is
refused in 4 ms with no gate log line, while comment-only and vote-only bundles reach
the gate.

## Scope

Admit `comment_options` on the custody broadcast under bindings that keep the server
from signing anything the SPA does not build:

1. A `comment_options` op is admitted only when the same bundle carries a `comment` op
   whose `author` and `permlink` equal the `comment_options` op's `author` and
   `permlink`. A lone `comment_options`, or one pointing at a different author or
   permlink, is refused.
2. The `comment_options` `author` must equal the JWT subject, same as the existing
   `comment` and `vote` binding checks.
3. Server-side rewards-policy enforcement: `percent_hbd` must be 0 and `extensions`
   must be empty (the SPA sends no beneficiaries; refusing beneficiary routing on
   custodial signing keeps a stolen JWT from redirecting rewards). Verify the SPA's
   actual bundle shape in `frontend/src/lib/signer.js` (or wherever the bundle is
   assembled) before pinning the field set, and push back on this item with what you
   find if the SPA sends more than `{author, permlink, max_accepted_payout,
   percent_hbd, allow_votes, allow_curation_rewards, extensions}`.
4. Refusals for binding violations use the existing pre-gate 403 FORBIDDEN shape with
   a message naming what failed. No emdashes in response strings.
5. Backend tests: the admitted comment+comment_options bundle reaches the fresh-auth
   gate (post-gate stop on a seeded key-less row, or the mock-auth fixture per the
   carve-out); each refusal class (lone options op, author mismatch, permlink
   mismatch, subject mismatch, nonzero percent_hbd, non-empty extensions) is pinned;
   vote-only and lone-comment bundles stay admitted.

## Coordination

- `frontend/tests/e2e/non-consent-fresh-auth.spec.js`'s comment test pins today's 403
  refusal as a positive assertion under a `known-defect` annotation. When the
  allowlist admits the op, that pin reddens BY DESIGN; the ui agent replaces it with
  `expectPostGateStop` per the spec's own docblock. Note this in your signal block so
  the architect routes the ui follow-up; do not edit frontend files yourself.
- `agents/docs/api-contracts/custody.md` is architect-zone; the architect updates the
  allowlist wording there at review. Flag in the signal if the implemented refusal
  shapes diverge from what this task prescribes.

## Acceptance criteria

1. A light account's comment, review, and publish bundles (comment + comment_options)
   pass the op allowlist and reach the fresh-auth gate.
2. Every binding listed in Scope 1-3 is enforced and refused with the pre-gate 403.
3. Vote-only and lone-comment behavior is unchanged.
4. Backend tests cover the admit path and each refusal class.
