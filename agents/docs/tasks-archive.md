## A native edit never sends an empty body, and never copies another post's `continues` (archived 2026-10-06) — three rounds; round 2 added the served-body send rule (§ 8 rule 2), round 3 one comment narrowing; clean; two follow-ups filed

### Architect archive note (2026-10-06, round 3)

Round 3 clean (`/ce-code-review`, lite path: comment only, zero findings). `1d26e15e` is exactly the prescribed one-line narrowing of the `latestIsTarget` comment, and the comment is true on both `papers.ts` serving paths. AC1 to AC5 were met at round 1; round 2 landed the served-body send rule and the `targetOwnContinues` docblock narrowing.

- Follow-ups filed: `ui-edit-no-change-guard-compares-served-authors` (normal), `ui-native-edit-continues-from-target-own-metadata` (low), both in `pending/`.
- Carried by `ui-composer-landing-wait-and-served-diff-base` (blocked): a non-head target whose own op is the latest sends the full body for an unchanged body; a stale cached detail can name an older latest op.
- Dismissed: `reconstructVersionsFromHaf` same-block ordering; the unpinned skip of a `versions[]` entry without `author`/`permlink`.
- Noted, no action: the round-3 hold's premise ("serves `latest.body` only when the chain holds more than one post") overlooks the metadata-restored fallback, which serves `latest.body` for a single post too. The comment carries no "only", so it stays true.
- No `/ce-compound`: no hold-time solutions entry cites this task, and the round-3 lesson (hold prose overclaims, then gets copied) is already recorded.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** high

Two defects in the native-edit arm of `handleSubmit` in `frontend/src/pages/edit.js`, found
while deciding the composer retry-safety question. Neither depends on any other task. Read
`agents/docs/ARCHITECTURE.md` § 8, "What a native edit sends".

## Why

1. **An unchanged body is sent as `''`, and Hive rejects it.** On a head target the arm sends
   `broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText`, and
   `computeDiff(a, a)` is `''`, so the empty string wins. hived's `comment_operation::validate`
   rejects an empty body ("Body is empty"), and nothing between the page and the node checks
   first. Measured with the real page: a title-only native edit broadcasts `body: ""`. The
   no-change guard does not stop it whenever another field changed, and it is skipped outright
   when supplementary files or addressed-review ticks are present, so attaching a file to one's
   own paper, or ticking the reviews a revision addresses without touching the text, also sends
   `''`. Every such edit ends in "Edit failed". Addressing reviews is a core PEvO flow.
2. **A native edit on a non-head post writes the head's `continues` onto its target.** The
   arm builds its metadata from `...pevoMeta`, where `pevoMeta` is
   `this.paper.json_metadata?.[APP_TAG]`, the metadata of the latest op across the chain. When
   the root author edits the root after a co-author's continuation became the head, that
   metadata is the continuation's, so the root's new op carries `continues` pointing at the root
   itself (measured with the real page). By read: `resolveContinuationChain` then finds the root
   as its own continuation, stops at its cycle guard and returns the root alone, and every
   listing, search, profile and reputation query filters `continues IS NULL`, so the paper drops
   out of all of them. No continuation exists on chain yet, so this has not happened; it will on
   the first non-head edit after one does.

## Scope

1. **No-op patch for an unchanged body.** When the patch computed for a head target is empty,
   send `@@ -0,0 +0,0 @@\n`. It was measured to leave the body unchanged in the backend's and
   frontend's `diff-match-patch` and in hivemind's pinned Python port (bases of 0, 1, 47 and
   70000 chars, and one with a non-BMP character). Leave the other branches of the send rule
   alone; the full-body cases in § 8 belong to a later task.
2. **A native edit's `continues` is its target's own.** Absent when the target is the root; for a
   continuation post, the post it already continues. Never the head's. The spread of the rest of
   `pevoMeta` (the paper-level fields such as the current IPFS document) can stay. The target's
   own predecessor is derivable from the chain order in `versions[]`, or readable from the
   target's last version through `fetchPaper(canonical, canonicalPermlink, <version_number>)`;
   pick one and say which in the signal block.

## Out of scope

- The full-body fallbacks, the diff base, retries and the head check in § 8. A later task covers
  them, after the backend serves the replayed body. Do not send the full body for the empty case:
  until that backend task lands, the form holds the creation body, and a full body built from it
  would silently revert every earlier edit.
- The continuation arm's own metadata (it sets `continues` to the head deliberately).

