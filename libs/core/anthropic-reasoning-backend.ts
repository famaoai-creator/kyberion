/**
 * Anthropic Reasoning Backend — real implementation of ReasoningBackend
 * using @anthropic-ai/sdk with Opus 4.7, adaptive thinking, prompt caching,
 * and Zod-validated structured output via `messages.parse()`.
 *
 * Registered at bootstrap when ANTHROPIC_API_KEY is present; otherwise the
 * stub backend remains active. Aligns with the CLI-harness coordination
 * model: Kyberion owns the contract, the reasoning itself runs on Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
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
  GenerateWithToolsResult,
  ToolDefinition,
} from './reasoning-backend.js';

const DEFAULT_MODEL = 'claude-opus-4-7' as const;
const DEFAULT_MAX_TOKENS = 16000;

// Shared system prompt — kept byte-stable so the prompt cache hits across
// every call. All method-specific context goes in the user message.
const SYSTEM_PROMPT = `You are a judgment-support reasoning engine for a CEO work-automation platform.

Your job: given a specific task (hypothesis divergence, cross-critique,
counterparty persona synthesis, branch forking, or short-horizon simulation),
produce high-quality structured output that matches the provided schema
exactly. No prose outside the JSON. No markdown fences. No explanation.

Principles:
- Think carefully before answering. Adaptive thinking is available; use it.
- Hypotheses and critiques must be genuinely different, not paraphrases.
- Personas must reflect the relationship node verbatim where fields exist
  and infer conservatively where they don't.
- When asked to classify or judge, be willing to reject — a "rejected" verdict
  with a real reason is more valuable than shallow agreement.
- Never invent facts about specific people or companies. Use placeholders or
  generic language when concrete facts are not provided.`;

export interface AnthropicReasoningBackendOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
}

const HypothesisSketchSchema = z.object({
  id: z.string(),
  proposed_by: z.string(),
  content: z.string(),
  status: z.enum(['pending', 'survived', 'rejected']).optional(),
});

const CritiqueResultSchema = z.object({
  hypotheses: z.array(
    HypothesisSketchSchema.extend({
      survived: z.boolean(),
      rejection_reason: z.string().optional(),
      critiques: z
        .array(z.object({ by: z.string(), content: z.string() }))
        .optional(),
    }),
  ),
});

const SynthesizedPersonaSchema = z.object({
  fidelity: z.enum(['low', 'medium', 'high']),
  identity: z.record(z.string(), z.unknown()),
  style_hints: z.record(z.string(), z.unknown()),
  ng_topics: z.array(z.string()),
  recent_history_summary: z.array(z.unknown()),
});

const ForkedBranchSchema = z.object({
  branch_id: z.string(),
  hypothesis_ref: z.string(),
  worktree_path: z.string(),
});

const PrioritySchema = z.enum(['must', 'should', 'could', 'wont']);

const SourceRefSchema = z.object({
  ref: z.string().optional(),
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const FunctionalRequirementSchema = z.object({
  id: z.string().regex(/^FR-[0-9A-Z]+$/u),
  description: z.string().min(1),
  priority: PrioritySchema,
  acceptance_criteria: z.array(z.string()).optional(),
  source_refs: z.array(SourceRefSchema).optional(),
  depends_on: z.array(z.string()).optional(),
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
  target: z.string().optional(),
  priority: PrioritySchema.optional(),
  source_refs: z.array(SourceRefSchema).optional(),
});

const ConstraintSchema = z.object({
  category: z.enum(['budget', 'timeline', 'technical', 'legal', 'organizational', 'other']),
  description: z.string(),
  source_refs: z.array(SourceRefSchema).optional(),
});

const AssumptionSchema = z.object({
  description: z.string(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  source_refs: z.array(SourceRefSchema).optional(),
});

const OpenQuestionSchema = z.object({
  question: z.string(),
  raised_by: z.string().optional(),
  status: z.enum(['open', 'answered', 'deferred']).optional(),
  source_refs: z.array(SourceRefSchema).optional(),
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

// ----- Design spec schemas -----

const DesignSpecComponentSchema = z.object({
  id: z.string().regex(/^COMP-[0-9A-Z]+$/u),
  name: z.string().min(1),
  responsibility: z.string().min(1),
  interfaces: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['rest', 'grpc', 'event', 'function_call', 'cli', 'ui', 'file', 'other']),
        description: z.string().optional(),
        contract_ref: z.string().optional(),
      }),
    )
    .optional(),
  depends_on: z.array(z.string()).optional(),
  technology_hints: z.array(z.string()).optional(),
  requirements_refs: z.array(z.string()).optional(),
});

const DesignSpecDataFlowSchema = z.object({
  from: z.string(),
  to: z.string(),
  payload: z.string(),
  protocol: z.string().optional(),
  triggers: z.array(z.string()).optional(),
});

const ExtractedDesignSpecSchema = z.object({
  architecture_summary: z.string().optional(),
  components: z.array(DesignSpecComponentSchema).min(1),
  data_flows: z.array(DesignSpecDataFlowSchema).default([]),
  cross_cutting_concerns: z
    .object({
      security: z.string().optional(),
      observability: z.string().optional(),
      performance: z.string().optional(),
      scaling: z.string().optional(),
      deployment: z.string().optional(),
      data_governance: z.string().optional(),
    })
    .optional(),
  trade_offs: z
    .array(
      z.object({
        decision: z.string(),
        options_considered: z.array(z.string()).optional(),
        chosen: z.string(),
        rationale: z.string(),
      }),
    )
    .default([]),
  risks: z
    .array(
      z.object({
        description: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        mitigation: z.string().optional(),
      }),
    )
    .default([]),
  open_decisions: z
    .array(
      z.object({
        decision: z.string(),
        options: z.array(z.string()).optional(),
        current_lean: z.string().optional(),
        blocking: z.boolean().optional(),
      }),
    )
    .default([]),
});

// ----- Test plan schemas -----

const TestCaseSchema = z.object({
  case_id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  steps: z.array(z.string()).min(1),
  expected: z.string().min(1),
  priority: z.enum(['must', 'should', 'could']).optional(),
  type: z
    .enum(['unit', 'integration', 'e2e', 'acceptance', 'performance', 'security'])
    .optional(),
  covers_requirements: z.array(z.string()).optional(),
});

const ExtractedTestPlanSchema = z.object({
  app_id: z.string().min(1),
  cases: z.array(TestCaseSchema).min(1),
  coverage_strategy: z.string().optional(),
});

// ----- Task plan schemas -----

const TaskPlanItemSchema = z.object({
  task_id: z.string().regex(/^T-[0-9A-Z-]+$/u),
  title: z.string().min(1),
  summary: z.string().min(1),
  fulfills_requirements: z.array(z.string()).optional(),
  design_refs: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  deliverables: z.array(z.string()).optional(),
  test_criteria: z.array(z.string()).optional(),
  priority: PrioritySchema,
  estimate: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  assigned_role: z
    .enum([
      'implementer',
      'reviewer',
      'tester',
      'planner',
      'operator',
      'experience_designer',
      'product_strategist',
      'owner',
    ])
    .optional(),
});

const DecomposedTaskPlanSchema = z.object({
  strategy_summary: z.string().optional(),
  tasks: z.array(TaskPlanItemSchema).min(1),
});

// Claude structured-output JSON Schema has limited nullable support; we use
// optional fields and normalize missing values to null in the return path.
const SimulationResultSchema = z.object({
  branches: z.array(
    z.object({
      branch_id: z.string(),
      hypothesis_ref: z.string(),
      first_failure_mode: z.string().optional(),
      first_success_mode: z.string().optional(),
      terminated_at_step: z.number().optional(),
    }),
  ),
});

export class AnthropicReasoningBackend implements ReasoningBackend {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicReasoningBackendOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]> {
    const minPer = Math.max(1, input.minPerPersona ?? 2);
    const userPrompt = [
      `TASK: Generate at least ${minPer} hypotheses per persona on the topic.`,
      `Each persona must produce hypotheses that reflect their worldview,`,
      `not the other personas'. Hypotheses across personas should genuinely conflict`,
      `so later cross-critique is meaningful.`,
      ``,
      `TOPIC: ${input.topic}`,
      `PERSONAS: ${input.personas.join(', ')}`,
      input.context ? `CONTEXT: ${JSON.stringify(input.context)}` : '',
      ``,
      `Return: { "hypotheses": HypothesisSketch[] }`,
      `Each id must be "H-<persona_slug>-<n>".`,
      `Set status="pending" on every hypothesis.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: zodOutputFormat(z.object({ hypotheses: z.array(HypothesisSketchSchema) })),
      },
    });

    return result.parsed_output!.hypotheses.map((h) => ({
      ...h,
      status: h.status ?? 'pending',
    }));
  }

  async crossCritique(input: CritiqueInput): Promise<CritiqueResult> {
    const userPrompt = [
      `TASK: For each hypothesis, have every OTHER persona critique it.`,
      `After critiques, decide if the hypothesis survives the critique pass.`,
      `Be willing to reject — surviving roughly half is a reasonable outcome.`,
      ``,
      `TOPIC: ${input.topic}`,
      `PERSONAS: ${input.personas.join(', ')}`,
      `HYPOTHESES:`,
      JSON.stringify(input.hypotheses, null, 2),
      ``,
      `Return: CritiqueResult with each hypothesis carrying { survived, critiques[], rejection_reason? }.`,
      `status must be "survived" or "rejected" and match the survived boolean.`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(CritiqueResultSchema) },
    });

    return result.parsed_output!;
  }

  async synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona> {
    const fidelity = input.fidelity ?? 'high';
    const userPrompt = [
      `TASK: Synthesize a counterparty persona from the supplied relationship-graph node.`,
      `Preserve identity and communication_style fields verbatim where present.`,
      `Infer conservatively for missing fields.`,
      `Never invent facts about a specific person.`,
      ``,
      `FIDELITY: ${fidelity}`,
      `NODE:`,
      JSON.stringify(input.relationshipNode, null, 2),
      ``,
      `Return SynthesizedPersona with:`,
      `- fidelity = "${fidelity}"`,
      `- identity = the node's identity object (preserve fields)`,
      `- style_hints from node.communication_style (preserve)`,
      `- ng_topics from the node`,
      `- recent_history_summary = last 3 entries of node.history, most recent last`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(SynthesizedPersonaSchema) },
    });

    return result.parsed_output!;
  }

  async forkBranches(input: BranchForkInput): Promise<ForkedBranch[]> {
    const surviving = input.hypotheses.filter((h) => h.status !== 'rejected');
    const userPrompt = [
      `TASK: Propose short-horizon simulation branches, one per surviving hypothesis.`,
      `Each branch_id is a capital letter starting at "A".`,
      `worktree_path should follow "counterfactual-branches/branch-<id>/".`,
      ``,
      `EXECUTION PROFILE: ${input.executionProfile}`,
      `COST CAP (tokens): ${input.costCapTokens}`,
      `MAX STEPS PER BRANCH: ${input.maxStepsPerBranch}`,
      `SURVIVING HYPOTHESES:`,
      JSON.stringify(surviving, null, 2),
      ``,
      `Return { "branches": ForkedBranch[] }. Do not fork rejected hypotheses.`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: zodOutputFormat(z.object({ branches: z.array(ForkedBranchSchema) })),
      },
    });

    return result.parsed_output!.branches;
  }

  async simulateBranches(input: SimulationInput): Promise<SimulationResult> {
    const userPrompt = [
      `TASK: For each branch, run a short-horizon mental simulation against the goal.`,
      `Decide the first failure mode, the first success mode, and when termination occurs.`,
      `Either failure or success (not both) may be non-null per branch.`,
      `terminated_at_step is a small positive integer (step count) or null if unresolved.`,
      ``,
      `GOAL: ${input.goal}`,
      `BRANCHES:`,
      JSON.stringify(input.branches, null, 2),
      ``,
      `Return SimulationResult.`,
    ].join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(SimulationResultSchema) },
    });

    return {
      branches: result.parsed_output!.branches.map((b) => ({
        branch_id: b.branch_id,
        hypothesis_ref: b.hypothesis_ref,
        first_failure_mode: b.first_failure_mode ?? null,
        first_success_mode: b.first_success_mode ?? null,
        terminated_at_step: b.terminated_at_step ?? null,
      })),
    };
  }

  async extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements> {
    const userPrompt = [
      `TASK: Extract structured requirements from the elicitation source below.`,
      ``,
      `Rules:`,
      `- Every functional requirement needs an FR-<n> id and a MoSCoW priority (must/should/could/wont).`,
      `- Every must-have FR needs at least one acceptance_criterion.`,
      `- Every NFR needs an NFR-<n> id and a category.`,
      `- Quote the source verbatim (short excerpt) in source_refs when possible.`,
      `- Capture ambiguity as open_questions rather than inventing facts.`,
      `- Preserve the source language in description / acceptance_criteria.`,
      ``,
      input.projectName ? `PROJECT: ${input.projectName}` : '',
      input.customer ? `CUSTOMER: ${JSON.stringify(input.customer)}` : '',
      input.language ? `SOURCE LANGUAGE: ${input.language}` : '',
      input.priorDraft
        ? `PRIOR DRAFT (refine, don't restart):\n${JSON.stringify(input.priorDraft, null, 2)}`
        : '',
      ``,
      `ELICITATION SOURCE:`,
      input.sourceText,
      ``,
      `Return ExtractedRequirements.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(ExtractedRequirementsSchema) },
    });

    const parsed = result.parsed_output!;
    return {
      functional_requirements: parsed.functional_requirements,
      non_functional_requirements: parsed.non_functional_requirements,
      constraints: parsed.constraints,
      assumptions: parsed.assumptions,
      open_questions: parsed.open_questions,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    };
  }

  async extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec> {
    const userPrompt = [
      `TASK: Derive an architectural design spec from the requirements draft below.`,
      ``,
      `Rules:`,
      `- Every component needs a COMP-<n> id, concrete responsibility, and a list of FR/NFR ids it fulfills in requirements_refs.`,
      `- Every data_flow's from/to must reference a component id defined above.`,
      `- Record every material architectural decision as a trade_off with options_considered + chosen + rationale.`,
      `- Unresolved decisions go in open_decisions; mark blocking=true when downstream work cannot start without them.`,
      `- Be specific but honest — do not invent capabilities the requirements don't justify.`,
      ``,
      input.projectName ? `PROJECT: ${input.projectName}` : '',
      input.additionalContext ? `ADDITIONAL CONTEXT: ${input.additionalContext}` : '',
      ``,
      `REQUIREMENTS DRAFT:`,
      JSON.stringify(input.requirementsDraft, null, 2),
      ``,
      `Return ExtractedDesignSpec.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(ExtractedDesignSpecSchema) },
    });

    return result.parsed_output!;
  }

  async extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan> {
    const userPrompt = [
      `TASK: Derive a test plan from the requirements (and design spec if provided).`,
      ``,
      `Rules:`,
      `- Every must-have FR must have at least one case whose covers_requirements references it.`,
      `- case_id is a unique string (e.g. "TC-FR1-HAPPY").`,
      `- steps must be concrete, sequenced user/actor actions; expected is a single observable outcome.`,
      `- Mix test types (unit / integration / e2e / acceptance / performance / security) where justified.`,
      ``,
      input.projectName ? `PROJECT: ${input.projectName}` : '',
      input.appId ? `APP_ID: ${input.appId}` : '',
      ``,
      `REQUIREMENTS DRAFT:`,
      JSON.stringify(input.requirementsDraft, null, 2),
      input.designSpec ? `\nDESIGN SPEC:\n${JSON.stringify(input.designSpec, null, 2)}` : '',
      ``,
      `Return ExtractedTestPlan.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(ExtractedTestPlanSchema) },
    });

    const parsed = result.parsed_output!;
    return {
      app_id: parsed.app_id || input.appId || 'unnamed-app',
      cases: parsed.cases,
      ...(parsed.coverage_strategy ? { coverage_strategy: parsed.coverage_strategy } : {}),
    };
  }

  async decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan> {
    const userPrompt = [
      `TASK: Decompose the requirements (and design if provided) into an implementation task plan.`,
      ``,
      `Rules:`,
      `- Every task_id follows "T-<area>-<n>" (uppercase / dashes only, e.g. "T-FR1-IMPL", "T-SETUP-DB").`,
      `- Every task's priority mirrors the priority of the FR/NFR it fulfills when clear.`,
      `- depends_on must reference earlier task_ids; no cycles.`,
      `- test_criteria are short verifiable checks (leave empty if purely setup).`,
      `- Estimates use T-shirt sizing (XS..XL) with M as the default bucket for "normal feature".`,
      `- Include at least one reviewer task and one tester task if the work is non-trivial.`,
      ``,
      input.projectName ? `PROJECT: ${input.projectName}` : '',
      ``,
      `REQUIREMENTS DRAFT:`,
      JSON.stringify(input.requirementsDraft, null, 2),
      input.designSpec ? `\nDESIGN SPEC:\n${JSON.stringify(input.designSpec, null, 2)}` : '',
      ``,
      `Return DecomposedTaskPlan with strategy_summary (1-3 sentences) and ordered tasks.`,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(DecomposedTaskPlanSchema) },
    });

    return result.parsed_output!;
  }

  async delegateTask(instruction: string, context?: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [context ? `Context: ${context}\n\n` : '', `Task: ${instruction}`].join(''),
        },
      ],
    });
    const parts = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    return parts.map((b) => b.text).join('\n');
  }

  async prompt(prompt: string): Promise<string> {
    return this.delegateTask(prompt);
  }

  async generateWithTools(prompt: string, tools: ToolDefinition[]): Promise<GenerateWithToolsResult> {
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: 'user', content: prompt }],
      tools: anthropicTools,
    });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const text = textBlocks.map((b) => b.text).join('\n');

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

    return {
      ...(text ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
