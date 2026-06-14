import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchAdminRoster = vi.fn();
const mockPromoteAdmin = vi.fn();
const mockDemoteAdmin = vi.fn();
const mockAdminGrantAccreditation = vi.fn();
const mockAdminRetractPaper = vi.fn();
const mockAdminRevokeAuthorship = vi.fn();
const mockAdminApproveAuthorship = vi.fn();
const mockFetchEmailStatus = vi.fn();

vi.mock('../../src/api.js', () => ({
  fetchAdminRoster: (...a) => mockFetchAdminRoster(...a),
  promoteAdmin: (...a) => mockPromoteAdmin(...a),
  demoteAdmin: (...a) => mockDemoteAdmin(...a),
  adminGrantAccreditation: (...a) => mockAdminGrantAccreditation(...a),
  adminRetractPaper: (...a) => mockAdminRetractPaper(...a),
  adminRevokeAuthorship: (...a) => mockAdminRevokeAuthorship(...a),
  adminApproveAuthorship: (...a) => mockAdminApproveAuthorship(...a),
  fetchEmailStatus: (...a) => mockFetchEmailStatus(...a),
}));

// The fresh-auth orchestrator is unit-tested elsewhere; here it is mocked with a
// self-custody-style pass-through (calls run() with no proof, wraps in { ok }).
// Individual tests override it to return { redirect } / { freshAuthFailed } etc.
const mockWithSettingsFreshAuth = vi.fn(async (_action, _ctx, run) => ({ ok: await run(undefined) }));
vi.mock('../../src/lib/settings-fresh-auth.js', () => ({
  withSettingsFreshAuth: (...a) => mockWithSettingsFreshAuth(...a),
}));

vi.mock('../../src/components/paper-card.js', () => ({ formatDate: (d) => d || '' }));

const mockAuthStore = {
  isConnected: true,
  username: 'alice',
  custody: 'light',
};
const mockRouterStore = { navigate: vi.fn() };
const mockToastStore = { show: vi.fn() };

vi.mock('alpinejs', () => ({
  default: {
    data: vi.fn(),
    store: vi.fn((name) => {
      if (name === 'auth') return mockAuthStore;
      if (name === 'router') return mockRouterStore;
      if (name === 'toast') return mockToastStore;
      return {};
    }),
  },
}));

import Alpine from 'alpinejs';
import { initAdminPage } from '../../src/pages/admin.js';

function createComponent() {
  initAdminPage();
  const factory = Alpine.data.mock.calls[Alpine.data.mock.calls.length - 1][1];
  const comp = factory();
  comp.$t = (key) => key;
  comp.$watch = vi.fn();
  return comp;
}

