import { describe, expect, it, vi } from 'vitest';

const remediation = vi.hoisted(() => ({ record: vi.fn(), emit: vi.fn() }));
vi.mock('../../../lib/intelligence-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/intelligence-primitives')>()),
  ledger: { record: remediation.record },
  emitChannelSurfaceEvent: remediation.emit,
}));
vi.mock('./intelligence-observation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./intelligence-observation-data')>()),
  missionTenantSlug: (missionId: string) => (missionId === 'MSN-TENANT' ? 'acme' : undefined),
}));

import {
  parseControlEventLine,
  parseControlEventRecord,
  recordRuntimeRemediationArtifacts,
} from './intelligence-control-data';

describe('runtime remediation ledger record', () => {
  it("names the mission's tenant and records only allow-listed lease metadata", () => {
    const lease = {
      agent_id: 'agent-1',
      owner_id: 'MSN-TENANT',
      owner_type: 'mission',
      metadata: { execution_mode: 'conversation', channel: 'slack', secret_blob: { x: 1 } },
    };
    recordRuntimeRemediationArtifacts({
      action: 'cleanup_runtime_lease',
      agentId: 'agent-1',
      lease,
    });
    expect(remediation.record).toHaveBeenCalledWith('MISSION_RUNTIME_REMEDIATION', {
      mission_id: 'MSN-TENANT',
      tenant_slug: 'acme',
      role: 'chronos_localadmin',
      agent_id: 'agent-1',
      remediation_action: 'cleanup_runtime_lease',
      owner_type: 'mission',
      metadata: { execution_mode: 'conversation', channel: 'slack' },
    });

    remediation.record.mockClear();
    recordRuntimeRemediationArtifacts({
      action: 'restart_runtime_lease',
      agentId: 'agent-2',
      lease: { ...lease, owner_id: 'MSN-NOWHERE', metadata: undefined },
    });
    const [, data] = remediation.record.mock.calls[0];
    expect(data).not.toHaveProperty('tenant_slug');
    expect(data.metadata).toEqual({});
  });
});

describe('intelligence control event parser', () => {
  it('keeps typed control event fields and payload values', () => {
    const event = parseControlEventLine(
      JSON.stringify({
        ts: '2099-01-01T00:00:00.000Z',
        decision: 'mission_orchestration_event_enqueued',
        event_type: 'surface_control_requested',
        event_id: 'event-1',
        requested_by: 'human:operator',
        payload: {
          surfaceId: 'chronos',
          operation: 'restart',
        },
      })
    );

    expect(event).toMatchObject({
      ts: '2099-01-01T00:00:00.000Z',
      decision: 'mission_orchestration_event_enqueued',
      payload: { surfaceId: 'chronos', operation: 'restart' },
    });
  });

  it('rejects malformed timestamp, field, payload, and dangerous-key shapes', () => {
    const base = {
      ts: '2099-01-01T00:00:00.000Z',
      decision: 'mission_control_action_applied',
    };

    expect(parseControlEventLine(JSON.stringify({ ...base, ts: 'not-a-date' }))).toBeNull();
    expect(parseControlEventLine(JSON.stringify({ ...base, operation: ['restart'] }))).toBeNull();
    expect(
      parseControlEventLine(
        JSON.stringify({ ...base, payload: { operation: { value: 'restart' } } })
      )
    ).toBeNull();
    expect(
      parseControlEventLine(
        '{"ts":"2099-01-01T00:00:00.000Z","decision":"event","payload":{"__proto__":{}}}'
      )
    ).toBeNull();
  });

  it('validates already-parsed JSONL records through the same control boundary', () => {
    expect(
      parseControlEventRecord({
        ts: '2099-01-01T00:00:00.000Z',
        decision: 'mission_control_action_applied',
      })
    ).toMatchObject({ decision: 'mission_control_action_applied' });
    expect(parseControlEventRecord(null)).toBeNull();
    expect(parseControlEventRecord(['not-an-event'])).toBeNull();
  });
});
