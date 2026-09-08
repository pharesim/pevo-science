import { mintSettingsActionProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginSettingsActionOrcidFreshAuth,
  consentOpFreshAuthRetryGate,
  FRESH_AUTH_REDIRECT_PENDING,
  FRESH_AUTH_CANCELLED,
  FRESH_AUTH_MINT_FAILED,
  FRESH_AUTH_PROMPT_BUSY,
  FRESH_AUTH_ORCID_FALLBACK,
  mintViaPasswordFactor,
  passwordPromptMessage,
  resolvePasswordFactor,
  promptBusy,
  subjectTeardownGuard,
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
 *     `/custody/fresh-auth`. The default factor for `change_email` /
 *     `delete_account`: used unless the account is known to be passwordless.
 *     Inline (no navigation).
 *   - ORCID: a full-page OAuth round-trip (`beginSettingsActionOrcidFreshAuth`),
 *     whose proof the `/orcid/callback` handler lands in the consent-op cache.
 *     The only factor for `set_password` (its target account is passwordless
 *     by definition), and the fallback for a `change_email` / `delete_account`
 *     account whose status explicitly reports no password.
 *
 * The settings actions consume a consent-op-kind, target-bound proof — the same
 * cache the ORCID round-trip lands into — so this reuses `getCachedConsentOpProof`
 * keyed on (action, username, ''), NOT the session-kind broadcast path.
 */

// Bind the password factor to this surface's mint call. The prompt/re-prompt
// flow and the CANCELLED/MINT_FAILED/ORCID_FALLBACK outcomes live in the
// shared mintViaPasswordFactor (fresh-auth.js); only the action-bound mint
// differs. `assumed` is the resolver's observed-vs-guessed flag, threaded
// through so an assumed password the backend 401s hands the action to the
// ORCID factor rather than a second prompt.
// The wire value is coerced before it leaves this callback, because the mint
// hands back `fresh_auth_proof` verbatim and FRESH_AUTH_REDIRECT_PENDING is
// `null` — the one member of the outcome vocabulary a JSON response can
// carry. Without the coercion a response whose proof field is null reads as
// "an ORCID round-trip is in flight" at `withSettingsFreshAuth`'s outcome
// ladder, and every caller aborts silently for a navigation that never
// started: the user answers the prompt, the spinner clears, and the action
// simply does not happen. The vocabulary's other members are Symbols, which no
// response can produce. FRESH_AUTH_MINT_FAILED is what a non-string lands on
// instead, because it is already this surface's word for re-auth that could
// not be completed and it reaches the user without spending a second prompt
// and a second write on a token the backend has declined to issue.
function mintViaPassword(action, assumed, guard) {
  return mintViaPasswordFactor(
    async (password) => {
      const proof = await mintSettingsActionProof(action, password);
      return typeof proof === 'string' ? proof : FRESH_AUTH_MINT_FAILED;
    },
    { message: passwordPromptMessage(), assumed, guard },
  );
}

// Start this surface's ORCID round-trip under the action's teardown guard.
// The start is itself an await a subject teardown can land in, so the starter
// re-checks `guard.tornDown` immediately before assigning window.location:
// stale starts unwind without navigating and resolve the shared clean-cancel
// sentinel, which this wrapper reports through
// `guard.cancel()` — once, here, for all three paths into the redirect (the
// passwordless branch, the assumed-password fallback, and the retry gate's
// hook), so no path can navigate the new subject's tab to ORCID for the
// subject that left, and none can drift on how the unwind reports. The flow
// keys the start wrote are the subject scrub's to remove, not this unwind's:
// the predicate reads true only after that scrub has run.
async function beginOrcidUnderGuard(action, guard) {
  const started = await beginSettingsActionOrcidFreshAuth(action, guard.tornDown);
  return started === FRESH_AUTH_CANCELLED ? guard.cancel() : started;
}

// `set_password` is the one deliberate exception to the shared factor resolver:
// its target account is passwordless BY DEFINITION (filling a null hash is what
// the action exists to do), so ORCID is the only factor registered on it no
// matter what the account status reports. Every other action defers to
// `resolvePasswordFactor`, which owns the fetch, the memo, the coalescing, and
// the unknown-status-falls-through-to-password direction. Centralized here so
// the initial mint (`resolveProof`) and the 401-retry gate
// (`withSettingsFreshAuth`) cannot drift on the exception.
async function passwordFactorFor(action) {
  if (action === 'set_password') return { usesPassword: false, assumed: false };
  return resolvePasswordFactor();
}

// Resolve a fresh-auth proof for `action` on a light account. Returns the proof
// string, FRESH_AUTH_REDIRECT_PENDING (ORCID round-trip started), CANCELLED
// (password modal dismissed), or MINT_FAILED (password re-auth exhausted).
// Factor selection: a freshly-returned ORCID proof in the consent-op cache
// wins; otherwise the password factor when `passwordFactorFor` holds;
// otherwise the ORCID factor. An ASSUMED password the backend 401s falls back
// to the ORCID round-trip — the settings page has no unsaved state worth more
// than completing the action.
async function resolveProof(action, { username }, guard) {
  const cached = getCachedConsentOpProof(action, username, '');
  if (cached) return cached;

  const factor = await passwordFactorFor(action);
  // The status read is itself an await a teardown can land in, and the answer
  // decides between prompting and navigating. Acting on it after a subject
  // change would open a prompt, or fire a full-page ORCID round-trip, for the
  // subject that left. The shared mint's own guard cannot see this one: it is
  // only entered after this point.
  if (guard.tornDown()) return guard.cancel();
  if (!factor.usesPassword) return beginOrcidUnderGuard(action, guard);

  const minted = await mintViaPassword(action, factor.assumed, guard);
  if (minted === FRESH_AUTH_ORCID_FALLBACK) {
    return beginOrcidUnderGuard(action, guard);
  }
  return minted;
}

/**
 * Run a settings critical action with the fresh-auth proof its JWT path
 * requires. `run(proof)` performs the API call (proof is `undefined` for
 * self-custody). Returns an outcome object:
 *
 *   { ok: <apiResult> }       request succeeded
 *   { redirect: true }        ORCID round-trip in flight; abort cleanly
 *   { cancelled: true }       user dismissed the password modal, or a subject
 *                             teardown abandoned the action (already reported by
 *                             the teardown itself); abort cleanly either way
 *   { freshAuthFailed: true } re-auth rejected or could not be completed (403
 *                             binding violation, wrong mechanism, a second wrong
 *                             password, or an expired ORCID-factor proof on
 *                             arrival); show a generic error
 *   { sessionInconsistent: true } the JWT subject and the proof subject diverge
 *                             (corrupted session); the session is torn down and a
 *                             re-login toast shown here — the caller aborts
 *                             cleanly without a second toast
 *
 * Non-fresh-auth errors (DUPLICATE, validation, transport, etc.) propagate to
 * the caller, which keeps the existing per-action error handling.
 *
 * @param {string} action - the fresh-auth target action, e.g. the settings
 *   actions ('change_email' | 'set_password' | 'delete_account' |
 *   'edit_accreditation_metadata') or the admin-console authority actions
 *   ('admin_grant_role', 'admin_grant_accreditation', etc.). Only the value
 *   matters to the backend's proof target; the orchestrator special-cases
 *   'set_password' (ORCID-only factor) and otherwise defers factor selection to
 *   the shared `resolvePasswordFactor` resolver.
 * @param {{ custody: string, username: string }} ctx
 * @param {(proof: string|undefined) => Promise<any>} run
 */
export async function withSettingsFreshAuth(action, ctx, run) {
  // Keychain / self-custody: the per-request signature is itself the fresh
  // proof, so no body proof is sent. Mirrors broadcastWithFreshAuth's gate.
  if (ctx.custody !== 'light') {
    return { ok: await run(undefined) };
  }

  // Opened before the first await, so it covers the whole action: the status
  // read, the prompt, the mint, the guarded call, and the retry gate's
  // re-mint. Every one of those must belong to the subject this tab
  // represented when the user asked for the action.
  const guard = subjectTeardownGuard();
  const proof = await resolveProof(action, ctx, guard);
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { redirect: true };
  if (proof === FRESH_AUTH_PROMPT_BUSY) return promptBusy();
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
    // The FRESH_AUTH_REQUIRED fallout — the remintable re-mint+retry, the
    // ASSUMED-password ORCID fallback, the username_mismatch teardown, and the
    // terminal freshAuthFailed — lives in the shared retry gate
    // (`consentOpFreshAuthRetryGate`, fresh-auth.js); only this surface's
    // bindings differ. `passwordFactorFor` keeps the set_password ORCID-only
    // exception in force on the retry, exactly as on the initial mint. Errors
    // that are not fresh-auth rethrow from the gate, so the caller keeps its
    // per-action handling.
    return consentOpFreshAuthRetryGate(err, {
      guard,
      resolveFactor: () => passwordFactorFor(action),
      mint: (assumed) => mintViaPassword(action, assumed, guard),
      beginOrcidRedirect: () => beginOrcidUnderGuard(action, guard),
      run,
      clearProofCache: clearCachedConsentOpProof,
    });
  }
}
