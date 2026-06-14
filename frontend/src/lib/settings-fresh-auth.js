import { mintSettingsActionProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginSettingsActionOrcidFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
  FRESH_AUTH_CANCELLED,
  FRESH_AUTH_MINT_FAILED,
  REMINTABLE_REASONS,
  mintViaPasswordFactor,
  passwordPromptMessage,
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

// Bind the password factor to this surface's mint call. The prompt/re-prompt
// flow and the CANCELLED/MINT_FAILED outcomes live in the shared
// mintViaPasswordFactor (fresh-auth.js); only the action-bound mint differs.
function mintViaPassword(action) {
  return mintViaPasswordFactor(
    (password) => mintSettingsActionProof(action, password),
    { message: passwordPromptMessage() },
  );
}

// The PASSWORD factor applies when the account has a password AND the action is
// not `set_password` (whose target account is passwordless by definition, so
// ORCID-only). Every other case uses the ORCID factor. Centralized so the
// initial mint (`resolveProof`) and the 401-retry gate (`withSettingsFreshAuth`)
// cannot drift on this predicate.
function usesPasswordFactor(action, hasPassword) {
  return action !== 'set_password' && hasPassword;
}

// Resolve a fresh-auth proof for `action` on a light account. Returns the proof
// string, FRESH_AUTH_REDIRECT_PENDING (ORCID round-trip started), CANCELLED
// (password modal dismissed), or MINT_FAILED (password re-auth exhausted).
// Factor selection: a freshly-returned ORCID proof in the consent-op cache
// wins; otherwise the password factor when `usesPasswordFactor` holds;
// otherwise the ORCID factor.
async function resolveProof(action, { username, hasPassword }) {
  const cached = getCachedConsentOpProof(action, username, '');
  if (cached) return cached;

  if (usesPasswordFactor(action, hasPassword)) {
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
 *   { freshAuthFailed: true } re-auth rejected or could not be completed (403
 *                             binding violation, wrong mechanism, a second wrong
 *                             password, or an expired ORCID-factor proof on
 *                             arrival); show a generic error
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
  if (proof === FRESH_AUTH_CANCELLED) return { cancelled: true };
  if (proof === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };

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

    // Re-mintable reasons (missing/expired/malformed) → mint a fresh proof and
    // retry the action once. The `err.code === 'FRESH_AUTH_REQUIRED'` check
    // above already establishes the 401 class; `ApiRequestError` (api.js) carries
    // no `status` field, only `code`/`details`, so the reason discriminator alone
    // gates the retry. `wrong_mechanism` (minted factor not registered on the
    // account) and the 403 username/target/kind mismatches are not fixable by
    // re-minting the same factor — they fall through to freshAuthFailed.
    const remintable = REMINTABLE_REASONS.includes(err.details?.reason);

    // Only the PASSWORD factor can retry inline. The ORCID factor would have to
    // re-run beginSettingsActionOrcidFreshAuth — a full-page OAuth redirect —
    // which near the 5-minute proof TTL risks a re-OAuth loop. For ORCID-factor
    // accounts surface a terminal re-auth failure so the user restarts
    // deliberately rather than bouncing through ORCID a second time.
    if (remintable && usesPasswordFactor(action, ctx.hasPassword)) {
      const retry = await mintViaPassword(action);
      if (retry === FRESH_AUTH_CANCELLED) return { cancelled: true };
      if (retry === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };
      try {
        const ok = await run(retry);
        clearCachedConsentOpProof();
        return { ok };
      } catch (retryErr) {
        if (retryErr?.code === 'FRESH_AUTH_REQUIRED') return { freshAuthFailed: true };
        throw retryErr;
      }
    }

    // 401 wrong_mechanism, 403 username/target/kind mismatch, or an ORCID-factor
    // proof we decline to re-mint inline → surface a generic re-auth failure.
    return { freshAuthFailed: true };
  }
}
