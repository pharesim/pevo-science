/**
 * Format a best-effort ETA (in seconds) into a short localized string.
 *
 * Used by the bridge import queued-state surface and the "My imports" page to
 * render the worker-tick estimate the backend returns as `eta_seconds`. The
 * backend derives the estimate from the chain cooldown window, so it is coarse
 * by nature; the formatter rounds to whole minutes / hours+minutes rather than
 * implying second-level precision.
 *
 * Localization is delegated to the caller's `$t` via the `myImports.eta*`
 * keys, which are the canonical ETA strings (`etaMinutes`, `etaHours`,
 * `etaUnknown`). Centralizing the bucketing here keeps the bridge submission
 * page and the My imports list rendering the same human ETA from the same
 * `eta_seconds` input.
 *
 * @param {number|null|undefined} etaSeconds best-effort estimate; `null`/
 *   non-finite/negative renders the `etaUnknown` string.
 * @param {(key: string, params?: object) => string} t the page's `$t`.
 * @returns {string} a short localized ETA, or the unknown-ETA string.
 */
export function formatEta(etaSeconds, t) {
  if (etaSeconds === null || etaSeconds === undefined || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
    return t('myImports.etaUnknown');
  }
  // Position 1 dispatches on the next tick, so its ETA is 0 — still surface a
  // concrete "~1 min" rather than "0 min", which reads as "should already be
  // done" to a user staring at a pending row.
  const totalMinutes = Math.max(1, Math.round(etaSeconds / 60));
  if (totalMinutes < 60) {
    return t('myImports.etaMinutes', { minutes: totalMinutes });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return t('myImports.etaHours', { hours, minutes });
}
