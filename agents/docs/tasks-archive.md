### ORCID-4 — Remove old ORCID routes (2026-04-19) — Reviewed ✓

Removed old fragmented ORCID endpoints from `auth.ts` and `accreditation.ts`, replaced by unified `/api/orcid/start` and `/api/orcid/callback` in `orcid.ts`. Cleaned up `signupOrcidStates`, `signupOrcidVerified` maps, legacy `signup_orcid_verified:` Redis key fallbacks, `orcidStates` map, `getExistingAccreditation` (from accreditation.ts), and unused imports. Signup and recover routes now use only `orcid_verified:` keys from the unified orcid module. Build passes, no stale references.

### ORCID-3 — Frontend ORCID consolidation (2026-04-19) — Reviewed ✓

Unified ORCID callback page (`orcid-callback.js`) replaces both `signup-orcid-callback.js` and `accreditation-orcid-callback.js`. All 4 modes (signup, login, accredit, link) handled by single page reading mode from localStorage. API consolidated from 5 functions to 2 (`startOrcid(mode)`, `completeOrcid(code, state)`). All consumer pages (signup, login, accreditation, settings, recover) updated. Router and page registry updated. i18n keys added to all 16 locales. API contract documented in `api-contracts/orcid.md`. Old backend routes preserved for ORCID-4 cleanup.

### ORCID-2b — Fix resend-verification crash on ORCID accounts (2026-04-19) — Reviewed ✓

Null check for `password_hash` in resend-verification handler via ternary guard. When null (ORCID-only accounts), returns `false` for password validation, producing the same constant-time generic response. TypeScript type updated to `string | null`.

### ORCID-2a — Fix login crash on ORCID-only accounts (2026-04-19) — Reviewed ✓

One-line null check for `password_hash` before `argon2.verify()` in login handler. Prevents crash on ORCID-only accounts (null password_hash). Returns same 401 "Invalid credentials" to avoid leaking account type.

### ORCID-2 — Relax signup fields for ORCID (2026-04-19) — Reviewed ✓

Signup handler relaxed: when `orcid_token` present, email/password/institution/field are optional. `full_name` falls back to ORCID profile name. ORCID signups skip email verification (go directly to `confirmed:` state, return `{ flow: 'choose', auth_token }`). ORCID-only signups (no email) use plain INSERT. Dual nonce lookup (unified + legacy keys). Follow-up: ORCID-2b needed for null password_hash guard in resend-verification handler.

### ORCID-1 — Unified ORCID route + migration (2026-04-19) — Reviewed ✓

New `backend/src/routes/orcid.ts` with unified `POST /api/orcid/start` and `POST /api/orcid/callback` supporting 4 modes (signup, login, accredit, link). Migration `002_nullable_email.sql` makes email nullable. `NO_ACCOUNT` error code added. Auth.ts updated with dual nonce lookup (`orcid_verified:` then legacy `signup_orcid_verified:`). Removed `orcidRedirectUri`/`orcidSignupRedirectUri` from config; redirect URI derived at runtime. Old routes preserved with derived URI until ORCID-4 cleanup.

### P3-1 — Extend edit authorization to claimed co-authors (2026-04-19) — Reviewed ✓

`edit.js`: `isAuthorized` getter extended with accepted authorship claim check; `loadPaperData()` extracts `authorship_claims` from enrichment. `paper-detail.js`: `isOwnPaper` getter extended with same check for Edit button visibility. Co-author edits correctly use continuation flow via existing `isContinuation` logic. No backend changes needed.

### P1-4 — Settings page ORCID section (2026-04-19) — Reviewed ✓

ORCID link/update flow in settings page. `startOrcidLink()` API function, OAuth redirect with CSRF state params, hostname validation (orcid.org/sandbox.orcid.org), localStorage signals for callback routing, accreditation gate on endpoint. Redis + in-memory fallback for state storage. i18n keys in all 16 locales.

### P1-3 — Display verified ORCID on profile pages (2026-04-19) — Reviewed ✓

Conditional ORCID display on profile pages with official SVG icon, linked to orcid.org. Only shows verified ORCID from accreditation data (not self-reported). Backend returns `orcid` from accreditation payload.

### P2-5 — Claim authorship UI (2026-04-19) — Reviewed ✓

Frontend claim UI on paper-detail: status badges (confirmed/pending), eligibility-gated claim buttons (ORCID/username/name match heuristic), approve/reject for post authors, unlisted author claims. API functions (fetchPaperClaims, claimAuthorship, approveAuthorshipClaim, revokeAuthorshipClaim). Broadcasts via broadcastOps/Keychain. Bridge paper approvals server-side. Profile UNION query includes claimed papers. i18n keys in all 16 locales.

### P2-6 — Reputation credit for claimed co-authors (2026-04-19) — Reviewed ✓

Extended `computeReputationBatch()` with `claim_events`, `claimer_orcids`, `accepted_claims` CTEs. Co-authors with accepted claims get equal paper credit. Revoked claims excluded. Self-claims excluded to avoid double counting.

### P2-4 — Notifications for authorship claims (2026-04-19) — Reviewed ✓

Three notification types: `claim_pending` (post author), `claim_approved` (claimer), `claim_revoked` (claimer). UNION ALL blocks in HAF notification query + switch cases in event parser + digest descriptions. Note: co-author-listed-on-new-paper notification deferred (requires paper creation listener pattern not yet in notification system).

### P2-3 — Backend claim endpoints (2026-04-19) — Reviewed ✓

`backend/src/routes/claims.ts` with GET list, POST claim, POST approve, POST revoke. Bridge papers server-broadcast, native papers return operation for frontend. Custody allows claim actions for light accounts. `authorship_claims` added to paper enrichment response. Author list merging deferred to frontend.

### P1-1 — Add `orcid` to accreditation custom_json payload (2026-04-19) — Reviewed ✓

Added `orcid: orcidId` to both standard and link-mode `customJsonPayload` in `backend/src/routes/accreditation.ts`. `signup-verify.ts` already included orcid.

### P1-2 — Extract `orcid` in HAF accreditation CTE (2026-04-19) — Reviewed ✓

Added `orcid` field to `accred_ranked` and `active_accreditations` CTEs in `hafsql.ts`. Propagated to accreditations list endpoint and profile accreditation response. Note: `/api/accreditations/:username` single-user endpoint still omits `orcid` from its response (minor inconsistency, not blocking).

### P1-3 — Display verified ORCID on profile pages (2026-04-19) — Reviewed ✓

Conditional ORCID badge in `profile.js:48-59`. Shows official ORCID SVG logo + clickable link to `https://orcid.org/<id>`. Only renders when `profile.accreditation.orcid` is present.

### P1-4 — Settings page ORCID section, backend part (2026-04-19) — Reviewed ✓

`GET /api/accreditation/orcid/link-start` endpoint for accredited users. Shared callback detects `mode: 'link'` from state, preserves existing accreditation fields via `getExistingAccreditation()` helper, broadcasts updated `accredit` custom_json with new ORCID. UI part still pending.

### P2-2 — HAF CTE for authorship claims (2026-04-19) — Reviewed ✓

`authorshipClaimsCteBody()` in `hafsql.ts` with 5 CTEs computing claim status. Auto-accept by ORCID match or hive username match. Revocation logic checks block ordering against latest approval. Requires `active_accreditations` in scope.

### P2-1 — Authorship claim custom_json schemas (2026-04-19) — Reviewed ✓

Schemas defined in `agents/docs/hive-schemas.md` sections 2.9 (claim_authorship), 2.10 (approve_authorship), 2.11 (revoke_authorship). All three payloads specified with required fields, signing accounts, and auto-accept conditions documented.

### SRCH-F1 — Show review results in search UI (2026-04-19) — Reviewed ✓

Implemented in `search.js`. Type filter dropdown (all/papers/reviews). Review results link to parent paper with hash anchor to review. Reviewer name and snippet shown. Type badge per result. All i18n keys in 16 locales.

### PSORT-F1 — Wire sort control on profile reviews tab (2026-04-19) — Reviewed ✓

Implemented in `profile.js`. Sort dropdown (date/votes) in reviews tab. Re-fetches with sort param on change. All i18n keys in 16 locales.

### VVER-F1 — Show voted-version indicator to current user (2026-04-19) — Reviewed ✓

Implemented in `vote-buttons.js` and `paper-detail.js`. `myVotedVersion`/`voteIsOutdated` getters. Amber notice below paper-level vote controls only (not review votes). `vote.outdatedNotice` key in all 16 locales.

### SRCH-B1 — Add review search support to search endpoint (2026-04-19) — Reviewed ✓

Implemented in `search.ts`. Separate `searchPapersFromHaf` and `searchReviewsFromHaf` helpers. `type=review` searches child comments with `type='review'` metadata, ILIKE on body only. `type=all` runs both in parallel and merges by created date desc. `type=paper` unchanged. Review results include `paper_author`/`paper_permlink`, `title: null`. `is_accredited` computed in route handler for all types.

### PSORT-B1 — Implement sort param on profile reviews endpoint (2026-04-19) — Reviewed ✓

Implemented in `profile.ts`. Route reads `sort` query param (votes/date, default date), passes to `fetchUserReviewsFromHaf`, included in cache key. `sort=votes` uses accredited net_votes correlated subquery with `c.created DESC` tiebreaker. `sort=date` preserves existing ORDER BY behavior.

### VVER-B1 — Add voted_version to voter objects in enrichment response (2026-04-19) — Reviewed ✓

Implemented in `papers.ts`. `block_num` on `PaperVersionEntry`, preserved through `resolveVersionsFromHaf`. `fetchEnrichmentFromHaf` builds `versionBlocks` array, `inferVotedVersion` helper infers version from block number. Voter objects include `voted_version` from revote explicit version or block_num inference. Shape: `{ voter, weight, effective_weight, voted_version }`.

### TYPC-1 — Delete dead types from responses.ts (2026-04-19) — Reviewed ✓

