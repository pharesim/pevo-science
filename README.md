# PEvO — Publish and Evaluate Onchain

A decentralized platform for open scientific publication and interactive peer evaluation, built on the [Hive](https://hive.io) network. Non-profit, AGPL-3.0-licensed, forkable.

## What is PEvO?

Scientists publish or import papers and peer reviews directly to Hive. Reputation scores are computed transparently from on-chain activity. Accredited researchers are verified through institutional email, ORCID or a Web of Trust. Large files are stored on IPFS. No paywalls, no gatekeepers, no publisher fees.

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
- **Auth:** Hive Keychain (self-custody) or email/password light accounts (custodial) + JWT session tokens
- **i18n:** 16 languages

See [ARCHITECTURE.md](agents/docs/ARCHITECTURE.md) for full system design.

## Prerequisites

- Docker + Docker Compose (recommended), or:
  - Node.js 20+
  - PostgreSQL
  - Redis
- [HAF SQL](https://gitlab.syncad.com/hive/haf) node and a Hive API node (for development)
- Hive accounts: `pevo.admin` (accreditation + bridge posting), `pevo.anon` (anonymous reviews), `pevo.onboarding` (onboarding account for light account creation)

## Quick Start

### Docker Compose (recommended)

```bash
git clone <repo-url> pevo && cd pevo
cp .env.example .env   # edit with your credentials
./deploy.sh restart
```

This builds and starts four services: PostgreSQL, Redis, Kubo (IPFS), and the backend (which serves the frontend). The app runs at `http://localhost:3001`.

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

# Required for light accounts: custodial key encryption (32-byte hex)
CUSTODY_ENCRYPTION_KEY=<64 hex chars>

# Required for light accounts: Hive account for claiming account tokens
HIVE_ONBOARD_ACCOUNT=pevo.onboarding
HIVE_ONBOARD_ACTIVE_KEY=5K...

# Required: SMTP for verification and reset emails
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
- **Light accounts:** Scientists with institutional emails can sign up without Hive Keychain. PEvO creates a real Hive account, holds the keys, and signs operations server-side. Users upgrade to self-custody with Hive Keychain at any time.
- **Progressive decentralization:** Accreditation starts centralized (email verification + ORCID), designed to move to web-of-trust and DAO governance.
- **Preprint bridge:** Import existing papers by pasting an arXiv ID, DOI, or URL (PubMed, bioRxiv, medRxiv, Semantic Scholar, ResearchGate links are resolved to their DOI automatically). The paper stays on its original platform; PEvO creates a reference for peer review.
- **Structured evaluation:** Accredited reviewers choose from 6 vote levels (strong endorsement to strong reject), with a neutral tier when votes balance out. Non-accredited users can still upvote/downvote simply. Citation relevance is togglable per-citation.
- **Votes persist across revisions:** When a paper is revised, existing votes remain valid. The system relies on downvotes, new reviews, and the quality multiplier as corrective mechanisms rather than penalizing authors who revise.

## Deployment

### Hive Accounts

Three Hive accounts must be created before deployment:

| Account | Purpose | Key Requirements |
|---------|---------|-----------------|
| `pevo.admin` | Broadcasts accreditation `custom_json` | Posting key stored in backend env |
| `pevo.anon` | Posts anonymous reviews | Posting key stored in backend env |
| `pevo.onboarding` | Creates light accounts via `create_claimed_account` | Active key stored in backend env |

Create these accounts via any Hive account creation service. Fund with enough RC (Resource Credits) for expected transaction volume. Delegate HP if needed.

### Docker Stack

The stack includes 4 services:
- **postgres** — PostgreSQL for app state (1GB memory limit)
- **redis** — Caching, rate limiting, ORCID state (256MB limit)
- **ipfs** — Kubo node for file storage (1GB memory limit)
- **backend** — Node.js API server + static frontend (health-checked)

The backend serves both the API (`/api/*`) and the compiled Alpine.js frontend (all other routes). There is no separate frontend service.

### Database

The backend queries the HAF node using inline CTEs against the raw `hafsql.*` tables. **No `pevo` schema or CREATE privilege is required** on the HAF node. Set `HAF_DATABASE_URL` in `.env` (read-only access is sufficient).

Docker Compose automatically creates the `pevo_app` database. Migrations in `backend/migrations/` run on first start.

### Production

The reverse proxy (TLS termination, routing) is managed outside of Docker Compose. Configure your reverse proxy to route all traffic to `localhost:3001`. Set `APP_URL` to your public base URL (e.g., `https://pevo.science`).

### Manual Deployment

```bash
# Build frontend (outputs to backend/public/)
cd frontend && npm ci && npm run build

# Build and run backend (serves both API and frontend)
cd backend && npm ci && npm run build
NODE_ENV=production node dist/index.js
```

### Health Check

```bash
curl https://pevo.science/api/health
# Expected: {"status":"ok","haf_available":true,"redis_available":true,"timestamp":"..."}
```

### Backups

The `scripts/backup.sh` script dumps the `pevo_app` database daily and retains the last 7 backups.

```bash
# Install the daily backup cron job
sudo cp scripts/backup.sh /usr/local/bin/pevo-backup
sudo chmod +x /usr/local/bin/pevo-backup

# Add cron entry (daily at 03:00)
echo "0 3 * * * root APP_DATABASE_URL=postgresql://pevo:PASS@localhost:5432/pevo_app /usr/local/bin/pevo-backup >> /var/log/pevo-backup.log 2>&1" | sudo tee /etc/cron.d/pevo-backup
```

Restore: `gunzip -c /var/backups/pevo/pevo_app_YYYYMMDD.sql.gz | psql $APP_DATABASE_URL`

### Security Checklist

- [ ] All private keys stored in environment variables, never in code or version control
- [ ] `.env` files excluded from git (`.gitignore`)
- [ ] CORS restricted to `APP_URL` in production
- [ ] TLS termination at reverse proxy
- [ ] Rate limiting enabled on all public endpoints
- [ ] Redis authentication enabled if exposed
- [ ] HAF database user has read-only access to `hafsql.*` schema
- [ ] IPFS gateway proxied through backend, never expose raw Kubo gateway
- [ ] Anonymous review encryption key is unique, random 32 bytes

## Development

This project uses AI coding assistance (Claude Code) for implementation. Architecture, standards research, and all review/integration decisions are made by the lead developer.

## License

AGPL-3.0. See [LICENSE](LICENSE).

Prior versions (before 3554a6c) were released under the MIT License.