describe('adminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithSettingsFreshAuth.mockImplementation(async (_action, _ctx, run) => ({ ok: await run(undefined) }));
    mockAuthStore.isConnected = true;
    mockAuthStore.username = 'alice';
    mockAuthStore.custody = 'light';
    mockFetchEmailStatus.mockResolvedValue({ data: { hasPassword: true } });
  });

  describe('tier gating', () => {
    it('canManageRoster is false for plain admin, true for super_admin and root', () => {
      const comp = createComponent();
      comp.tier = 'admin';
      expect(comp.canManageRoster).toBe(false);
      comp.tier = 'super_admin';
      expect(comp.canManageRoster).toBe(true);
      comp.tier = 'root';
      expect(comp.canManageRoster).toBe(true);
    });

    it('manageableLevels: super_admin manages admin; root manages admin + super_admin', () => {
      const comp = createComponent();
      comp.tier = 'admin';
      expect(comp.manageableLevels).toEqual([]);
      comp.tier = 'super_admin';
      expect(comp.manageableLevels).toEqual(['admin']);
      comp.tier = 'root';
      expect(comp.manageableLevels).toEqual(['admin', 'super_admin']);
    });
  });

  describe('canDemoteRow (lockout safety)', () => {
    it('allows demoting a manageable non-self, non-root member', () => {
      const comp = createComponent();
      comp.tier = 'super_admin';
      expect(comp.canDemoteRow({ account: 'bob', level: 'admin' })).toBe(true);
    });

    it('never allows demoting root', () => {
      const comp = createComponent();
      comp.tier = 'root';
      expect(comp.canDemoteRow({ account: 'sysroot', level: 'root' })).toBe(false);
    });

    it('never allows self-demotion (no self-lockout)', () => {
      const comp = createComponent();
      comp.tier = 'root';
      expect(comp.canDemoteRow({ account: 'alice', level: 'super_admin' })).toBe(false);
    });

    it('does not allow demoting a level above the viewer capability', () => {
      const comp = createComponent();
      comp.tier = 'super_admin'; // can manage admin only
      expect(comp.canDemoteRow({ account: 'carol', level: 'super_admin' })).toBe(false);
    });
  });

  describe('loadRoster', () => {
    it('sets tier and roster from the response', async () => {
      mockFetchAdminRoster.mockResolvedValue({ data: { tier: 'super_admin', roster: [{ account: 'bob', level: 'admin' }] } });
      const comp = createComponent();
      await comp.loadRoster();
      expect(comp.tier).toBe('super_admin');
      expect(comp.roster).toEqual([{ account: 'bob', level: 'admin' }]);
      expect(comp.loading).toBe(false);
    });

    it('null tier (not in roster) leaves the not-authorized state', async () => {
      mockFetchAdminRoster.mockResolvedValue({ data: { tier: null, roster: [] } });
      const comp = createComponent();
      await comp.loadRoster();
      expect(comp.tier).toBeNull();
      expect(comp.loadError).toBeNull();
    });

    it('sanitizes a load failure: generic message to DOM, raw err to console.warn', async () => {
      const leaky = new Error('db secret=deadbeefcafebabe');
      mockFetchAdminRoster.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      await comp.loadRoster();
      expect(comp.loadError).toBe('admin.loadFailed');
      expect(comp.loadError).not.toContain('deadbeef');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      warnSpy.mockRestore();
    });
  });

  describe('form validation', () => {
    it('canSubmitGrant requires all four fields', () => {
      const comp = createComponent();
      comp.grantAccount = 'bob'; comp.grantName = 'Bob'; comp.grantInstitution = 'MIT'; comp.grantField = '';
      expect(comp.canSubmitGrant).toBe(false);
      comp.grantField = 'Physics';
      expect(comp.canSubmitGrant).toBe(true);
    });

    it('canSubmitApprove requires a non-negative author index', () => {
      const comp = createComponent();
      comp.approveAuthor = 'a'; comp.approvePermlink = 'p'; comp.approveClaimer = 'c';
      comp.approveAuthorIndex = '';
      expect(comp.canSubmitApprove).toBe(false);
      comp.approveAuthorIndex = '0';
      expect(comp.canSubmitApprove).toBe(true);
    });
  });

  describe('confirm staging', () => {
    it('requestPromote stages a pendingConfirm bound to the admin_grant_role action', () => {
      const comp = createComponent();
      comp.tier = 'super_admin';
      comp.promoteAccount = '  bob  ';
      comp.promoteLevel = 'admin';
      comp.requestPromote();
      expect(comp.pendingConfirm).toBeTruthy();
      expect(comp.pendingConfirm.freshAuthAction).toBe('admin_grant_role');
    });

    it('requestDemote refuses to stage for a non-demotable row', () => {
      const comp = createComponent();
      comp.tier = 'super_admin';
      comp.requestDemote({ account: 'alice', level: 'super_admin' }); // self + unmanageable
      expect(comp.pendingConfirm).toBeNull();
    });

    it('requestGrantAccreditation stages the trimmed payload via its run closure', async () => {
      mockAdminGrantAccreditation.mockResolvedValue({ status: 'ok', data: {} });
      const comp = createComponent();
      comp.tier = 'admin';
      comp.grantAccount = '  bob '; comp.grantName = ' Bob '; comp.grantInstitution = ' MIT '; comp.grantField = ' Physics ';
      comp.requestGrantAccreditation();
      expect(comp.pendingConfirm.freshAuthAction).toBe('admin_grant_accreditation');
      // Execute the staged run closure to confirm the trimmed payload shape.
      await comp.pendingConfirm.run('proof-token');
      expect(mockAdminGrantAccreditation).toHaveBeenCalledWith(
        { account: 'bob', full_name: 'Bob', institution: 'MIT', field: 'Physics', method: 'admin' },
        'proof-token',
      );
    });
  });

  describe('runConfirmed', () => {
    function stagePromote(comp) {
      comp.tier = 'super_admin';
      comp.promoteAccount = 'bob';
      comp.promoteLevel = 'admin';
      comp.requestPromote();
    }

    it('happy path: runs the action with the staged fresh-auth action, toasts, reloads, resets', async () => {
      mockPromoteAdmin.mockResolvedValue({ status: 'ok', data: {} });
      mockFetchAdminRoster.mockResolvedValue({ data: { tier: 'super_admin', roster: [] } });
      const comp = createComponent();
      stagePromote(comp);
      await comp.runConfirmed();
      expect(mockWithSettingsFreshAuth).toHaveBeenCalledWith(
        'admin_grant_role',
        expect.objectContaining({ custody: 'light', username: 'alice' }),
        expect.any(Function),
      );
      expect(mockPromoteAdmin).toHaveBeenCalledWith('bob', 'admin', undefined);
      expect(mockToastStore.show).toHaveBeenCalledWith('admin.actionSuccess', 'success');
      expect(comp.pendingConfirm).toBeNull();
      expect(comp.promoteAccount).toBe('');
      expect(mockFetchAdminRoster).toHaveBeenCalled(); // reload
    });

    it('freshAuthFailed surfaces reauthFailed and keeps the confirm panel open', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ freshAuthFailed: true });
      const comp = createComponent();
      stagePromote(comp);
      await comp.runConfirmed();
      expect(comp.actionError).toBe('settings.reauthFailed');
      expect(comp.pendingConfirm).toBeTruthy();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    it('redirect (ORCID round-trip) clears the panel without toast', async () => {
      mockWithSettingsFreshAuth.mockResolvedValueOnce({ redirect: true });
      const comp = createComponent();
      stagePromote(comp);
      await comp.runConfirmed();
      expect(comp.pendingConfirm).toBeNull();
      expect(mockToastStore.show).not.toHaveBeenCalled();
    });

    it('sanitizes an action failure: generic message, raw err to console.warn', async () => {
      const leaky = new Error('chain rpc token=deadbeefcafebabe');
      mockPromoteAdmin.mockRejectedValue(leaky);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const comp = createComponent();
      stagePromote(comp);
      await comp.runConfirmed();
      expect(comp.actionError).toBe('admin.actionFailed');
      expect(comp.actionError).not.toContain('deadbeef');
      expect(warnSpy.mock.calls[0][1]).toBe(leaky);
      expect(comp.submitting).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('tierLabel', () => {
    it('maps tier keys to i18n label keys', () => {
      const comp = createComponent();
      expect(comp.tierLabel('admin')).toBe('admin.tierAdmin');
      expect(comp.tierLabel('super_admin')).toBe('admin.tierSuperAdmin');
      expect(comp.tierLabel('root')).toBe('admin.tierRoot');
      expect(comp.tierLabel('')).toBe('');
    });
  });
});
