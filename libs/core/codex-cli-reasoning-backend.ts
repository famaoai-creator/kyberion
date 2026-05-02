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

export interface CodexCliReasoningBackendOptions extends CodexCliQueryOptions {}

const SYSTEM_PROMPT = `You are a judgment-support reasoning engine for a CEO work-automation platform.

Your job: given a specific task (hypothesis divergence, cross-critique,
counterparty persona synthesis, branch forking, short-horizon simulation,
requirements extraction, design extraction, test-plan extraction, task
decomposition, or delegated work), produce high-quality structured output that
matches the supplied schema exactly.

Rules:
- Output JSON only.
- No markdown fences.
- No commentary outside the schema.
- Never invent concrete facts about real people or companies not present in the input.
- Preserve the user's language where the content is user-facing.`;

export class CodexCliReasoningBackend implements ReasoningBackend {
  readonly name = 'codex-cli';
  private readonly options: CodexCliQueryOptions;

  constructor(options: CodexCliReasoningBackendOptions = {}) {
    this.options = options;
  }

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    const minPer = Math.max(1, input.minPerPersona ?? 2);
    const schema = z.object({
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']).optional(),
        }),
      ),
    });
    const result = await runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Generate divergent hypotheses from multiple personas independently.',
        `Topic: ${input.topic}`,
        `Minimum hypotheses per persona: ${minPer}`,
        `Personas: ${input.personas.join(', ')}`,
      ].join('\n'),
      schema,
      options: this.options,
    }) as z.infer<typeof schema>;
    return result.hypotheses;
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    const schema = z.object({
      hypotheses: z.array(
        z.object({
          id: z.string(),
          proposed_by: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'survived', 'rejected']),
          survived: z.boolean(),
          rejection_reason: z.string().optional(),
          critiques: z.array(z.object({ by: z.string(), content: z.string() })).optional(),
        }),
      ),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Run a cross-critique pass over the hypotheses.',
        `Topic: ${input.topic}`,
        `Personas: ${input.personas.join(', ')}`,
        'Hypotheses:',
        JSON.stringify(input.hypotheses, null, 2),
      ].join('\n'),
      schema,
      options: this.options,
    }) as Promise<CritiqueResult>;
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    const schema = z.object({
      fidelity: z.enum(['low', 'medium', 'high']),
      identity: z.record(z.string(), z.any()),
      style_hints: z.record(z.string(), z.any()),
      ng_topics: z.array(z.string()),
      recent_history_summary: z.array(z.any()),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Synthesize a roleplay persona from the relationship node.',
        `Fidelity: ${input.fidelity ?? 'high'}`,
        JSON.stringify(input.relationshipNode, null, 2),
      ].join('\n'),
      schema,
      options: this.options,
    }) as Promise<SynthesizedPersona>;
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    const schema = z.object({
      branches: z.array(
        z.object({
          branch_id: z.string(),
          hypothesis_ref: z.string(),
          worktree_path: z.string(),
        }),
      ),
    });
    const result = await runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Fork short-horizon simulation branches from the hypotheses.',
        `Execution profile: ${input.executionProfile}`,
        `Cost cap: ${input.costCapTokens}`,
        `Max steps per branch: ${input.maxStepsPerBranch}`,
        JSON.stringify(input.hypotheses, null, 2),
      ].join('\n'),
      schema,
      options: this.options,
    }) as z.infer<typeof schema>;
    return result.branches;
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    const schema = z.object({
      branches: z.array(
        z.object({
          branch_id: z.string(),
          hypothesis_ref: z.string(),
          first_failure_mode: z.string().nullable(),
          first_success_mode: z.string().nullable(),
          terminated_at_step: z.number().nullable(),
        }),
      ),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Simulate the short-horizon execution of the branches.',
        `Goal: ${input.goal}`,
        JSON.stringify(input.branches, null, 2),
      ].join('\n'),
      schema,
      options: this.options,
    }) as Promise<SimulationResult>;
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    const schema = z.object({
      functional_requirements: z.array(z.any()),
      non_functional_requirements: z.array(z.any()).default([]),
      constraints: z.array(z.any()).default([]),
      assumptions: z.array(z.any()).default([]),
      open_questions: z.array(z.any()).default([]),
      scope: z
        .object({
          in_scope: z.array(z.string()).default([]),
          out_of_scope: z.array(z.string()).default([]),
        })
        .optional(),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Extract a structured requirements draft from the source text.',
        input.projectName ? `Project: ${input.projectName}` : '',
        input.language ? `Language: ${input.language}` : '',
        input.customer ? `Customer: ${JSON.stringify(input.customer)}` : '',
        input.priorDraft ? `Prior draft: ${JSON.stringify(input.priorDraft)}` : '',
        'Source text:',
        input.sourceText,
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
      options: this.options,
    }) as Promise<ExtractedRequirements>;
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    const schema = z.object({
      architecture_summary: z.string().optional(),
      components: z.array(z.any()),
      data_flows: z.array(z.any()).default([]),
      cross_cutting_concerns: z.record(z.string(), z.string()).optional(),
      trade_offs: z.array(z.any()).default([]),
      risks: z.array(z.any()).default([]),
      open_decisions: z.array(z.any()).default([]),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Derive an architectural design spec from the requirements draft.',
        input.projectName ? `Project: ${input.projectName}` : '',
        input.additionalContext ? `Additional context: ${input.additionalContext}` : '',
        JSON.stringify(input.requirementsDraft, null, 2),
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
      options: this.options,
    }) as Promise<ExtractedDesignSpec>;
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    const schema = z.object({
      app_id: z.string(),
      cases: z.array(z.any()),
      coverage_strategy: z.string().optional(),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Derive a structured test plan from the requirements draft and optional design spec.',
        input.projectName ? `Project: ${input.projectName}` : '',
        input.appId ? `App ID: ${input.appId}` : '',
        `Requirements draft: ${JSON.stringify(input.requirementsDraft, null, 2)}`,
        input.designSpec ? `Design spec: ${JSON.stringify(input.designSpec, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
      options: this.options,
    }) as Promise<ExtractedTestPlan>;
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const schema = z.object({
      strategy_summary: z.string().optional(),
      tasks: z.array(z.any()),
    });
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Decompose the work into an implementation task plan.',
        input.projectName ? `Project: ${input.projectName}` : '',
        `Requirements draft: ${JSON.stringify(input.requirementsDraft, null, 2)}`,
        input.designSpec ? `Design spec: ${JSON.stringify(input.designSpec, null, 2)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      schema,
      options: this.options,
    }) as Promise<DecomposedTaskPlan>;
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
