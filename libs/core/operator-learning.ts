import { createHash } from 'node:crypto';
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { logger } from './core.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  loadStandardIntentCatalog,
  resolveIntentResolutionPacket,
  type IntentResolutionPacket,
  type StandardIntentDefinition,
} from './intent-resolution.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

export type OperatorKnowledgeTier = 'personal' | 'confidential' | 'public';
export type OperatorRouteShape =
  | 'direct_reply'
  | 'task_session'
  | 'mission'
  | 'project_bootstrap'
  | 'browser_session'
  | 'pipeline'
  | 'actuator_action';

export interface OperatorProfile {
  kind: 'operator-profile';
  profile_id: string;
  scope: OperatorKnowledgeTier;
  subject: {
    display_name?: string;
    roles: string[];
    locale: string;
    timezone: string;
  };
  communication: {
    preferred_language: string;
    response_style: string;
    preferred_detail_level: string;
    question_budget_default?: number;
    default_structure?: string[];
  };
  decision_style: {
    ambiguity_tolerance: string;
    prefers_options_over_open_ended?: boolean;
    default_assumption_policy: string;
    tie_break_style?: string;
    ask_before_action_if: string[];
  };
  terminology?: {
    canonical_terms?: Array<{ term: string; aliases: string[] }>;
    preferred_labels?: Record<string, string>;
    forbidden_terms?: string[];
  };
  recurring_tasks?: Array<{
    family: string;
    trigger_phrases: string[];
    default_route?: string;
    default_outputs?: string[];
  }>;
  approval_policy: {
    requires_confirmation_if: string[];
    approval_thresholds?: Record<string, unknown>;
    delegate_when?: string[];
  };
  learning: {
    update_policy: string;
    min_samples_to_promote: number;
    retain_counterexamples: boolean;
    drift_detection?: boolean;
  };
  privacy?: {
    do_not_export?: string[];
    exportable?: string[];
  };
}

export interface OperatorRequestLog {
  kind: 'operator-request-log';
  request_id: string;
  profile_id: string;
  received_at: string;
  surface: string;
  raw_request: string;
  normalized_intent: {
    intent_id: string;
    task_family: string;
    goal?: string;
  };
  context?: {
    locale?: string;
    active_mission_ref?: string | null;
    project_ref?: string | null;
    [key: string]: unknown;
  };
  route: {
    shape: OperatorRouteShape;
    reason?: string;
    confidence: number;
  };
  signals: {
    decision_style_observed?: string;
    terminology_observed?: string[];
    approval_threshold_observed?: string[];
    recurring_task_candidate?: string[];
    correction_signals?: string[];
  };
  clarification?: {
    asked?: boolean;
    questions?: string[];
  };
  execution?: {
    started?: boolean;
    artifact_refs?: string[];
  };
  verification: {
    result: 'satisfied' | 'partial' | 'mismatch' | 'unverified';
    mismatch_notes?: string[];
    operator_correction_count: number;
  };
  learning_update: {
    candidate_created: boolean;
    candidate_kind?: string;
    promote_eligible: boolean;
    sample_count_after_update?: number;
  };
  privacy: {
    tier: OperatorKnowledgeTier;
    contains_sensitive_info: boolean;
    exportable_publicly: boolean;
    confidential_only?: boolean;
  };
}

export interface OperatorLearningProposal {
  kind: 'operator-learning-proposal';
  proposal_id: string;
  profile_id: string;
  created_at: string;
  recommended_tier: OperatorKnowledgeTier;
  requires_approval: boolean;
  summary: string;
  evidence_request_ids: string[];
  promotion_decision: {
    eligible: boolean;
    sample_count: number;
    required_samples: number;
    reason: string;
  };
  candidate_updates: {
    communication?: {
      question_budget_default?: number;
    };
    decision_style?: {
      observed_styles: string[];
    };
    terminology?: {
      observed_terms: string[];
    };
    recurring_tasks?: Array<{
      family: string;
      sample_count: number;
    }>;
    approval_policy?: {
      observed_triggers: string[];
    };
  };
}

export interface OperatorLearningPromotionRecord {
  kind: 'operator-learning-promotion-record';
  promotion_id: string;
  proposal_id: string;
  profile_id: string;
  approved_by: string;
  approved_at: string;
  target_tier: OperatorKnowledgeTier;
  target_path: string;
  summary: string;
  evidence_request_ids: string[];
  promotion_decision: OperatorLearningProposal['promotion_decision'];
  candidate_updates: OperatorLearningProposal['candidate_updates'];
}

