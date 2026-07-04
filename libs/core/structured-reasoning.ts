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
  SimulationInput,
  SimulationResult,
  SynthesizedPersona,
} from './reasoning-backend.js';

/**
 * Canonical, backend-agnostic structured-reasoning specs.
 *
 * The `ReasoningBackend` structured ops (divergence, critique, persona synthesis,
 * fork/simulate, requirements/design/test-plan extraction, task decomposition) are
 * the same prompt + JSON-schema contract regardless of which model executes them.
 * This module owns that contract once so any text-returning backend (OpenAI-compatible
 * `local`, `openrouter`, …) can implement all nine ops by supplying only a
 * `complete(systemPrompt, userPrompt) => Promise<string>` function.
 *
 * (The CLI backends — codex/agy/claude — predate this module and still carry their own
 * equivalent definitions; consolidating them onto these specs is a safe follow-up.)
 */
export const STRUCTURED_REASONING_SYSTEM_PROMPT = `You are a judgment-support reasoning engine for a CEO work-automation platform.

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

// ── shared schema fragments ──────────────────────────────────────────────────
const PrioritySchema = z.enum(['must', 'should', 'could', 'wont']);

const SourceRefSchema = z.object({
  ref: z.string().optional(),
  quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const OptionalArraySchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), z.array(itemSchema).optional());

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

// ── op spec ──────────────────────────────────────────────────────────────────
export interface StructuredOpSpec<TInput, TOutput> {
  /** Stable op identifier (for error messages / logging). */
  readonly op: string;
  /** Build the user prompt for this op from its typed input. */
  buildUserPrompt(input: TInput): string;
  /** Zod schema the model output must satisfy. */
  readonly schema: z.ZodTypeAny;
  /** Project the validated JSON onto the op's return shape. */
  extract(parsed: any): TOutput;
}

const divergePersonasSpec: StructuredOpSpec<DivergeHypothesisInput, HypothesisSketch[]> = {
  op: 'divergePersonas',
  schema: z.object({
    hypotheses: z.array(
      z.object({
        id: z.string(),
        proposed_by: z.string(),
        content: z.string(),
        status: z.enum(['pending', 'survived', 'rejected']).optional(),
      })
    ),
  }),
  buildUserPrompt: (input) =>
    [
      'Generate divergent hypotheses from multiple personas independently.',
      `Topic: ${input.topic}`,
      `Minimum hypotheses per persona: ${Math.max(1, input.minPerPersona ?? 2)}`,
      `Personas: ${input.personas.join(', ')}`,
    ].join('\n'),
  extract: (parsed) => parsed.hypotheses,
};

const crossCritiqueSpec: StructuredOpSpec<CritiqueInput, CritiqueResult> = {
  op: 'crossCritique',
  schema: z.object({
    hypotheses: z.array(
      z.object({
        id: z.string(),
        proposed_by: z.string(),
        content: z.string(),
        status: z.enum(['pending', 'survived', 'rejected']),
        survived: z.boolean(),
        rejection_reason: OptionalSchema(z.string()),
        critiques: z.array(z.object({ by: z.string(), content: z.string() })).optional(),
      })
    ),
  }),
  buildUserPrompt: (input) =>
    [
      'Run a cross-critique pass over the hypotheses.',
      `Topic: ${input.topic}`,
      `Personas: ${input.personas.join(', ')}`,
      'Hypotheses:',
      JSON.stringify(input.hypotheses, null, 2),
    ].join('\n'),
  extract: (parsed) => parsed as CritiqueResult,
};

const synthesizePersonaSpec: StructuredOpSpec<PersonaSynthesisInput, SynthesizedPersona> = {
  op: 'synthesizePersona',
  schema: z.object({
    fidelity: z.enum(['low', 'medium', 'high']),
    identity: z.record(z.string(), z.any()),
    style_hints: z.record(z.string(), z.any()),
    ng_topics: z.array(z.string()),
    recent_history_summary: z.array(z.any()),
  }),
  buildUserPrompt: (input) =>
    [
      'Synthesize a roleplay persona from the relationship node.',
      `Fidelity: ${input.fidelity ?? 'high'}`,
      JSON.stringify(input.relationshipNode, null, 2),
    ].join('\n'),
  extract: (parsed) => parsed as SynthesizedPersona,
};

const forkBranchesSpec: StructuredOpSpec<BranchForkInput, ForkedBranch[]> = {
  op: 'forkBranches',
  schema: z.object({
    branches: z.array(
      z.object({
        branch_id: z.string(),
        hypothesis_ref: z.string(),
        worktree_path: z.string(),
      })
    ),
  }),
  buildUserPrompt: (input) =>
    [
      'Fork short-horizon simulation branches from the hypotheses.',
      `Execution profile: ${input.executionProfile}`,
      `Cost cap: ${input.costCapTokens}`,
      `Max steps per branch: ${input.maxStepsPerBranch}`,
      JSON.stringify(input.hypotheses, null, 2),
    ].join('\n'),
  extract: (parsed) => parsed.branches,
};

const simulateBranchesSpec: StructuredOpSpec<SimulationInput, SimulationResult> = {
  op: 'simulateBranches',
  schema: z.object({
    branches: z.array(
      z.object({
        branch_id: z.string(),
        hypothesis_ref: z.string(),
        first_failure_mode: z.string().nullable(),
        first_success_mode: z.string().nullable(),
        terminated_at_step: z.number().nullable(),
      })
    ),
  }),
  buildUserPrompt: (input) =>
    [
      'Simulate the short-horizon execution of the branches.',
      `Goal: ${input.goal}`,
      `Max steps per branch: ${input.maxStepsPerBranch ?? 10}`,
      JSON.stringify(input.branches, null, 2),
    ].join('\n'),
  extract: (parsed) => parsed as SimulationResult,
};

const extractRequirementsSpec: StructuredOpSpec<ExtractRequirementsInput, ExtractedRequirements> = {
  op: 'extractRequirements',
  schema: ExtractedRequirementsSchema,
  buildUserPrompt: (input) =>
    [
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
  extract: (parsed) => parsed as ExtractedRequirements,
};

const extractDesignSpecSpec: StructuredOpSpec<ExtractDesignSpecInput, ExtractedDesignSpec> = {
  op: 'extractDesignSpec',
  schema: z.object({
    architecture_summary: OptionalSchema(z.string()),
    components: z.array(z.any()),
    data_flows: z.array(z.any()).default([]),
    cross_cutting_concerns: OptionalSchema(z.record(z.string(), z.string())),
    trade_offs: z.array(z.any()).default([]),
    risks: z.array(z.any()).default([]),
    open_decisions: z.array(z.any()).default([]),
  }),
  buildUserPrompt: (input) =>
    [
      'Derive an architectural design spec from the requirements draft.',
      input.projectName ? `Project: ${input.projectName}` : '',
      input.additionalContext ? `Additional context: ${input.additionalContext}` : '',
      JSON.stringify(input.requirementsDraft, null, 2),
    ]
      .filter(Boolean)
      .join('\n'),
  extract: (parsed) => parsed as ExtractedDesignSpec,
};

const extractTestPlanSpec: StructuredOpSpec<ExtractTestPlanInput, ExtractedTestPlan> = {
  op: 'extractTestPlan',
  schema: z.object({
    app_id: z.string(),
    cases: z.array(z.any()),
    coverage_strategy: OptionalSchema(z.string()),
  }),
  buildUserPrompt: (input) =>
    [
      'Derive a structured test plan from the requirements draft and optional design spec.',
      input.projectName ? `Project: ${input.projectName}` : '',
      input.appId ? `App ID: ${input.appId}` : '',
      `Requirements draft: ${JSON.stringify(input.requirementsDraft, null, 2)}`,
      input.designSpec ? `Design spec: ${JSON.stringify(input.designSpec, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  extract: (parsed) => parsed as ExtractedTestPlan,
};

const decomposeIntoTasksSpec: StructuredOpSpec<DecomposeIntoTasksInput, DecomposedTaskPlan> = {
  op: 'decomposeIntoTasks',
  schema: z.object({
    strategy_summary: OptionalSchema(z.string()),
    tasks: z.array(z.any()),
  }),
  buildUserPrompt: (input) =>
    [
      'Decompose the work into an implementation task plan.',
      input.projectName ? `Project: ${input.projectName}` : '',
      `Requirements draft: ${JSON.stringify(input.requirementsDraft, null, 2)}`,
      input.designSpec ? `Design spec: ${JSON.stringify(input.designSpec, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  extract: (parsed) => parsed as DecomposedTaskPlan,
};

export const structuredReasoningSpecs = {
  divergePersonas: divergePersonasSpec,
  crossCritique: crossCritiqueSpec,
  synthesizePersona: synthesizePersonaSpec,
  forkBranches: forkBranchesSpec,
  simulateBranches: simulateBranchesSpec,
  extractRequirements: extractRequirementsSpec,
  extractDesignSpec: extractDesignSpecSpec,
  extractTestPlan: extractTestPlanSpec,
  decomposeIntoTasks: decomposeIntoTasksSpec,
} as const;

// ── JSON extraction (defensive against fences / surrounding prose) ────────────
function tryParse(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function sliceOutermostJson(text: string): string | undefined {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  if (firstObj === -1 && firstArr === -1) return undefined;
  const useObj = firstArr === -1 || (firstObj !== -1 && firstObj < firstArr);
  const start = useObj ? firstObj : firstArr;
  const end = text.lastIndexOf(useObj ? '}' : ']');
  if (end <= start) return undefined;
  return text.slice(start, end + 1);
}

/**
 * Parse a model's textual response into JSON, tolerating ```json fences and
 * surrounding prose that smaller/local models often emit despite instructions.
 */
export function parseStructuredJson(text: string, op: string): unknown {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error(`[structured-reasoning] empty response for op "${op}"`);

  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return direct;
    const sliced = sliceOutermostJson(candidate);
    if (sliced !== undefined) {
      const parsed = tryParse(sliced);
      if (parsed !== undefined) return parsed;
    }
  }

  throw new Error(
    `[structured-reasoning] failed to parse JSON for op "${op}": ${trimmed.slice(0, 300)}`
  );
}

/**
 * Execute one structured-reasoning op against a text-returning backend.
 * `complete` runs a single (toolless) completion and returns the raw model text.
 */
export async function runStructuredReasoningOp<TInput, TOutput>(
  spec: StructuredOpSpec<TInput, TOutput>,
  input: TInput,
  complete: (systemPrompt: string, userPrompt: string) => Promise<string>
): Promise<TOutput> {
  const raw = await complete(STRUCTURED_REASONING_SYSTEM_PROMPT, spec.buildUserPrompt(input));
  const json = parseStructuredJson(raw, spec.op);
  const result = spec.schema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `[structured-reasoning] schema validation failed for "${spec.op}": ${result.error.message}`
    );
  }
  return spec.extract(result.data);
}
