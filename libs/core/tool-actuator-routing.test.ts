import { describe, expect, it } from 'vitest';

import { getToolActuatorRoutingPolicy, resolveToolActuatorRoute } from './tool-actuator-routing.js';

describe('tool-actuator-routing', () => {
  it('loads the governed policy and resolves a configured tool route', () => {
    const policy = getToolActuatorRoutingPolicy();
    expect(policy.version).toBe('1.0.0');

    expect(resolveToolActuatorRoute({ toolName: 'run_pipeline' })).toEqual(
      expect.objectContaining({
        tool_name: 'run_pipeline',
        execution_mode: 'deterministic_pipeline',
        preferred_actuators: ['orchestrator-actuator'],
        source: 'policy_match',
      })
    );
  });

  it('uses the governed fallback for an unknown tool', () => {
    expect(resolveToolActuatorRoute({ toolName: 'unknown_tool' })).toEqual(
      expect.objectContaining({
        tool_name: 'unknown_tool',
        execution_mode: 'llm_reasoning',
        preferred_actuators: ['orchestrator-actuator'],
        require_approval_on_mismatch: true,
        source: 'fallback',
      })
    );
  });

  it('fails closed for an external policy override', () => {
    const original = process.env.KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH;
    process.env.KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH =
      '/tmp/kyberion-tool-routing-policy-external.json';
    try {
      expect(() => getToolActuatorRoutingPolicy()).toThrow('[RESOURCE_PATH_SCOPE]');
    } finally {
      if (original === undefined) delete process.env.KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH;
      else process.env.KYBERION_TOOL_ACTUATOR_ROUTING_POLICY_PATH = original;
    }
  });
});
