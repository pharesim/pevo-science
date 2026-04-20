-- Durable tracking for in-flight IPFS pins.
-- Redis keys have a 24h TTL and are lost on flush/eviction, which would leave
-- orphan pins on Kubo that the cleanup job can never discover. This table is
-- the authoritative record; Redis remains as a hot cache for the download
-- proxy's known-CID check.

CREATE TABLE IF NOT EXISTS pending_ipfs_uploads (
  cid                TEXT PRIMARY KEY,
  uploader_account   TEXT NOT NULL,
  size_bytes         BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_ipfs_uploads_created_at
  ON pending_ipfs_uploads (created_at);
