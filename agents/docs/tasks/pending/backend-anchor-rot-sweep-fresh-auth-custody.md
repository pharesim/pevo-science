# BACKEND-ANCHOR-ROT-SWEEP-FRESH-AUTH-CUSTODY — de-rot three pre-existing comment anchors surfaced during the IPFS-upload re-review

**Owner:** Backend Agent
**Created:** 2026-06-06 (architect re-review of the IPFS-upload-security cluster)
**Priority:** P3 (comment hygiene; no behavior change)

## Problem

The architect re-review of the IPFS-upload-security cluster (`/ce-code-review`, 6/9 personas clean) surfaced three PRE-EXISTING comment anchors that violate root `CLAUDE.md` "Comment anchors". They were out of scope for the cluster's held tasks (each hold deliberately scoped its fix to one file), so they were filed here rather than swept opportunistically. None changes behavior.

## Sites

1. **`backend/src/lib/fresh-auth.ts` — `inFlightConsumes` docblock cites a memory slug.** The docblock pointing at the single-use in-flight-consume lock cites the `project_single_instance_only` memory slug as the source of the single-process assumption. Replace the slug pointer with the inline invariant, mirroring the fix already landed in the twin docblock in `backend/src/lib/ipfs-upload-token.ts` (state that this deployment is single-process, so the in-process lock is a complete guard, and a multi-instance topology would re-open the race and require a Redis-side sentinel the in-process lock is not a substitute for). Keep the two docblocks consistent.

2. **`backend/src/routes/custody.ts` — round-number anchor above the consent-op consume status ternary.** The comment immediately above the consent-op `consumeFreshAuthToken` failure-to-status mapping (the `username_mismatch || target_mismatch || kind_mismatch ? 403 : 401` ternary on the `/broadcast` consent-op path) carries a round-number coordination anchor ("Round-4 hold #10 + round-5 hold #3"). Re-anchor on the behavioral rationale (binding violations are "forbidden" and return 403; a missing/expired/malformed proof is "no proof present" and returns 401), with no round number, slug, line number, or SHA.

3. **`backend/tests/routes/orcid.test.ts` — round-number in a `describe` title.** The `describe(...)` block for the `POST /api/orcid/callback` `fresh_auth` mode embeds a round-number coordination label ("round-4 hold #6") in its title, which now also fronts the appended `ipfs_upload` issuance test. Reword the title to describe what the block exercises (the ORCID `fresh_auth`-mode callback), dropping the round number.

## Acceptance

1. All three anchors are re-anchored on stable behavioral/symbol semantics; none retains a round number, task slug, memory slug, line number, or SHA.
2. Per the "convention-enforcing fix must audit its own new code" convention, the replacement text in each site introduces no new rot class.
3. The `fresh-auth.ts` and `ipfs-upload-token.ts` `inFlightConsumes` docblocks read consistently after the fix.
4. `npm run typecheck` + `npm run lint` clean; no behavior change (comment/title-only edits).

## References

- root `CLAUDE.md` "Comment anchors" (the three rot classes).
- `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`
- `backend/src/lib/ipfs-upload-token.ts` — the already-de-rotted twin `inFlightConsumes` docblock to mirror.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
