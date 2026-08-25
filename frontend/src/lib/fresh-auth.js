import Alpine from 'alpinejs';
import {
  startOrcid,
  consentOpRequestFields,
  fetchEmailStatus,
  mintSessionAuthProof,
} from '../api.js';
import { broadcastOps } from '../signer.js';

// In-tab cache of the session-kind fresh_auth_proof WINDOW. The proof is
// target-less, bound to the JWT subject, and multi-use: it authorizes the
// non-consent broadcast surface and the IPFS upload-token pre-flight
// repeatedly until the window closes. Two deadlines bound it and the window
// ends at whichever arrives first — a sliding idle deadline that every
// successful use pushes forward, and an absolute cap no activity extends. The
// slide is not observable on the wire (neither the broadcast nor the
// upload-token response echoes a refreshed deadline), so the idle period is
// learned from the issuance response and the slide is modelled client-side.
// Held in sessionStorage so the window survives the ORCID OAuth round-trip
// (publish page → orcid.org → /orcid/callback → return path) without
// leaking across tabs or persisting past tab close.
const PROOF_KEY = 'pevo_fresh_auth_session_proof';

// A window closing sooner than this reads as already spent to the
// acquire-before-commit gate. Re-authing deliberately ahead of a submit beats
// discovering the window closed after the user has attached a file and paid
// for an upload. The broadcast path itself demands no margin — any live
// window is worth attempting.
const WINDOW_PREFLIGHT_MARGIN_MS = 120_000;

// In-tab cache of a consent_op-kind fresh_auth_proof. Target-bound to the
// triple `(action, root_author, root_permlink)` and, for name-only-route
// credit ops, the additional per-op fields the backend binds: `author_index`
// (claim/approve) and `claimer` (approve/revoke). The broadcast consumer MUST
// match every bound field to consume; a proof minted for slot 2 cannot be
// reused for slot 3, nor an approve proof for co-author A reused against
// co-author B (the substitution `target_mismatch` the binding defends).
// Settings critical actions and anchored-route consent ops (author_accept /
// author_resign) leave `author_index` / `claimer` null, so they match on the
// triple alone. Single-slot by design: each ORCID fresh_auth round-trip mints
// state for one target, so a second flow overwrites the cached entry (matches
// the existing pevo_orcid_mode overwrite pattern). The token itself is a
// single-use bearer bound to the JWT subject with the same 5-minute TTL as
// session-kind proofs; backend invariant is identical (consumed atomically on
// broadcast attempt, gone post-attempt whether success or failure).
const CONSENT_OP_PROOF_KEY = 'pevo_fresh_auth_consent_op_proof';

// Stashed pre-redirect context so the callback handler can navigate the
// user back to the page they initiated the action on. Cleared by the
// callback handler after the proof lands.
const RETURN_PATH_KEY = 'pevo_fresh_auth_return_to';

// Sentinel for `broadcastWithFreshAuth` callers: when minting required a
// full-page redirect to ORCID, broadcast cannot complete in this tick.
// Returning null (rather than throwing) lets callers `if (res === null) return`
// and unwinds cleanly without a generic error toast firing during navigation.
export const FRESH_AUTH_REDIRECT_PENDING = null;

// Allowed ORCID OAuth redirect hosts. Validated before every `window.location`
// assignment to a backend-supplied `redirect_url` (open-redirect defense).
// Shared by EVERY ORCID redirect flow: the session-auth and settings-action
// mint flows below, and the page-level start flows (login, signup, recover,
// settings ORCID-link, accreditation), so every redirect-host check uses this
// one allowlist. Frozen so a consumer cannot mutate the shared policy
// (`.includes()` is unaffected by the freeze).
export const ORCID_REDIRECT_HOSTS = Object.freeze(['orcid.org', 'sandbox.orcid.org']);

// 401 consume-failure reasons that mean "the proof was absent or no longer
// usable" — re-mint and retry once. `wrong_mechanism` is excluded (re-minting
// the same factor would not fix it). Single source of truth shared by both
// fresh-auth orchestrators (settings + authorship consent ops) and the
// session-kind retry gate in broadcastWithFreshAuth below, so the three retry
// gates cannot drift on which 401 reasons are recoverable.
export const REMINTABLE_REASONS = Object.freeze(['missing', 'expired', 'malformed']);

