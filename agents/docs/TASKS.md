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

### VVER-B1 — Add `voted_version` to voter objects in enrichment response (Backend)

**Goal:** Each voter in the enrichment response should include `voted_version: number` so the frontend knows which paper version the voter last evaluated.

**How to determine `voted_version`:**

- **Revote signals** (custom_json with `action: 'revote'`): The `version` field is already explicit in the payload. Use it directly.
- **Native Hive votes** (vote operations): No version field exists. Infer by comparing the vote's `block_num` against version `block_num` values. The voted version is the latest version whose block_num <= vote block_num. If the vote predates all versions, it's version 1.

**Implementation steps:**

1. Add `block_num: number` to `PaperVersionEntry` and `ReconstructedVersion` interfaces. Populate from the `commentOps` query in `reconstructVersionsFromHaf` (the data is already in the query result, just not exposed).
2. In `resolveVersionsFromHaf`, include `block_num` in the returned entries (stop stripping it).
3. In `fetchEnrichmentFromHaf`, after vote resolution and version fetching:
   - Build a sorted array of `{ version_number, block_num }` from the versions.
   - For each voter, determine `voted_version`:
     - If the resolved signal came from a revote with a `version` field, parse it as number.
     - Otherwise, binary-search the version block_nums to find the latest version where `version_block_num <= vote_block_num`. Default to 1.
   - Add `voted_version` to each voter object in the response.
4. The `voted_version` field should be present on ALL voters, not just the current user.

**Voter object shape after change:**
```ts
{ voter: string; weight: number; effective_weight: number; voted_version: number }
```

**Note:** `block_num` on version entries is for internal use in this computation. It does NOT need to be exposed in the paper detail response, only in enrichment. But including it in `PaperVersionEntry` makes it available if needed elsewhere.

### VVER-F1 — Show voted-version indicator to current user (UI)

**Goal:** When the logged-in user has voted on an older version of a paper, show a subtle indicator near the vote controls encouraging re-evaluation.

**Depends on:** VVER-B1 (enrichment now includes `voted_version` on voter objects).

**Implementation:**

1. In `vote-buttons.js`, add a computed getter `myVotedVersion`:
   - Find the current user's voter entry in `this.voters`.
   - Return `voter.voted_version` or `null` if not voted.
2. Add a computed getter `voteIsOutdated`:
   - `this.myVotedVersion !== null && this.myVotedVersion < this._latestVersion()`
3. In `paper-detail.js` template (the paper-level vote area, not review votes), add a small text line below the vote controls:
   - Shown only when `voteIsOutdated` is true.
   - Text: use i18n key `vote.outdatedNotice` with params `{ votedVersion, latestVersion }`.
   - Style: `text-xs text-amber-600` — subtle, informational, not alarming.
   - Example rendering: "You evaluated v2. Paper is now at v4."
4. Add i18n key `vote.outdatedNotice` to all 16 locale files.
   - English: `"Your evaluation is for v{votedVersion}. The paper has been updated to v{latestVersion}."`
   - Translate for all locales.

**What NOT to do:**
- No stale vote count badge on version selector (that was removed intentionally).
- No effect on reputation computation.
- No effect on the `effective_weight` or vote resolution.
- Do not show this indicator on review vote buttons (only the main paper vote area).

### PSORT-B1 — Implement `sort` param on profile reviews endpoint (Backend)

**Goal:** `GET /api/profile/:username/reviews` documents `sort` (`date`, `votes`) but only `order` (asc/desc) is implemented. Add sort-by-votes support.

**Implementation:**

1. In `profile.ts` around line 333, read the `sort` query param: `const sort = (req.query.sort as string) === 'votes' ? 'votes' : 'date';`
2. Pass `sort` into `fetchUserReviewsFromHaf`.
3. In `fetchUserReviewsFromHaf`, change the `ORDER BY` clause:
   - `date` (default): `ORDER BY c.created` (current behavior)
   - `votes`: `ORDER BY net_votes` (the accredited vote subquery result), then `c.created DESC` as tiebreaker
4. Include `sort` in the cache key.

### PSORT-F1 — Wire sort control on profile reviews tab (UI)

**Goal:** The profile reviews tab should offer a sort toggle (date / votes), matching the papers tab pattern.

**Depends on:** PSORT-B1

**Implementation:**

1. In the profile reviews tab template, add a sort dropdown/toggle matching the style of the papers tab sort control.
2. When sort changes, re-fetch `GET /api/profile/:username/reviews?sort=<value>&order=<order>`.

### SRCH-B1 — Add review search support to search endpoint (Backend)

**Goal:** `GET /api/search` documents `type=review` but the code only searches papers/bridge_papers. Add review search.

**Implementation:**

