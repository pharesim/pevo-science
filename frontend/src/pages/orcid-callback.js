import Alpine from 'alpinejs';
import { completeOrcid } from '../api.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import {
  cacheSessionProof,
  cacheConsentOpProof,
  getReturnPath,
  clearReturnPath,
} from '../lib/fresh-auth.js';

// Fallback for the ORCID minimum-works threshold shown in the insufficient-works
// copy when the backend's 422 carries no `details.required`. Mirrors the backend
// default for `ORCID_MIN_WORKS` documented in api-contracts/orcid.md. Once the
// backend emits `details: { required, have }` on the insufficient-works 422, the
// real value reaches the user and this fallback is never hit; it only covers the
// transitional window before that lands, so the threshold lives in one place
// here rather than baked into all 16 locale strings.
const ORCID_MIN_WORKS_FALLBACK = 3;

const template = `
      <div x-data="orcidCallbackPage" class="container-narrow py-8">
        <div class="max-w-md mx-auto text-center py-16">
          <!-- Verifying -->
          <div x-show="status === 'verifying'">
            <div class="animate-pulse text-ink-muted mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.verifyingOrcid')"></p>
          </div>

          <!-- Login success (brief, auto-redirects) -->
          <div x-show="status === 'login-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink-muted" x-text="$t('orcid.loginSuccess')"></p>
          </div>

          <!-- Accreditation success -->
          <div x-show="status === 'accredit-success'">
            <div class="text-pevo-green mb-4">
              <svg class="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            </div>
            <p class="text-ink font-medium mb-2" x-text="$t('orcid.verificationSuccess')"></p>
            <a :href="$lp('/profile/' + resultUsername)" @click.prevent="navigate('/profile/' + resultUsername)" class="btn-primary inline-block mt-4 no-underline" x-text="$t('orcid.viewProfile')"></a>
          </div>

          <!-- Error -->
          <div x-show="status === 'error'">
            <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p class="text-red-700 text-sm" x-text="errorMessage"></p>
            </div>
            <template x-if="errorAction === 'signup'">
              <a :href="$lp('/signup')" @click.prevent="navigate('/signup')" class="btn-primary inline-block no-underline" x-text="$t('common.signUp')"></a>
            </template>
            <template x-if="errorAction === 'recover'">
              <a :href="$lp('/recover')" @click.prevent="navigate('/recover')" class="btn-primary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
            <template x-if="errorAction === 'settings'">
              <a :href="$lp('/settings')" @click.prevent="navigate('/settings')" class="btn-primary inline-block no-underline" x-text="$t('common.verifyInSettings')"></a>
            </template>
            <!-- errorAction === 'timeout' (ORCID provider timeout / service
                 unavailable) intentionally renders NO action button: the message
                 instructs the user to wait and start over from scratch, and an
                 immediate same-code retry would 400 (state consumed). Withholding
                 the one-tap retry is the point — do not add a 'timeout' branch. -->
            <template x-if="errorAction === '' || errorAction === null">
              <a :href="$lp(backPath)" @click.prevent="navigate(backPath)" class="btn-secondary inline-block no-underline" x-text="$t('common.tryAgain')"></a>
            </template>
          </div>
        </div>
      </div>
`;

export { template as orcidCallbackPageTemplate };

