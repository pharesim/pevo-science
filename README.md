# PEvO — Publish and Evaluate Onchain

A decentralized platform for open scientific publication and interactive peer evaluation, built on the [Hive](https://hive.io) network. Non-profit, AGPL-3.0-licensed, forkable.

## What is PEvO?

Scientists publish papers and peer reviews directly to Hive. Reputation scores are computed transparently from on-chain activity. Accredited researchers are verified through institutional email or ORCID. Large files are stored on IPFS. No paywalls, no gatekeepers, no publisher fees.

See [docs/whitepaper-vision.md](docs/whitepaper-vision.md) for the full vision.

## Architecture

```
Browser (Alpine.js SPA + Hive Keychain)
    |           |
    | REST API  | Signed Hive transactions
    v           v
PEvO Backend    Hive Network
(Express)       (3s blocks, fee-less)
    |       |       |
    v       v       v
HAF SQL   Redis   IPFS
(indexed  (cache + (Kubo node,
chain     rate     file
data)     limiting) storage)
```

- **Frontend:** Alpine.js SPA + Vite + Tailwind CSS (served by backend)
- **Backend:** Node.js + Express + TypeScript
- **Network:** Hive (reading via HAF SQL, writing via Hive Keychain)
- **File storage:** IPFS (self-hosted Kubo node)
- **Cache / rate limiting:** Redis
- **Auth:** Hive Keychain (initial sign-in) + JWT session tokens (subsequent requests)
- **i18n:** 14 languages

See [ARCHITECTURE.md](ARCHITECTURE.md) for full system design.

## Prerequisites

- Docker + Docker Compose (recommended), or:
  - Node.js 20+
  - PostgreSQL
  - Redis
- [HAF SQL](https://gitlab.syncad.com/hive/haf) node (for production) or a Hive API node (for development)
- [Hive Keychain](https://hive-keychain.com/) browser extension
- Hive accounts: `pevo.admin` (accreditation + bridge posting) and `pevo.anon` (anonymous reviews)

## Quick Start

### Docker Compose (recommended)

```bash
git clone <repo-url> pevo && cd pevo
cp .env.example .env   # edit with your credentials
docker compose up --build
```

This starts four services: PostgreSQL, Redis, Kubo (IPFS), and the backend (which serves the frontend). The app runs at `http://localhost:3001`.

### Configure environment

Edit `.env` at the project root:

```env
# Required: at least one data source
HAF_DATABASE_URL=postgresql://user:pass@localhost:5432/haf_db
HIVE_API_NODES=https://api.hive.blog,https://api.deathwing.me,https://anyx.io

# Required: Hive account posting keys
PEVO_ADMIN_POSTING_KEY=5K...
PEVO_ANON_POSTING_KEY=5K...

# Required: encryption key for anonymous review mappings (32-byte hex)
ANON_REVIEW_ENCRYPTION_KEY=<64 hex chars>

# Required in production: random 32+ char string for session JWTs
SESSION_SECRET=<random string>

# Optional: SMTP for accreditation emails
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

See `.env.example` for the full list of options (Redis, ORCID OAuth, DataCite DOI, bridge account, etc.).

## Project Structure

```
pevo/
  .env.example            Environment template (single file for all services)
  docker-compose.yml      Full stack (postgres, redis, ipfs, backend)
  ARCHITECTURE.md         System design (single source of truth)
  backend/                Node.js + Express API (types in src/types/)
  frontend/               Alpine.js SPA (Vite build, served by backend)
  pinner/                 Community pinner — standalone Go binary with embedded IPFS node
  scripts/                Backup and deployment utilities
```

## Key Design Decisions

- **Hive-native:** Posts are Hive posts, comments are Hive comments, votes are Hive votes. No custom token.
- **Accredited-only data:** Only votes, reviews, and citations from accredited researchers count in reputation and rankings. Unaccredited users can read and vote on Hive (affecting rewards) but are filtered from PEvO's scientific discussion view.
- **Reputation is computed, not stored:** Scores are derived from on-chain data via SQL. Anyone running the same queries gets the same results. Voter reputation weighting creates a quality feedback loop; anti-sybil measures include activity-gating, downvote penalties, and citation caps.
- **Privacy for reviewers:** Anonymous reviews posted via a proxy account with encrypted mappings and a 6-month TTL.
- **Progressive decentralization:** Accreditation starts centralized (email verification + ORCID), designed to move to web-of-trust and DAO governance.
- **Preprint bridge:** Import existing papers from arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, or ResearchGate by pasting a URL or identifier. The paper stays on its original platform; PEvO creates a reference for peer review.
- **Structured evaluation:** Accredited reviewers choose from 6 vote levels (Strong endorsement to Strong reject). Non-accredited users can still upvote/downvote simply. Citation relevance is togglable per-citation.

## API Overview

| Endpoint | Description |
|----------|-------------|
| `GET /api/papers` | List papers (filterable by discipline, source, sortable) |
| `GET /api/papers/:author/:permlink` | Paper detail with reviews and citations |
| `GET /api/profile/:username` | Researcher profile + reputation breakdown |
| `GET /api/search?q=...` | Full-text search with filters |
| `GET /api/researchers` | Researcher directory |
| `GET /api/stats` | Platform-wide statistics |
| `GET /api/notifications` | User notifications (block-cursor pagination) |
| `POST /api/auth/session` | Session login (Keychain sign-in → JWT) |
| `POST /api/accreditation/request` | Request accreditation via email |
| `POST /api/accreditation/orcid/start` | Accreditation via ORCID OAuth |
| `POST /api/ipfs/upload` | Upload file to IPFS (PDF, images, CSV, ZIP) |
| `GET /api/ipfs/:cid` | Download IPFS file (validated against known papers) |
| `POST /api/reviews/anonymous` | Submit anonymous review |
| `GET /api/bridge/lookup` | Import preprint metadata (arXiv, PubMed, bioRxiv, ResearchGate, Semantic Scholar) |
| `POST /api/bridge/register` | Register preprint for peer review on PEvO |
| `GET /api/wot/:username` | Web of Trust vouch status |

Full spec with all 34 endpoints: [docs/api-contract.md](docs/api-contract.md)

## License

AGPL-3.0. See [LICENSE](LICENSE).

Prior versions (before this commit) were released under the MIT License.
