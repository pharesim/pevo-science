# PEvO Task Board

Pending tasks assigned by the Architect. Each agent **must check this file before starting work** and pick up any task assigned to them.

When a task is complete, the implementing agent moves it to a **Review** section (not Done). The **Architect** reviews the implementation against the spec and physically moves it to `agents/docs/tasks-archive.md`. Do NOT use strikethrough to mark tasks done here. Completed tasks must be removed from this file entirely.

Review history: `agents/docs/tasks-archive.md`

---

## On Hold

### BLOG-1 — Write launch blog post series (Architect + User)

**Goal:** Publish blog posts for the beta launch via the `pevo.science` Hive account with `pevo-blog` parent permlink. Published via HiveComb; PEvO blog section picks them up automatically.

**Track A — Why (the problems, the vision)**
1. The Long Road to Open Science
2. Open Access Isn't Enough — Where You Store It Matters
3. Rethinking Scientific Reputation
4. Open Evaluation Under Pressure
5. ~~Why PEvO, Why Now~~ — **published 2026-04-15** — `@pevo.science/publish-and-evaluate-openly-pevo-science-open-beta-officially-launched` (draft: `agents/docs/blog/why-pevo-why-now.md`)

**Track B — How (deep dives into PEvO mechanics)**
6. How Publishing Works on PEvO
7. The Reputation Algorithm Explained
8. Anonymous Review Without Losing Accountability
9. Accreditation — Verifying Scientists Without a Gatekeeper
10. Light Accounts — Zero-Friction Onboarding
11. The Preprint Bridge — Bringing arXiv/bioRxiv Into the Conversation
12. Community Pinning — How Anyone Can Help Host Science
13. Why Hive? The Infrastructure Behind PEvO

**Suggested sequence for remaining posts:**
1. "How Publishing Works on PEvO" (next)
2. "The Long Road to Open Science" (week 1)

---

## Pending

### Phase 1: ORCID on-chain

#### P1-1 — Add `orcid` to accreditation custom_json payload (Backend)

**Goal:** Include the verified ORCID iD in the on-chain accreditation record so it can be used for authorship claim verification.

**Changes:**
- In `backend/src/routes/accreditation.ts`, ORCID callback handler (~line 324): add `orcid: orcidId` to the `customJsonPayload` object.
- In `backend/src/routes/signup-verify.ts`, confirm handler (~line 249): already includes `orcid` — verify it's present and correct.
- The `custom_json` schema is defined in `agents/docs/hive-schemas.md` section 2.1 (already updated by Architect).

**Acceptance criteria:**
- When a user accredits via ORCID, the broadcast `custom_json` includes `orcid: "<orcid_id>"`.
- When a user accredits via email (no ORCID), the field is absent or empty.
- Existing tests still pass.

---

#### P1-2 — Extract `orcid` in HAF accreditation CTE (Backend)

**Goal:** Make verified ORCID queryable from the accreditation data indexed via HAF.

**Changes:**
- In `backend/src/hafsql.ts`, `activeAccreditationsCteBody()` (~line 61): add `cj.json::jsonb ->> 'orcid' AS orcid` to the `accred_ranked` SELECT and propagate it through `active_accreditations`.
- Update all consumers of `active_accreditations` CTE that SELECT columns to include `orcid` where needed (check `accreditation.ts`, `wot.ts`, `reputation.ts`, profile/papers routes).

**Acceptance criteria:**
- `active_accreditations` CTE returns an `orcid` column.
- Profile API response includes `orcid` when present.

---

#### P1-3 — Display verified ORCID on profile pages (UI)

**Goal:** Show the verified ORCID iD on researcher profile pages with a link to the ORCID profile.

**Changes:**
- Profile API already returns accreditation data. After P1-2, it will include `orcid`.
- In the profile page component, display the ORCID iD with the ORCID icon (same SVG used on accreditation page) linked to `https://orcid.org/<orcid_id>`.
- Only show for verified ORCIDs (from accreditation data), not self-reported ones from paper metadata.

**Acceptance criteria:**
- Profile page shows ORCID badge with clickable link when the user has a verified ORCID.
- No ORCID shown when the user doesn't have one.

---

#### P1-4 — Settings page ORCID section (Backend + UI)

**Goal:** Allow already-accredited users to link or update their ORCID via OAuth from the settings page.

**Backend changes:**
- Remove the "already accredited" guard in `backend/src/routes/accreditation.ts` ORCID start handler (~line 229), or add a separate endpoint (e.g., `POST /api/accreditation/orcid/link-start` and `POST /api/accreditation/orcid/link-callback`) that skips the accreditation check but still requires the user to be authenticated.
- The callback broadcasts a new `accredit` custom_json with all existing accreditation fields plus the new `orcid`. Since the CTE takes the most recent `block_num`, this overwrites the old record.
- Need to fetch the user's current accreditation data (name, institution, field, method) to preserve it in the new broadcast.

**UI changes:**
- Add an "ORCID" section to the settings page (`frontend/src/pages/settings.js`).
- Show current verified ORCID if linked, with option to update.
- "Link ORCID" button initiates OAuth flow, callback redirects back to settings.
- Add a new callback page or reuse the existing accreditation ORCID callback with a return-to-settings flow.

**Acceptance criteria:**
- Accredited user without ORCID can link one from settings.
- Accredited user with ORCID can see it displayed and update it.
- The new accreditation custom_json preserves existing accreditation fields.

---

### Phase 2: Claim authorship

#### P2-2 — HAF CTE for authorship claims (Backend)

**Goal:** Index `claim_authorship`, `approve_authorship`, and `revoke_authorship` custom_json operations from HAF.

