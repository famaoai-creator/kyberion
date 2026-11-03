import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { WorkItem } from '@agent/core/workforce/work-coordination';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
const h = vi.hoisted(() => ({
  item: {} as WorkItem,
  records: [] as ApprovalRequestRecord[],
  exec: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  buildExecutionEnv: () => ({ MISSION_ID: 'live', KYBERION_CUSTOMER: 'old' }),
  withExecutionContext: (_r: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: { rootResolve: (p: string) => '/repo/' + p, rootDir: () => '/repo' },
}));
vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: () => true,
  safeExecResultAsync: h.exec,
}));
vi.mock('@agent/core/workforce/work-coordination', () => ({ getWorkItem: () => h.item }));
vi.mock('@agent/core/governance/approval-store', () => ({
  listApprovalRequests: () => h.records,
  isApprovalRequestExpired: (r: ApprovalRequestRecord) => Boolean(r.expiresAt),
  computeApprovalPayloadHash: () => 'hash',
}));
vi.mock('@agent/core/mission/mission-admission', () => ({
  buildMissionAdmissionBrief: () => ({}),
  resolveDotMissionAdmission: () => ({}),
  resolveDotMissionAdmissionScope: () => ({
    tenant_slug: 'tenant-a',
    organization_id: 'org-a',
    project_id: 'proj-a',
  }),
}));
import { requestWorkItemMissionAlignment, readWorkItemMissionAlignment } from './mission-alignment';
describe('scoped server mission alignment adapter', () => {
  beforeEach(() => {
    h.item = {
      item_id: 'WI-1',
      version: 7,
      title: 'Title',
      description: 'Intent',
      status: 'blocked',
      priority: 'normal',
      source: 'local',
      source_ref: 'fixture',
      project_id: 'proj-a',
      labels: [],
      dependencies: [],
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
      context: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'proj-a' },
      metadata: {
        mission_id: 'MSN-ONE',
        admission_only: true,
        requested_work_shape: 'mission',
      },
    };
    h.records = [
      {
        id: 'original-request',
        status: 'pending',
        source: { missionId: 'MSN-ONE', taskId: 'WI-1' },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: 'hash',
          effectBinding: 'mission-admission:hash',
        },
        scope: {
          tier: 'confidential',
          tenant_slug: 'tenant-a',
          organization_id: 'org-a',
          project_id: 'proj-a',
          mission_id: 'MSN-ONE',
          task_id: 'WI-1',
        },
      } as ApprovalRequestRecord,
    ];
    h.exec.mockReset();
    h.exec.mockResolvedValue({ status: 0 });
  });
  it('passes only fixed arguments and current server version/scope', async () => {
    expect((await requestWorkItemMissionAlignment(h.item)).admission.requestId).toBe(
      'original-request'
    );
    expect(h.exec.mock.calls[0][1]).toEqual([
      '/repo/dist/scripts/mission_alignment_request.js',
      '--work-item',
      'WI-1',
      '--expected-work-item-version',
      '7',
      '--json',
    ]);
    expect(h.exec.mock.calls[0][2].env).toEqual({
      KYBERION_TENANT: 'tenant-a',
      KYBERION_ORGANIZATION_ID: 'org-a',
    });
  });
  it('reconciles a failed child only from the original exact receipt', async () => {
    h.exec.mockResolvedValue({ status: 1 });
    expect((await requestWorkItemMissionAlignment(h.item)).admission.status).toBe('pending');
    h.records = [];
    await expect(requestWorkItemMissionAlignment(h.item)).rejects.toThrow('held');
  });
  it('does not trust successful stdout without exact evidence', async () => {
    h.records = [];
    await expect(requestWorkItemMissionAlignment(h.item)).rejects.toThrow('no matching');
  });
  it('rejects scope change across the child boundary', async () => {
    const before = structuredClone(h.item);
    h.exec.mockImplementation(async () => {
      h.item.context!.project_id = 'other';
      return { status: 0 };
    });
    await expect(requestWorkItemMissionAlignment(before)).rejects.toThrow('changed');
  });
  it.each(['tenant_slug', 'organization_id', 'project_id'] as const)(
    'rejects mismatched receipt %s',
    async (axis) => {
      h.records[0].scope![axis] = 'other';
      await expect(requestWorkItemMissionAlignment(h.item)).rejects.toThrow('no matching');
    }
  );
  it('requires human-only confidential receipt', () => {
    h.records[0].accountability = undefined;
    expect(() => readWorkItemMissionAlignment(h.item)).toThrow();
  });
  it.each(['rejected', 'expired'] as const)(
    'reads %s without any subprocess or new approval',
    (status) => {
      h.records[0].status = status;
      expect(readWorkItemMissionAlignment(h.item).admission.status).toBe(status);
      expect(h.exec).not.toHaveBeenCalled();
    }
  );
});