export interface BuildOperatorRequestLogInput {
  packet: IntentResolutionPacket;
  profileId: string;
  surface: string;
  receivedAt?: string;
  requestId?: string;
  privacy?: Partial<OperatorRequestLog['privacy']>;
  verification?: Partial<OperatorRequestLog['verification']>;
  clarificationQuestions?: string[];
  execution?: OperatorRequestLog['execution'];
  context?: OperatorRequestLog['context'];
}

export interface BuildOperatorLearningSimulationInput {
  utterances: string[];
  surface: string;
  profile?: OperatorProfile;
  profileId?: string;
  startAt?: string;
  intervalMs?: number;
  privacy?: Partial<OperatorRequestLog['privacy']>;
  verification?: Partial<OperatorRequestLog['verification']>;
  context?: OperatorRequestLog['context'];
}

export interface OperatorLearningSimulation {
  kind: 'operator-learning-simulation';
  profile_id: string;
  request_logs: OperatorRequestLog[];
  proposal: OperatorLearningProposal;
}

export interface OperatorLearningDispatchMatch {
  intent_ids?: string[];
  categories?: string[];
  mission_classes?: string[];
  targets?: string[];
  actions?: string[];
  risk_profiles?: Array<'low' | 'review_required' | 'approval_required' | 'high_stakes'>;
  route_shapes?: OperatorRouteShape[];
  result_shapes?: string[];
  surface_contains_any?: string[];
  trigger_keywords_any?: string[];
}

export interface OperatorLearningDispatchRule {
  rule_id: string;
  priority?: number;
  match?: OperatorLearningDispatchMatch;
  dispatch: {
    decision_style_observed?: string;
    recurring_task_candidate?: string[];
    approval_threshold_observed?: string[];
    correction_signals?: string[];
  };
}

export interface OperatorLearningDispatchRegistry {
  version: string;
  rules: OperatorLearningDispatchRule[];
}

export interface OperatorLearningDispatchResult {
  decision_style_observed?: string;
  recurring_task_candidate?: string[];
  approval_threshold_observed?: string[];
  correction_signals?: string[];
}

let operatorProfileValidateFn: ValidateFunction | null = null;
let operatorRequestLogValidateFn: ValidateFunction | null = null;
let operatorLearningDispatchRegistryValidateFn: ValidateFunction | null = null;
let operatorLearningDispatchRegistryCachePath: string | null = null;
let operatorLearningDispatchRegistryCache: OperatorLearningDispatchRegistry | null = null;

