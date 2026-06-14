import Alpine from 'alpinejs';
import {
  fetchAdminRoster,
  promoteAdmin,
  demoteAdmin,
  adminGrantAccreditation,
  adminRetractPaper,
  adminRevokeAuthorship,
  adminApproveAuthorship,
  fetchEmailStatus,
} from '../api.js';
import { withSettingsFreshAuth } from '../lib/settings-fresh-auth.js';
import { createTimerGuard } from '../lib/timer-guard.js';
import { formatDate } from '../components/paper-card.js';

// Tier hierarchy. Higher rank = more authority. Drives the UX-only capability
// gates below; the backend tier middleware re-enforces every check, so a hidden
// control is never the security boundary. `root` is bootstrap config, not a
// roster row, so it never appears as a manageable target.
const TIER_RANK = { admin: 1, super_admin: 2, root: 3 };

const template = `
      <div x-data="adminPage" class="container-narrow py-8">
        <!-- Not signed in -->
        <template x-if="!isConnected">
          <div class="text-center py-16">
            <p class="text-ink-muted mb-4" x-text="$t('admin.signInRequired')"></p>
            <button @click="navigate('/login')" class="btn-primary" x-text="$t('admin.signIn')"></button>
          </div>
        </template>

        <template x-if="isConnected">
          <div class="max-w-2xl mx-auto">
            <h1 class="text-3xl font-bold text-ink mb-2" x-text="$t('admin.title')"></h1>
            <p class="text-ink-muted mb-8" x-text="$t('admin.description')"></p>

            <!-- Loading -->
            <div x-show="loading" class="py-8">
              <div class="animate-pulse h-4 bg-parchment-dark rounded w-48"></div>
            </div>

            <!-- Load error (could not reach the roster endpoint) -->
            <template x-if="!loading && loadError">
              <div class="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4">
                <p class="text-sm text-pevo-crimson-dark" x-text="loadError"></p>
                <button class="btn-secondary text-xs mt-2" @click="loadRoster()" x-text="$t('common.tryAgain')"></button>
              </div>
            </template>

            <!-- Not authorized: show, do not bounce (mirrors the unaccredited-banner convention) -->
            <template x-if="!loading && !loadError && !tier">
              <div class="bg-pevo-crimson-light border border-pevo-crimson/30 rounded-lg p-4">
                <p class="font-medium text-ink text-sm" x-text="$t('admin.notAuthorizedTitle')"></p>
                <p class="text-xs text-ink-muted mt-1" x-text="$t('admin.notAuthorizedHint')"></p>
              </div>
            </template>

            <!-- Authorized console -->
            <template x-if="!loading && !loadError && tier">
              <div class="space-y-6">
                <!-- Tier badge -->
                <div class="flex items-center gap-2">
                  <span class="text-sm text-ink-muted" x-text="$t('admin.yourTier')"></span>
                  <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-pevo-teal/10 text-pevo-teal" x-text="tierLabel(tier)"></span>
                </div>

                <!-- Shared confirm panel: shown for any pending mutation. Surfaces
                     the issued_by attribution before the operator commits. -->
                <template x-if="pendingConfirm">
                  <div class="border border-pevo-teal/40 bg-pevo-teal/5 rounded-xl p-5">
                    <h3 class="text-sm font-semibold text-ink mb-1" x-text="$t('admin.confirmTitle')"></h3>
                    <p class="text-sm text-ink mb-2" x-text="pendingConfirm.summary"></p>
                    <p class="text-xs text-ink-muted mb-4">
                      <span x-text="$t('admin.attributionNotice')"></span>
                      <span class="font-mono">@<span x-text="username"></span></span>
                    </p>
                    <div class="flex gap-3">
                      <button class="btn-primary text-sm disabled:opacity-50" :disabled="submitting"
                              @click="runConfirmed()"
                              x-text="submitting ? $t('admin.submitting') : $t('admin.confirmButton')"></button>
                      <button class="text-sm text-ink-muted hover:underline" :disabled="submitting"
                              @click="cancelConfirm()" x-text="$t('common.cancel')"></button>
                    </div>
                    <p x-show="actionError" class="text-sm text-pevo-crimson-dark mt-2" x-text="actionError"></p>
                  </div>
                </template>

                <!-- Roster management (super_admin and root) -->
                <template x-if="canManageRoster">
                  <div class="border border-parchment-dark rounded-xl p-6">
                    <h2 class="text-xl font-bold text-ink mb-4" x-text="$t('admin.rosterTitle')"></h2>

                    <template x-if="roster.length === 0">
                      <p class="text-sm text-ink-muted" x-text="$t('admin.rosterEmpty')"></p>
                    </template>

                    <ul x-show="roster.length > 0" class="divide-y divide-parchment-dark border border-parchment-dark rounded-lg overflow-hidden mb-5">
                      <template x-for="member in roster" :key="member.account">
                        <li class="flex items-center justify-between gap-3 px-3 py-2">
                          <div class="min-w-0">
                            <div class="flex items-center gap-2">
                              <span class="text-sm text-ink font-medium">@<span x-text="member.account"></span></span>
                              <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-parchment-dark text-ink-muted" x-text="tierLabel(member.level)"></span>
                            </div>
                            <p class="text-xs text-ink-muted mt-0.5"
                               x-text="$t('admin.grantedBy', { account: member.granted_by || '?', date: formatDate(member.granted_at) })"></p>
                          </div>
                          <button x-show="canDemoteRow(member)"
                                  class="text-sm text-pevo-crimson hover:underline shrink-0 disabled:opacity-50 disabled:no-underline"
                                  :disabled="pendingConfirm || submitting"
                                  @click="requestDemote(member)"
                                  x-text="$t('admin.demote')"></button>
                        </li>
                      </template>
                    </ul>

                    <!-- Promote form -->
                    <form @submit.prevent="requestPromote()" class="space-y-3">
                      <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.promoteTitle')"></h3>
                      <div class="flex flex-col sm:flex-row gap-3">
                        <input type="text" x-model="promoteAccount" :placeholder="$t('admin.accountPlaceholder')"
                               class="flex-1 border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                               autocapitalize="off" spellcheck="false">
                        <select x-model="promoteLevel"
                                class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                          <template x-for="lvl in manageableLevels" :key="lvl">
                            <option :value="lvl" x-text="tierLabel(lvl)"></option>
                          </template>
                        </select>
                        <button type="submit" class="btn-primary text-sm whitespace-nowrap disabled:opacity-50"
                                :disabled="!promoteAccount.trim() || pendingConfirm || submitting" x-text="$t('admin.promote')"></button>
                      </div>
                    </form>
                  </div>
                </template>

                <!-- Authority actions (all tiers) -->
                <div class="border border-parchment-dark rounded-xl p-6">
                  <h2 class="text-xl font-bold text-ink mb-4" x-text="$t('admin.authorityTitle')"></h2>

                  <!-- Grant accreditation -->
                  <form @submit.prevent="requestGrantAccreditation()" class="space-y-3 pb-5 mb-5 border-b border-parchment-dark">
                    <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.grantAccreditationTitle')"></h3>
                    <p class="text-xs text-ink-muted" x-text="$t('admin.grantAccreditationHint')"></p>
                    <input type="text" x-model="grantAccount" :placeholder="$t('admin.accountPlaceholder')"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           autocapitalize="off" spellcheck="false">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input type="text" x-model="grantName" maxlength="200" :placeholder="$t('admin.namePlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                      <input type="text" x-model="grantInstitution" maxlength="200" :placeholder="$t('admin.institutionPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    </div>
                    <input type="text" x-model="grantField" maxlength="100" :placeholder="$t('admin.fieldPlaceholder')"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    <button type="submit" class="btn-primary text-sm disabled:opacity-50"
                            :disabled="!canSubmitGrant || pendingConfirm || submitting" x-text="$t('admin.grantAccreditationSubmit')"></button>
                  </form>

                  <!-- Sanction (stubbed: payload pending the revoke-sanction op contract) -->
                  <div class="space-y-2 pb-5 mb-5 border-b border-parchment-dark opacity-60">
                    <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.sanctionTitle')"></h3>
                    <p class="text-xs text-ink-muted" x-text="$t('admin.sanctionHint')"></p>
                    <span class="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-parchment-dark text-ink-muted"
                          x-text="$t('admin.comingSoon')"></span>
                  </div>

                  <!-- Retract paper -->
                  <form @submit.prevent="requestRetractPaper()" class="space-y-3 pb-5 mb-5 border-b border-parchment-dark">
                    <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.retractTitle')"></h3>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input type="text" x-model="retractAuthor" :placeholder="$t('admin.authorPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                      <input type="text" x-model="retractPermlink" :placeholder="$t('admin.permlinkPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                    </div>
                    <input type="text" x-model="retractReason" :placeholder="$t('admin.reasonPlaceholder')"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    <button type="submit" class="btn-primary text-sm disabled:opacity-50"
                            :disabled="!canSubmitRetract || pendingConfirm || submitting" x-text="$t('admin.retractSubmit')"></button>
                  </form>

                  <!-- Revoke authorship -->
                  <form @submit.prevent="requestRevokeAuthorship()" class="space-y-3 pb-5 mb-5 border-b border-parchment-dark">
                    <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.revokeAuthorshipTitle')"></h3>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input type="text" x-model="revokeAuthor" :placeholder="$t('admin.authorPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                      <input type="text" x-model="revokePermlink" :placeholder="$t('admin.permlinkPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                    </div>
                    <input type="text" x-model="revokeClaimer" :placeholder="$t('admin.claimerPlaceholder')"
                           class="w-full border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                           autocapitalize="off" spellcheck="false">
                    <button type="submit" class="btn-primary text-sm disabled:opacity-50"
                            :disabled="!canSubmitRevoke || pendingConfirm || submitting" x-text="$t('admin.revokeAuthorshipSubmit')"></button>
                  </form>

                  <!-- Approve bridged-paper author -->
                  <form @submit.prevent="requestApproveAuthorship()" class="space-y-3">
                    <h3 class="text-sm font-semibold text-ink" x-text="$t('admin.approveAuthorshipTitle')"></h3>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input type="text" x-model="approveAuthor" :placeholder="$t('admin.authorPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                      <input type="text" x-model="approvePermlink" :placeholder="$t('admin.permlinkPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <input type="text" x-model="approveClaimer" :placeholder="$t('admin.claimerPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal"
                             autocapitalize="off" spellcheck="false">
                      <input type="number" min="0" x-model="approveAuthorIndex" :placeholder="$t('admin.authorIndexPlaceholder')"
                             class="border border-parchment-dark rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-pevo-teal focus:border-pevo-teal">
                    </div>
                    <button type="submit" class="btn-primary text-sm disabled:opacity-50"
                            :disabled="!canSubmitApprove || pendingConfirm || submitting" x-text="$t('admin.approveAuthorshipSubmit')"></button>
                  </form>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
`;

