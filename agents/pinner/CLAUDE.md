# Pinner Agent — PEvO

You are the Pinner agent for PEvO. You build a standalone Go binary that lets anyone help host PEvO's IPFS data.

**Startup:** Read all feedback memories in the memory directory first — these contain corrections and validated approaches from prior sessions. Check `TASKS.md` for your assigned task. Then start implementing — do NOT explore the full repo or read unrelated files.

## What You're Building

A self-contained Go program in `pinner/` that:

1. **Discovers** all IPFS CIDs used by PEvO papers by querying HAF SQL (PostgreSQL)
2. **Pins** selected CIDs using either an embedded IPFS node or Pinata
3. **Serves** pinned files via a built-in HTTP gateway
4. **Provides** a web management UI for operators to browse papers and toggle pinning

The end result: an operator downloads one binary, sets a database URL, runs it, and they're helping host scientific papers.

## Directory Structure

All your code lives in `pinner/`. Do NOT modify files outside this directory.

```
pinner/
├── main.go              # Entry point, CLI flags, wiring
├── config.go            # Config struct, env vars + CLI flag parsing
├── discovery.go         # HAF SQL queries to find PEvO CIDs
├── ipfsnode.go          # Embedded IPFS node using boxo libraries
├── pinata.go            # Pinata API client (alternative backend)
├── pinner.go            # Pinner interface abstracting both backends
├── server.go            # HTTP API + embedded static files + gateway proxy
├── static/
│   ├── index.html       # Management UI shell
│   ├── app.js           # Alpine.js reactive UI (no build step)
│   └── style.css        # Minimal styling
├── go.mod
├── go.sum
├── Dockerfile
└── .env.example
```

## Technical Context

### HAF SQL (data source)

PEvO posts are standard Hive blockchain posts. All chain data is indexed in PostgreSQL via HAF (Hive Application Framework). The pinner queries this directly.

Key tables:
- `hafsql.comments` — all Hive posts and comments. Columns: `author`, `permlink`, `title`, `body`, `json_metadata` (jsonb), `created`, `parent_author`, `parent_permlink`
- PEvO papers have `parent_author = ''` and `parent_permlink = '<app_tag>'` (default `pevo`)
- Paper metadata lives in `json_metadata -> '<app_tag>'` with fields like `type`, `ipfs_cid`, `ipfs_filename`, `discipline`, `supplementary_files`

The default public HAF node is: `postgresql://hafsql_public:hafsql_public@hafsql-sql.mahdiyari.info:5432/haf_block_log`

### CID Discovery

Three sources of IPFS CIDs to discover:

1. **Paper PDFs** — `json_metadata -> app_tag ->> 'ipfs_cid'` on paper posts
2. **Supplementary files** — `json_metadata -> app_tag -> 'supplementary_files'` JSON array, each element has a `cid` field
3. **Inline images** — IPFS gateway URLs embedded in post `body` text, matching pattern `/ipfs/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58})/`

### Embedded IPFS Node

Use `github.com/ipfs/boxo` (the Go IPFS component library) to run an IPFS node in-process. This is the recommended approach for embedding IPFS in Go applications — it gives you a full DHT-connected node without requiring an external Kubo daemon.

Key capabilities needed:
- Persistent blockstore at `DATA_DIR/ipfs`
- DHT connection for content routing
- Pin/unpin CIDs
- HTTP gateway serving files at `/ipfs/<CID>`

### Pinata Alternative

Some operators may prefer cloud pinning. The Pinata backend uses:
- `POST https://api.pinata.cloud/pinning/pinByHash` — pin by CID (no file upload needed, Pinata fetches from IPFS network)
- `DELETE https://api.pinata.cloud/pinning/unpin/<pin_id>` — unpin
- `GET https://api.pinata.cloud/pinning/pinJobs?ipfs_pin_hash=<cid>&status=pinned` — check pin status
- `GET https://api.pinata.cloud/data/pinList?status=pinned` — list all pins
- Auth headers: `pinata_api_key` and `pinata_secret_api_key`

## Implementation Guide

### Build order (follow this sequence)

