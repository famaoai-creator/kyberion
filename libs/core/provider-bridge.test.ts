import { describe, expect, it } from 'vitest';
import { buildProviderInvocationPlan } from './provider-bridge.js';

describe('provider-bridge', () => {
  it('builds a gemini prompt invocation with structured output flags', () => {
    const plan = buildProviderInvocationPlan(
      {
        capability_id: 'cli.native.gemini_headless_prompt',
        source: { type: 'cli_native', provider: 'gemini-cli', name: 'prompt', version: 'v1' },
        kind: 'reasoning',
        interaction_mode: 'request_response',
        risk_class: 'medium',
        replayability: 'partial',
        approval_hooks: { requires_pre_approval: true, approval_scope: 'action' },
        preferred_usage: { workflow_shapes: ['task_session'], intents: ['reasoning-session'] },
        fallback_path: { mode: 'kyberion_local_pipeline', target: 'reasoning-backend' },
        status: 'active',
      },
      { capabilityId: 'cli.native.gemini_headless_prompt', payload: 'hello world' },
    );

    expect(plan.bin).toBe('gemini');
    expect(plan.args).toEqual(['-p', 'hello world', '-o', 'json', '-y']);
  });

  it('builds a codex exec invocation with json mode', () => {
    const plan = buildProviderInvocationPlan(
      {
        capability_id: 'cli.native.codex_exec',
        source: { type: 'cli_native', provider: 'codex-cli', name: 'exec', version: 'v1' },
        kind: 'reasoning',
        interaction_mode: 'request_response',
        risk_class: 'medium',
        replayability: 'partial',
        approval_hooks: { requires_pre_approval: true, approval_scope: 'action' },
        preferred_usage: { workflow_shapes: ['task_session'], intents: ['generate-patch'] },
        fallback_path: { mode: 'kyberion_local_pipeline', target: 'reasoning-backend' },
        status: 'active',
      },
      { capabilityId: 'cli.native.codex_exec', payload: 'summarize the diff' },
    );

    expect(plan.bin).toBe('codex');
    expect(plan.args).toEqual(['exec', '--json', 'summarize the diff']);
  });

  it('rejects non-cli-native capabilities', () => {
    expect(() =>
      buildProviderInvocationPlan(
        {
          capability_id: 'provider.runtime.codex_app_server',
          source: { type: 'agent_runtime', provider: 'codex-cli', name: 'app-server', version: 'v1' },
          kind: 'reasoning',
          interaction_mode: 'request_response',
          risk_class: 'medium',
          replayability: 'partial',
          approval_hooks: { requires_pre_approval: true, approval_scope: 'action' },
          preferred_usage: { workflow_shapes: ['task_session'], intents: ['long-lived-analysis'] },
          fallback_path: { mode: 'kyberion_local_pipeline', target: 'reasoning-backend' },
          status: 'active',
        },
        { capabilityId: 'provider.runtime.codex_app_server', payload: 'should fail' },
      ),
    ).toThrow(/not CLI-native/);
  });

  it('maps gh workflow dispatch to the underlying gh workflow run command', () => {
    const plan = buildProviderInvocationPlan(
      {
        capability_id: 'cli.native.github_actions_inspection',
        source: { type: 'cli_native', provider: 'gh', name: 'run-workflow', version: 'v1' },
        kind: 'deterministic_utility',
        interaction_mode: 'deterministic_task',
        risk_class: 'low',
        replayability: 'deterministic',
        approval_hooks: { requires_pre_approval: false, approval_scope: 'none' },
        preferred_usage: { workflow_shapes: ['task_session'], intents: ['workflow-dispatch'] },
        fallback_path: { mode: 'kyberion_local_actuator', target: 'orchestrator-actuator' },
        status: 'active',
      },
      { capabilityId: 'cli.native.github_actions_inspection', args: ['dispatch', '--repo', 'owner/repo'] },
    );

    expect(plan.bin).toBe('gh');
    expect(plan.args).toEqual(['workflow', 'run', 'dispatch', '--repo', 'owner/repo']);
  });
});
