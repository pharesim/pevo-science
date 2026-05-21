# ARCHITECT-EXTRACT-PINNER-TO-OWN-REPO — Move the pinner out of the PEvO monorepo into its own repository

**Owner:** architect
**Created:** 2026-05-21
**Priority:** P2 (structural cleanup, not blocking ongoing PEvO work)

## Context

The pinner is already structurally separate from the rest of PEvO:

- It has its own `pinner/Dockerfile` and is NOT a service in PEvO's `docker-compose.yml`. PEvO operators do not run the pinner; community operators deploy it independently against their own HAF mirror.
- It is a Go service; the rest of PEvO is Node.js + Alpine. The two share no runtime libraries.
- Its lifecycle (release cadence, supervision model, orchestrator grace period) is independent. The recent `pinner-shutdown-drain` task and `/ce-code-review` triage surfaced that the pinner's deployment constraints (Docker SIGTERM grace, drain budget) are concerns PEvO's main repo learnings don't share.
- The discovery contract is one-way and minimal: the pinner reads HAF SQL filtered by `APP_TAG`. There is no PEvO → pinner call path today.

Keeping the pinner in the PEvO monorepo dilutes `agents/docs/solutions/` with pinner-specific learnings (the fetch-abort-controller doc explicitly scopes "IPFS gateway wrappers in pinner code") and the `architect`/`pinner`/`backend`/`ui` zone map carries a fourth role that does not belong to PEvO's core work. The just-completed pinner-shutdown-drain code-review surfaced an in-flight task (`pinner-drain-timeout-partial-block-trust`) and a held task whose follow-up work would more naturally land in a dedicated pinner repo's history.

## Decisions (settled before planning)

1. **History preservation strategy:** `git-filter-repo` to carry the `pinner/` subdirectory's commit history into the new repo. Future archaeologists keep `git blame` continuity on the Go source.
2. **Repo name:** `pevo-pinner`. Lineage signal to the PEvO ecosystem; disambiguates from generic "pinner."
3. **Sibling-agent coordination:** sibling pinner agent's in-flight autopin-concurrency-and-quota work lands in PEvO main BEFORE the extraction runs. Clean cut; no WIP migration.
4. **Day-1 agent shape:** single-agent (architect-only) in the new repo. Future split into architect + pinner agent is a follow-up if the new repo's task volume warrants it.
5. **License & branding:** AGPL-3.0, community-forkable, matches PEvO's stance.

## Goal

Move all pinner-bearing surfaces to `pevo-pinner` and clean up PEvO main so it no longer carries any pinner-specific code, coordination, or zone references.

### Phase A — Prerequisites (block the extraction until clear)

**Phase A SKIPPED per user decision 2026-05-21:** "We won't do any more pinner work here." In-flight pinner tasks in `tasks/review/` will NOT be reviewed in PEvO main; they migrate as-is to `pevo-pinner/agents/docs/tasks/review/` (see Phase D step 14). No code-review pass on the sibling-pinner work happens here; whatever pinner code is committed to PEvO main at extraction time is the snapshot that ships to `pevo-pinner`. The "DO NOT START NEW WORK" notice is also unnecessary — the pinner agent is being retired from PEvO main entirely (Phase F removes its CLAUDE.md and zone).

### Phase B — Extract via git-filter-repo (architect-local)

3. **Install git-filter-repo** if not present. `pip install git-filter-repo` or via package manager. Confirm `git filter-repo --version`.
4. **Clone PEvO to a temporary candidate path** (e.g., `~/workspace/pevo-pinner-candidate`). Use a fresh local clone, not a worktree, so the filter-repo rewrite does not affect PEvO main.
5. **Run `git filter-repo --subdirectory-filter pinner` inside the candidate clone.** This rewrites history to contain only the `pinner/` subdirectory's commits with `pinner/` stripped from every path. Verify by running `git log --oneline | wc -l` (should see fewer commits than PEvO main) and `ls` (should see `main.go`, `Dockerfile`, `go.mod`, etc., directly at the root).
6. **Sanity check the rewrite.** Confirm `go build ./...` succeeds at the candidate's HEAD. Confirm `go test ./...` passes (the existing test suite covers most of the pinner; this is the smoke test that the extraction did not break the build). If the build fails, investigate before continuing — likely cause is an import path that referenced a module name now stale.
7. **Adjust the module path in `go.mod`** to the new repo's URL (e.g., `module github.com/<owner>/pevo-pinner`). Find/replace any internal imports that referenced the old path (likely none, since pinner/ is `package main`-flat, but verify with `grep -r "import.*pinner" .`).