## Acceptance criteria

1. A head-target native edit whose body is unchanged broadcasts exactly `@@ -0,0 +0,0 @@\n`:
   for a title-only change, a supplementary-file-only change, and an addressed-reviews-only
   change.
2. A head-target native edit that changes the body still broadcasts a patch; the existing
   `head-author native edit still computes diff` spec stays green.
3. A non-head native edit's broadcast metadata carries no `continues` when the target is the
   root, and carries the target's own predecessor when the target is a continuation post. Change
   the fixture the non-head specs use (unit, and `frontend/tests/e2e/edit-paper.spec.js`) so the
   head's metadata carries a `continues`, so the assertion can fail.
4. Each assertion is probed by reverting its own site; list the probes in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## Implementation notes

**UI implementation signal (2026-10-05, commits `6e10bd5e`, `62812370`, `4648252e`, `bdefe550`; follow-up tasks `0498a574`, `59018357`; each verified an ancestor of `main` with the expected file list):**

- `6e10bd5e`: the fix, the new unit specs, and the e2e fixture change. `62812370`: the head-target continues spec reshaped to cover a root version listed between two continuations. `4648252e`: the seven `form button[type="submit"]` locators in `edit-paper.spec.js` scoped to `[x-data="editPage"] form button[type="submit"]` (user-approved fold-in: the always-rendered re-auth modal form made all seven specs fail at the click or at `toHaveCount(0)`, so the AC3 e2e assertion was never reached). `bdefe550`: the fixes from the review below.
- Scope 1 / AC1-2: the head-target branch sends `NO_OP_PATCH` (`@@ -0,0 +0,0 @@\n`) when `computeDiff` returns `''`; every other branch of the send rule is unchanged. Unit specs cover a title-only, a supplementary-file-only and an addressed-review-only edit. The `head-author native edit still computes diff` spec stays green and now also asserts the patch carries the change (`toContain('TWEAK')`), since the no-op patch also starts with `@@`; the e2e in-place spec gained the same check (`toContain('drift detection')`).
- Scope 2, the choice: the target's `continues` is derived from the chain order in `versions[]`, not read through `fetchPaper(..., version_number)`. `targetOwnContinues` puts the canonical root first (it continues nothing), then the other posts in the order of their first version, and returns the post before the target. When the response holds one post (a fork of an already-continued head, or a continuation whose PEvO block another frontend stripped, both served as papers of their own), the served metadata is that post's own, so its served `continues` is kept. Chosen for no network read, and no new failure path, inside the submit. The rule applies to every native edit, head or not: with the head excluded, a head continuation edited after a later root edit would have lost its `continues`, since the served metadata is then the root's.
- AC3: the unit non-head spec's served metadata is now parsed and names `continues`, and asserts the root sends none. New unit specs: a non-head continuation target sends its own predecessor; a head continuation target keeps its predecessor when the latest op is the root's (with a root version listed between two continuations); a continuation served on its own keeps its served `continues`; with a link whose first version is older than the root's, the root sends none and the link names the root. The e2e non-head fixture's served metadata now names `continues`.
- AC4 probes (unit probes in scratchpad copies of `bdefe550`, `tests/unit/pages-edit.test.js`, baseline 137 passed):
  - no-op site reverted to the old ternary: the three unchanged-body specs fail, nothing else;
  - `NO_OP_PATCH = ''`: the same three fail;
  - the else branch always sends `NO_OP_PATCH`: only `head-author native edit still computes diff` fails (on `TWEAK`);
  - `continues: targetContinues || undefined` deleted: the root non-head, continuation non-head, head-target and inverted-root specs fail (the fork and inverted-link specs pass because the served metadata happens to carry the right value there);
  - single-post branch deleted: only the fork spec fails;
  - canonical-root-first removed (`posts = []`): only the two inverted-chain specs fail;
  - de-duplication removed: the head-target spec and the fork spec fail.
  - E2E: with the `continues` line removed, the non-head spec fails at `expect(meta[APP_TAG].continues).toBeUndefined()`, receiving the root as its own `continues`; unmutated it passes (both served by vite dev from scratch copies carrying the backend's `__PEVO_CONFIG__`).
- AC5: the new comments anchor on `targetOwnContinues`, `NO_OP_PATCH` and the specs' fixtures; the commits passed the pre-commit anchor gate.
- Verification: full frontend unit suite 91 files / 2149 passed, exit 0. E2E on the final tree (`./deploy.sh restart`, `test-db-up`, `test-up`; dev routing restored after): `edit-paper.spec.js` 7/7 passed from the repo checkout. A scratch-only browser check (not committed) confirmed a title-only and an addressed-review-only head edit send the no-op patch on the real page.
- Review (verification workflow: mutation probes plus chain, send-rule and conventions lenses, one refuter each), triaged by the user, all as recommended:
  1. Fixed in `bdefe550`: a continuation post served as a paper of its own lost its `continues` under the first derivation (it read as a root).
  2. Fixed in `bdefe550`: the head-diff unit and e2e specs could not tell a real patch from the no-op patch.
  3. Fixed in `bdefe550`: a link re-pointed onto the chain by a hand-made op, older than the root, made the root's own edit write a cycle; the root now always reads first.
  4. Fixed in `bdefe550`: the e2e non-head spec's opening comment called the edited post a continuation; the fixture makes it the root.
  5. Filed as `ui-edit-no-change-guard-compares-served-authors` (normal, `0498a574`): the no-change guard compares the form with the raw head claim, so an untouched form whose served authors differ from it now lands a metadata-only version instead of failing.
- Residual, filed at the user's choice as `ui-native-edit-continues-from-target-own-metadata` (low, `59018357`): a link re-pointed onto the middle of a chain by a hand-made op reads out of order, so another author's edit of a continuation can name the wrong predecessor. The root and the listing are protected.
- Simplify pass (`/ce-simplify-code` over the `edit.js` changes, run after the move; the UI protocol puts it before): the reuse and efficiency reviewers found nothing; the quality reviewer raised three optional nits. Applied in `89db458e` (verified on `main`): a blank line setting the `targetContinues` capture apart from the comment about the captures `_finishLanded` reads. Skipped: returning `undefined` rather than `null` from `targetOwnContinues` (the `null` matches `userPostInChain`), and testing body equality instead of `diffText === ''` (equivalent; the current form is the task's own wording and the probes above pin it).

## Architect re-review (2026-10-06) — HELD PENDING FIXES:

Reviewed `6e10bd5e`..`89db458e` with `/ce-code-review` (correctness, adversarial, project-standards, testing, learnings; one finding validated independently). AC1 to AC5 are met, and the seven unit kill claims were re-measured and held. Two items:

1. **A native edit takes the patch path only when the served body is the target post's.** With `continues` fixed, a non-head edit keeps the chain intact, so the latest op can belong to a post other than the head. The paper detail serves a chain's body as the replay of its latest op (`detail.body = latest.body`), and the replay applies each patch to the patched post's own previous body. So when the latest op is not the target's:
   - an unchanged body sends `NO_OP_PATCH`, the target keeps its own older body, its op becomes the latest, and the paper page loses the other author's revision;
   - a changed body's patch is computed against the other post's text and applied to the target's own body.

   Fix: take the patch path (the computed patch, or `NO_OP_PATCH` for an unchanged body) only when the last `versions[]` entry names the target post, or carries no `author`/`permlink`. Otherwise send the full `newPostBody`, changed or not. For this one case this replaces the Out-of-scope sentence "Do not send the full body for the empty case": that sentence's reason is the creation body a single-post detail serves, while a chain detail serves the replayed body. Single-post papers keep the patch path.

   Tests: correct the fixture of `head native edit of a continuation post keeps the post it continues when the latest op is the root's` so `paper.body` and `_originalBody` hold the root's latest text, as the backend serves it for that chain, and assert the full body there. Add a changed-body spec in the same chain state. The head-target specs whose last `versions[]` entry is the target (`head-author native edit still computes diff`, the unchanged-body specs) stay on the patch path. Probe each new site by reverting it, and list the probes in the signal block.

   `agents/docs/ARCHITECTURE.md` § 8 "What a native edit sends" now carries this as its rule 2.

2. **Narrow the `targetOwnContinues` docblock.** Delete ", which continues nothing". A post served as a paper of its own and since continued is the canonical of a multi-post response and does continue a post. That case moved to `ui-native-edit-continues-from-target-own-metadata`.

Dismissed: the unpinned skip of a `versions[]` entry without `author`/`permlink` (the guard is correct, and only a degraded HAF read reaches it).

**UI re-review signal (2026-10-06, commits `a5dcb592`, `3969623c`, `35bac763`; each verified an ancestor of `main` with the expected file list):**

- `a5dcb592`: both hold items. Item 1: the native-edit arm takes the patch path (the computed patch, or `NO_OP_PATCH`) only when `targetIsHead && latestIsTarget`. `latestIsTarget` is true when the last `versions[]` entry names the target post, or carries no `author`/`permlink` (and when `versions[]` is absent, which no detail path serves). Every other native edit sends the full `newPostBody`, changed or not. It is captured with `targetIsHead` before the first await. Item 2: ", which continues nothing" deleted from the `targetOwnContinues` docblock, nothing else changed in it. `3969623c`: the new comment's "In a chain the served body is the latest version's" narrowed to a chain whose `versions[]` names its posts (a degraded chain read serves the root's row body with the synthetic entry; that path never reaches the native arm, but the sentence was broader than the backend). `35bac763`: simplify pass (below).
- Tests, as prescribed: the spec `head native edit of a continuation post keeps the post it continues when the latest op is the root's` now sits in `describe('a head continuation whose latest op is the root\'s')` with a shared fixture whose `paper.body`, `_originalBody` and form hold the root's latest text (as `papers.ts` serves `latest.body` for that chain), and it asserts that full body. New sibling `a changed body is sent whole, not as a patch`, same chain state, with a body long enough that the patch is shorter (39 vs 148 chars), so the old rule would send a patch. `head-author native edit still computes diff` and the three unchanged-body specs keep the patch path unmodified. Added beyond the hold: `a version entry that names no post keeps the no-op patch` (unchanged-body block), because nothing else pinned the unnamed-entry clause, and a single-post paper on a degraded read would otherwise send its served creation body whole.
- Red before the fix: both chain specs failed against the pre-fix `edit.js` (the unchanged one received `@@ -0,0 +0,0 @@\n`, the changed one `@@ -135,8 +135,14 @@ ...`).
- Probes (scratchpad copies, `tests/unit/pages-edit.test.js`, baseline 139 passed; rerun on `35bac763` for the three new-site probes with identical results):
  - `if (targetIsHead && latestIsTarget)` reverted to `if (targetIsHead)`: the two root-latest chain specs fail, nothing else.
  - unnamed-entry clause deleted from `latestIsTarget`: only `a version entry that names no post keeps the no-op patch` fails.
  - `versions?.[0]` read instead of the last entry: only `head-author native edit still computes diff` fails.
  - patch path never taken (`targetIsHead && false`): `head-author native edit still computes diff`, the three unchanged-body specs and the unnamed-entry spec fail.
  - permlink comparison dropped: survives, equivalent. The target is `userPostInChain`, the user's last `versions[]` entry, so a last entry by the target's author is that entry; with `ownPost` null the native arm needs a single post with no entry naming the user.
- Verification: full frontend unit suite 92 files / 2167 passed, exit 0 (on `a5dcb592`; the later commits touch comments and one test-local constant, and the edit-page file stays 139/139). E2E on `a5dcb592` (`./deploy.sh restart`, `test-db-up`, `test-up`; dev routing restored after): `edit-paper.spec.js` 7/7 passed. Its in-place spec's only version names the target, so it stays on the patch path.
- Verification workflow on `a5dcb592` (send-rule, test-strength and comment-truth lenses, a refuter per finding): zero findings. The send-rule lens drove 20 chain states in a copy (single post with named, synthetic or absent versions; head target latest; head target with the root's or a middle link's op latest; non-head target latest or not; the inverted chain, both ways; each with an unchanged and a changed body), and each sent what § 8 rule 2 prescribes. Its served-body residual is what `3969623c` narrows.
- Simplify pass (`/ce-simplify-code`, three reviewers). Applied in `35bac763`: the composed root body named once (`ROOT_POST_BODY`), and the full-body branch's comment deleted, since it restated the negation of the condition the branch docblock states. Skipped: folding the unnamed-entry spec into the `it.each` table (its own title says which branch it pins), and renaming the chain spec to drop the describe's context (the hold cites it by its current title).
- Out of scope, noted for triage, not filed: `reconstructVersionsFromHaf` orders ops by `block_num` alone, so two chain posts edited in the same block have no defined latest. The frontend check stays consistent with the served body (both come from the same array). Theoretical.

## Architect re-review (2026-10-06, round 3) — HELD PENDING FIXES:

Reviewed `a5dcb592`..`35bac763` with `/ce-code-review` (correctness, adversarial, project-standards, testing, learnings; the one finding confirmed by an independent validator). Both items of the previous hold are met: the send rule matched § 8 rule 2 in an 11-state matrix, the prescribed fixture and specs landed, the five probes re-measured as listed, and the docblock change is exactly the prescribed deletion. One item:

1. **Narrow the `latestIsTarget` comment in `handleSubmit`.** Change "In a chain whose versions[] names its posts" to "In a multi-post chain whose versions[] names its posts", and change nothing else in that comment. `papers.ts` serves `latest.body` only when the chain holds more than one post. A single post is served its `hafsql.comments` body, which stays at the creation body after an edit, while its `versions[]` still names the post, so the current wording also claims the single-post case. The wrong wording came from the previous hold's own sentence ("serves a chain's body as the replay of its latest op"). Comment only: no spec or probe is needed. Run the edit-page spec file and say so in the signal block.

Dismissed: the signal's note that `reconstructVersionsFromHaf` orders by `block_num` alone (two co-authors' edits to one paper in the same block; the edit page reads `versions[]` and the body from one response, so they agree). No action, already covered: a non-head target whose own op is the latest sends the full body for an unchanged body where § 8's order prescribes the no-op patch, and a stale cached detail can name an older latest op. `ui-composer-landing-wait-and-served-diff-base` carries both (its send-rule scope and the head check).

**UI re-review signal (2026-10-06, round 3, commit `1d26e15e`; verified an ancestor of `main`, file list `frontend/src/pages/edit.js` only):**

- Item 1: the `latestIsTarget` comment in `handleSubmit` now reads "In a multi-post chain whose versions[] names its posts". Nothing else in the comment changed; the diff is that one line. Checked against `papers.ts`: `detail.body = latest.body` sits inside `if (chain.length > 1)`.
- Comment only, so no spec or probe. `tests/unit/pages-edit.test.js`: 139/139 passed, vitest exit 0.

## Decide how an institutional mailbox is bound to one accredited account (archived 2026-10-06) — seven questions decided with the user; design written to ARCHITECTURE.md § 2 Credential Bindings; 8 implementation tasks and 7 defect tasks filed

### Architect archive note (2026-10-06)

Decisions, the task list and the dismissals are in the "Decisions (2026-10-06)" section below. Design commit 30817bbe.

**Owner:** architect
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 3). Two reviewers reported it and the
validator confirmed it from the code. The user chose a design task over accepting it for beta
(2026-10-05).