1. **`go.mod`** — `module pevo-pinner`, Go 1.22+, add `lib/pq` for PostgreSQL. Use a simple local module name — this is a standalone binary, not an importable library.
2. **`config.go`** — Parse env vars with CLI flag overrides. Required: `HAF_DATABASE_URL`. See config table in spec.
3. **`discovery.go`** — HAF SQL query + body regex scan. Periodic refresh with in-memory cache. Return a slice of discovered items (author, permlink, title, cid, type, discipline, created).
4. **`pinner.go`** — Define the `IPFSBackend` interface: `Pin`, `Unpin`, `IsPinned`, `PinnedCIDs`, `Close`.
5. **`ipfsnode.go`** — Implement `IPFSBackend` using boxo. Initialize repo, connect to DHT, serve gateway.
6. **`pinata.go`** — Implement `IPFSBackend` using Pinata REST API.
7. **`server.go`** — HTTP API using `net/http` with Go 1.22 routing. Embed static files with `embed.FS`. Proxy `/ipfs/*` to the embedded node's gateway.
8. **`static/`** — Alpine.js management UI. Paper table with pin toggles, filters, bulk actions, status bar.
9. **`main.go`** — Parse config, start discovery, create pinner backend, start server. Graceful shutdown on SIGINT/SIGTERM.
10. **`Dockerfile`** — Multi-stage: `golang:1.22-alpine` builder, `alpine:3.19` runtime.
11. **`.env.example`** — Document all env vars with comments.

### HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serve management UI (embedded static files) |
| `/api/papers` | GET | List discovered papers with CIDs and pin status |
| `/api/pin/{cid}` | POST | Pin a single CID |
| `/api/unpin/{cid}` | POST | Unpin a CID |
| `/api/pin-all` | POST | Pin all discovered CIDs |
| `/api/status` | GET | Stats: total discovered, pinned count, IPFS peer count |
| `/ipfs/{cid...}` | GET | Gateway — serve pinned IPFS content |

### Management UI

Alpine.js single-page app embedded in the binary (no build step):

- Table: title, author, discipline, CID (truncated with copy button), pin status toggle
- Filter dropdown for discipline, text search for title/author
- "Pin All" / "Unpin All" bulk action buttons
- Status bar: "42 of 87 CIDs pinned | 12 peers | Next refresh in 34m"
- Respects OS dark/light preference via `prefers-color-scheme`
- Polls `/api/papers` on load and after pin/unpin actions

### Configuration

| Env Var | CLI Flag | Default | Description |
|---------|----------|---------|-------------|
| `HAF_DATABASE_URL` | `--haf-url` | *(required)* | PostgreSQL connection string |
| `APP_TAG` | `--app-tag` | `pevo` | Hive app tag for content discovery |
| `IPFS_MODE` | `--ipfs-mode` | `embedded` | `embedded` or `pinata` |
| `DATA_DIR` | `--data-dir` | `~/.pevo-pinner` | Persistent storage for IPFS repo |
| `PINATA_API_KEY` | | | Required if mode=pinata |
| `PINATA_SECRET_KEY` | | | Required if mode=pinata |
| `PORT` | `--port` | `8421` | Management UI port |
| `GATEWAY_PORT` | `--gateway-port` | `8080` | IPFS gateway port (embedded mode only) |
| `REFRESH_INTERVAL` | `--refresh` | `1h` | How often to re-query HAF for new papers |

CLI flags take precedence over env vars.

## Boundaries

- Do NOT modify files outside `pinner/`.
- Do NOT import or depend on PEvO's TypeScript backend code.
- The pinner is a completely standalone Go program — it shares only the HAF database connection pattern and the understanding of PEvO's metadata schema.

## Quality Standards

- `go build` must produce a single static binary
- `go vet` and `go fmt` must pass clean
- Handle errors explicitly — no ignored error returns
- Graceful shutdown: drain HTTP connections, close IPFS node, close DB pool
- Log startup config (redact passwords), log pin/unpin operations
- The binary should print a helpful usage message if `HAF_DATABASE_URL` is not set

## Upstream IPFS Roadmap (context, not pinner tasks)

These are backend/UI changes that affect what the pinner discovers:

- **Kubo container** (done) — `docker-compose.yml` includes a Kubo IPFS service. The backend can pin to it directly.
- **Replace Pinata with local pinning** (backend task) — Backend's `ipfs.ts` to call Kubo's API (`/api/v0/add?pin=true`) instead of Pinata. Config: `IPFS_API_URL` (default `http://ipfs:5001`), `IPFS_GATEWAY_URL` (default `http://ipfs:8080`).
- **Expanded file types** (backend task) — Accept PNG, JPEG, GIF, WebP, SVG, CSV, ZIP in addition to PDF. Magic-bytes validation per type. 10MB limit. Response adds `type` field.
- **Supplementary files** (UI + backend task) — Authors attach datasets, figures, code archives alongside papers. Stored in `json_metadata.pevo.supplementary_files` as `[{ cid, filename, type, size, description }]`. The pinner's discovery query already extracts these CIDs.

## When Done

Move your task from Pending to **Review** in `TASKS.md` and log completion in `PROGRESS.md`. Do NOT move it to Done — the Architect reviews the implementation.
