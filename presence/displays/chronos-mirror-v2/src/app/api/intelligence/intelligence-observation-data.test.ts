import { beforeEach, describe, expect, it, vi } from 'vitest';

const missionStateMocks = vi.hoisted(() => ({
  loadState: vi.fn(),
}));

vi.mock('@agent/core/mission-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/mission-state')>();
  return {
    ...actual,
    listMissionsInSearchDirs: () => [
      { missionId: 'MSN-CONFIDENTIAL', missionPath: '/missions/MSN-CONFIDENTIAL' },
    ],
    loadState: missionStateMocks.loadState,
  };
});

import { approvalVisibleToScope } from './intelligence-control-data';
import { missionVisibleToScope } from './intelligence-observation-data';

describe('intelligence observation viewer scope', () => {
  beforeEach(() => {
    missionStateMocks.loadState.mockReturnValue({
      tenant_slug: 'tenant-a',
      tier: 'confidential',
    });
  });

  it('rejects a confidential mission for a public-only viewer', () => {
    expect(missionVisibleToScope('MSN-CONFIDENTIAL', 'all', ['public'])).toBe(false);
  });

  it('requires both tenant and tier scope for mission observations', () => {
    expect(missionVisibleToScope('MSN-CONFIDENTIAL', ['tenant-a'], ['confidential'])).toBe(true);
    expect(missionVisibleToScope('MSN-CONFIDENTIAL', ['tenant-b'], ['confidential'])).toBe(false);
  });

  it('treats missionless approvals as confidential', () => {
    expect(approvalVisibleToScope({ tenantSlug: 'tenant-a' }, 'all', ['public'])).toBe(false);
    expect(approvalVisibleToScope({ tenantSlug: 'tenant-a' }, 'all', ['confidential'])).toBe(true);
  });
});