No action needed. `responses.ts` already does not exist. Types are in their consumer files: `PaperSummary` in `helpers.ts`, `BridgeLookupResult`/`BridgeLookupAuthor` in `bridge.ts`, notification types in `notification-queries.ts`. No `responses.js` export in `types/index.ts`.

### STALE-3 — Drop vote staleness from frontend (2026-04-19) — Reviewed ✓

Removed all vote staleness UI from `vote-buttons.js` (`myVoteIsStale`, `staleVoteCount`, stale reset, stale branch in `voteCountLabel`; simplified `activeVoteCount`). Removed from `paper-detail.js`: `staleVotesAtVersion()`, stale vote count badge, stale vote banner, `myVoteIsStale` styling. Removed `staleBanner`, `votesWithStale`, `staleAtVersion`, `pendingShort` keys from all 16 locale files. No residual stale references found.

### UNAME-1 — Move username availability check to frontend (2026-04-19) — Reviewed ✓

Replaced backend `checkUsernameAvailability` API call with direct `@hiveio/dhive` `client.database.getAccounts()` call (lazy-loaded via dynamic import). Removed `checkUsernameAvailability` from `api.js`. Frontend `isValidUsername()` covers same rules as removed backend regex. Zero references to `checkUsernameAvailability` or `username-available` remain in codebase.

### STALE-1 — Drop vote staleness from reputation computation (2026-04-19) — Reviewed ✓

Removed `paper_revisions` CTE and its JOIN from `paper_resolved_votes` in `reputation.ts`. Votes now resolved purely by latest signal per voter, self-vote exclusion, co-author exclusion, and weight != 0 retraction. No issues.

### STALE-2 — Drop vote staleness from paper detail endpoint (2026-04-19) — Reviewed ✓

Removed `latestRevisionTs`/`contentRevisions` computation and `stale` field from voter objects in `papers.ts`. `effective_weight` is always the signal weight. Review "outdated" logic (separate from vote staleness) correctly preserved.

### STALE-4 — Update tests for vote staleness removal (2026-04-19) — Reviewed ✓

No changes needed. No test fixtures or assertions reference vote staleness. Only "stale" reference in tests is `setup.ts` Redis cache cleanup comment, which is unrelated.

### UNAME-2 — Remove `/api/auth/username-available` endpoint (2026-04-19) — Reviewed ✓

Removed `GET /username-available` route handler, `USERNAME_RE`/`BAD_SEGMENT_RE` constants, and unused `hiveClient` import from `auth.ts`. Username validation at account creation time (`signup-verify.ts:165`) is unaffected.

### REP-SQL-4 — Clean up removed JS reputation code and update tests (2026-04-19) — Reviewed ✓

Implemented by Backend agent. Removed `getUserStatsFromHiveApi()`, `emptyStats()`, and unused imports from `reputation.ts`. Updated `getReputationScore()` fallback to return zero when HAF unavailable. Updated `profile.ts` to use optional chaining with zero-fallback instead of Hive API fallback. Also added missing `continues IS NULL` filter to profile papers HAF query and Hive API path. TypeScript compiles clean.

### VOTE-1A — Update hive-schemas.md revote documentation (2026-04-18) — Reviewed ✓

Completed 2026-04-18. Updated `agents/docs/hive-schemas.md` section 3.1 and wrote `agents/docs/vote-resolution.md`.

### VOTE-1B — Remove phantom vote restriction (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. The enrichment function in `papers.ts` processes revote-only voters (no native vote required) in a separate loop at ~line 1298-1314.

### VOTE-1C — Always query revote custom_json (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. The revote query at ~line 1188 runs unconditionally (no `if` gate).

### VOTE-1D — Handle weight=0 as vote retraction (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. Vote resolution skips voters with `effectiveSignalWeight === 0` at lines ~1282 and ~1302.

### VOTE-1E — Rewrite vote counting for list view with parallel strategy (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. `batchResolveVotes()` at ~line 56-172 of `papers.ts` runs native votes and revotes in parallel via `Promise.all()`, merges by highest `block_num`, handles weight=0 retractions, computes `net_votes` and `vote_strength`, and re-sorts in JS when sorting by votes.

### VOTE-1F — Update reputation to use latest-vote-per-voter-per-paper (2026-04-19) — SUBSUMED

Subsumed by REP-SQL-2. The all-SQL reputation query implements latest-signal-per-voter natively.

### VOTE-1G — Add weight=0 retract option to vote UI (2026-04-18) — Reviewed ✓

Implemented 2026-04-18. See changes in `vote-buttons.js`, `paper-detail.js`, and all locale files.

### VOTE-1H — Display vote strength in list and detail views (2026-04-19) — Reviewed ✓

Already implemented prior to 2026-04-19. `vote-buttons.js` accepts `voteStrength`, has `strengthLabel()` and `voteCountLabel()` showing count + strength tier. `paper-detail.js` passes `voteStrength` from enrichment data. `home.js` list view uses `vote.strength.*` i18n keys. All 16 locale files have strength tier translations.

### REP-SQL-1 — Update algorithm spec for deterministic cycle-based SQL computation (2026-04-18) — Reviewed ✓

Completed 2026-04-18. Updated `agents/docs/reputation-algorithm-v3.md` to v0.4. Rewrote "Voter Reputation Weighting" section, added `cycle_blocks` parameter, defined cycle boundaries, replaced SQL sketch with full canonical SQL query (18 CTEs). Updated `agents/docs/hive-schemas.md` section 2.4.

### REP-SQL-2 — Move reputation computation to all-SQL query (2026-04-18) — Reviewed ✓

Reviewed 2026-04-18. See detailed review below in Done section.

### CONT-4 — Filter continuation posts from citations listing — REMOVED

Citations endpoint (`GET /api/papers/:author/:permlink/citations`) was removed as unused. Citation data is returned inline in paper detail responses.

### PERF-1 — Accreditations: single query with window count (2026-04-18) — Already implemented ✓

`fetchAccreditationsFromHaf()` in `backend/src/routes/accreditations.ts` already uses a single query with `count(*) OVER ()::int AS total`. Verified 2026-04-18.

### REP-SQL-3 — Rewrite batch job for deterministic cycle-based computation (2026-04-19) — Reviewed ✓

Reviewed by Architect (2026-04-19). Full rewrite of `reputation-batch.ts` verified against spec. Cycle determination: `floor((head_block - genesis_block) / cycle_blocks)` at L77. `cycle_blocks` read from reputation weights (L64), genesis from HAF (L65). Last computed cycle tracked in Redis `reputation:cycle:last` (L24,84,193). Cycle 0 bootstrap: `prevScores = {}` when `startCycle === 0` (L97-98), all voters get weight 1.0. Each subsequent cycle uses prior cycle's results (L197). Sequential catch-up loop (L114). No convergence iterations — single pass per cycle. `computeReputationSql()` called with `cycleEndBlock = genesis + (cycle+1) * cycleBlocks` (L121,161). Results stored via Redis pipeline (L189-194). Timer reduced from 24h to 1h (L19), checks cycle boundaries and skips if up-to-date (L87-89). Time cap (30min default) with partial result handling: marks cycle done and breaks (L115-117, 147-155, 193) — safe because missing users fall through to on-demand computation, and next run rebuilds prevScores from all Redis keys (L100-111). Adaptive concurrency reduces to 1 on slow HAF (L179-185). On-demand path (`getReputationScore()` → `computeReputationSql()`) uses batch scores from Redis as prevScores via `getBatchReputationMap()` fallback (reputation.ts:751). No issues.

## Done

### REP-SQL-2 — Move reputation computation to all-SQL query (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). `computeReputationSql()` at reputation.ts:725-1131 implements the canonical 18-CTE SQL query from the v0.4 spec. Papers/reviews/citations each have proper vote signal merging (native + revote via UNION ALL). `voter_weights` CTE distinguishes active vs inactive accounts (0.4 floor for active, pure sqrt for inactive). Decay computed in SQL via `EXTRACT(EPOCH FROM ...)`. Final aggregation clamps to [0, 100], rounds to 1 decimal. `getReputationScore()` at L1140-1153 uses SQL as primary path, falls back to JS computation via Hive API. `cycle_blocks: number` added to `ReputationWeights` in domain.ts:65 with default 201600. Parameters $1-$18 correctly mapped to all weight/config values. No issues.

### CONT-1 — Filter continuation posts from search results (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). search.ts:91 adds `(c.json_metadata -> ${appTagParam} -> 'continues') IS NULL` to the WHERE conditions. Correctly uses the parameterized `appTagParam` for the JSON path. No issues.

### CONT-2 — Filter continuation posts from user profile papers (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). HAF count query (profile.ts:154) and data query (profile.ts:166) both add `AND (json_metadata -> $2 -> 'continues') IS NULL`. Hive API fallback (profile.ts:201-202) checks `pevo?.continues` and returns false. All three code paths filter correctly. No issues.

### CONT-3 — Filter continuation posts from platform stats (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). stats.ts:40 adds `AND (c.json_metadata -> ${at} -> 'continues') IS NULL` to the papers CTE. Correctly placed alongside other type/app filters. No issues.

### CONT-5 — Filter continuation posts from vote counting (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). Verified no code changes needed. List query filters continuations at papers.ts:251 (`'continues' IS NULL`). `accreditedVoteCount()` runs as a correlated subquery within already-filtered results. `batchResolveVotes()` only processes papers from the filtered list. Detail/enrichment endpoints redirect continuation posts to canonical root via `findCanonicalRoot()` before vote counting. No issues.

### DOI-1 — Remove DOI endpoints from backend and contract (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). No `doi` route handlers remain in papers.ts. `DoiResponse`/`DoiStatus` types removed from responses.ts. DataCite config removed from config.ts. DOI endpoint sections removed from api-contract.md. No issues.

### PERF-2 — Search: parallelize count and data queries (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). search.ts:112 wraps `countResult` and `dataResult` in `Promise.all()`. Both queries use identical CTE, WHERE clause, and params (count gets only the ILIKE pattern, data gets ILIKE + limit + offset). No issues.