### Phase C — User creates the GitHub repo and pushes (user-action gate)

8. **USER ACTION: Create the GitHub repo.** Run `gh repo create <owner>/pevo-pinner --public --description "Community-operated IPFS pinning service for PEvO" --license AGPL-3.0`. Confirm the URL and update Phase B's `go.mod` module path if it differs from the assumed URL.
9. **USER ACTION: Push the rewritten history.** From the candidate clone: `git remote add origin git@github.com:<owner>/pevo-pinner.git`; `git push -u origin main`. Confirm via `gh repo view <owner>/pevo-pinner` that the commit graph matches expectations.

The architect cannot SSH or run `gh` against an account; these steps require the user. The architect's job in this phase is to spell out the commands and stand by.

### Phase D — Populate the new repo with coordination assets

10. **CLAUDE.md (root) of pevo-pinner.** Adapt `agents/pinner/CLAUDE.md` from PEvO main into the new repo's root `CLAUDE.md`. For day-1 single-agent shape, merge in only the parts of PEvO's root `CLAUDE.md` that are still relevant: comment-anchor conventions, commit-msg discipline (without the multi-agent zone-audit hook, which is overkill for single-agent), `Co-Authored-By` trailer requirement, the "stage only files you edited" rule. Strip out anything PEvO-specific (Hive, IPFS pinning constraints from a PEvO-paper perspective, accreditation, reputation). The pinner is an IPFS service that happens to read HAF; it is not part of PEvO's scientific-publication identity.
11. **README.md.** New file. Describe what the pinner is, who runs it (community operators), how to deploy (Docker), what `APP_TAG` to set, and how it interacts with PEvO indirectly via HAF SQL. Mention the AGPL-3.0 license and the PEvO project as the original consumer.
12. **LICENSE.** AGPL-3.0. Copy from PEvO main if compatible.
13. **agents/docs/ARCHITECTURE.md** (in pevo-pinner). New file. Cover: discovery via HAF SQL (the query shape, the `APP_TAG` filter), the autopin rule engine, the embedded IPFS node vs Pinata backend choice, the gateway-server architecture, the drain shutdown sequence (will need to be re-described after the drain-timeout-partial-block-trust work completes, which now lands in pevo-pinner not PEvO). This is the pinner's own architecture doc, not a fragment carried from PEvO.
14. **agents/docs/tasks/{pending,review,blocked}/ migrated.** Move every `pinner-*.md` task file from PEvO main's tasks tree to pevo-pinner's tasks tree, preserving the section (pending/review/blocked) each file currently sits in. As of 2026-05-21:
    - Migrate to `pevo-pinner/agents/docs/tasks/pending/`:
      - `pinner-drain-timeout-partial-block-trust.md`
      - `pinner-embedded-ipfs-node-via-boxo.md`
      - `pinner-shutdown-drain-in-flight-pins.md` (held; carries its 2 hold-block items)
    - Migrate to `pevo-pinner/agents/docs/tasks/review/`:
      - `pinner-autopin-concurrency-and-quota.md`
      - `pinner-cid-validation-on-autopin-path.md`
      - `pinner-response-size-cap-on-gateway-fetch.md`
    - `tasks/blocked/`: no `pinner-*` files currently (verified 2026-05-21); re-check at execution time.
    - Re-check `git status` for any new `pinner-*` task files added between this planning and execution and migrate them too.
    - The slug prefix stays `pinner-*` in the new repo because the new repo's single-agent shape still wants role-prefix consistency; if the new repo later moves to multi-agent, the architect-vs-pinner split can be revisited.