// Shared password-factor outcome sentinels for the consent-op / settings
// fresh-auth orchestrators. Exported (not per-orchestrator locals) so the
// orchestrators compare against the SAME symbol mintViaPasswordFactor returns —
// a per-file Symbol would never be `===` to the helper's return.
//   FRESH_AUTH_CANCELLED  the user dismissed the re-auth modal (abort cleanly,
//                         no error toast).
//   FRESH_AUTH_MINT_FAILED  re-auth could not be completed (a second wrong
//                         password, or a transport error on the retry mint);
//                         the caller surfaces a generic re-auth failure rather
//                         than letting the mint failure escape as the op's own
//                         message.
export const FRESH_AUTH_CANCELLED = Symbol('fresh_auth_cancelled');
export const FRESH_AUTH_MINT_FAILED = Symbol('fresh_auth_mint_failed');

// Default re-auth modal prompt. Lib code cannot use the `$t` magic helper; read
// the i18n store directly with an English fallback. Called by every
// password-factor surface — the settings and authorship consent-op
// orchestrators and the session-window acquisition below — so the prompt copy
// cannot drift between them.
export function passwordPromptMessage() {
  return (
    Alpine.store('i18n')?.messages?.settings?.reauthPasswordPrompt ||
    'Enter your account password to confirm this action.'
  );
}

// Tear down a corrupted session on `username_mismatch`: the JWT subject and the
// proof subject diverge, which no re-auth can fix. Disconnect the session and
// surface the re-login toast. Shared by all three fresh-auth orchestrators
// (broadcastWithFreshAuth, withAuthorshipFreshAuth, withSettingsFreshAuth) so the
// teardown side-effects cannot drift between surfaces; each caller still returns
// its own surface-appropriate sentinel after calling this (the session-kind path
// returns FRESH_AUTH_REDIRECT_PENDING, the consent-op/settings paths return
// { sessionInconsistent: true }). `auth.disconnect()` is synchronous (auth.js —
// in-memory mutation + localStorage/sessionStorage removals, no awaited I/O), so
// teardown completes before the toast fires and there is no toast-vs-teardown
// race. Lib code cannot use `$t`; read the i18n store directly with an English
// fallback for the not-yet-loaded-bundle case.
export function handleSessionInconsistency() {
  Alpine.store('auth')?.disconnect();
  const msg =
    Alpine.store('i18n')?.messages?.auth?.sessionInconsistency ||
    'Session inconsistency detected. Please sign in again.';
  Alpine.store('toast')?.show(msg, 'error');
}

// Password-factor mint shared by the settings + authorship consent-op
// orchestrators. Prompt via the global reauth modal, then mint via the caller's
// `mintFn(password)` — the only part that differs between surfaces (the settings
// vs authorship target binding). A wrong password (401 UNAUTHORIZED at the mint
// route) re-prompts once. Returns:
//   - the proof string on success;
//   - FRESH_AUTH_CANCELLED if the modal was dismissed at either prompt;
//   - FRESH_AUTH_MINT_FAILED if re-auth is spent (a second wrong password, or any
//     transport error on the retry mint).
// A non-auth error on the FIRST attempt (transport, 503, VALIDATION_ERROR)
// propagates so the caller's op-level handler surfaces the real cause.
export async function mintViaPasswordFactor(mintFn, { message }) {
  const modal = Alpine.store('reauthModal');

  let password = await modal.request({ message });
  if (password === null || password === undefined) return FRESH_AUTH_CANCELLED;

  try {
    return await mintFn(password);
  } catch (err) {
    // A non-auth error on the first attempt (transport, 503) propagates as an
    // unexpected failure; only a wrong password (UNAUTHORIZED) re-prompts.
    if (err?.code !== 'UNAUTHORIZED') throw err;

    password = await modal.request({ message });
    if (password === null || password === undefined) return FRESH_AUTH_CANCELLED;
    try {
      return await mintFn(password);
    } catch {
      // Last re-prompt spent: a second auth failure, or any transport error on
      // the retry mint, means re-auth could not be completed. Surface the
      // generic re-auth failure rather than letting it escape as the op's own
      // message — the user has already been prompted twice.
      return FRESH_AUTH_MINT_FAILED;
    }
  }
}

