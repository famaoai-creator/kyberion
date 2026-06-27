import { z } from 'zod';
import { buildCodexCliQueryOptionsFromEnv, runCodexCliQuery, type CodexCliQueryOptions } from './codex-cli-query.js';
import type {
  BranchForkInput,
  CritiqueInput,
  CritiqueResult,
  DecomposeIntoTasksInput,
  DecomposedTaskPlan,
  DivergeHypothesisInput,
  ExtractDesignSpecInput,
  ExtractRequirementsInput,
  ExtractTestPlanInput,
  ExtractedDesignSpec,
  ExtractedRequirements,
  ExtractedTestPlan,
  ForkedBranch,
  HypothesisSketch,
  PersonaSynthesisInput,
  ReasoningBackend,
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
} from './reasoning-backend.js';
import {
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  structuredReasoningSpecs,
  type StructuredOpSpec,
} from './structured-reasoning.js';

export interface CodexCliReasoningBackendOptions extends CodexCliQueryOptions {}

export class CodexCliReasoningBackend implements ReasoningBackend {
  readonly name = 'codex-cli';
  private readonly options: CodexCliQueryOptions;

  constructor(options: CodexCliReasoningBackendOptions = {}) {
    this.options = options;
  }

  /** Run a shared structured-reasoning op through the codex CLI (schema-validated). */
  private async runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput> {
    const result = await runCodexCliQuery({
      systemPrompt: STRUCTURED_REASONING_SYSTEM_PROMPT,
      userPrompt: spec.buildUserPrompt(input),
      schema: spec.schema,
      mode: 'workspace-write',
      options: this.options,
    });
    return spec.extract(result);
  }

  divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    return this.runStructured(structuredReasoningSpecs.divergePersonas, input);
  }

  crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    return this.runStructured(structuredReasoningSpecs.crossCritique, input);
  }

  synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    return this.runStructured(structuredReasoningSpecs.synthesizePersona, input);
  }

  forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    return this.runStructured(structuredReasoningSpecs.forkBranches, input);
  }

  simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    return this.runStructured(structuredReasoningSpecs.simulateBranches, input);
  }

  extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return this.runStructured(structuredReasoningSpecs.extractRequirements, input);
  }

  extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    return this.runStructured(structuredReasoningSpecs.extractDesignSpec, input);
  }

  extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    return this.runStructured(structuredReasoningSpecs.extractTestPlan, input);
  }

  decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    return this.runStructured(structuredReasoningSpecs.decomposeIntoTasks, input);
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    const schema = z.object({ answer: z.string() });
    const result = await runCodexCliQuery({
      systemPrompt:
        'You are a focused autonomous sub-agent. Complete the task in the workspace if needed and return a concise report.',
      userPrompt: [context ? `Context: ${context}` : '', `Task: ${instruction}`].filter(Boolean).join('\n\n'),
      schema,
      mode: 'workspace-write',
      options: this.options,
    }) as z.infer<typeof schema>;
    return result.answer;
  }

  async prompt(prompt: string): Promise<string> {
    return this.delegateTask(prompt);
  }
}

export function buildCodexCliBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexCliReasoningBackend {
  return new CodexCliReasoningBackend(buildCodexCliQueryOptionsFromEnv(env));
}
