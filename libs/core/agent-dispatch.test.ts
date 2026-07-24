import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DispatchingReasoningBackend,
  HarnessSubagentDispatcher,
  InSessionDispatcher,
  ProcessSpawnDispatcher,
  maybeWrapWithDispatcher,
  selectAgentDispatcher,
} from './agent-dispatch.js';
import type { ReasoningBackend } from './reasoning-backend.js';
import {
  SUBAGENT_CAPABILITY_PROFILES,
  SUBAGENT_PROFILE_CLI_TOOLS,
  getSubagentCapabilityProfile,
} from './subagent-capability-profiles.js';
import { a2aBridge } from './a2a-bridge.js';
import {
  getDefaultWorkerEventStream,
  resetDefaultWorkerEventStream,
  type WorkerEventEnvelope,
} from './worker-event-stream.js';

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

/**
 * CT-02: HarnessSubagentDispatcher — dispatches through the governed Claude
 * Agent SDK path (runClaudeAgentTask + Kyberion MCP + canUseTool). The real
 * SDK is never touched: HarnessSubagentDispatcher lazily imports
 * `claude-agent-query.js` / `claude-agent-governance.js` only inside
 * `dispatch()`, and every test below injects `loadRuntime` to replace that
 * import entirely — so the SDK-unavailable path is exercised by a
 * *rejecting* fake loader, not by uninstalling anything.
 */
