import { describe, expect, it, vi } from 'vitest';
import {
  DispatchingReasoningBackend,
  InSessionDispatcher,
  ProcessSpawnDispatcher,
  maybeWrapWithDispatcher,
  selectAgentDispatcher,
} from './agent-dispatch.js';
import type { ReasoningBackend } from './reasoning-backend.js';
import {
  SUBAGENT_CAPABILITY_PROFILES,
  getSubagentCapabilityProfile,
} from './subagent-capability-profiles.js';
import { a2aBridge } from './a2a-bridge.js';

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: vi.fn(async () => ({ payload: { content: 'sub-agent-result' } })),
  },
}));

const recordGovernanceAction = vi.fn();
vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
}));

/** Minimal fake backend that records delegation and supports tool-use opt-in. */
function makeFakeBackend(opts: { withTools?: boolean } = {}): ReasoningBackend & {
  delegateTask: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  const backend: any = {
    name: 'fake',
    delegateTask: vi.fn(async (instruction: string) => `spawned:${instruction}`),
    prompt: vi.fn(async (p: string) => `prompted:${p}`),
    extractRequirements: vi.fn(async () => ({ requirements: [] })),
    extractDesignSpec: vi.fn(async () => ({})),
    extractTestPlan: vi.fn(async () => ({})),
    decomposeIntoTasks: vi.fn(async () => ({ tasks: [] })),
    divergePersonas: vi.fn(async () => []),
    crossCritique: vi.fn(async () => ({})),
    synthesizePersona: vi.fn(async () => ({})),
    forkBranches: vi.fn(async () => []),
    simulateBranches: vi.fn(async () => ({})),
  };
  if (opts.withTools) {
    // No tool call → returns text; keeps the test off the real A2A bridge.
    backend.generateWithTools = vi.fn(async () => ({ text: 'no-tool-result' }));
  }
  return backend;
}

