import { describe, expect, it, vi } from 'vitest';
import {
  AgentRuntimeManualDriver,
  getAgentRuntimeManualDriverRegistration,
  registerAgentRuntimeManualDriver,
  type ManualDriveActionPlan,
  type ManualDriveApprovalContext,
} from './agent-runtime-manual-drive.js';

function plan(
  actionId: string,
  kind: ManualDriveActionPlan['kind'],
  execute: ManualDriveActionPlan['execute'] = () => actionId
): ManualDriveActionPlan {
  return { action_id: actionId, kind, title: actionId, execute };
}

describe('AgentRuntimeManualDriver', () => {
  it('peeks without executing and advances exactly one action in step mode', async () => {
    const executed: string[] = [];
    const plans = [
      plan('a1', 'stream_assistant', () => executed.push('a1')),
      plan('a2', 'hook', () => executed.push('a2')),
    ];
    const driver = new AgentRuntimeManualDriver({
      mode: 'step',
      nextAction: () => plans.shift() ?? null,
    });

    const first = await driver.peekAction();
    expect(first).toMatchObject({ action_id: 'a1', kind: 'stream_assistant', status: 'ready' });
    expect(executed).toEqual([]);
    expect((await driver.run()).stop_reason).toBe('step');

    expect((await driver.executeAction('a1')).status).toBe('executed');
    expect(executed).toEqual(['a1']);
    expect(await driver.peekAction()).toMatchObject({ action_id: 'a2', kind: 'hook' });
  });

  it('runs one action boundary at a time in auto mode and stops at idle', async () => {
    const executed: string[] = [];
    const driver = new AgentRuntimeManualDriver({
      mode: 'auto',
      nextAction: (() => {
        const plans = [
          plan('a1', 'append_entry', () => executed.push('a1')),
          plan('a2', 'consume_queue_item', () => executed.push('a2')),
        ];
        return () => plans.shift() ?? null;
      })(),
    });

    const result = await driver.run();
    expect(result.stop_reason).toBe('idle');
    expect(result.actions.map((action) => action.status)).toEqual(['executed', 'executed']);
    expect(executed).toEqual(['a1', 'a2']);
  });

  it('checks execute_tool approval at peek and again before execution', async () => {
    let approved = false;
    const phases: ManualDriveApprovalContext['phase'][] = [];
    const approvalPayloads: Array<Record<string, unknown> | undefined> = [];
    const execute = vi.fn();
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => ({
        ...plan('tool-1', 'execute_tool', () => {
          execute();
          return 'tool result';
        }),
        approval_payload: { target: 'safe-hash-only' },
      }),
      approvalGate: ({ phase, approval_payload }) => {
        phases.push(phase);
        approvalPayloads.push(approval_payload);
        return approved
          ? { status: 'approved', request_id: 'approval-1' }
          : { status: 'pending', request_id: 'approval-1', message: 'awaiting human approval' };
      },
    });

    expect(await driver.peekAction()).toMatchObject({
      action_id: 'tool-1',
      status: 'awaiting_approval',
      approval: { status: 'pending', request_id: 'approval-1' },
    });
    expect((await driver.executeAction('tool-1')).status).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();

    approved = true;
    expect((await driver.executeAction('tool-1')).status).toBe('executed');
    expect(execute).toHaveBeenCalledOnce();
    expect(phases).toEqual(['peek', 'peek', 'peek', 'execute']);
    expect(approvalPayloads).toEqual([
      { target: 'safe-hash-only' },
      { target: 'safe-hash-only' },
      { target: 'safe-hash-only' },
      { target: 'safe-hash-only' },
    ]);
  });

  it('fails closed when execute_tool has no approval gate', async () => {
    const execute = vi.fn();
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => plan('tool-1', 'execute_tool', execute),
    });

    const action = await driver.peekAction();
    expect(action).toMatchObject({
      status: 'blocked',
      approval: { status: 'denied' },
    });
    expect((await driver.executeAction('tool-1')).status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed when an approval gate returns an invalid decision', async () => {
    const execute = vi.fn();
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => plan('tool-1', 'execute_tool', execute),
      approvalGate: () => ({ status: 'maybe' }) as never,
    });

    expect(await driver.peekAction()).toMatchObject({
      status: 'blocked',
      approval: {
        status: 'denied',
        message: '[MANUAL_DRIVE_INVALID_APPROVAL] approval gate returned an invalid decision.',
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a non-interactive human-required gate blocked instead of awaiting approval', async () => {
    const execute = vi.fn();
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => plan('tool-1', 'execute_tool', execute),
      approvalGate: () => ({
        status: 'denied',
        message: '[HUMAN_REQUIRED] no interactive human is present',
      }),
    });

    expect(await driver.peekAction()).toMatchObject({
      status: 'blocked',
      approval: { status: 'denied' },
    });
    expect((await driver.executeAction('tool-1')).status).toBe('blocked');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed action plans before they can execute', async () => {
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => ({ kind: 'execute_tool' }) as unknown as ManualDriveActionPlan,
    });

    await expect(driver.peekAction()).rejects.toThrow('[MANUAL_DRIVE_INVALID_ACTION]');
  });

  it.each([
    ['description', { description: 42 }],
    ['operation_id', { operation_id: 42 }],
    ['requires_approval', { requires_approval: 'yes' }],
    ['approval_payload', { approval_payload: [] }],
  ])('rejects an action plan with an invalid %s field', async (_field, invalidField) => {
    const driver = new AgentRuntimeManualDriver({
      nextAction: () =>
        ({
          ...plan('malformed-optional', 'execute_tool'),
          ...invalidField,
        }) as unknown as ManualDriveActionPlan,
    });

    await expect(driver.peekAction()).rejects.toThrow(
      '[MANUAL_DRIVE_INVALID_ACTION] action plan optional fields are invalid.'
    );
  });

  it('serializes concurrent peeks and rejects concurrent executions', async () => {
    let nextCalls = 0;
    let releaseExecution: (() => void) | undefined;
    const driver = new AgentRuntimeManualDriver({
      nextAction: async () => {
        nextCalls += 1;
        return plan(
          'a1',
          'hook',
          () => new Promise<void>((resolve) => (releaseExecution = resolve))
        );
      },
    });

    const [first, second] = await Promise.all([driver.peekAction(), driver.peekAction()]);
    expect(first).toEqual(second);
    expect(nextCalls).toBe(1);

    const execution = driver.executeAction('a1');
    await expect(driver.executeAction('a1')).rejects.toThrow('[MANUAL_DRIVE_REENTRANT]');
    releaseExecution?.();
    await expect(execution).resolves.toMatchObject({ status: 'executed' });
  });

  it('registers a scoped process-local driver and disposes only its own registration', async () => {
    const driver = new AgentRuntimeManualDriver({
      nextAction: () => plan('registered-1', 'hook'),
    });
    const dispose = registerAgentRuntimeManualDriver({
      agentId: 'registered-agent',
      driver,
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
    });

    expect(getAgentRuntimeManualDriverRegistration('registered-agent')).toMatchObject({
      agentId: 'registered-agent',
      driver,
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
    });
    await expect(
      Promise.resolve(
        getAgentRuntimeManualDriverRegistration('registered-agent')?.driver.peekAction()
      )
    ).resolves.toMatchObject({ action_id: 'registered-1' });
    expect(() =>
      registerAgentRuntimeManualDriver({
        agentId: 'registered-agent',
        driver: new AgentRuntimeManualDriver({ nextAction: () => null }),
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
      })
    ).toThrow('[MANUAL_DRIVE_DUPLICATE]');

    dispose();
    expect(getAgentRuntimeManualDriverRegistration('registered-agent')).toBeUndefined();
  });

  it('rejects unscoped or invalid registrations before exposing a control target', () => {
    const driver = new AgentRuntimeManualDriver({ nextAction: () => null });
    expect(() =>
      registerAgentRuntimeManualDriver({ agentId: 'unscoped-agent', driver, scope: {} })
    ).toThrow('[MANUAL_DRIVE_SCOPE_REQUIRED]');
    expect(() =>
      registerAgentRuntimeManualDriver({
        agentId: 'invalid-driver',
        driver: {} as AgentRuntimeManualDriver,
        scope: { scope_kind: 'system', tier: 'public' },
      })
    ).toThrow('[MANUAL_DRIVE_DRIVER_INVALID]');
  });
});
