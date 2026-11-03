import { describe, expect, it } from 'vitest';
import { parseDiagnosticsResponse } from './intelligence-diagnostics-response';

const payload = {
  activeMissions: [{ missionId: 'mission-1', status: 'paused', nextTaskCount: 2 }],
  runtimeDoctor: [{ agentId: 'agent-1', reason: 'Needs review', severity: 'critical' }],
  surfaces: [{ id: 'chronos', health: 'unhealthy', controlSummary: 'needs attention' }],
  recentSurfaceOutbox: [{ message_id: 'message-1', surface: 'slack', text: 'Review needed' }],
};

describe('intelligence diagnostics response boundary', () => {
  it('accepts the diagnostic fields consumed by DiagnosticsAttentionSummary', () => {
    expect(parseDiagnosticsResponse(payload)).toEqual(payload);
  });

  it('accepts empty diagnostic collections', () => {
    expect(
      parseDiagnosticsResponse({
        activeMissions: [],
        runtimeDoctor: [],
        surfaces: [],
        recentSurfaceOutbox: [],
      })
    ).toEqual({ activeMissions: [], runtimeDoctor: [], surfaces: [], recentSurfaceOutbox: [] });
  });

  it('rejects invalid counters, severity, and missing required arrays', () => {
    expect(
      parseDiagnosticsResponse({
        ...payload,
        activeMissions: [{ ...payload.activeMissions[0], nextTaskCount: -1 }],
      })
    ).toBeUndefined();
    expect(
      parseDiagnosticsResponse({
        ...payload,
        runtimeDoctor: [{ ...payload.runtimeDoctor[0], severity: 'info' }],
      })
    ).toBeUndefined();
    expect(parseDiagnosticsResponse({ activeMissions: [] })).toBeUndefined();
  });

  it('rejects primitive entries and unsafe nested keys', () => {
    expect(parseDiagnosticsResponse({ ...payload, surfaces: ['bad'] })).toBeUndefined();
    const unsafe = JSON.parse(
      '{"activeMissions":[],"runtimeDoctor":[],"surfaces":[],"recentSurfaceOutbox":[{"message_id":"message-1","surface":"slack","text":"Review","__proto__":"bad"}]}'
    );
    expect(parseDiagnosticsResponse(unsafe)).toBeUndefined();
  });
});