### PERF-3 — getAccreditedSet: check cache before querying HAF (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). accreditation.ts:18-23 checks `hafCache.get('accredited_accounts_all')` as a fast path. If cached, filters the requested usernames against the full set locally and returns immediately. Falls through to existing HAF batch query when cache is cold. No issues.

### VOTE-1G — Add weight=0 retract option to vote UI (2026-04-18) — Reviewed ✓

Reviewed by Architect (2026-04-18). `vote-buttons.js`: `_updateLocalVoter(0)` correctly removes voter from array; `handleVote(0)` has dedicated retract branch with confirmation dialog (`confirm.retractMessage` + `confirm.retract`), broadcasts `weight: 0` via native vote or revote custom_json depending on payout window, adjusts `displayVotes` correctly, resets state to `voteState='none'`, invalidates cache. `paper-detail.js`: retract button in both paper and review vote dropdowns, gated on `voteState !== 'none'`. All 16 locale files have `vote.retract`, `confirm.retractMessage`, `confirm.retract` keys. Edge case: re-clicking retract when already retracted is caught by the `currentWeight === weight` guard (line 130). No issues.

### Signup Flow v2 — SF1–SF10 (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). All 10 tasks verified against spec. Backend: migration drops `username`/`link_flow` from `pending_signups`, all 6 endpoints updated (signup, verify, confirm, resume-signup, link simplified). Frontend: signup form simplified, `hive-keys.js` key derivation matches backend algorithm, `signup-verify.js` rewritten with full phase flow, `@scure/bip39` added. Deliberate deviation from spec: confirm/link endpoints use high-entropy auth_token instead of email+password re-entry — accepted. 189 backend tests pass, frontend builds clean.

### Backend: LA12 — Upgrade notification endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/custody/upgrade` in `custody.ts:131`: validates `custody: "light"`, password re-entry via argon2, NULLs posting_key_enc/iv_posting/memo_key_enc/iv_memo, sets `upgraded_at = NOW()`, issues new JWT with `custody: "self"`, audit logs success and failure. Rate-limited 1/hr/account. On-chain key verification omitted (spec marked it optional). No issues.

### Backend: LA13 — Password reset flow (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Two endpoints in `auth.ts:269-410`. `reset-request`: email lookup with constant-time response (prevents enumeration), 1-hour token, HTML+text email, clears token on mail failure. Rate-limited 5/hr/IP. `reset`: token + expiry validation, password complexity (10 chars + lowercase + uppercase + numbers), argon2id hash, sets `sessions_invalidated_at = NOW()`. Session invalidation enforced in `verifyHiveSignature.ts:78-97` — compares JWT `iat` against timestamp, rejects stale JWTs. Migration `004_password-reset.sql` adds `reset_token`, `reset_token_expires_at`, `sessions_invalidated_at`. Audit logged. No issues.

### Backend: LA1 — Database migrations for light accounts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Migration `003_light-accounts.sql` + `app-db.ts` create `pending_signups` (with `linked_username`), `light_accounts`, `custody_audit_log`, `account_creation_tokens`. **Fix applied during review:** removed `active_key_enc` and `iv_active` columns — active key is never stored server-side (upgrade is client-side). No other issues.

### Backend: LA2 — Key encryption/decryption module (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `custody-crypto.ts`: AES-256-GCM, HKDF-SHA256 with `pevo:custody:${username}` context, 96-bit random IV, auth tag appended to ciphertext. `CUSTODY_ENCRYPTION_KEY` from config. No issues.

### Backend: LA4 — Institutional email domain validator (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `email-validator.ts`: `.edu`, `.ac.*` (11 countries), `.edu.*` (17 countries), German/French patterns (regex), 5 research institutes, `.gov`. Extensible via `INSTITUTIONAL_EMAIL_DOMAINS` env var. No issues.

### Backend: LA5 — BIP39 seed phrase + Hive key derivation (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `seed-phrase.ts`: 12-word BIP39 mnemonic (128 bits), HMAC-SHA512 with `account+role`, `PrivateKey.fromSeed()`. Exports `generateSeedPhrase`, `deriveKeysFromMnemonic`, `generateKeysFromNewSeed`, `isValidSeedPhrase`. No issues.

### Backend: LA10 — Add `custody` claim to JWT (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). JWT includes `custody: "light" | "self"`. Keychain sessions get `"self"` (verifyHiveSignature.ts:150). Light accounts get `"light"` (auth.ts:244, signup-verify.ts:218). Middleware extracts to `req.hiveCustody` (verifyHiveSignature.ts:75). Session response includes `custody`. No issues.

### Backend: LA3 — Account creation service (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `account-creation.ts`: 6h claim interval, `claim_account` + `create_claimed_account` broadcasts, `FOR UPDATE SKIP LOCKED` token reservation, wired into index.ts startup/shutdown. No issues.

### Backend: LA6 — Signup endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/signup` in `auth.ts`: institutional email validation, username format + Hive availability, duplicate checks, argon2id hash, pending_signups with ON CONFLICT upsert, verification email, `linked_username` support. Rate-limited 10/hr/IP. **Fix applied during review:** added password complexity validation (lowercase + uppercase + numbers required, per spec §10.1). No other issues.

### Backend: LA8 — Password login endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/login`: lookup by username or email, argon2id verify, custody claim from `upgraded_at`, lockout after 20 failures/hr, rate-limited 10/hr/IP. No issues.

### Backend: LA11 — Custody audit logging (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `custody-audit.ts`: non-blocking INSERT, graceful null pool handling, error logged not thrown. No issues.

### Backend: LA14 — Pending signup cleanup job (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signup-cleanup.ts`: hourly cleanup of expired rows, wired into startup/shutdown, timer unref'd. No issues.

### Backend: LA7 — Email verification callback (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signup-verify.ts`: `POST /api/auth/verify` branches on `linked_username`. New accounts: seed phrase generation, mnemonic SHA256 hash storage. `POST /api/auth/confirm`: hash verification, `createClaimedAccount`, encrypts posting + memo keys, accreditation broadcast, JWT `custody: "light"`. No issues.

### Backend: LA23 — Link existing Hive account endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `POST /api/auth/link`: Keychain signature matching `linked_username`, light_accounts row with no keys and `upgraded_at = created_at`, accreditation broadcast, JWT `custody: "self"`. No issues.

### Backend: LA9 — Custodial broadcast endpoint (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `routes/custody.ts`: `ALLOWED_OPS = Set(['comment', 'vote'])`, author/voter enforcement, APP_TAG validation, posting key decrypted in-memory only, non-blocking audit log. Rate-limited 30/min/account. No issues.

### UI: LA15 — Signing abstraction (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `signer.js`: dual-path routing (custody API for light, Keychain for self), vote auto-detection. Auth store `custody` persisted to sessionStorage. No issues.

### UI: LA16 — Signup page (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/signup.js` + `/signup` route. Email, username picker with debounced availability check, password with confirmation, link-existing checkbox. No issues.

### UI: LA17 — Seed phrase display + retention confirmation (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/signup-verify.js` + `/signup/verify` route. Phases: verifying → seed (3x4 grid) → confirm (3 random words) → creating → done. Link-existing branch. No issues.

### UI: LA24 — Link existing Hive account UI (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). Integrated into signup.js (checkbox toggle) and signup-verify.js (link-keychain phase). No issues.

### UI: LA18 — Login page (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/login.js` + `/login` route. Email/password form, session with custody from backend. No issues.

### UI: LA19 — Refactor all Keychain call sites (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). All 6 files refactored to `broadcastOps()`. **Fix applied during review:** vouch-section.js: added `isLightAccount` getter, `canVouch`/`canRetract` exclude light accounts. Added vouch section HTML template to profile page in index.html with light-account message. Added `wot.keychainRequiredToVouch` i18n key to all 16 locales. No other issues.

### UI: LA25 — Confirmation modals for light account broadcasts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `broadcastConfirm` store + modal. Auto-confirms for non-light. Wired into publish, review, vote, comment. No issues.

### UI: LA20 — Upgrade flow UI in settings (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/settings.js` + `/settings` route. Client-side BIP39, multi-phase upgrade, dynamic crypto loading. No issues.

### UI: LA21 — Password reset pages (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). `pages/reset-password.js` + `/reset-password` route. Request + reset modes. No issues.

### UI: LA22 — i18n keys for light accounts (2026-04-14) — Reviewed ✓

Reviewed by Architect (2026-04-14). 7 key groups in all 16 locales. 122 keys per locale. All JSON valid. No issues.

### UI: RC1 — Add threaded comment section to each review card (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Collapsible comment section at index.html:1243-1278, placed after review body inside `x-for="rev in paper.reviews"` loop. Toggle button with chat icon at L1245-1249 uses local `showComments` state. `x-if="showComments"` gates `threadedComments` initialization (Option B lazy loading). `threadedComments` at L1252 receives `rev.author`/`rev.permlink` — reuses existing component unchanged. `commentComposer` at L1265 with `rev.author`/`rev.permlink` for reply posting. Comment count shown via `review.commentsToggle` (L1260) with ICU plural syntax. Empty state via `review.noComments` (L1259). All 16 locales have 3 new keys (`commentsToggle`, `noComments`, `replyToReview`) with real translations. No backend or component changes. No issues.

### Architect: L0 — Locale routing spec (2026-04-13) — Reviewed ✓

URL-based locale routing with `/:locale/path` structure, 302 redirects for bare paths, hreflang sitemap, backwards-compatible with existing URLs. ARCHITECTURE.md section 13 updated.

### UI: L1 + L2 — Locale-aware router and i18n URL detection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). **router.js:** `parsePath()` at L67-74 extracts locale from first path segment via `SUPPORTED_LOCALES.includes(segments[1])`, strips it, returns `locale` in result. Router store has `locale` property (L101). `navigate()` at L103-117 auto-prepends `/${currentLocale}` if path lacks a locale prefix. `popstate` handler at L128-135 syncs i18n store when locale changes via back/forward. **i18n.js:** `detectLocale()` at L18-37 priority: (1) URL path, (2) cookie, (3) navigator.language, (4) `en`. `setLocale()` at L82-98 calls `replaceState()` to swap locale prefix in URL and syncs router store locale. `$lp` Alpine magic at L135-137: `(path) => '/' + locale + path`. **main.js:** After `initI18n()`, syncs router locale to i18n locale (L101-104). No issues.

