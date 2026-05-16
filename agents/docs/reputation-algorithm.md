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

Authors with accepted authorship claims on a paper receive the same paper reputation score as the posting author. The paper's votes, reviews, decay, and quality multiplier all apply identically. This is implemented via `accepted_claims` in the reputation query, which resolves claim status using the same logic as `authorshipClaimsCteBody` (explicit approval, ORCID auto-accept, hive username auto-accept, with revocation override). Self-claims (claimer = post author) are excluded to avoid double counting.

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

This SQL query **is** the algorithm definition. It computes reputation scores for all target users in a single pass. Shared CTEs (cycle_ref, prev_scores, active_authors, voter_weights) run once regardless of user count. Anyone with HAF access can run it and get identical scores given the same inputs.

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `$1` | `text[]` | Target usernames (users whose reputation is being computed) |
| `$2` | `text[]` | Array of all accredited account names |
| `$3` | `text` | `APP_TAG` (e.g., `pevotest`) |
| `$4` | `text` | `APP_TAG/%` (app LIKE pattern, e.g., `pevotest/%`) |
| `$5` | `jsonb` | Previous cycle scores: `{"user1": 42.5, "user2": 10.0, ...}` or `'{}'::jsonb` for cycle 0 |
| `$6` | `int` | `cycle_end_block`: only data with `block_num < $6` is included |
| `$7` | `int` | Genesis block number |
| `$8` | `numeric` | `W_paper` (default 20) |
| `$9` | `numeric` | `W_review` (default 10) |
| `$10` | `numeric` | `W_downvote` (default 2) |
| `$11` | `numeric` | `W_citation` (default 3) |
| `$12` | `numeric` | `W_citation_max` (default 15) |
| `$13` | `numeric` | `W_accreditation_bonus` (default 5) |
| `$14` | `numeric` | `W_self_citation_discount` (default 0.05) |
| `$15` | `numeric` | `W_decay_rate` (default 0.02) |
| `$16` | `numeric` | `W_decay_floor` (default 0.3) |
| `$17` | `numeric` | `W_decay_grace_months` (default 6) |

### Return

One row per target user:
```json
{"username": "alice", "score": 29.0, "papers": 12.0, "reviews": 8.0, "citations": 4.0, "accreditation": 5}
```

### Query

