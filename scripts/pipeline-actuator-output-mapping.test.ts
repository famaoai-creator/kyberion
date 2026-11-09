import { describe, expect, it } from 'vitest';
import {
  isPipelineRunEnvelope,
  mapActuatorDispatchOutputToContext,
  resolveSemanticActuatorStepKind,
} from './pipeline-execution-part-bootstrap.js';

describe('actuator dispatch output → pipeline context mapping', () => {
  it('recovers capture/transform after the engine collapses types to apply', () => {
    expect(resolveSemanticActuatorStepKind('vcs', 'log', 'apply')).toBe('capture');
    expect(resolveSemanticActuatorStepKind('system', 'json_query', 'apply')).toBe('transform');
    expect(resolveSemanticActuatorStepKind('vcs', 'commit', 'apply')).toBe('apply');
    expect(resolveSemanticActuatorStepKind('vcs', 'log', 'capture')).toBe('capture');
  });

  it('detects one-step pipeline envelopes', () => {
    expect(
      isPipelineRunEnvelope({
        status: 'succeeded',
        results: [{ op: 'json_query', status: 'success' }],
        context: { last_transform: 'accepted' },
        total_steps: 1,
      })
    ).toBe(true);
    expect(isPipelineRunEnvelope({ op: 'log', cwd: '.', output: 'abc' })).toBe(false);
    expect(isPipelineRunEnvelope([{ name: 'cal' }])).toBe(false);
  });

  it('keeps envelopes so downstream unwrap can read nested channels', () => {
    const ctx = mapActuatorDispatchOutputToContext(
      { seed: 1 },
      {
        status: 'succeeded',
        results: [],
        context: { __ptc_result_1: 'accepted', seed: 1 },
        total_steps: 1,
      },
      'transform',
      { export_as: '__ptc_result_1' }
    );
    expect(ctx).toMatchObject({
      seed: 1,
      status: 'succeeded',
      total_steps: 1,
      context: { __ptc_result_1: 'accepted', seed: 1 },
    });
    expect(ctx.__ptc_result_1).toBeUndefined();
  });

  it('lands bare capture payloads on last_capture (vcs:log shape)', () => {
    const payload = { op: 'log', cwd: '/repo', output: 'abc\n' };
    expect(mapActuatorDispatchOutputToContext({}, payload, 'capture', {})).toEqual({
      last_capture: payload,
    });
  });

  it('lands bare transform payloads on export_as when set', () => {
    expect(
      mapActuatorDispatchOutputToContext({}, { rows: [1] }, 'transform', {
        export_as: 'filtered',
      })
    ).toEqual({ filtered: { rows: [1] } });
  });

  it('lands array payloads on the capture channel', () => {
    const calendars = [{ name: 'work' }];
    expect(mapActuatorDispatchOutputToContext({}, calendars, 'capture', {})).toEqual({
      last_capture: calendars,
    });
  });
});