15. **agents/docs/solutions/ — selective carry.** Most of PEvO's solutions docs that mention "pinner" are git-coordination conventions (commit-zone-audit-hook, concurrent-agent-staging-sweep, git-restore-staged, parallel-agent-git-index-race, etc.) that apply to PEvO's multi-agent setup and are irrelevant to pevo-pinner's single-agent day-1. Only carry the genuinely pinner-domain learnings:
    - `agents/docs/solutions/conventions/fetch-abort-controller-bounds-headers-only-2026-05-06.md` — explicitly scopes "IPFS gateway wrappers in pinner code"; copy with a note that the PEvO-side scope text should be updated when this task completes (or strip the PEvO-specific framing entirely).
    - Audit `boot-fatal-flush-watchdog-pattern-2026-05-11.md` — pino-flush specific; likely stays in PEvO main only, but its drain-or-die principle is referenced by the pinner work. Decide at execution: copy with adaptation, or leave PEvO-only and reference cross-repo.
    - Everything else: stay in PEvO main only. Tag the carried entries as "imported 2026-MM-DD from pevo-science/agents/docs/solutions/" inside the file body so the lineage is visible.
16. **tasks-archive.md (new, in pevo-pinner).** Initialize with the most recent archived pinner-* entries from PEvO main's `agents/docs/tasks-archive.md` (search for `## PINNER-*` headings). Carry the last 5-10 archived pinner entries; older history lives in PEvO main's archive forever, which is fine.
17. **.gitignore** for the new repo. Copy Go-appropriate ignores: `*.pevo-pinner` binary, build artifacts, etc. Do not carry PEvO's Node-specific gitignore patterns.
18. **README mention of the new repo in pevo-pinner itself.** Cross-link to pharesim/pevo-science as the canonical PEvO consumer.
19. **USER ACTION: commit and push.** The architect produces the file diffs locally inside the candidate clone; the user runs `git commit` (with appropriate trailers) and `git push`. Multiple commits acceptable, one per logical group (CLAUDE/README/LICENSE → coordination tree → tasks migration → solutions audit).

### Phase E — Cross-repo coordination surface

20. **Define the discovery contract.** The pinner reads HAF SQL filtered by `APP_TAG`. The contract is the query shape (which HAF tables/views, which columns, which JSON paths inside `json_metadata`), and the `APP_TAG` value. Document this in `pevo-pinner/agents/docs/ARCHITECTURE.md` as the upstream-coupling section. PEvO's own `agents/docs/ARCHITECTURE.md` should reference it briefly: "Community pinners discover papers via HAF SQL filtered by APP_TAG; see pevo-pinner repo for the discovery query and autopin rule shape."
21. **Define the gateway-endpoint contract.** PEvO's frontend reads CIDs and may fetch them through an IPFS gateway. Today the gateway endpoint is configured per-deployment (PEvO's `ipfsGateway` config from `window.__PEVO_CONFIG__`). Document that community pinners expose a gateway on a configurable port; PEvO operators choosing to use a community pinner point `ipfsGateway` at it. No code coupling; configuration coupling only.
22. **`APP_TAG` synchronization.** Both repos use the same env var name. Document in pevo-pinner's CLAUDE.md / README that operators MUST set `APP_TAG` to match the PEvO instance they're pinning for (`pevo` for production, `pevotest` for beta). PEvO's existing convention stays intact.
23. **Drift detection.** No technical mechanism today; future improvement. For now, document that breaking changes to the HAF discovery query in PEvO require a heads-up to community pinners. Add a one-line note to `agents/docs/ARCHITECTURE.md` in PEvO main: "Changes to the HAF discovery query consumed by pevo-pinner are breaking changes for community deployments; flag in PR description."

