import { describe, expect, it } from 'vitest';
import {
  parseManualCancelResponse,
  parseManualCommandStatusResponse,
  parseManualExecutionResponse,
  parseManualPeekResponse,
  parseManualQueuedResponse,
} from './agent-manual-response';

const action = {
  action_id: 'action-1',
  kind: 'execute_tool',
  title: 'Run the approved tool',
  description: 'One safe step',
  requires_approval: true,
  status: 'ready',
  approval: { status: 'approved', request_id: 'approval-1' },
};

describe('agent manual response boundary', () => {
  it('accepts peek, queued, and durable status responses', () => {
    expect(parseManualPeekResponse({ status: 'ok', agentId: 'agent-1', action })).toMatchObject({
      agentId: 'agent-1',
      action,
    });
    expect(
      parseManualQueuedResponse({
        status: 'queued',
        agentId: 'agent-1',
        commandId: 'command-1',
        action,
      })
    ).toMatchObject({ commandId: 'command-1', action });
    expect(
      parseManualCommandStatusResponse({
        status: 'completed',
        agentId: 'agent-1',
        commandId: 'command-1',
        actionStatus: 'awaiting_approval',
        approval: { status: 'pending' },
        action: { ...action, status: 'awaiting_approval' },
      })
    ).toMatchObject({ state: 'completed', actionStatus: 'awaiting_approval' });
  });

  it('accepts immediate execution and cancellation results', () => {
    expect(
      parseManualExecutionResponse({
        status: 'awaiting_approval',
        agentId: 'agent-1',
        action: { ...action, status: 'awaiting_approval' },
        approval: { status: 'pending' },
      })
    ).toMatchObject({ status: 'awaiting_approval', agentId: 'agent-1' });
    expect(
      parseManualCancelResponse({
        status: 'cancelled',
        agentId: 'agent-1',
        commandId: 'command-1',
      })
    ).toEqual({ status: 'cancelled', agentId: 'agent-1', commandId: 'command-1' });
  });

  it('rejects invalid states, action shapes, and dangerous nested keys', () => {
    expect(
      parseManualPeekResponse({
        status: 'ok',
        agentId: 'agent-1',
        action: { ...action, kind: 'shell' },
      })
    ).toBeUndefined();
    expect(
      parseManualCommandStatusResponse({
        status: 'completed',
        agentId: 'agent-1',
        commandId: 'command-1',
        actionStatus: 'queued',
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"status":"ok","agentId":"agent-1","action":{"action_id":"action-1","kind":"execute_tool","title":"Run the approved tool","status":"ready","__proto__":"bad"}}'
    );
    expect(parseManualPeekResponse(unsafe)).toBeUndefined();
  });
});
