/** Public reasoning contracts shared by providers, failover, and orchestration callers. */

import * as path from 'node:path';
import { findMissionPath, pathResolver } from './path-resolver.js';
import { getReasoningPayloadScope } from './reasoning-egress-scope.js';
import type { NativeSubagentAdopter } from './native-subagent-adopter.js';
import type { DelegationHandle } from './delegated-task-observability.js';
import type {
  BackendCapabilityProfile,
  ConstrainedSampling,
} from './backend-capability-profile.js';

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
  hypotheses: Array<
    HypothesisSketch & {
      survived: boolean;
      rejection_reason?: string;
      critiques?: Array<{ by: PersonaLabel; content: string }>;
    }
  >;
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
  maxStepsPerBranch?: number;
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
  blocking?: boolean;
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
  /** PI-17: optional governed role visibility for deferred tool planning. */
  allowed_roles?: readonly string[];
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
  /** PI-17: provider-native deferred tools returned as references. */
  deferredToolReferences?: string[];
}

export interface ReasoningCallBudget {
  cost_cap_tokens?: number;
  max_prompt_chars?: number;
  max_response_chars?: number;
  max_combined_chars?: number;
  approval_required?: boolean;
}

/** DH-06: mission context required to audit a model-visible reasoning call. */
export interface ReasoningPromptVisibilityContext {
  missionPath: string;
  missionId: string;
  taskId?: string;
  contextPackId?: string;
  knowledgeRefs?: string[];
  source?: string;
  form?: string;
}

export interface ReasoningCallOptions {
  /** Governed role used to resolve a runtime/model profile. */
  role?: string;
  /** Optional resolved profile override; security constraints still apply. */
  profile?: string;
  /** Selected reasoning-route profile (distinct from provider permission profile). */
  route_profile?: string;
  /** Provider-neutral permission tier projected by the provider adapter. */
  capability_profile?: string;
  /** Governed provider permission mode selected by the reasoning route. */
  permission_mode?: 'readonly' | 'edit' | 'full';
  effort?: 'low' | 'medium' | 'high';
  budget?: ReasoningCallBudget;
  /**
   * Task-weight routing hint (from resolveTaskModelHint / cognitive routing):
   * backends map this to a concrete model according to their own provider
   * policy. Absent = backend default.
   */
  model_tier?: 'fast' | 'standard' | 'deep';
  /** Explicit provider model selected by governed task routing. */
  model?: string;
  /** Cancellation propagated by delegateTaskHandle to killable providers. */
  signal?: AbortSignal;
  /** Whether this call starts a fresh task context or continues the current one. */
  context_mode?: import('./context-boundary.js').AgentContextMode;
  /** DH-12: persist a child session that can be cold-resumed once. */
  continuable?: boolean;
  /** CE-11: this call is advice-only and must never produce a tool call. */
  advisory?: boolean;
  /** PI-17: role-visible tools to announce in the message tail, not the stable prefix. */
  deferred_tool_names?: string[];
  /** PI-17: governed definitions passed to a provider-native deferred-tool wire. */
  deferred_tool_definitions?: ToolDefinition[];
  /** DH-06: append a metadata-only visibility receipt before provider execution. */
  prompt_visibility?: ReasoningPromptVisibilityContext;
}

/**
 * Provider-native text deltas for latency-sensitive surfaces such as voice.
 *
 * This is intentionally optional: CLI providers may only expose a completed
 * response, in which case callers must fall back to `prompt()` and emit one
 * delta. Providers that support HTTP/SSE or an equivalent native stream can
 * yield deltas without changing the existing reasoning contract.
 */
export type ReasoningTextStream = AsyncIterable<string>;

export interface StructuredDelegationOptions {
  context?: string;
  maxRetries?: number;
  /** Optional native constrained-sampling request. Validation remains the fallback. */
  constrainedSampling?: ConstrainedSampling;
  /** Required when constrainedSampling is used; no profile means fail-closed for `require`. */
  capabilityProfile?: Pick<
    BackendCapabilityProfile['capabilities'],
    'supportsStrictTools' | 'supportsGrammarTools'
  >;
}

export interface BestOfDelegationOptions extends StructuredDelegationOptions {
  candidateCount?: number;
  judgeInstructions?: string;
}

export interface PeerAdviceInput {
  question: string;
  context?: string;
  tone?: 'concise' | 'careful' | 'adversarial';
  preferred_provider?: string;
  preferred_label?: string;
}

export interface PeerAdviceResult {
  advisor_label: string;
  advisor_provider?: string;
  recommendation: string;
  risks: string[];
  follow_up_questions: string[];
  confidence: 'low' | 'medium' | 'high';
  peer_used: boolean;
}

