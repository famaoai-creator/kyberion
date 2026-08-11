import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the codex CLI query layer so these tests run without the `codex` binary.
vi.mock('./codex-cli-query.js', () => ({
  runCodexCliQuery: vi.fn(),
  buildCodexCliQueryOptionsFromEnv: vi.fn(() => ({})),
}));

import { runCodexCliQuery } from './codex-cli-query.js';
import {
  CodexCliReasoningBackend,
  type CodexHarnessSession,
} from './codex-cli-reasoning-backend.js';
import {
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  structuredReasoningSpecs,
} from './structured-reasoning.js';

const mockRun = vi.mocked(runCodexCliQuery);

describe('CodexCliReasoningBackend — structured ops via shared specs (no codex binary)', () => {
  beforeEach(() => mockRun.mockReset());

  it('divergePersonas uses the shared system prompt + spec schema and extracts hypotheses', async () => {
    mockRun.mockResolvedValue({
      hypotheses: [{ id: 'h1', proposed_by: 'cfo', content: 'c' }],
    } as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.divergePersonas({
      topic: 'pricing',
      personas: ['cfo'],
      minPerPersona: 2,
    } as any);

    expect(out).toEqual([{ id: 'h1', proposed_by: 'cfo', content: 'c' }]);
    const arg = mockRun.mock.calls[0][0] as any;
    expect(arg.systemPrompt).toBe(STRUCTURED_REASONING_SYSTEM_PROMPT);
    expect(arg.schema).toBe(structuredReasoningSpecs.divergePersonas.schema); // sources the shared spec
    expect(arg.userPrompt).toContain('Topic: pricing');
    expect(arg.mode).toBe('workspace-write');
  });

  it('forkBranches extracts the branches array from the shared spec', async () => {
    mockRun.mockResolvedValue({
      branches: [{ branch_id: 'b1', hypothesis_ref: 'h1', worktree_path: '/w' }],
    } as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.forkBranches({
      executionProfile: 'fast',
      costCapTokens: 1000,
      maxStepsPerBranch: 3,
      hypotheses: [],
    } as any);

    expect(out).toEqual([{ branch_id: 'b1', hypothesis_ref: 'h1', worktree_path: '/w' }]);
    expect((mockRun.mock.calls[0][0] as any).schema).toBe(
      structuredReasoningSpecs.forkBranches.schema
    );
  });

  it('extractRequirements returns the validated object whole', async () => {
    const reqs = { functional_requirements: [{ id: 'FR-1', description: 'd', priority: 'must' }] };
    mockRun.mockResolvedValue(reqs as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.extractRequirements({ sourceText: 'transcript' } as any);

    expect(out).toBe(reqs);
    expect((mockRun.mock.calls[0][0] as any).schema).toBe(
      structuredReasoningSpecs.extractRequirements.schema
    );
  });

  it('delegateTask keeps its own sub-agent prompt (not consolidated) and returns the answer', async () => {
    mockRun.mockResolvedValue({ answer: 'done' } as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.delegateTask('do it', 'ctx');

    expect(out).toBe('done');
    const arg = mockRun.mock.calls[0][0] as any;
    expect(arg.systemPrompt).toContain('focused autonomous sub-agent');
    expect(arg.userPrompt).toContain('Task: do it');
  });

  it('native adopter reuses one session while fresh tasks reset its context', async () => {
    const refreshContext = vi.fn(async () => ({ mode: 'soft' as const, threadId: 'thread-fresh' }));
    const session: CodexHarnessSession = {
      boot: vi.fn(async () => undefined),
      refreshContext,
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async (prompt, options) => ({
        text: `native:${prompt}`,
        stopReason: 'completed',
        trace: [{ enhancer: 'test', action: String(options?.subagent) }],
      })),
    };
    const backend = new CodexCliReasoningBackend({ harnessSession: session });
    const adopter = backend.getNativeSubagentAdopter?.();
    expect(adopter?.id).toBe('codex-app-server');

    const first = await adopter!.dispatch('task-a', 'ctx-a', {
      profile: 'implementer',
      context_mode: 'fresh',
    });
    const continued = await adopter!.dispatch('task-b', 'ctx-b', {
      profile: 'explorer',
      context_mode: 'continue',
    });
    const fresh = await adopter!.dispatch('task-c', 'ctx-c', {
      profile: 'explorer',
      context_mode: 'fresh',
    });

    expect(first).toContain('task-a');
    expect(continued).toContain('task-b');
    expect(fresh).toContain('task-c');
    expect(session.boot).toHaveBeenCalledOnce();
    expect(refreshContext).toHaveBeenCalledOnce();
    expect(session.askNativeSubagent).toHaveBeenCalledTimes(3);
    expect(session.ask).not.toHaveBeenCalled();
    expect((session.askNativeSubagent as any).mock.calls[0][1]).toMatchObject({
      profile: 'implementer',
      subagent: true,
      effort: 'medium',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    expect((session.askNativeSubagent as any).mock.calls[1][1]).toMatchObject({
      profile: 'explorer',
      subagent: true,
      effort: 'medium',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refuses planner because Codex has no verified no-exec permission projection', async () => {
    const session: CodexHarnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
    };
    const backend = new CodexCliReasoningBackend({ harnessSession: session });

    await expect(
      backend.getNativeSubagentAdopter?.()!.dispatch('plan only', undefined, { profile: 'planner' })
    ).rejects.toThrow('[SUBAGENT_UNAVAILABLE]');
    expect(session.boot).not.toHaveBeenCalled();
    expect(session.ask).not.toHaveBeenCalled();
  });

  it('refreshes after a failed native turn before the next fresh task', async () => {
    let attempts = 0;
    const refreshContext = vi.fn(async () => ({ mode: 'soft' as const }));
    const session: CodexHarnessSession = {
      boot: vi.fn(async () => undefined),
      refreshContext,
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('native turn timed out');
        return { text: 'recovered', stopReason: 'completed' };
      }),
    };
    const backend = new CodexCliReasoningBackend({ harnessSession: session });
    const adopter = backend.getNativeSubagentAdopter?.();
    if (!adopter) throw new Error('native subagent adopter is required for this test');

    await expect(
      adopter.dispatch('first task', undefined, { profile: 'implementer', context_mode: 'fresh' })
    ).rejects.toThrow('[SUBAGENT_UNAVAILABLE]');
    await expect(
      adopter.dispatch('second task', undefined, { profile: 'implementer', context_mode: 'fresh' })
    ).resolves.toBe('recovered');

    expect(refreshContext).toHaveBeenCalledOnce();
  });
});
