import { describe, expect, it, vi } from 'vitest';
import './worker-goal-driver.js';
import {
  createRuntimeForTask,
  runTaskToolLoop,
  type TaskToolRuntimeOptions,
} from './task-tool-runtime.js';
import type { WorkItem, WorkLease } from './work-coordination-types.js';
import { WorkerEventStream } from './worker-event-stream.js';
import { DynamicInjectionRegistry } from '../dynamic-injection.js';
import type { GenerateWithToolsResult } from '../reasoning/reasoning-backend.js';

const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'tenant-tools',
  organization_id: 'org-test',
  project_id: 'project-test',
  mission_id: 'MSN-TASK-TOOLS',
  task_id: 'implement',
};
function harness(profile = 'implementer', canonicalRole = 'implementer') {
  let item = {
    item_id: 'work-tools',
    status: 'in_progress',
    lease_id: 'lease-tools',
    claimed_by_peer_id: 'worker-test',
    context: { ...scope },
    metadata: { team_role: canonicalRole },
  } as unknown as WorkItem;
  let lease = {
    lease_id: 'lease-tools',
    item_id: item.item_id,
    holder_peer_id: 'worker-test',
    status: 'active',
    expires_at: '2099-01-01T00:00:00.000Z',
  } as WorkLease;
  const writeArtifact = vi.fn(
    () =>
      ({ path: 'task/report.txt' }) as unknown as ReturnType<
        NonNullable<TaskToolRuntimeOptions['writeArtifact']>
      >
  );
  const task: Record<string, unknown> = {
    task_id: scope.task_id,
    deliverable: 'evidence/report.txt',
    status: 'planned',
    assigned_to: { role: canonicalRole },
    ...(canonicalRole === 'reviewer'
      ? { phase_kind: 'review', review_target: 'original-implementation' }
      : {}),
  };
  let output: string | undefined;
  const recordEvidence = vi.fn(async () => {
    if (canonicalRole !== 'reviewer') task.status = 'completed';
    return { status: 'recorded' };
  });
  const writeDeliverable = vi.fn((_file: string, content: string) => {
    output = content;
  });
  const options: TaskToolRuntimeOptions = {
    getItem: () => item,
    leases: () => [lease],
    missionPath: () => `${process.cwd()}/active/shared/tmp/task-tool-test/${scope.mission_id}`,
    tasks: () => [task],
    mission: () =>
      ({
        mission_id: scope.mission_id,
        status: 'active',
        tier: scope.tier,
        tenant_slug: scope.tenant_slug,
        organization_id: scope.organization_id,
        relationships: { project: { project_id: scope.project_id } },
      }) as ReturnType<NonNullable<TaskToolRuntimeOptions['mission']>>,
    read: () => 'public source',
    writeArtifact,
    recordEvidence,
    writeDeliverable,
    inspectDeliverable: () => output,
  };
  const metadata = { work_item_id: item.item_id, capability_profile: profile };
  return {
    runtime: createRuntimeForTask(metadata, scope, options)!,
    metadata,
    options,
    writeArtifact,
    recordEvidence,
    writeDeliverable,
    setOutput: (value: string | undefined) => {
      output = value;
    },
    setItem: (next: Partial<WorkItem>) => {
      item = { ...item, ...next };
    },
    setLease: (next: Partial<WorkLease>) => {
      lease = { ...lease, ...next };
    },
  };
}

