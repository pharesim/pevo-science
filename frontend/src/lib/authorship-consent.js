import { mintAuthorshipFreshAuthProof } from '../api.js';
import {
  getCachedConsentOpProof,
  clearCachedConsentOpProof,
  beginAuthorshipOrcidFreshAuth,
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
// The wire value is coerced before it leaves this callback, for the reason the
// twin in settings-fresh-auth.js is: the mint hands back `fresh_auth_proof`
// verbatim and FRESH_AUTH_REDIRECT_PENDING is `null`, the one member of the
// outcome vocabulary a JSON response can carry, so an uncoerced null proof
// reads as a redirect in flight at `withAuthorshipFreshAuth`'s outcome ladder
// and the op aborts silently for a navigation that never started. The
// truthiness half is there for `''`. The type half refuses no string at all,
// and a malformed non-empty one travels this same path to be refused at the
// backend instead; `''` is the one the consumers themselves drop. It clears the
// whole ladder and arrives at `run` as a proof to act on, where the call site's own `proof ? { freshAuthProof: proof } : {}`
// and `broadcastOps`'s `if (freshAuthProof)` each drop it again, so the
// broadcast leaves with no proof field at all, the backend's consume reads
// that as `missing`, and that reason is remintable: the gate mints again
// through this same callback, asking for the password a second time to obtain
// the same empty answer. Only the second refusal is terminal.
// FRESH_AUTH_MINT_FAILED is the honest answer for both halves: re-auth could
// not be completed, and re-prompting cannot mend a token the backend has
// declined to issue.
function mintViaPassword(target, assumed, guard) {
  return mintViaPasswordFactor(
    async (password) => {
      const proof = await mintAuthorshipFreshAuthProof(target, password);
      return typeof proof === 'string' && proof ? proof : FRESH_AUTH_MINT_FAILED;
    },
    { message: passwordPromptMessage(), assumed, guard },
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

// Start this surface's ORCID round-trip under the op's teardown guard. The
// start is itself an await a subject teardown can land in, so the starter
// re-checks `guard.tornDown` immediately before assigning window.location:
// stale starts unwind without navigating and resolve the shared clean-cancel
// sentinel, which this wrapper reports through
// `guard.cancel()` — once, here, for all three paths into the redirect (the
// passwordless branch, the assumed-password fallback, and the retry gate's
// hook), so no path can navigate the new subject's tab to ORCID for the
// subject that left, and none can drift on how the unwind reports. The flow
// keys the start wrote are the subject scrub's to remove, not this unwind's:
// the predicate reads true only after that scrub has run.
async function beginOrcidUnderGuard(target, guard) {
  const started = await beginAuthorshipOrcidFreshAuth(target, guard.tornDown);
  return started === FRESH_AUTH_CANCELLED ? guard.cancel() : started;
}

// Resolve a target-bound proof for a light account. A freshly-returned ORCID
// proof in the consent-op cache wins; otherwise the factor the shared resolver
// selects — the inline password prompt unless the account is KNOWN to be
// passwordless, in which case the ORCID round-trip. An ASSUMED password the
// backend 401s also falls back to the round-trip: navigating away from the
// paper page costs the user their place, but the alternative is an op that
// cannot complete at all.
async function resolveProof(target, guard) {
  const cached = getCachedProof(target);
  if (cached) return cached;
  const factor = await resolvePasswordFactor();
  // The status read is itself an await a teardown can land in, and the answer
  // decides between prompting and navigating. Acting on it after a subject
  // change would open a prompt, or fire a full-page ORCID round-trip, for the
  // subject that left. The shared mint's own guard cannot see this one: it is
  // only entered after this point.
  if (guard.tornDown()) return guard.cancel();
  if (!factor.usesPassword) return beginOrcidUnderGuard(target, guard);
  const minted = await mintViaPassword(target, factor.assumed, guard);
  if (minted === FRESH_AUTH_ORCID_FALLBACK) {
    return beginOrcidUnderGuard(target, guard);
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
 *   { cancelled: true }           user dismissed the password modal, or a subject
 *                                 teardown abandoned the op (already reported by
 *                                 the teardown itself); abort cleanly either way
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

  // Opened before the first await, so it covers the whole op: the status read,
  // the prompt, the mint, the broadcast, and the retry gate's re-mint. Every
  // one of those must belong to the subject this tab represented when the user
  // asked for the op.
  const guard = subjectTeardownGuard();
  const proof = await resolveProof(target, guard);
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
    // The FRESH_AUTH_REQUIRED fallout — the remintable re-mint+retry, the
    // ASSUMED-password ORCID fallback, the username_mismatch teardown, and the
    // terminal freshAuthFailed — lives in the shared retry gate
    // (`consentOpFreshAuthRetryGate`, fresh-auth.js); only this surface's
    // bindings differ. Errors that are not fresh-auth rethrow from the gate,
    // so the caller keeps its op-level handling.
    return consentOpFreshAuthRetryGate(err, {
      guard,
      resolveFactor: resolvePasswordFactor,
      mint: (assumed) => mintViaPassword(target, assumed, guard),
      beginOrcidRedirect: () => beginOrcidUnderGuard(target, guard),
      run,
      clearProofCache: clearCachedConsentOpProof,
    });
  }
}
