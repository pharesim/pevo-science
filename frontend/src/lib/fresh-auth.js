import Alpine from 'alpinejs';
import {
  startOrcid,
  consentOpRequestFields,
  fetchEmailStatus,
  mintSessionAuthProof,
} from '../api.js';
import { broadcastOps } from '../signer.js';
import { REAUTH_PROMPT_BUSY } from '../components/reauth-modal.js';

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
//   FRESH_AUTH_PROMPT_BUSY  a re-auth prompt for a DIFFERENT action is already
//                         open, so this one was refused before the user ever
//                         saw it (distinct from CANCELLED, which is the user's
//                         own decision to stop).
//   FRESH_AUTH_REAUTH_REQUIRED  a window was needed and none was open, but the
//                         account's only factor is a full-page ORCID
//                         round-trip and the caller asked for acquisition
//                         without navigation (see `allowRedirect`).
//   FRESH_AUTH_ORCID_FALLBACK  the password factor was ASSUMED (the account
//                         status was unavailable) and the backend rejected the
//                         mint: the account most likely has no password, so
//                         the caller hands the action to its own ORCID factor
//                         instead of demanding a second password that may not
//                         exist.
export const FRESH_AUTH_CANCELLED = Symbol('fresh_auth_cancelled');
export const FRESH_AUTH_MINT_FAILED = Symbol('fresh_auth_mint_failed');
export const FRESH_AUTH_PROMPT_BUSY = Symbol('fresh_auth_prompt_busy');
export const FRESH_AUTH_REAUTH_REQUIRED = Symbol('fresh_auth_reauth_required');
export const FRESH_AUTH_ORCID_FALLBACK = Symbol('fresh_auth_orcid_fallback');

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
//     transport error on the retry mint);
//   - FRESH_AUTH_PROMPT_BUSY if another action's prompt already owns the modal;
//   - FRESH_AUTH_ORCID_FALLBACK if the password factor was ASSUMED
//     (`opts.assumed`) and the mint 401'd — see below.
// A non-auth error on the FIRST attempt (transport, 503, VALIDATION_ERROR)
// propagates so the caller's op-level handler surfaces the real cause.
export async function mintViaPasswordFactor(mintFn, { message, assumed = false }) {
  const modal = Alpine.store('reauthModal');

  let password = await modal.request({ message });
  if (password === REAUTH_PROMPT_BUSY) return FRESH_AUTH_PROMPT_BUSY;
  if (password === null || password === undefined) return FRESH_AUTH_CANCELLED;

  try {
    return await mintFn(password);
  } catch (err) {
    // A non-auth error on the first attempt (transport, 503) propagates as an
    // unexpected failure; only a wrong password (UNAUTHORIZED) re-prompts.
    if (err?.code !== 'UNAUTHORIZED') throw err;

    // When the password factor was ASSUMED rather than observed — the account
    // status was unavailable and the unknown fell through to the prompt — a
    // 401 here is at least as likely "no password registered" as a typo. A
    // second prompt would dead-end a genuinely passwordless account (there is
    // no password to get right, and the mint route burns a sentinel hash to
    // keep the two cases indistinguishable), so hand the caller back to its
    // ORCID factor instead. An account that really has a password only lands
    // here by mistyping while the status read is down, and its ORCID factor
    // completes the action too.
    if (assumed) return FRESH_AUTH_ORCID_FALLBACK;

    password = await modal.request({ message });
    if (password === REAUTH_PROMPT_BUSY) return FRESH_AUTH_PROMPT_BUSY;
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

// The session-window periods the backend publishes in
// `agents/docs/api-contracts/custody.md`, mirrored client-side: a 15-minute
// sliding idle deadline and a 2-hour absolute cap.
// A freshly issued window always spans the full period, so at issuance the
// distance the client measures to the server's deadline is that period minus
// clock skew and round-trip latency — the deadlines carry no duration the
// client does not already know. Both clocks tick at the same rate, so the
// window really does last one full period of wall time from issuance no matter
// how far apart the two clocks are set.
const SESSION_IDLE_PERIOD_MS = 900_000;
const SESSION_ABSOLUTE_PERIOD_MS = 7_200_000;

// Reconcile one server deadline against the client clock at issuance. The
// measured span is trusted only inside a plausible band around the mirrored
// period:
//   - longer than the period means the client clock trails the server's. The
//     window is not really longer, and believing it is buys a mid-flow 401
//     exactly where the pre-flight margin exists to prevent one.
//   - shorter than half the period is skew, not a shorter backend period.
//     Honouring it spends the window on prompts the user does not owe, and a
//     span under the pre-flight margin makes every acquisition read as
//     instantly stale — which for a passwordless account is an ORCID redirect
//     loop, since the round-trip caches a window the next gate rejects.
// A genuine backend period change inside the band is still honoured, so the
// client tracks the server rather than hardcoding it outright.
function anchoredSpan(deadline, periodMs) {
  const measured = new Date(deadline).getTime() - Date.now();
  if (!Number.isFinite(measured)) return NaN;
  if (measured > periodMs || measured < periodMs / 2) return periodMs;
  return measured;
}

// In-memory fallback copy of the window, written ONLY when the sessionStorage
// write failed (private mode, quota, storage blocked). Without it a failed
// write leaves the acquire-before-commit gate reporting a window that nothing
// recorded, so a single publish pays for three acquisitions and a passwordless
// account's submit gate can never be satisfied. A successful write clears it,
// so storage stays the single source of truth whenever storage works at all.
let _memoryWindow = null;

function persistWindow(entry) {
  try {
    sessionStorage.setItem(PROOF_KEY, JSON.stringify(entry));
    _memoryWindow = null;
  } catch {
    // The window still covers the rest of this page load through the mirror;
    // only surviving the ORCID round-trip (a full page load) needs storage.
    //
    // Drop any older stored entry before installing the mirror. A failed
    // write can leave a stale window readable (quota hit after an earlier
    // successful write), and the read consults storage before the mirror, so
    // without the removal the stale copy would shadow the fresher one. With
    // it, a non-empty storage read always implies a current entry by
    // construction.
    dropWindow();
    _memoryWindow = entry;
  }
}

function dropWindow() {
  _memoryWindow = null;
  try {
    sessionStorage.removeItem(PROOF_KEY);
  } catch {
    /* noop */
  }
}

// The raw cached entry, from storage when storage holds one and from the
// in-memory mirror when the read comes back empty or unreadable.
function storedWindow() {
  let raw;
  try {
    raw = sessionStorage.getItem(PROOF_KEY);
  } catch {
    return _memoryWindow;
  }
  if (raw === null || raw === undefined) return _memoryWindow;
  try {
    return JSON.parse(raw);
  } catch {
    dropWindow();
    return null;
  }
}

// Read the cached window: the token, both deadlines, and the idle period
// learned at issuance. `minRemainingMs` is the caller's freshness demand — a
// window still open but closing sooner than that reads as a miss WITHOUT being
// cleared, so a proactive re-auth the user then cancels leaves the live window
// usable for the action they were already taking.
//
// Every deadline in the entry is client-anchored (see `cacheSessionProof`), so
// comparing it to `Date.now()` is comparing two readings of the same clock.
function readSessionWindow(minRemainingMs = 0) {
  const entry = storedWindow();
  if (!entry) return null;
  const { token, expiresAt, absoluteExpiresAt, idlePeriodMs } = entry;
  if (!token || !expiresAt || !absoluteExpiresAt) {
    dropWindow();
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
    dropWindow();
    return null;
  }
  // The window ends at whichever deadline arrives first.
  const closesAt = Math.min(idleTs, absoluteTs);
  const now = Date.now();
  if (now >= closesAt) {
    dropWindow();
    return null;
  }
  if (now + minRemainingMs >= closesAt) return null;
  return { token, absoluteTs, idlePeriodMs };
}

function getCachedSessionProof(minRemainingMs = 0) {
  return readSessionWindow(minRemainingMs)?.token ?? null;
}

// Cache a freshly issued window. `expiresAt` is the server's sliding idle
// deadline and `absoluteExpiresAt` its cap; both are re-anchored to the client
// clock through `anchoredSpan` before being stored, so every later liveness
// check compares two readings of one clock and the server-vs-client offset
// drops out of the arithmetic entirely. The anchored idle span IS the idle
// period, and this is the only place the client can learn it — the backend
// publishes no period field — so it is stored alongside the deadlines for
// later slides to replay.
export function cacheSessionProof(token, expiresAt, absoluteExpiresAt) {
  const now = Date.now();
  const idlePeriodMs = anchoredSpan(expiresAt, SESSION_IDLE_PERIOD_MS);
  const absoluteSpanMs = anchoredSpan(absoluteExpiresAt, SESSION_ABSOLUTE_PERIOD_MS);
  // An unparseable deadline anchors to NaN, and `new Date(now + NaN)` throws a
  // RangeError at toISOString — from a cache write no caller expects to
  // reject. Fail closed instead, matching every other corrupt-entry case in
  // this module: drop the slot and let the next consumer re-auth.
  if (!Number.isFinite(idlePeriodMs) || !Number.isFinite(absoluteSpanMs)) {
    dropWindow();
    return;
  }
  persistWindow({
    token,
    expiresAt: new Date(now + idlePeriodMs).toISOString(),
    absoluteExpiresAt: new Date(now + absoluteSpanMs).toISOString(),
    idlePeriodMs,
  });
}

// Replay the server-side idle slide after a successful use. The backend pushes
// the idle deadline forward on every consume but echoes nothing back, so the
// client repeats the same arithmetic: now plus the idle period learned at
// issuance, never past the absolute cap. A miss (window already closed) is a
// no-op — the next acquisition re-auths. Every consume site owes this call;
// skipping one lets the client fall behind the server and evict a token the
// server would still honour.
export function slideSessionWindow() {
  const entry = readSessionWindow();
  if (!entry) return;
  const slidTs = Math.min(Date.now() + entry.idlePeriodMs, entry.absoluteTs);
  persistWindow({
    token: entry.token,
    expiresAt: new Date(slidTs).toISOString(),
    absoluteExpiresAt: new Date(entry.absoluteTs).toISOString(),
    idlePeriodMs: entry.idlePeriodMs,
  });
}

export function clearCachedSessionProof() {
  dropWindow();
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

// THE re-auth factor resolver. Every surface that has to choose between the
// inline password prompt and the navigating ORCID round-trip calls this one
// function, so the factor a user is offered cannot depend on which page they
// happen to be on.
//
// `hasPassword` from the account status is the discriminator, and the failure
// direction is folded in here on purpose: ONLY an explicit `false` routes to
// ORCID. An unknown, absent, or failed status resolves to the password prompt
// and lets the backend reject a genuinely passwordless account. That asymmetry
// is the whole point. The ORCID factor is a full-page navigation that discards
// page state, so a transient status failure must never be the thing that fires
// it at someone who could have typed a password instead.
//
// The answer is `{ usesPassword, assumed }`: `usesPassword` picks the factor,
// and `assumed` records whether that pick was observed from the account status
// or guessed because the status was unavailable. The distinction matters at
// exactly one point — a 401 at a password mint. Against an observed password
// that is a typo and earns a re-prompt; against an assumed one it is at least
// as likely "no password registered", and a second prompt would dead-end an
// account whose only registered factor is ORCID. `mintViaPasswordFactor`
// consumes the flag and hands such callers back to their ORCID factor.
//
// A positive answer is memoized per username for the tab: an account that has
// a password cannot lose one without a navigation that resets module state, so
// re-fetching on every acquisition is pure latency. The negative and assumed
// answers are deliberately NOT memoized — a passwordless user who sets a
// password in settings must be able to use it on their next acquisition, and
// a guess must never harden into a fact. The memo is keyed on the
// authenticated username so a re-login as a different account in the same tab
// cannot inherit it, and `auth.disconnect()` drops it outright alongside the
// proof caches.
let _passwordFactorMemo = null;
// Pairs the memo with `clearPasswordFactorMemo()`: a clear landing while a
// status fetch is in flight must not be undone by that fetch resolving
// afterwards, so the writer captures the generation before its await and
// declines the write when a clear happened in between.
let _passwordFactorMemoGeneration = 0;
// Concurrent resolutions coalesce onto one status request. The resolver has
// direct callers on several surfaces (session acquisition, both consent-op
// orchestrators, and their retry gates), and two racing callers must not each
// spend the rate-limited status budget — nor land on different factors when
// one request succeeds and its sibling transiently fails. Mirrors the
// in-flight pattern of `_acquireInFlight` below.
let _factorResolutionInFlight = null;

export function clearPasswordFactorMemo() {
  _passwordFactorMemo = null;
  _passwordFactorMemoGeneration += 1;
}

export async function resolvePasswordFactor() {
  const username = Alpine.store('auth')?.username;
  if (username && _passwordFactorMemo === username) {
    return { usesPassword: true, assumed: false };
  }
  if (_factorResolutionInFlight) return _factorResolutionInFlight;

  const flight = (async () => {
    const generation = _passwordFactorMemoGeneration;
    let hasPassword;
    try {
      hasPassword = (await fetchEmailStatus())?.data?.hasPassword;
    } catch {
      hasPassword = undefined;
    }
    if (
      hasPassword === true &&
      username &&
      generation === _passwordFactorMemoGeneration
    ) {
      _passwordFactorMemo = username;
    }
    return {
      usesPassword: hasPassword !== false,
      assumed: hasPassword !== true && hasPassword !== false,
    };
  })();

  _factorResolutionInFlight = flight;
  try {
    return await flight;
  } finally {
    // A teardown (abandonInFlightAcquisitions) may have cleared the slot and
    // a newer resolution may own it by now; only the flight that installed
    // itself may clear it.
    if (_factorResolutionInFlight === flight) _factorResolutionInFlight = null;
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
// was dismissed, FRESH_AUTH_MINT_FAILED when re-auth could not be completed, or
// FRESH_AUTH_PROMPT_BUSY when another action already owns the modal.
// Throws on transport / config errors.
//
// `allowRedirect: false` suppresses the navigating factor: callers already
// holding something the user would lose (a picked image, a batch of completed
// pins) get FRESH_AUTH_REAUTH_REQUIRED instead of a full-page ORCID round-trip
// fired out from under them. Only the passwordless branch is suppressed — the
// password factor's modal is inline and costs nothing to show mid-flow.
//
// Concurrent callers — a submit and a vote button racing in the same tick, or a
// page batch and an inline editor image — are coalesced through the
// module-level `_acquireInFlight` promises, so only one password modal or one
// redirect is ever in flight per posture. That coalescing is what lets the
// upload layer drop its own prompt-serialization gate: the singleton reauth
// modal is never asked twice concurrently by callers sharing a posture.
//
// The slot is keyed on the redirect policy: a caller only joins an
// acquisition that shares its `allowRedirect` posture. Joined promises hand
// the joiner the FIRST caller's outcome, and the two postures resolve the
// passwordless branch oppositely — suppressed refuses where permissive
// navigates — so a submit entitled to navigate must never inherit the
// refusal of an inline-image acquisition it happened to race, nor the other
// way round. Cross-posture collisions on the password factor surface as the
// modal's own busy sentinel, which callers already handle.
const _acquireInFlight = { permissive: null, suppressed: null };

// Pairs the in-flight acquisition state with `abandonInFlightAcquisitions()`:
// a flight captures the generation before its awaits and, when a teardown
// intervened, declines to cache, deliver, or navigate for a subject this tab
// no longer represents. Mirrors the `_passwordFactorMemoGeneration` pattern
// above.
let _acquireGeneration = 0;

// Abandon the module-level in-flight state when the tab's subject-bound
// session state is torn down (explicit logout, or a login that changes the
// JWT subject). Called by the auth store's subject scrub alongside the cache
// clears; this function owns only the in-flight promises and their
// generation, while the caches and the password-factor memo keep their own
// exported clears next to it in that scrub. Two hazards this closes:
//   - a caller arriving AFTER the teardown must not join a flight started
//     for the previous subject and inherit its outcome;
//   - an acquisition still pending at teardown must not repopulate the
//     just-scrubbed window cache when its mint resolves late (the mint
//     function writes `cacheSessionProof` on resolve) nor hand its proof to
//     anyone; the generation bump makes such a flight resolve as a clean
//     cancel instead.
export function abandonInFlightAcquisitions() {
  _acquireGeneration += 1;
  _acquireInFlight.permissive = null;
  _acquireInFlight.suppressed = null;
  _factorResolutionInFlight = null;
}

async function acquireSessionProof(minRemainingMs = 0, { allowRedirect = true } = {}) {
  const cached = getCachedSessionProof(minRemainingMs);
  if (cached) return cached;
  const slot = allowRedirect ? 'permissive' : 'suppressed';
  if (_acquireInFlight[slot]) return _acquireInFlight[slot];

  // Captured before any await: a teardown bumping the generation mid-flight
  // turns every later step into a clean cancel (see
  // abandonInFlightAcquisitions).
  const generation = _acquireGeneration;
  const flight = (async () => {
    // The navigation policy for the passwordless outcome, applied in one
    // place: the known-passwordless branch and the assumed-password fallback
    // below share it, so the two cannot diverge on when a redirect may fire.
    const orcidOrRefuse = () =>
      allowRedirect ? beginSessionAuthOrcidRedirect() : FRESH_AUTH_REAUTH_REQUIRED;

    const factor = await resolvePasswordFactor();
    if (generation !== _acquireGeneration) return FRESH_AUTH_CANCELLED;
    if (!factor.usesPassword) return orcidOrRefuse();

    const minted = await mintViaPasswordFactor(
      async (password) => {
        // The prompt can sit open across a teardown; do not spend a mint on
        // a subject this tab no longer represents.
        if (generation !== _acquireGeneration) return FRESH_AUTH_CANCELLED;
        const issued = await mintSessionAuthProof(password);
        // A teardown while the mint round-trip was pending: the scrub has
        // already emptied the window slot, and this write would repopulate
        // it under the wrong subject. Drop the issuance and unwind.
        if (generation !== _acquireGeneration) return FRESH_AUTH_CANCELLED;
        cacheSessionProof(
          issued.fresh_auth_proof,
          issued.expires_at,
          issued.absolute_expires_at,
        );
        return issued.fresh_auth_proof;
      },
      { message: passwordPromptMessage(), assumed: factor.assumed },
    );
    if (generation !== _acquireGeneration) return FRESH_AUTH_CANCELLED;
    // The assumed factor turned out to be the wrong guess: the account has no
    // password to prompt for, so the ORCID round-trip is the way through.
    if (minted === FRESH_AUTH_ORCID_FALLBACK) return orcidOrRefuse();
    return minted;
  })();

  _acquireInFlight[slot] = flight;
  try {
    return await flight;
  } finally {
    // A teardown may have cleared the slot and a newer flight may have
    // claimed it since; only the flight that installed itself may clear it.
    if (_acquireInFlight[slot] === flight) _acquireInFlight[slot] = null;
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
//   { ready: false, busy: true }      another action's prompt owns the modal
//   { ready: false, reauthRequired: true }  no window is open and the only
//                                     factor navigates, but the caller asked
//                                     for a non-navigating acquisition
//
// Throws on transport / config errors, so callers that have nothing to unwind
// go through `freshAuthWindowReady` instead, which cannot reject.
export async function ensureSessionWindow({
  minRemainingMs = WINDOW_PREFLIGHT_MARGIN_MS,
  allowRedirect = true,
} = {}) {
  if (Alpine.store('auth')?.custody !== 'light') return { ready: true, proof: null };

  const proof = await acquireSessionProof(minRemainingMs, { allowRedirect });
  if (proof === FRESH_AUTH_REDIRECT_PENDING) return { ready: false, redirect: true };
  if (proof === FRESH_AUTH_CANCELLED) return { ready: false, cancelled: true };
  if (proof === FRESH_AUTH_MINT_FAILED) return { ready: false, failed: true };
  if (proof === FRESH_AUTH_PROMPT_BUSY) return { ready: false, busy: true };
  if (proof === FRESH_AUTH_REAUTH_REQUIRED) return { ready: false, reauthRequired: true };
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

// The message a refused-while-open acquisition owes the user. The action was
// dropped before the user saw a prompt for it, so saying nothing would look
// like the button did nothing at all. Reaches the consent-op and settings
// orchestrators through `promptBusy` below, and the session path through the
// gate and broadcast unwinders, so the collision reads the same everywhere.
function showPromptBusyToast() {
  const msg =
    Alpine.store('i18n')?.messages?.common?.reauthPromptOpen ||
    'Finish the confirmation already open, then try again.';
  Alpine.store('toast')?.show(msg, 'error');
}

// The message a suppressed acquisition owes the user when no window is open
// and the account's only factor navigates. The work was refused before
// anything was lost — that is the point of suppressing — but a refusal that
// says nothing reads as a dead button, so tell the user the way through:
// re-authenticate, then try again.
function showReauthRequiredToast() {
  const msg =
    Alpine.store('i18n')?.messages?.common?.reauthRequired ||
    'Please confirm your identity again, then try once more.';
  Alpine.store('toast')?.show(msg, 'error');
}

// The refuse-while-open outcome as the orchestrators' callers see it: toast
// the way out, then unwind through the existing clean-abort outcome so call
// sites need no new branch — the message is the whole difference from a
// cancel. Shared by the settings and authorship orchestrators (both gates
// each) so the collision cannot read differently between surfaces.
export function promptBusy() {
  showPromptBusyToast();
  return { cancelled: true };
}

// Page-level acquire-before-commit gate: acquire the window, surface the one
// outcome the user needs told about, and answer the only question the caller
// has — may I start this work? Pages call this before a file selection or a
// submit sequence so a passwordless account's full-page ORCID round-trip fires
// while there is nothing to lose. See `ensureSessionWindow` for the ordering
// rule and the outcome vocabulary.
export async function freshAuthWindowReady(opts) {
  let outcome;
  try {
    outcome = await ensureSessionWindow(opts);
  } catch (err) {
    // A gate that rejects is worse than the path it front-runs: it sits ahead
    // of the caller's own try, so the rejection escapes, the step machine never
    // leaves idle, and the user re-clicks a dead-looking button forever. Every
    // acquisition failure the user can act on is a re-auth failure, so say so
    // and refuse the work.
    console.warn('[fresh-auth] window acquisition failed', err);
    showReauthFailedToast();
    return false;
  }
  if (outcome.ready) return true;
  if (outcome.failed) showReauthFailedToast();
  if (outcome.busy) showPromptBusyToast();
  if (outcome.reauthRequired) showReauthRequiredToast();
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
  if (proof === FRESH_AUTH_PROMPT_BUSY) showPromptBusyToast();
  // Defensive: the broadcast path always acquires permissively, and the
  // posture-keyed in-flight slots keep it from inheriting a suppressed
  // acquisition's refusal — but an outcome added to the vocabulary must not
  // be silently swallowed here if a future caller ever threads it through.
  if (proof === FRESH_AUTH_REAUTH_REQUIRED) showReauthRequiredToast();
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

  // One consume of the window: broadcast, then replay the idle slide the
  // backend performed but echoed nothing about. Both the first attempt and the
  // 401 retry go through here so "consume without sliding" — the bug class that
  // lets the client fall behind the server and evict a live token — cannot be
  // reintroduced by editing one branch and not the other.
  const attemptOnce = async (windowProof) => {
    const res = await broadcastOps(username, operations, { ...opts, freshAuthProof: windowProof });
    slideSessionWindow();
    return res;
  };

  const proof = await acquireSessionProof();
  if (acquisitionAborted(proof)) return FRESH_AUTH_REDIRECT_PENDING;

  try {
    return await attemptOnce(proof);
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
          return await attemptOnce(reacquired);
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
