/**
 * Reasoning Backend Contract — where LLM reasoning actually runs.
 *
 * Implements the contract layer of CONCEPT_INTEGRATION_BACKLOG P2-1.
 * Per the CLI harness coordination model, Kyberion owns the contract
 * (what to produce) but delegates the *reasoning* to the host CLI
 * (Claude Code, Codex, Gemini) or, in limited cases, an in-process LLM
 * client. This module exposes a small abstract surface so call sites
 * (decision-ops, compilers, workflows) never embed a specific reasoning
 * implementation.
 *
 * Default backend is `stub` — deterministic, offline, returns structured
 * placeholders and logs a warning. Real backends (e.g. a host-CLI
 * adapter that shells out to the containing Claude Code session) are
 * registered via `registerReasoningBackend`.
 */

import { logger } from './core.js';

export type PersonaLabel = string;

export interface DivergeHypothesisInput {
  topic: string;
  personas: PersonaLabel[];
  minPerPersona?: number;
  context?: Record<string, unknown>;
}

export interface HypothesisSketch {
  id: string;
  proposed_by: PersonaLabel;
  content: string;
  status?: 'pending' | 'survived' | 'rejected';
}

export interface CritiqueInput {
  topic: string;
  hypotheses: HypothesisSketch[];
  personas: PersonaLabel[];
}

export interface CritiqueResult {
  hypotheses: Array<HypothesisSketch & {
    survived: boolean;
    rejection_reason?: string;
    critiques?: Array<{ by: PersonaLabel; content: string }>;
  }>;
}

export interface PersonaSynthesisInput {
  relationshipNode: Record<string, unknown>;
  fidelity?: 'low' | 'medium' | 'high';
}

export interface SynthesizedPersona {
  fidelity: 'low' | 'medium' | 'high';
  identity: Record<string, unknown>;
  style_hints: Record<string, unknown>;
  ng_topics: string[];
  recent_history_summary: unknown[];
}

export interface BranchForkInput {
  hypotheses: HypothesisSketch[];
  executionProfile: string;
  costCapTokens: number;
  maxStepsPerBranch: number;
}

export interface ForkedBranch {
  branch_id: string;
  hypothesis_ref: string;
  worktree_path: string;
}

export interface SimulationInput {
  branches: ForkedBranch[];
  goal: string;
}

export interface SimulationResult {
  branches: Array<{
    branch_id: string;
    hypothesis_ref: string;
    first_failure_mode: string | null;
    first_success_mode: string | null;
    terminated_at_step: number | null;
  }>;
}

// ----- Requirements extraction (customer_engagement missions) -----

export type RequirementPriority = 'must' | 'should' | 'could' | 'wont';

export interface RequirementSourceRef {
  ref?: string;
  quote?: string;
  confidence?: number;
}

export interface FunctionalRequirement {
  id: string;
  description: string;
  priority: RequirementPriority;
  acceptance_criteria?: string[];
  source_refs?: RequirementSourceRef[];
  depends_on?: string[];
}

export interface NonFunctionalRequirement {
  id: string;
  category:
    | 'performance'
    | 'security'
    | 'availability'
    | 'usability'
    | 'compatibility'
    | 'maintainability'
    | 'compliance'
    | 'cost'
    | 'other';
  description: string;
  target?: string;
  priority?: RequirementPriority;
  source_refs?: RequirementSourceRef[];
}

export interface RequirementConstraint {
  category: 'budget' | 'timeline' | 'technical' | 'legal' | 'organizational' | 'other';
  description: string;
  source_refs?: RequirementSourceRef[];
}

export interface RequirementAssumption {
  description: string;
  confidence?: 'low' | 'medium' | 'high';
  source_refs?: RequirementSourceRef[];
}

export interface OpenQuestion {
  question: string;
  raised_by?: string;
  status?: 'open' | 'answered' | 'deferred';
  source_refs?: RequirementSourceRef[];
}

