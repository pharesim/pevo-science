# Account-state comments that enumerate A/B/C/D predate state G

**Owner:** backend
**Created:** 2026-10-05

Surfaced by the backend in its re-review signal on the custody-column
alignment (since archived) and approved for filing at that task's archive.
Comment-only. No behaviour change is wanted.

## Why

ARCHITECTURE.md § 6.1 enumerates state G: a pure self-custody Keychain account
that acquired an `accounts` row by registering an email through
`POST /api/settings/email`'s add flow. Its `custody` is NULL, it may later link
an ORCID and set a password, and it leaves through the same deletion exit as
A/B/C/D. § 6.3 now carries G's transitions, including
`A/B/C/D/G ──settings/email DELETE──> [no row]`.

Several backend comments still restate the pre-G enumeration. A comment that
lists states closes the set it names, so each of these now asserts something
false about which rows reach the code it describes. Known sites at HEAD
(re-locate each by its quoted text, not by position):

1. `routes/orcid.ts`, in the `/start` handler: "`delete_account` action
   (right-to-erasure exit, A/B/C/D → [no row] per ...".
2. `lib/fresh-auth.ts`, two docblocks: "(the de-facto right-to-erasure exit,
   A/B/C/D → [no row] per ..." and "anonymizes the audit log, transitioning
   A/B/C/D to the no-row state".
3. `routes/settings.ts`, above `DELETE /email`: "anonymizes
   `custody_audit_log`, transitioning A/B/C/D to the no-row state".
4. `jobs/registration-watch.ts`, the module docblock's event table:
   "`registration_done` ... a row reaches a finalized state (A/B/C/D)". The
   `collectCompleted` docblock in the same file already names G and is
   correct; the table above it now disagrees with it.
5. `routes/settings.ts`, `POST /set-password`: "today only the ORCID-path
   signup/recover leaves password_hash = NULL". False today. A G row is
   created with no password, a D row finalized through `POST /api/auth/link`
   has none, and a D row upgraded from C keeps C's NULL. The handler gates on
   `password_hash` NULL with `orcid` set and on no custody state, which is
   what § 6.4's set-password row now says.

## Scope

1. Fix every site above so it is true against § 6.1 and § 6.3 as they stand.
   Prefer citing § 6.3 for the deletion exit over restating a state list: the
   restated list is the shape that went stale. Where a list is genuinely
   needed, make it the § 6.3 set (A/B/C/D/G).
2. Sweep for sites this list missed before calling the item done. At minimum
   grep `backend/src` and `backend/tests` for `A/B/C/D`, `A, B, C, D`,
   `A/B/C`, `states A`, `finalized state`, and `light account row`, and read
   each hit against § 6.1. Report what the sweep found, including hits you
   judged correct and why.
3. The `set-password` comment's purpose is to explain why the handler
   requires an ORCID. Keep that purpose; replace only the false enumeration
   of which rows carry a NULL hash.

## Acceptance criteria

1. No comment in `backend/src` or `backend/tests` asserts a finalized-state
   set or a NULL-`password_hash` population that § 6.1 contradicts.
2. No behaviour change: `git diff` touches comments and docblocks only.
3. Comment-anchor conventions hold (root CLAUDE.md "Comment anchors"): no
   task slugs, round numbers, line numbers, or bare positional anchors in what
   you write. Cite § 6.1 and § 6.3 by section, which is the established form
   in these files.
