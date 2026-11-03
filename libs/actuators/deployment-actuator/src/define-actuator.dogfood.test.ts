import { describe, expect, it } from 'vitest';
import { actuator } from './index.js';

describe('deployment-actuator defineActuator dogfood', () => {
  it('exposes deploy_release through the declarative SDK', () => {
    expect(actuator.id).toBe('deployment-actuator');
    const ops = actuator.describeOps().map((entry) => entry.op);
    expect(ops).toContain('deploy_release');
  });

  it('rejects invalid deploy_release input via validateInput', async () => {
    const result = await actuator.dispatch('deploy_release', { mission_id: 'only-one-field' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires mission_id/);
  });
});
