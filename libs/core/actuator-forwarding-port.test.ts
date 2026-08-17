import { describe, expect, it } from 'vitest';
import {
  getActuatorForwardingPort,
  registerActuatorForwardingPort,
  resetActuatorForwardingPort,
  withActuatorForwardingPort,
  type ActuatorForwardingPort,
} from './actuator-forwarding-port.js';

describe('ActuatorForwardingPort', () => {
  it('rejects a second global provider instead of silently replacing the first', () => {
    const first: ActuatorForwardingPort = {
      forward: async () => ({ forwarded_to: 'a', status: 'succeeded' }),
    };
    const second: ActuatorForwardingPort = {
      forward: async () => ({ forwarded_to: 'b', status: 'succeeded' }),
    };
    registerActuatorForwardingPort(first);
    expect(() => registerActuatorForwardingPort(second)).toThrow(/already registered/);
    resetActuatorForwardingPort();
  });

  it('keeps forwarding ports isolated across concurrent async scopes', async () => {
    const portA: ActuatorForwardingPort = {
      forward: async () => ({ forwarded_to: 'a', status: 'succeeded' }),
    };
    const portB: ActuatorForwardingPort = {
      forward: async () => ({ forwarded_to: 'b', status: 'succeeded' }),
    };

    const [seenA, seenB] = await Promise.all([
      withActuatorForwardingPort(portA, async () => {
        await Promise.resolve();
        return getActuatorForwardingPort();
      }),
      withActuatorForwardingPort(portB, async () => {
        await Promise.resolve();
        return getActuatorForwardingPort();
      }),
    ]);

    expect(seenA).toBe(portA);
    expect(seenB).toBe(portB);
  });
});
