import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the codex CLI query layer so these tests run without the `codex` binary.
vi.mock('./codex-cli-query.js', () => ({
  runCodexCliQuery: vi.fn(),
  buildCodexCliQueryOptionsFromEnv: vi.fn(() => ({})),
}));

import { runCodexCliQuery } from './codex-cli-query.js';
import { CodexCliReasoningBackend } from './codex-cli-reasoning-backend.js';
import { STRUCTURED_REASONING_SYSTEM_PROMPT, structuredReasoningSpecs } from './structured-reasoning.js';

const mockRun = vi.mocked(runCodexCliQuery);

describe('CodexCliReasoningBackend — structured ops via shared specs (no codex binary)', () => {
  beforeEach(() => mockRun.mockReset());

  it('divergePersonas uses the shared system prompt + spec schema and extracts hypotheses', async () => {
    mockRun.mockResolvedValue({ hypotheses: [{ id: 'h1', proposed_by: 'cfo', content: 'c' }] } as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.divergePersonas({ topic: 'pricing', personas: ['cfo'], minPerPersona: 2 } as any);

    expect(out).toEqual([{ id: 'h1', proposed_by: 'cfo', content: 'c' }]);
    const arg = mockRun.mock.calls[0][0] as any;
    expect(arg.systemPrompt).toBe(STRUCTURED_REASONING_SYSTEM_PROMPT);
    expect(arg.schema).toBe(structuredReasoningSpecs.divergePersonas.schema); // sources the shared spec
    expect(arg.userPrompt).toContain('Topic: pricing');
    expect(arg.mode).toBe('workspace-write');
  });

  it('forkBranches extracts the branches array from the shared spec', async () => {
    mockRun.mockResolvedValue({ branches: [{ branch_id: 'b1', hypothesis_ref: 'h1', worktree_path: '/w' }] } as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.forkBranches({
      executionProfile: 'fast',
      costCapTokens: 1000,
      maxStepsPerBranch: 3,
      hypotheses: [],
    } as any);

    expect(out).toEqual([{ branch_id: 'b1', hypothesis_ref: 'h1', worktree_path: '/w' }]);
    expect((mockRun.mock.calls[0][0] as any).schema).toBe(structuredReasoningSpecs.forkBranches.schema);
  });

  it('extractRequirements returns the validated object whole', async () => {
    const reqs = { functional_requirements: [{ id: 'FR-1', description: 'd', priority: 'must' }] };
    mockRun.mockResolvedValue(reqs as any);
    const backend = new CodexCliReasoningBackend();

    const out = await backend.extractRequirements({ sourceText: 'transcript' } as any);

    expect(out).toBe(reqs);
    expect((mockRun.mock.calls[0][0] as any).schema).toBe(structuredReasoningSpecs.extractRequirements.schema);
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
});
