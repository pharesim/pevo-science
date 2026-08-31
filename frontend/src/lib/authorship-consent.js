import { mintAuthorshipFreshAuthProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginAuthorshipOrcidFreshAuth,
  FRESH_AUTH_REDIRECT_PENDING,
  FRESH_AUTH_CANCELLED,
  FRESH_AUTH_MINT_FAILED,
  FRESH_AUTH_PROMPT_BUSY,
  FRESH_AUTH_ORCID_FALLBACK,
  REMINTABLE_REASONS,
  mintViaPasswordFactor,
  passwordPromptMessage,
  resolvePasswordFactor,
  handleSessionInconsistency,
  promptBusy,
} from './fresh-auth.js';

/**
 * Fresh-auth proof-challenge flow for authorship consent/credit ops broadcast
 * through the custody endpoint — Routes 2 & 3 of the consent model
 * (`author_accept` / `author_resign`, and `claim_authorship` /
 * `approve_authorship` / `revoke_authorship`).
 *
 * Parallel to `withSettingsFreshAuth` (settings-fresh-auth.js), but the proof
 * binds to the PAPER target — and, for name-only credit ops, the slot
 * (`author_index`) and/or subject (`claimer`) — rather than the account-level
 * `(action, username, '')` target. Self-custody (Keychain) requests are fresh at
 * the middleware and carry no body proof; the per-request signature IS the proof.
 * Light accounts mint a target-bound proof via the factor the account supports
 * and thread it into the custody broadcast.
 *
 * Two factors, selected by account state:
 *   - PASSWORD: prompt via the global reauth modal, then mint at
 *     `/custody/fresh-auth`. The default factor: used unless the account is
 *     known to be passwordless. Inline (no navigation).
 *   - ORCID: a full-page OAuth round-trip (`beginAuthorshipOrcidFreshAuth`),
 *     whose proof the `/orcid/callback` handler lands in the consent-op cache.
 *     The factor for accounts whose status explicitly reports no password.
 *     Every accredited account has a linked ORCID, so this factor is always
 *     available to a user permitted to consent — but it is NOT the fallback for
 *     an unknown status: navigating away from a paper page costs the user their
 *     place, so an unresolved status takes the inline prompt and lets the
 *     backend reject a genuinely passwordless account. Only after such a
 *     rejection confirms there is no password does the op fall back to the
 *     round-trip, because at that point the redirect is the only way through.
 *
 * `target` is the normalized op descriptor:
 *   { action, rootAuthor, rootPermlink, authorIndex?, claimer? }
 * where `rootAuthor`/`rootPermlink` are the paper's root author/permlink (the
 * fields the backend echoes and the proof cache keys on, for both routes).
 */

// Bind the password factor to this surface's mint call. The prompt/re-prompt
// flow and the CANCELLED/MINT_FAILED/ORCID_FALLBACK outcomes live in the
// shared mintViaPasswordFactor (fresh-auth.js); only the target-bound mint
// differs. `assumed` is the resolver's observed-vs-guessed flag, threaded
// through so an assumed password the backend 401s hands the op to the ORCID
// factor rather than a second prompt.
function mintViaPassword(target, assumed) {
  return mintViaPasswordFactor(
    (password) => mintAuthorshipFreshAuthProof(target, password),
    { message: passwordPromptMessage(), assumed },
  );
}

function getCachedProof(target) {
  return getCachedConsentOpProof(
    target.action,
    target.rootAuthor,
    target.rootPermlink,
    target.authorIndex,
    target.claimer,
  );
}

// Resolve a target-bound proof for a light account. A freshly-returned ORCID
// proof in the consent-op cache wins; otherwise the factor the shared resolver
// selects — the inline password prompt unless the account is KNOWN to be
// passwordless, in which case the ORCID round-trip. An ASSUMED password the
// backend 401s also falls back to the round-trip: navigating away from the
// paper page costs the user their place, but the alternative is an op that
// cannot complete at all.
async function resolveProof(target) {
  const cached = getCachedProof(target);
  if (cached) return cached;
  const factor = await resolvePasswordFactor();
  if (!factor.usesPassword) return beginAuthorshipOrcidFreshAuth(target);
  const minted = await mintViaPassword(target, factor.assumed);
  if (minted === FRESH_AUTH_ORCID_FALLBACK) {
    return beginAuthorshipOrcidFreshAuth(target);
  }
  return minted;
}