function createAjv() {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

function formatSchemaErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map(
    (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
  );
}

function ensureOperatorProfileValidator(): ValidateFunction {
  if (operatorProfileValidateFn) return operatorProfileValidateFn;
  operatorProfileValidateFn = compileSchemaFromPath(
    createAjv(),
    pathResolver.knowledge('public/schemas/operator-profile.schema.json')
  );
  return operatorProfileValidateFn;
}

function ensureOperatorRequestLogValidator(): ValidateFunction {
  if (operatorRequestLogValidateFn) return operatorRequestLogValidateFn;
  operatorRequestLogValidateFn = compileSchemaFromPath(
    createAjv(),
    pathResolver.knowledge('public/schemas/operator-request-log.schema.json')
  );
  return operatorRequestLogValidateFn;
}

function ensureOperatorLearningDispatchRegistryValidator(): ValidateFunction {
  if (operatorLearningDispatchRegistryValidateFn) return operatorLearningDispatchRegistryValidateFn;
  operatorLearningDispatchRegistryValidateFn = compileSchemaFromPath(
    createAjv(),
    pathResolver.knowledge('public/schemas/operator-learning-dispatch-registry.schema.json')
  );
  return operatorLearningDispatchRegistryValidateFn;
}

const DEFAULT_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = pathResolver.knowledge(
  'public/governance/operator-learning-dispatch-registry.json'
);
const DEFAULT_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = pathResolver.knowledge(
  'personal/governance/operator-learning-dispatch-registry.json'
);
const DEFAULT_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH = pathResolver.knowledge(
  'confidential/governance/operator-learning-dispatch-registry.json'
);

const FALLBACK_OPERATOR_LEARNING_DISPATCH_REGISTRY: OperatorLearningDispatchRegistry = {
  version: 'fallback',
  rules: [
    {
      rule_id: 'executive-decision-support',
      priority: 100,
      match: {
        intent_ids: [
          'executive-strategy-brief',
          'executive-prioritization',
          'executive-reporting',
          'stakeholder-communication',
          'sales-account-strategy',
        ],
      },
      dispatch: {
        decision_style_observed: 'executive_options_with_recommendation',
        recurring_task_candidate: ['executive_decision_support'],
      },
    },
    {
      rule_id: 'technical-decision-support',
      priority: 95,
      match: {
        intent_ids: ['technical-decision-memo'],
      },
      dispatch: {
        decision_style_observed: 'decision_memo_with_tradeoffs',
        recurring_task_candidate: ['technical_decision_support'],
      },
    },
    {
      rule_id: 'llm-provider-selection',
      priority: 90,
      match: {
        intent_ids: ['llm-provider-selection'],
      },
      dispatch: {
        decision_style_observed: 'technical_evaluation',
        recurring_task_candidate: ['provider_selection'],
      },
    },
    {
      rule_id: 'agent-runtime-tuning',
      priority: 90,
      match: {
        intent_ids: ['agent-runtime-tuning'],
      },
      dispatch: {
        decision_style_observed: 'technical_evaluation',
        recurring_task_candidate: ['runtime_tuning'],
      },
    },
    {
      rule_id: 'knowledge-query',
      priority: 90,
      match: {
        intent_ids: ['knowledge-query'],
      },
      dispatch: {
        recurring_task_candidate: ['knowledge_query'],
      },
    },
    {
      rule_id: 'browser-navigation',
      priority: 90,
      match: {
        intent_ids: ['open-site', 'browser-step'],
      },
      dispatch: {
        recurring_task_candidate: ['browser_navigation'],
      },
    },
    {
      rule_id: 'approval-workflow',
      priority: 90,
      match: {
        intent_ids: ['request-approval', 'resolve-approval'],
      },
      dispatch: {
        recurring_task_candidate: ['approval_workflow'],
      },
    },
    {
      rule_id: 'kyberion-runtime-expansion',
      priority: 87,
      match: {
        intent_ids: [
          'bootstrap-kyberion-runtime',
          'verify-environment-readiness',
          'configure-reasoning-backend',
          'register-actuator-adapter',
        ],
      },
      dispatch: {
        recurring_task_candidate: ['kyberion_runtime_expansion'],
      },
    },
    {
      rule_id: 'onboarding-toolchain-setup',
      priority: 86,
      match: {
        intent_ids: ['configure-organization-toolchain'],
      },
      dispatch: {
        recurring_task_candidate: ['onboarding_setup'],
      },
    },
    {
      rule_id: 'onboarding-first-run',
      priority: 86,
      match: {
        intent_ids: ['launch-first-run-onboarding'],
      },
      dispatch: {
        recurring_task_candidate: ['onboarding_setup'],
      },
    },
    {
      rule_id: 'onboarding-presentation-preferences',
      priority: 86,
      match: {
        intent_ids: ['register-presentation-preference-profile'],
      },
      dispatch: {
        recurring_task_candidate: ['onboarding_setup'],
      },
    },
    {
      rule_id: 'kyberion-system-observability',
      priority: 87,
      match: {
        intent_ids: [
          'check-kyberion-baseline',
          'check-kyberion-vital',
          'diagnose-kyberion-system',
          'inspect-runtime-supervisor',
          'inspect-mission-state',
        ],
      },
      dispatch: {
        recurring_task_candidate: ['kyberion_system_observability'],
      },
    },
    {
      rule_id: 'service-lifecycle',
      priority: 88,
      match: {
        intent_ids: ['start-service', 'stop-service'],
      },
      dispatch: {
        recurring_task_candidate: ['service_lifecycle'],
      },
    },
    {
      rule_id: 'approval-threshold-risk',
      priority: 80,
      match: {
        risk_profiles: ['approval_required', 'high_stakes'],
      },
      dispatch: {
        approval_threshold_observed: ['high_risk_action'],
      },
    },
    {
      rule_id: 'approval-threshold-external-service',
      priority: 75,
      match: {
        targets: ['external_service'],
      },
      dispatch: {
        approval_threshold_observed: ['external_side_effect'],
      },
    },
    {
      rule_id: 'approval-threshold-llm',
      priority: 70,
      match: {
        categories: ['llm_reasoning_setup'],
      },
      dispatch: {
        approval_threshold_observed: ['org_policy_change'],
      },
    },
  ],
};

function getOperatorLearningDispatchRegistryPath(): string {
  return process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH?.trim() ||
    DEFAULT_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
}

function getPersonalOperatorLearningDispatchRegistryPath(): string | null {
  if (process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH?.trim()) return null;
  const configured =
    process.env.KYBERION_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH?.trim() ||
    DEFAULT_PERSONAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
  return safeExistsSync(configured) ? configured : null;
}

function getConfidentialOperatorLearningDispatchRegistryPath(): string | null {
  if (process.env.KYBERION_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH?.trim()) return null;
  const configured =
    process.env.KYBERION_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH?.trim() ||
    DEFAULT_CONFIDENTIAL_OPERATOR_LEARNING_DISPATCH_REGISTRY_PATH;
  return safeExistsSync(configured) ? configured : null;
}

function loadDispatchRegistryFromPath(registryPath: string): OperatorLearningDispatchRegistry {
  const parsed = JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string) as OperatorLearningDispatchRegistry;
  const validate = ensureOperatorLearningDispatchRegistryValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid operator learning dispatch registry: ${errors}`);
  }
  return parsed;
}

function mergeDispatchRegistries(
  base: OperatorLearningDispatchRegistry,
  overlay: OperatorLearningDispatchRegistry
): OperatorLearningDispatchRegistry {
  const rules = new Map<string, OperatorLearningDispatchRule>();
  for (const rule of base.rules) rules.set(rule.rule_id, rule);
  for (const rule of overlay.rules) rules.set(rule.rule_id, rule);
  return {
    ...base,
    ...overlay,
    rules: [...rules.values()],
  };
}

export function resetOperatorLearningDispatchRegistryCache(): void {
  operatorLearningDispatchRegistryCachePath = null;
  operatorLearningDispatchRegistryCache = null;
}

export function getOperatorLearningDispatchRegistry(): OperatorLearningDispatchRegistry {
  const registryPath = getOperatorLearningDispatchRegistryPath();
  const personalOverlayPath = getPersonalOperatorLearningDispatchRegistryPath();
  const confidentialOverlayPath = getConfidentialOperatorLearningDispatchRegistryPath();
  const cacheKey = [registryPath, personalOverlayPath, confidentialOverlayPath].filter(Boolean).join('::');
  if (operatorLearningDispatchRegistryCachePath === cacheKey && operatorLearningDispatchRegistryCache) {
    return operatorLearningDispatchRegistryCache;
  }

  if (!safeExistsSync(registryPath)) {
    operatorLearningDispatchRegistryCachePath = cacheKey;
    operatorLearningDispatchRegistryCache = FALLBACK_OPERATOR_LEARNING_DISPATCH_REGISTRY;
    return operatorLearningDispatchRegistryCache;
  }

  try {
    let parsed = loadDispatchRegistryFromPath(registryPath);
    if (confidentialOverlayPath) {
      parsed = mergeDispatchRegistries(parsed, loadDispatchRegistryFromPath(confidentialOverlayPath));
    }
    if (personalOverlayPath) {
      parsed = mergeDispatchRegistries(parsed, loadDispatchRegistryFromPath(personalOverlayPath));
    }
    operatorLearningDispatchRegistryCachePath = cacheKey;
    operatorLearningDispatchRegistryCache = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(
      `[OPERATOR_LEARNING_DISPATCH_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`
    );
    operatorLearningDispatchRegistryCachePath = cacheKey;
    operatorLearningDispatchRegistryCache = FALLBACK_OPERATOR_LEARNING_DISPATCH_REGISTRY;
    return operatorLearningDispatchRegistryCache;
  }
}

function matchDispatchRule(
  rule: OperatorLearningDispatchRule,
  intent?: StandardIntentDefinition,
  packet?: IntentResolutionPacket,
): boolean {
  const match = rule.match;
  if (!match) return true;

  if (match.intent_ids?.length) {
    const intentId = intent?.id || packet?.selected_intent_id;
    if (!intentId || !match.intent_ids.includes(intentId)) return false;
  }

  if (match.categories?.length && !match.categories.includes(String(intent?.category || ''))) {
    return false;
  }

  if (match.mission_classes?.length && !match.mission_classes.includes(String(intent?.mission_class || ''))) {
    return false;
  }

  if (match.targets?.length && !match.targets.includes(String(intent?.target || ''))) {
    return false;
  }

  if (match.actions?.length && !match.actions.includes(String(intent?.action || ''))) {
    return false;
  }

  if (match.risk_profiles?.length) {
    const riskProfile = intent?.risk_profile as
      | 'low'
      | 'review_required'
      | 'approval_required'
      | 'high_stakes'
      | undefined;
    if (!riskProfile || !match.risk_profiles.includes(riskProfile)) {
      return false;
    }
  }

  if (match.route_shapes?.length) {
    const routeShape = packet?.selected_resolution?.shape;
    if (!routeShape || !match.route_shapes.includes(routeShape as OperatorRouteShape)) {
      return false;
    }
  }

  if (match.result_shapes?.length) {
    const resultShape = packet?.selected_resolution?.result_shape;
    if (!resultShape || !match.result_shapes.includes(resultShape)) return false;
  }

  const utterance = String(packet?.utterance || '').toLowerCase();
  if (match.surface_contains_any?.length && !match.surface_contains_any.some((term) => utterance.includes(term.toLowerCase()))) {
    return false;
  }

  if (match.trigger_keywords_any?.length) {
    const triggerKeywords = new Set([
      ...(intent?.trigger_keywords || []),
      ...(packet?.candidates || []).flatMap((candidate) => candidate.matched_keywords || []),
    ].map((value) => String(value).toLowerCase()));
    const triggerText = `${utterance}\n${[...(intent?.surface_examples || [])].join('\n')}`.toLowerCase();
    if (!match.trigger_keywords_any.some((term) => triggerKeywords.has(term.toLowerCase()) || triggerText.includes(term.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

function dispatchOperatorLearningSignals(input: {
  intent?: StandardIntentDefinition;
  packet: IntentResolutionPacket;
}): OperatorLearningDispatchResult {
  const registry = getOperatorLearningDispatchRegistry();
  const orderedRules = [...registry.rules].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.rule_id.localeCompare(right.rule_id)
  );
  const matchedRules = orderedRules.filter((rule) => matchDispatchRule(rule, input.intent, input.packet));
  const result: OperatorLearningDispatchResult = {};

  for (const rule of matchedRules) {
    if (!result.decision_style_observed && rule.dispatch.decision_style_observed) {
      result.decision_style_observed = rule.dispatch.decision_style_observed;
    }
    if (rule.dispatch.recurring_task_candidate?.length) {
      result.recurring_task_candidate = unique([
        ...(result.recurring_task_candidate || []),
        ...rule.dispatch.recurring_task_candidate,
      ]);
    }
    if (rule.dispatch.approval_threshold_observed?.length) {
      result.approval_threshold_observed = unique([
        ...(result.approval_threshold_observed || []),
        ...rule.dispatch.approval_threshold_observed,
      ]);
    }
    if (rule.dispatch.correction_signals?.length) {
      result.correction_signals = unique([
        ...(result.correction_signals || []),
        ...rule.dispatch.correction_signals,
      ]);
    }
  }

  return result;
}

export function validateOperatorProfile(input: unknown): { valid: boolean; errors: string[] } {
  const validate = ensureOperatorProfileValidator();
  const valid = validate(input);
  return { valid: Boolean(valid), errors: valid ? [] : formatSchemaErrors(validate) };
}

export function validateOperatorRequestLog(input: unknown): { valid: boolean; errors: string[] } {
  const validate = ensureOperatorRequestLogValidator();
  const valid = validate(input);
  return { valid: Boolean(valid), errors: valid ? [] : formatSchemaErrors(validate) };
}

export function assertValidOperatorProfile(input: unknown): asserts input is OperatorProfile {
  const result = validateOperatorProfile(input);
  if (!result.valid) {
    throw new Error(`Invalid operator profile: ${result.errors.join('; ')}`);
  }
}

export function assertValidOperatorRequestLog(input: unknown): asserts input is OperatorRequestLog {
  const result = validateOperatorRequestLog(input);
  if (!result.valid) {
    throw new Error(`Invalid operator request log: ${result.errors.join('; ')}`);
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function countValues(values: string[]): Array<{ family: string; sample_count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .map(([family, sample_count]) => ({ family, sample_count }))
    .sort((left, right) => right.sample_count - left.sample_count || left.family.localeCompare(right.family));
}

function recommendTier(logs: OperatorRequestLog[]): OperatorKnowledgeTier {
  if (logs.some((log) => log.privacy.tier === 'personal' || log.privacy.contains_sensitive_info)) {
    return 'personal';
  }
  if (logs.some((log) => log.privacy.tier === 'confidential' || log.privacy.confidential_only)) {
    return 'confidential';
  }
  return logs.every((log) => log.privacy.exportable_publicly) ? 'public' : 'personal';
}

function requestIdFrom(value: string, receivedAt: string): string {
  const digest = createHash('sha256').update(`${receivedAt}\n${value}`).digest('hex').slice(0, 12);
  return `opreq_${digest}`;
}

function normalizeRouteShape(shape?: string): OperatorRouteShape {
  if (shape === 'project_bootstrap') return 'project_bootstrap';
  if (shape === 'mission') return 'mission';
  if (shape === 'browser_session') return 'browser_session';
  if (shape === 'pipeline') return 'pipeline';
  if (shape === 'actuator_action') return 'actuator_action';
  if (shape === 'task_session') return 'task_session';
  return 'direct_reply';
}

function findIntent(intentId?: string): StandardIntentDefinition | undefined {
  if (!intentId) return undefined;
  return loadStandardIntentCatalog().find((intent) => intent.id === intentId);
}

function inferDecisionStyle(intentId: string, intent?: StandardIntentDefinition): string | undefined {
  const dispatched = dispatchOperatorLearningSignals({
    intent,
    packet: {
      kind: 'intent_resolution_packet',
      utterance: '',
      selected_intent_id: intentId,
      candidates: [],
    },
  });
  return dispatched.decision_style_observed;
}

function inferRecurringTaskCandidate(intentId: string, intent?: StandardIntentDefinition): string[] {
  if (!intentId || intentId === 'unresolved_intent') return [];
  const dispatched = dispatchOperatorLearningSignals({
    intent,
    packet: {
      kind: 'intent_resolution_packet',
      utterance: '',
      selected_intent_id: intentId,
      candidates: [],
    },
  });
  return dispatched.recurring_task_candidate?.length
    ? dispatched.recurring_task_candidate
    : [intent?.mission_class || intentId].filter(Boolean);
}

function inferApprovalThresholds(intent?: StandardIntentDefinition): string[] {
  const dispatched = dispatchOperatorLearningSignals({
    intent,
    packet: {
      kind: 'intent_resolution_packet',
      utterance: '',
      selected_intent_id: intent?.id,
      candidates: [],
    },
  });
  return dispatched.approval_threshold_observed || [];
}

function maybeJaLocale(value: string): string | undefined {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(value) ? 'ja-JP' : undefined;
}

function withDefinedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function buildOperatorRequestLogFromIntentResolution(
  input: BuildOperatorRequestLogInput
): OperatorRequestLog {
  const receivedAt = input.receivedAt || new Date().toISOString();
  const selectedIntentId = input.packet.selected_intent_id || 'unresolved_intent';
  const selectedIntent = findIntent(input.packet.selected_intent_id);
  const selectedCandidate = input.packet.candidates.find(
    (candidate) => candidate.intent_id === input.packet.selected_intent_id
  );
  const routeShape = normalizeRouteShape(input.packet.selected_resolution?.shape);
  const context = withDefinedValues({
    ...input.context,
    locale:
      input.context?.locale ||
      maybeJaLocale(
        [input.packet.utterance, ...(selectedIntent?.surface_examples || [])].join('\n')
      ),
    active_mission_ref: input.context?.active_mission_ref,
    project_ref: input.context?.project_ref,
  });
  const normalizedIntent = withDefinedValues({
    intent_id: selectedIntentId,
    task_family:
      selectedIntent?.mission_class ||
      selectedIntent?.category ||
      input.packet.selected_resolution?.task_kind ||
      'unresolved',
    goal: selectedIntent?.description,
  }) as OperatorRequestLog['normalized_intent'];
  const correctionSignals = unique([
    !input.packet.selected_intent_id ? 'clarification_requested' : undefined,
    input.clarificationQuestions?.length ? 'clarification_prompted' : undefined,
    input.verification?.result === 'mismatch' ? 'operator_correction_required' : undefined,
  ]);
  const signals = withDefinedValues({
    decision_style_observed: inferDecisionStyle(selectedIntentId, selectedIntent),
    terminology_observed: unique([
      ...(selectedCandidate?.matched_keywords || []),
      ...(selectedIntent?.trigger_keywords || []).filter((keyword) =>
        input.packet.utterance.toLowerCase().includes(String(keyword).toLowerCase())
      ),
    ]),
    approval_threshold_observed: inferApprovalThresholds(selectedIntent),
    recurring_task_candidate: inferRecurringTaskCandidate(selectedIntentId, selectedIntent),
    correction_signals: correctionSignals,
  }) as OperatorRequestLog['signals'];
  const privacy = withDefinedValues({
    tier: input.privacy?.tier || 'personal',
    contains_sensitive_info: input.privacy?.contains_sensitive_info ?? false,
    exportable_publicly: input.privacy?.exportable_publicly ?? false,
    confidential_only: input.privacy?.confidential_only,
  }) as OperatorRequestLog['privacy'];
  const log: OperatorRequestLog = {
    kind: 'operator-request-log',
    request_id: input.requestId || requestIdFrom(input.packet.utterance, receivedAt),
    profile_id: input.profileId,
    received_at: receivedAt,
    surface: input.surface,
    raw_request: input.packet.utterance,
    normalized_intent: normalizedIntent,
    route: {
      shape: routeShape,
      reason: selectedCandidate?.reasons.join('; ') || 'no confident intent match',
      confidence: input.packet.selected_confidence ?? 0,
    },
    signals,
    clarification: {
      asked: Boolean(input.clarificationQuestions?.length) || !input.packet.selected_intent_id,
      questions: input.clarificationQuestions || [],
    },
    execution: input.execution || {
      started: false,
      artifact_refs: [],
    },
    verification: {
      result: input.verification?.result || 'unverified',
      mismatch_notes: input.verification?.mismatch_notes || [],
      operator_correction_count: input.verification?.operator_correction_count ?? 0,
    },
    learning_update: {
      candidate_created: Boolean(input.packet.selected_intent_id),
      candidate_kind: 'operator-request-pattern',
      promote_eligible: false,
      sample_count_after_update: 1,
    },
    privacy,
  };
  if (Object.keys(context).length > 0) log.context = context;
  assertValidOperatorRequestLog(log);
  return log;
}

export function buildOperatorLearningProposal(input: {
  profile?: OperatorProfile;
  requestLogs: OperatorRequestLog[];
  now?: string;
}): OperatorLearningProposal {
  if (input.profile) assertValidOperatorProfile(input.profile);
  if (!input.requestLogs.length) {
    throw new Error('Operator learning proposal requires at least one request log');
  }
  for (const log of input.requestLogs) assertValidOperatorRequestLog(log);

  const profileId = input.profile?.profile_id || input.requestLogs[0]?.profile_id;
  const sampleCount = input.requestLogs.length;
  const requiredSamples = input.profile?.learning.min_samples_to_promote || 5;
  const recurringTasks = countValues(input.requestLogs.flatMap((log) => log.signals.recurring_task_candidate || []));
  const correctionCount = input.requestLogs.reduce(
    (sum, log) => sum + log.verification.operator_correction_count,
    0
  );
  const mismatchCount = input.requestLogs.filter((log) => log.verification.result === 'mismatch').length;
  const eligible = sampleCount >= requiredSamples && mismatchCount === 0;
  const recommendedTier = recommendTier(input.requestLogs);

  return {
    kind: 'operator-learning-proposal',
    proposal_id: `olp-${profileId}-${Date.parse(input.now || new Date().toISOString()).toString(36)}`,
    profile_id: profileId,
    created_at: input.now || new Date().toISOString(),
    recommended_tier: recommendedTier,
    requires_approval: true,
    summary: `Observed ${sampleCount} operator request sample(s), ${correctionCount} correction(s), and ${recurringTasks.length} recurring task candidate(s).`,
    evidence_request_ids: unique(input.requestLogs.map((log) => log.request_id)),
    promotion_decision: {
      eligible,
      sample_count: sampleCount,
      required_samples: requiredSamples,
      reason: eligible
        ? 'sample threshold reached without mismatch signals'
        : 'keep as learning candidate until enough stable samples exist',
    },
    candidate_updates: {
      communication: {
        question_budget_default: input.profile?.communication.question_budget_default,
      },
      decision_style: {
        observed_styles: unique(input.requestLogs.map((log) => log.signals.decision_style_observed)),
      },
      terminology: {
        observed_terms: unique(input.requestLogs.flatMap((log) => log.signals.terminology_observed || [])),
      },
      recurring_tasks: recurringTasks,
      approval_policy: {
        observed_triggers: unique(
          input.requestLogs.flatMap((log) => log.signals.approval_threshold_observed || [])
        ),
      },
    },
  };
}

export function simulateOperatorLearningFromUtterances(
  input: BuildOperatorLearningSimulationInput
): OperatorLearningSimulation {
  if (!input.utterances.length) {
    throw new Error('Operator learning simulation requires at least one utterance');
  }
  if (input.profile) assertValidOperatorProfile(input.profile);

  const profileId = input.profile?.profile_id || input.profileId;
  if (!profileId) {
    throw new Error('Operator learning simulation requires profile or profileId');
  }

  const startAt = input.startAt || new Date().toISOString();
  const startMs = Date.parse(startAt);
  if (Number.isNaN(startMs)) {
    throw new Error(`Invalid operator learning simulation startAt: ${startAt}`);
  }
  const intervalMs = input.intervalMs ?? 1000;

  const requestLogs = input.utterances.map((utterance, index) => {
    const receivedAt = new Date(startMs + index * intervalMs).toISOString();
    return buildOperatorRequestLogFromIntentResolution({
      packet: resolveIntentResolutionPacket(utterance),
      profileId,
      surface: input.surface,
      receivedAt,
      privacy: input.privacy,
      verification: input.verification,
      context: input.context,
    });
  });

  return {
    kind: 'operator-learning-simulation',
    profile_id: profileId,
    request_logs: requestLogs,
    proposal: buildOperatorLearningProposal({
      profile: input.profile,
      requestLogs,
      now: new Date(startMs + input.utterances.length * intervalMs).toISOString(),
    }),
  };
}

function assertValidOperatorLearningProposal(input: OperatorLearningProposal): void {
  if (!input || input.kind !== 'operator-learning-proposal') {
    throw new Error('Invalid operator learning proposal: kind must be operator-learning-proposal');
  }
  if (!input.proposal_id || !input.profile_id) {
    throw new Error('Invalid operator learning proposal: proposal_id and profile_id are required');
  }
  if (!['personal', 'confidential', 'public'].includes(input.recommended_tier)) {
    throw new Error(`Invalid operator learning proposal: unsupported tier ${input.recommended_tier}`);
  }
  if (!input.promotion_decision || typeof input.promotion_decision.eligible !== 'boolean') {
    throw new Error('Invalid operator learning proposal: promotion_decision is required');
  }
}

function safeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'operator-learning';
}

function defaultPromotionPath(input: {
  proposal: OperatorLearningProposal;
  targetTier: OperatorKnowledgeTier;
  approvedAt: string;
}): string {
  const date = input.approvedAt.slice(0, 10);
  const fileName = `${safeSegment(input.proposal.proposal_id)}.json`;
  if (input.targetTier === 'personal') {
    return pathResolver.knowledge(`personal/operator-learning/${date}/${fileName}`);
  }
  if (input.targetTier === 'confidential') {
    return pathResolver.knowledge(`confidential/operator-learning/${date}/${fileName}`);
  }
  return pathResolver.knowledge(`public/operator-learning/${date}/${fileName}`);
}

export function promoteOperatorLearningProposal(input: {
  proposal: OperatorLearningProposal;
  approvedBy: string;
  approvedAt?: string;
  targetTier?: OperatorKnowledgeTier;
  outputPath?: string;
  allowBelowThreshold?: boolean;
  dryRun?: boolean;
}): OperatorLearningPromotionRecord {
  assertValidOperatorLearningProposal(input.proposal);
  const approvedBy = input.approvedBy.trim();
  if (!approvedBy) {
    throw new Error('Operator learning promotion requires approvedBy');
  }
  if (!input.proposal.promotion_decision.eligible && !input.allowBelowThreshold) {
    throw new Error(
      `Operator learning proposal ${input.proposal.proposal_id} is not eligible for promotion: ${input.proposal.promotion_decision.reason}`
    );
  }

  const approvedAt = input.approvedAt || new Date().toISOString();
  const targetTier = input.targetTier || input.proposal.recommended_tier;
  const targetPath =
    input.outputPath ||
    defaultPromotionPath({
      proposal: input.proposal,
      targetTier,
      approvedAt,
    });

  const record: OperatorLearningPromotionRecord = {
    kind: 'operator-learning-promotion-record',
    promotion_id: `olpr-${safeSegment(input.proposal.proposal_id)}-${Date.parse(approvedAt).toString(36)}`,
    proposal_id: input.proposal.proposal_id,
    profile_id: input.proposal.profile_id,
    approved_by: approvedBy,
    approved_at: approvedAt,
    target_tier: targetTier,
    target_path: targetPath,
    summary: input.proposal.summary,
    evidence_request_ids: input.proposal.evidence_request_ids,
    promotion_decision: input.proposal.promotion_decision,
    candidate_updates: input.proposal.candidate_updates,
  };

  if (!input.dryRun) {
    safeWriteFile(targetPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  return record;
}
