import AjvModule, { type ValidateFunction } from 'ajv';
import { logger } from './core.js';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { safeReadFile } from './secure-io.js';
import { isInjectionSuspected } from './untrusted-content.js';
import { classifyTaskSessionIntent } from './task-session.js';
import {
  buildOrganizationWorkLoopSummary,
  type OrganizationWorkLoopSummary,
} from './work-design.js';
import { discoverProviders, type ProviderInfo } from './provider-discovery.js';
import {
  resolveCapabilityBundleForIntent,
  summarizeRelevantCapabilityBundlesForIntentIds,
  summarizeRelevantCapabilityBundlesForIntentIdsCompact,
} from './capability-bundle-registry.js';
import {
  resolveExecutionProfileForIntent,
  summarizeRelevantExecutionProfilesForIntentIds,
  summarizeRelevantExecutionProfilesForIntentIdsCompact,
} from './intent-execution-profile-registry.js';
import { loadStandardIntentCatalog, resolveIntentResolutionPacket } from './intent-resolution.js';
import type { IntentResolutionPacket, StandardIntentDefinition } from './intent-resolution.js';
import {
  loadReasoningLevelPolicy,
  resolveReasoningLevelDecision,
  type ReasoningLevelDecision,
} from './reasoning-level-policy.js';
import {
  loadModelRegistry,
  resolveReasoningModelRoute,
  resolveTaskModelHint,
  resolveRuntimeModelId,
  type ModelRegistryFile,
  type ReasoningModelRoute,
} from './reasoning-model-routing.js';
import {
  buildIntentFlowCacheEligibility,
  lookupIntentFlowCache,
  storeIntentFlowCache,
} from './intent-flow-cache.js';
import {
  buildIntentUseCaseScenario,
  type IntentUseCaseScenario,
} from './intent-use-case-scenario.js';
import {
  buildFallbackExecutionBrief,
  normalizeExecutionBrief,
  type ExecutionBriefSeed,
} from './execution-brief.js';
import { resolveQuestionInteractionPacket } from './question-resolver.js';
import {
  normalizeExecutionShape,
  projectExecutionShapeToWorkflowShape,
  type ExecutionShape,
  type WorkflowExecutionShape,
} from './execution-shape.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';
import type { TraceContext } from './src/trace.js';
import type { ActuatorExecutionBrief } from './src/types/actuator-execution-brief.js';
import type { OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const INTENT_CONTRACT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/intent-contract.schema.json'
);
const WORK_LOOP_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-work-loop.schema.json'
);
const INTENT_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/intent-policy.schema.json'
);
const INTENT_POLICY_PATH = pathResolver.knowledge('product/governance/intent-policy.json');
const WORK_POLICY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/work-policy.schema.json');
const WORK_POLICY_PATH = pathResolver.knowledge('product/governance/work-policy.json');

export type IntentCompilerProvider = 'codex' | 'claude' | 'gemini';
export type IntentDeliveryMode = 'one_shot' | 'managed_program';

export interface IntentContract {
  kind: 'intent-contract';
  source_text: string;
  intent_id: string;
  correlation_id?: string;
  capability_bundle_id?: string;
  execution_profile_id?: string;
  goal: {
    summary: string;
    success_condition: string;
  };
  resolution: {
    execution_shape: WorkflowExecutionShape;
    task_type?: string;
  };
  required_inputs: string[];
  outcome_ids: string[];
  approval: {
    requires_approval: boolean;
  };
  delivery_mode: IntentDeliveryMode;
  clarification_needed: boolean;
  confidence: number;
  why: string;
}

export interface IntentDeliveryDecision {
  mode: IntentDeliveryMode;
  shouldBootstrapProject: boolean;
  shouldStartMission: boolean;
  shouldDeliverDirectOutcome: boolean;
  askHumanToConfirm: boolean;
  rationale: string;
}

export type AgentRoutingMode = 'prompt' | 'subagent' | 'coordination';
export type AgentRoutingScope =
  | 'single_artifact'
  | 'multi_artifact'
  | 'stateful_flow'
  | 'boundary_crossing';
export type AgentRoutingAutonomy = 'low' | 'medium' | 'high';
export type AgentRoutingFanout = 'none' | 'parallel' | 'review' | 'cross_critique';

export interface AgentRoutingDecision {
  kind: 'agent-routing-decision';
  source_text: string;
  intent_id: string;
  mode: AgentRoutingMode;
  scope: AgentRoutingScope;
  autonomy: AgentRoutingAutonomy;
  boundary_crossing: boolean;
  fanout: AgentRoutingFanout;
  owner: string;
  delegates?: string[];
  artifact_count: number;
  stop_condition: string;
  rationale: string;
}

export interface UserIntentFlow {
  executionBrief: ActuatorExecutionBrief;
  intentContract: IntentContract;
  workLoop: OrganizationWorkLoopSummary;
  useCaseScenario?: IntentUseCaseScenario;
  correlationId?: string;
  routingDecision?: AgentRoutingDecision;
  reasoningDecision: ReasoningLevelDecision;
  shadowModelRoute: ReasoningModelRoute;
  clarificationPacket?: OperatorInteractionPacket;
  source: 'llm' | 'fallback';
}

export interface CompileUserIntentFlowInput {
  text: string;
  correlationId?: string;
  channel?: string;
  locale?: string;
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantId?: string;
  tenantSlug?: string;
  serviceBindings?: string[];
  runtimeContext?: Record<string, unknown>;
  resolutionPacket?: IntentResolutionPacket;
}

interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

interface DeliveryModeRuleContext {
  text: string;
  shape: ExecutionShape;
  requiredInputs: string[];
}

interface DeliveryModeDecisionRule {
  mode: IntentDeliveryMode;
  shapes?: ExecutionShape[];
  text_patterns?: Array<TextMatchRule | string>;
  min_required_inputs?: number;
}

interface IntentPolicyFile {
  version: string;
  delivery: {
    rules: DeliveryModeDecisionRule[];
  };
  compiler: {
    relevant_intent_limit: number;
    intent_contract_rules: string[];
    work_loop_rules: string[];
  };
}

interface AgentRoutingPolicyRule {
  id?: string;
  match?: {
    intent_ids?: string[];
    task_types?: string[];
    query_types?: string[];
    shapes?: string[];
    catalog_shapes?: string[];
  };
  mode: AgentRoutingMode;
  scope?: AgentRoutingScope;
  autonomy?: AgentRoutingAutonomy;
  boundary_crossing?: boolean;
  fanout?: AgentRoutingFanout;
  owner: string;
  delegates?: string[];
  artifact_count?: number;
  stop_condition?: string;
  rationale?: string;
}

interface WorkPolicyFile {
  version: string;
  specialist_routing: unknown;
  profile_routing: unknown;
  design_rules: unknown;
  agent_routing?: {
    mode_rules: AgentRoutingPolicyRule[];
  };
}

interface LlmCompileOptions {
  askFn?: (prompt: string) => Promise<string>;
  provider?: IntentCompilerProvider;
  model?: string;
  modelProvider?: string;
  trace?: Pick<TraceContext, 'addEvent'>;
}

type CompilationFallbackReason =
  | 'simple_greeting'
  | 'execution_brief_invalid'
  | 'intent_contract_invalid'
  | 'work_loop_invalid'
  | 'backend_error'
  | 'none';

export interface IntentCompilerTarget {
  provider: IntentCompilerProvider;
  model?: string;
  modelProvider?: string;
}

interface IntentCompilerTargetResolutionOptions extends Pick<
  LlmCompileOptions,
  'provider' | 'model' | 'modelProvider'
