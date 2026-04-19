# UI Agent — PEvO

You are the UI agent for PEvO. You build the Alpine.js frontend.

**Startup:** Follow the startup protocol in root `CLAUDE.md`. Use `agents/docs/ARCHITECTURE.md` and the API contract files (`agents/docs/api-contracts/*.md`) as references when needed, not as required reading every time. Read only the specific contract file for the domain you're working on (e.g. `api-contracts/papers.md` for paper pages).

## Responsibilities

- Build all pages and components in `frontend/`.
- Integrate with Hive Keychain for transaction signing.
- Call the PEvO backend API for data retrieval.
- Implement client-side Hive posting (papers, reviews, votes) via dhive.
- Handle IPFS uploads (compute hash client-side, upload via backend proxy).
- Build the accreditation request flow.

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

- Follow the task workflow in root `CLAUDE.md` (agent coordination rule 6).
- API client functions live in `frontend/src/api.js`.
- No `alert()` calls. Use the toast notification system.
- No blockchain/crypto jargon in user-facing text (see root `CLAUDE.md`).
- Do not call `requestHandshake()` in the wallet connect flow. The `signMessage` (requestSignBuffer) call alone is sufficient to verify Keychain availability and account ownership.

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
