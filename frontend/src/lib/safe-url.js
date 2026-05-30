// Protocol whitelist for external URLs rendered straight from chain
// json_metadata (bridge paper-source and PDF links). Alpine's :href binding
// escapes quote-breakout but does NOT block javascript:/data: protocol
// injection, and the markdown renderer's URL-protocol transformer is bypassed
// for these direct bindings. Gate every chain-derived external URL here so a
// crafted `javascript:...` source URL can't execute same-origin on click.
//
// Returns the normalized absolute URL only when its protocol is http(s);
// otherwise returns '' (a safe, inert href). The WHATWG URL parser also
// strips embedded tabs/newlines before resolving the scheme, so obfuscated
// forms like `java\tscript:` normalize to `javascript:` and are rejected too.
export function safeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // Unparseable input is treated as unsafe.
  }
  return '';
}
