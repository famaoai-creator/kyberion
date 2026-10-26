import { describe, expect, it, vi } from 'vitest';
import {
  executeMcpMissionLifecycle,
  MCP_MISSION_LIFECYCLE_OPERATIONS,
  type MissionLifecycleToolDeps,
} from './mcp-mission-lifecycle.js';
import type { McpRequestContext } from '@agent/core/mcp-request-context';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as paths from '@agent/core/path-resolver';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import * as authority from '@agent/core/authority';

const serviceActorId = `service:mcp-owner-${createHash('sha256').update('operator-alice').digest('hex').slice(0, 16)}`;
const context: McpRequestContext = {
  principal: 'operator-alice',
  caller_role: 'operator',
  scope: {
    scope_kind: 'mission',
    tier: 'confidential',
    tenant_slug: 'tenant-a',
    mission_id: 'MSN-MCP-TOOLS',
  },
};
const reviewerContext: McpRequestContext = { ...context, nhi_id: 'agent:mcp-reviewer' };
function deps() {
  return {
    state: vi.fn(
      () =>
        ({
          mission_id: 'MSN-MCP-TOOLS',
          tier: 'confidential',
          tenant_slug: 'tenant-a',
        }) as ReturnType<NonNullable<MissionLifecycleToolDeps['state']>>
    ),
    approve: vi.fn((_input: Parameters<MissionLifecycleToolDeps['approve']>[0]) => ({
      allowed: true,
      status: 'approved',
    })),
    ownerBinding: vi.fn(() => ({ missionId: 'MSN-MCP-TOOLS', role: 'mission_controller' })),
    snapshot: vi.fn(() => 'mission-and-artifact-snapshot'),
    reserve: vi.fn(() => 'apply-claim-1'),
    settle: vi.fn(),
    execute: vi.fn(async (_argv: string[], _env: NodeJS.ProcessEnv) => 'controller completed'),
  };
}
describe('governed mission lifecycle MCP tools', () => {
  it.each(MCP_MISSION_LIFECYCLE_OPERATIONS)(
    'routes %s through typed controller argv with authenticated actor',
    async (operation) => {
      const ports = deps();
      const callContext = operation === 'review_task' ? reviewerContext : context;
      const actorId = callContext.nhi_id ?? serviceActorId;
      const result = await executeMcpMissionLifecycle(
        operation,
        {
          mission_id: 'MSN-MCP-TOOLS',
          task_id: 'review-task',
          note: 'verified evidence',
          result: 'verified',
          findings: [],
          approval_ref: 'approval-lifecycle',
        },
        callContext,
        ports
      );
      expect(result).toMatchObject({ status: 'executed', mission_id: 'MSN-MCP-TOOLS' });
      expect(ports.approve).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            actor_id: actorId,
            actor_type: callContext.nhi_id ? 'agent' : 'service',
            mission_snapshot: 'mission-and-artifact-snapshot',
          }),
          effectBinding: `mission.${operation}:MSN-MCP-TOOLS:review-task`,
        })
      );
      const [argv, env] = ports.execute.mock.calls[0]!;
      expect(argv[1]).toBe('MSN-MCP-TOOLS');
      expect(env).toMatchObject({ MISSION_ID: 'MSN-MCP-TOOLS', KYBERION_TENANT: 'tenant-a' });
      if (operation === 'record_evidence' || operation === 'review_task')
        expect(argv).toContain(actorId);
      if (operation === 'record_evidence') expect(argv).toContain('service');
      expect(ports.reserve).toHaveBeenCalledOnce();
      expect(ports.settle).toHaveBeenCalledWith(
        'approval-lifecycle',
        'apply-claim-1',
        actorId,
        'success'
      );
    }
  );
  it('parks before execution until the scope-bound approval is usable', async () => {
    const ports = deps();
    ports.approve.mockReturnValue({
      allowed: false,
      status: 'approval_required',
      request_id: 'approval-lifecycle',
    } as ReturnType<MissionLifecycleToolDeps['approve']>);
    expect(
      await executeMcpMissionLifecycle('finish', { mission_id: 'MSN-MCP-TOOLS' }, context, ports)
    ).toEqual({ status: 'approval_required', request_id: 'approval-lifecycle' });
    expect(ports.execute).not.toHaveBeenCalled();
  });
  it.each(['cowork', 'unknown'] as const)(
    'does not give mission-wide authority to %s callers',
    async (role) => {
      const ports = deps();
      await expect(
        executeMcpMissionLifecycle(
          'verify',
          { mission_id: 'MSN-MCP-TOOLS', result: 'verified', note: 'self approved' },
          { ...context, caller_role: role },
          ports
        )
      ).rejects.toThrow(/MCP_CALLER_ROLE/);
      expect(ports.approve).not.toHaveBeenCalled();
      expect(ports.execute).not.toHaveBeenCalled();
    }
  );
  it('does not infer mission ownership from an operator role or client mission scope', async () => {
    const ports = deps();
    ports.ownerBinding.mockReturnValue({ missionId: 'MSN-OTHER', role: 'mission_controller' });
    await expect(
      executeMcpMissionLifecycle('distill', { mission_id: 'MSN-MCP-TOOLS' }, context, ports)
    ).rejects.toThrow('MCP_MISSION_OWNER_REQUIRED');
    ports.ownerBinding.mockReturnValue({ missionId: 'MSN-MCP-TOOLS', role: 'operator' });
    await expect(
      executeMcpMissionLifecycle('distill', { mission_id: 'MSN-MCP-TOOLS' }, context, ports)
    ).rejects.toThrow('MCP_MISSION_OWNER_REQUIRED');
    expect(ports.state).not.toHaveBeenCalled();
    expect(ports.approve).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
  });
  it('checks the actual server identity binding rather than a copied client mission', async () => {
    const ports = deps();
    const identity = vi.spyOn(authority, 'resolveIdentityContext').mockReturnValue({
      missionId: 'MSN-SIBLING',
      role: 'mission_controller',
      persona: 'worker',
      authorities: [],
      executionMode: 'mission',
    });
    try {
      await expect(
        executeMcpMissionLifecycle('distill', { mission_id: 'MSN-MCP-TOOLS' }, context, {
          ...ports,
          ownerBinding: undefined,
        })
      ).rejects.toThrow('MCP_MISSION_OWNER_REQUIRED');
      expect(ports.state).not.toHaveBeenCalled();
      expect(ports.reserve).not.toHaveBeenCalled();
    } finally {
      identity.mockRestore();
    }
  });
  it('requires truthful owner-agent identity and never stamps it as a human', async () => {
    const ports = deps();
    const args = {
      mission_id: 'MSN-MCP-TOOLS',
      task_id: 'implement',
      note: 'agent wrote evidence',
      approval_ref: 'approval-lifecycle',
    };
    await expect(
      executeMcpMissionLifecycle(
        'record_evidence',
        args,
        { ...context, caller_role: 'agent' },
        ports
      )
    ).rejects.toThrow('MCP_MISSION_ACTOR_REQUIRED');
    await executeMcpMissionLifecycle(
      'record_evidence',
      args,
      { ...context, caller_role: 'agent', nhi_id: 'kyberion://agent/org/owner' },
      ports
    );
    const argv = ports.execute.mock.calls[0]![0];
    expect(argv).toContain('kyberion://agent/org/owner');
    expect(argv).toContain('agent');
    expect(argv).not.toContain('human');
  });
  it('consumes one approval at most once and refuses a replay before a second effect', async () => {
    const ports = deps();
    let claimed = false;
    ports.reserve.mockImplementation(() => {
      if (claimed) throw new Error('Approval apply already started');
      claimed = true;
      return 'apply-claim-1';
    });
    const args = { mission_id: 'MSN-MCP-TOOLS', approval_ref: 'approval-lifecycle' };
    await executeMcpMissionLifecycle('distill', args, context, ports);
    await expect(executeMcpMissionLifecycle('distill', args, context, ports)).rejects.toThrow(
      'already started'
    );
    expect(ports.execute).toHaveBeenCalledOnce();
  });
  it('refuses changed mission/artifact bytes after reservation and does not execute', async () => {
    const ports = deps();
    ports.snapshot.mockReturnValueOnce('reviewed-old').mockReturnValue('changed-artifact');
    await expect(
      executeMcpMissionLifecycle(
        'review_task',
        {
          mission_id: 'MSN-MCP-TOOLS',
          task_id: 'review-task',
          findings: [],
          approval_ref: 'approval-lifecycle',
        },
        reviewerContext,
        ports
      )
    ).rejects.toThrow('MCP_MISSION_STALE_APPROVAL');
    expect(ports.settle).toHaveBeenCalledWith(
      'approval-lifecycle',
      'apply-claim-1',
      reviewerContext.nhi_id,
      'failed'
    );
    expect(ports.execute).not.toHaveBeenCalled();
  });
  it('retains the durable reservation when controller effects are uncertain', async () => {
    const ports = deps();
    ports.execute.mockRejectedValue(new Error('timeout after possible commit'));
    await expect(
      executeMcpMissionLifecycle(
        'distill',
        { mission_id: 'MSN-MCP-TOOLS', approval_ref: 'approval-lifecycle' },
        context,
        ports
      )
    ).rejects.toThrow('MCP_MISSION_EFFECT_UNCERTAIN');
    expect(ports.reserve).toHaveBeenCalledOnce();
    expect(ports.settle).not.toHaveBeenCalled();
  });
  it.each(['deliverable', 'target_path'])(
    'includes actual %s target bytes in the human approval payload',
    async (field) => {
      const ports = deps();
      const directory = paths.pathResolver.sharedTmp(
        `mcp-lifecycle-snapshot-${process.pid}/MSN-MCP-TOOLS`
      );
      const locator = vi.spyOn(paths, 'findMissionPath').mockReturnValue(directory);
      const realSnapshotPorts: MissionLifecycleToolDeps = { ...ports, snapshot: undefined };
      ports.approve.mockReturnValue({
        allowed: false,
        status: 'approval_required',
        request_id: 'approval-lifecycle',
      } as ReturnType<MissionLifecycleToolDeps['approve']>);
      try {
        safeWriteFile(
          path.join(directory, 'NEXT_TASKS.json'),
          JSON.stringify([
            { task_id: 'implement', [field]: 'evidence/report.md' },
            { task_id: 'review-task', review_target: 'implement' },
          ]),
          { mkdir: true }
        );
        const artifact = path.join(directory, 'evidence/report.md');
        safeWriteFile(artifact, 'reviewed bytes', { mkdir: true });
        const args = { mission_id: 'MSN-MCP-TOOLS', task_id: 'review-task', findings: [] };
        await executeMcpMissionLifecycle('review_task', args, reviewerContext, realSnapshotPorts);
        const first = ports.approve.mock.calls[0]![0].payload.mission_snapshot;
        safeWriteFile(artifact, 'changed after presentation');
        await executeMcpMissionLifecycle('review_task', args, reviewerContext, realSnapshotPorts);
        expect(ports.approve.mock.calls[1]![0].payload.mission_snapshot).not.toBe(first);
        expect(ports.reserve).not.toHaveBeenCalled();
        expect(ports.execute).not.toHaveBeenCalled();
      } finally {
        locator.mockRestore();
        safeRmSync(path.dirname(directory), { recursive: true, force: true });
      }
    }
  );
  it('requires an authenticated reviewer instead of attributing a service review to an agent', async () => {
    const ports = deps();
    await expect(
      executeMcpMissionLifecycle(
        'review_task',
        {
          mission_id: 'MSN-MCP-TOOLS',
          task_id: 'review-task',
          findings: [],
        },
        context,
        ports
      )
    ).rejects.toThrow('MCP_MISSION_REVIEWER_REQUIRED');
    expect(ports.approve).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
  });
  it.each([{ tier: 'public' }, { tenant_slug: 'tenant-b' }, { mission_id: 'MSN-OTHER' }])(
    'rejects scope substitution %j before approval or execution',
    async (override) => {
      const ports = deps();
      await expect(
        executeMcpMissionLifecycle(
          'distill',
          { mission_id: 'MSN-MCP-TOOLS' },
          { ...context, scope: { ...context.scope, ...override } as McpRequestContext['scope'] },
          ports
        )
      ).rejects.toThrow('MCP_SCOPE_MISMATCH');
      expect(ports.approve).not.toHaveBeenCalled();
      expect(ports.execute).not.toHaveBeenCalled();
    }
  );
});