> {
  selectedIntent?: StandardIntentDefinition;
  discoveredProviders?: ProviderInfo[];
  modelRegistry?: ModelRegistryFile;
}

let intentContractValidateFn: ValidateFunction | null = null;
let workLoopValidateFn: ValidateFunction | null = null;
let intentPolicyValidateFn: ValidateFunction | null = null;
let workPolicyValidateFn: ValidateFunction | null = null;

function ensureIntentContractValidator(): ValidateFunction {
  if (intentContractValidateFn) return intentContractValidateFn;
  intentContractValidateFn = compileSchemaFromPath(ajv, INTENT_CONTRACT_SCHEMA_PATH);
  return intentContractValidateFn;
}

function ensureWorkLoopValidator(): ValidateFunction {
  if (workLoopValidateFn) return workLoopValidateFn;
  workLoopValidateFn = compileSchemaFromPath(ajv, WORK_LOOP_SCHEMA_PATH);
  return workLoopValidateFn;
}

function ensureIntentPolicyValidator(): ValidateFunction {
  if (intentPolicyValidateFn) return intentPolicyValidateFn;
  intentPolicyValidateFn = compileSchemaFromPath(ajv, INTENT_POLICY_SCHEMA_PATH);
  return intentPolicyValidateFn;
}

function ensureWorkPolicyValidator(): ValidateFunction {
  if (workPolicyValidateFn) return workPolicyValidateFn;
  workPolicyValidateFn = compileSchemaFromPath(ajv, WORK_POLICY_SCHEMA_PATH);
  return workPolicyValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateIntentContract(value: unknown): ValidationResult<IntentContract> {
  const validate = ensureIntentContractValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as IntentContract) : undefined,
  };
}

function attachCapabilityBundle(contract: IntentContract): IntentContract {
  const bundle = resolveCapabilityBundleForIntent(contract.intent_id);
  if (!bundle) {
    const { capability_bundle_id: _ignored, ...rest } = contract;
    return rest;
  }
  return {
    ...contract,
    capability_bundle_id: bundle.bundle_id,
  };
}

function attachExecutionProfile(
  contract: IntentContract,
  input: CompileUserIntentFlowInput
): IntentContract {
  const intent = findStandardIntentById(contract.intent_id);
  const profileId = intent?.execution_profile_id;
  if (!profileId) {
    const { execution_profile_id: _ignored, ...rest } = contract;
    return rest;
  }

  const profile = resolveExecutionProfileForIntent(contract.intent_id, {
    surface: input.channel,
    runtime_context: input.runtimeContext,
  });

  if (!profile) {
    const { execution_profile_id: _ignored, ...rest } = contract;
    return rest;
  }

  return {
    ...contract,
    execution_profile_id: profile.profile_id,
    ...(contract.capability_bundle_id || !profile.capability_bundle_id
      ? {}
      : { capability_bundle_id: profile.capability_bundle_id }),
  };
}

function validateWorkLoop(value: unknown): ValidationResult<OrganizationWorkLoopSummary> {
  const validate = ensureWorkLoopValidator();
  const valid = validate(value);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : errorsFrom(validate),
    value: valid ? (value as OrganizationWorkLoopSummary) : undefined,
  };
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function parseJsonObject<T>(text: string): T | null {
  const json = extractJsonObject(text.trim());
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function providerToCompilerProvider(provider: string): IntentCompilerProvider | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'codex') return 'codex';
  if (normalized === 'anthropic' || normalized === 'claude') return 'claude';
  if (normalized === 'google' || normalized === 'gemini') return 'gemini';
  return null;
}

function stripModelProviderPrefix(modelId: string): string {
  const idx = modelId.indexOf(':');
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

function inferCompilerPhaseKind(
  intent?: StandardIntentDefinition
): 'plan' | 'implement' | 'review' | 'mechanical' {
  const haystack = [
    intent?.id,
    intent?.category,
    intent?.legacy_category,
    intent?.description,
    intent?.execution_shape,
    intent?.resolution?.shape,
    intent?.resolution?.task_kind,
    intent?.mission_class,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    intent?.risk_profile === 'approval_required' ||
    intent?.risk_profile === 'high_stakes' ||
    /\b(review|audit|analy|assess|compare|critique|verify|validate)\b/.test(haystack)
  ) {
    return 'review';
  }

  if (/\b(plan|design|strategy|architecture|roadmap|proposal)\b/.test(haystack)) {
    return 'plan';
  }

  if (
    intent?.execution_shape === 'direct_reply' ||
    intent?.resolution?.shape === 'direct_reply' ||
    /\b(reply|answer|greeting|clarify)\b/.test(haystack)
  ) {
    return 'mechanical';
  }

  if (intent?.execution_shape === 'task_session' || intent?.resolution?.shape === 'task_session') {
    return 'implement';
  }

  return 'mechanical';
}

function inferCompilerScope(intent?: StandardIntentDefinition): 'S' | 'M' | 'L' {
  if (
    intent?.risk_profile === 'approval_required' ||
    intent?.risk_profile === 'high_stakes' ||
    intent?.mission_class === 'long_running_job'
  ) {
    return 'L';
  }

  if (intent?.execution_shape === 'task_session' || intent?.resolution?.shape === 'task_session') {
    return 'M';
  }

  return 'S';
}

function resolveIntentAwareCompilerTarget(
  options: IntentCompilerTargetResolutionOptions
): IntentCompilerTarget | null {
  const intent = options.selectedIntent;
  if (!intent) return null;
  const discoveredProviders = options.discoveredProviders ?? discoverProviders();
  const availableProviders = new Set(
    discoveredProviders
      .filter((entry) => entry.installed && entry.healthy)
      .map((entry) => providerToCompilerProvider(entry.provider))
      .filter((provider): provider is IntentCompilerProvider => Boolean(provider))
  );
  if (availableProviders.size === 0) return null;

  const registry = options.modelRegistry ?? loadModelRegistry();
  const hintPhase = inferCompilerPhaseKind(intent);
  const hintScope = inferCompilerScope(intent);
  const taskHint = resolveTaskModelHint(
    {
      phase_kind: hintPhase,
      risk: intent.risk_profile,
      estimated_scope: hintScope,
    },
    { registry }
  );

  const candidate = registry.models.find((model) => model.model_id === taskHint.model_id);
  if (!candidate) return null;

  const compilerProvider = providerToCompilerProvider(candidate.provider);
  if (
    !compilerProvider ||
    !availableProviders.has(compilerProvider) ||
    candidate.status === 'blocked' ||
    candidate.status === 'deprecated'
  ) {
    return null;
  }

  return {
    provider: compilerProvider,
    model: stripModelProviderPrefix(candidate.model_id),
    modelProvider: candidate.provider,
  };
}

export function summarizeRelevantIntents(
  text: string,
  packet?: ReturnType<typeof resolveIntentResolutionPacket>
): { text: string; omitted_count: number } {
  const policy = loadIntentPolicy();
  const intents = loadStandardIntentCatalog();
  const resolvedPacket = packet || resolveIntentResolutionPacket(text);
  const catalogById = new Map(intents.map((intent) => [String(intent.id || ''), intent]));
  const scored = resolvedPacket.candidates
    .slice(0, policy.compiler.relevant_intent_limit)
    .map((candidate) => catalogById.get(candidate.intent_id))
    .filter((intent): intent is NonNullable<typeof intent> => Boolean(intent))
    .map((intent) => ({
      id: intent.id,
      description: intent.description,
      resolution: intent.resolution,
      outcome_ids: intent.outcome_ids,
      intake_requirements: intent.intake_requirements,
      plan_outline: intent.plan_outline,
      specialist_id: intent.specialist_id,
      trigger_keywords: intent.trigger_keywords,
    }));

  const omittedCount = Math.max(0, resolvedPacket.candidates.length - scored.length);
  if (omittedCount > 0) {
    logger.info(
      `[intent-contract] omitted ${omittedCount} relevant intent candidate(s) for input preview; limit=${policy.compiler.relevant_intent_limit}`
    );
  }

  return { text: JSON.stringify(scored, null, 2), omitted_count: omittedCount };
}

function summarizeRelevantCapabilityBundlesByIntentIds(intentIds: string[]): string {
  return summarizeRelevantCapabilityBundlesForIntentIdsCompact(intentIds);
}

function summarizeRelevantExecutionProfilesByIntentIds(
  intentIds: string[],
  input: CompileUserIntentFlowInput
): string {
  return summarizeRelevantExecutionProfilesForIntentIdsCompact(intentIds, {
    surface: input.channel,
    runtime_context: input.runtimeContext,
  });
}

function findStandardIntentById(intentId?: string): StandardIntentDefinition | undefined {
  if (!intentId) return undefined;
  return loadStandardIntentCatalog().find((intent) => intent.id === intentId);
}

function resolvePolicyRoutingDecision(
  contract: IntentContract,
  workLoop: OrganizationWorkLoopSummary
): AgentRoutingDecision | null {
  const policy = loadWorkPolicy();
  const intent = findStandardIntentById(contract.intent_id);
  const matched = (policy.agent_routing?.mode_rules || []).find((rule) =>
    ruleMatches(
      {
        intentId: contract.intent_id,
        taskType: contract.resolution.task_type,
        shape: contract.resolution.execution_shape,
        catalogShape: intent?.execution_shape,
      },
      rule.match
    )
  );

  if (!matched) return null;

  const delegates = matched.delegates?.filter((value) => value.trim().length > 0);
  return {
    kind: 'agent-routing-decision',
    source_text: contract.source_text,
    intent_id: contract.intent_id,
    mode: matched.mode,
    scope: matched.scope || 'single_artifact',
    autonomy: matched.autonomy || 'low',
    boundary_crossing: Boolean(matched.boundary_crossing),
    fanout: matched.fanout || 'none',
    owner: matched.owner,
    delegates: delegates && delegates.length > 0 ? delegates : undefined,
    artifact_count: Math.max(1, matched.artifact_count || contract.outcome_ids.length || 1),
    stop_condition:
      matched.stop_condition || 'The request has reached a governed completion state.',
    rationale:
      matched.rationale ||
      'The routing policy matched this intent and selected the corresponding execution shape.',
  };
}

function normalizeShape(shape?: string): ExecutionShape {
  return normalizeExecutionShape(shape);
}

function toWorkflowShape(shape?: string): WorkflowExecutionShape {
  return projectExecutionShapeToWorkflowShape(normalizeExecutionShape(shape));
}

function isApprovalWorkflowRequest(text: string): boolean {
  return /(承認を依頼|承認を申請|承認依頼|稟議.*依頼|稟議|決裁|承認して|承認し|承認待ち|approve|approved?|通して|処理して)/i.test(
    text
  );
}

function loadIntentPolicy(): IntentPolicyFile {
  const value = JSON.parse(
    safeReadFile(INTENT_POLICY_PATH, { encoding: 'utf8' }) as string
  ) as IntentPolicyFile;
  const validate = ensureIntentPolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid intent-policy: ${errors}`);
  }
  return value;
}

function loadWorkPolicy(): WorkPolicyFile {
  const value = JSON.parse(
    safeReadFile(WORK_POLICY_PATH, { encoding: 'utf8' }) as string
  ) as WorkPolicyFile;
  const validate = ensureWorkPolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid work-policy: ${errors}`);
  }
  return value;
}