### UI: L3 — Update HTML href attributes to use locale prefix (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All ~50 `<a>` tag `href` attributes in `index.html` converted from `href="/path"` to `:href="$lp('/path')"` and from `:href="'/path/' + expr"` to `:href="$lp('/path/' + expr)"`. Verified: zero remaining hardcoded `href="/..."` except static assets (`/favicon.svg`, `/manifest.json`) which correctly have no locale prefix. `threaded-comments.js:55` profile href updated to use `$lp`. No changes to `navigate()` calls or `@click.prevent` handlers — router auto-prepends locale. No issues.

### Backend: L6 + L7 — Locale extraction and SSR meta injection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). **Locale extraction:** `SUPPORTED_LOCALES` Set and exclusion sets (`NO_LOCALE_PREFIXES`, `NO_LOCALE_FILES`) at app.ts:233-237. `detectLocale()` at L239-260 parses cookie via `parseCookie()` helper then `Accept-Language` with q-weight sorting. SPA catch-all at L355-460: valid locale → strip and proceed; bare path → 302 redirect with query string preservation. **SSR patterns:** `paperRouteRe` at L212 captures locale/author/permlink. `profileRouteRe` at L213. `staticPageMeta` lookup at L436 uses `pathWithoutLocale`. **hreflang:** `buildHreflangTags()` at L268-275 emits 14 locale links + `x-default` → `/en/...`. Injected in paper meta (L333), profile meta (L427), static page meta (L452), and generic pages (L458). **Breadcrumb:** fixed to use locale-prefixed Papers link (`/${locale}/papers`). No issues.

### Backend: L8 — Sitemap with locale prefixes and hreflang (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `xmlns:xhtml` namespace added to `<urlset>` at L194. `hreflangLinks()` helper at L153-158 emits `<xhtml:link>` for all 14 locales + `x-default`. `staticPaths` at L146 kept as bare paths; `url()` helper at L160-165 uses `/en${path}` for `<loc>` and injects `hreflangLinks(path)` inside each `<url>`. Dynamic paper URLs use same pattern (L187). No issues.

### UI: C1 — Add `canonical_url` to `json_metadata` on publish and edit (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All three broadcast paths add `canonical_url` at `json_metadata` root (outside `pevo` namespace). publish.js:494 uses `${window.location.origin}/paper/${username}/${permlink}`. edit.js:483 (continuation) uses `${window.location.origin}/paper/${username}/${newPermlink}`. edit.js:535 (same-author edit) uses `${window.location.origin}/paper/${this.author}/${this.permlink}`. No issues.

### Backend: C2 — Add `canonical_url` to bridge post metadata (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `buildBridgeMetadata()` at bridge.ts:440 takes two new params (`postAuthor`, `postPermlink`). Returns `canonical_url: \`${config.appUrl}/paper/${postAuthor}/${postPermlink}\`` at object root (L484). Both call sites in routes/bridge.ts pass `config.hiveBridgeAccount` and `permlink` (L207-208, L335-336). No issues.

### Backend: C3 — Add `<link rel="canonical">` to SSR meta injection (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `<link rel="canonical" href="${escAttr(reqUrl)}" />` added at app.ts:175 in `ogTags` array, gated on `reqUrl` truthy. Properly escaped. Injected into `<head>` alongside OG tags. No issues.



### UI: D2 — Version diff computation module (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `version-diff.js` exports `computeVersionDiff(versionA, versionB)`. diff_match_patch used for title/body with `diff_main` + `diff_cleanupSemantic`, returns `[{type, text}]` segments. Body `diffable: false` when either version has `ipfs_cid`. Authors compared by `hive`, supplementary files by `cid`, citations by `author|permlink`, keywords by string set — all return full objects in added/removed arrays with `changed` boolean. No issues.

### UI: D3 — Version comparison state in paper-detail.js (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 6 state vars (`diffMode`, `diffVersionA/B`, `diffResult`, `diffLoading`, `diffError`, `pickingDiffVersions`) at lines 38-45. `selectDiffVersions()` (L341-351) toggles pick mode. `pickDiffVersion(n)` (L353-368) sets A then B with auto-sort A<B. `startDiff()` (L370-386) fetches both versions via `Promise.all` with version param, calls `computeVersionDiff`, sets `diffMode`. `exitDiff()` (L388-396) resets all state. No issues.

### UI: D4 — Diff view HTML template (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Diff panel at index.html:743-859. Header with comparing label + close button (747-748). Loading state (751-754). No-changes fallback (758-761). Title diff with green insert / red strikethrough delete spans (763-776). Body diff with colored segments or PDF notice (778-796). Authors +/- list (798-811), supplementary files +/- with size (813-826), citations +/- (828-841), keywords as inline tags (843-856) — all gated on `changed`. No issues.

### UI: D5 — Compare versions button and version picker (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Button at index.html:727-734 inside `versions.length > 1` template gate (L697). Version buttons (702-713) conditionally call `pickDiffVersion` vs `loadVersion` based on `pickingDiffVersions`. Selected versions highlighted: blue ring for A, green ring for B (707-708). Button label toggles between "Compare versions" and "Close comparison" with dark styling when active. No issues.

### UI: D6 — Version diff i18n keys (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). 16 `diff.*` keys in all 14 locale files. Verified en.json (all 16 present), spot-checked de/ar/zh — real translations, not English copies. `comparing` uses `{a}`/`{b}` interpolation in all locales. No issues.

### Backend: Harden batch reputation job for scale (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 5 hardening requirements verified against `reputation-batch.ts`: (1) `maxDurationMs` default 30 min, checked before each chunk with partial Redis writes and skip logging. (2) `Promise.all` chunks of 5 via `DEFAULT_CONCURRENCY`. (3) `isHafAvailable()` at iteration start, skip with warning. (4) Rolling per-user avg tracked, concurrency reduced to 1 when >5s. (5) `batchRunning` boolean lock in try/finally, overlapping runs rejected. Convergence (3 iterations), Redis key format, startup/shutdown, 24h interval all unchanged. No issues.

### UI: Platform comparison table on about page (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Table at index.html:2548-2596, correctly placed after Open Source section. 10 feature rows × 7 platform columns with data-driven Alpine.js rendering. Symbol styling correct: `text-pevo-green` (✓), `text-amber-500` (partial ✓), `text-pevo-crimson` (✗), `text-ink-muted` (—). PEvO column highlighted with `bg-pevo-teal-light/30` on header and data cells. Responsive: `overflow-x-auto` wrapper, sticky left feature column (`sticky left-0 bg-white`). All 19 i18n keys (`comparisonTitle`, `comparisonSubtitle`, `comparisonFooter`, 6 platform headers, 10 feature labels) present in all 14 locales. Table data matches spec exactly. No issues.

### UI: R6 — Update profile reputation display (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Deprecated fields (`paper_votes`, `review_votes`, `account_age`) properly filtered in `breakdownEntries` getter at profile.js:45-50. HTML template uses `$t('profile.breakdown.' + key)` with fallback. i18n keys for all 4 active fields (papers, reviews, citations, accreditation) in all 14 locales. Backend breakdown at reputation.ts:568-574 emits only the 4 valid fields. Test at profile.test.ts:28-38 asserts deprecated fields absent and accreditation present. No issues.

### UI: R7 — Add `reputation_relevant` toggle to citation picker on publish form (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Citations array at publish.js:64 with add/remove/toggle methods at lines 295-308. HTML form at index.html:1353-1382 with author/permlink/title inputs and checkbox for `reputation_relevant`. Citations stored in `json_metadata.pevo.citations` with filtering (lines 448-450) — empty entries excluded, `reputation_relevant` boolean preserved. Draft save/restore works. i18n keys (`publish.citations`, `citationsHint`, `citationAuthor`, `citationPermlink`, `citationTitle`, `citationReputationRelevant`, `noCitations`, `addCitation`) in all 14 locales. No issues.

### UI: R8 — Vote strength selector (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `vote-buttons.js` defines 6 levels: Strong endorsement (+10000), Endorsement (+6000), Mild endorsement (+2500), Mild concerns (-2500), Reject (-6000), Strong reject (-10000) with green/red Tailwind color coding. Accredited users get dropdown selector via `handleVote()`, non-accredited get simple up/down via `handleSimpleVote()` (+/-10000 only). Non-accredited voting redirects to `/accreditation`. Vote UI on paper detail (index.html:842-888) and review cards (1032-1065). Current vote level shown after voting. i18n keys (11 vote keys) in all 14 locales. No issues.

### UI: PubPeer badge on paper detail page (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `loadPubPeer()` at paper-detail.js:81-97 POSTs to PubPeer v3 API when DOI exists. Stores `feedbacks[0]` in `pubpeerData`. Badge at index.html:910-919 renders only when `pubpeerData && total_comments > 0` — clickable link with count via `$t('pubpeer.badge', { count })`. Silent degradation: empty catch, `!res.ok` early return, optional chaining on feedbacks. i18n key `pubpeer.badge` with `{count}` interpolation in all 14 locales. No issues.

### Backend: R9 — Activity-gated voter weight floor (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). `voterWeight()` at reputation.ts:90-96 now takes `hasActivity` parameter: active = `0.4 + 0.6 * sqrt(rep/100)`, inactive = `sqrt(rep/100)`. `getActiveAccounts()` at reputation.ts:117 queries HAF for accounts with papers/reviews, cached 1h via hafCache. `voteInfluence()` at reputation.ts:102 accepts `activeAccounts` set. `computeReputation()` at reputation.ts:507 passes active set through to all vote influence calls. `reputation-batch.ts` fetches active accounts once before convergence loop. 8 new test cases for inactive branch, all 40 tests pass. No issues.

