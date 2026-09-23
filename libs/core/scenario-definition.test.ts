import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import {
  loadScenarioFile,
  parseScenarioDefinition,
  resolveScenarioLane,
  ScenarioDefinitionError,
  type ScenarioDefinition,
} from './scenario-definition.js';

function baseScenario(overrides: Partial<ScenarioDefinition> = {}): unknown {
  return {
    schema_version: 'kyberion-scenario.v1',
    id: 'base-scenario',
    title: 'Base scenario',
    tier: 1,
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: { ops: {} },
    turns: [],
    finalChecks: [],
    ...overrides,
  };
}

describe('resolveScenarioLane', () => {
  it('defaults to live-only when lane is absent', () => {
    expect(resolveScenarioLane({})).toBe('live-only');
  });

  it('defaults to live-only for any value other than pr-deterministic', () => {
    expect(resolveScenarioLane({ lane: 'nonsense' })).toBe('live-only');
  });

  it('resolves pr-deterministic explicitly', () => {
    expect(resolveScenarioLane({ lane: 'pr-deterministic' })).toBe('pr-deterministic');
  });
});

describe('parseScenarioDefinition', () => {
  it('parses a minimal valid scenario and defaults lane to live-only', () => {
    const parsed = parseScenarioDefinition(baseScenario());
    expect(parsed.lane).toBe('live-only');
    expect(parsed.id).toBe('base-scenario');
  });

  it('accepts an explicit lane', () => {
    const parsed = parseScenarioDefinition(baseScenario({ lane: 'pr-deterministic' }));
    expect(parsed.lane).toBe('pr-deterministic');
  });

  it('rejects a schema violation (unknown id pattern)', () => {
    expect(() => parseScenarioDefinition(baseScenario({ id: 'Not Kebab' }))).toThrow(
      ScenarioDefinitionError
    );
  });

  it('rejects additional top-level properties', () => {
    const raw = baseScenario();
    (raw as Record<string, unknown>).unexpected = true;
    expect(() => parseScenarioDefinition(raw)).toThrow(ScenarioDefinitionError);
  });

  it('rejects provider-qualified execution profile outside lane live-only', () => {
    const raw = baseScenario({
      lane: 'pr-deterministic',
      executionProfile: 'provider-qualified',
    } as Partial<ScenarioDefinition>);
    try {
      parseScenarioDefinition(raw);
      throw new Error('expected parseScenarioDefinition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioDefinitionError);
      expect((error as ScenarioDefinitionError).code).toBe('SCENARIO_INVALID');
      expect((error as ScenarioDefinitionError).issues.join(' ')).toMatch(
        /provider-qualified.*live-only/
      );
    }
  });

  it('rejects an intent turn on lane pr-deterministic', () => {
    const raw = baseScenario({
      lane: 'pr-deterministic',
      turns: [{ kind: 'intent', text: 'do it' }],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/intent turns/);
  });

  it('rejects a judge check on lane pr-deterministic', () => {
    const raw = baseScenario({
      lane: 'pr-deterministic',
      turns: [
        {
          kind: 'pipeline',
          steps: [{ op: 'x:y' }],
          checks: { judge: { rubric: 'r', minScore: 0.5 } },
        },
      ],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/judge checks/);
  });

  it('rejects deferred combined with lane pr-deterministic', () => {
    const raw = baseScenario({
      lane: 'pr-deterministic',
      deferred: { reason: 'no runner yet' },
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/deferred/);
  });

  it('accepts deferred combined with lane live-only', () => {
    const parsed = parseScenarioDefinition(
      baseScenario({
        deferred: { reason: 'no runner yet' },
      } as unknown as Partial<ScenarioDefinition>)
    );
    expect(parsed.deferred?.reason).toBe('no runner yet');
  });

  it('rejects an absolute seed file path', () => {
    const raw = baseScenario({
      seed: { files: [{ path: '/etc/passwd', content: 'x' }] },
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/relative path/);
  });

  it('rejects a seed file path that escapes the run root', () => {
    const raw = baseScenario({
      seed: { files: [{ path: '../outside.txt', content: 'x' }] },
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/'\.\.' segments/);
  });

  it('rejects a pipeline turn declaring both pipeline and steps', () => {
    const raw = baseScenario({
      turns: [{ kind: 'pipeline', pipeline: 'p.json', steps: [{ op: 'x:y' }] }],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(ScenarioDefinitionError);
  });

  it('rejects a pipeline turn declaring neither pipeline nor steps', () => {
    const raw = baseScenario({
      turns: [{ kind: 'pipeline' }],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(ScenarioDefinitionError);
  });

  it('rejects an absolute pipeline turn path', () => {
    const raw = baseScenario({
      turns: [{ kind: 'pipeline', pipeline: '/etc/pipeline.json' }],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(/relative path/);
  });

  it('rejects an unknown finalChecks type', () => {
    const raw = baseScenario({
      finalChecks: [{ type: 'somethingElse', op: 'x:y' }],
    } as unknown as Partial<ScenarioDefinition>);
    expect(() => parseScenarioDefinition(raw)).toThrow(ScenarioDefinitionError);
  });
});

describe('loadScenarioFile (fixtures)', () => {
  it('loads and parses the valid pr-deterministic example fixture', () => {
    const filePath = pathResolver.rootResolve(
      'tests/fixtures/scenarios/valid-pr-deterministic.json'
    );
    const parsed = loadScenarioFile(filePath);
    expect(parsed.id).toBe('apply-with-approval');
    expect(parsed.lane).toBe('pr-deterministic');
    expect(parsed.turns).toHaveLength(4);
    expect(parsed.finalChecks).toHaveLength(3);
  });

  it('rejects the invalid example fixture (intent + judge on pr-deterministic)', () => {
    const filePath = pathResolver.rootResolve(
      'tests/fixtures/scenarios/invalid-pr-deterministic-intent-judge.json'
    );
    expect(() => loadScenarioFile(filePath)).toThrow(ScenarioDefinitionError);
    try {
      loadScenarioFile(filePath);
      throw new Error('expected loadScenarioFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioDefinitionError);
      const issues = (error as ScenarioDefinitionError).issues.join(' ');
      expect(issues).toMatch(/intent turns/);
      expect(issues).toMatch(/judge checks/);
    }
  });
});
