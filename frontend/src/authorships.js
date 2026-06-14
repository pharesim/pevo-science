import Alpine from 'alpinejs';
import { fetchPendingAuthorships } from './api.js';

// Store of the signed-in user's outstanding authorship actions, surfaced in the
// header user-menu dropdown (the pending-authorships discovery surface). Sourced
// from GET /api/me/authorships/pending:
//   - pending_consents: Route-2 anchored slots awaiting the user's author_accept
//   - pending_claims:   the user's own Route-3 claims awaiting approval
//
// The endpoint is FAIL-CLOSED: a 503 on HAF unavailability must NOT degrade to an
// empty list (a silent empty would read as "nothing pending" and hide real
// obligations — ARCHITECTURE.md "Consented-set computation"). On any load failure
// the store sets `unavailable` and the dropdown shows a retry affordance instead
// of an empty state.
export function initAuthorships() {
  Alpine.store('authorships', {
    pendingConsents: [],
    pendingClaims: [],
    isLoading: false,
    unavailable: false,
    _username: null,
    // Monotonic generation counter: a load whose generation has been superseded
    // (by a newer load, or by stop() on disconnect) discards its result so a
    // slow in-flight response cannot repopulate after logout or clobber a fresher
    // fetch.
    _generation: 0,

    get count() {
      return this.pendingConsents.length + this.pendingClaims.length;
    },

    start(username) {
      this.stop();
      this._username = username;
      this.load();
    },

    stop() {
      this._generation += 1;
      this._username = null;
      this.pendingConsents = [];
      this.pendingClaims = [];
      this.unavailable = false;
      this.isLoading = false;
    },

    async load() {
      if (!this._username) return;
      // In-flight short-circuit: a refresh() firing while a load is already
      // running would otherwise issue a redundant fetch. The generation counter
      // still keeps a superseded result from landing, but this avoids the wasted
      // request. start() clears isLoading via stop() first, so it is never
      // blocked here.
      if (this.isLoading) return;
      const gen = (this._generation += 1);
      this.isLoading = true;
      try {
        const res = await fetchPendingAuthorships();
        if (gen !== this._generation) return;
        const d = res.data || {};
        this.pendingConsents = Array.isArray(d.pending_consents) ? d.pending_consents : [];
        this.pendingClaims = Array.isArray(d.pending_claims) ? d.pending_claims : [];
        this.unavailable = false;
      } catch (err) {
        if (gen !== this._generation) return;
        // Fail-closed on EVERY error, not just the documented 503: never assert
        // "nothing pending" on a failed fetch. The 503 (HAF unavailable) is the
        // contractual fail-closed case; a transport/other error is treated the
        // same so the surface shows a retry rather than an empty list.
        this.unavailable = true;
      } finally {
        if (gen === this._generation) this.isLoading = false;
      }
    },

    async refresh() {
      await this.load();
    },
  });
}
