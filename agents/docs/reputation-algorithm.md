# PEvO Reputation Algorithm — v0.5

> **Owner:** Architect Agent
> **Version:** 0.5
> **Date:** 2026-04-19
> **Status:** Implemented. Single all-users SQL query per batch cycle. No JS computation.

---

## Design Constraints

1. **Reproducible:** Scores must be fully reproducible from public on-chain data via SQL.
2. **Accredited-only inputs:** Only votes from accredited users feed into reputation.
3. **Voter reputation weighting:** Vote influence scales with the voter's own reputation. Circularity is resolved via lagged computation (use prior cycle's scores).

---

## Score Formula

```
score = CLAMP(0, 100,
    SUM_OVER_PAPERS(paper_rep(p)) +
    SUM_OVER_REVIEWS(review_rep(r)) +
    citation_score +
    (is_accredited ? W_accreditation_bonus : 0)
)
```

### Co-author Credit

Co-authors receive the **same** paper reputation score as the posting author (shared co-author credit, not divided) — the paper's votes, reviews, decay, and quality multiplier all apply identically — but only once they are **consented** for the paper. Per `ARCHITECTURE.md` § 2 "Consented vs claimed authorship", consent is conferred by the credited person's own explicit op via one of two routes: (route 2, anchored slot) the co-author broadcasts `author_accept` when their `authors[]` slot carries a `hive` handle equal to them or an `orcid` matching their authority-attested ORCID; (route 3, name-only slot) the co-author broadcasts `claim_authorship` and the paper author/admin confirms with `approve_authorship`. There is **no metadata auto-accept**: an ORCID/hive anchor only establishes who may consent, never credit on its own. Credit is keyed to the **on-chain post identity** — a deduped per-post collapse so a post credited to several recipients is not multiplied, and votes/reviews signed against the original post credit each consented co-author. The author/admin `revoke` backstop (and the co-author's own `author_resign` / self-`revoke`) demotes a consented co-author going forward. Self-credit where the consenting account = the post author is excluded to avoid double counting.

> **Implementation status.** The live reputation cycle does NOT yet compute the consented-set. It still resolves co-author credit via the legacy `accepted_claims` CTE (mirroring `authorshipClaimsCteBody`: explicit approval, ORCID auto-accept, hive-username auto-accept, with revocation override), keyed to the on-chain post identity (`user_papers` carries `chain_author`/`chain_permlink` on both arms; a deduped `chain_papers` CTE collapses multi-recipient posts; the final SUM attributes the score to `up.author`). That legacy resolution is documented verbatim in "Canonical SQL Query" below, which tracks the running code. Migrating credit onto the consented-set — removing the auto-accept arms, adding the anchored-ORCID `author_accept` route and the name-only `claim`+`approve` route, and honoring the `revoke`/`resign` demotions — is the backend implementation task; the prose above is intentionally ahead of code.

**Authorship list is final (design invariant, 2026-06-05).** Credit binds only to an author slot named at posting; there is no "unlisted claim → approve → add a never-named co-author" path (see `hive-schemas.md` § 2.9/2.10). New co-authors are added only via continuation revisions, which name them (claimed) before they consent (credited). Both list-final enforcement arms are now **live** (landed via `backend-co-author-claim-zero-score`): (1) the approval arm requires the claim's `author_index` to resolve to a named slot — an unlisted or out-of-range claim grants zero credit; (2) the paper self-vote and self-review exclusions reject any credited claimer for the chain post (not only the chain poster and `authors[].hive` members), so a claimer cannot self-vote/self-review the paper they are credited for. (A display-callsite extension of the self-review exclusion — dropping a claimer's self-review from the third-party-review *lists* — was flagged by the implementer as a separate follow-up decision.)

### Paper Reputation Contribution

Three signals combine per paper:

```
paper_rep(p) = MAX(-W_paper, quality(p) * MIN(weighted_upvotes(p), W_paper) - weighted_downvotes(p) * W_downvote) * decay(age)
```

#### Signal 1 — Weighted Upvotes (ceiling)

Each accredited vote carries two multipliers: the voter's **reputation weight** and the **vote strength** (derived from the Hive vote percentage).

