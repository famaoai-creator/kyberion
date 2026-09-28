import { describe, expect, it } from 'vitest';
import {
  assertObservationOpMappingsValid,
  chooseNativeOps,
  validateObservationOpMappings,
} from './native-op-mapping.js';

describe('native observation operation mapping', () => {
  it('loads the mapping through the governed schema boundary', () => {
    expect(() => assertObservationOpMappingsValid()).not.toThrow();
    expect(chooseNativeOps('Please open the GitHub issue')).toMatchObject({
      mapping_id: 'github-issue',
      gui_fallback: false,
      ops: ['gh:issue', 'gh:pr'],
    });
  });

  it('rejects actuator operations that are not registered', () => {
    expect(
      validateObservationOpMappings([
        {
          id: 'invalid',
          signals: ['invalid'],
          preferred_ops: ['missing:operation'],
          fallback_ops: [],
        },
      ])
    ).toEqual(['invalid: unknown actuator op missing:operation']);
  });
});
