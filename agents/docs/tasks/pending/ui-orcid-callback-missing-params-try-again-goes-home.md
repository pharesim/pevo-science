# A callback that arrives without an ORCID code sends "Try again" to the home page

**Owner:** ui
**Created:** 2026-10-09
**Priority:** normal

## Why

Found at the architect review of `ui-composer-surfaces-navigate-over-undrafted-work`. User triage:
"as recommended".

`init()` in `frontend/src/pages/orcid-callback.js` checks `code` and `state` first. When either is
missing or malformed it sets `orcid.missingParams` and returns, before it reads the
`pevo_orcid_mode` marker. `backPath` therefore keeps its `'/'` default, and the error card's
"Try again" (the `errorAction === ''` branch) goes to the home page. The mode branches further down
are what give every other error its back path: the return path for `session_auth` and
`fresh_auth`, `/signup` or `/login`, `/accreditation`, `/settings`.

The user-visible case is a user who leaves ORCID without authorizing. Intent only, check it against
ORCID's actual redirect: a denied authorization returns to the callback with an `error` parameter
and no `code`, so it takes this branch.

It matters more now. A passwordless account that submits a review, comment, vouch or retraction
with no window open leaves its composed work in the navigation stash, and only the page it left
restores it. After a denied authorization, "Try again" takes the user away from that page, and the
work comes back only if they find the page again themselves.

## Scope

Give the missing-params error the same back path the mode marker gives every other callback
error. Read the marker and set `backPath` before the missing-params return, using the same mapping
as the main path (one place, not a copy). Change nothing else on that branch: the error copy, the
`errorAction` and the flow keys left in `sessionStorage` stay as they are.

## Acceptance criteria

1. A callback with no usable `code` or `state` shows "Try again" pointing at the path the mode
   marker gives, for each mode the main path maps, and at `/` when there is no marker.
2. The other error branches and the success paths are unchanged.
3. Unit coverage for the `session_auth` case (return path in storage) and the no-marker case, each
   probed by reverting the fix.
4. New comments cite no task slug, round number or line number (root `CLAUDE.md` "Comment
   anchors").
