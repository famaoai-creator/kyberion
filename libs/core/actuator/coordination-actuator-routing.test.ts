import { describe, expect, it } from 'vitest';
import {
  getCoordinationExecutionOverride,
  resolveCoordinationActuatorRoute,
  validateCoordinationActuatorRouting,
} from './coordination-actuator-routing.js';

describe('coordination actuator routing (RS-07)', () => {
  it('only targets actuators from the actuator manifest catalog', () => {
    expect(validateCoordinationActuatorRouting()).toEqual([]);
  });

  it('reports non-actuators placed in target_actuators', () => {
    const violations = validateCoordinationActuatorRouting(['orchestrator-actuator']);
    expect(violations.some((line) => line.includes('"wisdom-actuator"'))).toBe(true);
  });

  it('separates non-actuator runtime components', () => {
    expect(resolveCoordinationActuatorRoute('general')).toEqual({
      target_actuators: ['orchestrator-actuator'],
      support_components: ['intent-compiler'],
    });
    expect(resolveCoordinationActuatorRoute('unregistered-kind')).toEqual(
      resolveCoordinationActuatorRoute('general')
    );
    expect(getCoordinationExecutionOverride('capture_photo').support_components).toEqual([
      'virtual-camera-bridge',
    ]);
  });

  it('fails closed for an unknown execution override', () => {
    expect(() => getCoordinationExecutionOverride('nope')).toThrow(/unknown execution override/);
  });
});