export interface ExtractRequirementsInput {
  /** Raw transcript / notes / document text from the elicitation source. */
  sourceText: string;
  /** Optional human-readable project name for labeling. */
  projectName?: string;
  /** Optional customer reference for the customer block. */
  customer?: { name?: string; person_slug?: string; org?: string };
  /** Optional prior-context — earlier requirements drafts to refine. */
  priorDraft?: unknown;
  /** Language of the source text (e.g. "ja", "en"). */
  language?: string;
}

export interface ExtractedRequirements {
  functional_requirements: FunctionalRequirement[];
  non_functional_requirements: NonFunctionalRequirement[];
  constraints: RequirementConstraint[];
  assumptions: RequirementAssumption[];
  open_questions: OpenQuestion[];
  scope?: {
    in_scope?: string[];
    out_of_scope?: string[];
  };
}

// ----- Design spec extraction -----

export interface DesignSpecComponent {
  id: string;
  name: string;
  responsibility: string;
  interfaces?: Array<{
    name: string;
    kind: 'rest' | 'grpc' | 'event' | 'function_call' | 'cli' | 'ui' | 'file' | 'other';
    description?: string;
    contract_ref?: string;
  }>;
  depends_on?: string[];
  technology_hints?: string[];
  requirements_refs?: string[];
}

export interface DesignSpecDataFlow {
  from: string;
  to: string;
  payload: string;
  protocol?: string;
  triggers?: string[];
}

export interface DesignSpecTradeOff {
  decision: string;
  options_considered?: string[];
  chosen: string;
  rationale: string;
}

export interface DesignSpecRisk {
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation?: string;
}

export interface DesignSpecOpenDecision {
  decision: string;
  options?: string[];
  current_lean?: string;
  blocking?: boolean;
}

export interface ExtractDesignSpecInput {
  requirementsDraft: unknown;
  projectName?: string;
  additionalContext?: string;
}

export interface ExtractedDesignSpec {
  architecture_summary?: string;
  components: DesignSpecComponent[];
  data_flows: DesignSpecDataFlow[];
  cross_cutting_concerns?: {
    security?: string;
    observability?: string;
    performance?: string;
    scaling?: string;
    deployment?: string;
    data_governance?: string;
  };
  trade_offs: DesignSpecTradeOff[];
  risks: DesignSpecRisk[];
  open_decisions: DesignSpecOpenDecision[];
}

// ----- Test plan extraction -----

export interface TestCase {
  case_id: string;
  title: string;
  objective: string;
  steps: string[];
  expected: string;
  priority?: 'must' | 'should' | 'could';
  type?: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'performance' | 'security';
  covers_requirements?: string[];
}

export interface ExtractTestPlanInput {
  requirementsDraft: unknown;
  designSpec?: unknown;
  projectName?: string;
  appId?: string;
}

export interface ExtractedTestPlan {
  app_id: string;
  cases: TestCase[];
  coverage_strategy?: string;
}

// ----- Task decomposition -----

export interface TaskPlanItem {
  task_id: string;
  title: string;
  summary: string;
  fulfills_requirements?: string[];
  design_refs?: string[];
  depends_on?: string[];
  inputs?: string[];
  deliverables?: string[];
  test_criteria?: string[];
  priority: 'must' | 'should' | 'could' | 'wont';
  estimate: 'XS' | 'S' | 'M' | 'L' | 'XL';
  assigned_role?:
    | 'implementer'
    | 'reviewer'
    | 'tester'
    | 'planner'
    | 'operator'
    | 'experience_designer'
    | 'product_strategist'
    | 'owner';
}

export interface DecomposeIntoTasksInput {
  requirementsDraft: unknown;
  designSpec?: unknown;
  projectName?: string;
}

