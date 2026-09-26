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
import {
  registerReasoningBackend,
  resetReasoningBackend,
  restoreStubServedOps,
  snapshotStubServedOps,
  stubReasoningBackend,
} from './reasoning-backend.js';
import { coreSeamCatalog } from './seam.js';
import type { ScenarioDefinition } from './scenario-definition.js';
import { getActiveScenarioRunId } from './scenario-run-scope.js';
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

interface ScenarioFixtureResponder {
  answer(method: string, prompt: string): string;
  answerStructured<T>(method: string, input: unknown): T;
  /** A call fixtures can never serve (tools, images): logged and thrown like a miss. */
  refuse(method: string, prompt: string): never;
}

function createFixtureResponder(
  def: ScenarioDefinition,
  log: ScenarioSideEffectLog
): ScenarioFixtureResponder {
  const fixtures = def.modelFixtures === 'fixtures' ? compileFixtures(def) : [];

  function baseRecord(method: string, prompt: string) {
    return {
      method,
      backend: SCENARIO_FIXTURE_BACKEND_NAME,
      prompt_hash: sha256(prompt),
      prompt_length: prompt.length,
    };
  }

  function forbid(method: string, base: ReturnType<typeof baseRecord>): never {
    appendScenarioReasoning(log, { ...base, outcome: 'forbidden' });
    throw new Error(
      `[SCENARIO_MODEL_CALL_FORBIDDEN] scenario ${def.id} is model-free but ${method} was called`
    );
  }

  function answer(method: string, prompt: string): string {
    const base = baseRecord(method, prompt);
    if (def.modelFixtures === 'model-free') forbid(method, base);
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

  function refuse(method: string, prompt: string): never {
    const base = baseRecord(method, prompt);
    if (def.modelFixtures === 'model-free') forbid(method, base);
    appendScenarioReasoning(log, { ...base, outcome: 'miss' });
    throw new Error(
      `[SCENARIO_FIXTURE_MISS] scenario ${def.id}: ${method} cannot be served from reasoning fixtures (prompt sha256 ${base.prompt_hash.slice(0, 12)})`
    );
  }

  return { answer, answerStructured, refuse };
}

export function createScenarioFixtureBackend(
  def: ScenarioDefinition,
  log: ScenarioSideEffectLog
): ReasoningBackend {
  return fixtureBackendFrom(createFixtureResponder(def, log));
}

function fixtureBackendFrom(responder: ScenarioFixtureResponder): ReasoningBackend {
  const { answer, answerStructured } = responder;
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
 * FU-01: route each call to `fixture` inside the scenario scope and to
 * `fallback` (the backend that was bound before the run, else the stub)
 * everywhere else, so unrelated host reasoning is never fixture-answered.
 * Every optional capability of `fallback` stays available outside the scope;
 * inside it, streaming is the fixture answer, tools / images are refused like
 * a fixture miss, and there is no delegation handle.
 */
function scopeFixtureBackend(
  fixture: ReasoningBackend,
  responder: ScenarioFixtureResponder,
  fallback: ReasoningBackend,
  inScope: () => boolean
): ReasoningBackend {
  const pick = (): ReasoningBackend => (inScope() ? fixture : fallback);
  const scoped: ReasoningBackend = {
    get name() {
      return pick().name;
    },
    get supportsVision() {
      return inScope() ? false : fallback.supportsVision;
    },
    getRuntimeInstructions: (options) =>
      inScope() ? [] : (fallback.getRuntimeInstructions?.(options) ?? []),
    getRuntimeProviderName: (options) =>
      inScope() ? fixture.name : fallback.getRuntimeProviderName?.(options) || fallback.name,
    resetSession: () => (inScope() ? undefined : fallback.resetSession?.()),
    getNativeSubagentAdopter: () =>
      inScope() ? null : (fallback.getNativeSubagentAdopter?.() ?? null),
    requiresNativeSubagent: () =>
      inScope() ? false : (fallback.requiresNativeSubagent?.() ?? false),
    prompt: (prompt, options) => pick().prompt(prompt, options),
    delegateTask: (instruction, context, options) =>
      pick().delegateTask(instruction, context, options),
    divergePersonas: (input, options) => pick().divergePersonas(input, options),
    crossCritique: (input, options) => pick().crossCritique(input, options),
    synthesizePersona: (input, options) => pick().synthesizePersona(input, options),
    forkBranches: (input, options) => pick().forkBranches(input, options),
    simulateBranches: (input, options) => pick().simulateBranches(input, options),
    extractRequirements: (input, options) => pick().extractRequirements(input, options),
    extractDesignSpec: (input, options) => pick().extractDesignSpec(input, options),
    extractTestPlan: (input, options) => pick().extractTestPlan(input, options),
    decomposeIntoTasks: (input, options) => pick().decomposeIntoTasks(input, options),
  };
  if (fallback.streamPrompt) {
    scoped.streamPrompt = (prompt, options) => {
      if (!inScope()) return fallback.streamPrompt!(prompt, options);
      return (async function* fixtureStream(): AsyncGenerator<string> {
        const text = await fixture.prompt(prompt, options);
        if (text) yield text;
      })();
    };
  }
  if (fallback.generateWithTools) {
    scoped.generateWithTools = async (prompt, tools, options) =>
      inScope()
        ? responder.refuse('generateWithTools', prompt)
        : fallback.generateWithTools!(prompt, tools, options);
  }
  if (fallback.promptWithImages) {
    scoped.promptWithImages = async (prompt, images, options) =>
      inScope()
        ? responder.refuse('promptWithImages', prompt)
        : fallback.promptWithImages!(prompt, images, options);
  }
  if (fallback.delegateTaskHandle) {
    // Absent inside the scope (callers fall back to the fixture-served
    // delegateTask) so a scenario never opens a real delegation record.
    Object.defineProperty(scoped, 'delegateTaskHandle', {
      enumerable: true,
      get: () => (inScope() ? undefined : fallback.delegateTaskHandle!.bind(fallback)),
    });
  }
  return scoped;
}

export interface ScenarioFixtureBackendInstallOptions {
  /**
   * FU-01: answer from fixtures only inside this scenario scope; calls made
   * elsewhere go to the previously bound backend (or the stub). Unset keeps
   * the unscoped behaviour (every call is fixture-answered).
   */
  scopeId?: string;
}

/**
 * Bind the fixture backend as the active reasoning backend. A backend that
 * was already bound is unbound for the run and re-bound (same implementation
 * and metadata) by the returned disposer. Unbinding goes through
 * `resetReasoningBackend()`, which also clears the process-wide stub-taint
 * registry, so the registry is snapshotted first and restored on dispose.
 */
export function installScenarioFixtureBackend(
  def: ScenarioDefinition,
  log: ScenarioSideEffectLog,
  options: ScenarioFixtureBackendInstallOptions = {}
): () => void {
  const seam = coreSeamCatalog.get<ReasoningBackend>('reasoning-backend');
  const prior = seam?.list()[0];
  const stubTaint = prior ? snapshotStubServedOps() : undefined;
  if (prior) {
    resetReasoningBackend();
    if ((seam?.list().length ?? 0) > 0) {
      restoreStubServedOps(stubTaint ?? []);
      throw new Error(
        '[SCENARIO_BACKEND_BUSY] the active reasoning backend could not be unbound for the scenario run'
      );
    }
  }
  const responder = createFixtureResponder(def, log);
  const fixtureBackend = fixtureBackendFrom(responder);
  const { scopeId } = options;
  const backend =
    scopeId === undefined
      ? fixtureBackend
      : scopeFixtureBackend(
          fixtureBackend,
          responder,
          prior?.implementation ?? stubReasoningBackend,
          () => getActiveScenarioRunId() === scopeId
        );
  const unregister = registerReasoningBackend(backend, {
    provenance: 'builtin',
    source: 'libs/core/scenario-model-fixtures.ts',
    reason: `scenario ${def.id} (${def.modelFixtures})`,
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unregister();
      if (prior) registerReasoningBackend(prior.implementation, prior.metadata);
    } finally {
      if (stubTaint) restoreStubServedOps(stubTaint);
    }
  };
}
