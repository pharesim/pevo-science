/**
 * Error tracking module backed by Sentry when NEXT_PUBLIC_SENTRY_DSN is set,
 * falling back to console.error otherwise.
 *
 * Usage:
 *   import { captureException, captureMessage } from "@/lib/errorTracking";
 *   captureException(err);
 *   captureMessage("something unexpected");
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;

  if (!DSN) return;

  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV ?? "development",
    // Adjust sample rates for production use
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
    // Only send errors in production by default; in dev, log to console
    enabled: process.env.NODE_ENV === "production",
  });
}

/**
 * Capture an exception. Sends to Sentry when DSN is configured,
 * otherwise logs to console.error.
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  ensureInit();

  if (DSN) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } else {
    console.error("[PEvO errorTracking] Exception:", error, context ?? "");
  }
}

/**
 * Capture a plain message. Sends to Sentry when DSN is configured,
 * otherwise logs to console.error.
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  ensureInit();

  if (DSN) {
    Sentry.captureMessage(message, level);
  } else {
    const logFn =
      level === "error"
        ? console.error
        : level === "warning"
          ? console.warn
          : console.info;
    logFn(`[PEvO errorTracking] ${level}:`, message);
  }
}