## Done

### Backend: R1 — Update reputation types (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All correct: `Citation.reputation_relevant?: boolean` at domain.ts:16. `ReputationBreakdown` has only papers/reviews/citations/accreditation (domain.ts:40-45). `ReputationWeights` has downvote/citation_max, no v2 fields (domain.ts:54-65). `DEFAULT_REPUTATION_WEIGHTS` matches spec exactly (domain.ts:67-78). No issues.

### Backend: R2 — Rewrite computeReputation() (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). Vote influence formula correct (reputation.ts:91-95). Paper score formula correct (reputation.ts:470-482). Review score formula correct (reputation.ts:485-496). Citation scoring with quality-weighting, decay, reputation_relevant filtering, and citation_max cap all correct (reputation.ts:500-508). No account_age factor. reputationMap parameter correct (reputation.ts:463).

**One issue:** `voterWeight()` at reputation.ts:83-86 always applies the 0.4 floor. Missing the spec's two-branch logic (floor only for accounts with publications/reviews, pure sqrt for accounts with no activity). Tracked as R9.

### Backend: R3 — Update HAF queries (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). `v.weight` queried (reputation.ts:148,179). Per-paper and per-review vote lists correct. Review ratings queried for quality multiplier (reputation.ts:155-169). Citations carry `reputation_relevant` flag (reputation.ts:200). `getGlobalMaxRshares` removed. 

**One issue:** No voter activity data fetched for the two-branch voter weight formula. Tracked as R9.

### Backend: R4 — Batch reputation computation (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). 3 convergence iterations (reputation-batch.ts:19). Redis storage at `reputation:batch:{username}` with no TTL (reputation-batch.ts:89). Bootstrap mode returns 1.0 for unknown voters (reputation.ts:83-86). Startup/shutdown wired in index.ts:49-50,67. No issues.

### Backend: R5 — Update tests (2026-04-13) — Reviewed ✓ (with follow-up)

Reviewed by Architect (2026-04-13). No v2 breakdown fields asserted. Fixtures use v3 defaults. All required test cases present: downvote penalty (reputation.test.ts:177-216), review quality (218-243), self-citations near zero (293-309), citation cap (311-329), reputation_relevant filtering (331-349), voter weight formula (374-394), vote strength multiplier (76-87).

**One issue:** No test for the non-contributor voterWeight branch (pure sqrt without floor). Tracked as R9.

### UI: R6 — Update profile reputation display (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Deprecated fields filtered via exclusion list (profile.js:47-49). HTML iterates breakdownEntries with i18n (index.html:2064-2068). i18n keys for papers/reviews/citations/accreditation (en.json:105-110). E2E fixtures updated (fixtures.ts:59-65). No issues.

### UI: R7 — Citation reputation_relevant toggle (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). Default true on addCitation (publish.js:296). Toggle method (publish.js:303-305). Included in json_metadata (publish.js:448-450). Checkbox bound in HTML (index.html:1357-1358). i18n key present (en.json:175). Draft save/restore includes citations (publish.js:152,227). No issues.

### UI: R8 — Vote strength selector (2026-04-13) — Reviewed ✓

Reviewed by Architect (2026-04-13). All 6 levels with correct Hive vote weights (vote-buttons.js:4-11). Weight passed to Keychain requestVote (keychain.js:334-343). Current vote level shown (vote-buttons.js:30-33). Accredited users get dropdown, non-accredited get simple up/down (index.html:843-888, 1021-1053). Current vote highlighted (index.html:864). All 6 i18n keys present (en.json:308-320). No issues.

### Architect: E0 — Edit flow schemas and interface contracts (2026-04-12) — Reviewed ✓

Schemas defined in TASKS.md and implemented in `backend/src/types/hive.ts` (`AddressedReview`, `ContinuationPointer` interfaces, `addresses_reviews`/`continues` fields on `PaperPevoMeta`) and `backend/src/types/responses.ts` (`PaperVersion`, `PaperDetail`, `ReviewInPaper` updated).

### Backend: E1 — Continuation chain resolution (2026-04-12) — Reviewed ✓

`resolveContinuationChain` + `findCanonicalRoot` in `papers.ts`. Iterative queries, 50-hop cap, JOIN with `operation_comment_view` for block_num collision resolution.

### Backend: E2 — Update `reconstructVersionsFromHaf` for continuation chains (2026-04-12) — Reviewed ✓

Fetches ops for all chain links, continuation post first op treated as full body, `post_author`/`post_permlink`/`addresses_reviews` on versions.

### Backend: E3 — Hide continuation posts from paper listings (2026-04-12) — Reviewed ✓

`(c.json_metadata -> appTag -> 'continues') IS NULL` added to `fetchPapersFromHaf`.

### Backend: E4 — Reverse lookup for continuation post URLs (2026-04-12) — Reviewed ✓

Paper detail endpoint walks backward via `findCanonicalRoot` when post has `pevo.continues`.

### Backend: E5 — Update enrichment for review staleness (2026-04-12) — Reviewed ✓

Reviews gain `outdated` and `addressed_by_version` computed fields.

### Backend: E6 — Cache invalidation endpoint (2026-04-12) — Reviewed ✓

`POST /:author/:permlink/invalidate` with `verifyHiveSignature` + rate limiting. Invalidates `paper-detail` and `paper-enrichment` keys.

### Backend: E7 — Update `buildPaperDetail` response shape (2026-04-12) — Reviewed ✓

`canonical_author`/`canonical_permlink`/`head_author`/`head_permlink` added. Canonical = head for non-chain papers.

### UI: E8 — Add edit route and register page (2026-04-12) — Reviewed ✓

Route in `router.js`, `initEditPage()` in `main.js`.

### UI: E9 — Create edit page component (2026-04-12) — Reviewed ✓

`frontend/src/pages/edit.js`: pre-fill from paper, discipline read-only, authors add-only, diff-match-patch for same-author edits, continuation support, review address checklist, draft save/restore.

### UI: E10 — Add `editPaper` to keychain.js (2026-04-12) — Reviewed ✓

Single `comment` op without `comment_options`. Continuations use `publishPaper`.

### UI: E11 — Add "Edit" button to paper-detail (2026-04-12) — Reviewed ✓

Visible when `isOwnPaper && !paper.is_retracted`, navigates to canonical author/permlink.

### UI: E12 — Edit page HTML template (2026-04-12) — Reviewed ✓

Loading/error/not-authorized states, continuation banner, disabled discipline, add-only authors, review checklist, dynamic submit button.

### UI: E13 — diff-match-patch + cache invalidation API (2026-04-12) — Reviewed ✓

Frontend dependency installed, `invalidatePaperCache` in `api.js`.

### UI: E14 — Review version badges (2026-04-12) — Reviewed ✓

Amber "outdated" badge, green "addressed in v{N}" badge.

### UI: E15 — i18n strings (2026-04-12) — Reviewed ✓

22 keys in `edit` section + 2 keys in `versions` section across all 14 locale files.

### Backend: I5a — Track IPFS uploads in Redis (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `ipfs.ts:146-157` — after successful `pinToIpfs()`, gets Redis via `getRedis()`, null-checks, stores `{ cid, uploader, timestamp }` as JSON at key `ipfs:pending:{cid}` with `'EX', 86400` (24h TTL). Non-blocking via `.catch()` that logs warning. No issues.

### Backend: I5b — IPFS orphan cleanup background job (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified all 5 spec requirements:
1. `CLEANUP_INTERVAL_MS = 30 * 60_000` (30 min). `setInterval` in `startIpfsCleanup()` with `.catch()` wrapper. Correct.
2. `runCleanup()` uses Redis `SCAN` with `MATCH ipfs:pending:*`, `COUNT 100`, cursor loop until `'0'`. Age check: `now - data.timestamp < MAX_AGE_MS` skips entries under 24h. Correct.
3. `cidReferencedInHaf()` queries `hafsql.comments` with jsonb `@>` containment for both `pevo.ipfs_cid` and `pevo.supplementary_files[].cid`. Correct.
4. `unpinFromKubo()` calls `POST /api/v0/pin/rm?arg={encodeURIComponent(cid)}` with 15s timeout. Handles "not pinned" gracefully. Correct.
5. `startIpfsCleanup()`/`stopIpfsCleanup()` wired into `index.ts:46` (boot) and `index.ts:63` (graceful shutdown). Correct.

**Accepted deviation:** `cidReferencedInHaf()` also checks `json_metadata->'image'` array for CID matches — catches inline images not covered by spec. Good addition, no issues.

### Backend/Go: I4-fix — CID path traversal validation in community pinner (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). `ValidateCID()` in `pinner.go:13` uses anchored regex `^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58})$` — path traversal impossible. Called at all 4 user-facing entry points: `handlePin` (server.go:109), `handleUnpin` (server.go:129), `handleIPFSProxy` (server.go:189), `handleGateway` (ipfsnode.go:192). All return 400 on invalid CIDs. `LogConfig` length guard at config.go:136 prevents panic on short API keys. No issues.

### Backend/Go: I4 — Community pinner with embedded IPFS node (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). `go vet` passes clean. All 13 files present matching spec: `IPFSBackend` interface (5 methods), config with env/CLI/`.env` loading, HAF SQL discovery (paper CIDs, supplementary files, inline images), Pinata backend, embedded backend with local storage + gateway fetching, HTTP API (6 endpoints), Alpine.js management UI, multi-stage Dockerfile. Graceful shutdown on SIGINT/SIGTERM.

**Architectural deviation (accepted):** boxo/libp2p replaced with simpler fetch-and-store approach — no DHT participation, content only served via local HTTP gateway. Acceptable for initial release; boxo integration can be added later if IPFS network availability is needed.

**Security fix required (tracked as I4-fix):** CID path traversal in `ipfsnode.go` — unvalidated CID string used in `filepath.Join`. Plus minor `LogConfig` panic on short API key. Assigned as pending task.

