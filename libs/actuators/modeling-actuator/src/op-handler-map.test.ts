import { describe, expect, it } from 'vitest';
import { loadActuatorOpRegistry } from '@agent/core/actuator/actuator-op-registry';
import {
  MODELING_APPLY_OP_HANDLERS,
  MODELING_CAPTURE_OP_HANDLERS,
  MODELING_CONTROL_OP_HANDLERS,
  MODELING_TRANSFORM_OP_HANDLERS,
} from './modeling-pipeline-helpers.js';

// RS-07: op dispatch is a handler map keyed by op name; keys must equal the
// governed op registry for this actuator.
describe('modeling-actuator op handler maps (RS-07)', () => {
  const registry = loadActuatorOpRegistry().domains.modeling;
  const cases = [
    ['capture', MODELING_CAPTURE_OP_HANDLERS],
    ['transform', MODELING_TRANSFORM_OP_HANDLERS],
    ['apply', MODELING_APPLY_OP_HANDLERS],
    ['control', MODELING_CONTROL_OP_HANDLERS],
  ] as const;

  for (const [stepType, handlers] of cases) {
    it(`${stepType} handler keys equal the registry ${stepType} ops`, () => {
      expect(Object.keys(handlers).sort()).toEqual([...(registry[stepType] ?? [])].sort());
    });
  }
});