function matchesRoutingValue(value: string | undefined, expected: string[] | undefined): boolean {
  if (!expected?.length) return true;
  if (!value) return false;
  return expected.includes(value);
}

function ruleMatches(
  input: {
    intentId?: string;
    taskType?: string;
    queryType?: string;
    shape?: string;
    catalogShape?: string;
  },
  match?: {
    intent_ids?: string[];
    task_types?: string[];
    query_types?: string[];
    shapes?: string[];
    catalog_shapes?: string[];
  }
): boolean {
  if (!match) return false;
  const wildcardMatches = (value: string | undefined, expected: string[] | undefined): boolean => {
    if (!expected?.length) return true;
    if (expected.includes('*')) return Boolean(value);
    return matchesRoutingValue(value, expected);
  };
  return (
    wildcardMatches(input.intentId, match.intent_ids) &&
    wildcardMatches(input.taskType, match.task_types) &&
    wildcardMatches(input.queryType, match.query_types) &&
    wildcardMatches(input.shape, match.shapes) &&
    wildcardMatches(input.catalogShape, match.catalog_shapes)
  );
}

function deliveryRuleMatches(
  context: DeliveryModeRuleContext,
  rule: DeliveryModeDecisionRule
): boolean {
  const shapeMatch = !rule.shapes?.length || rule.shapes.includes(context.shape);
  const minRequiredInputsMatch =
    rule.min_required_inputs === undefined ||
    context.requiredInputs.length >= rule.min_required_inputs;
  const textMatch =
    !rule.text_patterns?.length || matchesAnyTextRule(context.text, rule.text_patterns);
  return shapeMatch && minRequiredInputsMatch && textMatch;
}

export function inferGovernedDeliveryMode(
  text: string,
  shape: ExecutionShape,
  requiredInputs: string[]
): IntentDeliveryMode {
  const context: DeliveryModeRuleContext = { text, shape, requiredInputs };
  return (
    loadIntentPolicy().delivery.rules.find((rule) => deliveryRuleMatches(context, rule))?.mode ||
    'one_shot'
  );
}

function toExecutionBriefSeed(
  input: CompileUserIntentFlowInput,
  extras: Partial<ExecutionBriefSeed> = {}
): ExecutionBriefSeed {
  return {
    requestText: input.text,
    intentId: extras.intentId,
    goalSummary: extras.goalSummary,
    taskType: extras.taskType,
    executionShape: extras.executionShape,
    requiredInputs: extras.requiredInputs,
    outcomeIds: extras.outcomeIds,
    confidence: extras.confidence,
    tier: input.tier,
    locale: input.locale,
    projectName: input.projectName,
    trackName: input.trackName,
    serviceBindings: input.serviceBindings,
    summaryHint: extras.summaryHint,
  };
}

