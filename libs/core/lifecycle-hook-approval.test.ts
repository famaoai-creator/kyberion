import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(),
  listApprovalRequests: vi.fn(),
  recordGovernanceAction: vi.fn(),
}));

vi.mock('./approval-store.js', () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  listApprovalRequests: mocks.listApprovalRequests,
}));
vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: mocks.recordGovernanceAction,
}));

import {
  LifecycleHookEngine,
  fireDefaultLifecycleHooks,
  fireLifecycleHooksWithApproval,
  getDefaultLifecycleHookEngine,
  registerDefaultLifecycleHookApprovalSurface,
  resetDefaultLifecycleHookApprovalSurface,
  resetDefaultLifecycleHookEngine,
} from './lifecycle-hook-engine.js';

describe('lifecycle hook approval surface adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDefaultLifecycleHookApprovalSurface();
    resetDefaultLifecycleHookEngine();
    mocks.listApprovalRequests.mockReturnValue([]);
    mocks.createApprovalRequest.mockReturnValue({ id: 'approval-1' });
  });

  afterEach(() => {
    resetDefaultLifecycleHookApprovalSurface();
    resetDefaultLifecycleHookEngine();
  });

  it('materializes an interactive ask into the shared approval store', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'operator-check',
      event: 'pre_tool_use',
      handler: () => ({ decision: 'ask', block: false, reason: 'review required' }),
    });

    const outcome = await fireLifecycleHooksWithApproval(
      engine,
      'pre_tool_use',
      { matcher_value: 'service:publish' },
      {
        channel: 'presence',
        threadTs: 'thread-1',
        correlationId: 'corr-1',
        requestedBy: 'worker-1',
      }
    );

    expect(outcome).toMatchObject({
      decision: 'ask',
      blocked: true,
      approvalRequestId: 'approval-1',
    });
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      'surface_runtime',
      expect.objectContaining({
        channel: 'presence',
        threadTs: 'thread-1',
        correlationId: 'corr-1',
        requestedBy: 'worker-1',
        accountability: { finalDecision: 'human_only' },
      })
    );
  });

  it('reuses the pending request for a retried lifecycle fire', async () => {
    const engine = new LifecycleHookEngine();
    engine.register({
      id: 'operator-check',
      event: 'pre_tool_use',
      handler: () => ({ decision: 'ask', block: false, reason: 'review required' }),
    });
    mocks.listApprovalRequests.mockReturnValue([
      {
        id: 'existing-approval',
        correlationId: 'corr-2',
        channel: 'presence',
        requestedBy: 'worker-2',
        status: 'pending',
        kind: 'channel-approval',
      },
    ]);

    const outcome = await fireLifecycleHooksWithApproval(
      engine,
      'pre_tool_use',
      {},
      {
        channel: 'presence',
        threadTs: 'thread-2',
        correlationId: 'corr-2',
        requestedBy: 'worker-2',
      }
    );

    expect(outcome.approvalRequestId).toBe('existing-approval');
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('routes the default engine ask through the installed global surface', async () => {
    const engine = getDefaultLifecycleHookEngine();
    engine.register({
      id: 'default-operator-check',
      event: 'pre_tool_use',
      handler: () => ({ decision: 'ask', block: false, reason: 'default review' }),
    });
    const dispose = registerDefaultLifecycleHookApprovalSurface(() => ({
      channel: 'presence',
      threadTs: 'thread-default',
      correlationId: 'corr-default',
      requestedBy: 'worker-default',
    }));

    const outcome = await fireDefaultLifecycleHooks('pre_tool_use', {
      matcher_value: 'service:publish',
    });

    expect(outcome).toMatchObject({
      decision: 'ask',
      blocked: true,
      approvalRequestId: 'approval-1',
    });
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('keeps an ask blocked when no global surface is installed', async () => {
    const engine = getDefaultLifecycleHookEngine();
    engine.register({
      id: 'unhandled-ask',
      event: 'pre_tool_use',
      handler: () => ({ decision: 'ask', block: false, reason: 'surface required' }),
    });

    const outcome = await fireDefaultLifecycleHooks('pre_tool_use');

    expect(outcome).toMatchObject({ decision: 'ask', blocked: true });
    expect(outcome.approvalRequestId).toBeUndefined();
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('rejects replacing an active global surface', () => {
    const first = () => undefined;
    const second = () => undefined;
    const dispose = registerDefaultLifecycleHookApprovalSurface(first);
    expect(() => registerDefaultLifecycleHookApprovalSurface(second)).toThrow(
      '[HOOK_APPROVAL_SURFACE_ALREADY_REGISTERED]'
    );
    dispose();
  });
});