// Read the cached window: the token, both deadlines, and the idle period
// learned at issuance. `minRemainingMs` is the caller's freshness demand — a
// window still open but closing sooner than that reads as a miss WITHOUT being
// cleared, so a proactive re-auth the user then cancels leaves the live window
// usable for the action they were already taking.
function readSessionWindow(minRemainingMs = 0) {
  try {
    const raw = sessionStorage.getItem(PROOF_KEY);
    if (!raw) return null;
    const { token, expiresAt, absoluteExpiresAt, idlePeriodMs } = JSON.parse(raw);
    if (!token || !expiresAt || !absoluteExpiresAt) {
      sessionStorage.removeItem(PROOF_KEY);
      return null;
    }
    // A malformed deadline yields NaN; `Date.now() >= NaN` is false, so a naive
    // comparison would treat the entry as never-expiring. Treat a non-finite
    // deadline or idle period as corruption: clear the slot so the consumer
    // re-auths rather than replaying an entry of unknown lifetime.
    const idleTs = new Date(expiresAt).getTime();
    const absoluteTs = new Date(absoluteExpiresAt).getTime();
    if (
      !Number.isFinite(idleTs) ||
      !Number.isFinite(absoluteTs) ||
      !Number.isFinite(idlePeriodMs)
    ) {
      sessionStorage.removeItem(PROOF_KEY);
      return null;
    }
    // The window ends at whichever deadline arrives first.
    const closesAt = Math.min(idleTs, absoluteTs);
    const now = Date.now();
    if (now >= closesAt) {
      sessionStorage.removeItem(PROOF_KEY);
      return null;
    }
    if (now + minRemainingMs >= closesAt) return null;
    return { token, absoluteTs, idlePeriodMs };
  } catch {
    return null;
  }
}

function getCachedSessionProof(minRemainingMs = 0) {
  return readSessionWindow(minRemainingMs)?.token ?? null;
}

// Cache a freshly issued window. `expiresAt` is the sliding idle deadline,
// `absoluteExpiresAt` the cap. The distance from now to the idle deadline IS
// the idle period, and this is the only place the client can learn it — the
// backend publishes no period field — so it is stored alongside the deadlines
// for later slides to replay.
export function cacheSessionProof(token, expiresAt, absoluteExpiresAt) {
  try {
    const idlePeriodMs = new Date(expiresAt).getTime() - Date.now();
    sessionStorage.setItem(
      PROOF_KEY,
      JSON.stringify({ token, expiresAt, absoluteExpiresAt, idlePeriodMs }),
    );
  } catch {
    // sessionStorage may be unavailable (private mode, quota); the window
    // simply won't be reused this session. Broadcast still proceeds on the
    // freshly-minted token via the in-memory return value.
  }
}

// Replay the server-side idle slide after a successful use. The backend pushes
// the idle deadline forward on every consume but echoes nothing back, so the
// client repeats the same arithmetic: now plus the idle period learned at
// issuance, never past the absolute cap. A miss (window already closed,
// storage unavailable) is a no-op — the next acquisition re-auths.
export function slideSessionWindow() {
  const entry = readSessionWindow();
  if (!entry) return;
  try {
    const slidTs = Math.min(Date.now() + entry.idlePeriodMs, entry.absoluteTs);
    sessionStorage.setItem(
      PROOF_KEY,
      JSON.stringify({
        token: entry.token,
        expiresAt: new Date(slidTs).toISOString(),
        absoluteExpiresAt: new Date(entry.absoluteTs).toISOString(),
        idlePeriodMs: entry.idlePeriodMs,
      }),
    );
  } catch {
    /* noop — the cached window keeps its previous deadline */
  }
}

export function clearCachedSessionProof() {
  try {
    sessionStorage.removeItem(PROOF_KEY);
  } catch {
    /* noop */
  }
}

// Cache a consent_op-kind proof along with its target binding: the
// `(action, root_author, root_permlink)` triple plus the optional credit-op
// fields `author_index` (claim/approve) and `claimer` (approve/revoke). Pass
// the values the backend ECHOED at issuance, not values reconstructed
// client-side, so the cache key cannot drift from the proof's actual binding.
// Anchored consent ops and settings actions omit the two optional fields;
// they normalize to null and the lookup matches on the triple alone. Returns
// void; failures (private mode, quota) are swallowed and the consumer simply
// won't find a cache hit on lookup — the freshly-minted token returned by the
// mint flow can still be passed to the broadcast in-memory.
export function cacheConsentOpProof(
  token, expiresAt, action, rootAuthor, rootPermlink, authorIndex, claimer,
) {
  try {
    sessionStorage.setItem(
      CONSENT_OP_PROOF_KEY,
      JSON.stringify({
        token,
        expiresAt,
        action,
        rootAuthor,
        rootPermlink,
        authorIndex: authorIndex ?? null,
        claimer: claimer ?? null,
      }),
    );
  } catch {
    /* same swallow as cacheSessionProof */
  }
}

