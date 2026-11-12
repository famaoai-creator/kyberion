import { describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ManualDriveExecutionResult } from '@agent/core/agent/agent-runtime-manual-drive';

const viewer = {
  context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
  response: undefined,
};

const manualDriveMock = vi.hoisted(() => ({
  getAgentRuntimeManualDriverRegistration: vi.fn(),
  readManualDriverDescriptor: vi.fn((): unknown => null),
  enqueueManualDriverCommand: vi.fn(),
  cancelManualDriverCommand: vi.fn(),
  resumeManualDriverCommand: vi.fn(),
  readManualDriverCommandStatus: vi.fn((): unknown => null),
}));

vi.mock('../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: vi.fn((): unknown => null),
  getOpsAccessRole: vi.fn(() => 'localadmin'),
  requireOpsAccess: vi.fn((): unknown => null),
  roleToMissionRole: vi.fn(() => 'mission_controller'),
}));

vi.mock('../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: vi.fn(() => viewer),
  withViewerExecutionContextAsync: vi.fn(async (_viewer: unknown, run: () => unknown) => run()),
  viewerErrorResponse: vi.fn((error: unknown, status = 500) =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  ),
}));

vi.mock('@agent/core/agent/agent-runtime-manual-drive', () => manualDriveMock);

const a2aRoute = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/mesh/a2a-bridge', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/mesh/a2a-bridge')>(
    '@agent/core/mesh/a2a-bridge'
  );
  return { ...actual, a2aBridge: { route: a2aRoute } };
});

import { DELETE, POST } from './route';

function requestWithJson(value: unknown | (() => unknown)): NextRequest {
  return {
    json: async () => (typeof value === 'function' ? value() : value),
  } as unknown as NextRequest;
}