/**
 * Run an authorship consent/credit broadcast with the fresh-auth proof its
 * custody path requires. `run(proof)` performs the broadcast (proof is
 * `undefined` for self-custody — Keychain signs). Returns an outcome object:
 *
 *   { ok: <broadcastResult> }     broadcast succeeded
 *   { redirect: true }            ORCID round-trip in flight; abort cleanly
 *   { cancelled: true }           user dismissed the password modal; abort cleanly
 *   { freshAuthFailed: true }     re-auth rejected or could not be completed;
 *                                 show a generic error
 *   { sessionInconsistent: true } the JWT subject and proof subject diverge
 *                                 (corrupted session); the session is torn down
 *                                 and a re-login toast shown here — the caller
 *                                 aborts cleanly without a second toast
 *
 * Non-fresh-auth errors (a Keychain rejection, a 403 from the chain gate, a
 * transport error) propagate to the caller, which keeps its op-level handling.
 *
 * @param {{action: string, rootAuthor: string, rootPermlink: string, authorIndex?: number|null, claimer?: string|null}} target
 * @param {{ custody: string, username: string }} ctx
 * @param {(proof: string|undefined) => Promise<any>} run
 */
export async function withAuthorshipFreshAuth(target, ctx, run) {
  // Self-custody: the per-request signature is itself the fresh proof, so no
  // body proof is sent. Mirrors broadcastWithFreshAuth / withSettingsFreshAuth.
  if (ctx.custody !== 'light') {
    return { ok: await run(undefined) };
  }

  const proof = await resolveProof(target);
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { redirect: true };
  if (proof === FRESH_AUTH_PROMPT_BUSY) return promptBusy();
  if (proof === FRESH_AUTH_CANCELLED) return { cancelled: true };
  if (proof === FRESH_AUTH_MINT_FAILED) return { freshAuthFailed: true };

  try {
    const ok = await run(proof);
    // Proof is single-use and consumed by the backend before the broadcast; drop
    // any cached copy so the next op mints fresh rather than replaying a dead
    // token (a no-op when the password factor was used — it never caches).
    clearCachedConsentOpProof();
    return { ok };
  } catch (err) {
    if (err?.code !== 'FRESH_AUTH_REQUIRED') throw err;

    // The proof is consumed (success or fail) before the broadcast, so any retry
    // must mint a fresh one. Drop the cache first.
    clearCachedConsentOpProof();

    // Re-mintable reasons (missing/expired/malformed) retry inline ONLY on the
    // password factor. A KNOWN-ORCID account would need a second full-page
    // OAuth redirect near the 5-minute TTL (re-OAuth loop risk); it surfaces a
    // terminal failure so the user restarts deliberately. The one exception is
    // the ASSUMED-password 401 at the retry mint: there the 401 is new
    // information (the account has no password), the user has just engaged by
    // typing one, and without the redirect the op dead-ends — each pass costs
    // a typed password plus a full OAuth round-trip, so it cannot tight-loop.
    // `wrong_mechanism` and the 403 username/target/kind mismatches are not
    // fixable by re-minting the same factor — they fall through to
    // freshAuthFailed.
    const remintable = REMINTABLE_REASONS.includes(err.details?.reason);
    if (remintable) {
      const factor = await resolvePasswordFactor();
      if (factor.usesPassword) {
        const retry = await mintViaPassword(target, factor.assumed);
        if (retry === FRESH_AUTH_ORCID_FALLBACK) {
          await beginAuthorshipOrcidFreshAuth(target);
          return { redirect: true };
        }
        if (retry === FRESH_AUTH_PROMPT_BUSY) return promptBusy();
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
    }

    // username_mismatch: the JWT subject and the proof subject diverge — a
    // corrupted session, not a retryable re-auth failure. Tear the session down
    // and force re-login via the shared teardown, matching the session-kind and
    // settings siblings; otherwise the user retries a broken session indefinitely
    // against the generic "try again" outcome. Gate on the reason, not a status
    // code: the custody-broadcast error reaching this catch is an api.js
    // ApiRequestError carrying only code/details, no `status`.
    if (err.details?.reason === 'username_mismatch') {
      handleSessionInconsistency();
      return { sessionInconsistent: true };
    }

    return { freshAuthFailed: true };
  }
}
