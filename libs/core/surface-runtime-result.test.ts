import { describe, expect, it } from 'vitest';
import { parseSurfaceActuatorResult } from './surface-runtime-result.js';

describe('surface actuator result boundary', () => {
  it('accepts an object result', () => {
    expect(parseSurfaceActuatorResult('{"status":"ok"}', 'approval')).toEqual({ status: 'ok' });
  });

  it.each(['[]', 'null', '"ok"', '{'])('rejects non-object or malformed result %s', (output) => {
    expect(() => parseSurfaceActuatorResult(output, 'system')).toThrow(
      'SURFACE_ACTUATOR_RESULT_INVALID'
    );
  });
});