## Why

`POST /api/accreditation/request` checks an address only with `isInstitutionalEmail`, behind a
limiter keyed on the Hive account. `POST /api/accreditation/verify` never looks up earlier use of
the address: `evidence_hash` is salted with the token, so two accreditations from one mailbox
share no value on chain, and nothing in the app database records the address. A sanction is keyed
on the Hive username.

So one mailbox can accredit any number of Hive accounts, and a sanctioned researcher can accredit
a fresh account from the same mailbox. Every accredited account can vouch, and the threshold
number of vouches (3 by default) enrolls an account in the Web of Trust, so the WoT is only as
strong as this binding.

## Questions to settle

1. **The rule.** Does one verified mailbox back at most one accredited account at a time? Does a
   sanctioned account's mailbox stay bound, so that its holder cannot accredit another account?
2. **Where the binding lives.** An app-database table keyed by an HMAC of the normalised address
   needs a migration and is not reconstructible from the chain, which sits against design
   principles 2 and 6. A value on chain is public and linkable, which sits against principle 5.
   Name the trade and choose.
3. **Normalisation.** Case, plus-addressing, and subdomain variants of one institution.
4. **Rebinding.** A researcher who lost their keys, or who moves to another account.
5. **Other entry points.** Light-account signup already refuses a duplicate `accounts.email`. How
   do the signup-verify accredit path and the settings email add flow relate to the binding?