describe('HarnessSubagentDispatcher (CT-02)', () => {
  beforeEach(() => {
    resetDefaultWorkerEventStream();
  });

  afterEach(() => {
    resetDefaultWorkerEventStream();
  });

  const ALL_GOVERNED_TOOLS = [
    'Read',
    'Grep',
    'Glob',
    'NotebookRead',
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
  ];

  function makeFakeRuntime(runTaskImpl?: (params: any) => Promise<any>) {
    return {
      runTask:
        runTaskImpl ??
        vi.fn(async () => ({
          text: 'harness-result',
          sessionId: 's1',
          totalCostUsd: 0,
          numTurns: 1,
        })),
      buildGovernedAgentSystemPrompt: vi.fn(({ base, missionContext }: any) =>
        [base, missionContext ? `Mission context:\n${missionContext}` : '']
          .filter(Boolean)
          .join('\n\n')
      ),
      buildKyberionMcpServerConfig: vi.fn(() => ({ kyberion: {} }) as any),
      createKyberionCanUseTool: vi.fn(() => vi.fn() as any),
      allowedTools: ALL_GOVERNED_TOOLS,
    };
  }

  function collectEvents(): WorkerEventEnvelope[] {
    const events: WorkerEventEnvelope[] = [];
    getDefaultWorkerEventStream().subscribe((e) => events.push(e));
    return events;
  }

  it('applies the KD-05 profile system prompt prefix and tool allowlist (explorer ⇒ no write/execute tools)', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();

    const out = await dispatcher.dispatch('investigate the bug', 'mission ctx', backend, {
      profile: 'explorer',
    });

    expect(out).toBe('harness-result');
    expect(runtime.runTask).toHaveBeenCalledTimes(1);
    const call = (runtime.runTask as any).mock.calls[0][0];
    const explorerProfile = getSubagentCapabilityProfile('explorer');
    expect(call.systemPrompt).toContain(explorerProfile.systemPromptPrefix);
    expect(call.systemPrompt).toContain('mission ctx');
    expect(call.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'NotebookRead']);
    expect(call.allowedTools).not.toContain('Write');
    expect(call.allowedTools).not.toContain('Edit');
    expect(call.allowedTools).not.toContain('Bash');
    // Wave-3 drift prevention: the harness ceiling here (ALL_GOVERNED_TOOLS)
    // is a superset of explorer's SSoT tools, so the intersection equals the
    // SSoT list exactly — proving this dispatcher consumes
    // SUBAGENT_PROFILE_CLI_TOOLS rather than a locally hand-mirrored table.
    expect(call.allowedTools).toEqual(SUBAGENT_PROFILE_CLI_TOOLS.explorer);
  });

  it('defaults to the implementer profile when no role/profile hint is given', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();

    await dispatcher.dispatch('do work', undefined, backend);

    const call = (runtime.runTask as any).mock.calls[0][0];
    const implementerProfile = getSubagentCapabilityProfile('implementer');
    expect(call.systemPrompt).toContain(implementerProfile.systemPromptPrefix);
    expect(call.allowedTools).toContain('Bash');
    expect(call.allowedTools).toContain('Write');
  });

  it('degrades an unrecognized profile hint to implementer without failing the dispatch', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();

    const out = await dispatcher.dispatch('do work', undefined, backend, {
      profile: 'nonexistent-tier',
    });

    expect(out).toBe('harness-result');
    const call = (runtime.runTask as any).mock.calls[0][0];
    const implementerProfile = getSubagentCapabilityProfile('implementer');
    expect(call.systemPrompt).toContain(implementerProfile.systemPromptPrefix);
  });

  it('produces an empty allowlist (no tool execution) for the planner profile', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();

    await dispatcher.dispatch('plan it', undefined, backend, { profile: 'planner' });

    const call = (runtime.runTask as any).mock.calls[0][0];
    expect(call.allowedTools).toEqual([]);
  });

  it('falls back to ProcessSpawnDispatcher when the Agent SDK is unavailable (fail-open)', async () => {
    const dispatcher = new HarnessSubagentDispatcher({
      loadRuntime: async () => {
        throw new Error('Cannot find module "@anthropic-ai/claude-agent-sdk"');
      },
    });
    const backend = makeFakeBackend();

    const out = await dispatcher.dispatch('do X', 'ctx', backend);
    expect(out).toBe('spawned:do X');
    expect(backend.delegateTask).toHaveBeenCalledWith('do X', 'ctx');
  });

  it('emits subagent_begin/subagent_end(status=success) on the KC-02 worker event stream', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do work', undefined, backend);

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[0].payload.dispatcher).toBe('harness-subagent');
    expect(events[1].payload.status).toBe('success');
  });

  it('emits subagent_end(status=failure) and rethrows when the governed task errors', async () => {
    const runtime = makeFakeRuntime(async () => {
      throw new Error('boom');
    });
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await expect(dispatcher.dispatch('do work', undefined, backend)).rejects.toThrow('boom');

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[1].payload.status).toBe('failure');
    expect(events[1].payload.error).toContain('boom');
  });

  it('emits subagent_end(status=fallback) when the SDK is unavailable', async () => {
    const dispatcher = new HarnessSubagentDispatcher({
      loadRuntime: async () => {
        throw new Error('sdk unavailable');
      },
    });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do X', 'ctx', backend);

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[1].payload.status).toBe('fallback');
  });

  it('callers of delegateTask need no changes: DispatchingReasoningBackend forwards the profile hint through unmodified', async () => {
    const runtime = makeFakeRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const wrapped: ReasoningBackend = new DispatchingReasoningBackend(backend, dispatcher);

    // Pre-existing call shape (no options) keeps working unchanged.
    const out = await wrapped.delegateTask('task', 'ctx');
    expect(out).toBe('harness-result');

    // The new options bag (role/profile hint) flows through untouched.
    await wrapped.delegateTask('task2', 'ctx2', { profile: 'planner' });
    const secondCall = (runtime.runTask as any).mock.calls[1][0];
    const plannerProfile = getSubagentCapabilityProfile('planner');
    expect(secondCall.systemPrompt).toContain(plannerProfile.systemPromptPrefix);
    expect(secondCall.allowedTools).toEqual([]);
  });

  it('selectAgentDispatcher / maybeWrapWithDispatcher honor KYBERION_HARNESS_SUBAGENT', () => {
    expect(
      selectAgentDispatcher({ KYBERION_HARNESS_SUBAGENT: '1' } as unknown as NodeJS.ProcessEnv).name
    ).toBe('harness-subagent');
    // Takes precedence over KYBERION_IN_SESSION_SUBAGENT when both are set.
    expect(
      selectAgentDispatcher({
        KYBERION_HARNESS_SUBAGENT: '1',
        KYBERION_IN_SESSION_SUBAGENT: '1',
      } as unknown as NodeJS.ProcessEnv).name
    ).toBe('harness-subagent');

    const backend = makeFakeBackend();
    const wrapped = maybeWrapWithDispatcher(backend, {
      KYBERION_HARNESS_SUBAGENT: '1',
    } as unknown as NodeJS.ProcessEnv);
    expect(wrapped).not.toBe(backend);
    expect(wrapped).toBeInstanceOf(DispatchingReasoningBackend);
    expect(wrapped.name).toBe('fake+harness-subagent');
  });
});