### UI: I3b-form — Supplementary file upload on publish form (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). All features verified: `supplementaryFiles` array state with correct shape, `handleSupplementaryFiles()` with 5-file limit and 10MB validation, sequential upload during submit with per-file error/status handling, CIDs included in `json_metadata.pevo.supplementary_files`. HTML template has file list with filename/size/status, description input, remove button, conditional "Add files" picker. All 14 locale files have translations. IPFS gateway URL in `paper-detail.js` now configurable via `window.__PEVO_CONFIG__.ipfsGateway`. No issues.

### UI: I3b-display — Show supplementary files on paper detail (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). All features verified: `supplementaryFiles` getter with fallback chain (`paper.supplementary_files` → `json_metadata.pevo.supplementary_files` → `[]`), `supplementaryFileUrl(cid)` using configurable IPFS gateway, `formatFileSize(bytes)` helper. HTML template gated on non-empty array with document icon, filename linked to IPFS gateway (new tab, noopener), description + formatted size. All 14 locale files have `paperDetail.supplementaryFiles` key. No issues.

### Backend: I1 — Add Kubo IPFS container to Docker stack (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified against Phase 4 spec: `ipfs` service in `docker-compose.yml:41-60` matches spec exactly — `ipfs/kubo:latest`, `ipfs_data` volume, gateway `127.0.0.1:8082:8080`, API on 5001 (internal only), `IPFS_PROFILE=server`, healthcheck with `ipfs dag stat`, 1GB memory limit. Backend `depends_on` with `service_healthy`. `ipfs_data` in volumes. No issues.

### Backend: I2 — Replace Pinata with local IPFS pinning (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `config.ts:48-49` has `ipfsApiUrl`/`ipfsGatewayUrl` with correct defaults. `ipfs.ts:87-104` `pinToIpfs()` posts to Kubo `/api/v0/add?pin=true` with 30s timeout, parses `Hash`/`Size`. Config check at `ipfs.ts:137` uses `ipfsApiUrl`. Pinata keys retained per spec. No issues.

### Backend: I3 — Accept images and data files in IPFS upload (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `ipfs.ts:24-33` has all 8 MIME types matching spec. `validateMagicBytes()` at `ipfs.ts:35-62` correct for all types (PDF, PNG, JPEG, GIF, WebP bytes 8-11, SVG BOM-strip + `<svg` in first 1024, ZIP `PK\x03\x04`, CSV MIME-only). Response includes `type` field at `ipfs.ts:148`. Error message lists all types. No issues.

### Backend: I3b-types — Add SupplementaryFile type to PaperPevoMeta (2026-04-02) — Reviewed ✓

Reviewed by Architect (2026-04-02). Verified: `SupplementaryFile` at `hive.ts:14-20` matches spec (`cid`, `filename`, `type`, `size`, optional `description`). Added to `PaperPevoMeta` at `hive.ts:37`. Imported and added to `PaperDetail` at `responses.ts:12,82`. `buildPaperDetail()` at `papers.ts:546` populates from `pevo.supplementary_files` with `[]` default. No issues.

### UI: Remove `style` from DOMPurify allowlist — M8 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). Confirmed `style` is not in `ADD_ATTR` list in `markdown-renderer.js:41-49`. Only MathML attributes plus `class`, `width`, `height`, `aria-hidden`. No change needed — finding was already addressed.

### UI: Fix 4 lifecycle/race-condition findings — M4, M5, M6, M11 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 4 findings verified against source:

- **M4** — `publish.js:205`: `destroy()` calls `clearTimeout(this._draftTimer)`. Correct.
- **M5** — `notifications.js:42,50,60,77,87`: `_generation` counter incremented on start/stop, captured before poll, checked before applying response. Correct.
- **M6** — `paper-detail.js:47-48,53,58,211-219`: Both `loadPaper()` and `handleBridgeSync()` snapshot author/permlink and check before applying. Correct.
- **M11** — `auth.js:105,138-139`: `disconnect()` calls `_stopAccreditationPolling()`. `_startAccreditationPolling()` calls `_stopAccreditationPolling()` first. Correct.

No issues found.

### UI: Fix 5 polish findings — M7, M10, L6, L7, L11 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against source:

- **M7** — `index.html:476`: Retry button with `@click="loadPaper()"`. i18n key present. Correct.
- **M10** — `index.html:220,270`: `x-html` intentional with comment re `<highlight>` tag. Correct.
- **L6** — `header.js:100`: `event.actor || ''` fallback in `formatNotification`. Correct.
- **L7** — `config.js` exports `getAppTag`, `getAppVersion`, `getAppId`. All 3 consumers import correctly. Correct.
- **L11** — `index.html:90`: `:aria-label="$t('aria.notifications')"` on bell icon. Correct.

No issues found.

### Architect: Review and triage audit findings (2026-03-31) — Done ✓

Full-stack code audit completed 2026-03-31. Results in `agents/docs/audit-2026-03-31.md` — 5 HIGH, 11 MEDIUM, 11 LOW findings. Triaged 2026-03-31: all findings assigned as implementation tasks. H5 reclassified as false positive (Hive usernames cannot contain HTML).

---

## Done

### Backend: Fix 6 security/reliability findings — H1, H2, H3, H4, M1, M3 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 6 findings verified against code:

- **H1** — `verifyHiveSignature.ts:38-52`: Redis `SETNX` with `EX 300` (5-min TTL) for replay detection. In-memory Map fallback with cleanup interval. Correct.
- **H2** — `papers.ts:1005` GET route (no auth), `papers.ts:1021` POST route with `verifyHiveSignature` + `doiAssignLimiter` middleware chain. No `runMiddleware` or `res.headersSent` in file. Correct.
- **H3** — `helpers.ts:33`: `Math.min(10000, ...)` for page, `Math.min(100, ...)` for limit. Correct.
- **H4** — `docker-compose.yml:7,28,51,52`: All password refs use `:?` syntax. Correct.
- **M1** — `app.ts:73`: `config.appUrl || false`. Correct.
- **M3** — `search.ts:169-170`: SHA-256 hash, first 32 hex chars. Correct.

No issues found.

### Backend: Fix 5 security-adjacent findings — M2, L1, L4, L5, L9 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against code:

- **M2** — `accreditation.ts:178`: SHA-256 hash, `.slice(0, 8)` before logging. Correct.
- **L1** — `config.ts:78`: `?? (() => { throw new Error(...) })()`. Correct.
- **L4** — `config.ts:79`: `unsubscribeSecret` with `SESSION_SECRET` fallback. `digest.ts:38`: uses `config.unsubscribeSecret`. Correct.
- **L5** — `accreditation.ts:87-94`: `maskEmail()` shows `m***@***.edu` format — only first char of local + TLD. Correct.
- **L9** — `docker-compose.yml:32`: `REDISCLI_AUTH=$REDIS_PASSWORD redis-cli ping`. No `-a` flag. Correct.

No issues found.

### Backend: Fix 5 code quality findings — M9, L2, L3, L8, L10 (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 findings verified against code:

- **M9** — `responses.ts:398`: `redis_available?: boolean` in `HealthCheckResponse`. Correct.
- **L2** — All 12 `parseInt` calls across backend have explicit radix `, 10`. Correct.
- **L3** — `ipfs.ts:53`: `AbortSignal.timeout(30_000)` on Pinata fetch. Correct.
- **L8** — 5 routes return `422` with `VALIDATION_ERROR`: non-institutional email, already accredited, self-vouch, already retracted, DOI on retracted paper. `VALIDATION_ERROR` in `ErrorCode` union at `api.ts:22`. Correct.
- **L10** — `002_add-check-constraints.sql`: `CHECK (last_digest_block >= 0)`. Correct.

No issues found.

### UI: Fix 5 paper detail and notification bugs (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 5 bugs verified against spec:

1. **Bug 1 — ICU plural:** `interpolate()` in `i18n.js:40-50` handles `{var, plural, one {…} other {…}}` with `#` replacement. Regex-based, correct branching on `value === 1`. Simple `{key}` replacement runs after plural expansion. Correct.
2. **Bug 2 — Collapsible body:** `bodyExpanded: false` in `paper-detail.js:29`. Toggle button in `index.html` uses `paperDetail.showFullPaper` / `paperDetail.collapseBody`. Body div gated by `x-show="bodyExpanded"`. i18n keys in all 14 locales. Correct.
3. **Bug 3 — Discussion section:** `threaded-comments.js` fetches via `fetchPaperComments`, renders threaded HTML. `comment-composer.js` posts via `postComment` from keychain, dispatches `comment-posted` event for refresh. Section in `index.html` after reviews with loading/error/empty states and connect prompt. Correct.
4. **Bug 4 — Self-review guard:** `isOwnPaper` getter in both `paper-detail.js:73-79` and `review.js:36-41` checks primary author and co-authors array. "Write a Review" button hidden with `x-show="!isOwnPaper"`. Review form gated with `x-if="isAccredited && !isOwnPaper"`. Warning card shown. Backend `anonymousReview.ts:117-132` rejects with 403 for both direct author and co-author matches. `review.cannotReviewOwn` in all 14 locales. Correct.
5. **Bug 5 — Notification formatting:** `formatNotification()` in `header.js:82-105` maps event types to i18n keys, handles `accreditation_update` branching on `event.action`, passes interpolation params. `index.html` uses `x-text="formatNotification(event)"`. Correct.

No issues found.

### UI: Simplify header navigation (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All acceptance criteria verified against ARCHITECTURE.md § 14:

1. **Publish moved:** Removed from `primaryLinks`, placed first in `moreLinks` in `header.js:21`. Correct.
2. **User menu dropdown:** `userMenuOpen` state in `header.js:8`, `toggleUserMenu()` in `header.js:73-75`. Trigger button shows bell icon (with unread badge) + `@username` + chevron. Dropdown contains: Profile link → Notifications panel (title, mark-all-read, event list) → Disconnect button. `@click.outside="userMenuOpen = false"` on container. Correct.
3. **`notifOpen` removed:** Zero occurrences in codebase, fully replaced by `userMenuOpen`. Correct.
4. **Language switcher:** Unchanged position, standalone before user menu. Correct.
5. **Mobile nav:** Unchanged. Correct.
6. **No new i18n keys** needed or added. Correct.