// Look up a cached consent_op-kind proof. Strict match on every target field —
// the `(action, root_author, root_permlink)` triple plus `author_index` and
// `claimer` (each normalized to null when absent). Any mismatch returns null so
// the consumer mints a fresh proof bound to the intended slot/subject rather
// than replaying one minted for a different one. Also returns null and clears
// the slot on TTL expiry. A pre-extension cached entry (no author_index/claimer
// fields) reads them as undefined → null, so a triple-only lookup still hits.
export function getCachedConsentOpProof(
  action, rootAuthor, rootPermlink, authorIndex, claimer,
) {
  try {
    const raw = sessionStorage.getItem(CONSENT_OP_PROOF_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.token || !entry.expiresAt) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    // Malformed expiresAt yields NaN; `Date.now() >= NaN` is false. Treat
    // NaN as corruption — mirrors getCachedSessionProof.
    const ts = new Date(entry.expiresAt).getTime();
    if (!Number.isFinite(ts) || Date.now() >= ts) {
      sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
      return null;
    }
    if (
      entry.action !== action ||
      entry.rootAuthor !== rootAuthor ||
      entry.rootPermlink !== rootPermlink ||
      (entry.authorIndex ?? null) !== (authorIndex ?? null) ||
      (entry.claimer ?? null) !== (claimer ?? null)
    ) {
      return null;
    }
    return entry.token;
  } catch {
    return null;
  }
}

export function clearCachedConsentOpProof() {
  try {
    sessionStorage.removeItem(CONSENT_OP_PROOF_KEY);
  } catch {
    /* noop */
  }
}

export function getReturnPath() {
  try {
    return sessionStorage.getItem(RETURN_PATH_KEY);
  } catch {
    return null;
  }
}

export function clearReturnPath() {
  try {
    sessionStorage.removeItem(RETURN_PATH_KEY);
  } catch {
    /* noop */
  }
}

// Which factor opens a session window for this account. `hasPassword` from the
// account status is the discriminator: ONLY an explicit `false` routes to the
// ORCID round-trip. An unknown or failed status falls through to the password
// prompt and lets the backend reject a genuinely passwordless account — a
// transient status failure must not dead-end a valid password holder.
//
// A positive answer is memoized per username for the tab: an account that has
// a password cannot lose one, so re-fetching on every acquisition is pure
// latency. The negative answer is deliberately NOT memoized — a passwordless
// user who sets a password in settings must be able to use it on their next
// acquisition. The memo is keyed on the authenticated username so a re-login
// as a different account in the same tab cannot inherit it.
let _passwordFactorMemo = null;
async function accountHasPassword() {
  const username = Alpine.store('auth')?.username;
  if (username && _passwordFactorMemo === username) return true;
  try {
    const status = await fetchEmailStatus();
    const hasPassword = status?.data?.hasPassword;
    if (hasPassword === true && username) _passwordFactorMemo = username;
    return hasPassword;
  } catch {
    return undefined;
  }
}

// Start the ORCID round-trip that opens a session window. The only factor a
// passwordless account has, and a full-page navigation — callers must have
// nothing unsaved in flight when this fires (see `ensureSessionWindow`).
export async function beginSessionAuthOrcidRedirect() {
  return beginOrcidFreshAuthRedirect('session_auth', {}, '/');
}