```
voter_weight(v) =
    if has_published_or_reviewed(v):
        0.4 + 0.6 * sqrt(reputation(v) / 100)     → 0.4 to 1.0
    else:
        sqrt(reputation(v) / 100)                   → 0.0 to 1.0

vote_strength(v) = abs(hive_vote_percent(v)) / 100  → 0.0 to 1.0
vote_influence(v) = voter_weight(v) * vote_strength(v)

weighted_upvotes(p) = SUM(vote_influence(v))    for each accredited upvoter on p
upvote_cap(p) = MIN(weighted_upvotes(p), W_paper)
```

**Voter weight** has a 0.4 floor that is **earned by contributing** — the account must have published at least one paper or written at least one review. Accounts with zero contributions use pure sqrt (no floor). This prevents sybil attacks in both directions: empty fake accounts have very low vote weight (0.22 at rep 5), making mass upvoting and mass downvoting impractical. To earn the floor, each sybil would need to actually publish or review, which takes effort, creates discoverable patterns, and exposes each contribution to community downvotes.

| Reputation | No activity (sybil) | Has contributed |
|------------|---------------------|-----------------|
| 5 | 0.22 | 0.53 |
| 10 | 0.32 | 0.59 |
| 20 | 0.45 | 0.67 |
| 40 | 0.63 | 0.78 |
| 60 | 0.77 | 0.86 |
| 80 | 0.89 | 0.94 |
| 100 | 1.00 | 1.00 |

**Self-votes are excluded.** Votes from the posting author and co-authors (listed in `json_metadata.pevo.authors[].hive`) are filtered out before reputation computation and are not shown in vote counts.

**Vote sources.** Votes come from two sources: native Hive votes (`operation_vote_view`) and revote `custom_json` operations (`action: "revote"`). Within the 7-day Hive payout window, the frontend uses native votes. After the payout window, voters who have already cast a native vote use `custom_json` revotes to change their vote. For reputation, each voter contributes at most one weight per paper: their **latest signal** (highest `block_num` across both sources). Only an explicit `weight=0` retraction removes a vote from reputation.

**Vote retraction.** A vote (native or revote) with `weight=0` retracts the vote entirely. The voter is excluded from counts, scores, and reputation computation.

**Votes persist across revisions.** When a paper is revised, existing votes remain valid and continue to count for reputation. This avoids creating a perverse incentive against revising papers. The system relies on other corrective mechanisms: voters can downvote or retract, new reviews adjust the quality multiplier, and the community can re-evaluate at any time.

**Vote strength** comes from the Hive vote percentage. The PEvO frontend presents six labeled levels mapped to fixed Hive vote weights:

| Label | Hive vote % | Strength multiplier |
|-------|-------------|---------------------|
| Strong endorsement | +100% | 1.0 |
| Endorsement | +60% | 0.6 |
| Mild endorsement | +25% | 0.25 |
| Mild concerns | -25% | 0.25 |
| Reject | -60% | 0.6 |
| Strong reject | -100% | 1.0 |

On-chain this is a standard Hive vote at a specific weight — no custom_json needed. The algorithm reads `abs(weight) / 10000` as the strength multiplier.

Example: a "mild endorsement" (25%) from a rep-60 user (voter weight 0.86):
```
vote_influence = 0.86 * 0.25 = 0.22
```
vs a "strong endorsement" (100%) from the same user:
```
vote_influence = 0.86 * 1.00 = 0.86
```

- 0 accredited upvotes → paper contributes 0 (publishing alone earns nothing)
- A mild endorsement barely registers — a polite nod, not a real boost
- Capped at W_paper (default 20)

#### Signal 2 — Review Star Ratings (quality multiplier)

Reviews already carry structured ratings: methodology, novelty, clarity, significance (each 1-5).

```
review_avg(r) = mean(r.methodology, r.novelty, r.clarity, r.significance)
quality(p) = mean(review_avg(r) for each review on p) / 5     → 0.2 to 1.0

If no reviews exist: quality(p) = 1.0
```

- Reviews averaging 4.5/5 → quality = 0.9
- Reviews averaging 2.0/5 → quality = 0.4
- No reviews → quality = 1.0 (upvotes speak for themselves)

