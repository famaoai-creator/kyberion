import { describe, expect, it, vi } from 'vitest';
import type { GenerateWithToolsResult, ReasoningBackend, ToolDefinition } from '@agent/core';

const state = vi.hoisted(() => ({ backend: undefined as ReasoningBackend | undefined }));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    getReasoningBackend: () => state.backend,
  };
});

import { runReasoningLoop } from './reasoning-ops.js';

describe('wisdom reasoning loop deferred tool promotion', () => {
  it('promotes provider references only for the next iteration', async () => {
    const seen: Array<{ prompt: string; tools: string[] }> = [];
    let turn = 0;
    const discovered: ToolDefinition = {
      name: 'deploy_service',
      description: 'Deploy a governed service.',
      allowed_roles: ['operator'],
      inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    };
    state.backend = {
      name: 'test-backend',
      prompt: vi.fn(async () => 'FINAL ANSWER: done'),
      generateWithTools: vi.fn(
        async (prompt: string, tools: ToolDefinition[]): Promise<GenerateWithToolsResult> => {
          turn += 1;
          seen.push({ prompt, tools: tools.map((tool) => tool.name) });
          return turn === 1
            ? { deferredToolReferences: ['deploy_service'] }
            : { text: 'FINAL ANSWER: done' };
        }
      ),
    } as unknown as ReasoningBackend;

    const result = await runReasoningLoop({
      goal: 'find the deployment tool',
      maxSteps: 2,
      tools: [
        {
          name: 'tool_search',
          description: 'Search the governed catalog.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      toolRole: 'operator',
      toolSearch: vi.fn(async () => [discovered]),
    });

    expect(result.final_answer).toBe('done');
    expect(seen[0]?.tools).toEqual(['tool_search']);
    expect(seen[1]?.tools).toContain('deploy_service');
    expect(seen[1]?.prompt).toContain('deploy_service');
  });

  it('rejects a discovered tool outside the governed role', async () => {
    state.backend = {
      name: 'test-backend',
      prompt: vi.fn(async () => ''),
      generateWithTools: vi.fn(async () => ({ deferredToolReferences: ['admin_tool'] })),
    } as unknown as ReasoningBackend;

    await expect(
      runReasoningLoop({
        goal: 'find a tool',
        maxSteps: 1,
        tools: [{ name: 'tool_search', description: 'Search.', inputSchema: { type: 'object' } }],
        toolRole: 'operator',
        toolSearch: async () => [
          {
            name: 'admin_tool',
            description: 'Admin-only operation.',
            allowed_roles: ['admin'],
            inputSchema: { type: 'object' },
          },
        ],
      })
    ).rejects.toThrow('[TOOL_SEARCH_ROLE_DENIED]');
  });
});
