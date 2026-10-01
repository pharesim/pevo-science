# A composer retry cannot apply an edit twice or publish a paper twice

**Owner:** ui
**Created:** 2026-10-01

Implements, from `agents/docs/ARCHITECTURE.md` § 8 ("Composer Drafts"), "The head check",
"Retries", and the first rule of "What a native edit sends" (the retry window). Read § 8 first;
it is the contract this task is reviewed against.

## Why

Measured on 2026-09-30 and 2026-10-01.

- **A rejected broadcast can have landed, and the composers cannot tell.** On the custody route:
  a 504 `BROADCAST_TIMEOUT` (the transaction can even be signed after the 504), a 502
  `BROADCAST_FAILED` from a transport error that may have reached the node, a lost response with
  no code. On Keychain: the extension's own 10 s client timeout or a transport failure, all one
  localized message. Both composers keep the form live after any of them.
- **A native edit retried from a stale base applies the edit twice.** The patch is applied
  fuzzily (by PEvO's walker and by hivemind alike) and the per-hunk flags do not catch it: a
  re-applied insertion or append is duplicated in every case measured, with every flag true.
- **A publish or continuation retry mints a new permlink.** Inside 300 s of a landed first
  attempt the chain refuses it ("You may only post once every 5 minutes.", shown as "Publishing
  failed"); after that it is a second paper, or a second continuation of the same head, which the
  walker leaves as an orphan.
- **Concurrent editing is invisible to the page.** A second tab, another device, or an edit from
  another Hive frontend moves the head under a loaded edit page, and the next save merges a patch
  fuzzily into text the user has not seen (or, on the full-body paths, overwrites it).

## Scope

Depends on `backend-paper-body-from-replay-and-head-endpoint` (the head endpoint),
`ui-composer-drafts-bound-to-account-and-head` (the account- and head-bound draft this task adds
retry state to) and `ui-composer-landing-wait-and-served-diff-base` (the send rule this task adds
its first rule to). All three must be archived before this one starts.

1. **Head check** (edit page, both arms). Read the head endpoint right after the no-change check
   (before the first gate, so a refusal costs no re-auth and no upload) and again right before
   the broadcast. When a kept permlink exists (Scope 3), the existence check runs first and
   decides. When `head_marker` differs from the loaded paper's: flush the draft, broadcast
   nothing, and show the newer-version refusal with a reload (the remount the draft-binding task
   adds); the message says attached files must be picked again. When the endpoint cannot be read
   or the marker is null: broadcast nothing, keep the form and its attached files, and show the
   could-not-confirm message; the user can simply submit again.
2. **Native-edit attempt marker.** Record `{ at, path }` in the draft right before the broadcast
   call: after the uploads, and before the last `_windowReady({ allowRedirect: false, ... })`, so
   that gate's flush persists it. On a rejection, stamp the rejection time. Adopt it on restore.
   While a rejected attempt is inside its landing window (90 s on the custody route, 11 min on
   Keychain, counted from the rejection, or from the restore for a call that never settled), a
   native edit sends the full body: this is the first rule of § 8's send order, ahead of the
   no-op patch. Past the window, drop the marker; the head check decides. A submit that ends
   before its broadcast went out (a refused or cancelled last gate, a failed upload) restores the
   attempt state that existed before that submit. Besides the window expiry, only landing and
   Discard remove the marker; a form back at its baseline keeps it.
3. **Kept permlink** (publish page and the continuation arm). Mint once per instance, record it
   in the draft at the same moment as Scope 2, adopt it on restore. Before any send under a kept
   permlink, ask the head endpoint whether that post exists (`exists`; never the detail route).
   If it exists, the earlier attempt landed: run the landing (§ 8 "Landing is terminal": remove
   the draft once by its captured key, refuse further writes and submits) and show the
   already-published message with a link to the post, in place of the submit action. If it does
   not, send under the same permlink. If the read fails, send nothing and show the
   could-not-confirm message. Discard, an account change and starting a new paper drop the
   permlink. A submit that ends before its broadcast went out keeps an earlier kept permlink.

## Out of scope

- Classifying rejections, `idempotency_key`, a client-side broadcast timeout, and resending the
  identical signed transaction: considered and not adopted (§ 8, "Why the retry is made safe
  rather than the rejection classified").
- The review page and the comment composer (§ 8 Limits, last entry).
- The RC refusal message (`ui-custody-insufficient-rc-message`).

## Copy

New keys in all 16 locale files (English stubs plus `STUBS.md` lines), owned by this task: the
newer-version refusal (naming that attached files must be picked again), a reload label if no
existing key fits, the could-not-confirm message (shared by the head check and the existence
check), and the already-published message with its link label. No emdashes.

## Acceptance criteria

1. Head check: a moved marker broadcasts nothing, flushes the draft and offers the reload; an
   unreadable endpoint or a null marker broadcasts nothing, keeps the files and shows the
   could-not-confirm message; both checks run, before the first gate and before the broadcast.
2. The attempt marker: set right before the broadcast and persisted by the last gate's flush; a
   refused last gate and an upload failure restore the prior state; it survives a reload; inside
   the window the resubmit is a full body, including for an unchanged body; past it the marker is
   gone and the send rule of the earlier task applies; landing and Discard remove it; a form back
   at its baseline keeps it.
3. The kept permlink: survives a reload; an existing post runs the landing and shows the
   already-published message, with no further submit possible; a missing post means a send under
   the same permlink; a failed read sends nothing; Discard drops it; on the continuation arm the
   existence check decides before the head check.
4. Every assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## [BLOCKED by Architect] (2026-10-01) — sequenced behind three tasks

Needs the head endpoint from `backend-paper-body-from-replay-and-head-endpoint`, the draft shape
from `ui-composer-drafts-bound-to-account-and-head`, and the send rule from
`ui-composer-landing-wait-and-served-diff-base`. The architect moves this file to `pending/` once
all three are archived.
