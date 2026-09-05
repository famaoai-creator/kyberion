import { describe, expect, it, vi } from 'vitest';
import type {
  GenerateWithToolsResult,
  ReasoningBackend,
  ToolDefinition,
} from '@agent/core/reasoning-backend-contracts';

const state = vi.hoisted(() => ({ backend: undefined as ReasoningBackend | undefined }));

vi.mock('@agent/core/reasoning-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/reasoning-backend')>();
  return {
    ...actual,
    getReasoningBackend: () => state.backend,
  };
});

import { proposeToolCalls, runReasoningLoop } from './reasoning-ops.js';

describe('wisdom reasoning loop deferred tool promotion', () => {
  it('promotes provider references only for the next iteration', async () => {
    const seen: Array<{
      prompt: string;
      tools: string[];
      options?: { role?: string; deferred_tool_definitions?: ToolDefinition[] };
    }> = [];
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
        async (
          prompt: string,
          tools: ToolDefinition[],
          options?: { role?: string; deferred_tool_definitions?: ToolDefinition[] }
        ): Promise<GenerateWithToolsResult> => {
          turn += 1;
          seen.push({ prompt, tools: tools.map((tool) => tool.name), options });
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
      deferredTools: [discovered],
      toolSearch: vi.fn(async () => [discovered]),
    });

    expect(result.final_answer).toBe('done');
    expect(seen[0]?.tools).toEqual(['tool_search']);
    expect(seen[0]?.options).toMatchObject({
      role: 'operator',
      deferred_tool_definitions: [discovered],
    });
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

  it('promotes an explicitly deferred tool without an ambient catalog callback', async () => {
    const discovered: ToolDefinition = {
      name: 'deploy_service',
      description: 'Deploy a governed service.',
      allowed_roles: ['operator'],
      inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    };
    const seen: string[][] = [];
    let turn = 0;
    state.backend = {
      name: 'test-backend',
      prompt: vi.fn(async () => ''),
      generateWithTools: vi.fn(async (_prompt, tools) => {
        seen.push(tools.map((tool) => tool.name));
        turn += 1;
        return turn === 1 ? { deferredToolReferences: ['deploy_service'] } : { text: 'done' };
      }),
    } as unknown as ReasoningBackend;

    await runReasoningLoop({
      goal: 'find the deployment tool',
      maxSteps: 2,
      tools: [{ name: 'tool_search', description: 'Search.', inputSchema: { type: 'object' } }],
      deferredTools: [discovered],
      options: { role: 'operator' },
    });

    expect(seen).toEqual([['tool_search'], ['tool_search', 'deploy_service']]);
  });

  it('forwards direct tool-proposal options to the provider boundary', async () => {
    const generateWithTools = vi.fn(async () => ({ text: 'proposal' }));
    state.backend = {
      name: 'test-backend',
      prompt: vi.fn(async () => ''),
      generateWithTools,
    } as unknown as ReasoningBackend;

    await proposeToolCalls({
      prompt: 'propose a tool call',
      tools: [{ name: 'read', description: 'Read.', inputSchema: { type: 'object' } }],
      deferredTools: [{ name: 'deploy', description: 'Deploy.', inputSchema: { type: 'object' } }],
      options: { role: 'operator', deferred_tool_names: ['deploy_service'] },
    });

    expect(generateWithTools).toHaveBeenCalledWith(
      'propose a tool call',
      [{ name: 'read', description: 'Read.', inputSchema: { type: 'object' } }],
      {
        role: 'operator',
        deferred_tool_names: ['deploy_service'],
        deferred_tool_definitions: [
          { name: 'deploy', description: 'Deploy.', inputSchema: { type: 'object' } },
        ],
      }
    );
  });

  it('promotes deferred references before returning a tool proposal', async () => {
    const deploy: ToolDefinition = {
      name: 'deploy_service',
      description: 'Deploy a governed service.',
      allowed_roles: ['operator'],
      inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    };
    const seen: Array<{ prompt: string; tools: string[] }> = [];
    let turn = 0;
    state.backend = {
      name: 'test-backend',
      prompt: vi.fn(async () => ''),
      generateWithTools: vi.fn(async (prompt, tools) => {
        seen.push({ prompt, tools: tools.map((tool) => tool.name) });
        turn += 1;
        return turn === 1
          ? { deferredToolReferences: ['deploy_service'] }
          : { toolCalls: [{ name: 'deploy_service', input: { service: 'api' } }] };
      }),
    } as unknown as ReasoningBackend;

    const result = await proposeToolCalls({
      prompt: 'propose the deployment call',
      tools: [{ name: 'tool_search', description: 'Search.', inputSchema: { type: 'object' } }],
      deferredTools: [deploy],
      options: { role: 'operator' },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.tools).toEqual(['tool_search']);
    expect(seen[1]?.tools).toEqual(['tool_search', 'deploy_service']);
    expect(seen[1]?.prompt).toContain('deploy_service');
    expect(result.planned_tool_calls).toEqual([
      { name: 'deploy_service', input: { service: 'api' } },
    ]);
  });

  it('preserves options when the loop falls back to prompt', async () => {
    const prompt = vi.fn(async () => 'FINAL ANSWER: fallback');
    state.backend = {
      name: 'prompt-only-backend',
      prompt,
    } as unknown as ReasoningBackend;

    const result = await runReasoningLoop({
      goal: 'use the prompt fallback',
      maxSteps: 1,
      tools: [],
      options: { role: 'operator', model_tier: 'fast' },
    });

    expect(result.final_answer).toBe('fallback');
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('use the prompt fallback'), {
      role: 'operator',
      model_tier: 'fast',
    });
  });
});
