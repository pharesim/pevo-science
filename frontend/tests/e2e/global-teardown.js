/**
 * Playwright global-teardown — currently a no-op. Reset happens in global-setup
 * so each run starts clean; leaving rows after a failed run is intentional so
 * they can be inspected.
 */

export default async function globalTeardown() {}