Quality multiplies the upvote-derived ceiling. Bad reviews reduce the paper's reputation contribution even with many upvotes.

#### Signal 3 — Weighted Downvotes (penalty)

Each accredited downvote penalizes using the same `vote_influence` formula (voter weight × vote strength):

```
weighted_downvotes(p) = SUM(vote_influence(v))    for each accredited downvoter on p
penalty(p) = weighted_downvotes(p) * W_downvote
```

Default W_downvote = 2, meaning a "strong reject" from a rep-100 user (influence 1.0) cancels two "strong endorsements" from rep-100 users. A "mild concerns" vote (25%) from the same user only contributes 0.25 × 2 = 0.5 penalty — a gentle nudge.

The final paper_rep is clamped to [-W_paper, +W_paper], so a single paper can at most contribute +20 or penalize -20.

### Review Reputation Contribution

Reviews use the same weighted-vote mechanism, capped at W_review:

```
review_rep(r) = MAX(-W_review, MIN(weighted_upvotes(r), W_review) - weighted_downvotes(r) * W_downvote) * decay(age)
```

No quality multiplier for reviews (reviews don't receive star ratings themselves). The community's up/down votes on the review are the quality signal.

**Anonymous reviews are excluded** from the reviewer's own reputation score. Since anonymous reviews are posted via a proxy account, the public posting user is not the actual reviewer. Including them would attribute reputation to the proxy account, not the author. Only non-anonymous reviews (where `is_anonymous != 'true'`) count toward the reviewer's reputation.

### Citations (quality-weighted, capped)

Citations are weighted by the **quality of the citing paper**. A citation from a well-received paper is worth more than one from a paper nobody endorsed or that was downvoted. Self-citations are near-worthless.

Each citation carries a `reputation_relevant` flag (default `true`). When `false`, the citation appears in the paper's reference list but is excluded from reputation computation. This lets authors cite work for context or refutation without boosting the cited author's reputation.

```
For each citation of author A's work WHERE reputation_relevant == true:
  citing_paper_quality = paper_quality_score(citing_paper)    → 0.0 to 1.0
  citing_paper_age = age of the CITING paper in months
  citation_value =
    if citing_author == A:   citing_paper_quality * W_self_citation_discount * decay(citing_paper_age)
    else:                    citing_paper_quality * W_citation * decay(citing_paper_age)

citation_score = MIN(SUM(citation_value), W_citation_max)
```

Where `paper_quality_score(p)` is the same quality signal used for paper reputation:
- `quality(p) * MIN(weighted_upvotes(p), 1.0)` — a paper with no upvotes has quality 0 regardless of reviews
- Clamped to [0.0, 1.0]

The decay is applied to the **citing paper's age**, not the cited paper's age. This means:
- If people keep citing your old work in new papers, those citations retain full value
- If nobody has cited your work in years, those old citations fade away
- Your old work stays relevant exactly as long as others consider it relevant

This means:
- A recent citation from a quality paper: worth ~W_citation (3 pts)
- A citation from a paper with no engagement: worth 0
- A citation from a downvoted rubbish paper: worth 0
- A 5-year-old citation from a once-good paper: decayed to ~30% of original value
- A self-citation: worth at most 0.05 * W_citation ≈ 0.15 — effectively nothing
- Total citation contribution capped at W_citation_max (default 15)

### Accreditation

Flat bonus for accredited accounts.

---

## Voter Reputation Weighting — Resolving Circularity

Vote influence depends on the voter's reputation, which depends on votes they received, creating a circular dependency.

**Resolution: deterministic cycle-based computation.**

### Cycle Definition

Reputation is computed in fixed-size **block cycles**. Each cycle covers a contiguous range of Hive blocks:

```
cycle_blocks = W_cycle_blocks  (default 28,800 = ~1 day at 3s/block)
genesis      = block number of the first PEvO accreditation custom_json

cycle N covers blocks [genesis + N * cycle_blocks, genesis + (N+1) * cycle_blocks)
current_cycle = floor((head_block - genesis) / cycle_blocks)
```

### Cycle Computation Rules

1. **Cycle 0 (bootstrap):** All voter weights = 1.0. Previous scores = `'{}'::jsonb` (empty object). All on-chain data from genesis through `genesis + cycle_blocks - 1` is included.
2. **Cycle N (N > 0):** Uses cycle N-1 scores as voter weights. Previous scores are passed as a jsonb parameter. Voters not present in previous scores get weight 1.0 (new accounts).
3. **One pass per cycle.** No convergence iterations. Scores are a deterministic function of on-chain data plus the prior cycle's scores.
4. **On-demand queries** (1h cache TTL) use the last batch-computed cycle's scores for voter weighting. If no batch scores exist yet, all voters weight equally (bootstrap).
5. **Only data up to the cycle boundary is included.** The reputation query takes a `cycle_end_block` parameter and only considers votes, papers, reviews, and citations with `block_num < cycle_end_block`. This ensures identical results regardless of when the computation runs.

This is fully deterministic: given the same HAF snapshot + the same prior-cycle score table, any node produces identical results. There is no time-based input (no `NOW()`, no `Date.now()`). Age-based decay uses `cycle_end_block` to derive a reference timestamp.

### Storage

Batch-computed reputation scores are stored in Redis under the project-wide app-tag prefix (`${config.appTag}:`):
- `${appTag}:reputation:batch:{username}`. JSON-encoded `{score, breakdown}` where breakdown is `{papers, reviews, citations, accreditation}`. No TTL; overwritten each cycle. Readers parse defensively and surface `ZERO_SCORE` on parse failure (a rate-limited operator warn fires; readers do not recompute at head-block).
- `${appTag}:reputation:cycle:last`. The last completed cycle number (integer).

On a fresh system with no batch scores, `voter_weight(v) = 1.0` for all accredited voters (bootstrap mode). On startup, if the system is behind by multiple cycles, it catches up sequentially from the last completed cycle.

---

## Temporal Decay

```
decay(age_months) =
    if age_months <= W_decay_grace_months: 1.0
    else: MAX(W_decay_floor, 1.0 - ((age_months - W_decay_grace_months) * W_decay_rate))
```

---

## Weights

| Weight | Key | Default | Description |
|--------|-----|---------|-------------|
| W_paper | `paper` | 20 | Max points per paper (upvote cap ceiling) |
| W_review | `review` | 10 | Max points per review (upvote cap ceiling) |
| W_downvote | `downvote` | 2 | Penalty multiplier per weighted downvote |
| W_citation | `citation` | 3 | Points per quality-weighted external citation |
| W_citation_max | `citation_max` | 15 | Max total points from citations |
| W_accreditation_bonus | `accreditation_bonus` | 5 | Flat bonus for accredited accounts |
| W_self_citation_discount | `self_citation_discount` | 0.05 | Self-citation multiplier (near zero) |
| W_decay_rate | `decay_rate` | 0.02 | Monthly decay rate |
| W_decay_floor | `decay_floor` | 0.3 | Minimum decay multiplier |
| W_decay_grace_months | `decay_grace_months` | 6 | Months before decay begins |
| W_cycle_blocks | `cycle_blocks` | 28800 | Blocks per reputation cycle (~1 day at 3s/block) |

---

## Output Format

```json
{
  "score": 54,
  "breakdown": {
    "papers": 12,
    "reviews": 8,
    "citations": 4,
    "accreditation": 5
  }
}
```

---

## `update_weights` custom_json Schema

```json
{
  "action": "update_weights",
  "weights": {
    "paper": 20,
    "review": 10,
    "downvote": 2,
    "citation": 3,
    "citation_max": 15,
    "accreditation_bonus": 5,
    "self_citation_discount": 0.05,
    "decay_rate": 0.02,
    "decay_floor": 0.3,
    "decay_grace_months": 6,
    "cycle_blocks": 28800
  },
  "rationale": "v0.5 — single batch query per cycle, weights CTE",
  "timestamp": "<ISO 8601>"
}
```

---

## Canonical SQL Query

The production query in `backend/src/reputation.ts` (`computeReputationBatch`, with CTE bodies composed from `backend/src/hafsql.ts`) **is** the algorithm definition. It computes reputation scores for all target users in a single pass; shared CTEs (`cycle_ref`, `prev_scores`, `active_authors`, `voter_weights`) run once regardless of user count, and anyone with HAF access can run it and get identical scores given the same inputs.

Per the CLAUDE.md SSoT principle ("the code is the source of truth for ... data models, and schemas"), this section documents the query **structurally** — the parameter contract, the CTE roster and what each computes, and the load-bearing invariants — rather than pinning a verbatim copy (which had drifted from the code twice). `computeReputationBatch` is authoritative for the exact SQL and bind-parameter positions.

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `$1` | `text[]` | Target usernames (users whose reputation is being computed) |
| `$2` | `text[]` | All accredited account names — the voter/reviewer accreditation gate (`= ANY($2)`) |
| `$3` | `text` | `APP_TAG` (e.g., `pevotest`) — `custom_json` `id`, top-level `parent_permlink`, and the `json_metadata` key |
| `$4` | `text` | `APP_TAG/%` (the `json_metadata ->> 'app'` LIKE pattern) |
| `$5` | `jsonb` | Previous-cycle scores `{"user1": 42.5, ...}` (or `'{}'::jsonb` for cycle 0); drives voter weighting |
| `$6` | `int` | `cycle_end_block`: vote arms gate `block_num < $6`; `cycle_ref` resolves `ref_ts` at `$6 - 1` |
| `$7` | `numeric` | `W_paper` (default 20) |
| `$8` | `numeric` | `W_review` (default 10) |
| `$9` | `numeric` | `W_downvote` (default 2) |
| `$10` | `numeric` | `W_citation` (default 3) |
| `$11` | `numeric` | `W_citation_max` (default 15) |
| `$12` | `numeric` | `W_accreditation_bonus` (default 5) |
| `$13` | `numeric` | `W_self_citation_discount` (default 0.05) |
| `$14` | `numeric` | `W_decay_rate` (default 0.02) |
| `$15` | `numeric` | `W_decay_floor` (default 0.3) |
| `$16` | `numeric` | `W_decay_grace_months` (default 6) |
| `$17` | `text` | `config.hiveBridgeAccount` — bridge-author pin (`validPevoPaperWhere`) and the `approve`/`revoke_authorship` signer gate |
| `$18` | `text` | `config.hiveAnonAccount` (or `''`) — the anon-proxy OR-arm (`c.author = $18`) in the review-class composition sites |
| `$19` | `text` | `APP_TAG` again — `active_accreditations` `custom_id` (via `activeAccreditationsCteBody(19)`) |
| `$20` | `text[]` | `config.accreditationAuthorities` — the `required_posting_auths ?\| $20` authority gate in `accred_ranked` |
| `$21` | `text` | `config.hiveAdminAccount` — the admin signer in the `revoke_authorship` signer gate |

> There is **no genesis-block parameter**: a concurrent floor-sweep removed the former `$7` genesis lower-bound, so the weights begin at `$7` and the only block boundary is `block_num < $6` (`cycle_ref` degrades `$6` to head when the cycle is in progress).

### Return

One row per target user:
```json
{"username": "alice", "score": 29.0, "papers": 12.0, "reviews": 8.0, "citations": 4.0, "accreditation": 5}
```

### Query structure

The query is a single `WITH` chain of CTEs, evaluated in this order. Source: `computeReputationBatch` in `backend/src/reputation.ts`; the authorship-claim and accreditation CTE bodies are composed from `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `activeAccreditationsCteBody`).

**Shared / setup**

| CTE | Computes |
|-----|----------|
| `w` | Casts the 10 weight params `$7..$16` once to numeric (paper, review, downvote, citation, citation_max, accreditation_bonus, self_citation_discount, decay_rate, decay_floor, decay_grace_months). |
| `target_users` | `unnest($1)` — the users being scored this batch. |
| `cycle_ref` | Reference timestamp `ref_ts` for decay: the most recent block at or before `$6 - 1`, so an in-progress `cycle_end_block` degrades to head rather than zeroing all arms. |
| `prev_scores` | `jsonb_each_text($5)` → `(username, rep)`; previous-cycle scores driving voter weighting. |
| `active_authors` | Accredited paper authors (`$2`) ∪ accredited-or-anon (`$18`) non-self reviewers of valid papers; feeds the voter accredited-bonus curve. |
| `voter_weights` | Per accredited voter (`$2`): weight 1.0 when no prior score; the `0.4 + 0.6*sqrt(rep/100)` floored curve for `active_authors`; else `sqrt(rep/100)`. |

**Authorship claims (co-author credit — current legacy resolution; see "Co-author Credit" above for the target consented model)**

| CTE | Computes |
|-----|----------|
| `claim_events` | All `claim_authorship` / `approve_authorship` / `revoke_authorship` `custom_json` (`custom_id = $3`): action, claimer, paper_author, paper_permlink, author_index, approver (`required_posting_auths[0]`), block_num. |
| `accred_ranked`, `active_accreditations` | From `activeAccreditationsCteBody(19)`: authority-gated (`required_posting_auths ?\| $20`) accreditations, ranked per account, latest `accredit` wins — the gated ORCID source for the auto-accept arm. |
| `accepted_claims` | `DISTINCT (claimer, paper_author, paper_permlink)` for `target_users`' claims not voided by a qualifying revoke (signer ∈ `paper_author`/`$17`/`$21`/claimer), AND either explicitly approved (signer ∈ `paper_author`/`$17`) OR auto-accepted by trimmed-ORCID match vs `active_accreditations` OR by normalized hive-username match — all three arms require the claim's `author_index` to resolve to a named `authors[]` slot (list-final). |

**Papers arm**

| CTE | Computes |
|-----|----------|
| `user_papers` | Native papers by target users (`continues IS NULL`) ∪ accepted-claim papers crediting the claimer. Each row carries the credit-recipient `author` plus `chain_author`/`chain_permlink` (the on-chain post identity). |
| `chain_papers` | `SELECT DISTINCT chain_author AS author, chain_permlink AS permlink FROM user_papers` — deduped on-chain posts, so a post credited to N recipients matches the vote/review CTEs once. |
| `paper_vote_signals` → `paper_latest_votes` → `paper_resolved_votes` | Native votes + revote `custom_json` by accredited voters (`block_num < $6`) on `chain_papers` posts; latest-per-(voter, post) wins; self-votes and co-author votes excluded. |
| `paper_reviews` | Per `chain_papers` post, the averaged 4-dimension rating → quality multiplier, over valid non-self accredited-or-anon (`$2`/`$18`) reviews. |
| `paper_vote_agg`, `paper_scores` | Voter-weighted up/down sums; per `user_papers` row `clamp(quality*upvotes − downvotes*W_downvote) * decay`, joined to reviews/votes on the chain identity, credited to `up.author`. |

**Reviews arm**

| CTE | Computes |
|-----|----------|
| `user_reviews` | Each target user's valid non-self accredited-or-anon, non-anonymous reviews on real PEvO parent papers. |
| `review_vote_signals` → `review_latest_votes` → `review_resolved_votes` → `review_vote_agg` → `review_scores` | Votes/revotes on those reviews, resolved latest-per-(voter, review), voter-weighted, `clamp(up − down*W_downvote) * decay`, credited to the reviewer (`ur.author`). |

**Citations arm**

| CTE | Computes |
|-----|----------|
| `citing_papers` | For each target-user paper, `CROSS JOIN LATERAL` over `citations[]`, keeping cited authors ∈ target_users with `reputation_relevant != false`. |
| `citing_vote_signals` → `citing_latest_votes` → `citing_paper_quality` | Votes on the citing posts; per (cited_author, citing post) a self-flag, citing-paper quality, and voter-weighted upvotes excluding the citing author + co-authors. |
| `citation_scores` | Per cited_author: `LEAST(W_citation_max, SUM(clamp(quality * LEAST(weighted_upvotes, 1)) * (self_citation_discount if self else W_citation) * decay))`. |

**Final**

| CTE | Computes |
|-----|----------|
| `totals` | Per target user: `SUM(paper_scores)` as `papers`, `SUM(review_scores)` as `reviews`, `citation_scores` as `citations`, plus `W_accreditation_bonus` if accredited. |

The final `SELECT` clamps `papers + reviews + citations + accreditation` to `[0, 100]`, rounded to 1 decimal, returning the components alongside the total.

**Chain-identity invariant (load-bearing).** Votes and reviews are always signed against the *original poster*, never a claimer, so the paper vote/review CTEs key on the on-chain post identity (`chain_author`/`chain_permlink`) via `chain_papers`, while credit accrues to `up.author` (the claimer on the claim arm, the post author on the native arm) and `totals` does `SUM(...) GROUP BY author`. The `chain_papers` `DISTINCT` is what stops a post credited to several recipients from fan-out-multiplying its votes. (The review-of-a-user arm keys on `ur.author` directly — there the target user *is* the reviewer, so no claimer divergence exists.)

### Notes on the SQL Query

1. **No time functions.** The query derives age from `cycle_ref.ref_ts` (the timestamp of the block before `cycle_end_block`), not from `NOW()`. This makes results reproducible at any time.

2. **Vote resolution.** Native votes and revote custom_json are UNIONed, then `DISTINCT ON (voter, author, permlink) ORDER BY block_num DESC` picks the latest signal. Weight=0 signals are excluded (retractions).

3. **Voter weights from prior cycle.** The `$5` jsonb parameter carries the previous cycle's scores. The `voter_weights` CTE computes the activity-gated weight for each accredited voter. Voters not in `$5` get weight 1.0 (new accounts or bootstrap).

4. **Decay formula.** `GREATEST(w.decay_floor, 1.0 - ((age_months - w.decay_grace_months) * w.decay_rate))` with `age_months = EXTRACT(EPOCH FROM (ref_ts - created)) / (86400 * 30)`. Grace period applies: if `age_months <= w.decay_grace_months`, decay = 1.0.

5. **Self-vote exclusion.** Paper votes exclude the author and co-authors (via `jsonb_array_elements` check on `authors[].hive`). Review votes exclude the reviewer (`voter != author`). Citation upvotes exclude the citing author.

6. **Continuation posts excluded.** `(json_metadata -> $3 -> 'continues') IS NULL` in the `user_papers` CTE.

7. **Anonymous reviews excluded.** `is_anonymous != 'true'` in the `user_reviews` CTE.

8. **Block boundary enforcement.** All vote queries include `AND block_num < $6` to ensure only data within the cycle boundary is considered.

9. **Votes persist across revisions.** Votes are never invalidated by paper edits. The system relies on downvotes, new reviews, and the quality multiplier as corrective mechanisms rather than penalizing authors who revise.

10. **Citation COALESCE.** `LEAST(w.citation_max, COALESCE(SUM(...), 0))` prevents Postgres `LEAST(N, NULL) = N` from awarding phantom citation points when no citations exist.

---

### ORCID-keyed Aggregations

The reputation algorithm today aggregates by Hive account (`tu.username`, `authors[].hive`, the post `author`). It does NOT aggregate by ORCID. ORCID values surface in two narrow places: (a) `authorshipClaimsCteBody`'s ORCID auto-accept trigger (comparing the claimer's accreditation `orcid` to `paper.authors[i].orcid` for a slot-match), and (b) display fields on paper-detail responses (see `agents/docs/hive-schemas.md` § 1.1 "ORCID supersession rule"). Neither is an aggregation over ORCID values, so the supersession rule does not currently change any reputation score.

If a future revision adds an ORCID-keyed query (e.g., "citation counts grouped by author ORCID across papers", or an h-index-style ORCID rollup), the query MUST resolve the canonical display ORCID per the supersession rule rather than aggregating directly on the chain-typed `authors[i].orcid`. Concretely: LEFT JOIN against `active_accreditations` and prefer `aa.orcid` when present, fall back to `authors[].orcid` when not. Aggregating on the chain-typed value would double-count or mis-attribute reputation in the (rare today, growing as the platform onboards) case where a co-author was typed before they were accredited and later verified a different ORCID via accreditation.

The ORCID auto-accept in `authorshipClaimsCteBody` is correctly framed as a one-way slot-matching trigger and is NOT an aggregation. The matched slot is then credited via the existing hive-keyed aggregation (`accepted_claims` JOIN onto papers). No change to auto-accept semantics is required: the rule that "claimer's accreditation `orcid` matches `authors[i].orcid` → auto-accept slot `i`" continues to honor the publisher's chain-stored claim as the slot key.

