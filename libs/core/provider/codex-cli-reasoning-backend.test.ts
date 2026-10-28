import { runInExecutionScope } from '../foundation/execution-scope.js';
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
} from '../structured-reasoning.js';

import { resolveSandboxPolicy, withSandboxPolicy } from '../shell/sandbox-policy.js';
import type { ReasoningCallOptions } from '../reasoning/reasoning-backend-contracts.js';

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

  describe('explicit CLI permission constraints', () => {
    it.each([
      [{ profile: 'explorer' }, 'explorer', 'read-only'],
      [{ capability_profile: 'explorer' }, 'explorer', 'read-only'],
      [{ permission_mode: 'readonly' }, 'explorer', 'read-only'],
      [{ profile: 'implementer', permission_mode: 'readonly' }, 'explorer', 'read-only'],
      [{ profile: 'explorer', permission_mode: 'edit' }, 'explorer', 'read-only'],
      [{ profile: 'explorer', capability_profile: 'explorer' }, 'explorer', 'read-only'],
      [{ permission_mode: 'edit' }, 'implementer', 'workspace-write'],
      [{ profile: 'implementer' }, 'implementer', 'workspace-write'],
    ] as const)('projects %j without widening', async (options, profile, mode) => {
      mockRun.mockResolvedValue({ answer: 'bounded' });
      const backend = new CodexCliReasoningBackend();

      await expect(backend.delegateTask('inspect only', undefined, options)).resolves.toBe(
        'bounded'
      );

      expect(mockRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profile, mode }));
    });

    it('preserves the legacy default and keeps routing metadata out of permissions', async () => {
      mockRun.mockResolvedValue({ answer: 'done' });
      const backend = new CodexCliReasoningBackend();

      await backend.delegateTask('legacy');
      await backend.delegateTask('routed', undefined, { route_profile: 'deep', role: 'analyst' });

      for (const [query] of mockRun.mock.calls) {
        expect(query.mode).toBe('workspace-write');
        expect(query).not.toHaveProperty('profile');
      }
    });

    it.each([
      [{ profile: 'planner' }, /permission profile "planner" refused/],
      [{ profile: 'planner', permission_mode: 'readonly' }, /permission profile "planner" refused/],
      [{ profile: 'unknown-tier', permission_mode: 'readonly' }, /SUBAGENT_PROFILE_UNKNOWN/],
      [{ profile: 'unknown-tier' }, /SUBAGENT_PROFILE_UNKNOWN/],
      [{ capability_profile: 'unknown-tier' }, /SUBAGENT_PROFILE_UNKNOWN/],
      [
        { profile: 'explorer', capability_profile: 'implementer' },
        /conflicting capability profiles/,
      ],
      [{ permission_mode: 'full' }, /unsupported permission mode/],
      [{ permission_mode: 'invalid' }, /unsupported permission mode/],
    ])('refuses %j before calling the query', async (options, error) => {
      const backend = new CodexCliReasoningBackend();

      await expect(
        backend.delegateTask('bounded task', undefined, options as ReasoningCallOptions)
      ).rejects.toThrow(error as RegExp);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('prompt forwards readonly while preserving model, effort and cancellation', async () => {
      mockRun.mockResolvedValue({ answer: 'summary' });
      const signal = new AbortController().signal;
      const backend = new CodexCliReasoningBackend({ timeoutMs: 1234 });

      await expect(
        backend.prompt('summarize', {
          permission_mode: 'readonly',
          model: 'openai:test-model',
          effort: 'low',
          signal,
        })
      ).resolves.toBe('summary');

      expect(mockRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          profile: 'explorer',
          mode: 'read-only',
          options: expect.objectContaining({
            model: 'test-model',
            effort: 'low',
            signal,
            timeoutMs: 1234,
          }),
        })
      );
    });

    it('keeps ambient readonly authoritative over an explicit implementer', async () => {
      mockRun.mockResolvedValue({ answer: 'bounded' });
      const backend = new CodexCliReasoningBackend();
      // The query is mocked; allow the egress precheck while testing filesystem narrowing.
      const policy = resolveSandboxPolicy({
        provider: 'codex',
        mode: 'read-only',
        networkAccess: true,
      });

      await withSandboxPolicy(policy, () =>
        backend.delegateTask('inspect', undefined, {
          profile: 'implementer',
          permission_mode: 'edit',
        })
      );

      expect(mockRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          profile: 'explorer',
          mode: 'read-only',
        })
      );
    });
  });

  it('hides native capability in tenants and rejects a retained operator/injected adopter before dispatch', async () => {
    const session = {
      boot: vi.fn(),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(),
    } as unknown as CodexHarnessSession;
    const backend = new CodexCliReasoningBackend({ harnessSession: session });
    const retained = backend.getNativeSubagentAdopter()!;
    await runInExecutionScope({ tenantBound: true, tenantSlug: 'native-fixture' }, async () => {
      expect(backend.getNativeSubagentAdopter()).toBeNull();
      await expect(retained.dispatch('do not send')).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
      await expect(backend.resetSession()).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
      const tenantBackend = new CodexCliReasoningBackend({ harnessSession: session });
      expect(tenantBackend.getNativeSubagentAdopter()).toBeNull();
      expect(session.boot).not.toHaveBeenCalled();
      expect(session.ask).not.toHaveBeenCalled();
      expect(session.askNativeSubagent).not.toHaveBeenCalled();
    });
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