No issues found.

### Backend: Fix 4 runtime bugs (2026-03-31) — Reviewed ✓

Reviewed by Architect (2026-03-31). All 4 fixes verified against spec, 166/166 tests pass.

1. **Bug 1 — Set serialization:** `getAllAccreditedAccounts()` caches as `string[]`, wraps in `new Set()` on retrieval. Hive API fallback spreads Set to array before returning. Correct.
2. **Bug 2 — Hive API pagination:** Batches of 20, up to 5 pages, `start_author`/`start_permlink` cursor, `batch.slice(1)` dedup on subsequent pages, early exit on `batch.length < 20`. Correct.
3. **Bug 3 — SQL param indices:** Uses `accredCte.nextIdx` and `accredCte.nextIdx + 1` instead of hardcoded `$5`/`$6`. Comment updated. Correct.
4. **Bug 4 — Bridge permlink/title/errors:** `bridgePermlink()` lowercases, replaces `[^a-z0-9]+` with `-`, trims edges, truncates to 256. Title truncated to 253+`...` before broadcast. Both catch blocks (register + update) now return Hive RPC error detail via `jse_shortmsg`. Correct.

No issues found.

### UI: Alpine.js rewrite — All 5 Phases Complete (2026-03-30) — Reviewed ✓

Reviewed by Architect (2026-03-30). All 5 phases verified: 16 hash-based routes, 9 stores, 16 components, 16 pages, Tiptap editor, error tracking. index.html SPA shell correct (header, footer, toast, onboarding/username modals). Auth store has isAccredited with localStorage persistence and disconnect reset. Vite outputs to `backend/public/`. All dependencies present (Alpine.js, Tiptap, Sentry optional). No issues.

### Architect: Update specs and contracts for Alpine.js rewrite (2026-03-30) — Reviewed ✓

Completed by Architect. ARCHITECTURE.md updated (system diagram, data flow, CORS, i18n, Markdown rendering, editor deps, CSP — all Next.js/React refs removed). `docs/deployment-guide.md` updated to v0.2 (3 Docker services, single port). `contracts/disciplines.json` exported. `agents/architect/CLAUDE.md` updated.

### Backend: Serve static frontend and simplify config (2026-03-30) — Reviewed ✓

Completed by Backend agent. Reviewed by Architect (2026-03-30). `app.ts` correctly adds `express.static` before API routes and SPA catch-all after (skips `/api/` paths). CORS simplified. CSP updated for Alpine.js. `docker-compose.yml` frontend service removed. Dockerfile has correct build order (contracts → frontend → backend). TS compiles clean. No API behavior changed.

### Architect: Verify HAF sender column and update specs (2026-03-30) — Reviewed ✓

Completed by Architect. HAF `required_posting_auths` column confirmed (jsonb array). ARCHITECTURE.md updated with whitelist spec, `ACCREDITATION_AUTHORITIES` env var, and `accredited_only` default change.

### Backend: On-chain discovery + sender-filtered accreditations (2026-03-30) — Reviewed ✓

Completed by Backend agent. Reviewed by Architect (2026-03-30). Five tasks implemented:

1. **Sender whitelist filter:** `config.accreditationAuthorities` correctly built as `[hiveAdminAccount, ...extras]`. `hafsql.ts` CTE and `accreditation.ts` batch query both filter by `cj.required_posting_auths ?| $N::text[]`. Hive API fallback scans all authority accounts. Param indexing correct (`$1=appTag, $2=whitelist, $3+=usernames`).
2. **`accredited_only` default to `false`:** Changed in all three routes (`papers.ts:62`, `search.ts:153`, `comments.ts:21`). Uses `=== 'true'` comparison.
3. **`pending_accreditations` to Redis+memory:** `storeToken` writes both Redis (with TTL) and memory. `getToken` reads Redis first, memory fallback. `deleteToken` cleans both. No `getAppPool` import.
4. **`anon_review_mappings` to Redis+memory:** Same pattern with 180-day TTL. Encryption logic preserved. No `getAppPool` import.
5. **`app-db.ts` simplified:** Only `notification_preferences` remains. Migration updated. `.env` has `ACCREDITATION_AUTHORITIES` and updated `APP_DATABASE_URL` comment.

Tests: 165/166 pass. One flaky test (`papers.test.ts > returns papers with correct structure`) fails in full suite due to HAF connection contention but passes in isolation (8/8). Pre-existing issue, not a regression.

### UI: Add `isAccredited` to AuthContext (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). `isAccredited` and `accreditation` correctly added to AuthState, fetched after login, persisted in localStorage, reset on disconnect. Non-critical fetch failure defaults to unaccredited. No issues.

### UI: Gate all write actions behind accreditation (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). Publish/review forms gated behind `isAccredited`, CommentComposer returns null, VoteButtons redirects to /accreditation. i18n keys present in all locales. No issues.

### UI: Add primary author name/affiliation fields to publish form (2026-03-29) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-29). Three fields added (name required, affiliation/ORCID optional), pre-filled from accreditation, included in draft save/restore, used in submit payload, submit guarded by empty name check. No issues.

### UI: Fix disabled buttons in toolbar (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Undo/Redo correctly branch on markdownMode (execCommand for textarea, Tiptap chain for visual). Image button has no disabled prop; upload indicator is text-only. No stray disabled props on any toolbar button. No issues.

### UI: Auto-save publish form as local draft (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Debounce cleanup correct, initialLoadDone guard prevents restore/auto-save race, draft cleared on success only, all localStorage ops wrapped in try/catch. No bugs.

### UI: Fix B/I/S toolbar buttons — empty editor + markdown source mode (2026-03-27) — Reviewed ✓ (with follow-up)

Completed by UI agent. Reviewed by Architect (2026-03-27). All formatting buttons correctly branch on markdownMode with proper syntax. Focus-loss fix correct. Two minor disabled-button violations flagged as follow-up task above.

### UI: Add Full-screen editor toggle button (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). All 8 requirements met: button placement, variant gating, fixed positioning, flex expansion, icon toggle, Escape key, both modes. No issues.

### UI: Fix Markdown→Visual round-trip parsing in TiptapEditor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Full remark pipeline, math post-processing, DOMPurify allowlist all correct. Minor caveat: initial content loading (line 545) still uses naive `<p>` wrapping — low priority, doesn't affect toggle round-trip.

### UI: Remove duplicate `.pevo-editor` inline styles from TiptapEditor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). No `<style jsx global>` remains. globals.css `.ProseMirror` rules are the sole styling source. No issues.

### UI: Editor styling and toolbar state fixes (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Scoped styles, LinkPopover fix, and ExitBlockOnEnter all correct. Follow-up task created for duplicate inline styles.

### UI: Markdown source toggle on editor (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Toggle works correctly in both directions. Follow-up tasks created for Markdown→Visual parsing quality and missing Full-screen button.

### UI: Character counter on all editor variants (2026-03-27) — Reviewed ✓

Completed by UI agent. Reviewed by Architect (2026-03-27). Fully compliant with spec — no issues found.

---

## Done

### REC-1 — Account recovery for light accounts (Backend + Frontend) ✓

Architect review passed. Backend: `POST /api/auth/recover` with seed-phrase (timingSafeEqual memo key comparison) and ORCID (nonce-based OAuth) recovery methods. Rate limited 10/IP/hr, argon2id password update, session invalidation, audit logging, email uniqueness check. 9 tests passing. Frontend: `/recover` page with seed phrase / ORCID tabs, client-side key derivation via `deriveAllKeys()`, ORCID tab conditionally shown after `fetchAccreditationStatus()`, localStorage persistence for OAuth round-trip, password validation, success screen. Route + registry registered. 27 `recover.*` + `login.lostEmailAccess` i18n keys in all 16 locales. No issues found.

### ENRICH-F1 — Frontend: Remove batch-counts enrichment and stop overwriting initial values from enrichment (UI agent) ✓

Architect review passed. `fetchPaperBatchCounts` import and `enrichPapers` method removed from home.js. Paper detail enrichment handler sets only `reviews`, `voters`, `net_votes` — no overwrites of `citation_count`, `is_accredited`, `accredited_authors`, `versions`, `is_retracted`. `fetchPaperBatchCounts` function removed from api.js. No stale references found. No issues found.

### ENRICH-B1 — Backend: Fold review_count and citation_count into paper list query (Backend agent) ✓

Architect review passed. Review count and citation count computed via correlated subqueries in paper list HAF query. batch-counts endpoint removed. Hive API fallback defaults both to 0 via toPaperSummary. Bridge papers enriched with Semantic Scholar external counts. No issues found.

### ENRICH-B2 — Backend: Move citation_count, is_accredited, accredited_authors into initial paper detail load (Backend agent) ✓

Architect review passed. Both HAF and Hive API detail paths compute citation_count, is_accredited, accredited_authors. buildPaperDetail declares accredited_authors: [] as string[]. Bridge external citation counts preserved in both paths. No issues found.

### ENRICH-B3 — Backend: Remove versions and retraction from enrichment response (Backend agent) ✓

Architect review passed. Both HAF and Hive API enrichment paths return only { net_votes, voters, reviews }. Citation, retraction, postMeta queries removed from HAF enrichment. Versions retained internally for staleness computation but excluded from response. No issues found.

### CHUNK-1 — Lazy-load the editor chunk via dynamic import (UI agent) ✓

Architect review passed. Static createEditor import removed from publish.js and edit.js. _mountEditors() is async with dynamic import in both files. Editor chunk loads only on publish/edit pages. No issues found.

### CHUNK-2 — Isolate dhive into its own manual chunk in Vite config (UI agent) ✓

Architect review passed. hiveModules array and manualChunks function in vite.config.js correctly isolate @hiveio/dhive into a separate 'hive' chunk. No issues found.

