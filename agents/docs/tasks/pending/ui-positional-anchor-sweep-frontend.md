# Re-anchor the eight bare positional citations left in frontend/{src,tests}

**Owner:** ui
**Created:** 2026-09-06

Routed out of the round-6 architect review of `ui-cross-user-session-teardown`
(clean, archived the same day). That task retired the last bare positional anchor
in `lib/fresh-auth.js`'s `beginOrcidFreshAuthRedirect` docblock, and its signal
block correctly reported that the wider class was still open. This is that class,
filed as its own task so it is not blocked behind two still-open sibling tasks.

## Why

`.githooks/pre-commit` gained a positional-anchor arm on 2026-09-06 (`85baa79b`).
It is a DIFF gate: it fires only on newly-added lines, so none of the citations
below trips it and none of them will until someone edits that line. Root
`CLAUDE.md` defers the whole-tree-clean guarantee for these trees explicitly, and
that deferral is why the lines survived. The cost of leaving them is that the
`frontend/{src,tests}` trees cannot be promoted to a whole-tree-clean gate, and
each line is live rot: an insertion between the citation and its target silently
breaks the pointer with nothing to catch it.

The governing convention is
`agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md`.
A positional citation is durable ONLY when a stable behavioral name rides along in
the same container. All eight below are bare: the article sits directly against a
structural noun with no name in the slot.

## Scope

Re-anchor these eight, enumerated from the tree on 2026-09-06 by running the
hook's own positional regex over `frontend/src` and `frontend/tests`. Each is
quoted by its phrase rather than only its line number, since the numbers drift:

1. `tests/e2e/non-consent-fresh-auth.spec.js` - "is covered by the test above"
2. `tests/e2e/orcid-no-password.spec.js` - "See the docblock above the real round-trip describe"
3. `tests/unit/lib-fresh-auth-settings-orcid.test.js` - "The case above passes none"
4. `tests/unit/lib-fresh-auth-settings-orcid.test.js` - "The control for the case above"
5. `src/pages/settings.js` - "now that the guard above has already established"
6. `src/lib/fresh-auth.js` - "here and the call below"
7. `tests/unit/auth.test.js` - "The pair-partner of the test above"
8. `tests/unit/lib-settings-fresh-auth.test.js` - "The observed-factor sibling of the case above"

Item 6 deserves a judgment call rather than a reflex edit. Its full sentence is
"nothing may be awaited between here and the call below", and `mintViaPasswordFactor`
is named in the same comment paragraph, so a stable name arguably already rides
along and only the gate's noun-slot heuristic (which cannot see across a sentence)
would flag it. Decide it on the carve-out's three criteria and record the reasoning
in the commit message either way. A defensible "left as durable" is an acceptable
outcome for that one; the other seven are not.

For items 1 and 2, check whether the cited target is even in the same container
before rewriting. An e2e citation pointing across `describe` blocks needs the
target restated, not renamed.

## Acceptance criteria

- The hook's positional regex returns zero matches over `frontend/src` and
  `frontend/tests`, OR returns only item 6 with the carve-out reasoning recorded.
- Every replacement is audited against the other anchor rules per
  `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`:
  no task slug, round ordinal, line number, SHA, or `tasks-archive` redirect
  substituted for the position. This is the failure mode the convention exists for.
- Each rewrite is checked for behavioral accuracy against the code it describes,
  not just for anchor shape. A citation that is re-pointed at the wrong target is
  worse than the bare positional form it replaced.
- Comment-only. No production or test behavior changes, and the frontend unit
  suite stays at its documented baseline.

## Notes

Five of the eight belong to tasks still open in `tasks/pending/` at filing time
(`ui-consent-op-teardown-guard`, `ui-custody-upgrade-subject-pin`). Coordinate
rather than racing them: if either task is mid-flight on one of these files when
this is picked up, take the other files first and leave a note here. Items 1 and 2
predate both and have no other owner.

## Note (2026-09-14, from the light-account fresh-auth e2e task)

Item 1 no longer exists: the closing note in `tests/e2e/non-consent-fresh-auth.spec.js`
that carried "is covered by the test above" was replaced wholesale at 58ad7918, and the
hook's positional regex returns nothing over that file, the new
`tests/e2e/consent-op-fresh-auth.spec.js`, or `tests/e2e/fixtures/light-account.js`.
Seven items remain.
