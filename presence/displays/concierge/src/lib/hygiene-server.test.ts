import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectMissionHygieneReport: vi.fn(),
}));

vi.mock('@agent/core/mission-hygiene', () => ({
  collectMissionHygieneReport: mocks.collectMissionHygieneReport,
}));

vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: { findMissionPath: () => undefined, rootDir: () => '/repo' },
}));

vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: () => false,
  withSensitivePathMediation: (fn: () => unknown) => fn(),
}));

vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));

import { listHygieneInquiries } from './hygiene-server';

const viewer = (
  tenantSlugs: string[] | 'all',
  tierAccess: Array<'personal' | 'confidential' | 'public'>
) => ({
  role: 'localadmin' as const,
  tenantSlugs,
  organizationIds: 'all' as const,
  projectIds: 'all' as const,
  tierAccess,
  source: 'token' as const,
});

describe('Concierge hygiene viewer scope', () => {
  it('hides unknown and out-of-scope findings instead of relabelling them public', () => {
    mocks.collectMissionHygieneReport.mockReturnValue({
      abandoned: [
        {
          mission_id: 'MSN-ACME',
          tier: 'confidential',
          tenant_slug: 'acme',
          reason: 'awaiting_gate',
          age_days: 20,
        },
        {
          mission_id: 'MSN-BETA',
          tier: 'confidential',
          tenant_slug: 'beta',
          reason: 'awaiting_gate',
          age_days: 20,
        },
        {
          mission_id: 'MSN-LEGACY',
          tier: 'legacy',
          tenant_slug: 'acme',
          reason: 'awaiting_gate',
          age_days: 20,
        },
      ],
      stale: [],
    });

    const result = listHygieneInquiries(viewer(['acme'], ['confidential', 'public']));

    expect(result.map((entry) => entry.mission_id)).toEqual(['MSN-ACME']);
    expect(result[0]?.tier).toBe('confidential');
  });
});
