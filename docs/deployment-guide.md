# PEvO Deployment Guide

> **Owner:** Architect Agent
> **Version:** 0.2

## Prerequisites

### Hive Accounts

Two Hive accounts must be created before deployment:

| Account | Purpose | Key Requirements |
|---------|---------|-----------------|
| `pevo.admin` | Broadcasts accreditation `custom_json` | Posting key stored in backend env |
| `pevo.anon` | Posts anonymous reviews | Posting key stored in backend env |

Create these accounts via any Hive account creation service. Fund with enough RC (Resource Credits) for expected transaction volume. Delegate HP if needed.

### External Services

| Service | Required | Purpose |
|---------|----------|---------|
| HAF SQL node | Yes (primary data) | PostgreSQL with indexed Hive chain data |
| SMTP server | Yes (accreditation) | Sends verification emails |
| Redis | Optional (recommended for production) | Rate limiting, caching |

**IPFS:** The Docker stack includes a local Kubo node for file storage. No external IPFS service is required. Optionally, configure Pinata API keys as a fallback for uploads if the local node is unavailable.

---

## Environment Variables

All configuration lives in a single `.env` file at the project root (see `.env.example` for the full list). Key production values:

```bash
# Public URL
APP_URL=https://pevo.science

# Database
POSTGRES_PASSWORD=<strong-random>

# Hive account keys
PEVO_ADMIN_POSTING_KEY=5K...
PEVO_ANON_POSTING_KEY=5K...

# Anonymous review encryption (openssl rand -hex 32)
ANON_REVIEW_ENCRYPTION_KEY=...
```

See [.env.example](../.env.example) for all available variables.

---

## Database Setup

### HAF SQL

The backend queries the HAF node using inline CTEs against the raw `hafsql.*` tables (comments, operation_custom_json_view, etc.). **No `pevo` schema or CREATE privilege is required** on the HAF node. The `docs/haf-views.sql` file is a design reference only.

Set `HAF_DATABASE_URL` in `.env` to point to the HAF node (read-only access is sufficient).

### Application Database

Docker Compose automatically creates the `pevo_app` database. Migrations in `backend/migrations/` run on first start via the `/docker-entrypoint-initdb.d` mount. This stores notification preferences, accreditation tokens, and anonymous review mappings.

---

## Docker Deployment

### Development

```bash
cp .env.example .env
./deploy.sh up          # uses docker-compose.yml — port 3001 exposed
```

### Production

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, APP_URL, real keys
./deploy.sh up
```

The stack includes 4 services:
- **postgres** — PostgreSQL for app state (1GB memory limit)
- **redis** — Caching, rate limiting, ORCID state (256MB limit)
- **ipfs** — Kubo node for file storage (1GB memory limit)
- **backend** — Node.js API server + static frontend (health-checked)

The backend serves both the API (`/api/*`) and the compiled Alpine.js frontend (all other routes). There is no separate frontend service.

The reverse proxy (TLS termination, routing) is managed outside of Docker Compose. Configure your existing reverse proxy to route **all traffic** to `localhost:3001`. The backend handles both static files and API requests.

Set `APP_URL` to your public base URL (e.g., `https://pevo.science`).

### 4. Set up backups

```bash
# Install the daily backup cron job
sudo cp scripts/backup.sh /usr/local/bin/pevo-backup
sudo chmod +x /usr/local/bin/pevo-backup

# Add cron entry (daily at 03:00)
echo "0 3 * * * root APP_DATABASE_URL=postgresql://pevo:PASS@localhost:5432/pevo_app /usr/local/bin/pevo-backup >> /var/log/pevo-backup.log 2>&1" | sudo tee /etc/cron.d/pevo-backup

# Or run from inside Docker Compose:
docker compose exec postgres pg_dump -U pevo pevo_app | gzip > backup.sql.gz
```

### Health Check

```bash
curl https://pevo.science/api/health
# Expected: {"status":"ok","haf_available":true,"redis_available":true,"timestamp":"..."}
```

---

## Development

```bash
cp .env.example .env
docker compose up -d
# App: http://localhost:3001 (API + frontend served from same port)
```

For frontend development with hot reload:
```bash
cd frontend && npm run dev    # Vite dev server on port 5173, proxies /api to :3001
```

---

## Manual Deployment

### Build and Run

```bash
# Build frontend (outputs to backend/public/)
cd frontend && npm ci && npm run build

# Build and run backend (serves both API and frontend)
cd backend && npm ci && npm run build
NODE_ENV=production node dist/index.js
```

Runs on `PORT` (default 3001). Place behind a reverse proxy for TLS.

---

## Backup and Restore

### Automated Backups

The `scripts/backup.sh` script dumps the `pevo_app` database daily and retains the last 7 backups.

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_DIR` | `/var/backups/pevo` | Where dumps are stored |
| `BACKUP_KEEP_DAYS` | `7` | Days to retain |
| `APP_DATABASE_URL` | (required) | PostgreSQL connection string |

### Restore

```bash
gunzip -c /var/backups/pevo/pevo_app_20260326_030000.sql.gz | psql $APP_DATABASE_URL
```

---

## Monitoring

### Key Metrics

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| HAF availability | `GET /api/health` | `haf_available: false` |
| API response time | Backend logs (pino) | p95 > 2s |
| Error rate | Backend logs (5xx) | > 1% of requests |
| IPFS pin failures | Backend logs | Any failure |
| Accreditation broadcast failures | Backend logs | Any failure |
| Rate limit hits | Backend logs (429s) | Spike detection |

### Log Format

Backend uses structured JSON logging (pino). Pipe to your log aggregation service.

---

## Security Checklist

- [ ] All private keys (`PEVO_ADMIN_POSTING_KEY`, `PEVO_ANON_POSTING_KEY`, `ANON_REVIEW_ENCRYPTION_KEY`) stored in environment variables, never in code or version control
- [ ] `.env` files excluded from git (`.gitignore`)
- [ ] CORS restricted to `APP_URL` in production
- [ ] TLS termination at reverse proxy
- [ ] Rate limiting enabled on all public endpoints
- [ ] SMTP credentials use app-specific password
- [ ] Redis authentication enabled if exposed
- [ ] HAF database user has read-only access to `hafsql.*` schema
- [ ] File upload validation (PDF, images, CSV, ZIP — 10MB max, magic-byte verified) enforced server-side
- [ ] IPFS gateway proxied through backend (`/api/ipfs/:cid`) — validates CIDs against known papers, never exposes raw Kubo gateway
- [ ] Anonymous review encryption key is unique, random 32 bytes
