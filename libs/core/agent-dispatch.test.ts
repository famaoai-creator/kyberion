import { describe, expect, it, vi } from 'vitest';
import {
  DispatchingReasoningBackend,
  InSessionDispatcher,
  ProcessSpawnDispatcher,
  maybeWrapWithDispatcher,
  selectAgentDispatcher,
} from './agent-dispatch.js';
import type { ReasoningBackend } from './reasoning-backend.js';

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

  it('selectAgentDispatcher / maybeWrapWithDispatcher honor KYBERION_IN_SESSION_SUBAGENT', () => {
    expect(selectAgentDispatcher({} as NodeJS.ProcessEnv).name).toBe('process-spawn');
    expect(
      selectAgentDispatcher({ KYBERION_IN_SESSION_SUBAGENT: '1' } as unknown as NodeJS.ProcessEnv).name,
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
});
