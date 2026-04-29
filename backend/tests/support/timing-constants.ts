// Shared timing-oracle assertion thresholds for /api/auth/* and /api/auth/recover/*
// timing tests. Centralized here so a future tuning of argon2 wall-time only
// has one site to update; previously this constant was duplicated across
// recover.test.ts, signup-verify.test.ts, and auth-concurrency.test.ts and a
// missed update would silently weaken or strengthen the mutation-kill threshold
// in one file only.
//
// FLOOR is 35ms (not 40ms or ≥50ms) because argon2.verify at our ARGON2_OPTIONS
// (memoryCost = 64 MiB, time = 3, see backend/src/routes/auth.ts) runs 42-55ms
// median on reference hardware but can drop into the high-20s on faster CI
// hosts. Pinning the assertion to 50ms flakes on reference; pinning to 40ms
// lets a faster host silently let a ~28ms production oracle through. 35ms
// still kills the sentinel-removal mutation (~1ms pre-sentinel path → 35×
// margin) while surviving the lowest plausible argon2-verify floor.
//
// If ARGON2_OPTIONS.memoryCost or time changes, revisit this floor: a lower-
// cost configuration shrinks the gap between the burned and not-burned paths
// and may demand a lower floor (or a different mutation-kill strategy).
export const TIMING_ORACLE_FLOOR_MS = 35;

// CEILING is 150ms (not 40ms) because DB roundtrips + Express + supertest
// overhead on stressed CI can add 20-50ms to the no-argon2 path even without
// a burn. 40ms gave false-negative fails; 150ms is still well below the
// combined cost of argon2.verify + DB + Express (typically ~100ms total),
// so a regression that turns on argon2 on the fast-path would still cross
// 150ms and fail the assertion. Currently used only by recover.test.ts; kept
// here next to FLOOR so both thresholds and their argon2-tuning rationale
// live together.
export const TIMING_ORACLE_CEILING_MS = 150;