describe('chronos agents route input boundary', () => {
  it.each([
    ['null body', () => null],
    ['array body', () => []],
    ['non-string agent id', () => ({ action: 'logs', agentId: [] })],
    ['missing spawn provider', () => ({ action: 'spawn' })],
    ['unknown field', () => ({ action: 'spawn', provider: 'claude', unsupported: true })],
  ])('returns 400 for %s before runtime dispatch', async (_label, bodyFactory) => {
    const response = await POST(requestWithJson(bodyFactory()));
    expect(response.status).toBe(400);
  });

  it('returns 400 for malformed JSON before runtime dispatch', async () => {
    const response = await POST(
      requestWithJson(() => {
        throw new SyntaxError('Unexpected token');
      })
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 for malformed delete input before stopping a runtime', async () => {
    const response = await DELETE(requestWithJson({ agentId: { value: 'agent-1' } }));
    expect(response.status).toBe(400);
  });

  it.each(['propose', 'accept', 'reject', 'result', 'handoff', undefined])(
    'returns 400 for a2a performative %j without calling the bridge',
    async (performative) => {
      a2aRoute.mockClear();
      const response = await POST(
        requestWithJson({
          action: 'a2a',
          envelope: {
            a2a_version: '1.0',
            header: { msg_id: 'M-1', sender: 'kyberion:ops', receiver: 'agent-1', performative },
            payload: { text: 'hello' },
          },
        })
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ errorCode: 'A2A_PERFORMATIVE_NOT_ROUTABLE' });
      expect(a2aRoute).not.toHaveBeenCalled();
    }
  );

  it('answers 403 before judging the performative when the caller lacks ops access', async () => {
    a2aRoute.mockClear();
    const { requireOpsAccess } = await import('../../../../lib/ops/ops-request-guard');
    vi.mocked(requireOpsAccess).mockReturnValue(
      Response.json({ error: 'forbidden' }, { status: 403 }) as never
    );
    try {
      const response = await POST(
        requestWithJson({
          action: 'a2a',
          envelope: {
            a2a_version: '1.0',
            header: {
              msg_id: 'M-1',
              sender: 'kyberion:ops',
              receiver: 'agent-1',
              performative: 'propose',
            },
            payload: { text: 'hello' },
          },
        })
      );
      expect(response.status).toBe(403);
      expect(a2aRoute).not.toHaveBeenCalled();
    } finally {
      vi.mocked(requireOpsAccess).mockReturnValue(null as never);
    }
  });

  it.each(['request', 'query', 'inform'])(
    'passes a2a performative %j to the bridge',
    async (performative) => {
      a2aRoute.mockReset();
      a2aRoute.mockResolvedValue({ header: { performative: 'result' }, payload: { text: 'ok' } });
      const response = await POST(
        requestWithJson({
          action: 'a2a',
          envelope: {
            a2a_version: '1.0',
            header: { msg_id: 'M-1', sender: 'kyberion:ops', receiver: 'agent-1', performative },
            payload: { text: 'hello' },
          },
        })
      );
      expect(response.status).toBe(200);
      expect(a2aRoute).toHaveBeenCalledTimes(1);
    }
  );

  it('fails closed when the requested runtime has no local manual-drive provider', async () => {
    manualDriveMock.getAgentRuntimeManualDriverRegistration.mockReturnValue(undefined);
    const response = await POST(requestWithJson({ action: 'manual_peek', agentId: 'agent-1' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error:
        "[MANUAL_DRIVE_RUNTIME_NOT_REGISTERED] agent 'agent-1' has no active manual-drive target.",
    });
  });

  it('returns only the operator-safe action projection for a scoped manual provider', async () => {
    const driver = {
      peekAction: vi.fn(async () => ({
        action_id: 'step-1',
        kind: 'hook',
        title: 'Run hook',
        status: 'ready',
      })),
      executeAction: vi.fn(async (): Promise<ManualDriveExecutionResult> => ({
        status: 'executed',
        action: {
          action_id: 'step-1',
          kind: 'hook',
          title: 'Run hook',
          status: 'ready',
        },
        result: 'sensitive executor result must stay in-process',
      })),
    };
    manualDriveMock.getAgentRuntimeManualDriverRegistration.mockReturnValue({
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      driver,
    });
    const response = await POST(requestWithJson({ action: 'manual_peek', agentId: 'agent-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      agentId: 'agent-1',
      action: {
        action_id: 'step-1',
        kind: 'hook',
        title: 'Run hook',
        status: 'ready',
      },
    });

    const executeResponse = await POST(
      requestWithJson({ action: 'manual_execute', agentId: 'agent-1', actionId: 'step-1' })
    );
    expect(executeResponse.status).toBe(200);
    expect(await executeResponse.json()).toEqual({
      status: 'executed',
      agentId: 'agent-1',
      action: {
        action_id: 'step-1',
        kind: 'hook',
        title: 'Run hook',
        status: 'ready',
      },
    });

    driver.executeAction.mockResolvedValueOnce({
      status: 'failed',
      action: {
        action_id: 'step-1',
        kind: 'hook',
        title: 'Run hook',
        status: 'ready',
      },
      error: 'secret path and provider detail',
    });
    const failedResponse = await POST(
      requestWithJson({ action: 'manual_execute', agentId: 'agent-1', actionId: 'step-1' })
    );
    const failedBody = await failedResponse.json();
    expect(failedResponse.status).toBe(200);
    expect(failedBody.error).not.toContain('secret path');
    expect(failedBody.errorCode).toBe('internal');
  });

  it('queues and reports a durable manual command when the worker is in another process', async () => {
    const action = {
      action_id: 'step-durable',
      kind: 'hook',
      title: 'Run durable hook',
      status: 'ready',
    } as const;
    manualDriveMock.getAgentRuntimeManualDriverRegistration.mockReturnValue(undefined);
    manualDriveMock.readManualDriverDescriptor.mockReturnValue({
      version: 1,
      agent_id: 'agent-durable',
      owner_id: 'worker-owner',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      status: 'online',
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10_000).toISOString(),
      action,
    });
    manualDriveMock.enqueueManualDriverCommand.mockResolvedValue({
      commandId: 'command-1',
      agentId: 'agent-durable',
      actionId: action.action_id,
      requestedAt: new Date().toISOString(),
    });

    const queued = await POST(
      requestWithJson({
        action: 'manual_execute',
        agentId: 'agent-durable',
        actionId: action.action_id,
      })
    );
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({
      status: 'queued',
      agentId: 'agent-durable',
      commandId: 'command-1',
      action,
    });

    manualDriveMock.readManualDriverCommandStatus.mockReturnValue({
      commandId: 'command-1',
      agentId: 'agent-durable',
      actionId: action.action_id,
      state: 'completed',
      status: 'executed',
      action,
    });
    const status = await POST(
      requestWithJson({ action: 'manual_status', agentId: 'agent-durable', commandId: 'command-1' })
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      status: 'completed',
      agentId: 'agent-durable',
      commandId: 'command-1',
      actionStatus: 'executed',
      action,
    });

    manualDriveMock.readManualDriverCommandStatus.mockReturnValue({
      commandId: 'command-2',
      agentId: 'agent-durable',
      actionId: action.action_id,
      state: 'queued',
    });
    const queuedStatus = await POST(
      requestWithJson({ action: 'manual_status', agentId: 'agent-durable', commandId: 'command-2' })
    );
    expect(queuedStatus.status).toBe(200);
    expect(await queuedStatus.json()).toEqual({
      status: 'queued',
      agentId: 'agent-durable',
      commandId: 'command-2',
    });

    manualDriveMock.cancelManualDriverCommand.mockResolvedValue('cancelled');
    const cancelled = await POST(
      requestWithJson({ action: 'manual_cancel', agentId: 'agent-durable', commandId: 'command-1' })
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      status: 'cancelled',
      agentId: 'agent-durable',
      commandId: 'command-1',
    });
  });

  it('queues a durable resume only for an approval-waiting command', async () => {
    const action = {
      action_id: 'step-durable',
      kind: 'execute_tool',
      title: 'Run after approval',
      status: 'awaiting_approval',
      approval: { status: 'pending', request_id: 'approval-1' },
    } as const;
    manualDriveMock.getAgentRuntimeManualDriverRegistration.mockReturnValue(undefined);
    manualDriveMock.readManualDriverDescriptor.mockReturnValue({
      version: 1,
      agent_id: 'agent-durable',
      owner_id: 'worker-owner',
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      status: 'online',
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10_000).toISOString(),
      action,
    });
    manualDriveMock.resumeManualDriverCommand.mockResolvedValue({
      commandId: 'command-2',
      agentId: 'agent-durable',
      actionId: action.action_id,
      requestedAt: new Date().toISOString(),
      resumesCommandId: 'command-1',
    });

    const response = await POST(
      requestWithJson({
        action: 'manual_resume',
        agentId: 'agent-durable',
        commandId: 'command-1',
      })
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: 'queued',
      agentId: 'agent-durable',
      commandId: 'command-2',
      resumesCommandId: 'command-1',
      action,
    });
    expect(manualDriveMock.resumeManualDriverCommand).toHaveBeenCalledWith({
      agentId: 'agent-durable',
      commandId: 'command-1',
      resumedBy: 'chronos_agents_api',
    });
  });
});
