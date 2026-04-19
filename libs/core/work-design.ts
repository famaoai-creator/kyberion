import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { listDistillCandidateRecords } from './distill-candidate-registry.js';
import { loadStandardIntentCatalog, type StandardIntentDefinition } from './intent-resolution.js';
import { resolveMissionClassification } from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign } from './mission-review-gates.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const WORK_POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/work-policy.schema.json');

export interface OutcomeDefinition {
  id: string;
  label: string;
  description: string;
  deliverable_kind: string;
  downloadable: boolean;
  previewable: boolean;
}

export interface SpecialistDefinition {
  id: string;
  label: string;
  description: string;
  conversation_agent: string;
  team_roles: string[];
  capabilities: string[];
}

interface OutcomeCatalogFile {
  outcomes?: Record<string, Omit<OutcomeDefinition, 'id'>>;
}

interface SpecialistCatalogFile {
  specialists?: Record<string, Omit<SpecialistDefinition, 'id'>>;
}

interface BoundaryProfileFile {
  profiles?: Record<string, OrganizationWorkLoopSummary['execution_boundary']>;
}

interface RuntimeDesignProfileFile {
  profiles?: Record<string, OrganizationWorkLoopSummary['runtime_design']>;
}

interface RoutingMatch {
  intent_ids?: string[];
  task_types?: string[];
  query_types?: string[];
  shapes?: string[];
  catalog_shapes?: string[];
}

interface SpecialistRoutingPolicyFile {
  rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    specialist_id?: string;
  }>;
  fallback_specialist_id?: string;
}

interface WorkDesignProfileRoutingFile {
  execution_boundary_rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    profile_id?: string;
  }>;
  runtime_design_rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    profile_id?: string;
  }>;
  defaults?: {
    execution_boundary_profile_id?: string;
    runtime_design_profile_id?: string;
  };
}

interface WorkDesignRulesFile {
  process_checklist_rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    items?: string[];
  }>;
  execution_shape_rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    shape?: OrganizationWorkLoopSummary['resolution']['execution_shape'];
  }>;
  intent_label_rules?: Array<{
    id?: string;
    match?: RoutingMatch;
    label?: string;
    label_from?: 'intentId' | 'taskType' | 'queryType';
  }>;
}

interface ProcessDesignRuleInput {
  intentId?: string;
  taskType?: string;
  shape?: string;
}

interface ExecutionShapeRuleInput {
  intentId?: string;
  taskType?: string;
  shape?: string;
  catalogShape?: string;
}

interface IntentLabelRuleInput {
  intentId?: string;
  taskType?: string;
  queryType?: string;
}

interface ProcessChecklistRule {
  items: string[];
  match?: RoutingMatch;
}

interface ExecutionShapeRule {
  match?: RoutingMatch;
  shape: OrganizationWorkLoopSummary['resolution']['execution_shape'];
}

interface IntentLabelRule {
  match?: RoutingMatch;
  label?: string;
  label_from?: 'intentId' | 'taskType' | 'queryType';
}

interface WorkPolicyFile {
  version: string;
  specialist_routing: SpecialistRoutingPolicyFile;
  profile_routing: WorkDesignProfileRoutingFile;
  design_rules: WorkDesignRulesFile;
}

let workPolicyValidateFn: ValidateFunction | null = null;

function ensureWorkPolicyValidator(): ValidateFunction {
  if (workPolicyValidateFn) return workPolicyValidateFn;
  workPolicyValidateFn = compileSchemaFromPath(ajv, WORK_POLICY_SCHEMA_PATH);
  return workPolicyValidateFn;
}

export interface WorkDesignSummary {
  primary_specialist: SpecialistDefinition | null;
  conversation_agent: string | null;
  team_roles: string[];
  outcomes: OutcomeDefinition[];
  reusable_refs: Array<{
    candidate_id: string;
    title: string;
    target_kind: string;
    promoted_ref?: string;
  }>;
}