describe('agent-dispatch', () => {
  it('ProcessSpawnDispatcher delegates via the backend native delegateTask', async () => {
    const backend = makeFakeBackend();
    const out = await new ProcessSpawnDispatcher().dispatch('do X', 'ctx', backend);
    expect(out).toBe('spawned:do X');
    expect(backend.delegateTask).toHaveBeenCalledWith('do X', 'ctx');
  });

  it('InSessionDispatcher falls back to process-spawn when the base lacks generateWithTools', async () => {
    const backend = makeFakeBackend({ withTools: false });
    const out = await new InSessionDispatcher().dispatch('do Y', undefined, backend);
    expect(out).toBe('spawned:do Y');
    expect(backend.delegateTask).toHaveBeenCalledTimes(1);
  });

  it('InSessionDispatcher uses tool-use planning when available (no tool call → text)', async () => {
    const backend = makeFakeBackend({ withTools: true });
    const out = await new InSessionDispatcher().dispatch('do Z', undefined, backend);
    expect(out).toBe('no-tool-result');
    expect((backend as any).generateWithTools).toHaveBeenCalledTimes(1);
    expect(backend.delegateTask).not.toHaveBeenCalled();
  });

  it('DispatchingReasoningBackend routes delegateTask through the dispatcher and forwards cognition to base', async () => {
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    expect(wrapped.name).toBe('fake+process-spawn');
    await wrapped.delegateTask('task', 'c');
    expect(backend.delegateTask).toHaveBeenCalledWith('task', 'c');

    await wrapped.prompt('hi');
    expect(backend.prompt).toHaveBeenCalledWith('hi');
    await wrapped.extractRequirements({} as any);
    expect((backend as any).extractRequirements).toHaveBeenCalledTimes(1);
  });

  it('InSessionDispatcher breaks a dead-end invoke_agent loop via process-spawn fallback (KC-01)', async () => {
    recordGovernanceAction.mockClear();
    const backend = makeFakeBackend();
    (backend as any).generateWithTools = vi.fn(async () => ({
      toolCalls: [
        { name: 'invoke_agent', input: { agent_name: 'generalist', prompt: 'same task' } },
      ],
    }));
    const dispatcher = new InSessionDispatcher();

    const results: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(await dispatcher.dispatch('do W', undefined, backend));
    }

    // First 11 identical delegations still route in-session…
    expect(results[10]).toContain('[In-Session Rollup]');
    expect(backend.delegateTask).toHaveBeenCalledTimes(1);
    // …the 12th breaks the loop with a fresh process-spawn child.
    expect(results[11]).toBe('spawned:do W');
    expect(recordGovernanceAction).toHaveBeenCalledWith(
      'agent-dispatch:in-session',
      'tool_call_repeat_force_stop',
      expect.stringContaining('streak=12'),
      true
    );

    // Escalation reminder is injected into the next dispatch prompt after the 3rd repeat.
    const prompts = (backend as any).generateWithTools.mock.calls.map((call: any[]) => call[0]);
    expect(prompts[2]).not.toContain('<system-reminder>');
    expect(prompts[3]).toContain('<system-reminder>');
  });

  it('selectAgentDispatcher / maybeWrapWithDispatcher honor KYBERION_IN_SESSION_SUBAGENT', () => {
    expect(selectAgentDispatcher({} as NodeJS.ProcessEnv).name).toBe('process-spawn');
    expect(
      selectAgentDispatcher({ KYBERION_IN_SESSION_SUBAGENT: '1' } as unknown as NodeJS.ProcessEnv)
        .name
    ).toBe('in-session');

    const backend = makeFakeBackend();
    // default: returned unchanged (no decorator overhead)
    expect(maybeWrapWithDispatcher(backend, {} as NodeJS.ProcessEnv)).toBe(backend);
    // opt-in: wrapped in the dispatching decorator
    const wrapped = maybeWrapWithDispatcher(backend, {
      KYBERION_IN_SESSION_SUBAGENT: '1',
    } as unknown as NodeJS.ProcessEnv);
    expect(wrapped).not.toBe(backend);
    expect(wrapped).toBeInstanceOf(DispatchingReasoningBackend);
  });

  // KD-05 acceptance criterion 2: adding a profile requires registration in
  // exactly one place (subagent-capability-profiles.ts); catalog reflection
  // into the dispatch-side tool description follows automatically.
  it('reflects the live subagent capability catalog into the invoke_agent tool description and schema', async () => {
    const backend = makeFakeBackend({ withTools: true });
    await new InSessionDispatcher().dispatch('do it', undefined, backend);

    const tools = (backend as any).generateWithTools.mock.calls[0][1];
    const invokeAgentTool = tools.find((tool: any) => tool.name === 'invoke_agent');
    expect(invokeAgentTool).toBeDefined();
    for (const profile of SUBAGENT_CAPABILITY_PROFILES) {
      expect(invokeAgentTool.description).toContain(profile.name);
      expect(invokeAgentTool.inputSchema.properties.agent_profile.enum).toContain(profile.name);
    }
  });

  it('prefixes the sub-agent prompt with the chosen tier system prompt (explorer)', async () => {
    const backend = makeFakeBackend();
    (backend as any).generateWithTools = vi.fn(async () => ({
      toolCalls: [
        {
          name: 'invoke_agent',
          input: {
            agent_name: 'codebase_investigator',
            prompt: 'Find the bug.',
            agent_profile: 'explorer',
          },
        },
      ],
    }));

    await new InSessionDispatcher().dispatch('investigate', undefined, backend);

    const routedPayload = (a2aBridge.route as any).mock.calls.at(-1)[0];
    const explorerProfile = getSubagentCapabilityProfile('explorer');
    expect(routedPayload.payload.content).toContain(explorerProfile.systemPromptPrefix);
    expect(routedPayload.payload.content).toContain('Find the bug.');
  });

  it('falls back to the default tier for an unrecognized agent_profile without failing the dispatch', async () => {
    const backend = makeFakeBackend();
    (backend as any).generateWithTools = vi.fn(async () => ({
      toolCalls: [
        {
          name: 'invoke_agent',
          input: {
            agent_name: 'generalist',
            prompt: 'Do the thing.',
            agent_profile: 'nonexistent-tier',
          },
        },
      ],
    }));

    const out = await new InSessionDispatcher().dispatch('do it', undefined, backend);
    expect(out).toContain('[In-Session Rollup]');
    const routedPayload = (a2aBridge.route as any).mock.calls.at(-1)[0];
    const implementerProfile = getSubagentCapabilityProfile('implementer');
    expect(routedPayload.payload.content).toContain(implementerProfile.systemPromptPrefix);
  });
});
