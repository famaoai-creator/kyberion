import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConciergeViewerContext } from './viewer-context';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
const mocks = vi.hoisted(() => ({
  binding: vi.fn(),
  principal: vi.fn(),
  bindingId: vi.fn(),
  status: vi.fn(),
}));
vi.mock('@agent/core/service/service-binding-registry', () => ({
  loadServiceBindingRecord: mocks.binding,
}));
vi.mock('@agent/core/secret/account-introduction', () => ({
  ACCOUNT_INTRODUCTION_CHANNEL: 'account-introduction',
  accountIntroductionApprovalBindingId: mocks.bindingId,
  reviewAccountIntroductionApproval: mocks.status,
}));
vi.mock('./onboarding-authority-server', () => ({
  asOnboardingOwner: (run: () => unknown) => run(),
  onboardingAuthorityPrincipal: mocks.principal,
}));
import {
  accountIntroductionAccess,
  accountIntroductionApprovalMember,
} from './account-introduction-server';
const viewer = { role: 'localadmin' } as ConciergeViewerContext;
const record = { channel: 'account-introduction', id: 'id' } as ApprovalRequestRecord;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.binding.mockReturnValue({ owner_kind: 'person', owner_ref: 'user:owner' });
  mocks.principal.mockReturnValue({ accountableId: 'user:owner' });
  mocks.bindingId.mockReturnValue('selected');
  mocks.status.mockReturnValue({ ok: true });
});
describe('account approval owner adapter', () => {
  it('uses the stored tenant for membership admission', () => {
    mocks.binding.mockReturnValue({
      owner_kind: 'organization',
      owner_ref: 'actual',
      tenant_slug: 'actual',
    });
    accountIntroductionAccess(viewer, 'selected');
    expect(mocks.principal).toHaveBeenCalledWith(viewer, {
      kind: 'organization',
      tenant_slug: 'actual',
    });
  });
  it('rejects another person and never enters generic approval fallback for its own family', () => {
    mocks.binding.mockReturnValue({ owner_kind: 'person', owner_ref: 'user:other' });
    expect(accountIntroductionApprovalMember(viewer, record)).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it.each([undefined, 'operator'])('rejects undeclared/operator ownership (%s)', (owner_kind) => {
    mocks.binding.mockReturnValue({ owner_kind });
    expect(() => accountIntroductionAccess(viewer, 'selected')).toThrow();
  });
  it('requires the exact stored approval plan to validate before naming a decider', () => {
    mocks.status.mockImplementation(() => {
      throw new Error('changed plan');
    });
    expect(accountIntroductionApprovalMember(viewer, record)).toBeNull();
    expect(
      accountIntroductionApprovalMember(viewer, { ...record, channel: 'elsewhere' })
    ).toBeUndefined();
  });
  it('returns the authenticated accountable owner only after validation', () => {
    expect(accountIntroductionApprovalMember(viewer, record)).toMatchObject({
      id: 'user:owner',
      role: 'owner',
    });
    expect(mocks.status).toHaveBeenCalledWith({ accountableId: 'user:owner' }, 'selected', 'id');
  });
});
