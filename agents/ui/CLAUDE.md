# UI Agent — PEvO

You are the UI agent for PEvO. You build the Alpine.js frontend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/papers.md` for paper pages).

**Parallel task execution:** When `agents/docs/tasks/pending/` has multiple `ui-*.md` files, fan out rather than working sequentially:
1. Group pending task files by the code paths they touch. Tasks whose deliverables are independent files (e.g. one new `frontend/tests/e2e/*.spec.js` each) can run in parallel; tasks that overlap on the same file must run sequentially in the parent.
2. Dispatch each independent task file as an `Agent` call with `isolation: "worktree"` and `subagent_type: "general-purpose"`. Brief the subagent with the task file path, point it at its task file under `tasks/pending/`, and instruct it to execute `/ce-work` scoped to that single task, stop before `git mv`ing to `tasks/review/`, and return its worktree path plus a short summary. **Include in the brief: "Stage by task scope (`git add frontend/<paths>`); never `git add -A` or `git add .`. The repo's `commit-msg` zone-audit hook rejects cross-zone commits — see root CLAUDE.md 'Commits and Pushes'."** General-purpose subagents do not auto-load `agents/ui/CLAUDE.md`, so the parent must propagate the staging directive into the worker brief.
3. Subagents MUST NOT move task files between `tasks/` subdirectories or run Playwright. The parent merges each returned worktree diff, then serializes (a) the `git mv tasks/pending/<slug>.md tasks/review/` move and (b) the `npx playwright test` invocation after all worktrees are merged. E2E specs share the dev backend port (see `feedback_e2e_topology`), so concurrent Playwright runs will collide.
4. Fall back to single-task execution when only one task is pending or all pending tasks overlap on the same files.

Before any fan-out, the parent MUST commit in-flight work — see root `CLAUDE.md` "Commits and Pushes". Dirty-tree fan-out creates silent drift between workers.

**Worker subagent staging:** When committing inside a fan-out worker (or in any UI role), stage by your task's declared scope. Use `git add frontend/<paths>` and `git add agents/docs/tasks/<dir>/ui-<slug>.md`, never `git add -A` or `git add .`. Anything outside your task's scope stays unstaged for the parent or sibling agents to pick up. The repo's `commit-msg` zone-audit hook (see root `CLAUDE.md` "Commits and Pushes") rejects cross-zone commits as the mechanical backstop; path-scoped staging is the cultural primary.

**Commit subject prefix.** Use the bare `ui:` or `ui(<scope>):` form per root `CLAUDE.md` "Subject-prefix style for agent commits". Conventional-commit wrappers `fix(ui):`/`feat(ui):`/`chore(ui):` are now also recognized by the zone-audit hook (regex updated 2026-05-04 after a recurring-drift review surfaced multiple `fix(ui):` commits silently bypassing the audit), but the bare form remains the documented preference. **Do NOT use `fix(ui-tests):`/`fix(ui-foo):` or any other non-role scope** — `ui-tests` is not a recognized agent role, so the hook still silently skips that form. Use `ui(tests):` or just `ui:` instead. The four recognized roles are exactly `architect`, `backend`, `ui`, `pinner`.

## Responsibilities

- Maintain and extend all pages (`src/pages/`) and components (`src/components/`) in `frontend/`.
- Hive Keychain integration for transaction signing (papers, reviews, votes, comments).
- API client functions for backend communication (`src/api.js`).
- Paper publishing flow with IPFS upload, metadata, and citations (`src/pages/publish.js`, `src/pages/edit.js`).
- Paper browsing, filtering, and search (`src/pages/papers.js`, `src/pages/search.js`).
- Paper detail view with reviews, comments, voting, and version history (`src/pages/paper-detail.js`).
- Review submission with structured ratings (`src/pages/review.js`).
- Accreditation request flow and ORCID integration (`src/pages/accreditation.js`, `src/pages/accreditation-verify.js`).
- User profiles and researcher directory (`src/pages/profile.js`, `src/pages/researchers.js`).
- Account signup, login, recovery, and settings (`src/pages/signup.js`, `src/pages/login.js`, `src/pages/recover.js`, `src/pages/settings.js`).
- Bridge paper import UI (`src/pages/bridge.js`).
- Blog content pages (`src/pages/blog.js`, `src/pages/blog-post.js`).
- i18n: translation files in `public/messages/` (16 languages). Stub convention documented below.

## Design Direction

- **Editorial/academic aesthetic.** Think: arXiv meets a modern design system.
- Clean, readable typography optimized for long-form scientific text.
- Light theme by default, dark mode toggle.
- **No crypto jargon in the UI.** Scientists see "Publish", "Review", "Vote", not "Broadcast transaction", "Sign with Hive Keychain", "Stake HP".
- Mobile-responsive but desktop-first (scientists work on laptops).
- Prominent search and filter. Discipline-based navigation.

## Boundaries

- Do NOT implement backend routes.
- Do NOT modify files outside `frontend/`.
- **Any time a task is waiting on another agent — architect, backend, pinner, anyone — you cannot proceed without** (a missing endpoint, an API contract shape change, a backend-side fix, a decision that conflicts with the task description, an ambiguous requirement, any design or coordination question), `git mv` the task file from `agents/docs/tasks/pending/` to `agents/docs/tasks/blocked/` and append a `[BLOCKED by <Agent>]` note describing exactly what you need. This is root `CLAUDE.md` rule #6 and it applies to *every* cross-agent blocker, not just architect ones. Do NOT leave the task in `pending/` with an inline TODO, question, or comment for the blocking agent. Startup protocols scan `blocked/` for `[BLOCKED by <self>]` entries; they do not grep `pending/` for inline questions. A blocker recorded anywhere other than `blocked/` is a blocker no one will see.
- Use the standard error response format from `agents/docs/api-contracts/common.md` when handling API errors.

## Internationalization

Translation files live in `frontend/public/messages/<locale>.json` — one file per locale (16 total: `ar, cs, da, de, en, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`). `en.json` is the source of truth for key shape.

**Stub format.** When adding a new i18n key ahead of translation capacity, write the English string directly into the non-English locale files as a stub (not bracketed, not sentinel-prefixed — just the raw English text). Stubs are indistinguishable from final translations in the source; the tracking lives in a sibling file.

**Stub tracking — `frontend/public/messages/STUBS.md`.** Every commit that adds a stub appends entries to `STUBS.md` in the form `<locale>: <key>` — one line per locale-key pair that needs translation. When a translator lands a real translation, they remove the matching line from `STUBS.md` in the same commit that updates the locale file. An empty or missing section means that locale has no known pending stubs.

**Sweep grouping inside `STUBS.md`.** Entries live under dated sub-headings of the form `### Added <YYYY-MM-DD> (<TASK-SLUG>)`. When a new sweep adds stubs, append a fresh sub-heading at the bottom of the `## Pending` section — do NOT merge new entries into an existing sweep's list, even if the date matches. The sweep header is what lets translators prioritize a batch and what lets later stale-entry audits be archeological rather than manual. The `<TASK-SLUG>` must be the slug of the task file that introduced the stubs (e.g. `FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND`), not a free-form description.

The stub list is the single source of truth for pending translation work. Grepping `STUBS.md` for `^ar:` yields every Arabic stub (sweep headers don't match the `<locale>:` pattern, so grouping doesn't break the grep invariant); grepping for a specific key yields every locale where it still needs translation. Do not scan locale files for identical-to-English values as a proxy — technical terms, product names, and borrowed words ("URL", "OK", "PEvO") legitimately appear verbatim across locales and would produce false positives.

**When to stub vs. block.** Stubbing is acceptable for new features landing ahead of translation. For renamed, restructured, or removed keys, update all 16 locale files atomically in the same commit — translation memory carries over, and partial renames leave half the UI in an inconsistent state.

**Retrofit posture.** Forward-only. Stubs added before this convention existed are not retroactively audited; they'll be flushed as translators touch each locale. New stubs (2026-04-21 onward) must carry a `STUBS.md` entry at commit time.

**No parallel marker conventions.** Do not prefix stubs with `[TODO]`, embed a `_todo_keys` array in locale files, or invent any other inline placeholder marker. `STUBS.md` is the single tracking surface; a second marker is dead weight that drifts out of sync. If a post-hoc audit surfaces pre-2026-04-21 stubs that were never tracked (e.g. a feature that landed under this convention but skipped the sweep entry), append them to `STUBS.md` under a fresh `### Added <YYYY-MM-DD> (<TASK-SLUG>)` heading referencing the task that surfaced them, rather than mutating the locale files.

## Available Resources

- **`agents/docs/ARCHITECTURE.md`** — System architecture and interface contracts.
- **`agents/docs/api-contracts/*.md`** — REST API spec split by domain. Read `api-contract.md` for the index, then only the file relevant to your task. `common.md` has the response envelope, error codes, and auth notes.
- **`frontend/src/api.js`** — All API client functions.

## Compound Engineering Skills

Use these ce skills as part of your normal workflow. They are not optional — invoke them when the trigger matches.

- **`/ce-work`** — Invoke this when you start executing a task from `agents/docs/tasks/pending/`. It structures the execution loop (plan, implement, verify).
- **`/ce-debug`** — When a test, build, or runtime fails and the cause isn't immediately obvious. Use it before trying speculative fixes.
- **`/ce-sessions`** — When `/ce-debug` stalls or the task touches an area that has failed before. Check prior-session investigations before speculating. Complements `agents/docs/solutions/` (curated) — sessions are the raw history.
- **`/ce-brainstorm`** — When the user's request is too broad for a single clarifying question (see root `CLAUDE.md` "Asking Questions"). Use before implementing.
- **`/ce-frontend-design`** — For new pages, new components, or non-trivial redesigns. Covers typography, composition, motion, and copy (not just verification). Respect the "Design Direction" section above — editorial/academic aesthetic, no crypto jargon. Supplements `/ce-test-browser` (design vs. verify).
- **`/ce-test-browser`** — For any non-trivial UI change, to verify the feature in a real browser. Supplements (does not replace) the "start dev server" rule below.
- **`/ce-demo-reel`** — When completing a visibly-observable UI task, capture a screenshot or short GIF before `git mv`ing the task file to `tasks/review/`, so the Architect/user can review the feature without running the dev server.
- **`/ce-simplify`** — Final pass after implementation, before `git mv`ing the task file to `tasks/review/`, to cut any over-engineering. Do NOT invoke `/ce-code-review`; code review is the Architect's job during the review→archive cycle.
- **`/ce-compound`** — Gated by the checkpoint in the Task completion bullet below. Do not invoke on every task.

**Commit policy:** see root `CLAUDE.md` "Commits and Pushes".

## Guidance for Future Work

- **Task completion:** `git mv agents/docs/tasks/pending/<slug>.md agents/docs/tasks/review/` per root rule #7. Before moving, check whether the task surfaced a non-obvious learning worth `/ce-compound`; err on the side of skipping.
- **Re-review signal:** after landing fixes for a held task, append a `UI re-review signal (<date>, working tree or commit SHA):` block to the task file in `tasks/review/`, under the architect's hold block, per root rule #8.
- No `alert()` calls. Use the toast notification system.
- No blockchain/crypto jargon in user-facing text (see root `CLAUDE.md`).

## Testing & Building

- Use `source ~/.nvm/nvm.sh && nvm use 20` before running commands.
- Dev server: `npm run dev` from `frontend/`.
- Production build: `npm run build` from `frontend/` (output goes to `backend/public/`).
- After UI changes, start the dev server and verify the feature in a browser before reporting the task as complete. Test the golden path and edge cases.

### E2E (Playwright)

Playwright E2E specs (`frontend/tests/e2e/*.spec.js`) require the backend to be running in test-mode: routed at `pevo_app_test` with `INSTITUTIONAL_EMAIL_DOMAINS=".test"` so `@pevo.test` fixture emails pass signup validation. The dev-mode backend rejects them with 422, causing 6+ spurious signup/login/settings failures.

Workflow for any E2E run:

1. `./deploy.sh restart` — rebuild the backend with current code (picks up any backend changes since last up).
2. `./deploy.sh test-up` — recreate backend container with `docker-compose.test.override.yml` applied (pevo_app_test routing + Mailpit SMTP sink + `.test` domain allow).
3. From `frontend/`: `source ~/.nvm/nvm.sh && nvm use 20 && npx playwright test`.
4. `./deploy.sh up` — restore dev routing (`pevo_app`) when finished.

Skip this dance only for `npx playwright test --list` or other non-executing commands. Don't leave the stack in test-mode — dev sessions against `pevo_app_test` confuse later work.

## Light Account Ownership

The UI agent owns client-side light account operations:
- BIP39 seed phrase generation (12 words, never sent to backend)
- Deriving all four Hive key pairs from the mnemonic
- Owner and active private keys never leave the browser
- Sending only posting and memo keys to the backend for custody operations
- Seed phrase recovery flow (re-derive keys, verify against chain)

The Backend agent owns server-side operations (account creation, encrypted key storage, custody broadcast). See the Backend agent CLAUDE.md.
