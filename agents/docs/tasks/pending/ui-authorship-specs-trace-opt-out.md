# Two authorship e2e specs mint session JWTs with Playwright tracing still on

**Owner:** ui
**Created:** 2026-10-01

Routed out of the architect re-review of `ui-e2e-retry-model-comment-sweep` (archived
2026-10-01), where the implementer listed it for triage.

## Why

`frontend/tests/e2e/authorship-consent-actions.spec.js` and
`frontend/tests/e2e/authorship-pending-discovery.spec.js` both seed a session through
`seedAccreditedSession` in `fixtures/auth.js`. That helper mints a live backend-valid
session JWT with `mintSessionJwt` and writes it to `localStorage` through
`page.addInitScript`. Neither spec sets `test.use({ trace: 'off', ... })`, so the global
`trace: 'retain-on-failure'` in `frontend/playwright.config.js` applies. A failing test in
either spec leaves a `trace.zip` that holds the token under `frontend/test-results/`.

The other eight specs under `frontend/tests/e2e/` that call `seedAccreditedSession` all opt
out, with a one-line reason (for example `review-submit.spec.js`: "This spec mints a live
backend-valid bearer JWT via seedAccreditedSession. Disable trace/video/screenshot to keep
that token out of trace.zip artifacts ...").

`scanTracesForSecrets` in `global-teardown.js` is the backstop, and its JWT arm would catch
the token. But it reads traces with `unzip -p`, and it skips with a warning when that binary
is missing. `unzip` is not installed on the dev host (checked 2026-10-01). On that host the
scan never runs, and the per-spec opt-out is the only defense. The scan's own docblock names
the opt-out as the primary defense.

## Scope

1. In each of the two specs, add `test.use({ trace: 'off', video: 'off', screenshot: 'off' });`
   at module scope, after the imports. Add a short comment that gives the reason in the
   same terms as the sibling specs: the spec mints a live session JWT through
   `seedAccreditedSession`, and the global `retain-on-failure` default would otherwise
   persist it.

## Out of scope

- Any change to `scanTracesForSecrets`, to the global trace default, or to how the scan
  behaves without `unzip`.
- Installing `unzip` on any host.
- Any assertion, fixture, or mock change, and any other spec.

## Acceptance criteria

1. Both specs set trace, video, and screenshot off for every test in the file.
2. Every `frontend/tests/e2e/*.spec.js` that calls `seedAccreditedSession` sets
   `trace: 'off'`.
3. No assertion, fixture, or mock changes.
4. New comment text follows root `CLAUDE.md` "Comment anchors": no task slug, round or hold
   ordinal, line number, commit SHA, or bare positional reference.

## Notes

Running the two specs is optional: `test.use` changes which artifacts are kept, not what the
tests assert. State in the signal block whether they ran.
