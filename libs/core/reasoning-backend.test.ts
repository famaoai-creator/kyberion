import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  delegateBestOf,
  delegateStructured,
  getReasoningBackend,
  requestPeerAdvice,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
  type ReasoningBackend,
} from './reasoning-backend.js';
import { clearProviderHealth } from './provider-health-registry.js';
import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync } from './secure-io.js';
import { withExecutionContextAsync } from './authority.js';

const visibilityRoot = pathResolver.sharedTmp(`reasoning-backend-visibility-${process.pid}`);

describe('reasoning-backend', () => {
  afterEach(() => {
    delete process.env.KYBERION_REASONING_IN_PLACE_RETRIES;
    delete process.env.KYBERION_REASONING_RETRY_BASE_MS;
    resetReasoningBackend();
    clearProviderHealth();
    safeRmSync(visibilityRoot, { recursive: true, force: true });
  });

  it('defaults to the stub backend when none is registered', () => {
    expect(getReasoningBackend().name).toBe('stub');
  });

  it('gates structured constrained sampling before provider execution', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (prompt: string) => {
        calls.push(prompt);
        return '{}';
      },
    };
    const schema = z.object({});
    await expect(
      delegateStructured(backend, 'produce JSON', schema, {
        constrainedSampling: {
          jsonSchema: { type: 'object' },
          strict: 'require',
        },
      })
    ).rejects.toThrow(/required but not supported/);
    expect(calls).toEqual([]);

    await expect(
      delegateStructured(backend, 'produce JSON', schema, {
        constrainedSampling: {
          jsonSchema: { type: 'object' },
          strict: 'prefer',
        },
      })
    ).resolves.toEqual({});
    expect(calls.at(-1)).toMatch(/schema validator as the fallback/);
  });

  it('resolves a registered backend', () => {
    const fake: ReasoningBackend = {
      name: 'fake',
      divergePersonas: stubReasoningBackend.divergePersonas,
      crossCritique: stubReasoningBackend.crossCritique,
      synthesizePersona: stubReasoningBackend.synthesizePersona,
      forkBranches: stubReasoningBackend.forkBranches,
      simulateBranches: stubReasoningBackend.simulateBranches,
      extractRequirements: stubReasoningBackend.extractRequirements,
      extractDesignSpec: stubReasoningBackend.extractDesignSpec,
      extractTestPlan: stubReasoningBackend.extractTestPlan,
      decomposeIntoTasks: stubReasoningBackend.decomposeIntoTasks,
      delegateTask: stubReasoningBackend.delegateTask,
      prompt: stubReasoningBackend.prompt,
    };
    const dispose = registerReasoningBackend(fake);
    expect(getReasoningBackend().name).toBe('fake');
    dispose();
    expect(getReasoningBackend().name).toBe('stub');
  });

  it('rejects a second active backend until the first registration is disposed', () => {
    const first = { ...stubReasoningBackend, name: 'first' } as ReasoningBackend;
    const second = { ...stubReasoningBackend, name: 'second' } as ReasoningBackend;
    const dispose = registerReasoningBackend(first);
    expect(() => registerReasoningBackend(second)).toThrow(/already registered/);
    dispose();
    expect(() => registerReasoningBackend(second)).not.toThrow();
  });

  it('fails over to the next backend when the first backend throws', async () => {
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('primary');
            throw new Error('primary failed');
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('fallback');
            return 'ok';
          },
        },
      },
    ]);

    await expect(backend.prompt('hello')).resolves.toBe('ok');
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('retries transient failures in place before demoting the provider', async () => {
    process.env.KYBERION_REASONING_RETRY_BASE_MS = '0';
    clearProviderHealth();
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('primary');
            if (calls.length < 3) throw new Error('429 rate limit exceeded');
            return 'recovered';
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        backend: { ...stubReasoningBackend, prompt: async () => 'fallback' },
      },
    ]);

    await expect(backend.prompt('hello')).resolves.toBe('recovered');
    expect(calls).toEqual(['primary', 'primary', 'primary']);
  });

  it('records generic model-visible prompt calls without persisting prompt bodies', async () => {
    const missionPath = `${visibilityRoot}/mission`;
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'visibility-test',
        backend: {
          ...stubReasoningBackend,
          prompt: async (prompt) => {
            calls.push(prompt);
            return 'ok';
          },
          generateWithTools: async (prompt) => {
            calls.push(prompt);
            return { text: 'tool-ok' };
          },
          async *streamPrompt(prompt) {
            calls.push(prompt);
            yield 'stream-ok';
          },
          promptWithImages: async (prompt) => {
            calls.push(prompt);
            return 'image-ok';
          },
        },
      },
    ]);
    const visibility = {
      missionPath,
      missionId: 'MSN-REASONING-VISIBILITY',
      taskId: 'TASK-REASONING-VISIBILITY',
      contextPackId: 'CP-REASONING-VISIBILITY',
      knowledgeRefs: ['knowledge/product/example.md'],
    };

    await expect(backend.prompt('prompt secret', { prompt_visibility: visibility })).resolves.toBe(
      'ok'
    );
    await expect(
      backend.generateWithTools?.(
        'tool secret',
        [
          {
            name: 'lookup',
            description: 'Lookup',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        { prompt_visibility: visibility }
      )
    ).resolves.toMatchObject({ text: 'tool-ok' });

    await expect(
      backend.delegateTask('delegate secret', 'delegate context', {
        prompt_visibility: visibility,
      })
    ).resolves.toContain('[STUB]');
    const streamChunks: string[] = [];
    for await (const chunk of backend.streamPrompt!('stream secret', {
      prompt_visibility: visibility,
    })) {
      streamChunks.push(chunk);
    }
    await expect(
      backend.promptWithImages?.(
        'image secret',
        [{ path: 'active/shared/example.png', media_type: 'image/png' }],
        { prompt_visibility: visibility }
      )
    ).resolves.toBe('image-ok');

    const ledger = String(
      safeReadFile(`${missionPath}/coordination/prompt-visibility.jsonl`, { encoding: 'utf8' })
    );
    expect(ledger).not.toContain('prompt secret');
    expect(ledger).not.toContain('tool secret');
    expect(ledger).toContain('reasoning_prompt');
    expect(ledger).toContain('reasoning_generate_with_tools');
    expect(ledger).toContain('reasoning_delegate_task');
    expect(ledger).toContain('reasoning_stream_prompt');
    expect(ledger).toContain('reasoning_prompt_with_images');
    expect(ledger).toContain('CP-REASONING-VISIBILITY');
    expect(streamChunks).toEqual(['stream-ok']);
    expect(calls).toEqual(['prompt secret', 'tool secret', 'stream secret', 'image secret']);
  });

  it('derives a prompt visibility ledger from an active mission for direct callers', async () => {
    const missionId = `MSN-REASONING-AMBIENT-${Date.now()}`;
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const previousMissionId = process.env.MISSION_ID;
    await withExecutionContextAsync('mission_controller', async () => {
      safeMkdir(missionPath, { recursive: true });
      process.env.MISSION_ID = missionId;
      try {
        const backend = buildFailoverReasoningBackend([
          {
            backend: { ...stubReasoningBackend, prompt: async () => 'ambient-ok' },
          },
        ]);
        await expect(backend.prompt('ambient secret')).resolves.toBe('ambient-ok');
        const ledger = String(
          safeReadFile(`${missionPath}/coordination/prompt-visibility.jsonl`, { encoding: 'utf8' })
        );
        expect(ledger).not.toContain('ambient secret');
        expect(ledger).toContain('reasoning_ambient');
        expect(ledger).toContain(missionId);
      } finally {
        if (previousMissionId === undefined) delete process.env.MISSION_ID;
        else process.env.MISSION_ID = previousMissionId;
        safeRmSync(missionPath, { recursive: true, force: true });
      }
    });
  });

  it('does not invoke a provider when the visibility receipt cannot be written', async () => {
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('called');
            return 'must-not-run';
          },
        },
      },
    ]);

    expect(() =>
      backend.prompt('blocked before provider', {
        prompt_visibility: {
          missionPath: visibilityRoot,
          missionId: '',
        },
      })
    ).toThrow('[PROMPT_VISIBILITY_INVALID] missionId is required');
    expect(calls).toEqual([]);
  });

  it('dispatches a role-scoped prompt to the governed role chain', async () => {
    const defaultBackend = { ...stubReasoningBackend, prompt: async () => 'default-route' };
    const subagentBackend = { ...stubReasoningBackend, prompt: async () => 'subagent-route' };
    const backend = buildRoleAwareReasoningBackend(
      defaultBackend,
      new Map([['subagent', subagentBackend]])
    );

    await expect(backend.prompt('hello')).resolves.toBe('default-route');
    await expect(backend.prompt('hello', { role: 'subagent' })).resolves.toBe('subagent-route');
  });

  it('honors Retry-After and does not retry authentication failures', async () => {
    process.env.KYBERION_REASONING_IN_PLACE_RETRIES = '2';
    process.env.KYBERION_REASONING_RETRY_BASE_MS = '0';
    clearProviderHealth();
    const calls: string[] = [];
    const transient = Object.assign(new Error('503 service unavailable'), {
      headers: { 'retry-after': '0' },
    });
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('primary');
            throw transient;
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('fallback');
            throw new Error('authentication failed: invalid api key');
          },
        },
      },
    ]);

    await expect(backend.prompt('hello')).rejects.toThrow('failed across 2 candidate');
    expect(calls).toEqual(['primary', 'primary', 'primary', 'fallback']);
  });

  it('fails over after a provider-local authentication failure', async () => {
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'unauthenticated-primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('primary');
            throw new Error('authentication failed: invalid api key');
          },
        },
      },
      {
        label: 'healthy-fallback',
        provider: 'agy',
        backend: {
          ...stubReasoningBackend,
          prompt: async () => {
            calls.push('fallback');
            return 'served by fallback';
          },
        },
      },
    ]);

    await expect(backend.prompt('hello')).resolves.toBe('served by fallback');
    expect(calls).toEqual(['primary', 'fallback']);
  });

  it('retries transient generateWithTools failures in place before demoting', async () => {
    process.env.KYBERION_REASONING_RETRY_BASE_MS = '0';
    clearProviderHealth();
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          generateWithTools: async () => {
            calls.push('primary');
            if (calls.length < 3) throw new Error('529 overloaded');
            return { text: 'recovered', toolCalls: [] };
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        backend: {
          ...stubReasoningBackend,
          generateWithTools: async () => {
            calls.push('fallback');
            return { text: 'fallback', toolCalls: [] };
          },
        },
      },
    ]);

    const result = await backend.generateWithTools!('hello', []);
    expect(result.text).toBe('recovered');
    expect(calls).toEqual(['primary', 'primary', 'primary']);
  });

  it('applies PI-17 deferred tool loading at the shared backend boundary', async () => {
    let dispatchedPrompt = '';
    let dispatchedTools: Array<{ name: string }> = [];
    let deferredDefinitions: Array<{ name: string }> = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'deferred-tools',
        backend: {
          ...stubReasoningBackend,
          generateWithTools: async (prompt, tools, options) => {
            dispatchedPrompt = prompt;
            dispatchedTools = tools;
            deferredDefinitions = options?.deferred_tool_definitions || [];
            return { text: 'ok', toolCalls: [] };
          },
        },
      },
    ]);

    await backend.generateWithTools(
      'Choose the right capability.',
      [
        {
          name: 'read_file',
          description: 'Read a file.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'search',
          description: 'Search knowledge.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'deploy',
          description: 'Deploy a release.',
          inputSchema: { type: 'object', properties: {} },
          allowed_roles: ['operator'],
        },
      ],
      { role: 'agent', deferred_tool_names: ['search'] }
    );

    expect(dispatchedTools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(dispatchedPrompt).toContain('Choose the right capability.');
    expect(dispatchedPrompt).toContain('search');
    expect(dispatchedPrompt).not.toContain('deploy');
    expect(deferredDefinitions.map((tool) => tool.name)).toEqual(['search']);
  });

  it('delegates structured output with retry-on-mismatch', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (instruction: string) => {
        calls.push(instruction);
        return calls.length === 1 ? 'not json' : JSON.stringify({ answer: 'ok' });
      },
    };

    const result = await delegateStructured(
      backend,
      'Return answer',
      z.object({ answer: z.string() }),
      { maxRetries: 1 }
    );

    expect(result).toEqual({ answer: 'ok' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Retry attempt 1');
  });

  it('resolves structured schemas by registry name', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (instruction: string) => {
        calls.push(instruction);
        return calls.length === 1
          ? JSON.stringify({
              summary: 'done',
              artifacts: [],
              verification_done: ['validated'],
              gaps: [],
              needs: [],
            })
          : JSON.stringify({ summary: 'unexpected' });
      },
    };

    const result = await delegateStructured(backend, 'Return task result', 'task_result', {
      maxRetries: 0,
    });

    expect(result).toEqual({
      summary: 'done',
      artifacts: [],
      verification_done: ['validated'],
      gaps: [],
      needs: [],
    });
    expect(calls[0]).toContain('Schema:');
    expect(calls[0]).toContain('"summary"');
  });

  it('resolves A2A task contracts by registry name', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (instruction: string) => {
        calls.push(instruction);
        return JSON.stringify({
          intent: 'request_mission_work',
          text: '進捗をまとめて',
          context: {
            mission_id: 'MSN-schema-1',
            team_role: 'mission-controller',
          },
        });
      },
    };

    const result = await delegateStructured(backend, 'Return task contract', 'a2a_task_contract', {
      maxRetries: 0,
    });

    expect(result.intent).toBe('request_mission_work');
    expect(result.context.team_role).toBe('mission-controller');
    expect(calls[0]).toContain('context');
  });

  it('resolves procedure ranking by registry name', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (instruction: string) => {
        calls.push(instruction);
        return JSON.stringify({
          candidates: [{ procedure_id: 'demo', confidence: 0.9, reason: 'best' }],
        });
      },
    };

    const result = await delegateStructured(backend, 'Rank candidates', 'procedure_ranking', {
      maxRetries: 0,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.procedure_id).toBe('demo');
    expect(calls[0]).toContain('procedure_id');
  });

  it('selects a judge winner from best-of candidates', async () => {
    const calls: string[] = [];
    const backend = {
      delegateTask: async (instruction: string) => {
        calls.push(instruction);
        if (instruction.includes('candidate 1/2')) {
          return JSON.stringify({ answer: 'first' });
        }
        if (instruction.includes('candidate 2/2')) {
          return JSON.stringify({ answer: 'second' });
        }
        return JSON.stringify({ winner_index: 1, rationale: 'second is better' });
      },
    };

    const result = await delegateBestOf(
      backend,
      'Return answer',
      z.object({ answer: z.string() }),
      {
        candidateCount: 2,
        judgeInstructions: 'Pick the more useful answer.',
      }
    );

    expect(result.winner).toEqual({ answer: 'second' });
    expect(result.candidates).toHaveLength(2);
    expect(result.judge.winner_index).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('requests peer advice from a different failover backend when available', async () => {
    const calls: string[] = [];
    const backend = buildFailoverReasoningBackend([
      {
        label: 'primary',
        provider: 'codex',
        backend: {
          ...stubReasoningBackend,
          delegateTask: async () => {
            calls.push('primary');
            return JSON.stringify({
              advisor_label: 'primary',
              recommendation: 'stay put',
              risks: [],
              follow_up_questions: [],
              confidence: 'low',
            });
          },
        },
      },
      {
        label: 'peer',
        provider: 'gemini',
        backend: {
          ...stubReasoningBackend,
          delegateTask: async (instruction: string) => {
            calls.push('peer');
            expect(instruction).toContain('Question:');
            expect(instruction).toContain('Context:');
            return JSON.stringify({
              advisor_label: 'peer',
              recommendation: 'add a cache and validate it',
              risks: ['stale data'],
              follow_up_questions: ['what is the invalidation rule?'],
              confidence: 'high',
            });
          },
        },
      },
    ]);

    const advice = await requestPeerAdvice(backend, {
      question: 'Should we add caching?',
      context: 'The task is latency-sensitive.',
    });

    expect(calls).toEqual(['peer']);
    expect(advice).toMatchObject({
      advisor_label: 'peer',
      advisor_provider: 'gemini',
      recommendation: 'add a cache and validate it',
      peer_used: true,
      confidence: 'high',
    });
    expect(advice.risks).toEqual(['stale data']);
    expect(advice.follow_up_questions).toEqual(['what is the invalidation rule?']);
  });

  describe('stub backend', () => {
    it('diverges personas into hypotheses', async () => {
      const result = await stubReasoningBackend.divergePersonas({
        topic: 'pricing strategy',
        personas: ['Visionary', 'Auditor'],
        minPerPersona: 2,
      });
      expect(result).toHaveLength(4);
      expect(result.every((h) => h.proposed_by && h.content.includes('[STUB]'))).toBe(true);
    });

    it('keeps whitespace-separated persona ids stable', async () => {
      const result = await stubReasoningBackend.divergePersonas({
        topic: 'pricing strategy',
        personas: ['Visionary Persona'],
        minPerPersona: 1,
      });
      expect(result[0]?.id).toBe('H-Visionary_Persona-1');
    });

    it('cross-critiques with deterministic survival pattern', async () => {
      const hypotheses = await stubReasoningBackend.divergePersonas({
        topic: 'x',
        personas: ['A', 'B'],
        minPerPersona: 1,
      });
      const critique = await stubReasoningBackend.crossCritique({
        topic: 'x',
        hypotheses,
        personas: ['A', 'B'],
      });
      expect(critique.hypotheses).toHaveLength(2);
      expect(critique.hypotheses.filter((h) => h.survived)).toHaveLength(1);
    });

    it('synthesizes a persona from a relationship node', async () => {
      const persona = await stubReasoningBackend.synthesizePersona({
        relationshipNode: {
          identity: { name: 'A' },
          communication_style: { tempo: 'fast' },
          ng_topics: ['x'],
          history: [1, 2, 3, 4],
        },
      });
      expect(persona.identity).toEqual({ name: 'A' });
      expect(persona.ng_topics).toEqual(['x']);
      expect(persona.recent_history_summary).toHaveLength(3);
    });

    it('forks only surviving hypotheses', async () => {
      const branches = await stubReasoningBackend.forkBranches({
        hypotheses: [
          { id: 'H1', proposed_by: 'A', content: 'c', status: 'survived' },
          { id: 'H2', proposed_by: 'A', content: 'c', status: 'rejected' },
        ],
        executionProfile: 'counterfactual',
        costCapTokens: 1000,
        maxStepsPerBranch: 5,
      });
      expect(branches).toHaveLength(1);
      expect(branches[0].hypothesis_ref).toBe('H1');
    });

    it('simulates each branch with null terminals', async () => {
      const result = await stubReasoningBackend.simulateBranches({
        branches: [{ branch_id: 'A', hypothesis_ref: 'H1', worktree_path: 'x/' }],
        goal: 'ship',
      });
      expect(result.branches[0].terminated_at_step).toBeNull();
    });

    it('prefixes user-visible work responses with setup guidance when stub was not explicit', async () => {
      const previous = process.env.KYBERION_REASONING_BACKEND;
      delete process.env.KYBERION_REASONING_BACKEND;
      try {
        await expect(stubReasoningBackend.prompt('do work')).resolves.toContain(
          'Run `pnpm reasoning:setup`'
        );
        await expect(stubReasoningBackend.delegateTask('do work')).resolves.toContain(
          'Run `pnpm reasoning:setup`'
        );
      } finally {
        if (previous === undefined) {
          delete process.env.KYBERION_REASONING_BACKEND;
        } else {
          process.env.KYBERION_REASONING_BACKEND = previous;
        }
      }
    });

    it('keeps explicit stub mode deterministic without setup guidance', async () => {
      const previous = process.env.KYBERION_REASONING_BACKEND;
      process.env.KYBERION_REASONING_BACKEND = 'stub';
      try {
        const result = await stubReasoningBackend.prompt('offline test');
        expect(result).toBe('[STUB] offline test');
      } finally {
        if (previous === undefined) {
          delete process.env.KYBERION_REASONING_BACKEND;
        } else {
          process.env.KYBERION_REASONING_BACKEND = previous;
        }
      }
    });
  });
});