6. **Existing accreditations.** Past `evidence_hash` values cannot be compared, so the binding
   can only apply from its rollout on, apart from addresses the `accounts` table already holds.
7. **Enforcement points.** A refusal at `/request` is cheap; the check at `/verify` is the
   authoritative one and has to hold when two verifications race.

## Deliverable

Work the questions through with the user (`/ce-brainstorm`). Record the decisions in
`ARCHITECTURE.md` § 2 and file the implementation tasks with their priorities. A schema change
needs the user's explicit approval before any task is filed.

## Related

`backend-accreditation-verify-requires-the-account-session` makes a verification show control of
both mailbox and account. It does not limit how many accounts one mailbox can accredit.

## Decisions (2026-10-06)

Worked through with the user in a `/ce-brainstorm` dialogue, grounded by a read-only workflow over
the code, the open tasks and external sources (52 agents, every fact adversarially verified), and
written into `ARCHITECTURE.md` § 2 "Credential Bindings", § 2 "Revocation (custom_json)",
"Accreditation Lifecycle & Sanctions", § 6.4, § 7, `hive-schemas.md` § 2.1 and 2.2, `CONCEPTS.md`
("Credential Binding", "Release"), `.env.example` (`MAILBOX_BINDING_KEY`); commit 30817bbe. The
text passed a five-lens doc review with adversarial verification of each finding (45 applied).

