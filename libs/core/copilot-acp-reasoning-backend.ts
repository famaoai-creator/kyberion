import { ACPMediator } from './acp-mediator.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import {
  runStructuredReasoningOp,
  structuredReasoningSpecs,
  STRUCTURED_REASONING_SYSTEM_PROMPT,
  type StructuredOpSpec,
} from './structured-reasoning.js';
import { assertReasoningEgressAllowed } from './reasoning-egress-scope.js';
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

export interface CopilotAcpReasoningBackendOptions {
  command?: string;
  args?: string[];
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Reasoning adapter for GitHub Copilot CLI's Agent Client Protocol server.
 *
 * The ACP mediator owns process lifecycle, timeout handling, and governed
 * permission decisions. This class only maps the backend-agnostic reasoning
 * contract onto a text-returning ACP session.
 */
export class CopilotAcpReasoningBackend implements ReasoningBackend {
  readonly name = 'copilot-acp';
  private readonly mediator: ACPMediator;
  private bootPromise: Promise<void> | null = null;

  constructor(options: CopilotAcpReasoningBackendOptions = {}) {
    const command = options.command || process.env.KYBERION_COPILOT_CLI_BIN || 'gh';
    const model =
      options.model ||
      process.env.KYBERION_COPILOT_MODEL ||
      resolveRuntimeModelId('copilot-default');
    const args =
      options.args ||
      (command === 'gh'
        ? ['copilot', '--', '--acp', '--no-ask-user', '--model', model]
        : ['--acp', '--no-ask-user', '--model', model]);

    this.mediator = new ACPMediator({
      threadId: `reasoning-copilot-${process.pid}`,
      bootCommand: command,
      bootArgs: args,
      cwd: options.cwd,
      modelId: model,
      turnTimeoutMs: options.timeoutMs,
      // Copilot CLI authenticates through its own login/session before ACP.
      authenticateMethod: null,
    });
  }

  private async ensureBooted(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.mediator.boot().catch((error) => {
        this.bootPromise = null;
        throw error;
      });
    }
    await this.bootPromise;
  }

  private async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    assertReasoningEgressAllowed(this.name);
    await this.ensureBooted();
    try {
      return await this.mediator.ask(`${systemPrompt}\n\n${userPrompt}`);
    } catch (error) {
      await this.mediator.shutdown().catch(() => undefined);
      this.bootPromise = null;
      throw error;
    }
  }

  private runStructured<TInput, TOutput>(
    spec: StructuredOpSpec<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    return runStructuredReasoningOp(spec, input, (systemPrompt, userPrompt) =>
      this.complete(systemPrompt, userPrompt)
    );
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

  delegateTask(instruction: string, context?: string): Promise<string> {
    return this.complete(
      STRUCTURED_REASONING_SYSTEM_PROMPT,
      [context ? `Context: ${context}` : '', `Task: ${instruction}`].filter(Boolean).join('\n\n')
    );
  }

  prompt(prompt: string): Promise<string> {
    return this.complete(
      'You are a focused reasoning sub-agent. Return a concise, factual answer.',
      prompt
    );
  }

  async shutdown(): Promise<void> {
    await this.mediator.shutdown();
    this.bootPromise = null;
  }
}

export function buildCopilotAcpBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  model?: string
): CopilotAcpReasoningBackend {
  return new CopilotAcpReasoningBackend({
    model: model || env.KYBERION_COPILOT_MODEL,
  });
}
