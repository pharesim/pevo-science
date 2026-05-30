/**
 * Mocked-pool SQL-shape canaries for /api/notifications new_review arms.
 *
 * Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c):
 *   (a) Real-corpus seeding is impractical: arm 1a's defended failure mode
 *       is a `type='review'` reply to a non-paper Hive post (a peakd blog
 *       post, a non-paper comment, etc.) authored by the recipient. The
 *       public HAF corpus cannot be deterministically seeded with such a
 *       row + a matching peakd-side review-shaped reply at test time. Arm
 *       1b's `co.author != $1` self-review exclusion has the same seeding
 *       impracticality (a paper author's self-review reply on their own
 *       bridge paper).
 *   (b) `verifyHiveSignature` is mocked via the project-wide
 *       MOCK_VERIFY_SIGNATURE fixture (see
 *       `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`).
 *       This file's focus is SQL-shape predicates, NOT cryptographic
 *       verification behavior, so the carve-out's clause-(b) refinement
 *       permits the fixture: the 401-on-missing-header gate and the
 *       username-extraction behavior are preserved; only the cryptographic
 *       signature check is bypassed. The clause-(c) real-path companion for
 *       the cryptographic-verification risk class on `/api/notifications`
 *       is `auth.test.ts` — it does NOT hoist `MOCK_VERIFY_SIGNATURE`,
 *       stubs `getAccounts` to publish a deterministic test public key so
 *       real `verifyHiveSignature` runs end-to-end, and pins the
 *       cross-endpoint-replay rejection and malformed-signature rejection
 *       paths for this route against signed requests. The narrower residual
 *       gap — a real-signature successful authentication test that proceeds
 *       to HAF on `/api/notifications` — is not currently covered.
 *   (c) Real-path companion: the envelope shape + sort-order + limit
 *       behavior is exercised against real HAF in notifications.test.ts;
 *       this file covers the SQL-shape predicates those tests cannot pin
 *       (a revert of any predicate below would pass every existing test).
 *
 * Canaries pinned in this file:
 *   1. Arm 1a uses INNER JOIN to ${T.comments} p (round-1 hold #3 fix —
 *      LEFT JOIN admitted review-typed replies to non-paper posts and
 *      surfaced new_review notifications with empty titles).
 *   2. Arm 1a's JOIN carries validPevoPaperWhere(source='all') against
 *      the parent comment p, enforcing paper-class identity (the LEFT
 *      JOIN-to-non-paper griefing vector).
 *   3. Comment-derived arms (1a, 1b, 5) each carry `co.author != $1`
 *      self-author exclusion: reverting either inline filter would let a
 *      paper author receive "you reviewed your own paper" notifications, or
 *      a commenter a notification for replying to their own comment. Pinned
 *      both collectively (per-arm count == 3) and per-arm via slices that
 *      isolate arm 1a (first→second `new_review` tag) and arm 1b (second
 *      `new_review` → first `new_vote` tag).
 *   4. Citation arms (6a, 6b) each carry `citing.author <> $1` self-citation
 *      exclusion — the citation-side analogue of the comment arms' filter:
 *      a user citing their own paper must not notify themselves. Pinned
 *      per-arm via slices that isolate arm 6a (first→second `new_citation`
 *      tag) and arm 6b (second `new_citation` → `claim_pending` tag).
 *   5. The accreditation_update arm carries the required_posting_auths
 *      authority gate, so only an accredit/revoke op signed by an
 *      accreditation authority produces a notification — a self-broadcast
 *      op naming the recipient cannot push a spurious accreditation_update.
 *
 * Mutation kill: removing INNER from arm 1a's JOIN, dropping the
 * validPevoPaperWhere predicate from arm 1a, removing `co.author != $1`
 * from any comment-derived arm, removing `citing.author <> $1` from either
 * citation arm, or dropping the required_posting_auths gate from the
 * accreditation_update arm fails the corresponding canary below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/middleware/verifyHiveSignature.js', async () => {
  const { MOCK_VERIFY_SIGNATURE } = await import('../fixtures/index.js');
  return MOCK_VERIFY_SIGNATURE;
});

const { hafQueryMock, getPoolMock } = vi.hoisted(() => ({
  hafQueryMock: vi.fn(async (..._args: any[]) => ({ rows: [] as any[] })),
  getPoolMock: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  getPool: getPoolMock,
  isHafConfigured: () => getPoolMock() !== null,
  closeHafPool: async () => { /* no-op */ },
}));

const { createApp } = await import('../../src/app.js');
const { hafCache } = await import('../../src/cache.js');
const { config } = await import('../../src/config.js');
const app = createApp();

beforeEach(async () => {
  hafQueryMock.mockReset().mockResolvedValue({ rows: [] });
  getPoolMock.mockReset().mockReturnValue({ query: hafQueryMock });
  await hafCache.clear();
});

