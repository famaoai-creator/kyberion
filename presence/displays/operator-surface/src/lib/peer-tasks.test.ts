import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-viewer-scope-contract';
import { readOperatorPeerTasks } from './peer-tasks';

const { listPeerTasks, listWorkItems } = vi.hoisted(() => ({
  listPeerTasks: vi.fn(),
  listWorkItems: vi.fn(),
}));
vi.mock('@agent/core/mesh/peer-task-exchange', () => ({ listPeerTasks }));
vi.mock('@agent/core/workforce/work-coordination', () => ({ listWorkItems }));

const viewer: SurfaceViewerScope = {
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential'],
  source: 'token',
};

const completed = {
  task_id: 'PTK-completed',
  tenant_id: 'acme',
  local_peer_id: 'receiver',
  remote_peer_id: 'sender',
  task_type: 'report',
  state: 'completed',
  work_item_id: 'work-1',
  result: { artifacts: [{ ref: 'report.md', sha256: 'a'.repeat(64), bytes: 10 }] },
};

describe('readOperatorPeerTasks', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rejects unauthorized scope and invalid peers before querying the ledger', () => {
    expect(readOperatorPeerTasks(viewer, 'other', 'receiver')).toEqual([]);
    expect(readOperatorPeerTasks(viewer, undefined, 'receiver')).toEqual([]);
    expect(readOperatorPeerTasks(viewer, 'acme', '../receiver')).toEqual([]);
    expect(
      readOperatorPeerTasks({ ...viewer, tierAccess: ['public'] }, 'acme', 'receiver')
    ).toEqual([]);
    expect(readOperatorPeerTasks({ ...viewer, projectIds: ['one'] }, 'acme', 'receiver')).toEqual(
      []
    );
    expect(
      readOperatorPeerTasks({ ...viewer, organizationIds: ['one'] }, 'acme', 'receiver')
    ).toEqual([]);
    expect(listPeerTasks).not.toHaveBeenCalled();
    expect(listWorkItems).not.toHaveBeenCalled();
  });

  it('projects expired, pending and completed tasks for the recipient', () => {
    listPeerTasks.mockReturnValue([
      {
        ...completed,
        task_id: 'PTK-pending',
        state: 'pending',
        expires_at: '9999-01-01',
        work_item_id: undefined,
        result: undefined,
      },
      {
        ...completed,
        task_id: 'PTK-expired',
        state: 'pending',
        expires_at: '2000-01-01',
        work_item_id: undefined,
        result: undefined,
      },
      { ...completed, tenant_id: 'other' },
      completed,
    ]);
    listWorkItems.mockReturnValue([
      {
        item_id: 'work-1',
        status: 'done',
        source: 'peer',
        source_ref: 'peer-task:PTK-completed',
        context: { tenant_slug: 'acme' },
      },
    ]);
    const rows = readOperatorPeerTasks(viewer, 'acme', 'receiver');
    expect(listPeerTasks).toHaveBeenCalledWith('acme', 'receiver', { direction: 'inbound' });
    expect(listWorkItems).toHaveBeenCalledWith({
      tenantSlugs: ['acme'],
      source: 'peer',
      assigneePeerId: 'receiver',
    });
    expect(rows.map((row) => row.state)).toEqual(['completed', 'expired', 'pending']);
    expect(rows[0]).toMatchObject({
      workItem: { id: 'work-1', status: 'done' },
      artifacts: completed.result.artifacts,
    });
  });

  it('omits WorkItems that belong to another tenant or another task', () => {
    listPeerTasks.mockReturnValue([completed]);
    for (const [tenant, task] of [
      ['other', 'PTK-completed'],
      ['acme', 'PTK-another'],
    ]) {
      listWorkItems.mockReturnValue([
        {
          item_id: 'work-1',
          status: 'done',
          source: 'peer',
          source_ref: `peer-task:${task}`,
          context: { tenant_slug: tenant },
        },
      ]);
      expect(readOperatorPeerTasks(viewer, 'acme', 'receiver')[0]?.workItem).toBeNull();
    }
  });
});
