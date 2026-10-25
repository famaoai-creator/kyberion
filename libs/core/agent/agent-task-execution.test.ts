import { afterEach, describe, expect, it, vi } from 'vitest';
const guard = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../reasoning/reasoning-egress-scope.js', async (original) => ({
  ...(await original<typeof import('../reasoning/reasoning-egress-scope.js')>()),
  assertReasoningEgressAllowed: guard.check,
}));
import { withTaskRuntimeExecution } from './agent-lifecycle.js';
import { getReasoningPayloadScope } from '../reasoning/reasoning-egress-scope.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import type { TaskToolRuntime } from '../workforce/task-tool-runtime.js';
import { withExecutionContextAsync } from '../authority.js';

afterEach(() => {
  vi.unstubAllEnvs();
  guard.check.mockReset();
});
const runtime = () =>
  ({
    binding: {
      scope: {
        tier: 'confidential',
        tenant_slug: 'audit-tenant',
        organization_id: 'org-a',
        mission_id: 'MSN-TASK',
        task_id: 'task-a',
      },
      missionId: 'MSN-TASK',
      taskId: 'task-a',
    },
    assertCurrent: vi.fn(),
  }) as unknown as TaskToolRuntime;

describe('task runtime execution scope', () => {
  it('clears an inherited confidential tenant for a public task', async () => {
    const task = runtime();
    task.binding.scope = { tier: 'public', mission_id: 'MSN-TASK', task_id: 'task-a' };
    await withExecutionContextAsync(
      'worker',
      async () => {
        expect(currentExecutionScope()?.tenantSlug).toBe('ambient-private');
        await withTaskRuntimeExecution(task, 'stub', async () => {
          expect(currentExecutionScope()?.tenantSlug || '').toBe('');
          expect(getReasoningPayloadScope()?.tenant_slug).toBeUndefined();
        });
      },
      undefined,
      'ambient-private'
    );
  });
  it('masks inherited mission identity and binds confidential egress before calling a model', async () => {
    vi.stubEnv('KYBERION_TENANT', '');
    vi.stubEnv('MISSION_ID', 'MSN-UNRELATED');
    vi.stubEnv('TASK_ID', 'unrelated-task');
    const task = runtime();
    guard.check.mockImplementation(() => {
      expect(getReasoningPayloadScope()).toMatchObject({
        tier: 'confidential',
        tenant_slug: 'audit-tenant',
      });
      expect(currentExecutionScope()).toMatchObject({
        assumedRole: 'task_runtime_worker',
        tenantSlug: 'audit-tenant',
        executionIdentity: { missionId: 'MSN-TASK', taskId: 'task-a', projectId: null },
      });
    });
    expect(await withTaskRuntimeExecution(task, 'claude-cli', async () => 'scoped-result')).toBe(
      'scoped-result'
    );
    expect(guard.check).toHaveBeenCalledWith('claude-cli');
    expect(currentExecutionScope()?.executionIdentity?.missionId).not.toBe('MSN-TASK');
  });

  it('refuses provider egress before a confidential task reaches the model', async () => {
    vi.stubEnv('KYBERION_TENANT', '');
    const ask = vi.fn(async () => 'must not execute');
    guard.check.mockImplementation(() => {
      throw new Error('provider not attested for confidential');
    });
    await expect(withTaskRuntimeExecution(runtime(), 'unattested', ask)).rejects.toThrow(
      'not attested'
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
