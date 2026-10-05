import Alpine from 'alpinejs';
import { waitForKeychain } from './keychain.js';
import { fetchAccreditationStatus } from './api.js';
import { signRequest } from './sign-request.js';
import {
  clearCachedSessionProof,
  clearCachedConsentOpProof,
  clearReturnPath,
  clearPasswordFactorMemo,
  abandonInFlightAcquisitions,
  dismissOpenReauthPrompt,
  handleSessionRevoked,
  sessionRevokedMessage,
  handleSessionExpired,
  sessionExpiredMessage,
} from './lib/fresh-auth.js';
// TAB_SUBJECT_KEY: the per-tab marker naming the JWT subject this tab's
// subject-bound sessionStorage state (fresh-auth proof caches, ORCID flow
// keys) belongs to. Lives in sessionStorage so it shares that state's
// lifetime: it survives reloads and the ORCID round-trip alongside the
// proofs, and a marker that disagrees with an incoming subject is exactly
// the signal that another subject's leftovers are still in this tab. Written
// by _adoptSubject, removed with the rest of the subject-bound keys by
// _scrubSubjectBoundState, which loops SUBJECT_BOUND_STORAGE_KEYS — the
// shared key-set truth (see subject-bound-keys.js).
import {
  SUBJECT_BOUND_STORAGE_KEYS,
  TAB_SUBJECT_KEY,
} from './lib/subject-bound-keys.js';

const SESSION_KEY = 'pevo_session';

// Whether a session's server-issued expiry is still ahead of the client clock.
// The one comparison both the restore and the pre-request check make, so a
// session a reload would refuse to restore is never sent either. A missing or
// unparseable expiry is never ahead of anything, so it reads as expired.
function isUnexpired(expiresAt) {
  return new Date(expiresAt) > new Date();
}

