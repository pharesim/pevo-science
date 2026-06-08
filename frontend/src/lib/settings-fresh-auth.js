import Alpine from 'alpinejs';
import { mintSettingsActionProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginSettingsActionOrcidFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
} from './fresh-auth.js';

/**
 * Reusable fresh-auth proof-challenge flow for the three settings critical
 * actions (`change_email`, `set_password`, `delete_account`).
 *
 * On the JWT (light-account) path the backend requires a single-use,
 * target-bound `fresh_auth_proof` in the request body of each action (see
 * `agents/docs/api-contracts/settings.md` and ARCHITECTURE.md § 6.4/§ 6.5).
 * Self-custody (Keychain) requests are fresh at the middleware and carry no body
 * proof. This module mints/looks up the proof for the JWT path via the factor
 * the account supports and threads it into the action call.
 *
 * Two factors, selected by account state:
 *   - PASSWORD: prompt via the global reauth modal, then mint at
 *     `/custody/fresh-auth`. Used for `change_email` / `delete_account` when the
 *     account has a password. Inline (no navigation).
 *   - ORCID: a full-page OAuth round-trip (`beginSettingsActionOrcidFreshAuth`),
 *     whose proof the `/orcid/callback` handler lands in the consent-op cache.
 *     The only factor for `set_password` (its target account is passwordless),
 *     and the fallback for passwordless `change_email` / `delete_account`.
 *
 * The settings actions consume a consent-op-kind, target-bound proof — the same
 * cache the ORCID round-trip lands into — so this reuses `getCachedConsentOpProof`
 * keyed on (action, username, ''), NOT the session-kind broadcast path.
 */

// Sentinel: the user dismissed the password re-auth modal. Distinct from
// FRESH_AUTH_REDIRECT_PENDING (an ORCID round-trip is navigating away). Both
// mean "no proof obtained — abort the action cleanly without an error"; the
// caller surfaces them the same way (no error toast).
const CANCELLED = Symbol('settings_fresh_auth_cancelled');

// 401 consume-failure reasons that mean "the proof was absent or no longer
// usable" — re-mint and retry once. Mirrors the reason set
// `broadcastWithFreshAuth` retries on. `wrong_mechanism` is deliberately
// excluded: it means the minted factor is not registered on the account, which
// re-minting the same factor would not fix, so it falls through to the generic
// failure outcome.
const REMINTABLE_REASONS = ['missing', 'expired', 'malformed'];

function passwordPromptMessage() {
  // Lib code cannot use the `$t` magic helper; read the i18n store directly with
  // an English fallback, matching the fresh-auth.js session-inconsistency path.
  return (
    Alpine.store('i18n')?.messages?.settings?.reauthPasswordPrompt ||
    'Enter your account password to confirm this action.'
  );
}

// Password-factor mint: prompt via the global reauth modal, then mint. A wrong
// password (401 UNAUTHORIZED at the mint route) re-prompts once before giving
// up. Returns the proof string or CANCELLED.
async function mintViaPassword(action) {
  const modal = Alpine.store('reauthModal');
  const message = passwordPromptMessage();

  let password = await modal.request({ message });
  if (password === null || password === undefined) return CANCELLED;

  try {
    return await mintSettingsActionProof(action, password);
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      password = await modal.request({ message });
      if (password === null || password === undefined) return CANCELLED;
      return mintSettingsActionProof(action, password);
    }
    throw err;
  }
}

// Resolve a fresh-auth proof for `action` on a light account. Returns the proof
// string, FRESH_AUTH_REDIRECT_PENDING (ORCID round-trip started), or CANCELLED
// (password modal dismissed). Factor selection: a freshly-returned ORCID proof
// in the consent-op cache wins; otherwise the password factor when the account
// has a password AND the action is not `set_password` (passwordless by
// definition, so ORCID-only); otherwise the ORCID factor.
async function resolveProof(action, { username, hasPassword }) {
  const cached = getCachedConsentOpProof(action, username, '');
  if (cached) return cached;

  const usePassword = action !== 'set_password' && hasPassword;
  if (usePassword) {
    return mintViaPassword(action);
  }
  return beginSettingsActionOrcidFreshAuth(action);
}

/**
 * Run a settings critical action with the fresh-auth proof its JWT path
 * requires. `run(proof)` performs the API call (proof is `undefined` for
 * self-custody). Returns an outcome object:
 *
 *   { ok: <apiResult> }       request succeeded
 *   { redirect: true }        ORCID round-trip in flight; abort cleanly
 *   { cancelled: true }       user dismissed the password modal; abort cleanly
 *   { freshAuthFailed: true } re-auth rejected (403 binding violation, wrong
 *                             mechanism, or a second 401); show a generic error
 *
 * Non-fresh-auth errors (DUPLICATE, validation, transport, etc.) propagate to
 * the caller, which keeps the existing per-action error handling.
 *
 * @param {'change_email'|'set_password'|'delete_account'} action
 * @param {{ custody: string, username: string, hasPassword: boolean }} ctx
 * @param {(proof: string|undefined) => Promise<any>} run
 */
export async function withSettingsFreshAuth(action, ctx, run) {
  // Keychain / self-custody: the per-request signature is itself the fresh
  // proof, so no body proof is sent. Mirrors broadcastWithFreshAuth's gate.
  if (ctx.custody !== 'light') {
    return { ok: await run(undefined) };
  }

  const proof = await resolveProof(action, ctx);
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { redirect: true };
  if (proof === CANCELLED) return { cancelled: true };

  try {
    const ok = await run(proof);
    // Proof is single-use and consumed by the backend on success; drop any
    // cached copy so the next action mints fresh rather than replaying a dead
    // token (a no-op when the password factor was used — it never caches).
    clearCachedConsentOpProof();
    return { ok };
  } catch (err) {
    if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;

    // The proof is consumed (success or fail) before the route's mutation, so
    // any retry must mint a fresh one. Drop the cache first.
    clearCachedConsentOpProof();

    // 401 missing/expired/malformed → re-mint and retry once.
    if (err.status === 401 && REMINTABLE_REASONS.includes(err.details?.reason)) {
      const retry = await resolveProof(action, ctx);
      if (retry === FRESH_AUTH_REDIRECT_PENDING) return { redirect: true };
      if (retry === CANCELLED) return { cancelled: true };
      try {
        const ok = await run(retry);
        clearCachedConsentOpProof();
        return { ok };
      } catch (retryErr) {
        if (retryErr?.code === 'FRESH_AUTH_REQUIRED') return { freshAuthFailed: true };
        throw retryErr;
      }
    }

    // 401 wrong_mechanism, or 403 username/target/kind mismatch → not fixable by
    // re-minting the same factor; surface a generic re-auth failure.
    return { freshAuthFailed: true };
  }
}
