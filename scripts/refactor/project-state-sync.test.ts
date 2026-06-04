import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadState: vi.fn(),
  syncProjectOperationalStateFromMission: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual('@agent/core') as any;
  return {
    ...actual,
    syncProjectOperationalStateFromMission: mocks.syncProjectOperationalStateFromMission,
  };
});

vi.mock('./mission-state.js', () => ({
  loadState: mocks.loadState,
}));

describe('syncProjectOperationalStateIfLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when a mission is not linked to a project', async () => {
    mocks.loadState.mockReturnValue({
      mission_id: 'MSN-UNLINKED',
      relationships: {},
    });

    const { syncProjectOperationalStateIfLinked } = await import('./project-state-sync.js');
    await syncProjectOperationalStateIfLinked('MSN-UNLINKED');

    expect(mocks.syncProjectOperationalStateFromMission).not.toHaveBeenCalled();
  });

  it('syncs linked mission state into the project operational state store', async () => {
    mocks.loadState.mockReturnValue({
      mission_id: 'MSN-LINKED',
      mission_type: 'development',
      tier: 'public',
      status: 'active',
      tenant_slug: 'tenant-alpha',
      tenant_id: 'tenant-alpha',
      assigned_persona: 'worker',
      relationships: {
        project: {
          project_id: 'PRJ-OPS',
          project_path: 'active/projects/public/tenant-alpha/PRJ-OPS/project-os/project.json',
          note: 'ops mission',
        },
      },
      context: {},
      outcome_contract: {},
    });

    const { syncProjectOperationalStateIfLinked } = await import('./project-state-sync.js');
    await syncProjectOperationalStateIfLinked('MSN-LINKED');

    expect(mocks.syncProjectOperationalStateFromMission).toHaveBeenCalledWith(
      expect.objectContaining({
        mission_id: 'MSN-LINKED',
        relationships: expect.objectContaining({
          project: expect.objectContaining({
            project_id: 'PRJ-OPS',
          }),
        }),
      }),
    );
  });
});
