// Canonical argon2id parameters for password hashing across the backend.
// Pinned explicitly so a future node-argon2 default change, or a partial
// upgrade across call sites, cannot silently drift production-hashing
// parameters. Values meet OWASP 2024 minimums for argon2id
// (memoryCost >= 19456 KiB, timeCost >= 2, parallelism >= 1) with headroom.
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;
