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

const PrioritySchema = z.enum(['must', 'should', 'could', 'wont']);

const SourceRefSchema = z.object({
  ref: z.string().optional(),
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const OptionalArraySchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(itemSchema).optional(),
  );

const OptionalSchema = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

const FunctionalRequirementSchema = z.object({
  id: z.string().regex(/^FR-[0-9A-Z]+$/u),
  description: z.string().min(1),
  priority: PrioritySchema,
  acceptance_criteria: OptionalArraySchema(z.string()),
  source_refs: OptionalArraySchema(SourceRefSchema),
  depends_on: OptionalArraySchema(z.string()),
});

const NonFunctionalRequirementSchema = z.object({
  id: z.string().regex(/^NFR-[0-9A-Z]+$/u),
  category: z.enum([
    'performance',
    'security',
    'availability',
    'usability',
    'compatibility',
    'maintainability',
    'compliance',
    'cost',
    'other',
  ]),
  description: z.string().min(1),
  target: OptionalSchema(z.string()),
  priority: OptionalSchema(PrioritySchema),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const ConstraintSchema = z.object({
  category: z.enum(['budget', 'timeline', 'technical', 'legal', 'organizational', 'other']),
  description: z.string(),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const AssumptionSchema = z.object({
  description: z.string(),
  confidence: OptionalSchema(z.enum(['low', 'medium', 'high'])),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const OpenQuestionSchema = z.object({
  question: z.string(),
  raised_by: OptionalSchema(z.string()),
  status: OptionalSchema(z.enum(['open', 'answered', 'deferred'])),
  blocking: OptionalSchema(z.boolean()),
  source_refs: OptionalArraySchema(SourceRefSchema),
});

const ExtractedRequirementsSchema = z.object({
  functional_requirements: z.array(FunctionalRequirementSchema).min(1),
  non_functional_requirements: z.array(NonFunctionalRequirementSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  open_questions: z.array(OpenQuestionSchema).default([]),
  scope: z
    .object({
      in_scope: z.array(z.string()).default([]),
      out_of_scope: z.array(z.string()).default([]),
    })
    .optional(),
});

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
      mode: 'workspace-write',
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
            rejection_reason: OptionalSchema(z.string()),
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
      mode: 'workspace-write',
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
      mode: 'workspace-write',
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
      mode: 'workspace-write',
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
      mode: 'workspace-write',
      options: this.options,
    }) as Promise<SimulationResult>;
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    return runCodexCliQuery({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        'Extract a structured requirements draft from the source text.',
        'Use the source transcript to derive concrete requirements, but keep open_questions extremely sparse.',
        'Only emit open_questions when the answer is required to define the current MVP and cannot be inferred from the transcript.',
        'Questions about future phases, implementation preferences, vendor selection, or tuning details should become assumptions or deferred items, not open blockers.',
        'Prefer status="deferred" over status="open" whenever the core scope can proceed without the answer.',
        'When an open question is genuinely blocking the MVP, set blocking=true; otherwise leave it false or omit it.',
        'Do not convert the interviewer/Kyberion follow-up questions into open_questions unless the customer explicitly says the detail is unknown or blocking.',
        input.projectName ? `Project: ${input.projectName}` : '',
        input.language ? `Language: ${input.language}` : '',
        input.customer ? `Customer: ${JSON.stringify(input.customer)}` : '',
        input.priorDraft ? `Prior draft: ${JSON.stringify(input.priorDraft)}` : '',
        'Source text:',
        input.sourceText,
      ]
        .filter(Boolean)
        .join('\n'),
      schema: ExtractedRequirementsSchema,
      mode: 'workspace-write',
      options: this.options,
    }) as Promise<ExtractedRequirements>;
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    const schema = z.object({
      architecture_summary: OptionalSchema(z.string()),
      components: z.array(z.any()),
      data_flows: z.array(z.any()).default([]),
      cross_cutting_concerns: OptionalSchema(z.record(z.string(), z.string())),
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
      mode: 'workspace-write',
      options: this.options,
    }) as Promise<ExtractedDesignSpec>;
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    const schema = z.object({
      app_id: z.string(),
      cases: z.array(z.any()),
      coverage_strategy: OptionalSchema(z.string()),
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
      mode: 'workspace-write',
      options: this.options,
    }) as Promise<ExtractedTestPlan>;
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const schema = z.object({
      strategy_summary: OptionalSchema(z.string()),
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
      mode: 'workspace-write',
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