export function initOrcidCallbackPage() {
  Alpine.data('orcidCallbackPage', () => ({
    // Lifecycle guards (spread first). Every async continuation (awaited
    // promise resolution, setTimeout callback) that writes to component
    // state or fires navigation must check _mounted first. Timers are
    // tracked in _pendingTimers and cleared in destroy() so a user
    // navigating away mid-wait does not trip post-teardown state mutations.
    // See frontend/src/lib/timer-guard.js for the helper contract.
    ...createTimerGuard(),

    status: 'verifying',
    errorMessage: '',
    errorAction: '', // 'signup' for NO_ACCOUNT; 'recover' for ORCID_ALREADY_LINKED; 'settings' for BROADCAST_TIMEOUT, POST_BROADCAST_FAILED / POST_BROADCAST_OPERATOR_REQUIRED (outcome:'confirmed'), and accredit/link ORCID_PROVIDER_TIMEOUT; 'timeout' (renders no one-tap retry button) for the other ORCID_PROVIDER_TIMEOUT modes and INTERNAL_ERROR; else empty
    resultUsername: '',
    backPath: '/',

    navigate(path) { Alpine.store('router').navigate(path); },

    init() {
      const code = Alpine.store('router').query.code;
      const state = Alpine.store('router').query.state;

      if (!code || typeof code !== 'string' || code.length > 100 ||
          !state || typeof state !== 'string' || state.length > 256) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.missingParams');
        return;
      }

      // Read mode from sessionStorage (set before redirect) for error routing.
      // Do NOT remove it here. If completeOrcid fails (e.g. 503) and the user
      // refreshes, we need the mode to still be present so the retry can
      // reach the correct endpoint with the correct auth. It's cleared after
      // completeOrcid resolves successfully inside _verify.
      // sessionStorage (not localStorage) so concurrent tabs in different
      // ORCID modes don't overwrite each other's callback dispatch.
      const mode = sessionStorage.getItem('pevo_orcid_mode') || '';

      if (mode === 'signup' || mode === 'login') {
        this.backPath = mode === 'signup' ? '/signup' : '/login';
      } else if (mode === 'accredit') {
        this.backPath = '/accreditation';
      } else if (mode === 'link') {
        this.backPath = '/settings';
      } else if (mode === 'session_auth' || mode === 'fresh_auth') {
        this.backPath = getReturnPath() || '/';
      }

      this._verify(code, state, mode);
    },

    destroy() {
      this._teardownTimers();
      // Mid-callback teardown clears BOTH return-path pointers so a later ORCID
      // flow that does not write its own return path (e.g. signup) cannot read a
      // stale value and route the user to the wrong destination:
      //   - `pevo_orcid_return_to`, the signup/recover flows' pointer (happy-path
      //     resolution removes it inside `_handleSignup`; this covers the
      //     abandoned-mid-flight path);
      //   - the fresh-auth flow's return path via `clearReturnPath()`, which the
      //     fresh_auth / session_auth handlers otherwise clear only on the
      //     happy path.
      // Parity with `pevo_orcid_mode`'s scrub-on-logout in `auth.js`.
      sessionStorage.removeItem('pevo_orcid_return_to');
      clearReturnPath();
    },

    async _verify(code, state, mode) {
      let res;
      try {
        res = await completeOrcid(code, state, mode);
      } catch (err) {
        if (!this._mounted) return;
        this.status = 'error';

        if (err.code === 'NO_ACCOUNT') {
          this.errorMessage = this.$t('orcid.noAccountFound');
          this.errorAction = 'signup';
          return;
        }

        // The same-tick lock-contention 409 carries no `retriable: true`
        // discriminator because the OAuth state token is consumed before lock
        // acquisition, so any same-`{code, state}` retry returns 400
        // BAD_REQUEST. Every ORCID_ALREADY_LINKED 409 is treated as durable;
        // user restarts OAuth via /recover.
        if (err.code === 'ORCID_ALREADY_LINKED') {
          this.errorMessage = this.$t('orcid.alreadyLinkedDurable');
          this.errorAction = 'recover';
          return;
        }

        // Forward-compat for the broadcast-abort 504 envelope: the backend may
        // emit BROADCAST_TIMEOUT once that lands. Surfacing it now is safe — the
        // branch is inert until the code appears on the wire.
        if (err.code === 'BROADCAST_TIMEOUT') {
          this.errorMessage = this.$t('orcid.broadcastPending');
          this.errorAction = 'settings';
          return;
        }

        // POST_BROADCAST_FAILED with outcome:'confirmed' means the chain-side
        // bind succeeded; only a downstream cascade write (cache, accounts row,
        // reputation seed) failed. Per api-contracts/orcid.md, clients MUST NOT
        // route this through /recover — the ORCID is already bound, and a fresh
        // OAuth flow would surface 409 ORCID_ALREADY_LINKED. The outcome
        // discriminator is load-bearing: any other value (or absent) falls
        // through to the generic path below. Branch only on the contract enum,
        // never on details.failed_step or err.message substrings.
        if (err.code === 'POST_BROADCAST_FAILED' && err?.details?.outcome === 'confirmed') {
          this.errorMessage = this.$t('orcid.postBroadcastFailedConfirmed');
          this.errorAction = 'settings';
          return;
        }

        // POST_BROADCAST_OPERATOR_REQUIRED is the permanent-severity sibling of
        // POST_BROADCAST_FAILED (TypeError/SyntaxError/RangeError or SQLSTATE
        // class 23*/42* on the cascade write). Chain bind succeeded; the
        // app-side failure won't auto-reconcile and needs operator/support
        // attention. Per api-contracts/common.md, clients keying on
        // POST_BROADCAST_FAILED MUST also handle this sibling — the same
        // outcome-discriminator rule applies (load-bearing per the contract).
        // Routing to /recover is still wrong (the ORCID is bound), so the
        // affordance points at /settings; the copy carries the operator-contact
        // framing instead of the "give it a moment to sync" framing.
        if (err.code === 'POST_BROADCAST_OPERATOR_REQUIRED' && err?.details?.outcome === 'confirmed') {
          this.errorMessage = this.$t('orcid.postBroadcastOperatorRequired');
          this.errorAction = 'settings';
          return;
        }

        // ORCID_PROVIDER_TIMEOUT (504): the ORCID provider HTTP call (token
        // exchange or works fetch) did not respond in time. Per the orcid.md
        // contract the OAuth state is already consumed, so a same-{code,state}
        // retry returns 400; and on accredit/link the call may have partially
        // completed (the 504's verify_before_retry hint), so an immediate retry
        // risks a duplicate on-chain bind. Surface dedicated copy and withhold
        // the generic one-tap retry. Accredit/link route to /settings to verify
        // before restarting (matching the contract's verify_location); the
        // broadcast-less modes (signup/login/fresh_auth) get the no-retry
        // 'timeout' affordance.
        if (err.code === 'ORCID_PROVIDER_TIMEOUT') {
          if (mode === 'accredit' || mode === 'link') {
            this.errorMessage = this.$t('orcid.providerTimeoutVerify');
            this.errorAction = 'settings';
          } else {
            this.errorMessage = this.$t('orcid.providerTimeout');
            this.errorAction = 'timeout';
          }
          return;
        }

        // INTERNAL_ERROR (500/503): ORCID API unreachable, or the backend
        // service unavailable. A pre-broadcast failure with no chain side-effect.
        // Per the orcid.md "State consumption semantics", the OAuth state is
        // consumed only when the throw originates downstream of the consume DEL;
        // a pre-consume throw (state-read or auth-dispatch) leaves state intact.
        // The client cannot distinguish the two, so withhold the one-tap retry
        // via the 'timeout' affordance regardless: a same-code retry on the
        // consumed case would 400, and the state-preserved case is better served
        // by a deliberate restart than an immediate re-fire. Keep the
        // console.warn: unlike an expected VALIDATION_ERROR, a 5xx is an
        // unexpected server failure worth diagnosing, and the raw error stays out
        // of the DOM behind the dedicated copy.
        if (err.code === 'INTERNAL_ERROR') {
          console.warn('[orcid callback complete]', err);
          this.errorMessage = this.$t('orcid.serviceUnavailable');
          this.errorAction = 'timeout';
          return;
        }

        // VALIDATION_ERROR: the insufficient-works 422 (signup + accredit) is the
        // only VALIDATION_ERROR that carries a works-count details shape
        // ({ required, have }). The other VALIDATION_ERRORs on this surface — the
        // accredit "already accredited" 422 and the link "not accredited" 422 —
        // must NOT borrow the works copy. Detect the works case by that details
        // shape; until the backend emits it, fall back to mode (signup mode's
        // ONLY VALIDATION_ERROR is insufficient-works). The threshold is
        // de-hardcoded from the copy: pass the backend's real `required` when
        // present, else the documented-default fallback. Both VALIDATION_ERROR
        // paths are expected responses, so neither warns (avoids log noise);
        // only the generic fallback below console.warns for diagnostics.
        if (err.code === 'VALIDATION_ERROR') {
          const required = err.details?.required;
          if (typeof required === 'number' || mode === 'signup') {
            this.errorMessage = this.$t('signup.orcidInsufficientWorks', {
              min: typeof required === 'number' ? required : ORCID_MIN_WORKS_FALLBACK,
            });
          } else {
            this.errorMessage = this.$t('orcid.verificationFailed');
          }
        } else {
          console.warn('[orcid callback complete]', err);
          this.errorMessage = this.$t('orcid.verificationFailed');
        }
        return;
      }

      if (!this._mounted) return;
      const data = res.data;

      // Only clear the stored mode after completeOrcid resolved successfully.
      // If this throws (e.g. 503), we leave it so a refresh can retry.
      // If any handler below later gains an `await`, move this removeItem
      // inside the handler after the mutation resolves. Otherwise a mid-await
      // destroy() could clear the mode without routing the flow, breaking
      // the 503-refresh-retry invariant.
      sessionStorage.removeItem('pevo_orcid_mode');

      // Handlers self-guard on _mounted. The dispatch-level check above is
      // belt-and-suspenders — either guard alone would suffice; both together
      // tolerate a direct-call code path being added later without re-reading
      // the whole file.
      switch (data.mode) {
        case 'signup':
          this._handleSignup(data);
          break;
        case 'login':
          this._handleLogin(data);
          break;
        case 'accredit':
          this._handleAccredit(data);
          break;
        case 'link':
          this._handleLink(data);
          break;
        case 'fresh_auth':
          this._handleFreshAuth(data);
          break;
        case 'session_auth':
          this._handleSessionAuth(data);
          break;
        default:
          this.status = 'error';
          this.errorMessage = this.$t('orcid.verificationFailed');
      }
    },

    _handleSignup(data) {
      if (!this._mounted) return;
      // Store verified ORCID nonce for the signup page
      localStorage.setItem('pevo_signup_orcid_token', data.orcid_token);
      localStorage.setItem('pevo_signup_orcid_id', data.orcid_id);
      // Note: `data.name` intentionally not persisted. Auto-fill of the
      // full name field was considered (and the orphaned
      // pevo_signup_orcid_name key was previously written here for that)
      // but the signup form never reads it and the feature was abandoned.
      // The user fills Full Name themselves; ORCID surfaces the ID only.

      // Return to the originating page (signup or recover).
      // sessionStorage (not localStorage) — per-tab so concurrent flows in
      // different tabs cannot corrupt each other's return-path dispatch.
      const returnTo = sessionStorage.getItem('pevo_orcid_return_to');
      sessionStorage.removeItem('pevo_orcid_return_to');
      this.navigate(returnTo === 'recover' ? '/recover' : '/signup');
    },

    _handleLogin(data) {
      if (!this._mounted) return;
      this.status = 'login-success';

      // Reset accreditation state for the newly-logged-in ORCID username
      // by passing explicit `is_accredited: false` and `accreditation: null`
      // into the helper's data payload. Without this override, the helper's
      // preserve-on-undefined semantics would carry stale values (from a
      // prior session or a re-login as a different user) into localStorage.
      // The polling loop the helper starts refreshes these from the server
      // (a transient failure leaves the store at `false` until the next
      // 60s poll, which self-stops once accreditation is confirmed).
      const auth = Alpine.store('auth');
      auth.loginFromResponse({
        token: data.token,
        expires_at: data.expires_at,
        username: data.username,
        custody: data.custody || 'light',
        is_accredited: false,
        accreditation: null,
      });

      Alpine.store('toast').show(this.$t('orcid.loginSuccess'), 'success');
      this._setTimer(() => this.navigate('/papers'), 500);
    },

    _handleAccredit(data) {
      if (!this._mounted) return;
      this.status = 'accredit-success';
      this.resultUsername = data.username;

      // Refresh accreditation data in auth store. Pass the current polling
      // generation so a concurrent in-flight poll fetch cannot clobber this
      // one-shot result via the stale-fetch race.
      const auth = Alpine.store('auth');
      auth._checkAccreditation(auth._pollingGeneration);
      Alpine.store('toast').show(this.$t('orcid.verificationSuccess'), 'success');
    },

    _handleLink(data) {
      if (!this._mounted) return;
      // Signal settings page to show success
      localStorage.setItem('pevo_orcid_link_complete', '1');
      this.navigate('/settings');
    },

    _handleFreshAuth(data) {
      if (!this._mounted) return;
      // Defense-in-depth on the echoed target triple. The backend integration
      // test pin is the primary contract guard; this guard catches a release
      // that ships with the echo dropped between test runs. Without it the
      // SPA would silently write `undefined` into a target field and every
      // subsequent strict-equality lookup would miss, leaving the user
      // re-OAuthing indefinitely with no error surface.
      //
      // Type-check `root_permlink` rather than truthy-check it: the backend's
      // `set_password` fresh_auth echo deliberately ships `root_permlink: ''`
      // (a contract-valid empty string indicating an account-level, non-paper
      // target). A truthy check would reject that valid response. The other
      // two fields (`action`, `root_author`) are always non-empty per the
      // wire contract; their guards combine the typeof and truthy checks so
      // a `null` / `undefined` / wrong-type / empty value all surface error.
      if (
        typeof data.action !== 'string' || !data.action ||
        typeof data.root_author !== 'string' || !data.root_author ||
        typeof data.root_permlink !== 'string'
      ) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.verificationFailed');
        return;
      }
      // Per-action credit-field guard, one binding level deeper than the triple
      // guard above. Claim/approve bind author_index (the name-only slot);
      // approve/revoke bind claimer (the subject). If the backend drops a
      // credit-field echo, cacheConsentOpProof would store undefined→null while
      // the eventual broadcast consumer keys on the real index/subject — a
      // permanent strict-match miss and the same indefinite re-OAuth loop the
      // triple guard prevents. Require each field the action binds: author_index
      // a non-negative integer (slot 0 is valid, so check Number.isInteger, not
      // truthiness), claimer a non-empty string. Anchored consent ops
      // (author_accept / author_resign) and settings actions bind neither, so
      // they skip this guard.
      const needsAuthorIndex =
        data.action === 'claim_authorship' || data.action === 'approve_authorship';
      const needsClaimer =
        data.action === 'approve_authorship' || data.action === 'revoke_authorship';
      if (
        (needsAuthorIndex && !(Number.isInteger(data.author_index) && data.author_index >= 0)) ||
        (needsClaimer && !(typeof data.claimer === 'string' && data.claimer))
      ) {
        this.status = 'error';
        this.errorMessage = this.$t('orcid.verificationFailed');
        return;
      }
      // Target-bound consent-op proof: cache against the target the backend
      // bound at /start so the eventual broadcast consumer looks it up by
      // matching target. For settings actions and anchored consent ops that is
      // the (action, root_author, root_permlink) triple; name-only credit ops
      // additionally bind author_index (claim/approve) and claimer
      // (approve/revoke), echoed here only when present. The consumer
      // (withAuthorshipFreshAuth) retrieves via getCachedConsentOpProof with the
      // same target; cacheConsentOpProof normalizes absent credit fields to null
      // so a triple-only target still matches. Single-slot cache.
      cacheConsentOpProof(
        data.fresh_auth_proof,
        data.expires_at,
        data.action,
        data.root_author,
        data.root_permlink,
        data.author_index,
        data.claimer,
      );
      const returnPath = getReturnPath() || '/';
      clearReturnPath();
      Alpine.store('toast')?.show(this.$t('orcid.reauthSuccess'), 'success');
      this.navigate(returnPath);
    },

    _handleSessionAuth(data) {
      if (!this._mounted) return;
      // Backend returns `fresh_auth_proof` + `expires_at`. Cache for re-use
      // within the 5-minute TTL, then bounce the user back to where they
      // initiated the broadcast so they can retry it.
      cacheSessionProof(data.fresh_auth_proof, data.expires_at);
      const returnPath = getReturnPath() || '/';
      clearReturnPath();
      Alpine.store('toast')?.show(this.$t('orcid.reauthSuccess'), 'success');
      this.navigate(returnPath);
    },
  }));
}
