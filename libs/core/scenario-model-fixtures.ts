/**
 * ES-04: fixture-served reasoning backend for scenario runs.
 *
 * `modelFixtures: 'fixtures'` answers every reasoning call from
 * `def.fixtures.reasoning` (first entry whose `contains` / `regex` all match)
 * and throws `[SCENARIO_FIXTURE_MISS]` otherwise. `'model-free'` treats any
 * reasoning call as a violation (`[SCENARIO_MODEL_CALL_FORBIDDEN]`). Neither
 * mode ever falls back to the stub backend, so a scenario can't silently pass
 * on placeholder output. Only hashes and lengths are logged, never text.
 */

import * as crypto from 'node:crypto';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import { registerReasoningBackend, resetReasoningBackend } from './reasoning-backend.js';
import { coreSeamCatalog } from './seam.js';
import type { ScenarioDefinition } from './scenario-definition.js';
import { appendScenarioReasoning, type ScenarioSideEffectLog } from './scenario-side-effect-log.js';

export const SCENARIO_FIXTURE_BACKEND_NAME = 'scenario-fixtures';

interface CompiledReasoningFixture {
  index: number;
  contains?: string;
  regex?: RegExp;
  response: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function compileFixtures(def: ScenarioDefinition): CompiledReasoningFixture[] {
  return (def.fixtures.reasoning ?? []).map((fixture, index) => {
    let regex: RegExp | undefined;
    if (fixture.match.regex !== undefined) {
      try {
        regex = new RegExp(fixture.match.regex, 'u');
      } catch (error) {
        throw new Error(
          `[SCENARIO_FIXTURE_INVALID] fixtures.reasoning[${index}].match.regex: ${(error as Error).message}`
        );
      }
    }
    return {
      index,
      ...(fixture.match.contains !== undefined ? { contains: fixture.match.contains } : {}),
      ...(regex ? { regex } : {}),
      response: fixture.response,
    };
  });
}

function fixtureMatches(fixture: CompiledReasoningFixture, prompt: string): boolean {
  if (fixture.contains !== undefined && !prompt.includes(fixture.contains)) return false;
  if (fixture.regex && !fixture.regex.test(prompt)) return false;
  return fixture.contains !== undefined || fixture.regex !== undefined;
}

export function createScenarioFixtureBackend(
  def: ScenarioDefinition,
  log: ScenarioSideEffectLog
): ReasoningBackend {
  const fixtures = def.modelFixtures === 'fixtures' ? compileFixtures(def) : [];

  function answer(method: string, prompt: string): string {
    const base = {
      method,
      backend: SCENARIO_FIXTURE_BACKEND_NAME,
      prompt_hash: sha256(prompt),
      prompt_length: prompt.length,
    };
    if (def.modelFixtures === 'model-free') {
      appendScenarioReasoning(log, { ...base, outcome: 'forbidden' });
      throw new Error(
        `[SCENARIO_MODEL_CALL_FORBIDDEN] scenario ${def.id} is model-free but ${method} was called`
      );
    }
    const fixture = fixtures.find((candidate) => fixtureMatches(candidate, prompt));
    if (!fixture) {
      appendScenarioReasoning(log, { ...base, outcome: 'miss' });
      throw new Error(
        `[SCENARIO_FIXTURE_MISS] scenario ${def.id}: no reasoning fixture matches ${method} (prompt sha256 ${base.prompt_hash.slice(0, 12)})`
      );
    }
    appendScenarioReasoning(log, {
      ...base,
      outcome: 'fixture',
      fixture_index: fixture.index,
      response_hash: sha256(fixture.response),
      response_length: fixture.response.length,
    });
    return fixture.response;
  }

  function answerStructured<T>(method: string, input: unknown): T {
    const response = answer(method, `${method}\n${JSON.stringify(input)}`);
    try {
      return JSON.parse(response) as T;
    } catch {
      throw new Error(
        `[SCENARIO_FIXTURE_INVALID] scenario ${def.id}: fixture response for ${method} is not JSON`
      );
    }
  }

  return {
    name: SCENARIO_FIXTURE_BACKEND_NAME,
    async prompt(prompt) {
      return answer('prompt', prompt);
    },
    async delegateTask(instruction, context) {
      return answer('delegateTask', context ? `${instruction}\n\n${context}` : instruction);
    },
    async divergePersonas(input) {
      return answerStructured('divergePersonas', input);
    },
    async crossCritique(input) {
      return answerStructured('crossCritique', input);
    },
    async synthesizePersona(input) {
      return answerStructured('synthesizePersona', input);
    },
    async forkBranches(input) {
      return answerStructured('forkBranches', input);
    },
    async simulateBranches(input) {
      return answerStructured('simulateBranches', input);
    },
    async extractRequirements(input) {
      return answerStructured('extractRequirements', input);
    },
    async extractDesignSpec(input) {
      return answerStructured('extractDesignSpec', input);
    },
    async extractTestPlan(input) {
      return answerStructured('extractTestPlan', input);
    },
    async decomposeIntoTasks(input) {
      return answerStructured('decomposeIntoTasks', input);
    },
  };
}

/**
 * Bind the fixture backend as the active reasoning backend. A backend that
 * was already bound is unbound for the run and re-bound (same implementation
 * and metadata) by the returned disposer. Note: unbinding goes through
 * `resetReasoningBackend()`, which also clears the stub-taint registry.
 */
export function installScenarioFixtureBackend(
  def: ScenarioDefinition,
  log: ScenarioSideEffectLog
): () => void {
  const seam = coreSeamCatalog.get<ReasoningBackend>('reasoning-backend');
  const prior = seam?.list()[0];
  if (prior) {
    resetReasoningBackend();
    if ((seam?.list().length ?? 0) > 0) {
      throw new Error(
        '[SCENARIO_BACKEND_BUSY] the active reasoning backend could not be unbound for the scenario run'
      );
    }
  }
  const backend = createScenarioFixtureBackend(def, log);
  const unregister = registerReasoningBackend(backend, {
    provenance: 'builtin',
    source: 'libs/core/scenario-model-fixtures.ts',
    reason: `scenario ${def.id} (${def.modelFixtures})`,
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregister();
    if (prior) registerReasoningBackend(prior.implementation, prior.metadata);
  };
}
