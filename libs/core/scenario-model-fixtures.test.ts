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
});
