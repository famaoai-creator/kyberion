import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCoordinatedAgentExecutionPort } from '../coordinated-agent-execution-port.js';
import { SupervisorAgentExecutionPort, resetAgentExecutionPort } from './agent-execution-port.js';
import { agentLifecycle } from './agent-lifecycle.js';
import * as bridge from './agent-exec-adapter-bridge.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeWriteFile, safeRmSync } from '../secure-io.js';
import { writeMissionStateAtPath } from '../mission/mission-state-reader.js';
import {
  createWorkItem,
  getWorkItem,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import type { TaskToolRuntime } from '../workforce/task-tool-runtime.js';

const missionId = `MSN-API-PORT-TEST-${process.pid}`;
const projectId = `PRJ-API-PORT-TEST-${process.pid}`;
const actor = 'control-plane-agent';
const missionDir = pathResolver.missionDir(missionId, 'public');
let runtime: TaskToolRuntime | undefined;
let readResult: unknown;
beforeEach(() => {
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('MISSION_ID', missionId);
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('KYBERION_ORGANIZATION_ID', '');
  vi.stubEnv('KYBERION_PROJECT_ID', '');
  vi.stubEnv('KYBERION_TASK_ID', '');
  resetAgentExecutionPort();
  setWorkCoordinationNamespace('api-default-port-test');
  clearWorkCoordinationStore();
  safeMkdir(missionDir, { recursive: true });
  writeMissionStateAtPath(path.join(missionDir, 'mission-state.json'), {
    mission_id: missionId,
    mission_type: 'development',
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    priority: 3,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: { branch: 'test', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
    history: [],
    relationships: {
      project: {
        project_id: projectId,
        project_path: `active/projects/public/shared/${projectId}/project-os`,
        relationship_type: 'supports',
        affected_artifacts: [],
        gate_impact: 'informational',
        traceability_refs: [],
        note: 'Default API fixture',
      },
    },
  });
  safeWriteFile(
    path.join(missionDir, 'NEXT_TASKS.json'),
    JSON.stringify([
      {
        task_id: 'review-task',
        assigned_to: { role: 'reviewer' },
        phase_kind: 'review',
        status: 'planned',
      },
    ])
  );
  runtime = undefined;
  readResult = undefined;
  // Only emulate provider I/O. Default port, supervisor, lifecycle, task-runtime
  // creation, claim checks, secure read and completion assertions stay real.
  vi.spyOn(bridge, 'createAgentExecAdapter').mockImplementation(async (request) => {
    runtime = request.taskToolRuntime;
    return {
      boot: async () => undefined,
      shutdown: async () => undefined,
      ask: async () => {
        if (runtime)
          readResult = await runtime.execute({
            name: 'kyberion_task_read_file',
            arguments: { path: 'knowledge/product/governance/working-philosophy.md' },
          });
        return { text: 'api-read-ok', stopReason: 'completed' };
      },
    };
  });
});
afterEach(async () => {
  await agentLifecycle.shutdown(actor);
  vi.restoreAllMocks();
  resetAgentExecutionPort();
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  safeRmSync(missionDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const request = () => ({
  task_id: 'review-task',
  mission_id: missionId,
  agent_id: actor,
  provider: 'codex' as const,
  model_id: 'codex',
  instruction: 'Read the public working philosophy',
  idempotency_key: 'default-api',
  security_scope: {
    mission_id: missionId,
    write_tier: 'public' as const,
    read_tiers: ['public' as const],
    purpose: 'review',
    project_id: projectId,
  },
});

describe('default coordinated API task tools', () => {
  it('provisions real native task tools from the current claim and canonical role ceiling', async () => {
    const item = createWorkItem({
      itemId: 'WI-API-PORT',
      title: 'Public bounded read',
      description: 'Native default API tool binding',
      status: 'ready',
      projectId,
      context: { project_id: projectId, mission_id: missionId, task_id: 'review-task' },
      metadata: { team_role: 'reviewer' },
    });
    const result = await getCoordinatedAgentExecutionPort().delegate({
      ...request(),
      work_item_id: item.item_id,
      team_role_id: 'implementer',
      capabilities: ['code'],
    });
    expect(
      result.status,
      JSON.stringify({
        error: result.error,
        context: getWorkItem(item.item_id)?.context,
        binding: runtime?.binding.scope,
      })
    ).toBe('failed');
    expect(result.error).toContain('TASK_TOOL_OUTPUT_UNVERIFIED');
    expect(runtime?.binding).toMatchObject({
      workItemId: item.item_id,
      taskId: 'review-task',
      capabilityProfile: 'explorer',
      actorId: actor,
      leaseId: expect.any(String),
    });
    expect(readResult).toBeDefined();
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
  });
  it('refuses a supplied WorkItem that has no current claim before creating an adapter', async () => {
    const item = createWorkItem({
      itemId: 'WI-API-UNCLAIMED',
      title: 'Unclaimed',
      description: 'No implied grant',
      status: 'ready',
      projectId,
      context: { project_id: projectId, mission_id: missionId, task_id: 'review-task' },
    });
    const result = await new SupervisorAgentExecutionPort().delegate({
      ...request(),
      work_item_id: item.item_id,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('TASK_TOOL_BINDING');
    expect(bridge.createAgentExecAdapter).not.toHaveBeenCalled();
  });
  it('keeps a legacy unclaimed read-only delegation without manufacturing a task-tool binding', async () => {
    const result = await new SupervisorAgentExecutionPort().delegate(request());
    expect(result.status, result.error).toBe('succeeded');
    expect(runtime).toBeUndefined();
  });
});