// Acquire a session-kind window: reuse the cached one, or open a new one
// through the factor the account has registered. Password accounts mint inline
// at `POST /api/custody/session-auth` (a modal, no navigation); passwordless
// accounts take the ORCID round-trip.
//
// Returns the proof string, FRESH_AUTH_REDIRECT_PENDING when the ORCID factor
// started a full-page round-trip (the window lands in cache when the user
// returns via /orcid/callback), FRESH_AUTH_CANCELLED when the password modal
// was dismissed, or FRESH_AUTH_MINT_FAILED when re-auth could not be completed.
// Throws on transport / config errors.
//
// Concurrent callers — a submit and a vote button racing in the same tick, or a
// page batch and an inline editor image — are coalesced through the
// module-level `_acquireInFlight` promise, so only one password modal or one
// redirect is ever in flight. That coalescing is what lets the upload layer
// drop its own prompt-serialization gate: the singleton reauth modal is never
// asked twice concurrently.
let _acquireInFlight = null;
async function acquireSessionProof(minRemainingMs = 0) {
  const cached = getCachedSessionProof(minRemainingMs);
  if (cached) return cached;
  if (_acquireInFlight) return _acquireInFlight;

  _acquireInFlight = (async () => {
    const hasPassword = await accountHasPassword();
    if (hasPassword === false) return beginSessionAuthOrcidRedirect();
    return mintViaPasswordFactor(
      async (password) => {
        const issued = await mintSessionAuthProof(password);
        cacheSessionProof(
          issued.fresh_auth_proof,
          issued.expires_at,
          issued.absolute_expires_at,
        );
        return issued.fresh_auth_proof;
      },
      { message: passwordPromptMessage() },
    );
  })();

  try {
    return await _acquireInFlight;
  } finally {
    _acquireInFlight = null;
  }
}

// Acquire-before-commit gate (ARCHITECTURE.md § 6.4.1). Call this BEFORE
// starting work whose loss would cost the user — selecting a file, uploading to
// IPFS, entering a submit sequence — never after. The ORCID factor acquires by
// full-page navigation, so an acquisition that happens mid-flow throws away the
// attached file and any completed upload; acquiring first is what makes inline
// upload reachable for a passwordless account at all, and it is why neither the
// selected file nor the resulting CID needs to be persisted into a draft.
//
// By default a window closing sooner than the pre-flight margin reads as
// already spent, so a submit about to begin re-auths deliberately rather than
// discovering the window closed halfway through.
//
// Returns:
//   { ready: true, proof }            proceed; `proof` is the window token, or
//                                     null for self-custody (Keychain signs per
//                                     request and needs no window)
//   { ready: false, redirect: true }  ORCID round-trip in flight; abort cleanly
//   { ready: false, cancelled: true } the password modal was dismissed
//   { ready: false, failed: true }    re-auth could not be completed
export async function ensureSessionWindow({ minRemainingMs = WINDOW_PREFLIGHT_MARGIN_MS } = {}) {
  if (Alpine.store('auth')?.custody !== 'light') return { ready: true, proof: null };

  const proof = await acquireSessionProof(minRemainingMs);
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { ready: false, redirect: true };
  if (proof === FRESH_AUTH_CANCELLED) return { ready: false, cancelled: true };
  if (proof === FRESH_AUTH_MINT_FAILED) return { ready: false, failed: true };
  return { ready: true, proof };
}

// The one message a failed acquisition owes the user. Shown when re-auth could
// not be completed — a second wrong password, or a transport error on the retry
// mint — because the user was prompted twice and would otherwise watch the
// action do nothing at all. A dismissed modal says nothing: stopping was the
// user's own choice. Lib code cannot use `$t`; read the i18n store directly
// with an English fallback.
function showReauthFailedToast() {
  const msg =
    Alpine.store('i18n')?.messages?.settings?.reauthFailed ||
    'Re-authentication failed. Please try again.';
  Alpine.store('toast')?.show(msg, 'error');
}

// Page-level acquire-before-commit gate: acquire the window, surface the one
// outcome the user needs told about, and answer the only question the caller
// has — may I start this work? Pages call this before a file selection or a
// submit sequence so a passwordless account's full-page ORCID round-trip fires
// while there is nothing to lose. See `ensureSessionWindow` for the ordering
// rule and the outcome vocabulary.
export async function freshAuthWindowReady(opts) {
  const outcome = await ensureSessionWindow(opts);
  if (outcome.ready) return true;
  if (outcome.failed) showReauthFailedToast();
  return false;
}

