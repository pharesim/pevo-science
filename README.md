# PEvO — Publish and Evaluate Onchain

A decentralized platform for open scientific publication and interactive peer evaluation, built on the [Hive](https://hive.io) network. Non-profit, MIT-licensed, forkable.

## What is PEvO?

Scientists publish papers and peer reviews directly to Hive. Reputation scores are computed transparently from on-chain activity. Accredited researchers are verified through institutional email or ORCID. Large files are stored on IPFS. No paywalls, no gatekeepers, no publisher fees.

See [docs/whitepaper-vision.md](docs/whitepaper-vision.md) for the full vision.

## Architecture

```
Browser (Next.js + Hive Keychain)
    |           |
    | REST API  | Signed Hive transactions
    v           v
PEvO Backend    Hive Network
(Express)       (3s blocks, fee-less)
    |       |
    v       v
HAF SQL   Redis
(indexed  (cache +
chain     rate
data)     limiting)
```

- **Frontend:** Next.js 15 + React 19 + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Network:** Hive (reading via HAF SQL, writing via Hive Keychain)
- **File storage:** IPFS (via Pinata)
- **Cache / rate limiting:** Redis
- **Auth:** Hive Keychain (initial sign-in) + JWT session tokens (subsequent requests)
- **i18n:** 6 languages (English, Spanish, German, French, Chinese, Arabic with RTL)

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

### Option A: Docker Compose (recommended)

```bash
git clone <repo-url> pevo && cd pevo
cp .env.example .env   # edit with your credentials
docker compose up --build
```

Frontend runs at `http://localhost:3000`, backend at `http://localhost:3001`.

### Option B: Manual

```bash
git clone <repo-url> pevo && cd pevo
cp .env.example .env   # edit with your credentials

# Shared types
cd contracts && npm install && npm run build && cd ..

# Backend
cd backend && npm install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

#### Configure environment

Edit `.env` at the project root (single file shared by backend + frontend):

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

# Optional: IPFS via Pinata
PINATA_API_KEY=...
PINATA_SECRET_KEY=...

# Optional: SMTP for accreditation emails
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

See `.env.example` for the full list of options (Redis, ORCID OAuth, DataCite DOI, bridge account, etc.).

#### Set up HAF views (if using HAF SQL)

```bash
psql -d haf_db -f docs/haf-views.sql
```

#### Run

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

Frontend runs at `http://localhost:3000`, backend at `http://localhost:3001`.

## Project Structure

```
pevo/
  .env.example            Environment template (single file for all services)
  docker-compose.yml      Full stack (postgres, redis, backend, frontend)
  ARCHITECTURE.md         System design (single source of truth)
  PROGRESS.md             Milestone log
  backend/                Node.js + Express API (types in src/types/)
  frontend/               Alpine.js SPA (Vite build)
  docs/
    api-contract.md       REST API specification
    hive-schemas.md       Hive post metadata + custom_json schemas
    reputation-algorithm.md    Reputation scoring (v1)
    reputation-algorithm-v2.md Reputation scoring (v2: decay, self-citation discount)
    haf-views.sql         PostgreSQL views for HAF
    keychain-integration.md    Hive Keychain integration guide
    deployment-guide.md   Production deployment
    whitepaper-vision.md       PEvO vision document
  scripts/                Backup and deployment utilities
```

## Key Design Decisions

- **Hive-native:** Posts are Hive posts, comments are Hive comments, votes are Hive votes. No custom token.
- **Accredited-only data:** Only votes, reviews, and citations from accredited researchers count in reputation and rankings. Unaccredited users can read and vote on Hive (affecting rewards) but are filtered from PEvO's scientific discussion view.
- **Reputation is computed, not stored:** Scores are derived from on-chain data via SQL. Anyone running the same queries gets the same results.
- **Privacy for reviewers:** Anonymous reviews posted via a proxy account with encrypted mappings and a 6-month TTL.
- **Progressive decentralization:** Accreditation starts centralized (email verification + ORCID), designed to move to web-of-trust and DAO governance.
- **Preprint bridge:** Import existing papers from arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, or ResearchGate by pasting a URL or identifier. The paper stays on its original platform; PEvO creates a reference for peer review.

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
| `POST /api/ipfs/upload` | Upload PDF to IPFS |
| `POST /api/reviews/anonymous` | Submit anonymous review |
| `GET /api/bridge/lookup` | Import preprint metadata (arXiv, PubMed, bioRxiv, ResearchGate, Semantic Scholar) |
| `POST /api/bridge/register` | Register preprint for peer review on PEvO |
| `GET /api/wot/:username` | Web of Trust vouch status |

Full spec with all 33 endpoints: [docs/api-contract.md](docs/api-contract.md)

## License

MIT