### Phase F — PEvO main repo cleanup

24. **Remove `pinner/` directory.** `git rm -r pinner/`.
25. **Remove pinner zones from `.githooks/commit-msg`.** Edit `allowed_for_agent()` to drop the `pinner)` case. Edit `AGENT_PATTERN` to remove `|pinner`. Run `bash .githooks/tests/test-commit-msg.sh` to confirm the hook tests still pass (some tests likely reference the pinner case and will need to be updated or removed).
26. **Remove `agents/pinner/CLAUDE.md`** (already moved to pevo-pinner's root CLAUDE.md).
27. **Remove pinner enumeration from root `CLAUDE.md`.**
    - Update the "permanently multi-agent setup" sentence to list architect/backend/ui (drop pinner).
    - Update the "Subject-prefix style" example list to drop pinner from `<role>`.
    - Update the "shared-index race discipline" sentence to drop pinner.
    - Update the "review skill" sentence to drop pinner.
    - Update the "implementer agents" sentence in Asking Questions to drop pinner.
    - Update the Startup Protocol implementer-agents enumeration.
28. **Remove pinner reference from `agents/architect/CLAUDE.md`.** The "per-agent protocol files" line lists `architect/backend/ui/pinner` — drop pinner.
29. **Update `agents/docs/ARCHITECTURE.md`.**
    - The Pinner constraint section (around line 285) currently says "PEvO's IPFS pinning service must retain pins...". Rewrite this as: "The PEvO project relies on community-operated pinners that follow the per-version retention invariant. Pinner implementation lives in the pevo-pinner repo; see pevo-pinner/agents/docs/ARCHITECTURE.md for the discovery pipeline." Move the operational details (HAF query shape, retention invariant) to pevo-pinner's ARCHITECTURE.md.
    - The topology diagram references the IPFS Gateway and Kubo node — keep these because PEvO's backend still uploads to its own IPFS node (the embedded mode in pinner is a parallel concern). Verify the diagram still reads correctly without the pinner-specific framing.
30. **Update root `README.md`.** Replace any "pinner" descriptions with a one-paragraph "Community pinners: see pevo-pinner" pointer.
31. **Migrate the in-flight commit (2c582a0e) content.** The held `pinner-shutdown-drain-in-flight-pins.md` task file (with 2 hold-block items) and the new `pinner-drain-timeout-partial-block-trust.md` task file currently sit in PEvO main's `agents/docs/tasks/pending/`. Both should end up in pevo-pinner's tasks tree as part of Phase D step 14. After Phase D's task migration commit lands in pevo-pinner, `git rm` both files from PEvO main in this cleanup pass. The commit message should explicitly cite the destination repo so the rationale is visible in archaeology.
32. **Tasks-archive cleanup in PEvO main.** Leave PEvO main's `agents/docs/tasks-archive.md` alone — the historical pinner entries stay there as part of the historical record. Do not retroactively remove them.

### Phase G — Verification & handoff

33. **PEvO main builds and tests pass.** `./deploy.sh restart` succeeds. `cd backend && npx vitest run` passes. `cd frontend && npm run build` succeeds. Confirm no orphaned imports or scripts reference `pinner/`.
34. **`.githooks/tests/test-commit-msg.sh` passes** with the pinner zone removed.
35. **pevo-pinner builds and tests pass.** `go build ./...` and `go test ./...` succeed at HEAD.
36. **All in-flight pinner tasks landed.** Verify pevo-pinner's tasks/pending/ contains: the 6+ pinner-* files migrated from PEvO main. Verify the held drain task carries its 2 hold-block items. Verify the new partial-block-trust task is intact.
37. **No dangling references.** `grep -r "pinner" /home/micha/workspace/pevo --exclude-dir=.git --exclude-dir=.claude --exclude-dir=node_modules` should return ONLY:
    - Tasks-archive historical entries (acceptable).
    - The single "Community pinners: see pevo-pinner" pointer in README and ARCHITECTURE.md (acceptable).
    - Old commit messages reachable via `git log` (acceptable; history is immutable).
    No matches in code, no matches in active CLAUDE.md files, no matches in active task files.
38. **Pinner agent role formally retired.** Add a one-line note in `agents/docs/tasks-archive.md` at the top: `## pinner agent role retired (archived 2026-MM-DD) — code and coordination moved to pevo-pinner repo`. This makes the transition discoverable for future archaeologists.
39. **Announce.** Update PEvO's frontend / docs (TBD location) to point operators at the pevo-pinner repo. Out of architect scope; flag for user follow-up.

## Non-goals

- Migrating the existing community pinner deployments (if any). They keep running their existing builds; future updates pull from the new repo.
- Reworking the discovery query shape, the autopin rule engine, or the embedded IPFS backend. Those are pinner-internal concerns that ride along with the extraction unchanged.
- Splitting PEvO main's backend code further (e.g., extracting the accreditation service). Separate decision.
- Setting up CI/CD for pevo-pinner. Day-1 the repo can rely on `go build && go test` on contributor machines; CI is a follow-up.
- Designing a publish/notify mechanism for HAF discovery query breaking changes. Captured as a future improvement (step 23 above), not in scope.

## Acceptance

- pevo-pinner repo exists at `<owner>/pevo-pinner`, AGPL-3.0, with rewritten history that contains only the pinner subdirectory's commits.
- pevo-pinner builds (`go build ./...`) and tests pass (`go test ./...`).
- All in-flight `pinner-*` task files are present in pevo-pinner's `agents/docs/tasks/pending/`, including the held drain task and the new partial-block-trust task.
- The genuinely pinner-domain solutions doc (`fetch-abort-controller-bounds-headers-only-2026-05-06.md`) lives in pevo-pinner with imported-from lineage noted in its body.
- PEvO main has no `pinner/` directory, no `pinner` case in `.githooks/commit-msg`, no `pinner` agent in CLAUDE.md enumerations, and no `pinner-*` task files in the live tasks tree. ARCHITECTURE.md and README link to pevo-pinner for the operational details.
- `.githooks/tests/test-commit-msg.sh` passes in PEvO main with the pinner zone removed.
- A retirement note exists at the top of `agents/docs/tasks-archive.md`.
- The user has been told what manual steps remain (announcement, CI/CD, community-deploy update path).

## Risks

- **git-filter-repo destructive on the wrong repo.** Run only inside a fresh local clone, never the working PEvO checkout. Tag the source commit (`git tag pre-pinner-extraction`) before any rewrite so the original is recoverable.
- **Sibling agent regression.** If the sibling pinner agent's autopin-concurrency-and-quota work doesn't land before Phase B, the extraction snapshot will miss those changes. Phase A's prerequisite gate is the mitigation; do not skip it.
- **Reference drift.** Phase F's pinner-removal sweep might miss a reference. The grep verification at Phase G step 37 is the backstop.
- **Module path mismatch in Go imports.** Step 7 covers this, but if the pinner ever grows multi-package, the module-rename is more invasive. Today pinner is `package main` flat, so the risk is small.
- **Cross-repo coordination drift.** Future PEvO changes to the HAF discovery query (e.g., new metadata fields, schema migrations) can silently break community pinners. Step 23 documents the contract; longer-term, an automated check (CI in PEvO that runs against a stub pinner discovery query) would close the gap. Out of scope.

## References

- The just-completed code review of commit `51b8784c` (pinner-shutdown-drain-in-flight-pins) surfaced the structural-separation argument that motivated this extraction.
- `git-filter-repo` documentation: https://github.com/newren/git-filter-repo
- PEvO's existing `pinner/Dockerfile`, `pinner/main.go`, and `agents/pinner/CLAUDE.md` are the source-of-truth inputs to Phase B and Phase D.
- `agents/docs/ARCHITECTURE.md` § "Pinner constraint" is the section that needs rewriting in Phase F step 29.