export { template as adminPageTemplate };

export function initAdminPage() {
  Alpine.data('adminPage', () => ({
    ...createTimerGuard(),

    tier: null,
    roster: [],
    loading: true,
    loadError: null,

    // hasPassword drives the password-vs-ORCID fresh-auth factor (see settings).
    hasPassword: false,

    // Shared confirm/mutation state.
    pendingConfirm: null,
    submitting: false,
    actionError: null,

    // Roster promote form
    promoteAccount: '',
    promoteLevel: 'admin',

    // Grant accreditation form
    grantAccount: '',
    grantName: '',
    grantInstitution: '',
    grantField: '',

    // Retract paper form
    retractAuthor: '',
    retractPermlink: '',
    retractReason: '',

    // Revoke authorship form
    revokeAuthor: '',
    revokePermlink: '',
    revokeClaimer: '',

    // Approve authorship form
    approveAuthor: '',
    approvePermlink: '',
    approveClaimer: '',
    approveAuthorIndex: '',

    formatDate,

    get isConnected() { return Alpine.store('auth').isConnected; },
    get username() { return Alpine.store('auth').username; },
    get custody() { return Alpine.store('auth').custody; },

    // Roster management is super_admin and above; the backend re-enforces it.
    get canManageRoster() { return TIER_RANK[this.tier] >= TIER_RANK.super_admin; },

    // Levels the viewer may promote/demote: super_admin manages `admin`; root
    // manages `admin` and `super_admin`. `root` is never a manageable level.
    get manageableLevels() {
      if (this.tier === 'root') return ['admin', 'super_admin'];
      if (this.tier === 'super_admin') return ['admin'];
      return [];
    },

    // Deliberately stricter than the backend contract: institution and field are
    // optional server-side (default ''), but an operator-issued accreditation
    // should carry complete metadata, so the console requires all four. Only
    // full_name is required server-side. Relax here if a metadata-light grant is
    // ever needed.
    get canSubmitGrant() {
      return this.grantAccount.trim().length > 0
        && this.grantName.trim().length > 0
        && this.grantInstitution.trim().length > 0
        && this.grantField.trim().length > 0;
    },
    get canSubmitRetract() {
      return this.retractAuthor.trim().length > 0
        && this.retractPermlink.trim().length > 0
        && this.retractReason.trim().length > 0;
    },
    get canSubmitRevoke() {
      return this.revokeAuthor.trim().length > 0
        && this.revokePermlink.trim().length > 0
        && this.revokeClaimer.trim().length > 0;
    },
    get canSubmitApprove() {
      return this.approveAuthor.trim().length > 0
        && this.approvePermlink.trim().length > 0
        && this.approveClaimer.trim().length > 0
        && this.approveAuthorIndex !== '' && Number(this.approveAuthorIndex) >= 0;
    },

    navigate(path) { Alpine.store('router').navigate(path); },

    tierLabel(level) {
      if (level === 'admin') return this.$t('admin.tierAdmin');
      if (level === 'super_admin') return this.$t('admin.tierSuperAdmin');
      if (level === 'root') return this.$t('admin.tierRoot');
      return level || '';
    },

    // Demotable rows: a level the viewer can manage (so never `root`, which is
    // bootstrap config and never appears in manageableLevels), and never the
    // viewer's own account (no self-lockout out of the capability in use).
    canDemoteRow(member) {
      return this.manageableLevels.includes(member.level)
        && member.account !== this.username;
    },

    init() {
      if (this.isConnected) this.loadRoster();
      this.$watch('isConnected', (connected) => {
        if (connected) this.loadRoster();
      });
    },

    destroy() {
      this._teardownTimers();
    },

    async loadRoster() {
      this.loading = true;
      this.loadError = null;
      try {
        // hasPassword feeds the password-vs-ORCID fresh-auth factor, which only
        // applies on the light/JWT path; self-custody re-auths via the
        // per-request Keychain signature regardless, so skip the email fetch
        // there. Best-effort either way.
        const [rosterRes, emailRes] = await Promise.all([
          fetchAdminRoster(),
          this.custody === 'light' ? fetchEmailStatus().catch(() => null) : Promise.resolve(null),
        ]);
        if (!this._mounted) return;
        this.tier = rosterRes.data?.tier ?? null;
        this.roster = Array.isArray(rosterRes.data?.roster) ? rosterRes.data.roster : [];
        this.hasPassword = emailRes?.data?.hasPassword === true;
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see settings.handleOrcidLink): raw error only to
        // console.warn. _errorMessage surfaces a structured backend reason (e.g.
        // a 503 "Roster temporarily unavailable") and falls back to a generic
        // localized string for unstructured/transport errors.
        console.warn('[admin roster]', err);
        this.loadError = this._errorMessage(err, 'admin.loadFailed');
      } finally {
        if (this._mounted) this.loading = false;
      }
    },

    _freshAuthCtx() {
      return {
        custody: this.custody,
        username: this.username,
        hasPassword: this.hasPassword,
      };
    },

    // Map an action/load failure to a user-facing message. A 504 broadcast
    // timeout is ambiguous (the op may have landed; latest-op-wins makes a
    // re-broadcast harmless), so tell the operator to verify rather than showing
    // a definite failure. Structured backend errors carry a user-facing message
    // (an already-retracted 422, not-in-roster, root-not-demotable, a bad-enum
    // 400) — surface it so the operator sees WHY, not a blanket "failed". Plain
    // transport/unexpected errors carry no envelope `code`; fall back to a
    // generic localized string (their raw .message may leak internals, so only
    // console.warn sees it).
    _errorMessage(err, fallbackKey) {
      if (err?.details?.outcome === 'uncertain') return this.$t('admin.broadcastUncertain');
      if (typeof err?.code === 'string' && err?.message) return err.message;
      return this.$t(fallbackKey);
    },

    cancelConfirm() {
      this.pendingConfirm = null;
      this.actionError = null;
    },

    // ── Confirm requesters: each validates, then stages a pendingConfirm whose
    // `run(proof)` performs the admin-signed API call. The confirm panel shows
    // the summary + issued_by before the operator commits via runConfirmed(). ──

    requestPromote() {
      const account = this.promoteAccount.trim();
      if (!account) return;
      const level = this.promoteLevel;
      // Self-lockout guard: the backend does not reject a self-grant, so a
      // super_admin granting themselves `admin` would silently downgrade out of
      // the roster controls they are using. Mirror canDemoteRow's self-check.
      if (account === this.username) {
        Alpine.store('toast').show(this.$t('admin.cannotPromoteSelf'), 'error');
        return;
      }
      // An admin_grant rewrites the target's level. If they already hold an
      // equal-or-higher tier, granting this level overwrites it (a silent demote
      // when lower) — warn in the confirm copy so it is deliberate.
      const current = this.roster.find((m) => m.account === account)?.level;
      const isOverwrite = current && TIER_RANK[current] >= TIER_RANK[level];
      this._stageConfirm({
        freshAuthAction: 'admin_grant_role',
        summary: isOverwrite
          ? this.$t('admin.confirmPromoteOverwrite', { account, level: this.tierLabel(level), current: this.tierLabel(current) })
          : this.$t('admin.confirmPromote', { account, level: this.tierLabel(level) }),
        run: (proof) => promoteAdmin(account, level, proof),
      });
    },

    requestDemote(member) {
      if (!this.canDemoteRow(member)) return;
      this._stageConfirm({
        freshAuthAction: 'admin_revoke_role',
        summary: this.$t('admin.confirmDemote', { account: member.account, level: this.tierLabel(member.level) }),
        run: (proof) => demoteAdmin(member.account, member.level, proof),
      });
    },

    requestGrantAccreditation() {
      if (!this.canSubmitGrant) return;
      const values = {
        account: this.grantAccount.trim(),
        full_name: this.grantName.trim(),
        institution: this.grantInstitution.trim(),
        field: this.grantField.trim(),
        // `manual` is the admin-issued accreditation method; the backend enum is
        // ['manual','email','orcid'] (an out-of-enum value 422s before the
        // handler). 'manual' marks an operator-granted accreditation.
        method: 'manual',
      };
      this._stageConfirm({
        freshAuthAction: 'admin_grant_accreditation',
        summary: this.$t('admin.confirmGrant', { account: values.account }),
        run: (proof) => adminGrantAccreditation(values, proof),
      });
    },

    requestRetractPaper() {
      if (!this.canSubmitRetract) return;
      const values = {
        author: this.retractAuthor.trim(),
        permlink: this.retractPermlink.trim(),
        reason: this.retractReason.trim(),
      };
      this._stageConfirm({
        freshAuthAction: 'admin_retract_paper',
        summary: this.$t('admin.confirmRetract', { author: values.author, permlink: values.permlink }),
        run: (proof) => adminRetractPaper(values, proof),
      });
    },

    requestRevokeAuthorship() {
      if (!this.canSubmitRevoke) return;
      const values = {
        author: this.revokeAuthor.trim(),
        permlink: this.revokePermlink.trim(),
        claimer: this.revokeClaimer.trim(),
      };
      this._stageConfirm({
        freshAuthAction: 'admin_revoke_authorship',
        summary: this.$t('admin.confirmRevokeAuthorship', { claimer: values.claimer, permlink: values.permlink }),
        run: (proof) => adminRevokeAuthorship(values, proof),
      });
    },

    requestApproveAuthorship() {
      if (!this.canSubmitApprove) return;
      const values = {
        author: this.approveAuthor.trim(),
        permlink: this.approvePermlink.trim(),
        claimer: this.approveClaimer.trim(),
        author_index: Number(this.approveAuthorIndex),
      };
      this._stageConfirm({
        freshAuthAction: 'admin_approve_authorship',
        summary: this.$t('admin.confirmApproveAuthorship', { claimer: values.claimer, permlink: values.permlink }),
        run: (proof) => adminApproveAuthorship(values, proof),
      });
    },

    _stageConfirm({ freshAuthAction, summary, run }) {
      // One in-flight mutation at a time: while a confirm is already staged or a
      // submit is running, ignore new stage requests so a second action cannot
      // overwrite pendingConfirm out from under the first run() closure. The
      // form buttons also :disabled on this state; this is the authoritative
      // backstop behind that UX gate.
      if (this.submitting || this.pendingConfirm) return;
      this.actionError = null;
      this.pendingConfirm = { freshAuthAction, summary, run };
    },

    async runConfirmed() {
      if (!this.pendingConfirm || this.submitting) return;
      this.submitting = true;
      this.actionError = null;
      const { freshAuthAction, run } = this.pendingConfirm;
      try {
        // Per-action fresh re-auth (§ 6.4), not JWT alone. Reuses the settings
        // orchestrator: password modal or ORCID round-trip on the light path;
        // self-custody's per-request Keychain signature is already fresh.
        const outcome = await withSettingsFreshAuth(
          freshAuthAction,
          this._freshAuthCtx(),
          (proof) => run(proof),
        );
        if (!this._mounted) return;
        // ORCID round-trip navigating away, password modal dismissed, or a
        // torn-down corrupted session: abort cleanly (orchestrator already
        // toasted on sessionInconsistent).
        if (outcome.redirect || outcome.cancelled || outcome.sessionInconsistent) {
          this.pendingConfirm = null;
          return;
        }
        if (outcome.freshAuthFailed) {
          this.actionError = this.$t('settings.reauthFailed');
          return;
        }
        this.pendingConfirm = null;
        this._resetForms();
        Alpine.store('toast').show(this.$t('admin.actionSuccess'), 'success');
        // Reflect the mutation: re-read the roster (and viewer tier, which a
        // self-affecting role change could move). No optimistic UI.
        await this.loadRoster();
      } catch (err) {
        if (!this._mounted) return;
        // Sanitization pattern (see settings.handleOrcidLink): raw error to
        // console.warn; _errorMessage surfaces the structured backend reason.
        console.warn('[admin action]', err);
        this.actionError = this._errorMessage(err, 'admin.actionFailed');
      } finally {
        if (this._mounted) this.submitting = false;
      }
    },

    _resetForms() {
      this.promoteAccount = ''; this.promoteLevel = 'admin';
      this.grantAccount = ''; this.grantName = ''; this.grantInstitution = ''; this.grantField = '';
      this.retractAuthor = ''; this.retractPermlink = ''; this.retractReason = '';
      this.revokeAuthor = ''; this.revokePermlink = ''; this.revokeClaimer = '';
      this.approveAuthor = ''; this.approvePermlink = ''; this.approveClaimer = ''; this.approveAuthorIndex = '';
    },
  }));
}