export interface DecomposedTaskPlan {
  strategy_summary?: string;
  tasks: TaskPlanItem[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface GenerateWithToolsResult {
  text?: string;
  toolCalls?: ToolCall[];
}

export interface ReasoningBackend {
  name: string;
  /** Divergence — produce independent hypotheses per persona. */
  divergePersonas(input: DivergeHypothesisInput): Promise<HypothesisSketch[]>;
  /** Cross-critique — each persona critiques the others' hypotheses. */
  crossCritique(input: CritiqueInput): Promise<CritiqueResult>;
  /** Persona synthesis — derive a counterparty persona from a relationship node. */
  synthesizePersona(input: PersonaSynthesisInput): Promise<SynthesizedPersona>;
  /** Fork — propose N short-horizon branches from surviving hypotheses. */
  forkBranches(input: BranchForkInput): Promise<ForkedBranch[]>;
  /** Simulate — run short-horizon simulations of branches. */
  simulateBranches(input: SimulationInput): Promise<SimulationResult>;
  /** Extract structured requirements from raw elicitation-source text. */
  extractRequirements(input: ExtractRequirementsInput): Promise<ExtractedRequirements>;
  /** Derive an architectural design spec from a requirements draft. */
  extractDesignSpec(input: ExtractDesignSpecInput): Promise<ExtractedDesignSpec>;
  /** Derive a test plan (test-case-adf-compatible cases) from requirements + optional design. */
  extractTestPlan(input: ExtractTestPlanInput): Promise<ExtractedTestPlan>;
  /** Decompose requirements + design into an ordered implementation task plan. */
  decomposeIntoTasks(input: DecomposeIntoTasksInput): Promise<DecomposedTaskPlan>;
  /** Delegate a complex, multi-step task to an autonomous sub-agent. */
  delegateTask(instruction: string, context?: string): Promise<string>;
  /** Run a plain prompt against the active reasoning backend. */
  prompt(prompt: string): Promise<string>;
  /** (Optional) Execute a prompt with tool access (Function Calling / Tool Use). */
  generateWithTools?(prompt: string, tools: ToolDefinition[]): Promise<GenerateWithToolsResult>;
}

let registered: ReasoningBackend | null = null;

/** Register a real backend. Most deployments do this in a bootstrap module. */
export function registerReasoningBackend(backend: ReasoningBackend): void {
  registered = backend;
}

/** Get the active backend, falling back to the deterministic stub. */
export function getReasoningBackend(): ReasoningBackend {
  return registered ?? stubReasoningBackend;
}

/** Clear the registered backend. Used by tests. */
export function resetReasoningBackend(): void {
  registered = null;
}

function slugify(value: string): string {
  return value.replace(/\s+/gu, '_').slice(0, 48);
}

/** Deterministic, offline backend that emits structured placeholders. */
export const stubReasoningBackend: ReasoningBackend = {
  name: 'stub',

  async divergePersonas(input) {
    logger.warn(
      `[reasoning-backend:stub] divergePersonas — no real backend registered; topic="${input.topic}"`,
    );
    const min = Math.max(1, input.minPerPersona ?? 1);
    const out: HypothesisSketch[] = [];
    for (const persona of input.personas) {
      for (let i = 0; i < min; i++) {
        out.push({
          id: `H-${slugify(persona)}-${i + 1}`,
          proposed_by: persona,
          content: `[STUB] Hypothesis ${i + 1} from ${persona} on "${input.topic}"`,
          status: 'pending',
        });
      }
    }
    return out;
  },

  async crossCritique(input) {
    logger.warn('[reasoning-backend:stub] crossCritique — no real backend registered');
    const hypotheses = input.hypotheses.map((hypothesis, idx) => {
      const critics = input.personas.filter((p) => p !== hypothesis.proposed_by).slice(0, 1);
      const survived = idx % 2 === 0;
      return {
        ...hypothesis,
        survived,
        status: survived ? ('survived' as const) : ('rejected' as const),
        rejection_reason: survived ? undefined : '[STUB] not selected by critique pass',
        critiques: critics.map((p) => ({ by: p, content: `[STUB] critique by ${p}` })),
      };
    });
    return { hypotheses };
  },

  async synthesizePersona(input) {
    logger.warn('[reasoning-backend:stub] synthesizePersona — no real backend registered');
    const node = input.relationshipNode as {
      identity?: Record<string, unknown>;
      communication_style?: Record<string, unknown>;
      ng_topics?: string[];
      history?: unknown[];
    };
    return {
      fidelity: input.fidelity ?? 'high',
      identity: (node.identity ?? {}) as Record<string, unknown>,
      style_hints: node.communication_style ?? {},
      ng_topics: node.ng_topics ?? [],
      recent_history_summary: (node.history ?? []).slice(-3),
    };
  },

  async forkBranches(input) {
    logger.warn('[reasoning-backend:stub] forkBranches — no real backend registered');
    const surviving = input.hypotheses.filter((h) => h.status !== 'rejected');
    return surviving.map((h, i) => ({
      branch_id: String.fromCharCode(65 + i),
      hypothesis_ref: h.id,
      worktree_path: `counterfactual-branches/branch-${String.fromCharCode(65 + i)}/`,
    }));
  },

  async simulateBranches(input) {
    logger.warn('[reasoning-backend:stub] simulateBranches — no real backend registered');
    return {
      branches: input.branches.map((b) => ({
        branch_id: b.branch_id,
        hypothesis_ref: b.hypothesis_ref,
        first_failure_mode: null,
        first_success_mode: null,
        terminated_at_step: null,
      })),
    };
  },

  async extractRequirements(input) {
    logger.warn(
      '[reasoning-backend:stub] extractRequirements — no real backend registered; emitting a single placeholder requirement',
    );
    const head = input.sourceText.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const goalPreview = head.slice(0, 140);
    return {
      functional_requirements: [
        {
          id: 'FR-STUB1',
          description: goalPreview || '[STUB] Replace with extracted functional requirement',
          priority: 'should',
          acceptance_criteria: ['[STUB] Add acceptance criterion'],
        },
      ],
      non_functional_requirements: [],
      constraints: [],
      assumptions: [],
      open_questions: [
        {
          question:
            '[STUB] No real reasoning backend is registered — register AnthropicReasoningBackend or ClaudeAgentReasoningBackend and re-run.',
          status: 'open',
        },
      ],
    };
  },

  async extractDesignSpec(_input) {
    logger.warn('[reasoning-backend:stub] extractDesignSpec — no real backend registered');
    return {
      architecture_summary: '[STUB] Register a real backend to generate a real architecture summary.',
      components: [
        {
          id: 'COMP-STUB1',
          name: '[STUB] Core Component',
          responsibility: '[STUB] Replace with extracted responsibility',
        },
      ],
      data_flows: [],
      trade_offs: [],
      risks: [],
      open_decisions: [
        {
          decision: '[STUB] No real backend registered — cannot generate design',
          blocking: true,
        },
      ],
    };
  },

  async extractTestPlan(input) {
    logger.warn('[reasoning-backend:stub] extractTestPlan — no real backend registered');
    return {
      app_id: input.appId ?? 'stub-app',
      cases: [
        {
          case_id: 'TC-STUB1',
          title: '[STUB] Placeholder test case',
          objective: '[STUB] Register a real backend to generate test cases from requirements',
          steps: ['[STUB] Step 1'],
          expected: '[STUB] Expected outcome',
        },
      ],
    };
  },

  async decomposeIntoTasks(_input) {
    logger.warn('[reasoning-backend:stub] decomposeIntoTasks — no real backend registered');
    return {
      strategy_summary:
        '[STUB] No real backend registered. Register AnthropicReasoningBackend or ClaudeAgentReasoningBackend.',
      tasks: [
        {
          task_id: 'T-STUB-1',
          title: '[STUB] Placeholder task',
          summary: '[STUB] Replace with real decomposition',
          priority: 'should',
          estimate: 'M',
        },
      ],
    };
  },

  async delegateTask(instruction, context) {
    logger.warn(`[reasoning-backend:stub] delegateTask — no real backend registered; instruction="${instruction}"`);
    return `[STUB] Delegated task execution (stub). Context: ${context ?? 'none'}`;
  },

  async prompt(prompt) {
    logger.warn(`[reasoning-backend:stub] prompt — no real backend registered; prompt="${prompt.slice(0, 80)}"`);
    return `[STUB] ${prompt}`;
  },
};
