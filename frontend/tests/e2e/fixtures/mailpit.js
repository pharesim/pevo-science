/**
 * Read the mail the test stack's Mailpit sink captured.
 *
 * Mailpit runs only under `./deploy.sh test-up`, which points the backend's
 * SMTP at it and publishes its HTTP API on 127.0.0.1:8025. MAILPIT_URL
 * overrides that address; it carries no secret. The API is called from the
 * Node test process, never from the page: the SPA's CSP does not let the
 * page fetch the Mailpit address.
 */

const MAILPIT_URL = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';

async function getJson(path) {
  const res = await fetch(`${MAILPIT_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`[e2e mailpit] GET ${path} answered ${res.status}`);
  return res.json();
}

/**
 * The plain-text body of the newest message to `to`, waiting for it to
 * arrive. Specs give every attempt its own addresses, so a recipient names
 * one message and nothing needs deleting between runs.
 */
export async function waitForMailText({ to, timeoutMs = 15_000 }) {
  const query = encodeURIComponent(`to:"${to}"`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { messages = [] } = await getJson(`/api/v1/search?query=${query}&limit=1`);
    if (messages.length > 0) {
      const message = await getJson(`/api/v1/message/${messages[0].ID}`);
      return message.Text;
    }
    if (Date.now() > deadline) throw new Error(`[e2e mailpit] no message to ${to} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The path and query of the link in `text` whose path is `path`. The mail
 * carries the backend's APP_URL origin, which need not be the Playwright
 * base URL, so specs open the path on their own origin.
 */
export function linkPath(text, path) {
  for (const raw of text.match(/https?:\/\/\S+/g) ?? []) {
    const url = new URL(raw);
    if (url.pathname === path) return url.pathname + url.search;
  }
  throw new Error(`[e2e mailpit] no ${path} link in the message`);
}
