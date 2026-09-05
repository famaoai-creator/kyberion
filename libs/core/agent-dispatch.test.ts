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
import { registerOpPreflightListener, resetOpPreflight } from './op-preflight.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const a2aRoute = vi.hoisted(() =>
  vi.fn(async () => ({ payload: { content: 'sub-agent-result' } }))
);

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: a2aRoute,
  },
}));

vi.mock('./a2a-route-port.js', () => ({
  getA2ARoute: () => a2aRoute,
}));

const recordGovernanceAction = vi.fn();
vi.mock('./governance-action-recorder.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
}));

// AC-01: `resolveAmbientMissionIdForEvents` (agent-dispatch.ts) reads the
// shared "current mission focus" file at `pathResolver.shared('runtime/current_mission_focus.json')`
// directly (not via `mission-state.ts` — see that function's doc comment for
// why: it would create a runtime import cycle back into this module).
// Redirecting just that one subPath to a scratch file under
// `pathResolver.sharedTmp(...)` lets one test assert mission_id propagation
// without ever touching the real shared mission-focus file (other
// concurrent providers/missions in this worktree read/write that file for
// real — see the multi-provider co-execution contract).
const missionFocusPathOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('./path-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./path-resolver.js')>();
  return {
    ...actual,
    pathResolver: {
      ...actual.pathResolver,
      shared: (subPath = '') =>
        missionFocusPathOverride.value !== undefined &&
        subPath === 'runtime/current_mission_focus.json'
          ? missionFocusPathOverride.value
          : actual.pathResolver.shared(subPath),
    },
  };
});

afterEach(() => resetOpPreflight());
afterEach(() => {
  missionFocusPathOverride.value = undefined;
});

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
  it('routes dispatcher environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/agent-dispatch.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('ProcessSpawnDispatcher delegates via the backend native delegateTask', async () => {
    const backend = makeFakeBackend();
    const options = { profile: 'explorer', effort: 'medium' as const };
    const out = await new ProcessSpawnDispatcher().dispatch('do X', 'ctx', backend, options);
    expect(out).toBe('spawned:do X');
    expect(backend.delegateTask).toHaveBeenCalledWith('do X', 'ctx', options);
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

  it('forwards role and deferred-tool options through tool-capable dispatch wrappers', async () => {
    const backend = makeFakeBackend({ withTools: true });
    const options = { role: 'planner', deferred_tool_names: ['capability_read'] };

    await new InSessionDispatcher().dispatch('do scoped Z', undefined, backend, options);
    expect(backend.generateWithTools).toHaveBeenLastCalledWith(
      expect.stringContaining('Task: do scoped Z'),
      expect.any(Array),
      options
    );

    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());
    await wrapped.generateWithTools('direct scoped prompt', [], options);
    expect(backend.generateWithTools).toHaveBeenLastCalledWith('direct scoped prompt', [], options);
  });

  it('DispatchingReasoningBackend routes delegateTask through the dispatcher and forwards cognition to base', async () => {
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    expect(wrapped.name).toBe('fake+process-spawn');
    await wrapped.delegateTask('task', 'c');
    // NI-03: with no incoming chain, delegateTask originates a single-link
    // delegation chain and embeds it into the context it passes down — the
    // original context is preserved as the prefix.
    expect(backend.delegateTask).toHaveBeenCalledWith(
      'task',
      expect.stringMatching(/^c\n<delegation-chain>\[.*\]<\/delegation-chain>$/)
    );

    await wrapped.prompt('hi');
    expect(backend.prompt).toHaveBeenCalledWith('hi');
    await wrapped.extractRequirements({} as any);
    expect((backend as any).extractRequirements).toHaveBeenCalledTimes(1);
  });

  it('runs delegateTask through the serial preflight repair entrance', async () => {
    registerOpPreflightListener({
      id: 'test.delegate.repair',
      run: (call) =>
        call.source === 'delegate'
          ? { repaired_input: { instruction: 'repaired task' } }
          : undefined,
    });
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    await wrapped.delegateTask('original task');

    expect(backend.delegateTask).toHaveBeenCalledWith(
      'repaired task',
      expect.stringContaining('<delegation-chain>')
    );
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

  it('routes through a native adopter and emits a native success event', async () => {
    const dispatch = vi.fn(async (instruction, context, options) => {
      expect(instruction).toBe('native task');
      expect(context).toBe('native context');
      expect(options?.profile).toBe('explorer');
      return 'native-result';
    });
    const backend = makeFakeBackend() as ReasoningBackend & {
      getNativeSubagentAdopter: NonNullable<ReasoningBackend['getNativeSubagentAdopter']>;
    };
    backend.getNativeSubagentAdopter = () => ({
      id: 'test-native-adopter',
      dispatch,
      getInfo: () => ({
        provider: 'test-provider',
        parentThreadId: 'parent-thread',
        threadId: 'child-thread',
        turnId: 'turn-1',
        forked: true,
        mode: 'thread-fork',
      }),
    });
    const events = collectEvents();

    const result = await new HarnessSubagentDispatcher().dispatch(
      'native task',
      'native context',
      backend,
      { profile: 'explorer' }
    );

    expect(result).toBe('native-result');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(backend.delegateTask).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[1].payload).toMatchObject({
      adopter_id: 'test-native-adopter',
      provider: 'test-provider',
      thread_id: 'child-thread',
      native: true,
      native_fork: true,
      status: 'success',
    });
  });

  it('fails closed when the backend requires native adoption but it is unavailable', async () => {
    const backend = makeFakeBackend();
    backend.requiresNativeSubagent = () => true;
    const events = collectEvents();

    await expect(
      new HarnessSubagentDispatcher().dispatch('native task', undefined, backend, {
        profile: 'implementer',
      })
    ).rejects.toThrow('[SUBAGENT_UNAVAILABLE]');

    expect(backend.delegateTask).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['subagent_begin', 'subagent_unavailable']);
    expect(events[1].payload).toMatchObject({
      fallback_allowed: false,
    });
  });
});