describe('GET /api/notifications — new_review arm SQL-shape canaries', () => {
  async function captureNotificationsSql(): Promise<{ sql: string; params: unknown[] }> {
    // Use a sinceBlock past the genesis short-circuit so the route reaches
    // the notification query. The route hits pool.query three times in
    // sequence:
    //   1. `getGenesisBlock` — `SELECT MIN(cj.block_num) AS genesis ...
    //      WHERE cj.custom_id = $1`. The first dispatch branch below
    //      short-circuits this with `{ genesis: 0 }` so the `head > genesis`
    //      clamp doesn't engage.
    //   2. `getGenesisBlock` HEAD fallback — `SELECT MAX(block_num) AS head
    //      FROM hafsql.haf_blocks`. Falls through to the catch-all
    //      `return { rows: [] }` branch; no capture (the empty result is
    //      benign for the genesis lookup).
    //   3. `fetchNotificationsFromHaf` — the notification CTE-chain that
    //      we want to inspect. Its UNION-ALL arms tag rows with
    //      `'new_review'::text AS event_type` (and several other event
    //      types); capture only when the SQL contains that distinctive
    //      arm-tag substring so neither bootstrap query nor any future
    //      pre-notifications query added inside the route steals the
    //      capture. `verifyHiveSignature` is mocked at the module level
    //      above via the project-wide MOCK_VERIFY_SIGNATURE fixture; this
    //      file's focus is SQL-shape, not cryptographic verification (see
    //      `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md`
    //      for the auth-mock policy under clause-(b)).
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    hafQueryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      // Bootstrap: genesis-block lookup. Return 0 so the clamp doesn't engage.
      if (sql.includes('AS genesis')) {
        return { rows: [{ genesis: 0 }] };
      }
      // Notifications query — distinguishable by the event-type tags
      // emitted in the UNION-ALL arms.
      if (sql.includes("'new_review'::text")) {
        capturedSql = sql;
        capturedParams = params ?? [];
        return { rows: [] };
      }
      // Anything else: empty fall-through (don't capture).
      return { rows: [] };
    });
    const res = await request(app)
      .get('/api/notifications?since_block=1000000')
      .set('X-Hive-Username', 'pevo.admin')
      .set('X-Hive-Signature', 'mock-sig');
    expect(res.status).toBe(200);
    expect(capturedSql.length).toBeGreaterThan(0);
    return { sql: capturedSql, params: capturedParams };
  }

  it('arm 1a promotes the parent-paper join to INNER JOIN (round-1 hold #3 mutation-kill)', async () => {
    const { sql } = await captureNotificationsSql();
    // The round-1 hold flipped the parent-paper join from LEFT JOIN to
    // INNER JOIN to enforce paper-class existence at the JOIN level.
    // Reverting to LEFT JOIN re-opens the empty-title griefing vector.
    // Detection: arm 1a's parent JOIN is the only `JOIN hafsql.comments p`
    // occurrence in the SQL — arm 1b's `p` is LEFT JOINed (the
    // user_bridge_papers CTE already guarantees paper-class identity), so
    // a `LEFT JOIN hafsql.comments p` substring is fine for 1b. We
    // require the bare `JOIN hafsql.comments p` (no leading `LEFT`) to be
    // present, which only matches arm 1a's INNER JOIN.
    expect(sql).toMatch(/(?<!LEFT )JOIN hafsql\.comments p\b/);
  });

  it('arm 1a JOIN carries validPevoPaperWhere(source=all) paper-class gate (round-1 hold #3)', async () => {
    const { sql } = await captureNotificationsSql();
    // validPevoPaperWhere(source='all') expands to
    //   ((p.json_metadata -> $X ->> 'type') = 'paper'
    //    OR (p.author = $Y AND (p.json_metadata -> $X ->> 'type') = 'bridge_paper'))
    // We pin both arms against the parent alias `p` so a refactor that
    // drops the predicate from arm 1a's JOIN fails red.
    expect(sql).toContain("(p.json_metadata");
    expect(sql).toContain("'paper'");
    expect(sql).toContain("'bridge_paper'");
    // Arm 1b uses validPevoPaperWhere(source='bridge') inside the
    // user_bridge_papers CTE — that hits c.json_metadata, not p.
    // The 'paper' (native) arm above can only originate from arm 1a's
    // source='all' composition.
  });

  it('comment-derived arms (1a, 1b, 5) each apply co.author != $1 self-author exclusion (per-arm count)', async () => {
    const { sql } = await captureNotificationsSql();
    // Reverting the inline `AND co.author != $1` filter lets a paper
    // author receive `new_review` notifications for their own self-reply,
    // and a commenter a `new_reply` notification for replying to themselves.
    // Asymmetric vs `excludeSelfReviewWhere` is deliberate — co-author
    // reviews of a shared paper ARE wanted notifications (notification
    // surface ≠ aggregation surface).
    //
    // Per-arm count: arm 1a (native new-review), arm 1b (bridge new-review),
    // and arm 5 (new_reply) each carry their own inline self-exclusion
    // filter. A revert that drops one but leaves the others is invisible to
    // a bare `toContain` substring check. Match the clause-form (with the
    // leading `AND`) so an explanatory SQL comment mentioning the predicate
    // does not inflate the count, and pin at 3 so a single-arm regression
    // fails red.
    const occurrences = (sql.match(/AND co\.author != \$1/g) ?? []).length;
    expect(occurrences).toBe(3);
  });

  it('arm 1a (native new_review) carries co.author != $1 in its own slice', async () => {
    const { sql } = await captureNotificationsSql();
    // Per-arm slice (complements the collective count above): isolate arm 1a
    // from the first `'new_review'::text` tag up to arm 1b's tag, and assert
    // the self-exclusion lives inside that slice. A revert that drops the
    // filter from arm 1a specifically — while another arm still carries it —
    // would keep the collective count at 3 only if the removed filter were
    // re-added elsewhere; the slice pins the predicate to the native arm.
    const arm1a = sql.match(/'new_review'::text([\s\S]*?)'new_review'::text/);
    expect(arm1a, 'arm 1a slice (first→second new_review tag) not found').not.toBeNull();
    expect(arm1a![1]).toMatch(/AND co\.author != \$1/);
  });

  it('arm 1b (bridge new_review) carries co.author != $1 in its own slice', async () => {
    const { sql } = await captureNotificationsSql();
    // Slice arm 1b from the second `'new_review'::text` tag up to the first
    // `'new_vote'::text` tag (arm 2a). The bridge-review arm must carry the
    // same self-exclusion as the native arm.
    const arm1b = sql.match(/'new_review'::text[\s\S]*?'new_review'::text([\s\S]*?)'new_vote'::text/);
    expect(arm1b, 'arm 1b slice (second new_review→first new_vote tag) not found').not.toBeNull();
    expect(arm1b![1]).toMatch(/AND co\.author != \$1/);
  });

  it('citation arm 6a carries citing.author <> $1 self-citation exclusion in its own slice', async () => {
    const { sql } = await captureNotificationsSql();
    // The citation arms notify the cited author. A user citing their own
    // paper must not notify themselves: the citation-side analogue of the
    // comment arms' `co.author != $1` is `citing.author <> $1` on the citing
    // post's broadcaster. Slice arm 6a from the first `'new_citation'::text`
    // tag to the second (arm 6b's tag).
    const arm6a = sql.match(/'new_citation'::text([\s\S]*?)'new_citation'::text/);
    expect(arm6a, 'arm 6a slice (first→second new_citation tag) not found').not.toBeNull();
    expect(arm6a![1]).toMatch(/AND citing\.author <> \$1/);
  });

  it('citation arm 6b carries citing.author <> $1 self-citation exclusion in its own slice', async () => {
    const { sql } = await captureNotificationsSql();
    // Slice arm 6b from the second `'new_citation'::text` tag to the
    // `'claim_pending'::text` tag (arm 7). The bridge-citation arm carries
    // the same self-citation exclusion as the native arm.
    const arm6b = sql.match(/'new_citation'::text[\s\S]*?'new_citation'::text([\s\S]*?)'claim_pending'::text/);
    expect(arm6b, 'arm 6b slice (second new_citation→claim_pending tag) not found').not.toBeNull();
    expect(arm6b![1]).toMatch(/AND citing\.author <> \$1/);
  });

  it('accreditation_update arm carries the required_posting_auths authority gate', async () => {
    const { sql } = await captureNotificationsSql();
    // The accreditation-update feed reads accredit/revoke ops directly to
    // notify the recipient. Without the authority gate, a self-broadcast
    // accredit/revoke op naming the recipient (signed with any posting key)
    // pushes a spurious accreditation_update notification. Isolate the arm
    // (from its event-type tag to the next arm's tag) and assert the gate
    // lives inside it — `required_posting_auths ?|` also appears in the
    // accred_ranked CTE, so a bare substring check would pass even after a
    // revert of this arm's gate.
    const arm = sql.match(/'accreditation_update'::text[\s\S]*?'new_vouch'::text/);
    expect(arm, 'accreditation_update arm not found in captured SQL').not.toBeNull();
    expect(arm![0]).toMatch(/required_posting_auths \?\|/);
  });

  it('accreditation_update authority gate binds to the accreditationAuthorities param', async () => {
    const { sql, params } = await captureNotificationsSql();
    // The prior canary asserts the `required_posting_auths ?|` text is present
    // inside the arm, but a placeholder-index shift in activeAccreditationsCteBody
    // could move the gate to a different $N (binding it to the wrong value)
    // while the text stays — the prior canary would remain green. Pin the bound
    // value: resolve the arm's gate placeholder back to its position in the
    // params array and assert it carries accreditationAuthorities.
    const arm = sql.match(/'accreditation_update'::text[\s\S]*?'new_vouch'::text/);
    expect(arm, 'accreditation_update arm not found in captured SQL').not.toBeNull();
    const gate = arm![0].match(/required_posting_auths \?\| \$(\d+)::text\[\]/);
    expect(gate, 'authority-gate placeholder not found in accreditation_update arm').not.toBeNull();
    const placeholderIdx = Number(gate![1]);
    expect(params[placeholderIdx - 1]).toEqual(config.accreditationAuthorities);
  });
});