function resolveTenantId(input: CompileUserIntentFlowInput): string | undefined {
  const runtime = input.runtimeContext || {};
  const candidates = [
    input.tenantId,
    input.tenantSlug,
    typeof runtime.tenant_id === 'string' ? runtime.tenant_id : undefined,
    typeof runtime.tenantId === 'string' ? runtime.tenantId : undefined,
    typeof runtime.tenant_slug === 'string' ? runtime.tenant_slug : undefined,
    typeof runtime.tenantSlug === 'string' ? runtime.tenantSlug : undefined,
    process.env.KYBERION_TENANT,
    process.env.KYBERION_CUSTOMER,
  ];
  return candidates
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function resolveIntentPacketForInput(input: CompileUserIntentFlowInput): IntentResolutionPacket {
  return resolveIntentResolutionPacket(input.text, {
    tier: input.tier,
    tenantId: resolveTenantId(input),
  });
}

function resolveCorrelationId(input: CompileUserIntentFlowInput): string | undefined {
  const runtime = input.runtimeContext || {};
  const candidates = [
    input.correlationId,
    typeof runtime.correlation_id === 'string' ? runtime.correlation_id : undefined,
    typeof runtime.correlationId === 'string' ? runtime.correlationId : undefined,
  ];
  return candidates
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function buildFallbackIntentContract(
  input: CompileUserIntentFlowInput,
  executionBrief?: ActuatorExecutionBrief
): IntentContract {
  const packet = resolveIntentPacketForInput(input);
  const selectedPlatformId =
    typeof input.runtimeContext?.platform_id === 'string'
      ? input.runtimeContext.platform_id
      : packet.selected_parameters?.platform_id;
  const classified = classifyTaskSessionIntent(input.text);
  const selectedShape = normalizeShape(
    packet.selected_resolution?.shape || (executionBrief ? 'task_session' : 'direct_reply')
  );
  const contextualFrame = buildContextualIntentFrame(input.text);
  const correlationId = resolveCorrelationId(input);
  if (
    isApprovalWorkflowRequest(input.text) ||
    packet.selected_intent_id === 'resolve-approval' ||
    packet.selected_intent_id === 'request-approval'
  ) {
    const requiredInputs = [
      ...(executionBrief?.missing_inputs || ['approval_system', 'approval_scope']),
    ];
    const approvalSystem =
      executionBrief?.approval_system || packet.selected_parameters?.platform_id;
    const clarificationAssessment = assessContextualClarification({
      intentId: executionBrief?.archetype_id || packet.selected_intent_id || 'resolve-approval',
      text: input.text,
      executionShape: 'task_session',
      requiredInputs,
      confidence: executionBrief?.confidence,
      contextualFrame,
    });
    const effectiveRequiredInputs = clarificationAssessment.shouldClarify ? requiredInputs : [];
    const intentId =
      executionBrief?.archetype_id || packet.selected_intent_id || 'resolve-approval';
    return attachExecutionProfile(
      attachCapabilityBundle({
        kind: 'intent-contract',
        source_text: input.text,
        intent_id: intentId,
        ...(correlationId ? { correlation_id: correlationId } : {}),
        goal: {
          summary:
            executionBrief?.summary ||
            (approvalSystem ? `Process the approval queue in ${approvalSystem}` : undefined) ||
            'Process the approval queue and resolve the requested ringi item(s).',
          success_condition:
            'The target approval system and approval scope are identified and the requested approvals are handled safely.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'service_operation',
        },
        required_inputs: effectiveRequiredInputs,
        outcome_ids: executionBrief?.deliverables || ['approval_resolved'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: inferGovernedDeliveryMode(
          input.text,
          'task_session',
          effectiveRequiredInputs
        ),
        clarification_needed: clarificationAssessment.shouldClarify,
        confidence: executionBrief?.confidence || 0.3,
        why: clarificationAssessment.shouldClarify
          ? 'Fallback approval workflow request was normalized into the governed intent-contract schema.'
          : `Fallback approval workflow request was normalized into the governed intent-contract schema; clarification was skipped by policy (${clarificationAssessment.reason}).`,
      }),
      input
    );
  }
  if (classified) {
    const classifiedShape =
      classified.payload?.bootstrap_kind === 'project_bootstrap'
        ? 'project_bootstrap'
        : 'task_session';
    const shape = packet.selected_resolution?.shape ? selectedShape : classifiedShape;
    const normalizedShape = toWorkflowShape(shape);
    const requiredInputs = [
      ...(executionBrief?.missing_inputs || classified.requirements?.missing || []),
    ];
    if (packet.selected_intent_id === 'setup-messaging-bridge') {
      if (selectedPlatformId) {
        const platformIndex = requiredInputs.indexOf('platform_id');
        if (platformIndex >= 0) requiredInputs.splice(platformIndex, 1);
      } else if (!requiredInputs.includes('platform_id')) {
        requiredInputs.push('platform_id');
      }
    }
    const clarificationAssessment = assessContextualClarification({
      intentId: executionBrief?.archetype_id || classified.intentId || classified.taskType,
      text: input.text,
      executionShape: normalizedShape,
      requiredInputs,
      confidence: executionBrief?.confidence,
      contextualFrame,
    });
    const effectiveRequiredInputs = clarificationAssessment.shouldClarify ? requiredInputs : [];
    return attachExecutionProfile(
      attachCapabilityBundle({
        kind: 'intent-contract',
        source_text: input.text,
        intent_id: executionBrief?.archetype_id || classified.intentId || classified.taskType,
        ...(correlationId ? { correlation_id: correlationId } : {}),
        goal: {
          summary: executionBrief?.summary || classified.goal.summary,
          success_condition: classified.goal.success_condition,
        },
        resolution: {
          execution_shape: normalizedShape,
          task_type: executionBrief?.target_actuators?.includes('pptx-generator')
            ? 'presentation_deck'
            : classified.taskType,
        },
        required_inputs: effectiveRequiredInputs,
        outcome_ids: executionBrief?.deliverables || [],
        approval: {
          requires_approval: Boolean(classified.payload?.approval_required),
        },
        delivery_mode:
          normalizedShape === 'project_bootstrap'
            ? 'managed_program'
            : inferGovernedDeliveryMode(input.text, normalizedShape, effectiveRequiredInputs),
        clarification_needed: clarificationAssessment.shouldClarify,
        confidence: 0.55,
        why: executionBrief
          ? clarificationAssessment.shouldClarify
            ? 'Fallback classifier and execution brief were normalized into the governed intent-contract schema.'
            : `Fallback classifier and execution brief were normalized into the governed intent-contract schema; clarification was skipped by policy (${clarificationAssessment.reason}).`
          : 'Fallback classifier mapped the request to the nearest governed task session contract.',
      }),
      input
    );
  }

  const requiredInputs = (() => {
    const required = [...(executionBrief?.missing_inputs || ['goal_or_target'])];
    if (packet.selected_intent_id === 'setup-messaging-bridge') {
      if (selectedPlatformId) {
        return required.filter((item) => item !== 'platform_id');
      }
      if (!required.includes('platform_id')) {
        required.push('platform_id');
      }
    }
    return required;
  })();
  const clarificationAssessment = assessContextualClarification({
    intentId: executionBrief?.archetype_id || 'general_request',
    text: input.text,
    executionShape: toWorkflowShape(selectedShape),
    requiredInputs,
    confidence: executionBrief?.confidence,
    contextualFrame,
  });
  const effectiveRequiredInputs = clarificationAssessment.shouldClarify ? requiredInputs : [];
  const resolvedExecutionBrief =
    executionBrief ?? buildFallbackExecutionBrief(toExecutionBriefSeed(input));

  return attachExecutionProfile(
    attachCapabilityBundle({
      kind: 'intent-contract',
      source_text: input.text,
      intent_id: resolvedExecutionBrief.archetype_id || 'general_request',
      ...(correlationId ? { correlation_id: correlationId } : {}),
      goal: {
        summary: resolvedExecutionBrief.summary || 'Clarify and respond to the current request',
        success_condition:
          'The request is either clarified or answered without violating governance constraints.',
      },
      required_inputs: effectiveRequiredInputs,
      resolution: {
        execution_shape: toWorkflowShape(selectedShape),
        task_type: resolvedExecutionBrief.target_actuators?.includes('pptx-generator')
          ? 'presentation_deck'
          : undefined,
      },
      outcome_ids: resolvedExecutionBrief.deliverables || [],
      approval: {
        requires_approval: false,
      },
      delivery_mode: inferGovernedDeliveryMode(input.text, selectedShape, effectiveRequiredInputs),
      clarification_needed: clarificationAssessment.shouldClarify,
      confidence: 0.25,
      why: resolvedExecutionBrief
        ? clarificationAssessment.shouldClarify
          ? 'Fallback execution brief was normalized into the governed intent-contract schema.'
          : `Fallback execution brief was normalized into the governed intent-contract schema; clarification was skipped by policy (${clarificationAssessment.reason}).`
        : clarificationAssessment.shouldClarify
          ? 'Fallback could not derive a safe execution contract from the current request.'
          : `Fallback could not derive a safe execution contract from the current request, but clarification was skipped by policy (${clarificationAssessment.reason}).`,
    }),
    input
  );
}

function buildExecutionBriefPrompt(input: CompileUserIntentFlowInput): string {
  const packet = input.resolutionPacket || resolveIntentPacketForInput(input);
  return [
    'You are the Kyberion Execution Brief Compiler.',
    'First infer a shared guided-coordination brief, then derive a governed execution brief before any contract or work-loop compilation.',
    'Return JSON only. No markdown. No prose.',
    '',
    'Rules:',
    '- Prefer semantic structure over literal keyword matching.',
    '- Reuse the shared coordination brief concept before specializing into the execution brief.',
    '- Make missing inputs explicit.',
    '- Identify likely target actuators and deliverables.',
    '- Keep the brief human-readable and minimal.',
    '',
    'Relevant governed intents:',
    summarizeRelevantIntents(input.text, packet).text,
    '',
    'Request context:',
    JSON.stringify(
      {
        text: input.text,
        channel: input.channel,
        locale: input.locale,
        project_id: input.projectId,
        project_name: input.projectName,
        track_id: input.trackId,
        track_name: input.trackName,
        tier: input.tier || 'confidential',
        service_bindings: input.serviceBindings || [],
        runtime_context: input.runtimeContext || {},
      },
      null,
      2
    ),
    '',
    'Output schema:',
    JSON.stringify(
      {
        kind: 'actuator-execution-brief',
        request_text: 'string',
        archetype_id: 'string',
        confidence: 0.0,
        summary: 'string',
        user_facing_summary: 'string',
        normalized_scope: ['string'],
        target_actuators: ['string'],
        deliverables: ['string'],
        missing_inputs: ['string'],
        assumptions: ['string'],
        clarification_questions: [
          {
            id: 'string',
            question: 'string',
            reason: 'string',
            default_assumption: 'string',
            impact: 'string',
          },
        ],
        readiness: 'fully_automatable|needs_clarification|needs_external_asset|blocked_by_runtime',
        readiness_reason: 'string',
        llm_touchpoints: [
          {
            stage: 'string',
            purpose: 'string',
            output_contract: 'string',
          },
        ],
        recommended_next_step: 'string',
      },
      null,
      2
    ),
  ].join('\n');
}

function buildIntentContractPrompt(
  input: CompileUserIntentFlowInput,
  executionBrief: ActuatorExecutionBrief
): string {
  const policy = loadIntentPolicy();
  const packet = input.resolutionPacket || resolveIntentPacketForInput(input);
  const bundleIntentIds = packet.candidates.map((candidate) => candidate.intent_id);
  return [
    'You are the Kyberion Intent Contract Compiler.',
    'Convert the user request into a governed JSON contract.',
    'Use the execution brief as the source of truth for meaning, scope, and missing inputs.',
    'That execution brief is itself downstream of the shared guided-coordination brief.',
    'Return JSON only. No markdown. No prose.',
    '',
    'Rules:',
    ...policy.compiler.intent_contract_rules.map((rule) => `- ${rule}`),
    '- Preserve service binding references from the execution brief when present.',
    '- Prefer attaching a capability_bundle_id when the intent maps to a reusable governed bundle.',
    '',
    'Execution brief:',
    JSON.stringify(executionBrief, null, 2),
    '',
    'Runtime context hints:',
    JSON.stringify(input.runtimeContext || {}, null, 2),
    '',
    'Output schema:',
    JSON.stringify(
      {
        kind: 'intent-contract',
        source_text: 'string',
        intent_id: 'string',
        correlation_id: 'string?',
        capability_bundle_id: 'string?',
        execution_profile_id: 'string?',
        goal: { summary: 'string', success_condition: 'string' },
        resolution: {
          execution_shape: 'direct_reply|task_session|pipeline|mission|project_bootstrap',
          task_type: 'string?',
        },
        required_inputs: ['string'],
        outcome_ids: ['string'],
        approval: { requires_approval: true },
        delivery_mode: 'one_shot|managed_program',
        clarification_needed: true,
        confidence: 0.0,
        why: 'string',
      },
      null,
      2
    ),
    '',
    'Relevant governed intents:',
    summarizeRelevantIntents(input.text, packet).text,
    '',
    'Relevant capability bundles:',
    summarizeRelevantCapabilityBundlesByIntentIds(bundleIntentIds),
    '',
    'Relevant execution profiles:',
    summarizeRelevantExecutionProfilesByIntentIds(bundleIntentIds, input),
    '',
    'Relevant capability bundles (detailed registry snapshot):',
    summarizeRelevantCapabilityBundlesForIntentIds(bundleIntentIds),
    '',
    'Relevant execution profiles (detailed registry snapshot):',
    summarizeRelevantExecutionProfilesForIntentIds(bundleIntentIds, {
      surface: input.channel,
      runtime_context: input.runtimeContext,
    }),
    '',
    'Request context:',
    JSON.stringify(
      {
        text: input.text,
        channel: input.channel,
        locale: input.locale,
        project_id: input.projectId,
        project_name: input.projectName,
        track_id: input.trackId,
        track_name: input.trackName,
        tier: input.tier || 'confidential',
        service_bindings: input.serviceBindings || [],
      },
      null,
      2
    ),
  ].join('\n');
}

function buildWorkLoopPrompt(
  input: CompileUserIntentFlowInput,
  executionBrief: ActuatorExecutionBrief,
  contract: IntentContract
): string {
  const policy = loadIntentPolicy();
  const packet = input.resolutionPacket || resolveIntentPacketForInput(input);
  const bundleIntentIds = packet.candidates.map((candidate) => candidate.intent_id);
  return [
    'You are the Kyberion Work Loop Compiler.',
    'Produce a governed Organization Work Loop Summary JSON.',
    'Use the execution brief and intent contract as the source of truth.',
    'Return JSON only. No markdown. No prose.',
    '',
    'Rules:',
    ...policy.compiler.work_loop_rules.map((rule) => `- ${rule}`),
    '',
    'Execution brief:',
    JSON.stringify(executionBrief, null, 2),
    '',
    'Intent contract:',
    JSON.stringify(contract, null, 2),
    '',
    'Runtime context hints:',
    JSON.stringify(input.runtimeContext || {}, null, 2),
    '',
    'Relevant governed intents:',
    summarizeRelevantIntents(input.text, packet).text,
    '',
    'Relevant capability bundles:',
    summarizeRelevantCapabilityBundlesByIntentIds(bundleIntentIds),
    '',
    'Relevant capability bundles (detailed registry snapshot):',
    summarizeRelevantCapabilityBundlesForIntentIds(bundleIntentIds),
    '',
    'Output must match this structure:',
    'organization-work-loop.schema.json',
  ].join('\n');
}

async function defaultAsk(prompt: string): Promise<string> {
  return getReasoningBackend().prompt(prompt);
}

export function resolveIntentCompilerTarget(
  options: IntentCompilerTargetResolutionOptions = {}
): IntentCompilerTarget {
  const intentAware = resolveIntentAwareCompilerTarget(options);
  if (!options.provider && !options.model && !options.modelProvider && intentAware) {
    return intentAware;
  }

  const rawProvider = (
    options.provider ||
    process.env.KYBERION_INTENT_COMPILER_PROVIDER ||
    'codex'
  ).toLowerCase();
  const provider: IntentCompilerProvider =
    rawProvider === 'claude' || rawProvider === 'gemini' ? rawProvider : 'codex';
  const explicitModel = options.model || process.env.KYBERION_INTENT_COMPILER_MODEL;
  const explicitModelProvider =
    options.modelProvider || process.env.KYBERION_INTENT_COMPILER_MODEL_PROVIDER;

  if (provider === 'claude') {
    return {
      provider,
      model: explicitModel || process.env.KYBERION_CLAUDE_MODEL,
    };
  }

  if (provider === 'gemini') {
    return {
      provider,
      model: explicitModel || resolveRuntimeModelId('gemini-default'),
    };
  }

  return {
    provider: 'codex',
    model: explicitModel || process.env.KYBERION_CODEX_MODEL,
    modelProvider: explicitModelProvider || process.env.KYBERION_CODEX_MODEL_PROVIDER,
  };
}

async function compileExecutionBriefWithLlm(
  input: CompileUserIntentFlowInput,
  options: LlmCompileOptions = {}
): Promise<ActuatorExecutionBrief | null> {
  const ask = options.askFn || ((prompt: string) => defaultAsk(prompt));
  const raw = await ask(buildExecutionBriefPrompt(input));
  const parsed = parseJsonObject<ActuatorExecutionBrief>(raw);
  return parsed ? normalizeExecutionBrief(parsed, toExecutionBriefSeed(input)) : null;
}

async function compileIntentContractWithLlm(
  input: CompileUserIntentFlowInput,
  executionBrief: ActuatorExecutionBrief,
  options: LlmCompileOptions = {}
): Promise<IntentContract | null> {
  const ask = options.askFn || ((prompt: string) => defaultAsk(prompt));
  const raw = await ask(buildIntentContractPrompt(input, executionBrief));
  const parsed = parseJsonObject<IntentContract>(raw);
  if (!parsed) return null;
  const result = validateIntentContract(parsed);
  if (!result.valid) return null;
  return attachCorrelationId(
    attachExecutionProfile(attachCapabilityBundle(result.value!), input),
    input
  );
}

async function compileWorkLoopWithLlm(
  input: CompileUserIntentFlowInput,
  executionBrief: ActuatorExecutionBrief,
  contract: IntentContract,
  options: LlmCompileOptions = {}
): Promise<OrganizationWorkLoopSummary | null> {
  const ask = options.askFn || ((prompt: string) => defaultAsk(prompt));
  const raw = await ask(buildWorkLoopPrompt(input, executionBrief, contract));
  const parsed = parseJsonObject<OrganizationWorkLoopSummary>(raw);
  if (!parsed) return null;
  const result = validateWorkLoop(parsed);
  return result.valid ? result.value! : null;
}

function buildFallbackWorkLoop(
  input: CompileUserIntentFlowInput,
  contract: IntentContract
): OrganizationWorkLoopSummary {
  return buildOrganizationWorkLoopSummary({
    intentId: contract.intent_id,
    taskType: contract.resolution.task_type,
    shape: contract.resolution.execution_shape,
    utterance: input.text,
    outcomeIds: contract.outcome_ids,
    tier: input.tier,
    projectId: input.projectId,
    projectName: input.projectName,
    trackId: input.trackId,
    trackName: input.trackName,
    locale: input.locale,
    serviceBindings: input.serviceBindings,
    requiresApproval: contract.approval.requires_approval,
  });
}

function buildClarificationPacket(
  contract: IntentContract,
  workLoop: OrganizationWorkLoopSummary,
  executionBrief?: ActuatorExecutionBrief,
  locale?: string
): OperatorInteractionPacket | undefined {
  if (!contract.clarification_needed) return undefined;
  return resolveQuestionInteractionPacket(
    {
      text: contract.source_text,
      intentId: contract.intent_id,
      executionShape: contract.resolution.execution_shape as any,
      locale,
      requiredInputs: contract.required_inputs,
      confidence: contract.confidence,
      executionBrief,
    },
    'More context is required before execution',
    contract.goal.summary
  );
}

function attachCorrelationId(
  contract: IntentContract,
  input: CompileUserIntentFlowInput
): IntentContract {
  const correlationId = resolveCorrelationId(input);
  if (!correlationId) return contract;
  return {
    ...contract,
    correlation_id: contract.correlation_id || correlationId,
  };
}

export function formatClarificationPacket(packet: OperatorInteractionPacket): string {
  const briefSummary =
    typeof (packet as any).execution_brief_summary === 'string' &&
    (packet as any).execution_brief_summary.trim().length > 0
      ? (packet as any).execution_brief_summary
      : undefined;
  const lines: string[] = [];
  if (isInjectionSuspected()) {
    lines.push(
      '⚠️ 外部コンテンツにインジェクションの疑い (Injection suspected in external content)',
      ''
    );
  }
  lines.push(packet.headline, packet.summary);
  if (briefSummary) {
    lines.push('', `Brief: ${briefSummary}`);
  }
  lines.push('', 'Required inputs:');
  for (const question of packet.questions || []) {
    lines.push(`- ${question.id}: ${question.question}`);
  }
  return lines.join('\n');
}

export interface ClarificationFormatOptions {
  /** When true, show only the first blocking question instead of the full list. Default: false */
  concise?: boolean;
  /** Output locale. 'ja' produces Japanese-phrased output. Default: 'en' */
  locale?: 'en' | 'ja';
}

/**
 * Concise clarification formatter — surfaces the single next required input
 * rather than the full question list.  Use for CLI and surface contexts where
 * brevity is more important than completeness.
 */
export function formatClarificationPacketConcise(
  packet: OperatorInteractionPacket,
  options: ClarificationFormatOptions = {}
): string {
  const locale = options.locale ?? 'en';
  const questions = packet.questions ?? [];
  const first = questions[0];
  const remaining = questions.length - 1;

  let warning = '';
  if (isInjectionSuspected()) {
    warning =
      '⚠️ 外部コンテンツにインジェクションの疑い (Injection suspected in external content)\n';
  }

  if (!first) {
    return (
      warning +
      (locale === 'ja'
        ? '不足している情報はありません。実行を進められます。'
        : 'No missing inputs. Ready to proceed.')
    );
  }

  if (locale === 'ja') {
    const moreHint = remaining > 0 ? `（他 ${remaining} 件）` : '';
    const lines = [`次に必要な情報${moreHint}: \`${first.id}\``, first.question];
    if (first.reason) lines.push(`理由: ${first.reason}`);
    if (first.default_assumption) lines.push(`デフォルト: ${first.default_assumption}`);
    return warning + lines.join('\n');
  }

  const moreHint = remaining > 0 ? ` (+ ${remaining} more)` : '';
  const lines = [`Next required${moreHint}: \`${first.id}\``, first.question];
  if (first.reason) lines.push(`Reason: ${first.reason}`);
  if (first.default_assumption) lines.push(`Default: ${first.default_assumption}`);
  return warning + lines.join('\n');
}

export function deriveIntentDeliveryDecision(contract: IntentContract): IntentDeliveryDecision {
  const durableShape =
    contract.resolution.execution_shape === 'project_bootstrap' ||
    contract.resolution.execution_shape === 'mission';
  const managedProgram = contract.delivery_mode === 'managed_program';
  const askHumanToConfirm =
    managedProgram &&
    contract.resolution.execution_shape === 'task_session' &&
    !contract.clarification_needed;

  const decisionRules: Array<{
    when: () => boolean;
    rationale: string;
    decision: Omit<IntentDeliveryDecision, 'mode' | 'rationale'>;
  }> = [
    {
      when: () => askHumanToConfirm,
      rationale:
        'The request implies durable program management, but the current execution shape still needs a human confirmation before bootstrap.',
      decision: {
        shouldBootstrapProject: true,
        shouldStartMission: true,
        shouldDeliverDirectOutcome: false,
        askHumanToConfirm: true,
      },
    },
    {
      when: () => managedProgram,
      rationale:
        'The request appears to require durable governance across revisions, work items, or staged outcomes.',
      decision: {
        shouldBootstrapProject: contract.resolution.execution_shape === 'project_bootstrap',
        shouldStartMission: true,
        shouldDeliverDirectOutcome: false,
        askHumanToConfirm: false,
      },
    },
    {
      when: () => true,
      rationale:
        'The request appears satisfiable as a single direct outcome without durable project scaffolding.',
      decision: {
        shouldBootstrapProject: false,
        shouldStartMission: false,
        shouldDeliverDirectOutcome: !durableShape,
        askHumanToConfirm: false,
      },
    },
  ];

  const matchedRule = decisionRules.find((rule) => rule.when())!;

  return {
    mode: contract.delivery_mode,
    ...matchedRule.decision,
    rationale: matchedRule.rationale,
  };
}

export function deriveAgentRoutingDecision(
  contract: IntentContract,
  workLoop: OrganizationWorkLoopSummary,
  sourceText = contract.source_text
): AgentRoutingDecision {
  const policyDecision = resolvePolicyRoutingDecision(contract, workLoop);
  if (policyDecision) return policyDecision;

  const intent = findStandardIntentById(contract.intent_id);
  const managedProgram = contract.delivery_mode === 'managed_program';
  const durableShape =
    contract.resolution.execution_shape === 'project_bootstrap' ||
    contract.resolution.execution_shape === 'mission';
  const boundaryCrossing =
    managedProgram ||
    durableShape ||
    workLoop.runtime_design.coordination.bus === 'mission_coordination_bus' ||
    workLoop.runtime_design.memory.store === 'mission_working_memory';
  const browserSession = intent?.execution_shape === 'browser_session';
  const lowRiskSimpleIntent =
    intent?.risk_profile === 'low' &&
    contract.outcome_ids.length <= 1 &&
    contract.required_inputs.length <= 1;
  const reviewHeavy =
    workLoop.review_design.review_mode !== 'lean' ||
    contract.required_inputs.length >= 2 ||
    contract.outcome_ids.length > 1 ||
    (intent?.plan_outline?.length || 0) >= 3 ||
    intent?.risk_profile === 'review_required';

  const mode: AgentRoutingMode = boundaryCrossing
    ? 'coordination'
    : browserSession && lowRiskSimpleIntent
      ? 'prompt'
      : reviewHeavy
        ? 'subagent'
        : 'prompt';

  const scope: AgentRoutingScope = boundaryCrossing
    ? 'boundary_crossing'
    : mode === 'coordination'
      ? 'stateful_flow'
      : contract.outcome_ids.length > 1
        ? 'multi_artifact'
        : 'single_artifact';

  const autonomy: AgentRoutingAutonomy =
    mode === 'prompt' ? 'low' : mode === 'subagent' ? (reviewHeavy ? 'high' : 'medium') : 'high';

  const fanout: AgentRoutingFanout =
    mode === 'coordination'
      ? 'parallel'
      : contract.outcome_ids.length > 1
        ? 'parallel'
        : browserSession && lowRiskSimpleIntent
          ? 'none'
          : workLoop.review_design.review_mode === 'strict'
            ? 'cross_critique'
            : reviewHeavy
              ? 'review'
              : 'none';

  const owner =
    workLoop.teaming.specialist_id ||
    intent?.specialist_id ||
    workLoop.teaming.conversation_agent ||
    'intent-owner';
  const delegates = [
    workLoop.teaming.conversation_agent,
    managedProgram ? 'mission-controller' : undefined,
  ].filter((value): value is string => Boolean(value) && value !== owner);

  const artifactCount = Math.max(contract.outcome_ids.length, mode === 'coordination' ? 1 : 1);

  const stopCondition =
    mode === 'coordination'
      ? 'The governed orchestration has a durable owner, state transition, and completion checkpoint.'
      : mode === 'subagent'
        ? 'The child worker has produced a bounded result and the owner has accepted it.'
        : 'The response is ready as a single governed reply or artifact.';

  const rationale =
    mode === 'coordination'
      ? 'The request crosses a durable governance boundary and should be managed as coordinated work.'
      : mode === 'subagent'
        ? 'The request is bounded but review-heavy enough to benefit from a child worker.'
        : 'The request can finish as a single prompt without autonomous decomposition.';

  return {
    kind: 'agent-routing-decision',
    source_text: sourceText,
    intent_id: contract.intent_id,
    mode,
    scope,
    autonomy,
    boundary_crossing: boundaryCrossing,
    fanout,
    owner,
    delegates: delegates.length > 0 ? delegates : undefined,
    artifact_count: artifactCount,
    stop_condition: stopCondition,
    rationale,
  };
}

const SIMPLE_GREETING_REGEX =
  /^(こんにちは|おはよう|こんばんは|ありがとう|さようなら|バイバイ|お疲れ様|おつかれ|hello|hi|thanks|thank you|bye)[！!！？?]?$/i;

function emitIntentCompilationCompletedEvent(
  trace: Pick<TraceContext, 'addEvent'> | undefined,
  input: {
    reasoningDecision: ReasoningLevelDecision;
    shadowModelRoute: ReasoningModelRoute;
    source: 'llm' | 'fallback';
    cacheStatus: 'disabled' | 'miss' | 'hit' | 'invalid' | 'write';
    selectedIntentId?: string;
    selectedConfidence?: number;
    compilerProvider: string;
    compilerModel: string;
    fallbackReason: CompilationFallbackReason;
    reasoningPolicyVersion: string;
    selectedResolutionShape?: string;
    contractExecutionShape?: string;
  }
): void {
  const shapeDisagreement =
    Boolean(input.selectedResolutionShape) &&
    Boolean(input.contractExecutionShape) &&
    input.selectedResolutionShape !== input.contractExecutionShape;
  trace?.addEvent('intent_compilation.completed', {
    reasoning_level: input.reasoningDecision.level,
    reasoning_rule_id: input.reasoningDecision.rule_id,
    source: input.source,
    selected_intent_id: input.selectedIntentId || '',
    selected_confidence: input.selectedConfidence ?? 0,
    compiler_provider: input.compilerProvider,
    compiler_model: input.compilerModel,
    recommended_model_id: input.shadowModelRoute.recommended_model_id || '',
    model_route_status: input.shadowModelRoute.model_route_status,
    cache_status: input.cacheStatus,
    fallback_reason: input.fallbackReason,
    reasoning_policy_version: input.reasoningPolicyVersion,
    shape_disagreement: shapeDisagreement,
    selected_resolution_shape: input.selectedResolutionShape || '',
    contract_execution_shape: input.contractExecutionShape || '',
  });
}

export async function compileUserIntentFlow(
  input: CompileUserIntentFlowInput,
  options: LlmCompileOptions = {}
): Promise<UserIntentFlow> {
  const resolutionPacket = input.resolutionPacket || resolveIntentPacketForInput(input);
  const resolvedInput = {
    ...input,
    resolutionPacket,
  };
  const reasoningPolicy = loadReasoningLevelPolicy();
  const selectedIntent = resolutionPacket.selected_intent_id
    ? findStandardIntentById(resolutionPacket.selected_intent_id)
    : undefined;
  const compilerTarget = resolveIntentCompilerTarget({
    provider: options.provider,
    model: options.model,
    modelProvider: options.modelProvider,
    selectedIntent,
  });
  const reasoningDecision = resolveReasoningLevelDecision(
    {
      isSimpleGreeting: SIMPLE_GREETING_REGEX.test(input.text.trim()),
      resolutionPacket,
      selectedIntent,
    },
    reasoningPolicy
  );
  const shadowModelRoute = resolveReasoningModelRoute(reasoningDecision, {
    policy: reasoningPolicy,
  });
  const cacheEligibility = buildIntentFlowCacheEligibility({
    text: input.text,
    locale: input.locale,
    tier: input.tier,
    channel: input.channel,
    serviceBindings: input.serviceBindings,
    runtimeContext: input.runtimeContext,
    resolutionPacket,
    selectedIntent,
    reasoningDecision,
    shadowModelRoute,
  });
  const cacheLookup = lookupIntentFlowCache({
    eligibility: cacheEligibility,
    inputText: input.text,
  });
  if (cacheLookup.status === 'hit' && cacheLookup.cachedFlow) {
    emitIntentCompilationCompletedEvent(options.trace, {
      reasoningDecision: cacheLookup.cachedFlow.reasoningDecision,
      shadowModelRoute: cacheLookup.cachedFlow.shadowModelRoute,
      source: cacheLookup.cachedFlow.source,
      cacheStatus: 'hit',
      selectedIntentId: resolutionPacket.selected_intent_id,
      selectedConfidence: resolutionPacket.selected_confidence,
      compilerProvider: compilerTarget.provider,
      compilerModel: compilerTarget.model || 'default',
      fallbackReason: 'none',
      reasoningPolicyVersion: reasoningPolicy.version,
      selectedResolutionShape: resolutionPacket.selected_resolution?.shape,
      contractExecutionShape: cacheLookup.cachedFlow.intentContract.resolution.execution_shape,
    });
    const cachedUseCaseScenario = buildIntentUseCaseScenario({
      input: resolvedInput,
      packet: resolutionPacket,
      selectedIntent,
      executionBrief: cacheLookup.cachedFlow.executionBrief,
      intentContract: cacheLookup.cachedFlow.intentContract,
      workLoop: cacheLookup.cachedFlow.workLoop,
    });
    return {
      ...cacheLookup.cachedFlow,
      useCaseScenario: cachedUseCaseScenario,
      correlationId: cacheLookup.cachedFlow.correlationId || resolveCorrelationId(input),
    };
  }
  let executionBrief: ActuatorExecutionBrief | null = null;
  let intentContract: IntentContract | null = null;
  let workLoop: OrganizationWorkLoopSummary | null = null;
  let source: 'llm' | 'fallback' = 'llm';
  let fallbackReason: CompilationFallbackReason = 'none';
  let cacheStatus: 'disabled' | 'miss' | 'invalid' | 'hit' | 'write' = cacheLookup.status;

  const isSimpleGreeting = reasoningDecision.level === 'REFLEX_DETERMINISTIC';

  if (isSimpleGreeting) {
    source = 'fallback';
    fallbackReason = 'simple_greeting';
    const correlationId = resolveCorrelationId(input);
    intentContract = {
      kind: 'intent-contract',
      source_text: input.text,
      intent_id: 'generic-conversation',
      ...(correlationId ? { correlation_id: correlationId } : {}),
      goal: {
        summary: 'Conversational acknowledgment',
        success_condition: 'Polite greeting acknowledged.',
      },
      resolution: {
        execution_shape: 'direct_reply',
        task_type: 'service_operation',
      },
      required_inputs: [],
      outcome_ids: ['conversational_reply'],
      approval: {
        requires_approval: false,
      },
    } as any;
  } else {
    try {
      executionBrief = await compileExecutionBriefWithLlm(resolvedInput, options);
      if (!executionBrief) {
        source = 'fallback';
        if (fallbackReason === 'none') fallbackReason = 'execution_brief_invalid';
        executionBrief = buildFallbackExecutionBrief(toExecutionBriefSeed(resolvedInput));
      }
      intentContract = await compileIntentContractWithLlm(resolvedInput, executionBrief, options);
      if (intentContract) {
        workLoop = await compileWorkLoopWithLlm(
          resolvedInput,
          executionBrief,
          intentContract,
          options
        );
      } else if (fallbackReason === 'none') {
        source = 'fallback';
        fallbackReason = 'intent_contract_invalid';
      }
    } catch (error: any) {
      logger.warn(`[INTENT_CONTRACT] LLM compilation failed: ${error?.message || String(error)}`);
      source = 'fallback';
      fallbackReason = 'backend_error';
    }
  }

  if (!intentContract) {
    source = 'fallback';
    if (fallbackReason === 'none') fallbackReason = 'intent_contract_invalid';
    intentContract = buildFallbackIntentContract(resolvedInput, executionBrief ?? undefined);
  }
  if (!workLoop) {
    source = 'fallback';
    if (fallbackReason === 'none') fallbackReason = 'work_loop_invalid';
    workLoop = buildFallbackWorkLoop(resolvedInput, intentContract);
  }
  const routingDecision = deriveAgentRoutingDecision(intentContract, workLoop, resolvedInput.text);
  const finalExecutionBrief =
    executionBrief ?? buildFallbackExecutionBrief(toExecutionBriefSeed(resolvedInput));
  const useCaseScenario = buildIntentUseCaseScenario({
    input: resolvedInput,
    packet: resolutionPacket,
    selectedIntent,
    executionBrief: finalExecutionBrief,
    intentContract,
    workLoop,
  });
  if (cacheEligibility.eligible) {
    const writeResult = storeIntentFlowCache({
      eligibility: cacheEligibility,
      flow: {
        executionBrief: finalExecutionBrief,
        intentContract,
        workLoop,
        routingDecision,
        reasoningDecision,
        shadowModelRoute,
        clarificationPacket: buildClarificationPacket(
          intentContract,
          workLoop,
          finalExecutionBrief,
          input.locale
        ),
        source,
      },
    });
    if (cacheStatus === 'invalid') {
      // Preserve the invalid signal so corrupted cache files remain visible.
    } else {
      cacheStatus = writeResult.status === 'write' ? 'write' : cacheStatus;
      if (cacheStatus === 'disabled') {
        cacheStatus = writeResult.status;
      }
      if (cacheStatus === 'miss' && writeResult.status === 'disabled') {
        cacheStatus = 'miss';
      }
    }
  }
  emitIntentCompilationCompletedEvent(options.trace, {
    reasoningDecision,
    shadowModelRoute,
    source,
    selectedIntentId: resolutionPacket.selected_intent_id,
    selectedConfidence: resolutionPacket.selected_confidence,
    compilerProvider: compilerTarget.provider,
    compilerModel: compilerTarget.model || 'default',
    fallbackReason,
    reasoningPolicyVersion: reasoningPolicy.version,
    cacheStatus,
    selectedResolutionShape: resolutionPacket.selected_resolution?.shape,
    contractExecutionShape: intentContract.resolution.execution_shape,
  });

  return {
    executionBrief: finalExecutionBrief,
    intentContract,
    workLoop,
    useCaseScenario,
    correlationId: resolveCorrelationId(input),
    routingDecision,
    reasoningDecision,
    shadowModelRoute,
    clarificationPacket: buildClarificationPacket(
      intentContract,
      workLoop,
      finalExecutionBrief,
      input.locale
    ),
    source,
  };
}