```sql
-- ═══════════════════════════════════════════════════════════════════
-- PEvO Reputation — Canonical SQL Query (v0.5)
--
-- Computes reputation scores for all target users in one pass.
-- Deterministic: same inputs → same output, no time-based functions.
-- ═══════════════════════════════════════════════════════════════════

WITH

-- ── Cast weight parameters once ─────────────────────────────────
w AS (SELECT
  $8::numeric  AS paper,
  $9::numeric  AS review,
  $10::numeric AS downvote,
  $11::numeric AS citation,
  $12::numeric AS citation_max,
  $13::numeric AS accreditation_bonus,
  $14::numeric AS self_citation_discount,
  $15::numeric AS decay_rate,
  $16::numeric AS decay_floor,
  $17::numeric AS decay_grace_months
),

-- ── Target users ────────────────────────────────────────────────
target_users AS (
  SELECT unnest AS username FROM unnest($1::text[])
),

-- ── Reference timestamp from cycle_end_block ────────────────────
-- Used for age-based decay. No NOW() or time functions.
cycle_ref AS (
  SELECT b.timestamp AS ref_ts
  FROM hafsql.haf_blocks b
  WHERE b.block_num = $6 - 1
),

-- ── Previous cycle scores (jsonb → table) ───────────────────────
prev_scores AS (
  SELECT key AS username, value::numeric AS rep
  FROM jsonb_each_text($5)
),

-- ── Active authors: users who have published or reviewed ───────
-- Used for the activity-gated voter weight floor (R9). Distinct from the
-- "users to score" set (which is `getAllAccreditedAccounts()`); a newly-
-- accredited but non-publishing user is scored but does not get the
-- accredited-active voter bonus until they author a paper or review.
active_authors AS (
  SELECT DISTINCT author FROM (
    SELECT c.author FROM hafsql.comments c
    WHERE c.parent_author = '' AND c.parent_permlink = $3
      AND (c.json_metadata -> $3 ->> 'type') IN ('paper', 'bridge_paper')
      AND c.json_metadata ->> 'app' LIKE $4
    UNION ALL
    SELECT c.author FROM hafsql.comments c
    JOIN hafsql.comments p ON p.author = c.parent_author AND p.permlink = c.parent_permlink
    WHERE p.parent_author = '' AND p.parent_permlink = $3
      AND p.json_metadata ->> 'app' LIKE $4
      AND (c.json_metadata -> $3 ->> 'type') = 'review'
      AND c.json_metadata ->> 'app' LIKE $4
  ) t
),

-- ── Voter weight lookup ─────────────────────────────────────────
-- For each accredited voter, compute their weight from prior cycle.
-- Active (has paper/review): LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(rep/100)))
-- Inactive:                  LEAST(1.0, sqrt(rep/100))
-- Not in prev_scores:        1.0 (bootstrap/new account)
voter_weights AS (
  SELECT
    a.voter,
    CASE
      WHEN ps.rep IS NULL THEN 1.0  -- not in prev scores → bootstrap
      WHEN aa.author IS NOT NULL THEN  -- active voter
        LEAST(1.0, GREATEST(0.4, 0.4 + 0.6 * sqrt(ps.rep / 100.0)))
      ELSE  -- inactive voter
        LEAST(1.0, sqrt(ps.rep / 100.0))
    END AS vw
  FROM unnest($2::text[]) AS a(voter)
  LEFT JOIN prev_scores ps ON ps.username = a.voter
  LEFT JOIN active_authors aa ON aa.author = a.voter
),

-- ═══ PAPERS ═══
user_papers AS (
  SELECT c.author, c.permlink, c.created, c.json_metadata
  FROM hafsql.comments c
  WHERE c.author IN (SELECT username FROM target_users)
    AND c.parent_author = '' AND c.parent_permlink = $3
    AND (c.json_metadata -> $3 ->> 'type') = 'paper'
    AND c.json_metadata ->> 'app' LIKE $4
    AND (c.json_metadata -> $3 -> 'continues') IS NULL
),

paper_vote_signals AS (
  SELECT voter, author, permlink, weight, block_num FROM (
    SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
    FROM hafsql.operation_vote_view vo
    WHERE vo.voter = ANY($2::text[])
      AND vo.author IN (SELECT username FROM target_users)
      AND EXISTS (SELECT 1 FROM user_papers up WHERE up.author = vo.author AND up.permlink = vo.permlink)
      AND vo.block_num >= $7 AND vo.block_num < $6
    UNION ALL
    SELECT
      cj.required_posting_auths ->> 0 AS voter,
      cj.json::jsonb ->> 'author' AS author,
      cj.json::jsonb ->> 'permlink' AS permlink,
      (cj.json::jsonb ->> 'weight')::int AS weight,
      cj.block_num
    FROM hafsql.operation_custom_json_view cj
    WHERE cj.custom_id = $3
      AND cj.json::jsonb ->> 'action' = 'revote'
      AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
      AND cj.block_num >= $7 AND cj.block_num < $6
      AND cj.required_posting_auths ->> 0 = ANY($2::text[])
  ) all_signals
),

paper_latest_votes AS (
  SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight, block_num
  FROM paper_vote_signals
  ORDER BY voter, author, permlink, block_num DESC
),

paper_resolved_votes AS (
  SELECT plv.voter, plv.author, plv.permlink, plv.weight, plv.block_num
  FROM paper_latest_votes plv
  JOIN user_papers up ON up.author = plv.author AND up.permlink = plv.permlink
  WHERE plv.voter != up.author
    AND plv.weight != 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(up.json_metadata -> $3 -> 'authors') a
      WHERE a ->> 'hive' = plv.voter
    )
),

paper_reviews AS (
  SELECT up.author, up.permlink,
    AVG(
      ((c.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
       (c.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
       (c.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
       (c.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
    ) / 5.0 AS quality
  FROM user_papers up
  JOIN hafsql.comments c
    ON c.parent_author = up.author AND c.parent_permlink = up.permlink
    AND (c.json_metadata -> $3 ->> 'type') = 'review'
    AND c.json_metadata ->> 'app' LIKE $4
  GROUP BY up.author, up.permlink
),

paper_vote_agg AS (
  SELECT prv.author, prv.permlink,
    COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight > 0), 0) AS weighted_up,
    COALESCE(SUM(vw.vw * ABS(prv.weight) / 10000.0) FILTER (WHERE prv.weight < 0), 0) AS weighted_down
  FROM paper_resolved_votes prv
  JOIN voter_weights vw ON vw.voter = prv.voter
  GROUP BY prv.author, prv.permlink
),

paper_scores AS (
  SELECT up.author, up.permlink,
    GREATEST(-w.paper, LEAST(w.paper,
      COALESCE(pr.quality, 1.0) * LEAST(COALESCE(pva.weighted_up, 0), w.paper)
      - COALESCE(pva.weighted_down, 0) * w.downvote
    )) * GREATEST(w.decay_floor,
      CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
        ELSE GREATEST(w.decay_floor,
          1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - up.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
        )
      END
    ) AS score
  FROM user_papers up
  CROSS JOIN cycle_ref cr
  CROSS JOIN w
  LEFT JOIN paper_reviews pr ON pr.author = up.author AND pr.permlink = up.permlink
  LEFT JOIN paper_vote_agg pva ON pva.author = up.author AND pva.permlink = up.permlink
),

-- ═══ REVIEWS ═══
user_reviews AS (
  SELECT c.author, c.permlink, c.created
  FROM hafsql.comments c
  WHERE c.author IN (SELECT username FROM target_users)
    AND (c.json_metadata -> $3 ->> 'type') = 'review'
    AND c.json_metadata ->> 'app' LIKE $4
    AND COALESCE(c.json_metadata -> $3 ->> 'is_anonymous', 'false') != 'true'
),

review_vote_signals AS (
  SELECT voter, author, permlink, weight, block_num FROM (
    SELECT vo.voter, vo.author, vo.permlink, vo.weight, vo.block_num
    FROM hafsql.operation_vote_view vo
    WHERE vo.voter = ANY($2::text[])
      AND vo.author IN (SELECT username FROM target_users)
      AND EXISTS (SELECT 1 FROM user_reviews ur WHERE ur.author = vo.author AND ur.permlink = vo.permlink)
      AND vo.block_num >= $7 AND vo.block_num < $6
    UNION ALL
    SELECT
      cj.required_posting_auths ->> 0 AS voter,
      cj.json::jsonb ->> 'author' AS author,
      cj.json::jsonb ->> 'permlink' AS permlink,
      (cj.json::jsonb ->> 'weight')::int AS weight,
      cj.block_num
    FROM hafsql.operation_custom_json_view cj
    WHERE cj.custom_id = $3
      AND cj.json::jsonb ->> 'action' = 'revote'
      AND cj.json::jsonb ->> 'author' IN (SELECT username FROM target_users)
      AND cj.block_num >= $7 AND cj.block_num < $6
      AND cj.required_posting_auths ->> 0 = ANY($2::text[])
  ) all_signals
),

review_latest_votes AS (
  SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
  FROM review_vote_signals
  ORDER BY voter, author, permlink, block_num DESC
),

review_resolved_votes AS (
  SELECT rlv.voter, rlv.author, rlv.permlink, rlv.weight
  FROM review_latest_votes rlv
  JOIN user_reviews ur ON ur.author = rlv.author AND ur.permlink = rlv.permlink
  WHERE rlv.voter != rlv.author
    AND rlv.weight != 0
),

review_vote_agg AS (
  SELECT rrv.author, rrv.permlink,
    COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight > 0), 0) AS weighted_up,
    COALESCE(SUM(vw.vw * ABS(rrv.weight) / 10000.0) FILTER (WHERE rrv.weight < 0), 0) AS weighted_down
  FROM review_resolved_votes rrv
  JOIN voter_weights vw ON vw.voter = rrv.voter
  GROUP BY rrv.author, rrv.permlink
),

review_scores AS (
  SELECT ur.author, ur.permlink,
    GREATEST(-w.review, LEAST(w.review,
      LEAST(COALESCE(rva.weighted_up, 0), w.review)
      - COALESCE(rva.weighted_down, 0) * w.downvote
    )) * GREATEST(w.decay_floor,
      CASE
        WHEN EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
        ELSE GREATEST(w.decay_floor,
          1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - ur.created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
        )
      END
    ) AS score
  FROM user_reviews ur
  CROSS JOIN cycle_ref cr
  CROSS JOIN w
  LEFT JOIN review_vote_agg rva ON rva.author = ur.author AND rva.permlink = ur.permlink
),

-- ═══ CITATIONS ═══
citing_papers AS (
  SELECT
    citing.author AS citing_author,
    citing.permlink AS citing_permlink,
    citing.created AS citing_created,
    citing.json_metadata AS citing_meta,
    cit ->> 'author' AS cited_author,
    COALESCE((cit ->> 'reputation_relevant')::boolean, true) AS reputation_relevant
  FROM hafsql.comments citing
  CROSS JOIN LATERAL jsonb_array_elements(
    citing.json_metadata -> $3 -> 'citations'
  ) AS cit
  WHERE citing.parent_author = '' AND citing.parent_permlink = $3
    AND (citing.json_metadata -> $3 ->> 'type') = 'paper'
    AND citing.json_metadata ->> 'app' LIKE $4
    AND jsonb_typeof(citing.json_metadata -> $3 -> 'citations') = 'array'
    AND citing.author = ANY($2::text[])
    AND (cit ->> 'author') IN (SELECT username FROM target_users)
    AND COALESCE((cit ->> 'reputation_relevant')::boolean, true) = true
),

citing_vote_signals AS (
  SELECT voter, permlink, author, weight, block_num FROM (
    SELECT vo.voter, vo.permlink, vo.author, vo.weight, vo.block_num
    FROM hafsql.operation_vote_view vo
    WHERE vo.voter = ANY($2::text[])
      AND (vo.author, vo.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
      AND vo.block_num >= $7 AND vo.block_num < $6
    UNION ALL
    SELECT
      cj.required_posting_auths ->> 0 AS voter,
      cj.json::jsonb ->> 'permlink' AS permlink,
      cj.json::jsonb ->> 'author' AS author,
      (cj.json::jsonb ->> 'weight')::int AS weight,
      cj.block_num
    FROM hafsql.operation_custom_json_view cj
    WHERE cj.custom_id = $3
      AND cj.json::jsonb ->> 'action' = 'revote'
      AND cj.block_num >= $7 AND cj.block_num < $6
      AND cj.required_posting_auths ->> 0 = ANY($2::text[])
      AND (cj.json::jsonb ->> 'author', cj.json::jsonb ->> 'permlink')
        IN (SELECT citing_author, citing_permlink FROM citing_papers)
  ) all_signals
),

citing_latest_votes AS (
  SELECT DISTINCT ON (voter, author, permlink) voter, author, permlink, weight
  FROM citing_vote_signals
  ORDER BY voter, author, permlink, block_num DESC
),

citing_paper_quality AS (
  SELECT
    cp.cited_author,
    cp.citing_author,
    cp.citing_permlink,
    cp.citing_created,
    cp.citing_author = cp.cited_author AS is_self,
    COALESCE(cpr.quality, 1.0) AS review_quality,
    COALESCE(SUM(vw.vw * ABS(clv.weight) / 10000.0)
      FILTER (WHERE clv.weight > 0 AND clv.voter != cp.citing_author AND clv.weight != 0), 0
    ) AS weighted_upvotes
  FROM citing_papers cp
  LEFT JOIN (
    SELECT up2.permlink, up2.author,
      AVG(
        ((c2.json_metadata -> $3 -> 'rating' ->> 'methodology')::numeric +
         (c2.json_metadata -> $3 -> 'rating' ->> 'novelty')::numeric +
         (c2.json_metadata -> $3 -> 'rating' ->> 'clarity')::numeric +
         (c2.json_metadata -> $3 -> 'rating' ->> 'significance')::numeric) / 4.0
      ) / 5.0 AS quality
    FROM hafsql.comments up2
    JOIN hafsql.comments c2
      ON c2.parent_author = up2.author AND c2.parent_permlink = up2.permlink
      AND (c2.json_metadata -> $3 ->> 'type') = 'review'
      AND c2.json_metadata ->> 'app' LIKE $4
    WHERE (up2.author, up2.permlink) IN (SELECT citing_author, citing_permlink FROM citing_papers)
    GROUP BY up2.permlink, up2.author
  ) cpr ON cpr.author = cp.citing_author AND cpr.permlink = cp.citing_permlink
  LEFT JOIN citing_latest_votes clv
    ON clv.author = cp.citing_author AND clv.permlink = cp.citing_permlink
  LEFT JOIN voter_weights vw ON vw.voter = clv.voter
  GROUP BY cp.cited_author, cp.citing_author, cp.citing_permlink, cp.citing_created, cpr.quality
),

citation_scores AS (
  SELECT cpq.cited_author AS author,
    LEAST(w.citation_max, COALESCE(SUM(
      GREATEST(0, LEAST(1.0, cpq.review_quality * LEAST(cpq.weighted_upvotes, 1.0)))
      * CASE WHEN cpq.is_self THEN w.self_citation_discount ELSE w.citation END
      * GREATEST(w.decay_floor,
          CASE
            WHEN EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) <= w.decay_grace_months THEN 1.0
            ELSE GREATEST(w.decay_floor,
              1.0 - ((EXTRACT(EPOCH FROM (cr.ref_ts - cpq.citing_created)) / (86400.0 * 30) - w.decay_grace_months) * w.decay_rate)
            )
          END
        )
    ), 0)) AS score
  FROM citing_paper_quality cpq
  CROSS JOIN cycle_ref cr
  CROSS JOIN w
  GROUP BY cpq.cited_author, w.citation_max, w.self_citation_discount, w.citation,
           w.decay_floor, w.decay_grace_months, w.decay_rate
),

-- ═══ FINAL AGGREGATION ═══
totals AS (
  SELECT
    tu.username,
    COALESCE(ps_agg.papers, 0) AS papers,
    COALESCE(rs_agg.reviews, 0) AS reviews,
    COALESCE(cs.score, 0) AS citations,
    CASE WHEN tu.username = ANY($2::text[]) THEN w.accreditation_bonus ELSE 0 END AS accreditation
  FROM target_users tu
  CROSS JOIN w
  LEFT JOIN (SELECT author, SUM(score) AS papers FROM paper_scores GROUP BY author) ps_agg
    ON ps_agg.author = tu.username
  LEFT JOIN (SELECT author, SUM(score) AS reviews FROM review_scores GROUP BY author) rs_agg
    ON rs_agg.author = tu.username
  LEFT JOIN citation_scores cs ON cs.author = tu.username
)

SELECT
  username,
  LEAST(100, GREATEST(0, ROUND((papers + reviews + citations + accreditation)::numeric, 1))) AS score,
  ROUND(papers::numeric, 1) AS papers,
  ROUND(reviews::numeric, 1) AS reviews,
  ROUND(citations::numeric, 1) AS citations,
  accreditation::numeric AS accreditation
FROM totals;
```

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