export function initAuth() {
  Alpine.store('auth', {
    username: null,
    isConnected: false,
    isKeychainInstalled: false,
    isLoading: true,
    isAccredited: false,
    accreditation: null,
    token: null,
    expiresAt: null,
    custody: null,

    _accreditationInterval: null,
    // Monotonically increasing; bumped on every _startAccreditationPolling()
    // call. An in-flight _checkAccreditation fetch captures the generation
    // it started in; if the value advances before the fetch resolves, the
    // continuation discards its result rather than clobbering whatever the
    // newer polling loop has since written to the store. _stopAccreditationPolling
    // cancels the setInterval but cannot abort an in-flight fetch, so a
    // rapid disconnect→login (or storage-event re-login as a different
    // user) without this guard lets the prior user's accreditation overwrite
    // the new user's session.
    _pollingGeneration: 0,

    init() {
      this._restoreSession();
      this.isLoading = false;

      waitForKeychain(3000).then((installed) => {
        this.isKeychainInstalled = installed;
      });

      this._startAccreditationPolling();

      // Sync login/logout across tabs
      this._boundStorageHandler = (e) => this._handleStorageEvent(e);
      window.addEventListener('storage', this._boundStorageHandler);

      // Clean up on page unload
      window.addEventListener('beforeunload', () => {
        this._stopAccreditationPolling();
        window.removeEventListener('storage', this._boundStorageHandler);
      });
    },

    // `notice` is passed through to the sign-in modal; see its `prompt`.
    async connect({ notice } = {}) {
      // Open sign-in modal — may resolve with username (Keychain path) or null (email path or cancel)
      const el = document.querySelector('[x-data="signInModal"]');
      const modal = el && Alpine.$data(el);
      if (!modal) throw new Error('Sign-in modal not found');
      const inputUsername = await modal.prompt({ notice });
      if (!inputUsername) return;

      const accreditationPromise = fetchAccreditationStatus(inputUsername).catch(() => null);

      const signed = await signRequest(inputUsername, 'POST', '/api/auth/session', {});
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: {
          ...signed.headers,
          'Content-Type': 'application/json',
        },
        body: signed.body,
      });

      if (res.ok) {
        const body = await res.json();
        const accRes = await accreditationPromise;
        this.loginFromResponse({
          token: body.data.token,
          expires_at: body.data.expires_at,
          username: inputUsername,
          custody: body.data.custody ?? 'self',
          is_accredited: accRes?.data?.is_accredited ?? false,
          accreditation: accRes?.data?.accreditation ?? null,
        });
      } else {
        throw new Error('Authentication failed');
      }
    },

    // Set auth state from a login/session/upgrade API response. Used by
    // every login-style call site (login, orcid callback, signup-verify
    // create + link, sign-in modal connect) and by the custody-upgrade
    // flow in settings.js.
    //
    // Field semantics:
    //
    // - `token` + `expires_at` rotate as an atomic pair. Both must be
    //   truthy for either to land on the store. The decoupled-guard form
    //   the upgrade flow used to ship allowed `{token: new, expires_at:
    //   undefined}` to persist a fresh token with stale expiry (UI thinks
    //   logged in, first API call returns 401) and the symmetric
    //   `{token: undefined, expires_at: new}` to wipe the live token.
    //   Atomic-pair enforcement closes both halves.
    //
    // - `username`, `is_accredited`, `accreditation` are preserve-on-
    //   undefined: the custody-upgrade sites pass `{token, expires_at,
    //   username, custody}` and omit only the accreditation pair, which a
    //   flow that changes neither must not clobber. Callers whose response
    //   shape omits `is_accredited` or
    //   `accreditation` (e.g., the bare password-login responses at
    //   `sign-in-modal.js#handleEmailLogin` and `signup.js#_resolveExistingAccount`)
    //   MUST pass explicit `false` / `null` overrides via spread, e.g.:
    //
    //     auth.loginFromResponse({ ...res.data, is_accredited: false, accreditation: null });
    //
    //   Otherwise the preserve-on-undefined branch keeps whatever the
    //   prior session wrote, leaking user-A's accreditation badge into
    //   user-B's session on cross-user re-login.
    //
    // - `custody` is preserve-on-undefined for the same reason: callers
    //   pass an explicit custody (login → 'light', upgrade → 'self',
    //   etc.); omitting it preserves the existing value.
    //
    // - Subject adoption: the response's subject is adopted via
    //   _adoptSubject BEFORE any field lands, so a login as a different
    //   user scrubs the previous subject's state instead of inheriting it
    //   while a same-subject re-login keeps its live fresh-auth window.
    //   Every live call site passes `username` explicitly; the fallback to
    //   the current username is defensive only, and no caller relies on it.
    //   The custody-upgrade sites go further and never reach this helper
    //   with a stale subject: they pin the account their upgrade started
    //   for and drop the landing outright when the live store has moved off
    //   it. Routing such a landing through adoption instead would file the
    //   intervening user's accreditation under the upgrade subject's
    //   username (both fields are omitted, so preserve-on-undefined keeps
    //   them), and after a sign-out it would write a full durable session
    //   for a user who just left.
    loginFromResponse(data) {
      const subject = data.username !== undefined ? data.username : this.username;
      if (subject) this._adoptSubject(subject);
      if (data.token && data.expires_at) {
        this.token = data.token;
        this.expiresAt = data.expires_at;
      }
      if (data.username !== undefined) this.username = data.username;
      if (data.is_accredited !== undefined) this.isAccredited = data.is_accredited;
      if (data.accreditation !== undefined) this.accreditation = data.accreditation;
      if (data.custody !== undefined) this.custody = data.custody;
      this.isConnected = true;
      this._saveSession();
      this._startAccreditationPolling();
    },

    // Optimistically reflect a locally-known accreditation metadata edit
    // (full name / institution / field). The edit is admin-signed and broadcast
    // on-chain by the backend (chain is SSoT); this merges the new values into
    // the stored accreditation so Settings, profile, and the accreditation page
    // update without a reload. Tenure (`accredited_since`) and method/orcid are
    // untouched by a metadata edit, so the spread preserves them.
    //
    // Returns true when the merge landed, false when there is no current
    // accreditation to merge into (the store was cleared mid fresh-auth
    // round-trip). The caller must not claim success on false: the on-chain edit
    // still landed, but the display can't reflect it.
    //
    // Bumps `_pollingGeneration` so any in-flight `_checkAccreditation` fetch —
    // which captured the prior generation and would otherwise resolve with
    // pre-edit data and revert this write via its own store assignment — drops
    // its result at the stale-fetch guard. We deliberately do NOT re-fetch here:
    // the HAF-indexed accreditation status lags the chain broadcast, so an
    // immediate re-fetch could itself return pre-edit metadata.
    applyAccreditationMetadata({ name, institution, field }) {
      if (!this.accreditation) return false;
      this.accreditation = { ...this.accreditation, name, institution, field };
      this._pollingGeneration += 1;
      this._saveSession();
      return true;
    },

    // A recovery of `data.username` revoked every earlier session of that
    // account and reissued `data.token`, the one session the server spares
    // (ARCHITECTURE.md § 6.7). Settle this browser on it as part of the
    // user's own action, so no later bearer request meets the revoked token
    // and tears the session down with the signed-out message. A session for
    // the same account ends through `disconnect` first, whose scrub drops
    // the tab state the recovery made stale: the session-proof window, and a
    // remembered password the recovery may have removed. A session for
    // another account is left signed in and the reissued one is not adopted.
    //
    // Returns true when the reissued session was adopted.
    adoptRecoveredSession(data) {
      if (this.username && this.username !== data.username) return false;
      if (this.username) this.disconnect();
      this.loginFromResponse({
        token: data.token,
        expires_at: data.expires_at,
        username: data.username,
        custody: data.custody ?? 'light',
        is_accredited: false,
        accreditation: null,
      });
      return true;
    },

    disconnect() {
      this.username = null;
      this.isConnected = false;
      this.isAccredited = false;
      this.accreditation = null;
      this.token = null;
      this.expiresAt = null;
      this.custody = null;
      this._stopAccreditationPolling();
      localStorage.removeItem(SESSION_KEY);
      this._scrubSubjectBoundState();
    },

    // A bearer request was answered `401 SESSION_INVALIDATED`: the server
    // revoked `sentToken` because the account's credentials changed on
    // another browser or device. The api.js bearer helper and the custody
    // broadcast in signer.js report here, so the revoked-session teardown has
    // one home. The key-upgrade request in pages/settings.js does not: it
    // sends a token pinned before its first await and reads its own 401s.
    //
    // The custody upgrade reissues a token, which reaches every tab of the
    // browser through the storage event, and a request sent just before that
    // with the old token can be answered after the new one is adopted. That
    // late rejection is why `_endSession` acts only on the token this store
    // still holds. The opposite ordering exists too: the server revokes the
    // old token a moment before it answers the upgrade, so a rejection can
    // arrive while this store still holds the old token. When the upgrading
    // tab has already saved the reissued session, this tab has simply not
    // processed the storage event yet, which is why `_endSession` reads the
    // stored session first and adopts a newer one instead of tearing down. A
    // rejection that lands before any tab has saved the reissued session still
    // tears this one down.
    //
    // Returns true when this call tore the session down.
    handleRevokedSession(sentToken) {
      return this._endSession(sentToken, handleSessionRevoked, sessionRevokedMessage);
    },

    // A bearer request is about to leave with `sentToken`, and the session has
    // reached its own expiry. The api.js bearer helper and the custody
    // broadcast in signer.js ask here before every send. Past `expiresAt` the
    // backend cannot verify the token and answers a bare 401 UNAUTHORIZED,
    // which the password-mint flows read as a wrong password and every other
    // caller reports as an unexplained failure. Ending the session here
    // instead says what happened, once, and the abandoned fresh-auth flows
    // unwind through their teardown guards, never as a rejected password.
    //
    // Clock skew is accepted, not corrected: `expiresAt` is the server's
    // timestamp and `isUnexpired` reads the client clock. A client clock that
    // runs fast ends the session early, which costs a sign-in and nothing
    // else. One that runs slow leaves a gap as long as the skew, in which the
    // server rejects the token first and the request still meets the bare
    // 401 this check exists to prevent.
    //
    // Returns true when the session has expired, in which case the caller must
    // not send. That holds even when a newer session another tab stored is
    // adopted instead of torn down: the request was built for the expired
    // token, and the adopted session may belong to a different account.
    endSessionIfExpired(sentToken) {
      if (isUnexpired(this.expiresAt)) return false;
      this._endSession(sentToken, handleSessionExpired, sessionExpiredMessage);
      return true;
    },

    // End the session `sentToken` belongs to, through `tearDown` (one of the
    // shared fresh-auth teardowns), then offer sign-in carrying `notice()`.
    // Shared by the revoked and expired sessions, so the two cannot drift on
    // the stale-token check or the adoption of a newer stored session.
    //
    // Acts only when `sentToken` is still the one this store holds. Tearing
    // down for a token the store has since replaced would remove the stored
    // session and sign every tab out of a session the server considers
    // valid. The same comparison makes a second report for the same token a
    // no-op, because the first one cleared it. A same-subject token swap does
    // not run the subject scrub, so a teardown guard cannot stand in for this
    // check.
    //
    // Reads the stored session before tearing down, and adopts it when it
    // carries a different live token: another tab has saved a newer session
    // and this tab has not processed the storage event yet. Tearing down
    // there would remove that newer session from storage and sign the other
    // tab out with it.
    //
    // The user did not sign out, so the teardown says why the session ended
    // and then offers sign-in where they are. Staying on the page matches the
    // header sign-out and the session-inconsistency teardown, and keeps what
    // a route change would destroy: a half-written review, attached files,
    // the key-upgrade retry state.
    //
    // Returns true when this call tore the session down.
    _endSession(sentToken, tearDown, notice) {
      if (!sentToken || sentToken !== this.token) return false;
      if (this._adoptStoredSessionOtherThan(sentToken)) return false;
      tearDown();
      this._offerSignIn(notice());
      return true;
    },

    // Take up the stored session when it carries a token other than
    // `rejectedToken`, exactly as the storage event for it would have. Returns
    // false, leaving the store untouched, when storage holds the rejected
    // token, nothing readable, or a session that has expired.
    _adoptStoredSessionOtherThan(rejectedToken) {
      let stored = null;
      try {
        stored = JSON.parse(localStorage.getItem(SESSION_KEY));
      } catch {
        /* unreadable entry: nothing to adopt */
      }
      if (!stored?.token || stored.token === rejectedToken) return false;
      this._restoreSession();
      if (this.token !== stored.token) return false;
      this._startAccreditationPolling();
      return true;
    },

    // Open the sign-in modal without a user gesture, carrying the reason
    // (`notice`): the teardown's message times out, and a user returning to a
    // background tab would otherwise find a bare sign-in prompt.
    // Fire-and-forget: the caller is an error path that must not wait on the
    // user, so a failed sign-in is reported here the way the header's Sign in
    // button reports it. Skipped when the modal is missing or already open,
    // since a second prompt() would orphan the first one's pending promise.
    _offerSignIn(notice) {
      const el = document.querySelector('[x-data="signInModal"]');
      const modal = el && Alpine.$data(el);
      if (!modal || modal.open) return;
      this.connect({ notice }).catch((err) => {
        console.warn('[auth] sign in after an ended session failed:', err);
        const msg = Alpine.store('i18n')?.messages?.common?.connectionFailed || 'Connection failed';
        Alpine.store('toast')?.show(msg, 'error');
      });
    },

    // THE central subject-change detection point: adopt `username` as the
    // subject this tab's state belongs to. Every path that (re)establishes
    // the JWT subject funnels through here — loginFromResponse for all
    // login-style call sites, _restoreSession for cold loads and the
    // cross-tab storage event — so a login as a different user runs the same
    // scrub as an explicit logout and no per-call-site scrub list can drift.
    //
    // Same-subject re-login is deliberately NOT a subject change: the live
    // fresh-auth window and proof caches belong to the same account, and
    // discarding them would cost the user a re-auth they do not owe. The
    // custody-upgrade call sites only ever reach here in that same-subject
    // case: they pin the account their upgrade started for, pass it as
    // `username`, and drop the landing without calling the helper at all
    // when the live store has moved to a different subject or to none.
    //
    // The marker read falls back to the in-memory username so the check
    // still works within a page load when sessionStorage is unavailable
    // (the fresh-auth window then lives in an in-memory mirror, which the
    // scrub clears).
    _adoptSubject(username) {
      let marker = null;
      try {
        marker = sessionStorage.getItem(TAB_SUBJECT_KEY);
      } catch {
        /* sessionStorage unavailable; fall back to the in-memory subject */
      }
      const previous = marker ?? this.username;
      if (previous && previous !== username) this._scrubSubjectBoundState();
      try {
        sessionStorage.setItem(TAB_SUBJECT_KEY, username);
      } catch {
        /* noop */
      }
    },

    // THE scrub for state bound to the JWT subject. Runs on explicit
    // logout (disconnect) and on any subject change detected by
    // _adoptSubject. Add any future subject-bound cache HERE, not at a call
    // site, so every teardown path picks it up — and add its sessionStorage
    // key to SUBJECT_BOUND_STORAGE_KEYS (subject-bound-keys.js), which this
    // scrub and the test-fixture mirror of it both loop, so the fixture
    // cannot drift from what the real scrub removes.
    _scrubSubjectBoundState() {
      // Scrub sessionStorage state bound to the JWT subject so cross-user
      // re-login on a shared browser cannot pick up a stale fresh-auth proof
      // or ORCID return-path mode. The session-kind proof is consumed by the
      // backend GETDEL on broadcast, but consent-op proofs and the return-path
      // pointer outlive the JWT subject without this scrub.
      clearCachedSessionProof();
      clearCachedConsentOpProof();
      clearReturnPath();
      // The password-factor memo is username-keyed, so cross-account
      // inheritance is already unreachable; dropping it here also retires a
      // stale positive for the SAME account after the one transition that can
      // remove a password (recover via ORCID with no new password, B → C in
      // ARCHITECTURE.md § 6.3). A same-subject re-login skips this scrub by
      // design (see `_adoptSubject`), so a stale positive that survives it is
      // retired at the mint route instead, by a second consecutive rejection
      // of the password (`mintViaPasswordFactor`).
      clearPasswordFactorMemo();
      // In-flight acquisition promises outlive the caches they feed: abandon
      // them so a late resolution cannot repopulate the slots just cleared,
      // nor hand its outcome to a caller arriving under the next subject.
      // Ordered AFTER the window clear above, in this one synchronous body,
      // and the fresh-auth consume and retry legs on the broadcast and upload
      // surfaces depend on that: once their guard reads torn-down they neither
      // evict nor slide the cached window, on the reasoning that this flight's
      // own window is already gone and whatever now sits in the slot is the
      // successor's. The store's own suite pins the order.
      abandonInFlightAcquisitions();
      // A re-auth prompt can be open when this runs, and nothing else closes
      // it: it would stay on screen and answerable for a subject this tab no
      // longer represents, holding the previous subject's typed password, with
      // its caller parked on the prompt promise indefinitely. Dismissing it
      // resolves that promise so the caller unwinds. Ordered after the
      // generation bump above so the resumed caller always observes the
      // teardown, rather than relying on the microtask ordering that makes the
      // two interchangeable today.
      dismissOpenReauthPrompt();
      // The shared key list is the storage-removal truth: the proof-cache
      // clears above already removed their own keys (plus module state the
      // list cannot carry), so for those this loop is an idempotent re-remove,
      // and for the ORCID flow keys and the tab-subject marker it is the
      // removal itself.
      try {
        for (const key of SUBJECT_BOUND_STORAGE_KEYS) sessionStorage.removeItem(key);
      } catch {
        /* sessionStorage unavailable (private mode); noop */
      }
    },

    getSessionToken() {
      return this.token;
    },

    _restoreSession() {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const { token, username, expiresAt, isAccredited, accreditation, custody } = JSON.parse(saved);
      if (token && username && isUnexpired(expiresAt)) {
        // The restored subject may differ from the one this tab's
        // sessionStorage state belongs to: a login as another user in a
        // different tab lands here via the storage event, and a reload after
        // such a login lands here with the previous subject's proofs still
        // in this tab. Adoption scrubs them; a same-subject restore (an
        // ordinary reload, the ORCID round-trip return) keeps the live
        // window.
        this._adoptSubject(username);
        this.token = token;
        this.username = username;
        this.isConnected = true;
        this.isAccredited = isAccredited ?? false;
        this.accreditation = accreditation ?? null;
        this.custody = custody ?? 'self';
        this.expiresAt = expiresAt;
        return;
      }
      localStorage.removeItem(SESSION_KEY);
    },

    _handleStorageEvent(e) {
      if (e.key !== SESSION_KEY) return;
      if (e.newValue) {
        this._restoreSession();
        this._startAccreditationPolling();
      } else {
        this.disconnect();
      }
    },

    _saveSession() {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        token: this.token, 
        username: this.username, 
        expiresAt: this.expiresAt, 
        isAccredited: this.isAccredited,
        accreditation: this.accreditation, 
        custody: this.custody,
      }));
    },

    async _checkAccreditation(gen) {
      // Skip if the session isn't fully connected yet. Prevents requests to
      // /api/accreditations/null during page teardown or before a login has
      // populated the store.
      if (!this.username || !this.isConnected) return;
      try {
        const accRes = await fetchAccreditationStatus(this.username);
        // Stale-fetch guard: a newer _startAccreditationPolling() has bumped
        // _pollingGeneration. The polling loop that owned this gen is gone;
        // its in-flight result must not clobber whatever the new loop has
        // written to the store. Every call site passes the current
        // generation (polling loop, settings ORCID-return init,
        // orcid-callback _handleAccredit).
        if (gen !== this._pollingGeneration) return;
        // disconnect() may have run while the fetch was in flight; drop the
        // stale result rather than re-persisting a cleared session.
        if (!this.username || !this.isConnected) return;
        if (accRes?.data) {
          this.isAccredited = accRes.data.is_accredited;
          this.accreditation = accRes.data.accreditation;
          this._saveSession();
        }
      } catch (err) {
        console.warn('[auth] accreditation check failed:', err);
      }
    },

    _startAccreditationPolling() {
      this._stopAccreditationPolling();
      const myGen = ++this._pollingGeneration;
      this._checkAccreditation(myGen);
      this._accreditationInterval = setInterval(() => {
        if (!this.username || this.isAccredited) {
          this._stopAccreditationPolling();
          return;
        }
        this._checkAccreditation(myGen);
      }, 60000);
    },

    _stopAccreditationPolling() {
      if (this._accreditationInterval) {
        clearInterval(this._accreditationInterval);
        this._accreditationInterval = null;
      }
    },
  });
}