/**
 * XP-06: `dispatchWithConcurrencyGovernance` (agent-dispatch.ts) wraps every
 * dispatcher's `dispatch()` with `withDelegationSlot` + `withWallClockBudget`
 * from `delegation-concurrency.ts`. These tests exercise the wiring itself
 * (provider resolution, serialization under a saturated cap) — the
 * semaphore/budget mechanics themselves are covered exhaustively in
 * `delegation-concurrency.test.ts`.
 */
describe('XP-06 delegation concurrency governance (agent-dispatch wiring)', () => {
  beforeEach(async () => {
    const { resetDelegationConcurrencyStateForTests } = await import('./delegation-concurrency.js');
    resetDelegationConcurrencyStateForTests();
    delete process.env.KYBERION_DELEGATION_MAX_CONCURRENCY;
    delete process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY;
    delete process.env.KYBERION_DELEGATION_PROVIDER_CAPS;
  });

  afterEach(async () => {
    const { resetDelegationConcurrencyStateForTests } = await import('./delegation-concurrency.js');
    resetDelegationConcurrencyStateForTests();
  });

  it('gates ProcessSpawnDispatcher.dispatch through the per-provider semaphore keyed by backend.name', async () => {
    process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY = '1';
    const backend = makeFakeBackend();
    (backend as any).name = 'claude-cli'; // providerIdForReasoningIdentifier -> 'claude'

    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    backend.delegateTask = vi
      .fn()
      .mockImplementationOnce(async (instruction: string) => {
        order.push(`start:${instruction}`);
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push(`end:${instruction}`);
        return `spawned:${instruction}`;
      })
      .mockImplementationOnce(async (instruction: string) => {
        order.push(`start:${instruction}`);
        order.push(`end:${instruction}`);
        return `spawned:${instruction}`;
      });

    const dispatcher = new ProcessSpawnDispatcher();
    const first = dispatcher.dispatch('first', undefined, backend);
    const second = dispatcher.dispatch('second', undefined, backend);

    await new Promise((resolve) => setTimeout(resolve, 0));
    // The provider cap (1) is held by the first call — the second must still
    // be queued, not running.
    expect(order).toEqual(['start:first']);

    releaseFirst();
    const [out1, out2] = await Promise.all([first, second]);
    expect(out1).toBe('spawned:first');
    expect(out2).toBe('spawned:second');
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it("buckets an unrecognized backend name under the shared 'unknown' provider", async () => {
    const { getDelegationConcurrencyStats } = await import('./delegation-concurrency.js');
    const backend = makeFakeBackend(); // name: 'fake' — not a known provider identifier
    await new ProcessSpawnDispatcher().dispatch('do it', undefined, backend);
    const stats = getDelegationConcurrencyStats();
    expect(stats.providers.unknown).toBeDefined();
  });

  it('applies the same governance to InSessionDispatcher and HarnessSubagentDispatcher without double-wrapping their internal process-spawn fallback', async () => {
    process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY = '1';
    const backend = makeFakeBackend({ withTools: false }); // forces InSessionDispatcher's fallback path

    // If the fallback path re-entered the semaphore for the same provider
    // while the outer governance wrapper still held its slot, this would
    // hang forever instead of resolving.
    await expect(new InSessionDispatcher().dispatch('do Y', undefined, backend)).resolves.toBe(
      'spawned:do Y'
    );

    const dispatcher = new HarnessSubagentDispatcher({
      loadRuntime: async () => {
        throw new Error('sdk unavailable');
      },
    });
    await expect(dispatcher.dispatch('do X', 'ctx', backend)).resolves.toBe('spawned:do X');
  });
});

// ---------------------------------------------------------------------------
// NI-03: delegation-chain propagation at the delegateTask choke point.
// ---------------------------------------------------------------------------
describe('agent-dispatch NI-03 delegation chain', () => {
  const savedSystemRole = process.env.SYSTEM_ROLE;
  const savedMissionRole = process.env.MISSION_ROLE;

  afterEach(() => {
    if (savedSystemRole === undefined) delete process.env.SYSTEM_ROLE;
    else process.env.SYSTEM_ROLE = savedSystemRole;
    if (savedMissionRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedMissionRole;
  });

  function makeIncomingChain() {
    // What the mission worker originates at dispatch (NI-03): orchestrator
    // root (unrestricted) → worker (its KD-05 tier).
    return [
      {
        actor: 'kyberion://agent/ni03-org/mission-orchestrator',
        team_role: 'orchestrator',
        granted_scope: {},
        granted_at: '2026-07-26T00:00:00.000Z',
      },
      {
        actor: 'kyberion://agent/ni03-org/worker-a',
        team_role: 'implementer',
        granted_scope: { capability_tier: 'implementer' as const },
        granted_at: '2026-07-26T00:00:01.000Z',
      },
    ];
  }

  it('2-hop delegation: appends the sub-worker link, giving a 3-link root-first chain in the sub-worker dispatch', async () => {
    const { embedDelegationChainInContext, extractDelegationChainFromContext } =
      await import('./delegation-chain.js');
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    const incoming = makeIncomingChain();
    const context = embedDelegationChainInContext('worker task context', incoming);
    await wrapped.delegateTask('investigate the failure', context, {
      role: 'reviewer',
      profile: 'explorer',
    });

    expect(backend.delegateTask).toHaveBeenCalledTimes(1);
    const receivedContext = backend.delegateTask.mock.calls[0][1] as string;
    const extracted = extractDelegationChainFromContext(receivedContext);
    expect(extracted.contextWithoutChain).toBe('worker task context');
    expect(extracted.chain).toHaveLength(3);
    // Root-first: orchestrator → worker → sub-worker.
    expect(extracted.chain![0].actor).toBe('kyberion://agent/ni03-org/mission-orchestrator');
    expect(extracted.chain![1].actor).toBe('kyberion://agent/ni03-org/worker-a');
    expect(extracted.chain![2]).toMatchObject({
      actor: 'subagent:process-spawn:explorer',
      team_role: 'reviewer',
      granted_scope: { capability_tier: 'explorer' },
    });
  });

  it('fail-closed attenuation: a sub-worker tier above its parent throws typed and never dispatches', async () => {
    const { DelegationAttenuationError, embedDelegationChainInContext } =
      await import('./delegation-chain.js');
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    // Parent (worker) holds the read-only explorer tier...
    const incoming = makeIncomingChain();
    incoming[1].granted_scope = { capability_tier: 'explorer' as const };
    const context = embedDelegationChainInContext('ctx', incoming);

    // ...and the delegation requests the (default) implementer tier.
    await expect(wrapped.delegateTask('write files', context)).rejects.toThrow(
      DelegationAttenuationError
    );
    expect(backend.delegateTask).not.toHaveBeenCalled();
  });

  it('a malformed embedded chain block also fails closed before dispatch', async () => {
    const { DelegationAttenuationError } = await import('./delegation-chain.js');
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    await expect(
      wrapped.delegateTask('task', 'ctx\n<delegation-chain>{broken</delegation-chain>')
    ).rejects.toThrow(DelegationAttenuationError);
    expect(backend.delegateTask).not.toHaveBeenCalled();
  });

  it('no incoming chain: originates a single-link root chain from the current actor (best-effort env resolution)', async () => {
    const { extractDelegationChainFromContext } = await import('./delegation-chain.js');
    process.env.SYSTEM_ROLE = 'Mission Controller';
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, new ProcessSpawnDispatcher());

    await wrapped.delegateTask('task', 'plain context');

    const receivedContext = backend.delegateTask.mock.calls[0][1] as string;
    const extracted = extractDelegationChainFromContext(receivedContext);
    expect(extracted.contextWithoutChain).toBe('plain context');
    expect(extracted.chain).toHaveLength(1);
    // 'Mission Controller' slugifies to mission-controller and derives an nhi id.
    expect(extracted.chain![0].actor).toMatch(
      /^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/mission-controller$/
    );
    expect(extracted.chain![0].granted_scope).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AC-01: delegation correlation — `delegation_id` pairs begin/end(/unavailable),
// plus `team_role`, `agent_id`, `parent_agent_id`, `instruction_summary`,
// `elapsed_ms` and `source.mission_id` on the KC-02 worker-event envelopes
// emitted by `HarnessSubagentDispatcher` and `ProcessSpawnDispatcher`.
// ---------------------------------------------------------------------------
describe('AC-01 delegation correlation (agent-dispatch)', () => {
  function collectEvents(): WorkerEventEnvelope[] {
    const events: WorkerEventEnvelope[] = [];
    getDefaultWorkerEventStream().subscribe((e) => events.push(e));
    return events;
  }

  function makeFakeHarnessRuntime(runTaskImpl?: (params: any) => Promise<any>) {
    return {
      runTask: runTaskImpl ?? vi.fn(async () => ({ text: 'harness-result' })),
      buildGovernedAgentSystemPrompt: vi.fn(({ base, missionContext }: any) =>
        [base, missionContext ? `Mission context:\n${missionContext}` : '']
          .filter(Boolean)
          .join('\n\n')
      ),
      buildKyberionMcpServerConfig: vi.fn(() => ({ kyberion: {} }) as any),
      createKyberionCanUseTool: vi.fn(() => vi.fn() as any),
      allowedTools: ['Read', 'Write', 'Bash'],
    };
  }

  beforeEach(() => {
    resetDefaultWorkerEventStream();
    missionFocusPathOverride.value = undefined;
  });

  afterEach(() => {
    resetDefaultWorkerEventStream();
  });

  it('HarnessSubagentDispatcher: begin/end share one delegation_id and a stable agent_id (no native thread id)', async () => {
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do the thing', undefined, backend, { profile: 'implementer' });

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    const [begin, end] = events;
    expect(typeof begin.payload.delegation_id).toBe('string');
    expect((begin.payload.delegation_id as string).length).toBeGreaterThan(0);
    expect(end.payload.delegation_id).toBe(begin.payload.delegation_id);
    expect(begin.payload.agent_id).toBe(end.payload.agent_id);
    expect(begin.payload.team_role).toBe('implementer');
    expect(end.payload.team_role).toBe('implementer');
  });

  it('instruction_summary is present and at most 120 chars, even for a long instruction', async () => {
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('x'.repeat(500), undefined, backend);

    const [begin] = events;
    expect(typeof begin.payload.instruction_summary).toBe('string');
    const summary = begin.payload.instruction_summary as string;
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(120);
  });

  it('elapsed_ms on subagent_end is a non-negative integer', async () => {
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do work', undefined, backend);

    const end = events[1];
    expect(Number.isInteger(end.payload.elapsed_ms)).toBe(true);
    expect(end.payload.elapsed_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('parent_agent_id equals the last actor of a delegation chain already embedded in context', async () => {
    const { buildDelegationLink, embedDelegationChainInContext } =
      await import('./delegation-chain.js');
    const chain = [
      buildDelegationLink({
        actor: 'kyberion://agent/ac01-org/orchestrator',
        granted_scope: {},
      }),
    ];
    const context = embedDelegationChainInContext('task context', chain);
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do work', context, backend);

    expect(events[0].payload.parent_agent_id).toBe('kyberion://agent/ac01-org/orchestrator');
    expect(events[1].payload.parent_agent_id).toBe('kyberion://agent/ac01-org/orchestrator');
    // The envelope's `source.agent_id` names the emitting (parent) actor.
    expect(events[0].source?.agent_id).toBe('kyberion://agent/ac01-org/orchestrator');
  });

  it("parent_agent_id resolves to the root actor (not this dispatch's own placeholder) when routed through DispatchingReasoningBackend", async () => {
    const { buildDelegationLink, embedDelegationChainInContext } =
      await import('./delegation-chain.js');
    // The incoming chain the mission worker originates at dispatch time —
    // no sub-worker link for THIS dispatch yet; that gets appended by
    // `propagateDelegationChainThroughContext` inside `delegateTask` below,
    // before `HarnessSubagentDispatcher.dispatch()` ever sees the context.
    const rootChain = [
      buildDelegationLink({
        actor: 'kyberion://agent/ac01-org/root-orchestrator',
        granted_scope: {},
      }),
    ];
    const context = embedDelegationChainInContext('task context', rootChain);
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const wrapped = new DispatchingReasoningBackend(backend, dispatcher);
    const events = collectEvents();

    await wrapped.delegateTask('do work', context, { profile: 'implementer' });

    // Prove the fix is actually exercised (not vacuously true because no
    // append happened): the context the dispatcher received really does end
    // with this dispatch's own placeholder link, appended by
    // `propagateDelegationChainThroughContext` before `dispatch()` ran.
    const { extractDelegationChainFromContext } = await import('./delegation-chain.js');
    const receivedContext = (runtime.buildGovernedAgentSystemPrompt as any).mock.calls[0][0]
      .missionContext as string;
    const receivedChain = extractDelegationChainFromContext(receivedContext).chain!;
    expect(receivedChain[receivedChain.length - 1].actor).toMatch(
      /^subagent:harness-subagent:implementer$/
    );
    expect(receivedChain[0].actor).toBe('kyberion://agent/ac01-org/root-orchestrator');

    expect(events[0].payload.parent_agent_id).toBe('kyberion://agent/ac01-org/root-orchestrator');
    expect(events[1].payload.parent_agent_id).toBe('kyberion://agent/ac01-org/root-orchestrator');
    expect(events[0].payload.parent_agent_id).not.toMatch(/^subagent:/);
  });

  it('omits parent_agent_id when context carries no delegation chain', async () => {
    const runtime = makeFakeHarnessRuntime();
    const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
    const backend = makeFakeBackend();
    const events = collectEvents();

    await dispatcher.dispatch('do work', 'plain context, no chain', backend);

    expect(events[0].payload.parent_agent_id).toBeUndefined();
    expect(events[0].source?.agent_id).toBeUndefined();
  });

  it('source.mission_id is populated from the ambient current-mission-focus file when one is set', async () => {
    const { safeWriteFile, safeRmSync } = await import('./secure-io.js');
    const scratchPath = pathResolver.sharedTmp(
      'agent-dispatch-ac01-test/current_mission_focus.json'
    );
    safeWriteFile(scratchPath, JSON.stringify({ mission_id: 'MSN-AC01-TEST' }));
    missionFocusPathOverride.value = scratchPath;
    try {
      const runtime = makeFakeHarnessRuntime();
      const dispatcher = new HarnessSubagentDispatcher({ loadRuntime: async () => runtime });
      const backend = makeFakeBackend();
      const events = collectEvents();

      await dispatcher.dispatch('do work', undefined, backend);

      expect(events[0].source?.mission_id).toBe('MSN-AC01-TEST');
      expect(events[1].source?.mission_id).toBe('MSN-AC01-TEST');
    } finally {
      safeRmSync(scratchPath, { force: true });
    }
  });

  it('subagent_unavailable also carries the same delegation_id as its begin', async () => {
    const backend = makeFakeBackend();
    backend.requiresNativeSubagent = () => true;
    const events = collectEvents();

    await expect(
      new HarnessSubagentDispatcher().dispatch('native task', undefined, backend, {
        profile: 'implementer',
      })
    ).rejects.toThrow('[SUBAGENT_UNAVAILABLE]');

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_unavailable']);
    expect(events[1].payload.delegation_id).toBe(events[0].payload.delegation_id);
    expect(events[1].payload.delegation_id).toEqual(expect.any(String));
  });

  it('keeps agent_id stable across begin/end even with a native thread id (carried separately as thread_id)', async () => {
    const dispatch = vi.fn(async () => 'native-result');
    const backend = makeFakeBackend() as ReasoningBackend & {
      getNativeSubagentAdopter: NonNullable<ReasoningBackend['getNativeSubagentAdopter']>;
    };
    backend.getNativeSubagentAdopter = () => ({
      id: 'test-native-adopter',
      dispatch,
      getInfo: () => ({ threadId: 'native-thread-42' }),
    });
    const events = collectEvents();

    await new HarnessSubagentDispatcher().dispatch('native task', undefined, backend);

    const [begin, end] = events;
    expect(end.payload.agent_id).toBe(begin.payload.agent_id);
    expect(end.payload.agent_id).not.toBe('native-thread-42');
    expect(end.payload.thread_id).toBe('native-thread-42');
    expect(end.payload.delegation_id).toBe(begin.payload.delegation_id);
  });

  it('ProcessSpawnDispatcher now emits correlated subagent_begin/end too (previously silent)', async () => {
    const backend = makeFakeBackend();
    const events = collectEvents();

    const out = await new ProcessSpawnDispatcher().dispatch('do X', 'ctx', backend, {
      profile: 'explorer',
    });

    expect(out).toBe('spawned:do X');
    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[0].payload.dispatcher).toBe('process-spawn');
    expect(events[0].payload.team_role).toBe('explorer');
    expect(events[1].payload.delegation_id).toBe(events[0].payload.delegation_id);
    expect(events[1].payload.status).toBe('success');
    expect(events[1].payload.agent_id).toBe(events[0].payload.agent_id);
  });

  it('ProcessSpawnDispatcher emits subagent_end(status=failure) and rethrows when delegateTask errors', async () => {
    const backend = makeFakeBackend();
    backend.delegateTask.mockRejectedValueOnce(new Error('spawn failed'));
    const events = collectEvents();

    await expect(new ProcessSpawnDispatcher().dispatch('do X', 'ctx', backend)).rejects.toThrow(
      'spawn failed'
    );

    expect(events.map((e) => e.type)).toEqual(['subagent_begin', 'subagent_end']);
    expect(events[1].payload.status).toBe('failure');
    expect(events[1].payload.error).toContain('spawn failed');
    expect(events[1].payload.delegation_id).toBe(events[0].payload.delegation_id);
  });
});