| Question | Decision | Chosen over |
|---|---|---|
| 1. The rule | One verified mailbox backs at most one accredited account; a second account is refused, sanction or not, so a sanctioned account's mailbox stays bound. Extended to the ORCID iD: each credential binds one account, a sanction keeps every credential held. The principle is one researcher, one accredited account; two credentials on two accounts is an undetected breach, not a permitted arrangement (user correction mid-session) | sanction-only refusal; record-only registry; small per-mailbox cap; mailbox only |
| 2. Where the binding lives | Mailbox: app-database table `mailbox_bindings` keyed by HMAC-SHA256 of the canonical address under a dedicated secret, nothing on chain (schema change approved). ORCID: on chain as today, with sanction stickiness added to the read | keyed hash in the accredit op; table plus encrypted copy on chain |
| 3. Normalisation | Trim, lowercase, strip `+tag`, keep dots, the request schema's email rule, punycode domain; subdomains and aliases not folded; one shared function; the mail recipient is never derived from the folded form (architect, from evidence; confirmed in the synthesis) | |
| 4. Rebinding | The holder can release the account's own accreditation (new `revoke type: "release"`, admin-signed on the holder's fresh-auth request), which frees its mailboxes; lost keys go to an admin (`POST /api/admin/accreditation/release`). History of released bindings kept for admins, one year, no waiting period | admin-only; move by mailbox proof alone; no moves; waiting period |
| 5. Other entry points | Light-account signup claims the binding at finalize for the mailbox the signup link proved; `/signup` answers uniformly after the duplicate check; ORCID-path signups bind no mailbox; settings e-mail never binds; account deletion no longer frees a mailbox | |
| 6. Existing accreditations | Light accounts on file are bound by an operator script (mail-proven signup ops matched by hash); page-accredited Keychain accounts are left until their mailbox is next verified | asking the ten to verify again |
| 7. Enforcement | Uniform `/request` answer with the notice delivered by mail; authoritative claim at `/verify` after the session and the existing gates, 409 `MAILBOX_ALREADY_BOUND`, row before op, kept on ambiguous outcomes, partial unique index as race arbiter, fail closed without the app database | |

