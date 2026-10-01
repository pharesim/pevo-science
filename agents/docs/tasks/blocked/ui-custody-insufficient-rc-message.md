# Custody callers say plainly when an account lacks the resource credits for a broadcast

**Owner:** ui
**Created:** 2026-10-01

## Why

`backend-light-account-rc-delegation-and-preflight` adds an error code for a custody broadcast
the signing account cannot afford in resource credits (`agents/docs/ARCHITECTURE.md` § 1
"Light-Account Resource Credits"). Every custody caller today shows one generic failure string
and reads nothing from the error, so a light account whose paper is too large for its credits
sees "Publishing failed", retries, and fails again forever.

## Scope

On the publish and edit pages, the review page, the comment composer and the vote buttons, map
the new code to a specific message: the broadcast was not sent, and either it can be retried
once credits regenerate (with the wait when the details give it) or, when the cost exceeds the
account's maximum, it cannot be sent from this account as it stands. Show a wait only if the
error details carry one; do not invent a regeneration estimate. A rejection with this code is
definitely not landed: on the composer pages it restores the attempt state that existed before
the submit (§ 8 "Retries"). It adds no attempt marker or kept permlink of its own and clears no
earlier attempt's, so a marker left by an earlier ambiguous attempt still governs the next
resubmit. New keys in all 16 locale files per the i18n convention; no emdashes.

## Acceptance criteria

1. Each caller shows the specific message for the new code and its generic message otherwise.
2. On the composer pages, this rejection leaves the attempt state as it was before the submit:
   no new marker or permlink, and an earlier attempt's marker and kept permlink survive.
3. Specs per caller, each probed by reverting its own site.

## [BLOCKED by Architect] (2026-10-01) — sequenced behind the backend RC task

Waits for the final error shape from `backend-light-account-rc-delegation-and-preflight`. The
architect moves this file to `pending/` when that task is archived. If `ui-composer-retry-safety`
has not landed by then, criterion 2 applies to whichever of the two lands second.
