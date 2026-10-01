// "5 minutes ago" for a past timestamp, in the `time.*` i18n strings. Shared
// by the composer pages' draft cards, which state how old a stored draft is.
export function relativeTime(timestamp, t) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesLong', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursLong', { count: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.yesterday');
  return t('time.daysLong', { count: days });
}