// Generic ORCID fresh-auth redirect. Stashes the return path + per-tab mode
// marker, starts the OAuth round-trip with the caller's target `extra`, validates
// the redirect host against the shared allowlist, and navigates. Callers supply
// the OAuth `mode` ('session_auth' for the target-less broadcast/upload window,
// 'fresh_auth' for the target-bound consent-op and settings surfaces), the
// `extra` (the action plus any target fields the backend binds) and a default
// return path used only when `window.location.pathname` is empty. Returns
// FRESH_AUTH_REDIRECT_PENDING; throws on transport / config / invalid-host errors.
async function beginOrcidFreshAuthRedirect(mode, extra, returnPathDefault) {
  const returnPath = window.location.pathname || returnPathDefault;
  try {
    sessionStorage.setItem(RETURN_PATH_KEY, returnPath);
  } catch {
    /* return-path fallback handled in callback */
  }
  // Per-tab marker so the callback dispatches to the matching handler.
  // sessionStorage, not localStorage: localStorage is shared across tabs, so a
  // second tab in a different mode (e.g. 'link') would silently overwrite this
  // tab's marker and route the callback to the wrong handler. sessionStorage is
  // per-tab and survives the OAuth round-trip within the originating tab.
  sessionStorage.setItem('pevo_orcid_mode', mode);

  let data;
  try {
    data = await startOrcid(mode, extra);
  } catch (err) {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw err;
  }

  // Validate the redirect host before navigating — open-redirect defense
  // shared with settings.js handleOrcidLink. Uses the shared
  // ORCID_REDIRECT_HOSTS allowlist, not an inline literal, so no redirect flow
  // can drift from the others' host policy.
  let target;
  try {
    target = new URL(data.redirect_url);
  } catch {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw new Error('Invalid ORCID redirect URL');
  }
  if (!ORCID_REDIRECT_HOSTS.includes(target.hostname)) {
    sessionStorage.removeItem('pevo_orcid_mode');
    clearReturnPath();
    throw new Error('Invalid ORCID redirect URL');
  }

  window.location.href = data.redirect_url;
  return FRESH_AUTH_REDIRECT_PENDING;
}

// Initiate an ORCID fresh-auth round-trip for a settings critical action
// (`change_email`, `set_password`, `delete_account`). Sibling of
// `beginSessionAuthOrcidRedirect`, but for the consent-op-kind, target-bound
// settings surface rather than the session-kind window: the proof the backend
// mints binds to (action, <username>, ''), and the `/orcid/callback` handler
// caches it via `cacheConsentOpProof` keyed on the echoed target. The settings
// flow retrieves it post-redirect with `getCachedConsentOpProof(action,
// username, '')`.
//
// This is the only mint factor for `set_password` (a passwordless account has
// no password to base a password proof on) and the fallback factor for
// `change_email` / `delete_account` on passwordless accounts. The backend
// synthesizes the target from the authenticated username, so only `action` is
// sent. Returns `FRESH_AUTH_REDIRECT_PENDING` after starting the full-page
// redirect; callers abort cleanly and resume after the user returns. Throws on
// transport / config / invalid-redirect-host errors.
export async function beginSettingsActionOrcidFreshAuth(action) {
  return beginOrcidFreshAuthRedirect('fresh_auth', { action }, '/settings');
}

// Initiate an ORCID fresh-auth round-trip for an authorship consent/credit op.
// Sibling of beginSettingsActionOrcidFreshAuth, but the backend binds the proof
// to the paper target (and, for credit ops, the slot/subject), so the full
// target travels in the start `extra` via consentOpRequestFields. The
// `/orcid/callback` handler caches the echoed proof through cacheConsentOpProof
// keyed on that target; withAuthorshipFreshAuth retrieves it post-redirect.
export async function beginAuthorshipOrcidFreshAuth(target) {
  return beginOrcidFreshAuthRedirect('fresh_auth', consentOpRequestFields(target), '/');
}

// Map a non-string acquisition outcome onto the broadcast call-site contract.
// Every failure to acquire unwinds through the single FRESH_AUTH_REDIRECT_PENDING
// sentinel so the eight broadcast call sites keep their one clean-abort branch
// instead of growing per-outcome handling of their own.
function acquisitionAborted(proof) {
  if (typeof proof === 'string') return false;
  if (proof === FRESH_AUTH_MINT_FAILED) showReauthFailedToast();
  return true;
}