**Changes:**
- Add `authorshipClaimsCteBody()` function in `backend/src/hafsql.ts`. Logic:
  - Select all `claim_authorship` ops.
  - A claim is `accepted` if: (a) an `approve_authorship` op exists for the same (claimer, paper_author, paper_permlink), or (b) auto-accept conditions are met (claimer's on-chain ORCID matches `authors[author_index].orcid`, or `authors[author_index].hive === claimer`). Auto-accept requires joining with `active_accreditations` CTE (for ORCID) and paper metadata (for author list).
  - A claim is `revoked` if a `revoke_authorship` op exists with a higher block_num than the claim/approval.
  - A claim is `pending` otherwise.
- The CTE depends on `active_accreditations` being in scope (same as vouches CTE pattern).

**Acceptance criteria:**
- CTE returns: `claimer, paper_author, paper_permlink, author_index, status (accepted/pending/revoked), claimed_at`.
- Auto-accept works for ORCID match and hive username match.
- Revocations override both auto-accepted and manually approved claims.

---

#### P2-3 — Backend claim endpoints (Backend)

**Goal:** API endpoints for claiming, approving, and revoking authorship.

**New endpoints:**
- `POST /api/papers/:author/:permlink/claim` — Authenticated accredited user claims an author slot. Body: `{ author_index: number | null }`. Backend validates the user is accredited, broadcasts `claim_authorship` custom_json signed by the user's posting key (Keychain) or server-side for light accounts.
- `POST /api/papers/:author/:permlink/claims/:claimer/approve` — Original post author (or bridge account admin) approves. Broadcasts `approve_authorship`.
- `POST /api/papers/:author/:permlink/claims/:claimer/revoke` — Original post author, bridge account admin, admin account, or claimer themselves. Broadcasts `revoke_authorship`.
- `GET /api/papers/:author/:permlink/claims` — Returns list of claims on a paper with their status.

**Integration with paper detail:**
- The paper detail API response (and enrichment endpoint) should include `authorship_claims: [{ claimer, author_index, status }]` so the frontend can display claim status on author slots.
- When merging claims into the author list at read time: for accepted claims with an `author_index`, set `authors[i].hive = claimer` and add `authors[i].claimed = true`. For accepted unlisted claims (`author_index: null`), append the author.

**Acceptance criteria:**
- Claim, approve, revoke endpoints work.
- Paper detail merges accepted claims into author list without modifying on-chain post metadata.
- Claims appear on the paper detail response.

---

#### P2-4 — Notifications for authorship claims (Backend)

**Goal:** Notify relevant parties when authorship-related events occur.

**Notifications to generate:**
1. **Co-author listed on native paper:** When a paper is published with co-authors that have `hive` usernames, notify each co-author prompting them to confirm authorship.
2. **Claim pending approval:** When a claim requires manual approval (not auto-accepted), notify the original post author (native) or send email to bridge account admin (bridged).
3. **Claim approved:** Notify the claimer.
4. **Claim revoked:** Notify the claimer.

**Changes:**
- Extend the existing notification system (check `backend/src/notification-queries.ts` and `backend/src/routes/notifications.ts`) with new notification types.
- For bridge account admin email: use the existing SMTP transport.

**Acceptance criteria:**
- Co-authors with hive usernames get notified when listed on a new paper.
- Claimers get notified on approval/revocation.
- Bridge admin gets email for pending claims on bridged papers.

---

#### P2-5 — Claim authorship UI (UI)

**Goal:** Frontend for claiming authorship and viewing claim status.

**Paper detail page changes:**
- On each author slot, show claim status: unclaimed, pending, confirmed.
- For the logged-in accredited user: show "Claim" button on matching unclaimed slots (by ORCID or name match heuristic to suggest the right slot).
- For unlisted users: "Claim authorship" button that opens a modal to select or specify their author identity.
- For the original post author: show "Approve"/"Reject" buttons on pending claims.

**Profile page changes:**
- "Publications" tab includes papers where the user has an accepted authorship claim (not just papers where they are the Hive post author).

**Acceptance criteria:**
- Users can claim author slots from the paper detail page.
- Pending/confirmed status is visible on author lists.
- Original authors can approve/reject from paper detail.
- Claimed papers appear on profile.

---

#### P2-6 — Reputation credit for claimed co-authors (Backend)

**Goal:** The reputation algorithm gives equal credit to all authors with accepted claims on a paper.

**Changes:**
- In `backend/src/reputation.ts`: when computing paper-based reputation, query accepted authorship claims and credit each claimed author equally (same score as the posting author).
- This requires the claims CTE (P2-2) to be available in the reputation query.

**Acceptance criteria:**
- All authors with accepted claims receive equal reputation credit for the paper.
- Revoked claims stop contributing to reputation.

---

### Phase 3: Co-author edit rights

#### P3-1 — Extend edit authorization to claimed co-authors (Backend + UI)

**Goal:** Users with accepted authorship claims can edit the paper via the continuation flow.

**Backend changes:**
- The paper detail response already includes `authorship_claims` (from P2-3). No additional backend changes needed unless the edit flow has server-side authorization checks.

**UI changes:**
- In `frontend/src/pages/edit.js`, `isAuthorized` getter (~line 352): extend to check accepted claims from `this.paper.authorship_claims` in addition to `authors[i].hive`.
- All co-author edits already go through the continuation flow (fixed in commit 73c2dd4).

**Acceptance criteria:**
- A user with an accepted authorship claim sees the "Edit" button on the paper.
- Their edit creates a continuation post.
- The continuation chain resolves correctly and displays the latest content.

---

## Review
