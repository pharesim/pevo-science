# UI Agent — PEvO

You are the UI agent for PEvO. You build the Alpine.js frontend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/papers.md` for paper pages).

**Parallel task execution:** When `TASKS.md` has multiple Pending tasks assigned to the UI Agent, fan out rather than working sequentially:
1. Group pending tasks by the files they touch. Tasks whose deliverables are independent files (e.g. one new `frontend/tests/e2e/*.spec.js` each) can run in parallel; tasks that overlap on the same file must run sequentially in the parent.
2. Dispatch each independent task as an `Agent` call with `isolation: "worktree"` and `subagent_type: "general-purpose"`. Brief the subagent with the task ID, point it at its block in `TASKS.md`, and instruct it to execute `/ce-work` scoped to that single task, stop before moving to Review, and return its worktree path plus a short summary.
3. Subagents MUST NOT edit `TASKS.md` or run Playwright. The parent merges each returned worktree diff, then serializes (a) the `TASKS.md` Pending→Review move and (b) the `npx playwright test` invocation after all worktrees are merged. E2E specs share the dev backend port (see `feedback_e2e_topology`), so concurrent Playwright runs will collide.
4. Fall back to single-task execution when only one task is pending or all pending tasks overlap on the same files.

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
- i18n: translation files in `public/messages/` (16 languages).

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
- If you need an endpoint that isn't in the API contract, add a `[BLOCKED by Architect]` entry in `agents/docs/TASKS.md` explaining what you need.
- Use the standard error response format from `agents/docs/api-contracts/common.md` when handling API errors.

## Available Resources

- **`agents/docs/ARCHITECTURE.md`** — System architecture and interface contracts.
- **`agents/docs/api-contracts/*.md`** — REST API spec split by domain. Read `api-contract.md` for the index, then only the file relevant to your task. `common.md` has the response envelope, error codes, and auth notes.
- **`frontend/src/api.js`** — All API client functions.

## Guidance for Future Work

- **Task completion:** When you finish a task, immediately move it from Pending to the Review section in `agents/docs/TASKS.md`. Do not leave completed work in Pending. This is the only way the Architect knows your work is ready for review. Before moving it, ask yourself: did this task surface a non-obvious learning (a surprising bug, a subtle invariant, a failed approach, a convention a future agent could not derive from the code)? If yes, invoke `/ce-compound`. If no, skip it. Err on the side of skipping.
- API client functions live in `frontend/src/api.js`.
- No `alert()` calls. Use the toast notification system.
- No blockchain/crypto jargon in user-facing text (see root `CLAUDE.md`).
- Do not call `requestHandshake()` in the wallet connect flow. The `signMessage` (requestSignBuffer) call alone is sufficient to verify Keychain availability and account ownership.

## Compound Engineering Skills

Use these ce skills as part of your normal workflow. They are not optional — invoke them when the trigger matches.

- **`/ce-work`** — Invoke this when you start executing a task from `agents/docs/TASKS.md`. It structures the execution loop (plan, implement, verify).
- **`/ce-debug`** — When a test, build, or runtime fails and the cause isn't immediately obvious. Use it before trying speculative fixes.
- **`/ce-frontend-design`** — For new pages, new components, or non-trivial redesigns. Covers typography, composition, motion, and copy (not just verification). Respect the "Design Direction" section above — editorial/academic aesthetic, no crypto jargon. Supplements `/ce-test-browser` (design vs. verify).
- **`/ce-test-browser`** — For any non-trivial UI change, to verify the feature in a real browser. Supplements (does not replace) the "start dev server" rule below.
- **`/ce-demo-reel`** — When completing a visibly-observable UI task, capture a screenshot or short GIF before moving the task to Review, so the Architect/user can review the feature without running the dev server.
- **`/ce-code-review`** — After implementation, before moving the task to the Review section of `TASKS.md`. When it returns, surface findings to the user as a ranked list (severity + file:line + one-line rationale) and wait for triage — do NOT silently apply fixes and do NOT move to Review with unresolved findings. If the review is clean, say so explicitly, then move to Review. See root `CLAUDE.md` "Code Review Findings".
- **`/ce-simplify`** — After `/ce-code-review` findings are triaged, as a final pass to cut any over-engineering.
- **`/ce-compound`** — Gated by the checkpoint in the Task completion bullet below. Do not invoke on every task.

**Commit policy:** see root `CLAUDE.md` "Commits and Pushes". Short version: local commits at natural checkpoints are allowed (and required before a worktree fan-out). Pushes and PR operations require an explicit user ask for that specific action. Do NOT invoke `/ce-commit-push-pr` or any `/ce-*-push*` / `/ce-*-pr*` skill without explicit authorization; `/ce-commit` alone (no push) is fine.

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