export interface ReasoningBackend {
  name: string;
  /** Optional provider-specific notes; never overrides Kyberion governance. */
  getRuntimeInstructions?(options?: ReasoningCallOptions): string[];
  /** Provider identity selected by a routing wrapper for runtime notes. */
  getRuntimeProviderName?(options?: ReasoningCallOptions): string;
  /** Divergence — produce independent hypotheses per persona. */
  divergePersonas(
    input: DivergeHypothesisInput,
    options?: ReasoningCallOptions
  ): Promise<HypothesisSketch[]>;
  /** Cross-critique — each persona critiques the others' hypotheses. */
  crossCritique(input: CritiqueInput, options?: ReasoningCallOptions): Promise<CritiqueResult>;
  /** Persona synthesis — derive a counterparty persona from a relationship node. */
  synthesizePersona(
    input: PersonaSynthesisInput,
    options?: ReasoningCallOptions
  ): Promise<SynthesizedPersona>;
  /** Fork — propose N short-horizon branches from surviving hypotheses. */
  forkBranches(input: BranchForkInput, options?: ReasoningCallOptions): Promise<ForkedBranch[]>;
  /** Simulate — run short-horizon simulations of branches. */
  simulateBranches(
    input: SimulationInput,
    options?: ReasoningCallOptions
  ): Promise<SimulationResult>;
  /** Extract structured requirements from raw elicitation-source text. */
  extractRequirements(
    input: ExtractRequirementsInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedRequirements>;
  /** Derive an architectural design spec from a requirements draft. */
  extractDesignSpec(
    input: ExtractDesignSpecInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedDesignSpec>;
  /** Derive a test plan (test-case-adf-compatible cases) from requirements + optional design. */
  extractTestPlan(
    input: ExtractTestPlanInput,
    options?: ReasoningCallOptions
  ): Promise<ExtractedTestPlan>;
  /** Decompose requirements + design into an ordered implementation task plan. */
  decomposeIntoTasks(
    input: DecomposeIntoTasksInput,
    options?: ReasoningCallOptions
  ): Promise<DecomposedTaskPlan>;
  /** Delegate a complex, multi-step task to an autonomous sub-agent. */
  delegateTask(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): Promise<string>;
  /**
   * QM-06: drop any provider-side session state. Called on both sides of a
   * failover switch so neither backend serves a later call with a stale
   * provider session. Optional — backends without session continuity omit it.
   */
  resetSession?(): Promise<void> | void;
  /** Optional adopter for a provider-native subagent surface. */
  getNativeSubagentAdopter?(): NativeSubagentAdopter | null;
  /** Whether this backend requires the native adopter when delegation is requested. */
  requiresNativeSubagent?(): boolean;
  /** Start an id-addressable delegation that can be joined or cancelled. */
  delegateTaskHandle?(
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ): DelegationHandle;
  /** Run a plain prompt against the active reasoning backend. */
  prompt(prompt: string, options?: ReasoningCallOptions): Promise<string>;
  /** Optional provider-native text stream; callers must support prompt fallback. */
  streamPrompt?(prompt: string, options?: ReasoningCallOptions): ReasoningTextStream;
  /** (Optional) Execute a prompt with tool access (Function Calling / Tool Use). */
  generateWithTools?(
    prompt: string,
    tools: ToolDefinition[],
    options?: ReasoningCallOptions
  ): Promise<GenerateWithToolsResult>;
  /**
   * (Optional) Run a prompt with images attached.
   *
   * Optional because most backends here are CLI bridges that take text on
   * stdin and have nowhere to put an image. Callers must check
   * `backendSupportsVision` and degrade explicitly — a caller that silently
   * falls back to a text prompt would be asking a model to describe pictures
   * it was never shown, and would get confident answers about nothing.
   */
  promptWithImages?(
    prompt: string,
    images: ReasoningImageAttachment[],
    options?: ReasoningCallOptions
  ): Promise<string>;
  /** Explicit capability override for adapters that expose an optional image path. */
  supportsVision?: boolean;
}

/** A local image file to attach to a reasoning call. */
export interface ReasoningImageAttachment {
  /** Absolute path to the image on this host. */
  path: string;
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

/** True when this backend can actually look at images. */
export function backendSupportsVision(
  backend: Pick<ReasoningBackend, 'promptWithImages' | 'supportsVision'>
): boolean {
  return backend.supportsVision !== false && typeof backend.promptWithImages === 'function';
}

/** Images larger than this are refused rather than silently truncated. */
export const MAX_REASONING_IMAGE_BYTES = 5 * 1024 * 1024;
/** More attachments than this in one call is almost always a mistake. */
export const MAX_REASONING_IMAGES = 20;
export const MAX_REASONING_IMAGE_BYTES_TOTAL = 20 * 1024 * 1024;

export function validateReasoningImageAttachmentPaths(
  images: readonly ReasoningImageAttachment[]
): void {
  const root = pathResolver.rootDir();
  const scope = getReasoningPayloadScope();
  for (const image of images) {
    const resolved = path.resolve(image.path);
    const relative = path.relative(root, resolved).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('[VISION_PATH_DENIED] image attachment must stay under the project root');
    }
    if (scope && scope.tier !== 'public') {
      const expected = `active/missions/${scope.tier}/`;
      const projectExpected = `active/projects/${scope.tier}/`;
      if (!relative.startsWith(expected) && !relative.startsWith(projectExpected)) {
        throw new Error(
          `[VISION_TIER_MISMATCH] ${scope.tier} image must remain in a tiered mission/project path`
        );
      }
    }
  }
}

export interface ReasoningBackendCandidate {
  backend: ReasoningBackend;
  provider?: string;
  label?: string;
}

export interface ReasoningFailoverPolicy {
  max_attempts: number;
  max_in_place_retries: number;
  on_unsupported_parameter?: 'reject' | 'warn-and-drop' | 'translate';
}
