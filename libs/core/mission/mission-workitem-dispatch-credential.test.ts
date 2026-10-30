import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import {
  credentialBindingReadiness,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import type { WorkItem } from '../workforce/work-coordination.js';
import { delegateSubagentTask } from './mission-workitem-dispatch-review.js';

const probes = vi.hoisted(() => ({
  build: vi.fn(),
  dispatch: vi.fn(),
  nativeInfo: vi.fn(),
  reset: vi.fn(),
  insideClaim: false,
}));

vi.mock('../workforce/task-execution-port.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workforce/task-execution-port.js')>()),
  buildTaskReasoningBackend: probes.build,
}));
vi.mock('../agent/agent-dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agent-dispatch.js')>()),
  HarnessSubagentDispatcher: class {
    dispatch(...args: unknown[]) {
      return probes.dispatch(...args);
    }
  },
}));
vi.mock('../coordinated-agent-execution-port.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordinated-agent-execution-port.js')>()),
  delegateCoordinatedCliSubagentTask: async (
    _request: unknown,
    execute: () => Promise<unknown>
  ) => {
    expect(probes.build).not.toHaveBeenCalled();
    return runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { TEST_KEY: 'task-secret' } },
        async () => {
          probes.insideClaim = true;
          try {
            return await execute();
          } finally {
            probes.insideClaim = false;
          }
        }
      )
    );
  },
}));

afterEach(() => {
  probes.insideClaim = false;
  vi.resetAllMocks();
});

function input() {
  return {
    item: {
      item_id: 'WI-BINDING',
      version: 1,
      project_id: 'MSN-BINDING',
      metadata: {},
    } as WorkItem,
    prompt: 'perform bounded task',
    routingOptions: {
      mode: 'codex-cli',
      model: 'test-model',
      role: 'implementer',
      route_profile: 'test-route',
      effort: 'high',
    },
    adapters: {},
    notes: [] as string[],
    signal: new AbortController().signal,
    securityScope: { tier: 'confidential', tenant_slug: 'alpha' } as never,
    contextMode: 'project' as never,
  };
}

describe('post-claim CLI task backend construction', () => {
  it('constructs and discovers native capability only inside trusted credential dispatch', async () => {
    probes.build.mockImplementation(() => {
      expect(probes.insideClaim).toBe(true);
      expect(credentialBindingReadiness().status).toBe('bound');
      return {
        name: 'test-task-provider',
        getNativeSubagentAdopter: probes.nativeInfo,
        resetSession: probes.reset,
      };
    });
    probes.nativeInfo.mockImplementation(() => {
      expect(probes.insideClaim).toBe(true);
      return null;
    });
    probes.reset.mockImplementation(async () => {
      expect(probes.insideClaim).toBe(true);
      expect(credentialBindingReadiness().status).toBe('bound');
    });
    probes.dispatch.mockResolvedValue('completed task');
    const result = await delegateSubagentTask(input());
    expect(result.responseText).toBe('completed task');
    expect(probes.build).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'codex-cli',
        model: 'test-model',
        role: 'implementer',
        profile: 'test-route',
      })
    );
    expect(probes.dispatch).toHaveBeenCalledTimes(1);
    expect(probes.reset).toHaveBeenCalledTimes(1);
  });

  it('cleans up a failed owned backend while preserving the primary execution failure', async () => {
    probes.build.mockReturnValue({ name: 'test-task-provider', resetSession: probes.reset });
    probes.dispatch.mockRejectedValue(new Error('primary task failure'));
    probes.reset.mockImplementation(async () => {
      expect(probes.insideClaim).toBe(true);
      expect(credentialBindingReadiness().status).toBe('bound');
      throw new Error('cleanup failure');
    });
    await expect(delegateSubagentTask(input())).rejects.toThrow('primary task failure');
    expect(probes.reset).toHaveBeenCalledTimes(1);
  });

  it('uses explicit adapters without constructing or inspecting a host backend', async () => {
    const delegateTask = vi.fn(async () => {
      expect(credentialBindingReadiness().status).toBe('bound');
      return 'adapter result';
    });
    const result = await delegateSubagentTask({ ...input(), adapters: { delegateTask } });
    expect(result.responseText).toBe('adapter result');
    expect(probes.build).not.toHaveBeenCalled();
    expect(probes.nativeInfo).not.toHaveBeenCalled();
    expect(probes.reset).not.toHaveBeenCalled();
    expect(probes.dispatch).not.toHaveBeenCalled();
  });
});