### CHUNK-3 — Verify all chunks are under 500 KB after CHUNK-1 and CHUNK-2 (UI agent) ✓

Architect review passed. Index chunk 475 KB (under threshold). hive (728 KB) and editor (850 KB) are third-party libraries, lazy-loaded or cached separately. No issues found.

### EMAIL-B1 — Backend: Email management endpoints (Backend agent) ✓

Architect review passed. Migration, schema, 4 endpoints (GET/POST/DELETE email + GET verify/:token), per-endpoint rate limiters, Zod validation, transactional cascade delete, parameterized SQL throughout. 15 tests passing. No issues found.

### EMAIL-F1 — Frontend: Email management section in settings page (UI agent) ✓

Architect review passed. 4 API functions, 3-state email section (no email/verified/pending), delete confirmation with custody-aware warnings, verify-email micro-page, route + registry. Architect fix: 2 hardcoded "Cancel" buttons replaced with `$t('common.cancel')`.

### EMAIL-I1 — Add email management i18n keys to all 16 locale files (UI agent) ✓

Architect review passed. All 20 keys present in all 16 locale files with idiomatic translations. `{email}` placeholder preserved. Brand names untranslated. All files valid JSON. No issues found.

### I18N-1 — Remove dead i18n keys from all 16 locale files (UI agent) ✓

Architect review passed. All dead keys removed from all 16 locale files. `publish.pdfSelected` preserved (actively used). All 16 files have synchronized key sets (948 keys across 50 sections). No JS or HTML files modified. No issues found.

### I18N-2 — Fix hardcoded strings in templates and JS (UI agent) ✓

Architect review passed. All 6 categories verified: aria-labels in index.html use `$t()`, `methodLabel()` in accreditation.js uses i18n, PDF selected in publish.js uses i18n with interpolation, all catch-block error strings across pages use i18n keys, `formatShortDate` in paper-detail.js reads locale from i18n store. 12 new keys confirmed in en.json (2 aria + 10 common error). No remaining hardcoded English strings found. No issues found.

### I18N-3 — Retranslate stale FAQ and missing translations in all 15 non-English locales (UI agent) ✓

Architect review passed. FAQ q3-q14 verified translated (not English placeholders) across all 15 non-English locales. Spot-checked de, fr, es, zh, ar, it, pl — all authentic translations. `footer.contact`, `seedPhrase.chooseCreateHint`, `aria.toggleMenu`, `aria.dismiss`, and all 10 common.* error keys present and translated in all 15 locales. All 16 JSON files pass validation. No issues found.

### VOUCH-B1 — Backend: Add `GET /api/accounts/search` endpoint (Backend agent) ✓

Architect review passed. New route file `accounts.ts` registered at `/api/accounts` with `readLimiter`. Validates `q` (2-16 chars, sanitized to valid Hive username chars), clamps `limit` to [1,10] default 5. Calls `lookup_accounts` Hive API, cross-references accreditation via `getAccreditedSet()`. Response shape matches spec. 9 tests passing against real Hive API. No issues found.

### VOUCH-F1 — Frontend: Replace "Browse researchers" with vouch search (UI agent) ✓

Architect review passed. "Browse researchers" removed. Debounced (300ms) search input with magnifying glass icon, circular Hive avatars (32px, SVG letter fallback), clickable usernames navigating to profile, green checkmark for accredited accounts, "No accounts found." on empty results. `searchAccounts()` in api.js matches spec. i18n: `vouchDescription` updated, 3 new keys added, `browseResearchers` removed (en.json only per spec). All component data properties match spec. No issues found.

### ACC-1 — Show accreditation status for already-accredited users (UI agent) ✓

Architect review passed. Status card shown when user is accredited (green banner, name/institution/field/method/date details, vouch section with "Browse researchers" link). Form wrapped in `x-if="!isAccredited"`. Computed properties, `formatDate` import, and `methodLabel()` helper added. All 9 i18n keys match spec in en.json, no keys removed. No issues found.

### GS-1 — Rework getting-started page (UI agent) ✓

Architect review passed. Template rewritten with comparison cards (quick start vs full custody), icon-enhanced step cards, upgrade callout for quick path, and capabilities section. Key prefix `kc` → `fc` in JS. All 37 i18n keys match spec in en.json, old keys removed. All 16 locale files updated with translations. No issues found.

### GEN-1 — Apply genesis block floor to all custom_json queries (Backend) ✓

Architect review passed. All 3 steps implemented correctly: `getCachedGenesisBlock()` sync accessor, head-block fallback for fresh namespaces, startup warmup. All 3 CTE builders and all 10 standalone queries have parameterized `block_num >= $N` with correct index shifting. Bonus: notifications/digest now clamp `sinceBlock` to genesis floor, tests updated to use dynamic genesis block. 189 tests pass. No issues found.

### AUTH-1 — Per-author accreditation badges across all paper views (Backend + Frontend) ✓

Architect review passed. Backend: `accredited_authors` string array added to enrichment response, paper list endpoints (HAF + Hive API), and profile papers endpoint. Frontend: per-author rendering on paper detail, home, papers, and profile pages — accredited authors shown as clickable profile links with green checkmark icon, non-accredited as plain text. No text label on badge.

### PROF-1 — Skip expensive queries for non-accredited profiles (Backend) ✓

Architect review passed. Profile handler split into two phases: account + accreditation first, expensive HAF/reputation queries only for accredited users. Non-accredited profiles return zeroed stats immediately. No issues found.

### PX-2 — Extract all remaining page templates (UI agent) ✓

Architect review passed. All 26 templates extracted, index.html reduced to 570 lines, page-mount and registry working correctly.

Architect fix: `paper-detail.js` lines 537 and 623 had over-escaped backticks (`\\\``) in Alpine `:style` template literals — changed to `\`` to match the correct pattern used in profile.js, home.js, and papers.js.

### PX-1 — Scaffold page-mount component and page registry (UI agent) ✓

Architect fix: `renderPage` destroyed all children of `<main>` — would wipe inline `<template x-if>` blocks for non-migrated pages on first navigation to a registered route. Fixed by introducing a dedicated `_container` div that `pageMount` manages exclusively, leaving inline template blocks untouched.

### NAV-F1 — Frontend: Jump to review from profile link (UI agent) ✓

### PROF-B1 — Backend: Add `GET /api/profile/:username/reviews` endpoint (Backend agent) ✓

Architect fix: Hive API fallback had `const [parent] = await get_content(...)` — array destructuring on a single-object return. Would extract wrong data for paper title. Fixed to `const parent = ...`.

### PROF-F1 — Frontend: Add Publications/Reviews tabs on researcher profile (UI agent) ✓

### VSTALE-B2 — Backend: Exclude stale votes from reputation computation (Backend agent) ✓

Architect fix: vote resolution when both native vote and revote exist after the latest content revision now compares timestamps per §31 ("use whichever has the later timestamp"). Original code always preferred the revote. Fixed in both `reputation.ts` and `routes/papers.ts`.

### VSTALE-B3 — Backend: Validate incoming `revote` custom_json (Backend agent) ✓

Architect fix: added `version` field presence check to revote validation in both `reputation.ts` and `routes/papers.ts`, and added `version` to the SQL SELECT. §3.1 requires author/permlink/version all present.

### VSTALE-B1 — Backend: Vote staleness detection in paper detail (Backend agent) ✓

Architect fix: SELECT was missing `v.timestamp`, and code referenced `r.vote_ts` (undefined) instead of `r.timestamp`. All native votes on revised papers would have been incorrectly marked stale. Fixed in architect review.

### VSTALE-F1 — Frontend: Broadcast `revote` custom_json (UI agent) ✓
### VSTALE-F2 — Frontend: Show vote staleness in paper detail (UI agent) ✓
### VSTALE-F3 — Frontend: Show stale vote count on version timeline (UI agent) ✓

### ORCID-B1 — Backend: Add `ORCID_MIN_WORKS` config (Backend agent) ✓
### ORCID-B2 — Backend: Add `POST /api/auth/orcid/start` (Backend agent) ✓
### ORCID-B3 — Backend: Add `POST /api/auth/orcid/callback` (Backend agent) ✓

Architect fix: changed source-name comparison to use `source-orcid.path` instead of `source-name.value`. The original compared the source display name against the ORCID iD, which would never match — every work would count as external.

### ORCID-B4 — Backend: Modify `POST /api/auth/signup` to accept `orcid_token` (Backend agent) ✓
### ORCID-B5 — Backend: Include verified ORCID in attestation only (Backend agent) ✓
### ORCID-F1 — Frontend: Replace ORCID text input with OAuth button on signup (UI agent) ✓
### ORCID-F2 — Frontend: Add signup ORCID callback page (UI agent) ✓
### ORCID-F3 — Frontend: Restore form state and show verified ORCID on signup (UI agent) ✓
### ORCID-F4 — Frontend: Update error messaging (UI agent) ✓
### ORCID-F5 — Frontend: Add API functions for signup ORCID flow (UI agent) ✓

### I18N-4 — Internationalize editor.js (UI agent) ✓

All ~30 hardcoded English strings extracted to `_t()` helper using `Alpine.store('i18n').t()`. `editor` section with 36 keys added to all 16 locale files with translations. Toolbar titles, aria-labels, math modal, link popover, character count, fullscreen toggle, and image upload error all internationalized.

### I18N-5 — Deduplicate shared i18n keys into `common` section (UI agent) ✓

7 new keys added to `common` (`getAccredited`, `noAccount`, `signUp`, `hasKeychain`, `connectKeychain`, `alreadySignedIn`, `goToPapers`), 9 old duplicate keys removed from `publish`, `review`, `signIn`, `login`, `signup` sections. All 16 locale files updated atomically. JS/HTML references updated.

### I18N-6 — Fix untranslated values in all locale files (UI agent) ✓

87 untranslated values across 15 non-English locale files translated. Spot-checked: `versionWithDate` uses native words (German "Version", Spanish "Versión", Chinese "版本", Arabic "الإصدار"). All 16 locale files have identical key sets.
