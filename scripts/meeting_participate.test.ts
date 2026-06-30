import { describe, expect, it } from 'vitest';
import { TraceContext } from '@agent/core';
import {
  assertMeetingParticipationRuntime,
  evaluateMeetingBootstrapGate,
  prepareMeetingTarget,
  resolveMeetingParticipationVoiceProfile,
} from './meeting_participate.js';
import { resolveMeetingParticipationRuntimePlan } from '@agent/core';

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

  it('fails closed when realtime voice is requested without real bridges', () => {
    const plan = resolveMeetingParticipationRuntimePlan({ transport_mode: 'realtime_voice' });

    expect(() =>
      assertMeetingParticipationRuntime({
        runtimePlan: plan,
        bus: { bus_id: 'stub' },
        busProbe: { available: true },
        stt: { bridge_id: 'stub' },
        tts: { bridge_id: 'stub' },
      }),
    ).toThrow(/requires a real audio bus/);
  });

  it('allows dry-run plans to proceed with stubbed runtime pieces', () => {
    const plan = resolveMeetingParticipationRuntimePlan({
      transport_mode: 'realtime_voice',
      dry_run: true,
    });

    expect(() =>
      assertMeetingParticipationRuntime({
        runtimePlan: plan,
        bus: { bus_id: 'stub' },
        busProbe: { available: false, reason: 'not installed' },
        stt: { bridge_id: 'stub' },
        tts: { bridge_id: 'stub' },
      }),
    ).not.toThrow();
  });

  it('resolves the registry default voice profile when none is provided', () => {
    const profile = resolveMeetingParticipationVoiceProfile({
      registry: {
        version: 'test',
        default_profile_id: 'operator-ja-default',
        profiles: [
          {
            profile_id: 'operator-ja-default',
            display_name: 'Operator Japanese Default',
            tier: 'public',
            languages: ['ja'],
            default_engine_id: 'local_say',
            status: 'active',
          },
        ],
      },
    });

    expect(profile.profile_id).toBe('operator-ja-default');
  });

  it('rejects an explicit voice profile that is missing from the registry', () => {
    expect(() =>
      resolveMeetingParticipationVoiceProfile({
        voiceProfileId: 'operator-default-v1',
        registry: {
          version: 'test',
          default_profile_id: 'operator-ja-default',
          profiles: [
            {
              profile_id: 'operator-ja-default',
              display_name: 'Operator Japanese Default',
              tier: 'public',
              languages: ['ja'],
              default_engine_id: 'local_say',
              status: 'active',
            },
          ],
        },
      }),
    ).toThrow(/not present in the active registry/);
  });
});