1. In `searchFromHaf`, when `type === 'review'`:
   - Search comments where `(json_metadata -> appTag ->> 'type') = 'review'` and `parent_author != ''` (reviews are replies to papers).
   - The text match (`ILIKE`) applies to `c.body` only (reviews have no title).
   - `discipline` and `language` filters don't apply to reviews (drop them or ignore).
   - `source` filter doesn't apply to reviews.
   - `accredited_only` filters by reviewer author accreditation.
   - Return results with `type: "review"`, plus `paper_author`/`paper_permlink` from `c.parent_author`/`c.parent_permlink`.
2. When `type === 'all'`, run both paper and review queries (UNION or two queries merged).
3. The `SearchResult` shape for reviews:
   ```json
   {
     "type": "review",
     "author": "reviewer1",
     "permlink": "re-...",
     "title": null,
     "snippet": "...matching text...",
     "created": "...",
     "is_accredited": true,
     "paper_author": "scientist1",
     "paper_permlink": "neural-network-plasticity-2026"
   }
   ```
4. Update the search cache key to remain correct.

### SRCH-F1 — Show review results in search UI (UI)

**Goal:** Render review search results alongside paper results. Review results link to the paper with the review highlighted/scrolled-to.

**Depends on:** SRCH-B1

**Implementation:**

1. In the search results template, handle `type === "review"` entries.
2. Show reviewer name, snippet, and a link to the parent paper's review section.
3. Add a type filter dropdown if not already present (all / papers / reviews).

### TYPC-1 — Delete dead types from responses.ts (Backend)

**Goal:** Remove `responses.ts` by relocating the ~15 used types into the files that consume them, then deleting the file and its barrel export.

**Context:** `responses.ts` exports ~50 types. Only these are actually imported outside the file:

| Type | Consumer |
|------|----------|
| `PaperSummary` | `helpers.ts` |
| `NotificationEvent` (union) + `NotificationEventType`, `BaseNotificationEvent`, `NewReviewEvent`, `NewCitationEvent`, `NewVoteEvent`, `AccreditationUpdateEvent`, `NewVouchEvent`, `NewReplyEvent` | `digest.ts`, `notification-queries.ts` |
| `NotificationBatch` | `notification-queries.ts` |
| `BridgeLookupResult` | `bridge.ts` |
| `BridgeLookupAuthor` | `bridge.ts` |

Everything else (`ReviewInPaper`, `PaperVersion`, `PaperDetail`, `PaperEnrichment`, `DiscussionComment`, `ReviewDetail`, `Profile`, `AccreditedResearcher`, `AccreditationRequest`, `AccreditationRequestResponse`, `AccreditationVerifyResponse`, `AccreditationStatus`, `VouchInfo`, `VouchStatus`, `SearchResult`, `Discipline`, `PlatformStats`, `IpfsUploadResponse`, `AnonymousReviewRequest`, `AnonymousReviewResponse`, `BridgeCheckResult`, `BridgeSourceInfo`, `RegisterBridgePaperResponse`, `UpdateBridgePaperResponse`, `SessionResponse`, `HealthCheckResponse`, `OrcidStartResponse`, `OrcidCallbackResponse`, `CitationFormat`, `CitationExportResponse`, `RetractPaperResponse`, `DigestFrequency`, `NotificationPreferences`) is dead code.

**Steps:**

1. **Move `PaperSummary`** into `helpers.ts` (the only consumer). It imports `PaperAuthor` from domain.ts, so add that import in helpers.ts. Remove the `PaperSummary` import from helpers.ts's current `types/index.js` import line.

2. **Move `BridgeLookupResult` and `BridgeLookupAuthor`** into `bridge.ts` (the only consumer). `BridgeLookupResult` references `BridgeLookupAuthor` so they stay together. No domain.ts imports needed. Remove the existing import of these types from bridge.ts's `types/index.js` import.

3. **Move the notification type cluster** (`NotificationEventType`, `BaseNotificationEvent`, `NewReviewEvent`, `NewCitationEvent`, `NewVoteEvent`, `AccreditationUpdateEvent`, `NewVouchEvent`, `NewReplyEvent`, `NotificationEvent`, `NotificationBatch`) into `notification-queries.ts`. That file is the primary owner. `digest.ts` also imports `NotificationEvent`, so after moving, update digest.ts to import from `./notification-queries.js` instead of `./types/index.js`.

4. **Delete `responses.ts`.**

5. **Remove the `export * from "./responses.js"` line** from `types/index.ts`.

6. **Verify build** — run `npx tsc --noEmit` from `backend/`. Fix any import errors.

**Rules:**
- Do NOT add re-exports or compatibility shims. Each type lives in exactly one place.
- Do NOT create new files. Types move into existing consumer files.
- `PaperSummary` needs `PaperAuthor` from domain.ts. The notification types and bridge types have no domain.ts dependencies (confirm before moving).
- If any "dead" type turns out to be used (grep missed it), move it to its consumer instead of deleting it. Do not leave anything behind in responses.ts.

## Review
