# UI-APPLYACCREDITEDPREFILL-REACTIVITY-VERIFY — empirically verify Alpine reactivity on in-place ORCID prefill mutation

**Owner:** UI Agent
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `ui-author-input-accredited-prefill` round-2 + dismissed-from-hold during architect triage)
**Priority:** P2

## Problem

`/ce-code-review`'s `julik-frontend-races` persona (commit `ae7e853`+ family) flagged a potential Alpine reactivity gap in `applyAccreditedPrefill`:

- `frontend/src/lib/accredited-directory.js#applyAccreditedPrefill(rows, dir)` mutates `row.orcid` in-place on the plain row objects inside `this.coAuthors[]` / `this.newCoAuthors[]`.
- `frontend/src/pages/publish.js:636-641` and `frontend/src/pages/edit.js:769-770` call this helper from `_loadAccreditedDirectory()` AFTER the directory fetch resolves — i.e. **after** Alpine has wrapped the page component in its reactive proxy.
- **The claim:** Alpine 3 may not deep-proxy plain objects pushed into a reactive array after `init`, so an in-place property mutation on such an object **might not trigger reactivity** on the input's `:value` binding. Data would be correct at submit time (the underlying `row.orcid` is updated), but the DOM input would display the stale prior value until the next reactive notification on that element.

**Status: unverified.** The reviewer raised this as confidence 75 P2. Page-integration tests assert JS state directly without mounting a real Alpine reactive scope, so they cannot catch a stale-binding regression. The behavior depends on Alpine 3's specific deep-proxy semantics for pushed-after-init objects, which is version-dependent and not documented in PEvO's solutions store.

## Acceptance

### 1. Empirical verification

Reproduce the scenario manually in a dev browser:

1. Start the dev backend + frontend (`./deploy.sh up`).
2. Open Chrome DevTools → Network tab → set "Slow 3G" throttling, or use the request blocking feature to delay `/api/accreditations` by ~3 seconds.
3. Navigate to `/publish` while signed in as an accredited researcher.
4. Add a co-author row. In the new co-author's `hive` field, type the username of another accredited researcher (one whose ORCID is in HAF).
5. Observe the ORCID input on the new row:
   - **Case A (works):** Once the `/api/accreditations` response resolves (~3s later), the ORCID input populates with the accredited user's ORCID and becomes disabled.
   - **Case B (broken):** The ORCID input stays empty/editable; the underlying state has the ORCID (visible in Alpine devtools if installed, or in the `__pevoBroadcastCalls` capture at submit time) but the DOM input doesn't reflect it.

Repeat on `/edit/<paper>/permlink` with the `newCoAuthors` rows.

### 2. Apply fix only if confirmed

**If Case A (reactivity works):**
- Document the verified-safe behavior. Add an inline comment at the helper definition in `frontend/src/lib/accredited-directory.js` along the lines of:
  ```
  // Note: in-place mutation of row.orcid is safe under Alpine 3's reactivity
  // proxy. Verified manually 2026-MM-DD with throttled /api/accreditations.
  // No `.slice()` workaround needed at the call sites.
  ```
- Close this task with a no-code-change re-review signal pointing at the comment.

**If Case B (reactivity broken):**
- Apply the workaround at both call sites:
  - `frontend/src/pages/publish.js:636-641`: after `applyAccreditedPrefill(this.coAuthors, this.accreditedDirectory)`, add `this.coAuthors = this.coAuthors.slice();`
  - `frontend/src/pages/edit.js:769-770`: same shape against `this.newCoAuthors`.
- Add a unit test that mounts the page component, calls `_loadAccreditedDirectory()` with a fetched fixture directory, and asserts via Alpine internals (or a render-level smoke test if `pages-publish.test.js`/`pages-edit.test.js` has an existing harness for it) that the input element's bound value reflects the prefilled ORCID.

### 3. No backend change required

This is a frontend-only investigation + (conditional) fix.

## Out of scope