export interface OrganizationWorkLoopSummary {
  intent: {
    label: string;
  };
  context: {
    project_id?: string;
    project_name?: string;
    track_id?: string;
    track_name?: string;
    tier: 'personal' | 'confidential' | 'public';
    locale?: string;
    service_bindings: string[];
  };
  resolution: {
    execution_shape: 'direct_reply' | 'task_session' | 'mission' | 'project_bootstrap';
    task_type?: string;
  };
  workflow_design: {
    workflow_id: string;
    pattern: string;
    stage: string;
    phases: string[];
    rationale: string;
  };
  review_design: {
    review_mode: 'lean' | 'standard' | 'strict';
    required_gate_ids: string[];
    all_gate_ids: string[];
    rationale: string;
  };
  outcome_design: {
    outcome_ids: string[];
    labels: string[];
  };
  process_design: {
    plan_outline: string[];
    intake_requirements: string[];
    operator_checklist: string[];
  };
  runtime_design: {
    owner_model: 'single_actor' | 'single_owner_multi_worker';
    assignment_policy: 'direct_specialist' | 'lease_aware_capability' | 'dependency_first';
    coordination: {
      bus: 'none' | 'mission_coordination_bus';
      channels: string[];
    };
    memory: {
      store: 'none' | 'mission_working_memory';
      scope: 'none' | 'mission_local';
      purpose: string[];
    };
  };
  execution_boundary: {
    llm_zone: {
      allowed: string[];
      forbidden: string[];
    };
    knowledge_zone: {
      owns: string[];
    };
    compiler_zone: {
      responsibilities: string[];
    };
    executor_zone: {
      responsibilities: string[];
    };
    rule: string;
  };
  teaming: {
    specialist_id?: string;
    specialist_label?: string;
    conversation_agent?: string;
    team_roles: string[];
  };
  authority: {
    requires_approval: boolean;
  };
  learning: {
    reusable_refs: string[];
  };
}

function normalizeKnowledgeTier(value?: string): 'personal' | 'confidential' | 'public' {
  return value === 'personal' || value === 'public' ? value : 'confidential';
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function loadOutcomeCatalog(): Record<string, OutcomeDefinition> {
  const parsed = loadJson<OutcomeCatalogFile>(pathResolver.knowledge('public/governance/outcome-catalog.json'));
  const entries = parsed.outcomes || {};
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, { id, ...value }]),
  );
}

export function loadSpecialistCatalog(): Record<string, SpecialistDefinition> {
  const parsed = loadJson<SpecialistCatalogFile>(pathResolver.knowledge('public/orchestration/specialist-catalog.json'));
  const entries = parsed.specialists || {};
  return Object.fromEntries(
    Object.entries(entries).map(([id, value]) => [id, { id, ...value }]),
  );
}

function loadExecutionBoundaryProfiles(): Record<string, OrganizationWorkLoopSummary['execution_boundary']> {
  const parsed = loadJson<BoundaryProfileFile>(pathResolver.knowledge('public/governance/execution-boundary-profiles.json'));
  return parsed.profiles || {};
}

function loadRuntimeDesignProfiles(): Record<string, OrganizationWorkLoopSummary['runtime_design']> {
  const parsed = loadJson<RuntimeDesignProfileFile>(pathResolver.knowledge('public/governance/runtime-design-profiles.json'));
  return parsed.profiles || {};
}

