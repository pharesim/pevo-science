# The publish e2e spec calls the rewards policy "rewards off"

**Owner:** ui
**Created:** 2026-10-01

Reported as out of scope in the signal block of `ui-non-consent-spec-comment-options-pin-flip`
(archived 2026-10-01). The user chose to file it.

## Why

`frontend/tests/e2e/publish.spec.js`, in the test that asserts the publish broadcast, says:

```js
// The second op configures comment_options (rewards off); verify presence
// but not details, which are not asserted here.
```

"Rewards off" is wrong. PEvO allows rewards. The UI does not show them, and the only policy
field is `percent_hbd: 0`, which pays out 100% in Hive Power instead of the default HBD/HP
split. The SPA sends `max_accepted_payout: '1000000.000 HBD'` and `allow_votes` /
`allow_curation_rewards` both `true`, and the custody broadcast handler now pins those exact
values. A reader who trusts this comment will think posts decline rewards. See
`agents/docs/solutions/conventions/rewards-policy-pin-percent-hbd-not-allow-curation-2026-05-16.md`.

It is the only "rewards off" wording in `frontend/` at the time of filing
(`git grep -n -i "rewards off" -- frontend`).

## Scope

1. Reword the comment so it states the policy correctly, e.g. that the second op is the
   `comment_options` op that routes the payout to Hive Power (`percent_hbd: 0`), and that
   this spec checks only that the op is present.
2. Say where the policy field is pinned, by test name or file, not by line number:
   `frontend/tests/unit/pages-publish.test.js` asserts `percent_hbd` on the publish bundle,
   and `non-consent-fresh-auth.spec.js` asserts it on the light-account publish broadcast.
   Re-check both at the head you work from before you cite them.
3. Re-run `git grep -n -i "rewards off\|rewards disabled\|no rewards" -- frontend` and fix
   any other hit that describes the on-chain policy the same way. A sentence about the UI
   not showing rewards is correct and stays.

Comment-only. Do not add an assertion: the field is already pinned in the two places
named in scope item 2.

## Acceptance criteria

1. No comment under `frontend/` says posts have rewards off, disabled, or declined.
2. The reworded comment names `percent_hbd: 0` as the policy field.
3. No added line carries a task slug, a task redirect, a round or hold ordinal, a
   line-number or SHA anchor, or a bare positional anchor.
4. No assertion changes. Running the spec is optional. State in the signal block whether it
   ran.