describe('claimed task tool runtime', () => {
  it('binds to live task scope and emits provider-safe names', async () => {
    const h = harness();
    expect(h.runtime.binding.taskId).toBe(scope.task_id);
    expect(h.runtime.definitions.map((entry) => entry.name)).toEqual([
      'kyberion_task_read_file',
      'kyberion_task_write_deliverable',
      'kyberion_task_write_artifact',
      'kyberion_task_record_evidence',
    ]);
    expect(h.runtime.definitions.every((entry) => /^[A-Za-z0-9_-]+$/.test(entry.name))).toBe(true);
    await h.runtime.execute({
      name: 'kyberion_task_write_artifact',
      arguments: { name: 'report.txt', content: 'done', mission_id: 'other' },
    });
    expect(h.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { mission: scope.mission_id, task: scope.task_id },
        tier: scope.tier,
      })
    );
    await h.runtime.execute({
      name: 'kyberion_task_write_deliverable',
      arguments: { content: 'verified task output' },
    });
    await h.runtime.execute({
      name: 'kyberion_task_record_evidence',
      arguments: { note: 'artifact verified' },
    });
    expect(h.recordEvidence).toHaveBeenCalledWith(h.runtime.binding, 'artifact verified');
  });
  it('allows only read tools for explorers and rejects hidden tool invocation', async () => {
    const h = harness('explorer');
    expect(h.runtime.definitions.map((entry) => entry.name)).toEqual(['kyberion_task_read_file']);
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_write_artifact',
        arguments: { name: 'report.txt', content: 'bad' },
      })
    ).rejects.toThrow('TASK_TOOL_DENIED');
    expect(h.writeArtifact).not.toHaveBeenCalled();
  });
  it('rejects cross-scope read paths before I/O', async () => {
    const h = harness();
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_read_file',
        arguments: { path: 'knowledge/personal/private.txt' },
      })
    ).rejects.toThrow('TASK_TOOL_SCOPE_DENIED');
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_read_file',
        arguments: { path: 'libs/../knowledge/confidential/other/private.txt' },
      })
    ).rejects.toThrow('TASK_TOOL_SCOPE_DENIED');
  });
  it.each(['tenant', 'lease', 'expiry'] as const)(
    'revalidates %s before every effect',
    async (change) => {
      const h = harness();
      if (change === 'tenant') h.setItem({ context: { ...scope, tenant_slug: 'other' } });
      if (change === 'lease') h.setItem({ lease_id: 'reassigned' });
      if (change === 'expiry') h.setLease({ expires_at: '2000-01-01T00:00:00.000Z' });
      await expect(
        h.runtime.execute({
          name: 'kyberion_task_write_artifact',
          arguments: { name: 'report.txt', content: 'bad' },
        })
      ).rejects.toThrow(/TASK_TOOL_(SCOPE_DENIED|LEASE_LOST)/);
      expect(h.writeArtifact).not.toHaveBeenCalled();
    }
  );
  it('refuses metadata trying to widen a reviewer task profile', () => {
    const h = harness();
    h.setItem({ metadata: { team_role: 'reviewer' } });
    expect(() => createRuntimeForTask(h.metadata, scope, h.options)).toThrow('exceeds task role');
  });
  it('pins egress/backend policy from the stored claim rather than message metadata', () => {
    const h = harness();
    const forged = createRuntimeForTask(
      {
        ...h.metadata,
        security_scope: { external_egress: 'allow', allowed_reasoning_backends: ['anything'] },
      },
      scope,
      h.options
    )!;
    expect(forged.binding.externalEgress).toBe('deny');
    h.setItem({
      metadata: {
        team_role: 'implementer',
        security_scope: { external_egress: 'allow', allowed_reasoning_backends: ['approved-api'] },
      },
    });
    expect(() => forged.assertCurrent()).toThrow('TASK_TOOL_EGRESS_POLICY_CHANGED');
    const approved = createRuntimeForTask(h.metadata, scope, h.options)!;
    expect(approved.binding).toMatchObject({
      externalEgress: 'allow',
      allowedReasoningBackends: ['approved-api'],
    });
    h.setItem({
      metadata: { team_role: 'implementer', security_scope: { external_egress: 'deny' } },
    });
    expect(() => approved.assertCurrent()).toThrow('TASK_TOOL_EGRESS_POLICY_CHANGED');
  });
  it('refuses a runtime actor unrelated to the lease or assigned agent', () => {
    const h = harness();
    expect(() =>
      createRuntimeForTask(h.metadata, scope, { ...h.options, actorId: 'unrelated-agent' })
    ).toThrow('TASK_TOOL_ACTOR_DENIED');
    h.setItem({ assignee_peer_id: 'assigned-reviewer' });
    expect(() =>
      createRuntimeForTask(h.metadata, scope, { ...h.options, actorId: 'assigned-reviewer' })
    ).toThrow('TASK_TOOL_ACTOR_DENIED');
  });
  it.each(['explorer', 'planner'])(
    'allows %s to emit only its own declared result and evidence',
    async (profile) => {
      const h = harness(profile, profile === 'explorer' ? 'reviewer' : 'planner');
      await h.runtime.execute({
        name: 'kyberion_task_write_deliverable',
        arguments: { content: 'Independent findings and evidence' },
      });
      await h.runtime.execute({
        name: 'kyberion_task_record_evidence',
        arguments: { note: 'Own result produced; independent review remains required' },
      });
      expect(h.writeDeliverable).toHaveBeenCalledTimes(1);
      expect(h.recordEvidence).toHaveBeenCalledTimes(1);
      h.runtime.assertComplete?.();
      expect(
        h.runtime.definitions.some((entry) => entry.name === 'kyberion_task_write_source')
      ).toBe(false);
      await expect(
        h.runtime.execute({
          name: 'kyberion_task_write_source',
          arguments: { path: 'libs/core/secure-io.ts', content: 'bad' },
        })
      ).rejects.toThrow('TASK_TOOL_DENIED');
    }
  );
  it('accepts standalone mission legacy display project links without widening scope', () => {
    const h = harness();
    h.setItem({
      context: {
        mission_id: scope.mission_id,
        task_id: scope.task_id,
        project_id: scope.mission_id,
      },
    });
    h.options.mission = () =>
      ({ mission_id: scope.mission_id, tier: 'public', status: 'active' }) as ReturnType<
        NonNullable<TaskToolRuntimeOptions['mission']>
      >;
    const runtime = createRuntimeForTask(
      h.metadata,
      { tier: 'public', mission_id: scope.mission_id, task_id: scope.task_id },
      h.options
    );
    expect(runtime?.binding.scope.project_id).toBeUndefined();
  });
  it('drives fake API tool execution through artifact, evidence and structured completion', async () => {
    const h = harness();
    const results: GenerateWithToolsResult[] = [
      { toolCalls: [{ name: 'kyberion_task_write_deliverable', input: { content: 'validated' } }] },
      {
        toolCalls: [{ name: 'kyberion_task_record_evidence', input: { note: 'report verified' } }],
      },
      {
        text: 'TASK_RESULT: completed with report',
        toolCalls: [
          {
            name: 'goal_update',
            input: { status: 'complete', reason: 'task report exists and evidence recorded' },
          },
        ],
      },
    ];
    const prompts: string[] = [];
    const backend = {
      generateWithTools: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return results.shift()!;
      }),
    };
    const result = await runTaskToolLoop(h.runtime, backend, 'Produce and record task report', {
      stream: new WorkerEventStream(),
      injectionRegistry: new DynamicInjectionRegistry(),
      auditToolCall: vi.fn(),
    });
    expect(result).toMatchObject({
      stopReason: 'end_turn',
      text: 'TASK_RESULT: completed with report',
    });
    expect(h.writeArtifact).toHaveBeenCalledTimes(1);
    expect(h.writeDeliverable).toHaveBeenCalledWith(
      expect.stringContaining(`${scope.mission_id}/evidence/report.txt`),
      'validated'
    );
    expect(h.recordEvidence).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toContain('task/report.txt');
    expect(backend.generateWithTools).toHaveBeenCalledTimes(3);
  });
  it('yields approval without retrying the pending effect', async () => {
    const h = harness();
    await h.runtime.execute({
      name: 'kyberion_task_write_deliverable',
      arguments: { content: 'pending approved report' },
    });
    const pending = Object.assign(new Error('human approval pending'), {
      code: 'AGENT_APPROVAL_PENDING',
      approvalRequestId: 'approval-task',
    });
    h.recordEvidence.mockRejectedValueOnce(pending);
    const backend = {
      generateWithTools: vi.fn(async () => ({
        toolCalls: [{ name: 'kyberion_task_record_evidence', input: { note: 'report verified' } }],
      })),
    };
    await expect(
      runTaskToolLoop(h.runtime, backend, 'Record report', {
        stream: new WorkerEventStream(),
        injectionRegistry: new DynamicInjectionRegistry(),
        auditToolCall: vi.fn(),
      })
    ).rejects.toBe(pending);
    expect(backend.generateWithTools).toHaveBeenCalledTimes(1);
    expect(h.recordEvidence).toHaveBeenCalledTimes(1);
    const resumed = {
      generateWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [
            {
              name: 'kyberion_task_write_deliverable',
              input: { content: 'verified approved report' },
            },
          ],
        })
        .mockResolvedValueOnce({
          toolCalls: [
            { name: 'kyberion_task_record_evidence', input: { note: 'report verified' } },
          ],
        })
        .mockResolvedValueOnce({
          text: 'TASK_RESULT: approved report recorded',
          toolCalls: [
            {
              name: 'goal_update',
              input: { status: 'complete', reason: 'approved evidence recorded' },
            },
          ],
        }),
    };
    expect(
      await runTaskToolLoop(h.runtime, resumed, 'Resume approved report', {
        stream: new WorkerEventStream(),
        injectionRegistry: new DynamicInjectionRegistry(),
        auditToolCall: vi.fn(),
      })
    ).toMatchObject({ stopReason: 'end_turn' });
  });
  it('does not let a sidecar explorer overwrite the original implementation report', async () => {
    const h = harness('explorer');
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_write_deliverable',
        arguments: { content: 'replace implementation' },
      })
    ).rejects.toThrow('TASK_TOOL_DENIED');
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_record_evidence',
        arguments: { note: 'self review' },
      })
    ).rejects.toThrow('TASK_TOOL_DENIED');
    expect(h.writeDeliverable).not.toHaveBeenCalled();
    expect(h.recordEvidence).not.toHaveBeenCalled();
  });
  it('refuses plausible model completion with no verified output', async () => {
    const h = harness();
    const backend = {
      generateWithTools: vi.fn(async () => ({
        text: 'TASK_RESULT: complete',
        toolCalls: [{ name: 'goal_update', input: { status: 'complete', reason: 'looks done' } }],
      })),
    };
    await expect(
      runTaskToolLoop(h.runtime, backend, 'Write verified report', {
        stream: new WorkerEventStream(),
        injectionRegistry: new DynamicInjectionRegistry(),
        auditToolCall: vi.fn(),
      })
    ).rejects.toThrow('TASK_TOOL_OUTPUT_UNVERIFIED');
  });
  it('invalidates evidence when its declared artifact changes after recording', async () => {
    const h = harness();
    await expect(
      h.runtime.execute({
        name: 'kyberion_task_record_evidence',
        arguments: { note: 'no artifact yet' },
      })
    ).rejects.toThrow('TASK_TOOL_OUTPUT_UNVERIFIED');
    expect(h.recordEvidence).not.toHaveBeenCalled();
    await h.runtime.execute({
      name: 'kyberion_task_write_deliverable',
      arguments: { content: 'version A' },
    });
    await h.runtime.execute({
      name: 'kyberion_task_record_evidence',
      arguments: { note: 'verified A' },
    });
    h.runtime.assertComplete?.();
    await h.runtime.execute({
      name: 'kyberion_task_write_deliverable',
      arguments: { content: 'version B' },
    });
    expect(() => h.runtime.assertComplete?.()).toThrow('Task evidence has not been recorded');
    await h.runtime.execute({
      name: 'kyberion_task_record_evidence',
      arguments: { note: 'verified B' },
    });
    h.runtime.assertComplete?.();
  });
  it('does not return TASK_RESULT success from a blocked or budget-paused loop', async () => {
    const h = harness();
    const backend = {
      generateWithTools: vi.fn(async () => ({
        text: 'TASK_RESULT: complete',
        toolCalls: [
          {
            name: 'goal_update',
            input: { status: 'blocked', impossible: true, reason: 'cannot do task' },
          },
        ],
      })),
    };
    await expect(
      runTaskToolLoop(h.runtime, backend, 'Write report', {
        stream: new WorkerEventStream(),
        injectionRegistry: new DynamicInjectionRegistry(),
        auditToolCall: vi.fn(),
      })
    ).rejects.toThrow('TASK_TOOL_INCOMPLETE');
  });
});
