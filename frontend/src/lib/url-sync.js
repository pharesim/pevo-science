// Shared helper for page-owns-URL guards across list pages that sync filter
// state to window.location (paper-feed, researchers, search).
//
// The regex strips an optional 2-3 letter locale prefix (e.g. `/en`, `/fra`)
// when it's followed by `/` or end-of-string, so `/en/papers` → `/papers`,
// `/fr/papers/` → `/papers`, `/papers` → `/papers`. Paths like
// `/research-something` are not treated as having a locale prefix (the
// lookahead requires `/` or end-of-string after the locale segment), so they
// pass through untouched.
//
// Trailing slashes are dropped so `/fr/papers/` normalises to `/papers` —
// callers compare exact-equal to `/papers`, `/researchers`, `/search`.
export function localeStrippedPath(pathname) {
  const stripped = pathname.replace(/^\/[a-z]{2,3}(?=\/|$)/, '') || '/';
  if (stripped.length > 1 && stripped.endsWith('/')) {
    return stripped.slice(0, -1);
  }
  return stripped;
}
