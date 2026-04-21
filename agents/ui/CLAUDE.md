# UI Agent — PEvO

You are the UI agent for PEvO. You build the Alpine.js frontend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/papers.md` for paper pages).

**Parallel task execution:** When `agents/docs/tasks/pending/` has multiple `ui-*.md` files, fan out rather than working sequentially:
1. Group pending task files by the code paths they touch. Tasks whose deliverables are independent files (e.g. one new `frontend/tests/e2e/*.spec.js` each) can run in parallel; tasks that overlap on the same file must run sequentially in the parent.
2. Dispatch each independent task file as an `Agent` call with `isolation: "worktree"` and `subagent_type: "general-purpose"`. Brief the subagent with the task file path, point it at its task file under `tasks/pending/`, and instruct it to execute `/ce-work` scoped to that single task, stop before `git mv`ing to `tasks/review/`, and return its worktree path plus a short summary.
3. Subagents MUST NOT move task files between `tasks/` subdirectories or run Playwright. The parent merges each returned worktree diff, then serializes (a) the `git mv tasks/pending/<slug>.md tasks/review/` move and (b) the `npx playwright test` invocation after all worktrees are merged. E2E specs share the dev backend port (see `feedback_e2e_topology`), so concurrent Playwright runs will collide.
4. Fall back to single-task execution when only one task is pending or all pending tasks overlap on the same files.

Before any fan-out, the parent MUST commit in-flight work — see root `CLAUDE.md` "Commits and Pushes". Dirty-tree fan-out creates silent drift between workers.

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
- If you need an endpoint that isn't in the API contract, `git mv` your task file to `agents/docs/tasks/blocked/` and append a `[BLOCKED by Architect]` note explaining what you need.
- Use the standard error response format from `agents/docs/api-contracts/common.md` when handling API errors.

## Internationalization

Translation files live in `frontend/public/messages/<locale>.json` — one file per locale (16 total: `ar, cs, da, de, en, es, fa, fr, he, it, nl, pl, pt, sv, tr, zh`). `en.json` is the source of truth for key shape.

**Stub format.** When adding a new i18n key ahead of translation capacity, write the English string directly into the non-English locale files as a stub (not bracketed, not sentinel-prefixed — just the raw English text). Stubs are indistinguishable from final translations in the source; the tracking lives in a sibling file.

**Stub tracking — `frontend/public/messages/STUBS.md`.** Every commit that adds a stub appends entries to `STUBS.md` in the form `<locale>: <key>` — one line per locale-key pair that needs translation. When a translator lands a real translation, they remove the matching line from `STUBS.md` in the same commit that updates the locale file. An empty or missing section means that locale has no known pending stubs.

The stub list is the single source of truth for pending translation work. Grepping `STUBS.md` for `^ar:` yields every Arabic stub; grepping for a specific key yields every locale where it still needs translation. Do not scan locale files for identical-to-English values as a proxy — technical terms, product names, and borrowed words ("URL", "OK", "PEvO") legitimately appear verbatim across locales and would produce false positives.

**When to stub vs. block.** Stubbing is acceptable for new features landing ahead of translation. For renamed, restructured, or removed keys, update all 16 locale files atomically in the same commit — translation memory carries over, and partial renames leave half the UI in an inconsistent state.

**Retrofit posture.** Forward-only. Stubs added before this convention existed are not retroactively audited; they'll be flushed as translators touch each locale. New stubs (2026-04-21 onward) must carry a `STUBS.md` entry at commit time.

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

## Light Account Ownership

The frontend owns client-side light account operations:
- BIP39 seed phrase generation (12 words, never sent to backend)
- Deriving all four Hive key pairs from the mnemonic
- Owner and active private keys never leave the browser
- Sending only posting and memo keys to the backend for custody operations
- Seed phrase recovery flow (re-derive keys, verify against chain)

The backend owns server-side operations (account creation, encrypted key storage, custody broadcast). See the Backend agent CLAUDE.md.
