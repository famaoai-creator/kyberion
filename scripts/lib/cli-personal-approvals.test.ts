import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';

const {
  inspectInstalledIdentity,
  withLocalAuthorityPrincipal,
  withAuthenticatedPersonalApprovals,
} = vi.hoisted(() => ({
  inspectInstalledIdentity: vi.fn(),
  withLocalAuthorityPrincipal: vi.fn(),
  withAuthenticatedPersonalApprovals: vi.fn(),
}));

vi.mock('./installed-identity.js', () => ({ inspectInstalledIdentity }));
vi.mock('./authority-principal.js', () => ({ withLocalAuthorityPrincipal }));
vi.mock('@agent/core/organization/onboarding-authority', () => ({
  ONBOARDING_AUTHORITY_CHANNEL: 'onboarding-authority',
}));
vi.mock('@agent/core/governance/authenticated-personal-approvals', () => ({
  withAuthenticatedPersonalApprovals,
}));

import {
  cliApprovalStoreScope,
  listCliPendingApprovals,
  withCliPersonalApprovals,
} from './cli-personal-approvals.js';

const OWNER = { requesterId: 'r', accountableId: 'user:owner', personalOwner: true };
const record = (id: string, scope?: ApprovalRequestRecord['scope']) =>
  ({ id, storageChannel: 'onboarding-authority', scope }) as unknown as ApprovalRequestRecord;
const personal = record('p-1', { tier: 'personal', scope_kind: 'system' } as never);
const tenant = record('t-1', { tier: 'confidential', tenant_slug: 'acme' } as never);
// Personal credential consent carries an owner workflow role the terminal does not settle.
const consent = {
  ...personal,
  id: 'g-1',
  storageChannel: 'grant-standing',
} as unknown as ApprovalRequestRecord;

/** The personal scope is open: run executes inside it, marked by `inPersonal`. */
let inPersonal = false;
function openScope() {
  inspectInstalledIdentity.mockReturnValue({ source: 'local', ready: true });
  withLocalAuthorityPrincipal.mockImplementation((_argv, run) => run(OWNER));
  withAuthenticatedPersonalApprovals.mockImplementation((_principal, run) => {
    inPersonal = true;
    try {
      return run();
    } finally {
      inPersonal = false;
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inPersonal = false;
});

describe('withCliPersonalApprovals', () => {
  it('runs inside the authenticated personal scope of the local owner', () => {
    openScope();
    expect(withCliPersonalApprovals(() => inPersonal)).toEqual({ value: true });
    expect(withAuthenticatedPersonalApprovals).toHaveBeenCalledWith(OWNER, expect.any(Function));
  });

  it('stays closed for an installation-backed or unidentified checkout', () => {
    for (const source of ['installation', 'unavailable']) {
      inspectInstalledIdentity.mockReturnValue({ source });
      expect(withCliPersonalApprovals(() => 1)).toBeNull();
    }
    expect(withLocalAuthorityPrincipal).not.toHaveBeenCalled();
  });

  it('stays closed for a local checkout that has not completed identity onboarding', () => {
    inspectInstalledIdentity.mockReturnValue({ source: 'local', ready: false });
    expect(withCliPersonalApprovals(() => 1)).toBeNull();
    expect(withLocalAuthorityPrincipal).not.toHaveBeenCalled();
  });

  it('stays closed when the owner identity is not onboarded or the scope is refused', () => {
    inspectInstalledIdentity.mockReturnValue({ source: 'local', ready: true });
    withLocalAuthorityPrincipal.mockImplementation(() => {
      throw new Error('Complete reviewed identity onboarding first.');
    });
    expect(withCliPersonalApprovals(() => 1)).toBeNull();
    withLocalAuthorityPrincipal.mockImplementation((_argv, run) => run(OWNER));
    withAuthenticatedPersonalApprovals.mockReturnValue(null);
    expect(withCliPersonalApprovals(() => 1)).toBeNull();
  });

  it("propagates the caller's own failure instead of reporting a closed scope", () => {
    openScope();
    expect(() =>
      withCliPersonalApprovals(() => {
        throw new Error('decision refused');
      })
    ).toThrow('decision refused');
  });
});

describe('listCliPendingApprovals', () => {
  it('adds personal-partition records the ordinary listing cannot see', () => {
    openScope();
    const list = vi.fn(() => (inPersonal ? [tenant, personal] : [tenant]));
    expect(listCliPendingApprovals(list).map((r) => r.id)).toEqual(['t-1', 'p-1']);
  });

  it('leaves personal channels the terminal cannot settle to Concierge', () => {
    openScope();
    const list = () => (inPersonal ? [personal, consent] : []);
    expect(listCliPendingApprovals(list).map((r) => r.id)).toEqual(['p-1']);
    expect(cliApprovalStoreScope(consent)).toBeUndefined();
    // …also when an explicit personal env already put it in the ordinary listing.
    expect(listCliPendingApprovals(() => [tenant, consent]).map((r) => r.id)).toEqual(['t-1']);
  });

  it('does not duplicate a personal record already listed (explicit personal env)', () => {
    openScope();
    expect(listCliPendingApprovals(() => [personal]).map((r) => r.id)).toEqual(['p-1']);
  });

  it('returns the ordinary listing when the personal scope is closed', () => {
    inspectInstalledIdentity.mockReturnValue({ source: 'unavailable' });
    expect(listCliPendingApprovals(() => [tenant]).map((r) => r.id)).toEqual(['t-1']);
  });
});

describe('cliApprovalStoreScope', () => {
  it('opens the personal scope only for personal-partition records', () => {
    openScope();
    expect(cliApprovalStoreScope(tenant)).toBeUndefined();
    expect(cliApprovalStoreScope(personal)!(() => inPersonal)).toBe(true);
  });

  it('refuses a personal decision when the scope cannot be opened', () => {
    inspectInstalledIdentity.mockReturnValue({ source: 'unavailable' });
    expect(() => cliApprovalStoreScope(personal)!(() => 1)).toThrow(/personal approvals/);
  });
});
