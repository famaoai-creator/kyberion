import { describe, expect, it } from 'vitest';
import { asActuatorContextPatch, CONTEXT_PATCH_BRAND } from '@agent/core/actuator/actuator-sdk';
import {
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

  it('merges branded context patches from legacy envelope ops', () => {
    expect(
      mapActuatorDispatchOutputToContext(
        { seed: 1 },
        asActuatorContextPatch({ exists: true, seed: 1 }),
        'capture',
        {}
      )
    ).toEqual({ seed: 1, exists: true });
  });

  it('lands bare capture payloads on last_capture', () => {
    const payload = { op: 'log', cwd: '/repo', output: 'abc\n' };
    expect(mapActuatorDispatchOutputToContext({}, payload, 'capture', {})).toEqual({
      last_capture: payload,
    });
  });

  it('lands channel values on export_as', () => {
    expect(
      mapActuatorDispatchOutputToContext({}, 'accepted', 'transform', {
        export_as: 'got',
      })
    ).toEqual({ got: 'accepted' });
  });

  it('lands array payloads on the capture channel', () => {
    const calendars = [{ name: 'work' }];
    expect(mapActuatorDispatchOutputToContext({}, calendars, 'capture', {})).toEqual({
      last_capture: calendars,
    });
  });

  it('refuses legacy run envelopes at the engine boundary', () => {
    expect(() =>
      mapActuatorDispatchOutputToContext(
        {},
        {
          status: 'succeeded',
          results: [],
          context: { last_capture: 'x' },
          total_steps: 1,
        },
        'capture',
        {}
      )
    ).toThrow(/ACTUATOR_OUTPUT_ENVELOPE/);
  });

  it('does not leak the patch brand into context', () => {
    const mapped = mapActuatorDispatchOutputToContext(
      {},
      asActuatorContextPatch({ exists: true }),
      'apply',
      {}
    );
    expect(mapped[CONTEXT_PATCH_BRAND]).toBeUndefined();
    expect(mapped.exists).toBe(true);
  });
});
