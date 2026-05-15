import { describe, expect, it } from 'vitest';
import { TraceContext } from '@agent/core';
import { evaluateMeetingBootstrapGate, prepareMeetingTarget } from './meeting_participate.js';

describe('meeting_participate bootstrap gate', () => {
  it('records a failed gate in trace and returns not ready', async () => {
    const trace = new TraceContext('meeting_participate:MSN-TEST-001', {
      missionId: 'MSN-TEST-001',
      actuator: 'meeting-participate',
    });

    const result = await evaluateMeetingBootstrapGate('MSN-TEST-001', trace, {
      skipBootstrapCheck: false,
      loadManifest: () =>
        ({
          manifest_id: 'meeting-participation-runtime',
          version: 'test',
          capabilities: [],
        }) as any,
      readinessCheck: () => ({
        ready: false,
        manifest_id: 'meeting-participation-runtime',
        generated_at: '2026-05-08T00:00:00.000Z',
        receipt_expires_at: null,
        missing: [
          {
            capability_id: 'playwright-chromium',
            satisfied: false,
            reason: 'missing browser runtime',
          },
        ],
        receipt_age_minutes: null,
      }),
    });

    expect(result).toEqual({ ready: false, skipped: false });

    const traceDoc = trace.finalize();
    expect(traceDoc.rootSpan.children).toHaveLength(1);
    const gateSpan = traceDoc.rootSpan.children[0];
    expect(gateSpan.name).toBe('meeting_participate.bootstrap_gate');
    expect(gateSpan.status).toBe('error');
    expect(gateSpan.events.map((event) => event.name)).toContain('meeting_participate.bootstrap_gate_failed');
    expect(gateSpan.events.map((event) => event.name)).toContain('meeting_participate.bootstrap_gate_missing');
    expect(traceDoc.rootSpan.status).toBe('error');
  });

  it('records a manifest load error instead of proceeding silently', async () => {
    const trace = new TraceContext('meeting_participate:MSN-TEST-002', {
      missionId: 'MSN-TEST-002',
      actuator: 'meeting-participate',
    });

    const result = await evaluateMeetingBootstrapGate('MSN-TEST-002', trace, {
      skipBootstrapCheck: false,
      loadManifest: () => {
        throw new Error('manifest missing');
      },
    });

    expect(result).toEqual({ ready: false, skipped: false });

    const traceDoc = trace.finalize();
    const gateSpan = traceDoc.rootSpan.children[0];
    expect(gateSpan.status).toBe('error');
    expect(gateSpan.events.map((event) => event.name)).toContain('meeting_participate.bootstrap_gate_error');
    expect(traceDoc.rootSpan.status).toBe('error');
  });

  it('rejects unsupported meeting hosts before coordinator execution', () => {
    expect(() =>
      prepareMeetingTarget({
        url: 'https://example.com/meeting',
        platform: 'auto',
      } as any),
    ).toThrow(/unsupported meeting URL/i);
  });
});