Tasks filed (2026-10-06): `backend-mailbox-binding-registry` (high),
`backend-accreditation-release-op` (high), `backend-orcid-binding-sanction-sticky` (high),
`backend-signup-finalize-claims-mailbox-binding` (high), `backend-mailbox-binding-backfill-script`
(normal), `backend-mailbox-binding-history-and-admin-view` (normal),
`ui-accreditation-binding-refusal-states` (high), `ui-accreditation-release-flow` (normal).

Defects found while grounding, triaged by the user "as recommended": `backend-signup-email-address-list`
(high), `backend-signup-finalize-evidence-hash-salted` (normal), `backend-verify-failure-may-have-landed`
(normal), `backend-registration-watch-masks-addresses` (normal),
`backend-academic-domains-case-and-stoplist` (low), `architect-accreditation-docs-drift-sweep` (low),
`ui-signup-duplicate-and-server-strings` (low); two stale-comment items appended to
`backend-accreditation-wot-comment-and-dead-code-pass`; `ui-light-account-vouch` moved from
`blocked/` to `pending/` (its blocker was archived 2026-10-01). Dismissed: `/verify` skipping its
HAF gates when HAF is unconfigured (every deployment configures HAF; the binding gate sits outside
that block by design).

The privacy and terms task (`tasks/hold/`, untracked) carries the notice items the binding needs.
Learnings: no `/ce-compound`; the design rationale is in `ARCHITECTURE.md`.

## The sign-in modal has no way to ORCID sign-in (archived 2026-10-06) — clean review; two signal follow-ups and two residual risks triaged

### Architect archive note (2026-10-06)

