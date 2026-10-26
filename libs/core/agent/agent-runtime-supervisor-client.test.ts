import { describe, expect, it } from 'vitest';
import {
  toSupervisorEnsurePayload,
  normalizeSupervisorResponse,
  normalizeSupervisorResult,
  resolveAskTransportTimeout,
  restoreSupervisorError,
  isSupervisorRemoteError,
} from './agent-runtime-supervisor-client.js';
import { isAgentRuntimeApprovalPendingError } from './agent-prompt-approval-port.js';

describe('normalizeSupervisorResponse', () => {
  it('distinguishes acknowledged server failures from local transport unavailability', () => {
    const remote = restoreSupervisorError('[TASK_TOOL_OUTPUT_UNVERIFIED] Original server cause');
    expect(isSupervisorRemoteError(remote)).toBe(true);
    expect(
      isSupervisorRemoteError(new Error('[SUPERVISOR_PREASK_FAILED] method=health ECONNREFUSED'))
    ).toBe(false);
  });
  it('restores an approval suspension across the daemon transport', () => {
    const error = restoreSupervisorError('pending', {
      code: 'AGENT_APPROVAL_PENDING',
      approval_request_id: 'approval-1',
      approval_storage_channel: 'pipeline-approvals',
      approval_kind: 'pipeline',
      scope: { tier: 'public', mission_id: 'MSN-A' },
    });
    expect(isAgentRuntimeApprovalPendingError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'AGENT_APPROVAL_PENDING',
      approvalRequestId: 'approval-1',
      approvalStorageChannel: 'pipeline-approvals',
      approvalKind: 'pipeline',
      scope: { mission_id: 'MSN-A' },
    });
    expect(
      isAgentRuntimeApprovalPendingError(
        restoreSupervisorError('bad', { code: 'AGENT_APPROVAL_PENDING' })
      )
    ).toBe(false);
  });
  it('accepts a valid response envelope and preserves the result', () => {
    expect(
      normalizeSupervisorResponse<{ text: string }>({
        id: 'ask-1',
        ok: true,
        result: { text: 'done' },
      })
    ).toEqual({ id: 'ask-1', ok: true, result: { text: 'done' } });
  });

  it.each([
    null,
    [],
    { id: '', ok: true },
    { id: 'response-1', ok: 'true' },
    { id: 'response-1', ok: false, error: 42 },
    { id: 'response-1', ok: false, errorDetail: [] },
  ])('rejects malformed response envelopes: %j', (value) => {
    expect(() => normalizeSupervisorResponse(value)).toThrow();
  });
});

describe('normalizeSupervisorResult', () => {
  it('accepts the endpoint result shapes used by the daemon', () => {
    expect(
      normalizeSupervisorResult('health', {
        ok: true,
        pid: 42,
        socket_path: '/tmp/supervisor.sock',
        code_stamp: 123,
      })
    ).toMatchObject({ ok: true, pid: 42 });
    expect(
      normalizeSupervisorResult('status', {
        agent_id: 'agent-1',
        session_id: null,
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-1' },
        log: [{ message: 'ready' }],
      })
    ).toMatchObject({ agent_id: 'agent-1', session_id: null });
    expect(normalizeSupervisorResult('ask', { text: 'completed' })).toEqual({
      text: 'completed',
    });
  });

  it('rejects malformed endpoint result shapes before callers receive them', () => {
    expect(() => normalizeSupervisorResult('health', { ok: true, pid: '42' })).toThrow();
    expect(() =>
      normalizeSupervisorResult('status', { agent_id: 'agent-1', log: [null] })
    ).toThrow();
    expect(() => normalizeSupervisorResult('status', { agent_id: 42 })).toThrow();
    expect(() => normalizeSupervisorResult('list', [{ agent_id: 'agent-1' }, null])).toThrow();
    expect(() => normalizeSupervisorResult('ask', { text: 42 })).toThrow();
    expect(() => normalizeSupervisorResult('refresh', { refreshed: true })).toThrow();
  });
});

describe('resolveAskTransportTimeout', () => {
  it('keeps the default transport budget for ordinary asks', () => {
    expect(resolveAskTransportTimeout()).toBe(60_000);
    expect(resolveAskTransportTimeout(1_000)).toBe(60_000);
  });

  it('keeps the supervisor socket open beyond a task dispatch budget', () => {
    expect(resolveAskTransportTimeout(180_000)).toBe(185_000);
    expect(resolveAskTransportTimeout(300_000)).toBe(305_000);
  });

  it('refuses to send a tool-less runtime to the daemon, which cannot honor it', () => {
    expect(() =>
      toSupervisorEnsurePayload({
        agentId: 'surface--tenant-acme--confidential',
        provider: 'claude',
        requestedBy: 'surface_agent',
        toolAccess: 'none',
      })
    ).toThrow(/TOOL_LOCKDOWN_UNSUPPORTED/);
  });
});

describe('scoped surface manifest transport', () => {
  it('forwards the base manifest binding without replacing the runtime identity', () => {
    expect(
      toSupervisorEnsurePayload({
        agentId: 'opaque-runtime-instance',
        manifestAgentId: 'presence-surface-agent',
        provider: 'claude',
        requestedBy: 'surface_agent',
        scope: { tier: 'public', viewer_principal: 'viewer-a' },
      })
    ).toMatchObject({
      agentId: 'opaque-runtime-instance',
      manifestAgentId: 'presence-surface-agent',
      scope: { tier: 'public', viewer_principal: 'viewer-a' },
    });
  });
});