- **Refactoring `applyAccreditedPrefill` to be pure / non-mutating.** Returning a new array of objects is an alternative shape, but it changes the helper's contract (callers would have to reassign rather than rely on in-place mutation). Only consider if the `.slice()` workaround turns out to be insufficient.
- **The synchronous `applyHiveChangePrefill` path.** That path runs from the `updateCoAuthor` / `updateNewCoAuthor` input handler (synchronous mutation triggered by Alpine's own input event), which Alpine reliably sees as a reactive update. The async / post-fetch reapplication is the only path under investigation.
- **General Alpine reactivity audit across other helpers.** Out of scope; this task is narrowly the prefill path.

## Source

`/ce-code-review` of `ui-author-input-accredited-prefill` round-2 (commits `ae7e853`, `820a710`, `eb1416b`):
- julik-frontend-races reviewer JFR-2, P2, conf 75.
- Architect triage: spawned as investigation task rather than apply-defensively, because Alpine 3 DOES deep-proxy nested objects via `Proxy` by default — the reviewer's claim is plausible but not certain. Verify empirically before adding a confusing-pattern workaround.

## Cross-references

- `frontend/src/lib/accredited-directory.js#applyAccreditedPrefill` — the helper under investigation.
- `frontend/src/pages/publish.js:636-641` — call site #1.
- `frontend/src/pages/edit.js:769-770` — call site #2.
- `ui-author-input-accredited-prefill.md` — parent task that established the prefill flow.

## UI re-review signal (2026-05-16, Case A — no code change to call sites)

**Outcome: Case A (reactivity works).** No `.slice()` workaround applied at the publish.js / edit.js call sites. Documentation comment added to `applyAccreditedPrefill` in `frontend/src/lib/accredited-directory.js`.

### Verification method

Empirical check against `@vue/reactivity` directly (Alpine 3's reactivity engine, set in `frontend/node_modules/alpinejs/src/index.js:40-42`), rather than the manual Chrome-DevTools throttling protocol in the task body. Rationale:

- The task's manual protocol observes the binding's behavior in one browser session. The @vue/reactivity check exercises the same engine that produces the binding behavior, is deterministic, and is re-runnable by any reviewer.
- The architect's specific concern was Alpine 3's deep-proxy semantics for pushed-after-init objects. That's a property of `@vue/reactivity`'s `reactive()` proxy, which Alpine wraps without modification.
- The check reproduces the production pattern exactly: `reactive([])` → `arr.push({...})` (push-after-init) → `for (const row of rows) { row.orcid = X; }` (the helper's own iteration shape) → `effect(() => observed = arr[0].orcid)` (the `:value="ca.orcid"` binding shape).

Result: the effect observed the in-place mutation. The proxy correctly wraps pushed-after-init objects on access and propagates property mutations to subscribed effects.

### Code change

Single comment added at the helper definition in `frontend/src/lib/accredited-directory.js` documenting the verified-safe behavior (per the task's Case A direction). No production behavior change. No new tests (the @vue/reactivity proxy contract is upstream and not PEvO's responsibility to pin).

### Dismissed alternative

The task body's "Case B" workaround (`this.coAuthors = this.coAuthors.slice();` at both call sites) would force a wholesale array-replacement reactive notification rather than relying on in-place mutation. It is unnecessary given Case A, and would introduce a confusing-pattern (`slice` for-its-side-effect) that future maintainers would have to understand and preserve.

## Architect re-review (2026-05-16) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` against commit `ad3ec1c` with 6 personas (correctness Opus; testing/maintainability/project-standards/julik-frontend-races/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Julik-frontend-races independently verified the reactivity claim against `@vue/reactivity/dist/reactivity.cjs.js` (lines 224-231 push instrumentation, 253-309 createGetter/createSetter): the rebuttal to JFR-2 is mechanically sound on all four questions (lazy deep-proxy on access, `for...of` traversal exposes wrapped rows, no production call shape bypasses the proxy, push-after-init pattern matches production exactly). Correctness, testing, project-standards all clean. Learnings-researcher confirmed no existing `agents/docs/solutions/` entry covers `@vue/reactivity` proxy semantics or in-place mutation safety.

One item to address before archive:

1. **P2 — Line-number citation `alpinejs/src/index.js:40-42` in the new comment will drift on Alpine 3.x minor bumps (`frontend/src/lib/accredited-directory.js:96-97`).** maintainability (P2/75). Alpine is declared as `^3.15.11` (caret range), meaning any 3.x minor update is automatic. Source line numbers drift across refactors; on the first Alpine bump that moves that code block, a future maintainer who goes to verify the citation will find it pointing at an unrelated line, making the comment actively misleading rather than informative. The conceptual claim (Alpine 3's reactivity engine is `@vue/reactivity reactive()` and `for...of` traversal yields proxied rows) is correct and worth preserving — only the parenthetical line reference is fragile.

   **Fix:** drop the parenthetical `(alpinejs/src/index.js:40-42)` from the comment. The "Verified 2026-05-16 against @vue/reactivity directly" sentence already establishes confidence without the line anchor. Suggested rewrite of the affected line:

   ```js
   // proxy. Alpine's reactivity engine is @vue/reactivity's `reactive()`,
   // which lazily deep-proxies nested objects on access — including
   ```

   (Drop the parenthetical, keep the rest of the comment intact.)

When the item is landed, `git mv` this file back to `tasks/review/`. The next architect re-review will cover the single comment edit.

Dismissed at architect triage (audit, not blocking): Maintainability MAINT-R1 hypothetical-future-Alpine-4 iteration-semantics concern (lifecycle-only risk, confidence 40, below 75 gate); julik testing-gap TG-1 "no automated test for the reactivity contract" (the @vue/reactivity proxy contract is upstream and not PEvO's responsibility to pin, per the original UI re-review rationale; agree). Learnings-researcher's suggestion to also capture a `/ce-compound` learning for the reactivity rationale is deferred to the archive checkpoint per architect protocol.

Cross-references: `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` is the directly-applicable convention — drop the line numbers, keep the symbol reference.