// High-level wrapper around `broadcastOps`: acquires a session window if one is
// not already open, attaches its proof to the broadcast, and handles the
// FRESH_AUTH_REQUIRED retry / re-login fallout per the custody contract.
//
// Returns the broadcast response on success, or `FRESH_AUTH_REDIRECT_PENDING`
// (null) whenever the window could not be put in hand — an ORCID round-trip in
// flight, a dismissed password modal, a spent re-auth, or a torn-down session.
// Callers treat the null return as "abort cleanly"; any user-facing message has
// already been shown here.
//
// The window is multi-use, so a broadcast that succeeds leaves it cached and
// merely slides its idle deadline. Acquisition is only reached on the first
// action of a window (or the first after one closes), which is what makes a
// burst of votes cost a single re-auth act.
//
// Keychain (self-custody) users skip acquisition entirely; their per-request
// signed canonical message is the fresh proof.
export async function broadcastWithFreshAuth(username, operations, opts = {}) {
  const auth = Alpine.store('auth');
  if (auth?.custody !== 'light') {
    return broadcastOps(username, operations, opts);
  }

  const proof = await acquireSessionProof();
  if (acquisitionAborted(proof)) return FRESH_AUTH_REDIRECT_PENDING;

  try {
    const res = await broadcastOps(username, operations, { ...opts, freshAuthProof: proof });
    // The backend slid the window's idle deadline on this consume but echoes
    // nothing back, so replay the slide locally; otherwise the cached window
    // would expire on its mint-time deadline while the server still honours it.
    slideSessionWindow();
    return res;
  } catch (err) {
    // Error shape `{ status, code, details }` is produced by signer.js#broadcastOps
    // (see frontend/src/signer.js — the non-2xx branch parses the JSON envelope
    // and rethrows). Keep this catch's branching aligned with the codes that
    // helper attaches; any new error code introduced upstream must be reflected
    // here.
    if (err?.code === 'FRESH_AUTH_REQUIRED') {
      // A 401 against a window proof means the window is genuinely closed — the
      // idle deadline or the absolute cap arrived, or a password reset or
      // account recovery ended every outstanding proof. That is not a spent
      // single-use token to be re-minted behind the user's back: drop the dead
      // window and put a real re-auth act in front of them.
      clearCachedSessionProof();

      if (
        err.status === 401 &&
        REMINTABLE_REASONS.includes(err.details?.reason)
      ) {
        // Normalize any error thrown by the re-acquisition or the retry
        // broadcastOps to the `{ status, code, details }` shape callers expect.
        // Without this wrap, a network failure during re-auth surfaces with
        // `TypeError: Failed to fetch` (or a startOrcid error envelope) instead
        // of the original FRESH_AUTH_REQUIRED context, so call-site
        // discriminators (publish.js, vote-buttons.js, vouch-section.js)
        // misclassify the failure and surface the wrong toast.
        try {
          const reacquired = await acquireSessionProof();
          if (acquisitionAborted(reacquired)) return FRESH_AUTH_REDIRECT_PENDING;
          const res = await broadcastOps(
            username, operations, { ...opts, freshAuthProof: reacquired },
          );
          slideSessionWindow();
          return res;
        } catch (retryErr) {
          // Preserve the shape if the retry's own error already follows the
          // contract (i.e., another FRESH_AUTH_REQUIRED or any signer.js-shaped
          // error). Otherwise wrap into a synthesized 0/UNKNOWN shape that
          // callers can still inspect without crashing on `.details`.
          if (retryErr && typeof retryErr.status === 'number' && retryErr.code) {
            throw retryErr;
          }
          const wrapped = new Error(retryErr?.message || 'fresh-auth retry failed');
          wrapped.status = 0;
          wrapped.code = 'FRESH_AUTH_RETRY_FAILED';
          wrapped.details = { cause: retryErr?.message || String(retryErr) };
          throw wrapped;
        }
      }

      // 403 username_mismatch → JWT subject and proof subject diverge.
      // Critical session inconsistency; force re-login via the shared teardown
      // (disconnect + re-login toast). The session-kind error carries `status`
      // (signer.js#broadcastOps shapes it), so this surface gates on the 403,
      // unlike the consent-op/settings paths whose api.js errors omit `status`.
      if (err.status === 403 && err.details?.reason === 'username_mismatch') {
        handleSessionInconsistency();
        return FRESH_AUTH_REDIRECT_PENDING;
      }

      // 403 kind_mismatch on the non-consent surface is structurally
      // impossible (this surface accepts both kinds). Treat as a wire-contract
      // regression and log for diagnostics; surface as a generic error.
      if (err.status === 403 && err.details?.reason === 'kind_mismatch') {
        console.warn('[fresh-auth] unexpected kind_mismatch on non-consent broadcast', err);
      }
    }
    throw err;
  }
}
