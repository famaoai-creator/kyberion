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

describe('reasoning-backend', () => {
  afterEach(() => {
    delete process.env.KYBERION_REASONING_IN_PLACE_RETRIES;
    delete process.env.KYBERION_REASONING_RETRY_BASE_MS;
    resetReasoningBackend();
    clearProviderHealth();
  });

  it('defaults to the stub backend when none is registered', () => {
    expect(getReasoningBackend().name).toBe('stub');
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
    registerReasoningBackend(fake);
    expect(getReasoningBackend().name).toBe('fake');
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
