---
title: "Recursive chain CTEs over pevo.continues: two-phase canonical-path selection, unique-parent linearity, and harness-first validation"
date: 2026-06-10
category: architecture-patterns
module: backend/src/hafsql.ts
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "Writing or modifying a WITH RECURSIVE CTE in hafsql.ts (consentChainCteBody or a sibling) that walks the pevo.continues pointer graph"
  - "Porting a JS iterative walker with per-hop ORDER BY ... LIMIT 1 selection (resolveContinuationChain shape) into SQL"
  - "Reasoning about adversarial fan-out or DoS bounds for recursion over broadcaster-controlled chain pointers"
  - "Designing a complex multi-CTE SQL feature before any test harness exists for it"
related_components:
  - consent-ops
  - paper-version-chain
  - reputation-cycle
tags:
  - recursive-cte
  - postgresql
  - continuation-chain
  - canonical-path
  - synthetic-corpus-harness
  - from-redirect-testing
---

# Recursive chain CTEs over `pevo.continues`: two-phase canonical-path selection, unique-parent linearity, and harness-first validation

## Context

The consented-authorship model required porting the JS continuation-chain walker (`resolveContinuationChain` in `routes/papers.ts`) into SQL as `consentChainCteBody`. The JS walker picks exactly ONE child per hop — the earliest-created admissible continuation (`ORDER BY co.block_num ASC LIMIT 1`) — while threading a cumulative author-admission set down the walk. Translating that per-hop LIMIT-1 selection into a recursive CTE hits hard PostgreSQL constraints, and the obvious workarounds are either wrong or look exponentially dangerous.

## Guidance

**1. The recursive term cannot reference the recursive table inside a subquery or LATERAL.** PostgreSQL rejects any reference to the WITH RECURSIVE working table that is not the single top-level FROM reference: no correlated `(SELECT MIN(...) ... WHERE parent = p.x)` dedup, no `JOIN LATERAL (... WHERE continues -> p ... ORDER BY ... LIMIT 1)`. Per-parent earliest-child selection therefore CANNOT happen during the walk.

**2. Use the two-phase shape instead.** Phase A (recursion 1, `chain_tree`): admit EVERY child that passes the gates (cumulative author-set membership, `validPevoPaperWhere`, visited-array cycle guard, depth cap) — forks materialize as siblings. Phase B (non-recursive): rank siblings per parent with `ROW_NUMBER() OVER (PARTITION BY parent ORDER BY created_block ASC, created_id ASC)`. Phase C (recursion 2, `canonical_chain`): walk the materialized tree following only `sibling_rank = 1` children. Phase C's recursive term may freely subquery `chain_tree`/`ranked_children` — the no-subquery restriction only covers the CTE's own working table, not earlier CTEs.

**3. Per-path state in phase A is safe because parent pointers are unique.** Each post carries exactly ONE `pevo.continues` pointer, so every node has a unique root-path; a node is reached at most once and carries one cumulative-set/visited array. The "tree recursion over adversarial pointers explodes exponentially" fear is unfounded here: fan-out requires multiple CHILDREN per node (cheap to create) but no recombination is possible, so total recursion work is linear in the number of admissible posts. Cycles ARE reachable through a root whose own `continues` points back into its chain — keep the visited-array guard.

**4. Validate the design in a scratch harness against the real planner BEFORE landing it.** A /tmp node script (pg via `createRequire` from `backend/`, temp tables mimicking the hafsql views, a synthetic corpus covering forks/cycles/edits/consent ops) executed the draft SQL in minutes per iteration. It caught a corpus-design error (an edit removing an author from the ROOT's latest metadata silently de-admits that author's whole branch — correct walker semantics, wrong test setup) that would have been a confusing vitest failure. The harness then converted directly into the durable regression test (`tests/consented-authors-cte-real-postgres.test.ts`) via the FROM-redirect technique (`sql.split(T.comments).join('syn_comments')` with a drift guard), running the PRODUCTION fragments verbatim.

**5. Composition mechanics.** A WITH list containing any recursive member needs `WITH RECURSIVE` — `buildRecursiveWith` exists so non-recursive queries keep their byte-stable `WITH ` prefix for shape canaries. Two chain backbones can coexist in one WITH via the `namePrefix` option (the claims builder embeds a `claims_`-prefixed copy seeded from `claims_base` through the `rootsFromCte` scope variant, bounding the walk by claim cardinality).

## Why This Matters

Getting any of these wrong produces either invalid SQL (constraint 1), silently divergent semantics from the JS walker (earliest-wins forks resolved differently → wrong credit), or an unnecessary redesign driven by a phantom DoS (the exponential-fan-out fear). The harness-first loop turned a multi-hour SQL debugging cycle into minute-scale iterations and produced the regression suite as a byproduct.

## When to Apply

Any change to `consentChainCteBody` or a new recursive walk over `pevo.continues` (or any other single-parent pointer graph in HAF data); any port of a JS iterative walker with per-hop selection into SQL; any complex CTE feature where the test harness does not exist yet.

## Examples

Phase B/C core (the shape that replaces per-hop LIMIT 1):

```sql
ranked_children AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY root_author, root_permlink, parent_author, parent_permlink
    ORDER BY created_block ASC NULLS LAST, created_id ASC NULLS LAST
  ) AS sibling_rank
  FROM chain_node_created WHERE depth > 0
),
canonical_chain AS (
  SELECT ... FROM chain_node_created WHERE depth = 0
  UNION ALL
  SELECT r.* FROM canonical_chain p
  JOIN ranked_children r
    ON r.parent_author = p.author AND r.parent_permlink = p.permlink
   AND r.sibling_rank = 1   -- earliest admissible child, exactly the JS walker's pick
)
```

FROM-redirect drift guard in the regression test (silent no-op redirect would run against live HAF and pass/fail for the wrong reason):

```ts
sql = sql.split(T.comments).join('syn_comments');
expect(sql).not.toContain(T.comments);
```
