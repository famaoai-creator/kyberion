import { afterEach, describe, expect, it } from 'vitest';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import {
  getReasoningBackend,
  getStubServedOps,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning-backend.js';
import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import {
  createScenarioFixtureBackend,
  installScenarioFixtureBackend,
  SCENARIO_FIXTURE_BACKEND_NAME,
} from './scenario-model-fixtures.js';
import { runInScenarioScope } from './scenario-run-scope.js';
import { createScenarioSideEffectLog } from './scenario-side-effect-log.js';

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'model-fixtures',
    title: 'Model fixtures',
    tier: 1,
    executionProfile: 'simulated',
    modelFixtures: 'fixtures',
    requires: {},
    seed: {},
    fixtures: {
      ops: {},
      reasoning: [
        { match: { contains: 'summarize', regex: 'ticket-\\d+' }, response: 'summary text' },
        { match: { contains: 'summarize' }, response: 'generic summary' },
        { match: { contains: 'extractRequirements' }, response: '{"requirements":[]}' },
        { match: { contains: 'forkBranches' }, response: 'not json' },
      ],
    },
    turns: [],
    finalChecks: [],
    ...overrides,
  });
}

afterEach(() => {
  resetReasoningBackend();
});

describe('scenario fixture reasoning backend (ES-04)', () => {
  it('answers from the first matching fixture and logs hashes only', async () => {
    const log = createScenarioSideEffectLog();
    const backend = createScenarioFixtureBackend(scenario(), log);

    await expect(backend.prompt('please summarize ticket-42')).resolves.toBe('summary text');
    await expect(backend.prompt('please summarize this')).resolves.toBe('generic summary');
    await expect(backend.delegateTask('summarize', 'ctx')).resolves.toBe('generic summary');
    expect(log.reasoning.map((r) => [r.seq, r.method, r.outcome, r.fixture_index])).toEqual([
      [1, 'prompt', 'fixture', 0],
      [2, 'prompt', 'fixture', 1],
      [3, 'delegateTask', 'fixture', 1],
    ]);
    expect(log.reasoning[0]).toMatchObject({
      backend: SCENARIO_FIXTURE_BACKEND_NAME,
      prompt_length: 'please summarize ticket-42'.length,
      response_length: 'summary text'.length,
    });
    expect(log.reasoning[0]?.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log)).not.toContain('ticket-42');
  });

  it('throws SCENARIO_FIXTURE_MISS instead of falling back to the stub', async () => {
    const log = createScenarioSideEffectLog();
    const backend = createScenarioFixtureBackend(scenario(), log);
    const before = getStubServedOps().length;

    await expect(backend.prompt('unrelated prompt')).rejects.toThrow('[SCENARIO_FIXTURE_MISS]');
    await expect(backend.divergePersonas({ topic: 't', personas: [] } as never)).rejects.toThrow(
      '[SCENARIO_FIXTURE_MISS]'
    );
    expect(log.reasoning.map((r) => r.outcome)).toEqual(['miss', 'miss']);
    expect(getStubServedOps().length).toBe(before);
  });

  it('parses structured fixture responses as JSON and rejects non-JSON', async () => {
    const backend = createScenarioFixtureBackend(scenario(), createScenarioSideEffectLog());
    await expect(backend.extractRequirements({ text: 'x' } as never)).resolves.toEqual({
      requirements: [],
    });
    await expect(backend.forkBranches({} as never)).rejects.toThrow('[SCENARIO_FIXTURE_INVALID]');
  });

  it('forbids every reasoning call in model-free mode', async () => {
    const log = createScenarioSideEffectLog();
    const backend = createScenarioFixtureBackend(scenario({ modelFixtures: 'model-free' }), log);
    await expect(backend.prompt('please summarize ticket-42')).rejects.toThrow(
      '[SCENARIO_MODEL_CALL_FORBIDDEN]'
    );
    await expect(backend.delegateTask('anything')).rejects.toThrow(
      '[SCENARIO_MODEL_CALL_FORBIDDEN]'
    );
    expect(log.reasoning.map((r) => r.outcome)).toEqual(['forbidden', 'forbidden']);
  });

  it('rejects an invalid fixture regex at creation', () => {
    const def = scenario({
      fixtures: { ops: {}, reasoning: [{ match: { regex: '(' }, response: 'x' }] },
    });
    expect(() => createScenarioFixtureBackend(def, createScenarioSideEffectLog())).toThrow(
      '[SCENARIO_FIXTURE_INVALID]'
    );
  });

  it('binds as the active backend and restores the previously bound one on dispose', async () => {
    const prior = { ...stubReasoningBackend, name: 'prior-backend' } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });

    const dispose = installScenarioFixtureBackend(scenario(), createScenarioSideEffectLog());
    expect(getReasoningBackend().name).toBe(SCENARIO_FIXTURE_BACKEND_NAME);
    await expect(getReasoningBackend().prompt('nothing matches')).rejects.toThrow(
      '[SCENARIO_FIXTURE_MISS]'
    );
    dispose();
    dispose();
    expect(getReasoningBackend()).toBe(prior);
  });

  it('restores the stub-taint registry that unbinding the prior backend cleared', async () => {
    resetReasoningBackend();
    await stubReasoningBackend.delegateTask('tainted before the scenario');
    const prior = { ...stubReasoningBackend, name: 'prior-backend' } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });

    const dispose = installScenarioFixtureBackend(scenario(), createScenarioSideEffectLog());
    dispose();
    expect(getStubServedOps().map((entry) => entry.op)).toEqual(['delegateTask']);
    expect(getReasoningBackend()).toBe(prior);
  });

  it('binds on an empty seam and leaves it empty after dispose', () => {
    const dispose = installScenarioFixtureBackend(scenario(), createScenarioSideEffectLog());
    expect(getReasoningBackend().name).toBe(SCENARIO_FIXTURE_BACKEND_NAME);
    dispose();
    expect(getReasoningBackend()).toBe(stubReasoningBackend);
  });

  it('with a scopeId answers from fixtures only inside that scope (FU-01)', async () => {
    const prior = {
      ...stubReasoningBackend,
      name: 'prior-backend',
      prompt: async () => 'prior answer',
      getRuntimeProviderName: () => 'prior-provider',
    } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });
    const log = createScenarioSideEffectLog();
    const dispose = installScenarioFixtureBackend(scenario(), log, { scopeId: 'run-a' });
    try {
      const backend = getReasoningBackend();
      await expect(backend.prompt('please summarize ticket-42')).resolves.toBe('prior answer');
      expect(backend.name).toBe('prior-backend');
      expect(backend.getRuntimeProviderName?.()).toBe('prior-provider');
      await expect(
        runInScenarioScope('run-b', () => backend.prompt('please summarize ticket-42'))
      ).resolves.toBe('prior answer');
      await runInScenarioScope('run-a', async () => {
        await expect(backend.prompt('please summarize ticket-42')).resolves.toBe('summary text');
        expect(backend.name).toBe(SCENARIO_FIXTURE_BACKEND_NAME);
        expect(backend.getRuntimeProviderName?.()).toBe(SCENARIO_FIXTURE_BACKEND_NAME);
      });
      expect(log.reasoning.map((r) => r.outcome)).toEqual(['fixture']);
    } finally {
      dispose();
    }
    expect(getReasoningBackend()).toBe(prior);
  });

  it('with a scopeId keeps every optional capability of the prior backend outside the scope', async () => {
    const calls: string[] = [];
    const prior = {
      ...stubReasoningBackend,
      name: 'prior-backend',
      supportsVision: true,
      async *streamPrompt(prompt: string) {
        calls.push(`stream:${prompt}`);
        yield 'prior ';
        yield 'stream';
      },
      async generateWithTools(prompt: string) {
        calls.push(`tools:${prompt}`);
        return { text: 'prior tools', toolCalls: [] };
      },
      async promptWithImages(prompt: string) {
        calls.push(`images:${prompt}`);
        return 'prior vision';
      },
      delegateTaskHandle(instruction: string) {
        calls.push(`handle:${instruction}`);
        return { delegation_id: 'd-1', join: async () => 'prior handle' };
      },
    } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });
    const log = createScenarioSideEffectLog();
    const dispose = installScenarioFixtureBackend(scenario(), log, { scopeId: 'run-a' });
    const collect = async (stream: AsyncIterable<string>) => {
      const parts: string[] = [];
      for await (const part of stream) parts.push(part);
      return parts.join('');
    };
    const image = [{ path: '/x.png', media_type: 'image/png' as const }];
    try {
      const backend = getReasoningBackend();
      expect(backend.supportsVision).toBe(true);
      await expect(collect(backend.streamPrompt!('host'))).resolves.toBe('prior stream');
      await expect(backend.generateWithTools!('host', [])).resolves.toMatchObject({
        text: 'prior tools',
      });
      await expect(backend.promptWithImages!('host', image)).resolves.toBe('prior vision');
      await expect(backend.delegateTaskHandle!('host').join()).resolves.toBe('prior handle');
      expect(calls).toEqual(['stream:host', 'tools:host', 'images:host', 'handle:host']);

      await runInScenarioScope('run-a', async () => {
        expect(backend.supportsVision).toBe(false);
        await expect(collect(backend.streamPrompt!('please summarize ticket-1'))).resolves.toBe(
          'summary text'
        );
        await expect(backend.generateWithTools!('summarize', [])).rejects.toThrow(
          '[SCENARIO_FIXTURE_MISS]'
        );
        await expect(backend.promptWithImages!('summarize', image)).rejects.toThrow(
          '[SCENARIO_FIXTURE_MISS]'
        );
        expect(backend.delegateTaskHandle).toBeUndefined();
        await expect(backend.delegateTask('summarize')).resolves.toBe('generic summary');
      });
      expect(calls).toHaveLength(4);
      expect(log.reasoning.map((r) => [r.method, r.outcome])).toEqual([
        ['prompt', 'fixture'],
        ['generateWithTools', 'miss'],
        ['promptWithImages', 'miss'],
        ['delegateTask', 'fixture'],
      ]);
    } finally {
      dispose();
    }
  });

  it('with a scopeId omits optional methods the prior backend lacks', () => {
    const { streamPrompt, generateWithTools, promptWithImages, ...plain } = {
      ...stubReasoningBackend,
    } as ReasoningBackend;
    void streamPrompt;
    void generateWithTools;
    void promptWithImages;
    const prior = { ...plain, name: 'plain', delegateTaskHandle: undefined } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });
    const dispose = installScenarioFixtureBackend(scenario(), createScenarioSideEffectLog(), {
      scopeId: 'run-a',
    });
    try {
      const backend = getReasoningBackend();
      expect(backend.streamPrompt).toBeUndefined();
      expect(backend.generateWithTools).toBeUndefined();
      expect(backend.promptWithImages).toBeUndefined();
      expect(backend.delegateTaskHandle).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('with a scopeId and nothing bound before, calls outside the scope get the stub', async () => {
    const dispose = installScenarioFixtureBackend(scenario(), createScenarioSideEffectLog(), {
      scopeId: 'run-a',
    });
    try {
      const before = getStubServedOps().length;
      await expect(getReasoningBackend().delegateTask('host work')).resolves.toEqual(
        expect.any(String)
      );
      expect(getStubServedOps().length).toBe(before + 1);
    } finally {
      dispose();
    }
  });
});