function loadWorkPolicy(): WorkPolicyFile {
  const value = loadJson<WorkPolicyFile>(pathResolver.knowledge('public/governance/work-policy.json'));
  const validate = ensureWorkPolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid work-policy: ${errors}`);
  }
  return value;
}

function loadSpecialistRoutingPolicy(): SpecialistRoutingPolicyFile {
  return loadWorkPolicy().specialist_routing;
}

function loadWorkDesignProfileRouting(): WorkDesignProfileRoutingFile {
  return loadWorkPolicy().profile_routing;
}

function loadWorkDesignRules(): WorkDesignRulesFile {
  return loadWorkPolicy().design_rules;
}

function findIntentDefinition(intentId?: string) {
  if (!intentId) return null;
  return loadStandardIntentCatalog().find((intent: StandardIntentDefinition) => intent?.id === intentId) || null;
}

function matchesRoutingValue(value: string | undefined, expected: string[] | undefined): boolean {
  if (!expected?.length) return true;
  if (!value) return false;
  return expected.includes(value);
}

function ruleMatches(
  input: { intentId?: string; taskType?: string; queryType?: string; shape?: string; catalogShape?: string },
  match?: RoutingMatch,
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

function buildProcessDesign(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['process_design'] {
  const intentDefinition = findIntentDefinition(input.intentId);
  const planOutline = Array.isArray(intentDefinition?.plan_outline)
    ? intentDefinition!.plan_outline.map(String).filter(Boolean)
    : [];
  const intakeRequirements = Array.isArray(intentDefinition?.intake_requirements)
    ? intentDefinition!.intake_requirements.map(String).filter(Boolean)
    : [];
  const rules = loadWorkDesignRules();
  const checklistRuleInput = {
    intentId: input.intentId,
    taskType: input.taskType,
    shape: input.shape === 'task_session' || input.taskType ? 'task_session' : input.shape,
  };

  const operatorChecklist = [
    ...planOutline,
    ...(rules.process_checklist_rules || [])
      .filter((rule) => ruleMatches(checklistRuleInput, rule.match))
      .flatMap((rule) => (rule.items || []).map(String)),
  ].filter(Boolean);

  return {
    plan_outline: planOutline,
    intake_requirements: intakeRequirements,
    operator_checklist: operatorChecklist,
  };
}

function buildExecutionBoundary(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['execution_boundary'] {
  const routing = loadWorkDesignProfileRouting();
  const profiles = loadExecutionBoundaryProfiles();
  const matched = (routing.execution_boundary_rules || []).find((rule) => ruleMatches(input, rule.match));
  const defaultProfileId = routing.defaults?.execution_boundary_profile_id || 'default_governed_execution';
  return profiles[matched?.profile_id || defaultProfileId] || profiles.default_governed_execution;
}

function buildRuntimeDesign(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['runtime_design'] {
  const routing = loadWorkDesignProfileRouting();
  const profiles = loadRuntimeDesignProfiles();
  const matched = (routing.runtime_design_rules || []).find((rule) => ruleMatches(input, rule.match));
  const defaultProfileId = routing.defaults?.runtime_design_profile_id || 'single_actor_delivery';
  return profiles[matched?.profile_id || defaultProfileId] || profiles.single_actor_delivery;
}

function inferExecutionShape(input: {
  intentId?: string;
  taskType?: string;
  shape?: string;
}): OrganizationWorkLoopSummary['resolution']['execution_shape'] {
  if (input.shape) {
    if (input.shape === 'project_bootstrap' || input.shape === 'mission' || input.shape === 'task_session') {
      return input.shape;
    }
    return 'direct_reply';
  }
  const intentDefinition = findIntentDefinition(input.intentId);
  const catalogShape = intentDefinition?.resolution?.shape;
  const rules = loadWorkDesignRules();
  const matchedRule = (rules.execution_shape_rules || []).find((rule) =>
    Boolean(rule.shape) && ruleMatches({ ...input, catalogShape }, rule.match),
  );
  return matchedRule?.shape || 'direct_reply';
}

function inferIntentLabel(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
}): string {
  const rules = loadWorkDesignRules();
  const matchedRule = (rules.intent_label_rules || []).find((rule) => ruleMatches(input, rule.match));
  if (!matchedRule) return 'general_request';
  if (matchedRule.label) return matchedRule.label;
  if (matchedRule.label_from) return input[matchedRule.label_from] || 'general_request';
  return 'general_request';
}

function specialistIdForIntent(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
}): string {
  const intentDefinition = findIntentDefinition(input.intentId);
  if (typeof intentDefinition?.specialist_id === 'string' && intentDefinition.specialist_id.trim()) {
    return intentDefinition.specialist_id;
  }
  const policy = loadSpecialistRoutingPolicy();
  const matched = (policy.rules || []).find((rule) => ruleMatches(input, rule.match));
  return matched?.specialist_id || policy.fallback_specialist_id || 'surface-concierge';
}

export function resolveWorkDesign(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
  outcomeIds?: string[];
  tier?: 'personal' | 'confidential' | 'public';
}): WorkDesignSummary {
  const specialists = loadSpecialistCatalog();
  const outcomes = loadOutcomeCatalog();
  const intentDefinition = findIntentDefinition(input.intentId);
  const primary = specialists[specialistIdForIntent(input)] || null;
  const requestedOutcomeIds = (input.outcomeIds && input.outcomeIds.length)
    ? input.outcomeIds
    : (Array.isArray(intentDefinition?.outcome_ids) ? intentDefinition.outcome_ids : []);
  const tier = normalizeKnowledgeTier(input.tier);
  const resolvedOutcomes = requestedOutcomeIds
    .map((id) => outcomes[id])
    .filter((value): value is OutcomeDefinition => Boolean(value));
  const reusableRefs = listDistillCandidateRecords()
    .filter((candidate) => candidate.status === 'promoted')
    .filter((candidate) => normalizeKnowledgeTier(candidate.tier) === tier)
    .filter((candidate) => {
      if (primary?.id && candidate.specialist_id && candidate.specialist_id === primary.id) return true;
      if (input.taskType && candidate.metadata?.task_type === input.taskType) return true;
      if (requestedOutcomeIds.length && requestedOutcomeIds.some((id) => candidate.summary.includes(id) || candidate.evidence_refs?.some((ref) => ref.includes(id)))) return true;
      return false;
    })
    .slice(0, 4)
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: candidate.title,
      target_kind: candidate.target_kind,
      promoted_ref: candidate.promoted_ref,
    }));

  return {
    primary_specialist: primary,
    conversation_agent: primary?.conversation_agent || null,
    team_roles: primary?.team_roles || [],
    outcomes: resolvedOutcomes,
    reusable_refs: reusableRefs,
  };
}

export function buildOrganizationWorkLoopSummary(input: {
  intentId?: string;
  taskType?: string;
  queryType?: string;
  shape?: string;
  missionTypeHint?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
  outcomeIds?: string[];
  tier?: 'personal' | 'confidential' | 'public';
  projectId?: string;
  projectName?: string;
  trackId?: string;
  trackName?: string;
  locale?: string;
  serviceBindings?: string[];
  requiresApproval?: boolean;
}): OrganizationWorkLoopSummary {
  const tier = normalizeKnowledgeTier(input.tier);
  const executionShape = inferExecutionShape(input);
  const missionClassification = resolveMissionClassification({
    missionTypeHint: input.missionTypeHint,
    intentId: input.intentId,
    taskType: input.taskType,
    shape: executionShape,
    utterance: input.utterance,
    artifactPaths: input.artifactPaths,
    progressSignals: input.progressSignals,
  });
  const workflowDesign = resolveMissionWorkflowDesign({
    missionClass: missionClassification.mission_class,
    deliveryShape: missionClassification.delivery_shape,
    riskProfile: missionClassification.risk_profile,
    stage: missionClassification.stage,
    executionShape,
    intentId: input.intentId,
    taskType: input.taskType,
  });
  const reviewDesign = resolveMissionReviewDesign({
    missionClass: missionClassification.mission_class,
    deliveryShape: missionClassification.delivery_shape,
    riskProfile: missionClassification.risk_profile,
    workflowPattern: workflowDesign.pattern,
    stage: missionClassification.stage,
  });
  const design = resolveWorkDesign({
    intentId: input.intentId,
    taskType: input.taskType,
    queryType: input.queryType,
    shape: input.shape,
    outcomeIds: input.outcomeIds,
    tier,
  });
  return {
    intent: {
      label: inferIntentLabel(input),
    },
    context: {
      project_id: input.projectId,
      project_name: input.projectName,
      track_id: input.trackId,
      track_name: input.trackName,
      tier,
      locale: input.locale,
      service_bindings: Array.isArray(input.serviceBindings) ? input.serviceBindings : [],
    },
    resolution: {
      execution_shape: executionShape,
      task_type: input.taskType,
    },
    workflow_design: workflowDesign,
    review_design: reviewDesign,
    outcome_design: {
      outcome_ids: design.outcomes.map((outcome) => outcome.id),
      labels: design.outcomes.map((outcome) => outcome.label),
    },
    process_design: buildProcessDesign(input),
    runtime_design: buildRuntimeDesign(input),
    execution_boundary: buildExecutionBoundary(input),
    teaming: {
      specialist_id: design.primary_specialist?.id,
      specialist_label: design.primary_specialist?.label,
      conversation_agent: design.conversation_agent || undefined,
      team_roles: design.team_roles,
    },
    authority: {
      requires_approval: Boolean(input.requiresApproval),
    },
    learning: {
      reusable_refs: design.reusable_refs.map((ref) => ref.promoted_ref || ref.title),
    },
  };
}
