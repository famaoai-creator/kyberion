import * as path from 'node:path';
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { loadOrganizationProfile, type OrganizationProfile } from './organization-profile.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { listProjectRecords, loadProjectRecord } from './project-registry.js';
import { loadState } from './mission-state.js';
import { t } from './t.js';
import type { SupportedLocale } from './locale.js';
import { pathResolver } from './path-resolver.js';
import { isValidTenantSlug } from './entity-scope.js';
import { auditChain } from './audit-chain.js';
import { resolveTenant } from './tenant-registry.js';
import {
  safeExistsSync,
  loadJson,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeWriteFile,
} from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

export type OrganizationTier = 'personal' | 'confidential' | 'public';
export type OrganizationWorkShape =
  | 'solution_project'
  | 'service_operation'
  | 'routine_operation'
  | 'incident_response'
  | 'governance_cadence'
  | 'improvement_experiment';
export type OrganizationRelationshipType =
  'owns' | 'supports' | 'delivers' | 'depends_on' | 'responds_to' | 'improves' | 'governs';

export interface OrganizationOperatingModelCatalog {
  version: string;
  work_shapes: Array<{
    id: OrganizationWorkShape;
    management_unit: string;
    lifecycle: string;
    description: string;
    accountable_role?: string;
  }>;
  relationship_types: Array<{
    id: OrganizationRelationshipType;
    description: string;
  }>;
  resolution_examples: Array<{
    scenario_id: string;
    title: string;
    work_shape: OrganizationWorkShape;
    management_unit: string;
    rationale: string;
  }>;
}

export interface OrganizationPurposeObjective {
  objective_id: string;
  title: string;
  description?: string;
  horizon?: string;
  status?: 'planned' | 'active' | 'completed' | 'retired';
  owner_role?: string;
}

export interface OrganizationPurposeRecord {
  version: string;
  organization_id: string;
  name: string;
  purpose: string;
  principles?: string[];
  objectives?: OrganizationPurposeObjective[];
  tier: OrganizationTier;
  tenant_slug?: string;
  owner_role: string;
  approval_state: 'draft' | 'pending_approval' | 'approved' | 'superseded';
  updated_at: string;
  source_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrganizationServiceHealthSummary {
  healthy: number;
  degraded: number;
  critical: number;
  unknown: number;
}

export interface OrganizationOperationalState {
  organization_id: string;
  name: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  purpose_ref?: string;
  active_project_ids?: string[];
  active_operation_ids?: string[];
  open_incident_ids?: string[];
  pending_decision_ids?: string[];
  service_health_summary?: OrganizationServiceHealthSummary;
  recent_outcome_refs?: string[];
  updated_at: string;
  last_reconciled_at?: string;
  metadata?: Record<string, unknown>;
}

export interface OrganizationDomainRecord {
  version: string;
  domain_id: string;
  organization_id: string;
  name: string;
  purpose?: string;
  owner_role: string;
  capability_ids: string[];
  service_ids: string[];
  policy_refs?: string[];
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  updated_at: string;
  source_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrganizationCapabilityRecord {
  version: string;
  capability_id: string;
  organization_id: string;
  domain_id: string;
  name: string;
  description?: string;
  owner_role: string;
  service_ids: string[];
  policy_refs?: string[];
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  updated_at: string;
  source_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrganizationServiceRecord {
  version: string;
  service_id: string;
  organization_id: string;
  domain_id: string;
  name: string;
  outcome: string;
  owner_role: string;
  consumers: string[];
  slo: {
    target: string;
    measurement_window: string;
    objective?: number;
    unit?: string;
  };
  slis: Array<{
    sli_id: string;
    name: string;
    source_ref: string;
    freshness_seconds: number;
    threshold?: string;
  }>;
  runbook_refs: string[];
  escalation_path: string[];
  dependencies: string[];
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'degraded' | 'paused' | 'retired';
  updated_at: string;
  source_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrganizationServiceState {
  service_id: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  health: 'healthy' | 'degraded' | 'critical' | 'unknown';
  observed_at: string;
  source_timestamp: string;
  freshness_seconds: number;
  confidence: number;
  active_project_ids?: string[];
  active_operation_ids?: string[];
  open_incident_ids?: string[];
  last_outcome_refs?: string[];
  reconcile_status: 'current' | 'stale' | 'missing_source' | 'conflict' | 'unknown';
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export type OrganizationOperationType = 'continuous' | 'scheduled' | 'event_driven' | 'governance';

export interface OrganizationOperationRecord {
  version: string;
  operation_id: string;
  organization_id: string;
  service_id?: string;
  capability_id?: string;
  name: string;
  purpose?: string;
  operation_type: OrganizationOperationType;
  owner_role: string;
  trigger: {
    kind: 'schedule' | 'event' | 'manual' | 'cadence';
    expression?: string;
    event_ref?: string;
    timezone?: string;
  };
  automation_boundary: {
    allowed_actions: string[];
    approval_required_actions: string[];
    forbidden_actions: string[];
  };
  escalation_path: string[];
  evidence_outputs: string[];
  execution_target: {
    kind: 'mission' | 'task_session' | 'pipeline' | 'actuator';
    ref?: string;
  };
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  updated_at: string;
  source_refs?: string[];
  metadata?: Record<string, unknown>;
}

export interface OrganizationOperationState {
  operation_id: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'paused';
  due_status: 'current' | 'due' | 'overdue' | 'not_scheduled' | 'unknown';
  last_run_at?: string;
  next_due_at?: string;
  last_result_summary?: string;
  last_evidence_refs?: string[];
  exception_refs?: string[];
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface OrganizationOperationRun {
  run_id: string;
  operation_id: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'started' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  started_at: string;
  completed_at?: string;
  execution_ref?: string;
  result_summary?: string;
  evidence_refs?: string[];
  exception_refs?: string[];
  recorded_at: string;
  metadata?: Record<string, unknown>;
}

export type OrganizationManagementUnit =
  'project' | 'service' | 'operation' | 'incident' | 'cadence' | 'experiment' | 'task_session';

export interface OrganizationWorkResolution {
  kind: 'organization_work_resolution';
  utterance: string;
  organization_id: string;
  tenant_slug?: string;
  tier?: OrganizationTier;
  work_shape: OrganizationWorkShape;
  management_unit: OrganizationManagementUnit;
  context_refs?: {
    domain_id?: string;
    service_id?: string;
    operation_id?: string;
    project_id?: string;
    incident_id?: string;
    cadence_id?: string;
  };
  selected_intent_id?: string;
  selected_confidence?: number;
  proposed_parent?: {
    kind: Exclude<OrganizationManagementUnit, 'task_session'>;
    id?: string;
    reason?: string;
  };
  confidence: number;
  authority_class: 'low' | 'normal' | 'high' | 'approval_required';
  human_decision: 'pending' | 'accepted' | 'corrected' | 'rejected';
  reasons: string[];
  next_questions: string[];
  dry_run: true;
}

export interface OrganizationIncidentRecord {
  version: string;
  incident_id: string;
  organization_id: string;
  service_id?: string;
  operation_id?: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'detected' | 'triaging' | 'mitigating' | 'resolved' | 'closed';
  owner_role: string;
  impact_summary: string;
  trigger_refs?: string[];
  mitigation_mission_id?: string;
  post_incident_review_ref?: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface OrganizationCadenceRecord {
  version: string;
  cadence_id: string;
  organization_id: string;
  name: string;
  cadence_type: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'ad_hoc';
  schedule: string;
  owner_role: string;
  decision_ids: string[];
  tier: OrganizationTier;
  tenant_slug?: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface OrganizationDecisionRecord {
  version: string;
  decision_id: string;
  organization_id: string;
  cadence_id: string;
  title: string;
  decision_type?:
    | 'approval'
    | 'policy_change'
    | 'slo_change'
    | 'automation_boundary'
    | 'prioritization'
    | 'review';
  status: 'proposed' | 'pending_approval' | 'approved' | 'rejected' | 'deferred' | 'implemented';
  requested_by?: string;
  decision_owner: string;
  due_at: string;
  options: string[];
  chosen_option?: string;
  rationale?: string;
  approval_refs?: string[];
  follow_up_refs: string[];
  tier: OrganizationTier;
  tenant_slug?: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export type OrganizationLearningSourceType =
  'incident_review' | 'routine_exception' | 'project_closure' | 'governance_decision';

export interface OrganizationLearningCandidate {
  version: string;
  learning_id: string;
  organization_id: string;
  source_type: OrganizationLearningSourceType;
  source_ref: string;
  title: string;
  summary: string;
  evidence_refs: string[];
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  status: 'proposed' | 'approved' | 'rejected' | 'promoted';
  tier: OrganizationTier;
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface QueueOrganizationLearningCandidateInput {
  learningId: string;
  organizationId: string;
  sourceType: OrganizationLearningSourceType;
  sourceRef: string;
  title: string;
  summary: string;
  evidenceRefs?: string[];
  targetKind: OrganizationLearningCandidate['target_kind'];
  tier: OrganizationTier;
  tenantSlug?: string;
  metadata?: Record<string, unknown>;
  rootDir?: string;
}

export interface OrganizationCatalog {
  version: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  domains: OrganizationDomainRecord[];
  capabilities: OrganizationCapabilityRecord[];
  services: OrganizationServiceRecord[];
}

export interface OrganizationCatalogReconciliation {
  status: 'clean' | 'attention';
  missing_capabilities: string[];
  missing_services: string[];
  orphan_capabilities: string[];
  orphan_services: string[];
  services_without_state: string[];
  stale_services: string[];
  invalid_runbook_refs: string[];
  missing_operation_services: string[];
  operations_without_state: string[];
  overdue_operations: string[];
  missing_incident_services: string[];
  missing_incident_operations: string[];
  missing_decision_cadences: string[];
  pending_decisions: string[];
  missing_project_refs: string[];
  invalid_execution_refs: string[];
  invalid_evidence_refs: string[];
}

export interface OrganizationProjectLineage {
  project_id: string;
  name: string;
  status: string;
  tier: OrganizationTier;
  role: 'solution_project';
  track_ids: string[];
  mission_ids: string[];
  task_session_ids: string[];
}

export interface OrganizationLineage {
  nodes: Array<{
    id: string;
    kind:
      | 'organization'
      | 'domain'
      | 'capability'
      | 'service'
      | 'operation'
      | 'incident'
      | 'cadence'
      | 'decision'
      | 'project'
      | 'mission';
  }>;
  edges: Array<{
    from: string;
    to: string;
    relationship: OrganizationRelationshipType;
  }>;
}

export interface OrganizationReconciliationResult {
  mode: 'dry_run' | 'apply';
  reconciliation: OrganizationCatalogReconciliation;
  actions: Array<{
    action: 'refresh_operational_summary';
    reason: string;
    target: string;
  }>;
  blocked_issues: string[];
  updated_paths: string[];
}

export interface OrganizationManagementView {
  organization_id: string;
  profile: OrganizationProfile | null;
  purpose: OrganizationPurposeRecord | null;
  operational_state: OrganizationOperationalState | null;
  domains: OrganizationDomainRecord[];
  capabilities: OrganizationCapabilityRecord[];
  services: OrganizationServiceRecord[];
  service_states: OrganizationServiceState[];
  operations: OrganizationOperationRecord[];
  operation_states: OrganizationOperationState[];
  incidents: OrganizationIncidentRecord[];
  cadences: OrganizationCadenceRecord[];
  decisions: OrganizationDecisionRecord[];
  solution_projects: OrganizationProjectLineage[];
  lineage: OrganizationLineage;
  learning_candidates: OrganizationLearningCandidate[];
  reconciliation: OrganizationCatalogReconciliation;
  catalog_version: string;
  control_plane: {
    accounting: {
      active_projects: number;
      active_services: number;
      healthy_services: number;
      degraded_or_critical_services: number;
      active_operations: number;
      overdue_operations: number;
      open_incidents: number;
      pending_decisions: number;
    };
    outcome_accounting: {
      objectives: Array<{
        objective_id: string;
        title: string;
        coverage: 'linked' | 'unlinked';
        refs: string[];
      }>;
      services: Array<{
        service_id: string;
        outcome: string;
        health: OrganizationServiceState['health'] | OrganizationServiceRecord['status'];
        refs: string[];
      }>;
      operations: Array<{
        operation_id: string;
        result_summary?: string;
        evidence_refs: string[];
      }>;
    };
    intervention_points: Array<{
      kind: 'reconciliation' | 'project' | 'incident' | 'decision' | 'operation';
      id: string;
      priority: 'high' | 'medium' | 'low';
      reason: string;
    }>;
    learning_refs: string[];
  };
  readiness: {
    purpose: 'missing' | 'draft' | 'approved';
    operational_state: 'missing' | 'available';
    pending_human_decisions: number;
  };
}

export interface ResolveOrganizationWorkInput {
  utterance: string;
  organizationId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  contextRefs?: OrganizationWorkResolution['context_refs'];
  locale?: SupportedLocale;
}

const ORGANIZATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CATALOG_PATH = pathResolver.knowledge(
  'product/orchestration/organization-operating-model.json'
);
const CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operating-model.schema.json'
);
const PURPOSE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-purpose.schema.json'
);
const STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operational-state.schema.json'
);
const DOMAIN_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-domain.schema.json'
);
const CAPABILITY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-capability.schema.json'
);
const SERVICE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-service.schema.json'
);
const SERVICE_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-service-state.schema.json'
);
const OPERATION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operation.schema.json'
);
const OPERATION_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operation-state.schema.json'
);
const OPERATION_RUN_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-operation-run.schema.json'
);
const WORK_RESOLUTION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-work-resolution.schema.json'
);
const INCIDENT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-incident.schema.json'
);
const CADENCE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-cadence.schema.json'
);
const DECISION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-decision.schema.json'
);
const LEARNING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-learning-candidate.schema.json'
);
const PURPOSE_FILE_NAME = 'purpose.json';
const STATE_FILE_NAME = 'organization-state.json';
const DOMAIN_FILE_NAME = 'domain.json';
const CAPABILITY_FILE_NAME = 'capability.json';
const SERVICE_FILE_NAME = 'service.json';
const SERVICE_STATE_FILE_NAME = 'service-state.json';
const OPERATION_FILE_NAME = 'operation.json';
const OPERATION_STATE_FILE_NAME = 'operation-state.json';
const OPERATION_RUN_FILE_NAME = 'run.json';
const INCIDENT_FILE_NAME = 'incident.json';
const CADENCE_FILE_NAME = 'cadence.json';
const DECISION_FILE_NAME = 'decision.json';
const LEARNING_FILE_NAME = 'candidate.json';
const validatorCache = new Map<string, ValidateFunction>();

function validatorFor(schemaPath: string): ValidateFunction {
  const cached = validatorCache.get(schemaPath);
  if (cached) return cached;
  const validator = ajv.compile(loadJson<unknown>(schemaPath));
  validatorCache.set(schemaPath, validator);
  return validator;
}

function validationErrors(validator: ValidateFunction): string {
  return (validator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
    .join('; ');
}

function assertOrganizationId(organizationId: string): void {
  if (!ORGANIZATION_ID_RE.test(organizationId)) {
    throw new Error(`Invalid organization_id '${organizationId}'.`);
  }
}

function assertTenantSlug(tenantSlug: string): void {
  if (tenantSlug !== 'shared' && !isValidTenantSlug(tenantSlug)) {
    throw new Error(`Invalid tenant_slug '${tenantSlug}'.`);
  }
}

function recordTenant(record: { tenant_slug?: string }): string {
  const tenantSlug = record.tenant_slug?.trim() || 'shared';
  assertTenantSlug(tenantSlug);
  return tenantSlug;
}

function assertRecordIdentity(
  record: {
    organization_id: string;
    tier?: OrganizationTier;
    tenant_slug?: string;
  },
  rootDir?: string
): void {
  assertOrganizationId(record.organization_id);
  if (record.tier === 'confidential' && !record.tenant_slug?.trim()) {
    throw new Error(
      `tenant_slug is required for confidential organization records (${record.organization_id}).`
    );
  }
  if (record.tier === 'confidential' && record.tenant_slug === 'shared') {
    throw new Error(
      `tenant_slug 'shared' is not a tenant for confidential organization records (${record.organization_id}).`
    );
  }
  recordTenant(record);
  if (
    record.tenant_slug &&
    (process.env.KYBERION_ENTITY_GOVERNANCE === 'enforce' || !process.env.VITEST)
  ) {
    resolveTenant(record.tenant_slug, { rootDir });
  }
}

function statePath(
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  assertOrganizationId(organizationId);
  assertTenantSlug(tenantSlug);
  return path.join(
    pathResolver.organizationStateDir(organizationId, tier, tenantSlug, rootDir),
    STATE_FILE_NAME
  );
}

function purposePath(
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  assertOrganizationId(organizationId);
  assertTenantSlug(tenantSlug);
  return path.join(
    pathResolver.organizationStateDir(organizationId, tier, tenantSlug, rootDir),
    PURPOSE_FILE_NAME
  );
}

type OrganizationRecordKind =
  | 'domains'
  | 'capabilities'
  | 'services'
  | 'operations'
  | 'incidents'
  | 'cadences'
  | 'decisions'
  | 'learning';

function recordPath(
  kind: OrganizationRecordKind,
  recordId: string,
  fileName: string,
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  assertOrganizationId(recordId);
  assertOrganizationId(organizationId);
  assertTenantSlug(tenantSlug);
  return path.join(
    pathResolver.organizationStateDir(organizationId, tier, tenantSlug, rootDir),
    kind,
    recordId,
    fileName
  );
}

function recordQueryTiers(tier?: OrganizationTier): OrganizationTier[] {
  return tier ? [tier] : ['personal', 'confidential', 'public'];
}

function recordQueryTenant(tenantSlug?: string): string {
  const tenant = tenantSlug || 'shared';
  assertTenantSlug(tenant);
  return tenant;
}

function readJsonRecord<T>(filePath: string, label: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return loadJson<T>(filePath);
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${String(error)}`);
  }
}

function saveValidated<T>(record: T, schemaPath: string, filePath: string, label: string): string {
  const validator = validatorFor(schemaPath);
  if (!validator(record)) throw new Error(`Invalid ${label}: ${validationErrors(validator)}`);
  const parent = path.dirname(filePath);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8' });
  return filePath;
}

export function loadOrganizationOperatingModelCatalog(): OrganizationOperatingModelCatalog {
  const catalog = loadJson<unknown>(CATALOG_PATH);
  const validator = validatorFor(CATALOG_SCHEMA_PATH);
  if (!validator(catalog))
    throw new Error(`Invalid organization operating model: ${validationErrors(validator)}`);
  return catalog as OrganizationOperatingModelCatalog;
}

export function validateOrganizationPurpose(value: unknown): value is OrganizationPurposeRecord {
  return Boolean(validatorFor(PURPOSE_SCHEMA_PATH)(value));
}

export function validateOrganizationOperationalState(
  value: unknown
): value is OrganizationOperationalState {
  return Boolean(validatorFor(STATE_SCHEMA_PATH)(value));
}

export function validateOrganizationDomain(value: unknown): value is OrganizationDomainRecord {
  return Boolean(validatorFor(DOMAIN_SCHEMA_PATH)(value));
}

export function validateOrganizationCapability(
  value: unknown
): value is OrganizationCapabilityRecord {
  return Boolean(validatorFor(CAPABILITY_SCHEMA_PATH)(value));
}

export function validateOrganizationService(value: unknown): value is OrganizationServiceRecord {
  return Boolean(validatorFor(SERVICE_SCHEMA_PATH)(value));
}

export function validateOrganizationServiceState(
  value: unknown
): value is OrganizationServiceState {
  return Boolean(validatorFor(SERVICE_STATE_SCHEMA_PATH)(value));
}

export function validateOrganizationOperation(
  value: unknown
): value is OrganizationOperationRecord {
  return Boolean(validatorFor(OPERATION_SCHEMA_PATH)(value));
}

export function validateOrganizationOperationState(
  value: unknown
): value is OrganizationOperationState {
  return Boolean(validatorFor(OPERATION_STATE_SCHEMA_PATH)(value));
}

export function validateOrganizationOperationRun(
  value: unknown
): value is OrganizationOperationRun {
  return Boolean(validatorFor(OPERATION_RUN_SCHEMA_PATH)(value));
}

export function validateOrganizationWorkResolution(
  value: unknown
): value is OrganizationWorkResolution {
  return Boolean(validatorFor(WORK_RESOLUTION_SCHEMA_PATH)(value));
}

export function validateOrganizationIncident(value: unknown): value is OrganizationIncidentRecord {
  return Boolean(validatorFor(INCIDENT_SCHEMA_PATH)(value));
}

export function validateOrganizationCadence(value: unknown): value is OrganizationCadenceRecord {
  return Boolean(validatorFor(CADENCE_SCHEMA_PATH)(value));
}

export function validateOrganizationDecision(value: unknown): value is OrganizationDecisionRecord {
  return Boolean(validatorFor(DECISION_SCHEMA_PATH)(value));
}

export function validateOrganizationLearningCandidate(
  value: unknown
): value is OrganizationLearningCandidate {
  return Boolean(validatorFor(LEARNING_SCHEMA_PATH)(value));
}

function classifyOrganizationWork(
  utterance: string,
  selectedTaskKind?: string
): {
  workShape: OrganizationWorkShape;
  managementUnit: Exclude<OrganizationManagementUnit, 'task_session'>;
  confidence: number;
  reasonKey: string;
} {
  const normalized = utterance.toLocaleLowerCase();
  const rules: Array<{
    workShape: OrganizationWorkShape;
    managementUnit: Exclude<OrganizationManagementUnit, 'task_session'>;
    confidence: number;
    pattern: RegExp;
    reasonKey: string;
  }> = [
    {
      workShape: 'incident_response',
      managementUnit: 'incident',
      confidence: 0.93,
      pattern: /障害|インシデント|緊急|停止|エラー|outage|incident|emergency|down/,
      reasonKey: 'organization:organization_resolution_reason_incident',
    },
    {
      workShape: 'governance_cadence',
      managementUnit: 'cadence',
      confidence: 0.9,
      pattern: /経営会議|レビュー|承認|決裁|監査|予算|方針|governance|review|approval|audit|budget/,
      reasonKey: 'organization:organization_resolution_reason_governance',
    },
    {
      workShape: 'routine_operation',
      managementUnit: 'operation',
      confidence: 0.88,
      pattern:
        /月次|週次|毎日|定期|定常|請求|レポート|監視|daily|weekly|monthly|routine|scheduled|report|monitor/,
      reasonKey: 'organization:organization_resolution_reason_routine',
    },
    {
      workShape: 'service_operation',
      managementUnit: 'service',
      confidence: 0.84,
      pattern: /サービス|窓口|運用|顧客対応|サポート|support|service|customer/,
      reasonKey: 'organization:organization_resolution_reason_service',
    },
    {
      workShape: 'improvement_experiment',
      managementUnit: 'experiment',
      confidence: 0.82,
      pattern: /改善|試す|実験|パイロット|pilot|experiment|optimize|improve/,
      reasonKey: 'organization:organization_resolution_reason_experiment',
    },
    {
      workShape: 'solution_project',
      managementUnit: 'project',
      confidence: 0.8,
      pattern: /作る|開発|構築|導入|新しい|project|build|develop|implement|launch/,
      reasonKey: 'organization:organization_resolution_reason_project',
    },
  ];
  const matched = rules.find((rule) => rule.pattern.test(normalized));
  if (matched) return matched;
  if (selectedTaskKind === 'project_bootstrap' || selectedTaskKind === 'mission') {
    return {
      workShape: 'solution_project',
      managementUnit: 'project',
      confidence: 0.62,
      reasonKey: 'organization:organization_resolution_reason_fallback_project',
    };
  }
  if (selectedTaskKind === 'task_session') {
    return {
      workShape: 'service_operation',
      managementUnit: 'service',
      confidence: 0.58,
      reasonKey: 'organization:organization_resolution_reason_fallback_service',
    };
  }
  return {
    workShape: 'routine_operation',
    managementUnit: 'operation',
    confidence: 0.4,
    reasonKey: 'organization:organization_resolution_reason_fallback_routine',
  };
}

export function resolveOrganizationWork(
  input: ResolveOrganizationWorkInput
): OrganizationWorkResolution {
  assertOrganizationId(input.organizationId);
  const tenantSlug = input.tenantSlug || 'shared';
  assertTenantSlug(tenantSlug);
  const utterance = input.utterance.trim();
  if (!utterance) throw new Error('utterance is required.');
  const packet = resolveIntentResolutionPacket(utterance, {
    tier: input.tier,
    tenantId: tenantSlug === 'shared' ? undefined : tenantSlug,
  });
  const classification = classifyOrganizationWork(
    utterance,
    packet.selected_resolution?.task_kind || packet.selected_resolution?.shape
  );
  const contextRefs = input.contextRefs;
  const parentId =
    classification.managementUnit === 'project'
      ? contextRefs?.project_id
      : classification.managementUnit === 'service'
        ? contextRefs?.service_id
        : classification.managementUnit === 'operation'
          ? contextRefs?.operation_id
          : classification.managementUnit === 'incident'
            ? contextRefs?.incident_id
            : classification.managementUnit === 'cadence'
              ? contextRefs?.cadence_id
              : undefined;
  const authorityClass =
    classification.workShape === 'governance_cadence' ||
    /承認|決裁|変更|削除|停止|権限|approve|approval|change|delete|disable/i.test(utterance)
      ? 'approval_required'
      : classification.workShape === 'incident_response'
        ? 'high'
        : classification.confidence < 0.7
          ? 'low'
          : 'normal';
  const nextQuestions: string[] = [];
  if (!parentId) {
    const parentLabel = {
      project: 'project_id',
      service: 'service_id',
      operation: 'operation_id',
      incident: 'incident_id',
      cadence: 'cadence_id',
      experiment: 'experiment_id',
    }[classification.managementUnit];
    if (parentLabel) {
      nextQuestions.push(
        t(
          'organization:organization_resolution_parent_question',
          { parent: parentLabel },
          input.locale
        )
      );
    }
  }
  if (classification.confidence < 0.7) {
    nextQuestions.push(
      t('organization:organization_resolution_confirmation_question', undefined, input.locale)
    );
  }
  if (authorityClass === 'high' || authorityClass === 'approval_required') {
    nextQuestions.push(
      t('organization:organization_resolution_approval_question', undefined, input.locale)
    );
  }
  const result: OrganizationWorkResolution = {
    kind: 'organization_work_resolution',
    utterance,
    organization_id: input.organizationId,
    ...(tenantSlug !== 'shared' ? { tenant_slug: tenantSlug } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
    work_shape: classification.workShape,
    management_unit: classification.managementUnit,
    ...(contextRefs ? { context_refs: contextRefs } : {}),
    ...(packet.selected_intent_id ? { selected_intent_id: packet.selected_intent_id } : {}),
    ...(packet.selected_confidence !== undefined
      ? { selected_confidence: packet.selected_confidence }
      : {}),
    proposed_parent: {
      kind: classification.managementUnit,
      ...(parentId ? { id: parentId } : {}),
      reason: parentId
        ? t('organization:organization_resolution_context_adopted', undefined, input.locale)
        : t(classification.reasonKey as Parameters<typeof t>[0], undefined, input.locale),
    },
    confidence: classification.confidence,
    authority_class: authorityClass,
    human_decision: 'pending',
    reasons: [
      t(classification.reasonKey as Parameters<typeof t>[0], undefined, input.locale),
      ...(packet.selected_intent_id
        ? [
            t(
              'organization:organization_resolution_standard_intent',
              { intent: packet.selected_intent_id },
              input.locale
            ),
          ]
        : [t('organization:organization_resolution_no_standard_intent', undefined, input.locale)]),
      t('organization:organization_resolution_proposal_notice', undefined, input.locale),
    ],
    next_questions: nextQuestions,
    dry_run: true,
  };
  if (!validateOrganizationWorkResolution(result)) {
    throw new Error(
      `Invalid organization work resolution: ${validationErrors(validatorFor(WORK_RESOLUTION_SCHEMA_PATH))}`
    );
  }
  return result;
}

export function organizationPurposePath(
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  return purposePath(organizationId, tier, tenantSlug, rootDir);
}

export function organizationOperationalStatePath(
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  return statePath(organizationId, tier, tenantSlug, rootDir);
}

export function saveOrganizationPurpose(
  record: OrganizationPurposeRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    PURPOSE_SCHEMA_PATH,
    purposePath(record.organization_id, record.tier, recordTenant(record), options.rootDir),
    'organization purpose'
  );
}

export function loadOrganizationPurpose(
  organizationId: string,
  query: { tier?: OrganizationTier; tenantSlug?: string; rootDir?: string } = {}
): OrganizationPurposeRecord | null {
  assertOrganizationId(organizationId);
  const tiers: OrganizationTier[] = query.tier
    ? [query.tier]
    : ['personal', 'confidential', 'public'];
  const tenantSlug = query.tenantSlug || 'shared';
  assertTenantSlug(tenantSlug);
  for (const tier of tiers) {
    const record = readJsonRecord<OrganizationPurposeRecord>(
      purposePath(organizationId, tier, tenantSlug, query.rootDir),
      'organization purpose'
    );
    if (record && validateOrganizationPurpose(record) && record.organization_id === organizationId)
      return record;
  }
  return null;
}

export function saveOrganizationOperationalState(
  record: OrganizationOperationalState,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    STATE_SCHEMA_PATH,
    statePath(record.organization_id, record.tier, recordTenant(record), options.rootDir),
    'organization operational state'
  );
}

export type OrganizationLifecycleVerb = 'pause' | 'resume' | 'archive';

export function transitionOrganizationLifecycle(input: {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
  verb: OrganizationLifecycleVerb;
  reason?: string;
}): OrganizationOperationalState {
  const current = loadOrganizationOperationalState(input.organizationId, input);
  if (!current) throw new Error(`Organization not found: ${input.organizationId}`);
  const expected = input.verb === 'pause' ? 'active' : input.verb === 'resume' ? 'paused' : null;
  if (expected && current.status !== expected) {
    throw new Error(
      `Organization '${input.organizationId}' is ${current.status}; expected ${expected}.`
    );
  }
  if (input.verb === 'archive' && (current.active_project_ids || []).length > 0) {
    throw new Error(
      `Cannot archive organization with active projects: ${current.active_project_ids!.join(', ')}`
    );
  }
  const next: OrganizationOperationalState = {
    ...current,
    status: input.verb === 'pause' ? 'paused' : input.verb === 'resume' ? 'active' : 'archived',
    updated_at: new Date().toISOString(),
    metadata: {
      ...(current.metadata || {}),
      ...(input.verb === 'archive' ? { archived_at: new Date().toISOString() } : {}),
      ...(input.reason ? { lifecycle_reason: input.reason } : {}),
    },
  };
  saveOrganizationOperationalState(next, { rootDir: input.rootDir });
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'organization_controller',
    action: `organization.${input.verb}`,
    operation: `${input.verb}:${input.organizationId}`,
    result: 'completed',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    metadata: { organization_id: input.organizationId, reason: input.reason },
  });
  return next;
}

export type OrganizationRetireKind = 'domain' | 'capability' | 'service' | 'operation' | 'cadence';

export function retireOrganizationEntity(input: {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
  kind: OrganizationRetireKind;
  recordId: string;
  reason?: string;
}): Record<string, unknown> {
  const query = {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  };
  let record: any;
  if (input.kind === 'domain') record = loadOrganizationDomain(input.recordId, query);
  else if (input.kind === 'capability') record = loadOrganizationCapability(input.recordId, query);
  else if (input.kind === 'service') record = loadOrganizationService(input.recordId, query);
  else if (input.kind === 'operation') record = loadOrganizationOperation(input.recordId, query);
  else
    record = listOrganizationCadences(query).find((entry) => entry.cadence_id === input.recordId);
  if (!record) throw new Error(`${input.kind} not found: ${input.recordId}`);
  const catalog = loadOrganizationCatalog(query);
  const relationRecord = record as { capability_ids?: string[]; service_ids?: string[] };
  if (
    input.kind === 'domain' &&
    ((relationRecord.capability_ids || []).length || (relationRecord.service_ids || []).length)
  ) {
    throw new Error(`Cannot retire domain '${input.recordId}' while child records remain.`);
  }
  if (input.kind === 'capability' && (relationRecord.service_ids || []).length) {
    throw new Error(
      `Cannot retire capability '${input.recordId}' while service references remain.`
    );
  }
  if (
    input.kind === 'service' &&
    catalog.domains.some((domain) => domain.service_ids.includes(input.recordId))
  ) {
    throw new Error(`Cannot retire service '${input.recordId}' while a domain references it.`);
  }
  const next = {
    ...record,
    status: 'retired',
    updated_at: new Date().toISOString(),
    metadata: {
      ...(record.metadata || {}),
      ...(input.reason ? { retire_reason: input.reason } : {}),
    },
  };
  if (input.kind === 'domain') saveOrganizationDomain(next, { rootDir: input.rootDir });
  else if (input.kind === 'capability')
    saveOrganizationCapability(next, { rootDir: input.rootDir });
  else if (input.kind === 'service') saveOrganizationService(next, { rootDir: input.rootDir });
  else if (input.kind === 'operation') saveOrganizationOperation(next, { rootDir: input.rootDir });
  else saveOrganizationCadence(next, { rootDir: input.rootDir });
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'organization_controller',
    action: `organization.${input.kind}.retire`,
    operation: `retire:${input.recordId}`,
    result: 'completed',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    metadata: { organization_id: input.organizationId, reason: input.reason },
  });
  return next;
}

/**
 * Destructive removal is an explicit, fail-closed lifecycle verb. Callers
 * must choose it deliberately; ordinary lifecycle transitions use retire.
 */
export function removeOrganizationEntity(input: {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
  kind: OrganizationRetireKind;
  recordId: string;
  reason?: string;
}): { status: 'removed'; kind: OrganizationRetireKind; record_id: string } {
  const query = {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  };
  const record =
    input.kind === 'domain'
      ? loadOrganizationDomain(input.recordId, query)
      : input.kind === 'capability'
        ? loadOrganizationCapability(input.recordId, query)
        : input.kind === 'service'
          ? loadOrganizationService(input.recordId, query)
          : input.kind === 'operation'
            ? loadOrganizationOperation(input.recordId, query)
            : listOrganizationCadences(query).find((entry) => entry.cadence_id === input.recordId);
  if (!record) throw new Error(`${input.kind} not found: ${input.recordId}`);

  const catalog = loadOrganizationCatalog(query);
  const relationRecord = record as { capability_ids?: string[]; service_ids?: string[] };
  if (
    input.kind === 'domain' &&
    ((relationRecord.capability_ids || []).length || (relationRecord.service_ids || []).length)
  ) {
    throw new Error(`Cannot remove domain '${input.recordId}' while child records remain.`);
  }
  if (input.kind === 'capability' && (relationRecord.service_ids || []).length) {
    throw new Error(
      `Cannot remove capability '${input.recordId}' while service references remain.`
    );
  }
  if (
    input.kind === 'service' &&
    catalog.domains.some((domain) => domain.service_ids.includes(input.recordId))
  ) {
    throw new Error(`Cannot remove service '${input.recordId}' while a domain references it.`);
  }

  const fileName =
    input.kind === 'domain'
      ? DOMAIN_FILE_NAME
      : input.kind === 'capability'
        ? CAPABILITY_FILE_NAME
        : input.kind === 'service'
          ? SERVICE_FILE_NAME
          : input.kind === 'operation'
            ? OPERATION_FILE_NAME
            : CADENCE_FILE_NAME;
  const kindDirectory =
    input.kind === 'domain'
      ? 'domains'
      : input.kind === 'capability'
        ? 'capabilities'
        : input.kind === 'service'
          ? 'services'
          : input.kind === 'operation'
            ? 'operations'
            : 'cadences';
  safeRmSync(
    recordPath(
      kindDirectory,
      input.recordId,
      fileName,
      input.organizationId,
      input.tier,
      recordTenant(record),
      input.rootDir
    ),
    { force: true }
  );
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'organization_controller',
    action: `organization.${input.kind}.remove`,
    operation: `remove:${input.recordId}`,
    result: 'completed',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    metadata: { organization_id: input.organizationId, reason: input.reason },
  });
  return { status: 'removed', kind: input.kind, record_id: input.recordId };
}

export function loadOrganizationOperationalState(
  organizationId: string,
  query: { tier?: OrganizationTier; tenantSlug?: string; rootDir?: string } = {}
): OrganizationOperationalState | null {
  assertOrganizationId(organizationId);
  const tiers: OrganizationTier[] = query.tier
    ? [query.tier]
    : ['personal', 'confidential', 'public'];
  const tenantSlug = query.tenantSlug || 'shared';
  assertTenantSlug(tenantSlug);
  for (const tier of tiers) {
    const record = readJsonRecord<OrganizationOperationalState>(
      statePath(organizationId, tier, tenantSlug, query.rootDir),
      'organization operational state'
    );
    if (
      record &&
      validateOrganizationOperationalState(record) &&
      record.organization_id === organizationId
    )
      return record;
  }
  return null;
}

export function saveOrganizationDomain(
  record: OrganizationDomainRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    DOMAIN_SCHEMA_PATH,
    recordPath(
      'domains',
      record.domain_id,
      DOMAIN_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization domain'
  );
}

export function saveOrganizationCapability(
  record: OrganizationCapabilityRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    CAPABILITY_SCHEMA_PATH,
    recordPath(
      'capabilities',
      record.capability_id,
      CAPABILITY_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization capability'
  );
}

export function saveOrganizationService(
  record: OrganizationServiceRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    SERVICE_SCHEMA_PATH,
    recordPath(
      'services',
      record.service_id,
      SERVICE_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization service'
  );
}

export function saveOrganizationServiceState(
  record: OrganizationServiceState,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    SERVICE_STATE_SCHEMA_PATH,
    recordPath(
      'services',
      record.service_id,
      SERVICE_STATE_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization service state'
  );
}

export function loadOrganizationDomain(
  domainId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationDomainRecord | null {
  assertOrganizationId(domainId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationDomainRecord>(
      recordPath(
        'domains',
        domainId,
        DOMAIN_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization domain'
    );
    if (record && validateOrganizationDomain(record) && record.domain_id === domainId)
      return record;
  }
  return null;
}

export function loadOrganizationCapability(
  capabilityId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationCapabilityRecord | null {
  assertOrganizationId(capabilityId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationCapabilityRecord>(
      recordPath(
        'capabilities',
        capabilityId,
        CAPABILITY_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization capability'
    );
    if (record && validateOrganizationCapability(record) && record.capability_id === capabilityId)
      return record;
  }
  return null;
}

export function loadOrganizationService(
  serviceId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationServiceRecord | null {
  assertOrganizationId(serviceId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationServiceRecord>(
      recordPath(
        'services',
        serviceId,
        SERVICE_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization service'
    );
    if (
      record &&
      validateOrganizationService(record) &&
      record.service_id === serviceId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

export function loadOrganizationServiceState(
  serviceId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationServiceState | null {
  assertOrganizationId(serviceId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationServiceState>(
      recordPath(
        'services',
        serviceId,
        SERVICE_STATE_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization service state'
    );
    if (
      record &&
      validateOrganizationServiceState(record) &&
      record.service_id === serviceId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

function operationDirectory(
  operationId: string,
  organizationId: string,
  tier: OrganizationTier,
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  return path.dirname(
    recordPath(
      'operations',
      operationId,
      OPERATION_FILE_NAME,
      organizationId,
      tier,
      tenantSlug,
      rootDir
    )
  );
}

export function saveOrganizationOperation(
  record: OrganizationOperationRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    OPERATION_SCHEMA_PATH,
    recordPath(
      'operations',
      record.operation_id,
      OPERATION_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization operation'
  );
}

export function saveOrganizationOperationState(
  record: OrganizationOperationState,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    OPERATION_STATE_SCHEMA_PATH,
    path.join(
      operationDirectory(
        record.operation_id,
        record.organization_id,
        record.tier,
        recordTenant(record),
        options.rootDir
      ),
      OPERATION_STATE_FILE_NAME
    ),
    'organization operation state'
  );
}

export function saveOrganizationOperationRun(
  record: OrganizationOperationRun,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  assertOrganizationId(record.run_id);
  return saveValidated(
    record,
    OPERATION_RUN_SCHEMA_PATH,
    path.join(
      operationDirectory(
        record.operation_id,
        record.organization_id,
        record.tier,
        recordTenant(record),
        options.rootDir
      ),
      'runs',
      record.run_id,
      OPERATION_RUN_FILE_NAME
    ),
    'organization operation run'
  );
}

export function loadOrganizationOperation(
  operationId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationOperationRecord | null {
  assertOrganizationId(operationId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationOperationRecord>(
      recordPath(
        'operations',
        operationId,
        OPERATION_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization operation'
    );
    if (
      record &&
      validateOrganizationOperation(record) &&
      record.operation_id === operationId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

export function loadOrganizationOperationState(
  operationId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationOperationState | null {
  assertOrganizationId(operationId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationOperationState>(
      path.join(
        operationDirectory(operationId, query.organizationId, tier, tenantSlug, query.rootDir),
        OPERATION_STATE_FILE_NAME
      ),
      'organization operation state'
    );
    if (
      record &&
      validateOrganizationOperationState(record) &&
      record.operation_id === operationId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

export function listOrganizationOperations(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
    status?: OrganizationOperationRecord['status'];
  } = {}
): OrganizationOperationRecord[] {
  return listOrganizationRecordFiles('operations', OPERATION_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationOperationRecord>(filePath, 'organization operation')
    )
    .filter((record): record is OrganizationOperationRecord =>
      Boolean(record && validateOrganizationOperation(record))
    )
    .filter((record) => !query.status || record.status === query.status)
    .sort((a, b) => a.operation_id.localeCompare(b.operation_id));
}

export function listOrganizationOperationStates(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationOperationState[] {
  return listOrganizationRecordFiles('operations', OPERATION_STATE_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationOperationState>(filePath, 'organization operation state')
    )
    .filter((record): record is OrganizationOperationState =>
      Boolean(record && validateOrganizationOperationState(record))
    )
    .sort((a, b) => a.operation_id.localeCompare(b.operation_id));
}

export function listOrganizationOperationRuns(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationOperationRun[] {
  return listOrganizationRecordFiles('operations', OPERATION_RUN_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationOperationRun>(filePath, 'organization operation run')
    )
    .filter((record): record is OrganizationOperationRun =>
      Boolean(record && validateOrganizationOperationRun(record))
    )
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
}

export function saveOrganizationIncident(
  record: OrganizationIncidentRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    INCIDENT_SCHEMA_PATH,
    recordPath(
      'incidents',
      record.incident_id,
      INCIDENT_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization incident'
  );
}

export function loadOrganizationIncident(
  incidentId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationIncidentRecord | null {
  assertOrganizationId(incidentId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationIncidentRecord>(
      recordPath(
        'incidents',
        incidentId,
        INCIDENT_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization incident'
    );
    if (
      record &&
      validateOrganizationIncident(record) &&
      record.incident_id === incidentId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

export function saveOrganizationCadence(
  record: OrganizationCadenceRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    CADENCE_SCHEMA_PATH,
    recordPath(
      'cadences',
      record.cadence_id,
      CADENCE_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization cadence'
  );
}

export function loadOrganizationCadence(
  cadenceId: string,
  query: { organizationId: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): OrganizationCadenceRecord | null {
  assertOrganizationId(cadenceId);
  assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  for (const tier of recordQueryTiers(query.tier)) {
    const record = readJsonRecord<OrganizationCadenceRecord>(
      recordPath(
        'cadences',
        cadenceId,
        CADENCE_FILE_NAME,
        query.organizationId,
        tier,
        tenantSlug,
        query.rootDir
      ),
      'organization cadence'
    );
    if (
      record &&
      validateOrganizationCadence(record) &&
      record.cadence_id === cadenceId &&
      record.organization_id === query.organizationId &&
      record.tier === tier &&
      recordTenant(record) === tenantSlug
    )
      return record;
  }
  return null;
}

export function saveOrganizationDecision(
  record: OrganizationDecisionRecord,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    DECISION_SCHEMA_PATH,
    recordPath(
      'decisions',
      record.decision_id,
      DECISION_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization decision'
  );
}

export function saveOrganizationLearningCandidate(
  record: OrganizationLearningCandidate,
  options: { rootDir?: string } = {}
): string {
  assertRecordIdentity(record, options.rootDir);
  return saveValidated(
    record,
    LEARNING_SCHEMA_PATH,
    recordPath(
      'learning',
      record.learning_id,
      LEARNING_FILE_NAME,
      record.organization_id,
      record.tier,
      recordTenant(record),
      options.rootDir
    ),
    'organization learning candidate'
  );
}

export function buildOrganizationLearningCandidate(
  input: QueueOrganizationLearningCandidateInput,
  now = new Date().toISOString()
): OrganizationLearningCandidate {
  const record: OrganizationLearningCandidate = {
    version: '1.0.0',
    learning_id: input.learningId,
    organization_id: input.organizationId,
    source_type: input.sourceType,
    source_ref: input.sourceRef,
    title: input.title,
    summary: input.summary,
    evidence_refs: input.evidenceRefs || [],
    target_kind: input.targetKind,
    status: 'proposed',
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    created_at: now,
    updated_at: now,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  assertRecordIdentity(record, input.rootDir);
  if (!validateOrganizationLearningCandidate(record)) {
    throw new Error(
      `Invalid organization learning candidate: ${validationErrors(validatorFor(LEARNING_SCHEMA_PATH))}`
    );
  }
  return record;
}

export function enqueueOrganizationLearningCandidate(
  input: QueueOrganizationLearningCandidateInput
): OrganizationLearningCandidate {
  const record = buildOrganizationLearningCandidate(input);
  saveOrganizationLearningCandidate(record, { rootDir: input.rootDir });
  return record;
}

export interface BuildOrganizationScaffoldInput {
  organizationId: string;
  name: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  purpose?: string;
  principles?: string[];
  ownerRole?: string;
  rootDir?: string;
}

export interface OrganizationScaffold {
  state: OrganizationOperationalState;
  purpose?: OrganizationPurposeRecord;
}

export function buildOrganizationScaffold(
  input: BuildOrganizationScaffoldInput,
  now = new Date().toISOString()
): OrganizationScaffold {
  assertOrganizationId(input.organizationId);
  const existing = loadOrganizationOperationalState(input.organizationId, {
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (existing) {
    throw new Error(
      `Organization state already exists for '${input.organizationId}' (${input.tier}). Use 'purpose set' or 'reconcile' instead of 'init'.`
    );
  }
  const state: OrganizationOperationalState = {
    organization_id: input.organizationId,
    name: input.name,
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    status: 'active',
    active_project_ids: [],
    active_operation_ids: [],
    open_incident_ids: [],
    pending_decision_ids: [],
    updated_at: now,
  };
  assertRecordIdentity(state, input.rootDir);
  if (!validateOrganizationOperationalState(state)) {
    throw new Error(
      `Invalid organization operational state: ${validationErrors(validatorFor(STATE_SCHEMA_PATH))}`
    );
  }
  const scaffold: OrganizationScaffold = { state };
  if (input.purpose) {
    scaffold.purpose = buildOrganizationPurposeRecord(
      {
        organizationId: input.organizationId,
        name: input.name,
        tier: input.tier,
        tenantSlug: input.tenantSlug,
        purpose: input.purpose,
        principles: input.principles,
        ownerRole: input.ownerRole || 'operator',
        rootDir: input.rootDir,
      },
      now
    );
  }
  return scaffold;
}

export interface BuildOrganizationPurposeInput {
  organizationId: string;
  name: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  purpose: string;
  principles?: string[];
  ownerRole: string;
  approvalState?: OrganizationPurposeRecord['approval_state'];
  rootDir?: string;
}

export function buildOrganizationPurposeRecord(
  input: BuildOrganizationPurposeInput,
  now = new Date().toISOString()
): OrganizationPurposeRecord {
  const existing = loadOrganizationPurpose(input.organizationId, {
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  const record: OrganizationPurposeRecord = {
    version: '1.0.0',
    organization_id: input.organizationId,
    name: input.name,
    purpose: input.purpose,
    ...(input.principles?.length
      ? { principles: input.principles }
      : existing?.principles?.length
        ? { principles: existing.principles }
        : {}),
    ...(existing?.objectives?.length ? { objectives: existing.objectives } : {}),
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    owner_role: input.ownerRole,
    approval_state: input.approvalState || existing?.approval_state || 'draft',
    updated_at: now,
  };
  assertRecordIdentity(record, input.rootDir);
  if (!validateOrganizationPurpose(record)) {
    throw new Error(
      `Invalid organization purpose: ${validationErrors(validatorFor(PURPOSE_SCHEMA_PATH))}`
    );
  }
  return record;
}

export interface BuildOrganizationObjectiveInput {
  organizationId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  objective: OrganizationPurposeObjective;
  rootDir?: string;
}

export function buildOrganizationObjectiveAddition(
  input: BuildOrganizationObjectiveInput,
  now = new Date().toISOString()
): OrganizationPurposeRecord {
  const existing = loadOrganizationPurpose(input.organizationId, {
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (!existing) {
    throw new Error(
      `Organization purpose not found for '${input.organizationId}'. Run 'purpose set' (or 'init --purpose') first.`
    );
  }
  const objectives = existing.objectives || [];
  if (objectives.some((entry) => entry.objective_id === input.objective.objective_id)) {
    throw new Error(
      `Objective '${input.objective.objective_id}' already exists for '${input.organizationId}'.`
    );
  }
  const record: OrganizationPurposeRecord = {
    ...existing,
    objectives: [...objectives, input.objective],
    updated_at: now,
  };
  if (!validateOrganizationPurpose(record)) {
    throw new Error(
      `Invalid organization purpose: ${validationErrors(validatorFor(PURPOSE_SCHEMA_PATH))}`
    );
  }
  return record;
}

export interface BuildOrganizationDomainInput {
  organizationId: string;
  domainId: string;
  name: string;
  ownerRole: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  purpose?: string;
  rootDir?: string;
}

export function buildOrganizationDomainRecord(
  input: BuildOrganizationDomainInput,
  now = new Date().toISOString()
): OrganizationDomainRecord {
  const record: OrganizationDomainRecord = {
    version: '1.0.0',
    domain_id: input.domainId,
    organization_id: input.organizationId,
    name: input.name,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    owner_role: input.ownerRole,
    capability_ids: [],
    service_ids: [],
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    status: 'active',
    updated_at: now,
  };
  assertRecordIdentity(record, input.rootDir);
  if (!validateOrganizationDomain(record)) {
    throw new Error(
      `Invalid organization domain: ${validationErrors(validatorFor(DOMAIN_SCHEMA_PATH))}`
    );
  }
  return record;
}

export interface BuildOrganizationServiceInput {
  organizationId: string;
  serviceId: string;
  domainId: string;
  name: string;
  outcome: string;
  ownerRole: string;
  consumers: string[];
  tier: OrganizationTier;
  tenantSlug?: string;
  sloTarget?: string;
  sloWindow?: string;
  runbookRefs?: string[];
  status?: OrganizationServiceRecord['status'];
  rootDir?: string;
}

export interface OrganizationServiceAddition {
  service: OrganizationServiceRecord;
  domain: OrganizationDomainRecord;
}

export function buildOrganizationServiceAddition(
  input: BuildOrganizationServiceInput,
  now = new Date().toISOString()
): OrganizationServiceAddition {
  if (!input.consumers.length) {
    throw new Error('At least one --consumer is required for service add.');
  }
  const domain = loadOrganizationDomain(input.domainId, {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (!domain) {
    throw new Error(
      `Domain '${input.domainId}' not found for '${input.organizationId}'. Run 'domain add' first.`
    );
  }
  const service: OrganizationServiceRecord = {
    version: '1.0.0',
    service_id: input.serviceId,
    organization_id: input.organizationId,
    domain_id: input.domainId,
    name: input.name,
    outcome: input.outcome,
    owner_role: input.ownerRole,
    consumers: input.consumers,
    slo: {
      target: input.sloTarget || `${input.name} is operating and observable`,
      measurement_window: input.sloWindow || 'weekly',
    },
    slis: [
      {
        sli_id: `sli-${input.serviceId}-visibility`,
        name: `${input.name} operational visibility`,
        source_ref: 'organization-operating-model.reconciliation',
        freshness_seconds: 3600,
      },
    ],
    runbook_refs: input.runbookRefs?.length ? input.runbookRefs : ['docs/OPERATOR_UX_GUIDE.md'],
    escalation_path: [input.ownerRole],
    dependencies: [],
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    status: input.status || 'active',
    updated_at: now,
  };
  assertRecordIdentity(service, input.rootDir);
  if (!validateOrganizationService(service)) {
    throw new Error(
      `Invalid organization service: ${validationErrors(validatorFor(SERVICE_SCHEMA_PATH))}`
    );
  }
  const nextDomain: OrganizationDomainRecord = domain.service_ids.includes(input.serviceId)
    ? domain
    : { ...domain, service_ids: [...domain.service_ids, input.serviceId], updated_at: now };
  return { service, domain: nextDomain };
}

export interface BuildOrganizationServiceStateInput {
  organizationId: string;
  serviceId: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  health: OrganizationServiceState['health'];
  /** Defaults to `current`: an operator declaration is the source, so it is not stale. */
  reconcileStatus?: OrganizationServiceState['reconcile_status'];
  /**
   * How old the underlying observation is. Defaults to 0 — a declaration made
   * now describes now. Feeds `stale_services` detection in reconciliation.
   */
  freshnessSeconds?: number;
  /** 0..1. Defaults to 1: the operator asserting the health IS the source. */
  confidence?: number;
  /** ISO timestamp the observation came from. Defaults to `observed_at`. */
  sourceTimestamp?: string;
  activeProjectIds?: string[];
  activeOperationIds?: string[];
  openIncidentIds?: string[];
  lastOutcomeRefs?: string[];
  rootDir?: string;
}

/**
 * Builds the runtime-health half of a service record.
 *
 * A service declares what is promised; its state declares whether the promise
 * is currently being met. Reconciliation treats a service with no state as
 * `services_without_state` and refuses to summarise health from nothing —
 * fail-closed, because "no state" and "healthy" must never look alike. This
 * builder is how a state gets declared when no telemetry feed owns the service
 * yet, so the parent service must already exist: a state for a service that was
 * never defined would be health without a promise to measure against.
 */
export function buildOrganizationServiceState(
  input: BuildOrganizationServiceStateInput,
  now = new Date().toISOString()
): OrganizationServiceState {
  const service = loadOrganizationService(input.serviceId, {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (!service) {
    throw new Error(
      `Service '${input.serviceId}' not found for '${input.organizationId}'. Run 'service add' first.`
    );
  }
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw new Error(`--confidence must be between 0 and 1 (received ${input.confidence}).`);
  }
  if (input.freshnessSeconds !== undefined && input.freshnessSeconds < 0) {
    throw new Error(
      `--freshness-seconds must not be negative (received ${input.freshnessSeconds}).`
    );
  }
  const state: OrganizationServiceState = {
    service_id: input.serviceId,
    organization_id: input.organizationId,
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    health: input.health,
    observed_at: now,
    source_timestamp: input.sourceTimestamp || now,
    freshness_seconds: input.freshnessSeconds ?? 0,
    confidence: input.confidence ?? 1,
    ...(input.activeProjectIds?.length ? { active_project_ids: input.activeProjectIds } : {}),
    ...(input.activeOperationIds?.length ? { active_operation_ids: input.activeOperationIds } : {}),
    ...(input.openIncidentIds?.length ? { open_incident_ids: input.openIncidentIds } : {}),
    ...(input.lastOutcomeRefs?.length ? { last_outcome_refs: input.lastOutcomeRefs } : {}),
    reconcile_status: input.reconcileStatus || 'current',
    updated_at: now,
  };
  assertRecordIdentity(state, input.rootDir);
  if (!validateOrganizationServiceState(state)) {
    throw new Error(
      `Invalid organization service state: ${validationErrors(
        validatorFor(SERVICE_STATE_SCHEMA_PATH)
      )}`
    );
  }
  return state;
}

export interface BuildOrganizationOperationInput {
  organizationId: string;
  operationId: string;
  name: string;
  operationType: OrganizationOperationType;
  ownerRole: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  serviceId?: string;
  purpose?: string;
  triggerKind?: OrganizationOperationRecord['trigger']['kind'];
  triggerExpression?: string;
  executionKind?: OrganizationOperationRecord['execution_target']['kind'];
  executionRef?: string;
  evidenceOutputs?: string[];
  rootDir?: string;
}

export function buildOrganizationOperationRecord(
  input: BuildOrganizationOperationInput,
  now = new Date().toISOString()
): OrganizationOperationRecord {
  const record: OrganizationOperationRecord = {
    version: '1.0.0',
    operation_id: input.operationId,
    organization_id: input.organizationId,
    ...(input.serviceId ? { service_id: input.serviceId } : {}),
    name: input.name,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    operation_type: input.operationType,
    owner_role: input.ownerRole,
    trigger: {
      kind: input.triggerKind || 'manual',
      ...(input.triggerExpression ? { expression: input.triggerExpression } : {}),
    },
    automation_boundary: {
      allowed_actions: [],
      approval_required_actions: [],
      forbidden_actions: [],
    },
    escalation_path: [input.ownerRole],
    evidence_outputs: input.evidenceOutputs?.length
      ? input.evidenceOutputs
      : [`${input.operationId}-run-report`],
    execution_target: {
      kind: input.executionKind || 'mission',
      ...(input.executionRef ? { ref: input.executionRef } : {}),
    },
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    status: 'active',
    updated_at: now,
  };
  assertRecordIdentity(record, input.rootDir);
  if (!validateOrganizationOperation(record)) {
    throw new Error(
      `Invalid organization operation: ${validationErrors(validatorFor(OPERATION_SCHEMA_PATH))}`
    );
  }
  return record;
}

export interface BuildOrganizationCadenceInput {
  organizationId: string;
  cadenceId: string;
  name: string;
  cadenceType: OrganizationCadenceRecord['cadence_type'];
  schedule: string;
  ownerRole: string;
  tier: OrganizationTier;
  tenantSlug?: string;
  status?: OrganizationCadenceRecord['status'];
  rootDir?: string;
}

/**
 * Builds a governance cadence — the recurring body that decides, rather than the
 * work being decided about (`governance_cadence` in the work-shape catalog).
 *
 * `decision_ids` starts empty and grows through `buildOrganizationDecision`, so
 * the cadence record is the durable index of everything that body ever decided.
 */
export function buildOrganizationCadence(
  input: BuildOrganizationCadenceInput,
  now = new Date().toISOString()
): OrganizationCadenceRecord {
  const existing = loadOrganizationCadence(input.cadenceId, {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  const record: OrganizationCadenceRecord = {
    version: '1.0.0',
    cadence_id: input.cadenceId,
    organization_id: input.organizationId,
    name: input.name,
    cadence_type: input.cadenceType,
    schedule: input.schedule,
    owner_role: input.ownerRole,
    // Re-running `cadence add` must not erase the decision history already
    // indexed against this body.
    decision_ids: existing?.decision_ids ?? [],
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    status: input.status || 'active',
    updated_at: now,
  };
  assertRecordIdentity(record, input.rootDir);
  if (!validateOrganizationCadence(record)) {
    throw new Error(
      `Invalid organization cadence: ${validationErrors(validatorFor(CADENCE_SCHEMA_PATH))}`
    );
  }
  return record;
}

export interface BuildOrganizationDecisionInput {
  organizationId: string;
  decisionId: string;
  cadenceId: string;
  title: string;
  decisionOwner: string;
  dueAt: string;
  options: string[];
  tier: OrganizationTier;
  tenantSlug?: string;
  decisionType?: OrganizationDecisionRecord['decision_type'];
  status?: OrganizationDecisionRecord['status'];
  requestedBy?: string;
  chosenOption?: string;
  rationale?: string;
  approvalRefs?: string[];
  followUpRefs?: string[];
  rootDir?: string;
}

export interface OrganizationDecisionAddition {
  decision: OrganizationDecisionRecord;
  cadence: OrganizationCadenceRecord;
}

/**
 * Builds a decision and links it back into its cadence.
 *
 * The parent cadence must exist: reconciliation reports a decision whose
 * `cadence_id` resolves to nothing as `missing_decision_cadences`, because a
 * decision with no body that made it cannot be audited. Returning the updated
 * cadence alongside the decision keeps that index in one transaction — the same
 * shape `service add` uses for its parent domain.
 */
export function buildOrganizationDecision(
  input: BuildOrganizationDecisionInput,
  now = new Date().toISOString()
): OrganizationDecisionAddition {
  if (!input.options.length) {
    throw new Error('At least one --option is required for decision add.');
  }
  if (input.chosenOption && !input.options.includes(input.chosenOption)) {
    throw new Error(
      `--chosen-option '${input.chosenOption}' is not one of the declared options (${input.options.join(', ')}).`
    );
  }
  const cadence = loadOrganizationCadence(input.cadenceId, {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (!cadence) {
    throw new Error(
      `Cadence '${input.cadenceId}' not found for '${input.organizationId}'. Run 'cadence add' first.`
    );
  }
  const decision: OrganizationDecisionRecord = {
    version: '1.0.0',
    decision_id: input.decisionId,
    organization_id: input.organizationId,
    cadence_id: input.cadenceId,
    title: input.title,
    ...(input.decisionType ? { decision_type: input.decisionType } : {}),
    status: input.status || 'proposed',
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    decision_owner: input.decisionOwner,
    due_at: input.dueAt,
    options: input.options,
    ...(input.chosenOption ? { chosen_option: input.chosenOption } : {}),
    ...(input.rationale ? { rationale: input.rationale } : {}),
    ...(input.approvalRefs?.length ? { approval_refs: input.approvalRefs } : {}),
    follow_up_refs: input.followUpRefs ?? [],
    tier: input.tier,
    ...(input.tenantSlug ? { tenant_slug: input.tenantSlug } : {}),
    updated_at: now,
  };
  assertRecordIdentity(decision, input.rootDir);
  if (!validateOrganizationDecision(decision)) {
    throw new Error(
      `Invalid organization decision: ${validationErrors(validatorFor(DECISION_SCHEMA_PATH))}`
    );
  }
  const nextCadence: OrganizationCadenceRecord = cadence.decision_ids.includes(input.decisionId)
    ? cadence
    : {
        ...cadence,
        decision_ids: [...cadence.decision_ids, input.decisionId],
        updated_at: now,
      };
  return { decision, cadence: nextCadence };
}

export interface BuildOrganizationProjectLinkInput {
  organizationId: string;
  projectId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  detach?: boolean;
  rootDir?: string;
}

export function buildOrganizationProjectLink(
  input: BuildOrganizationProjectLinkInput,
  now = new Date().toISOString()
): OrganizationOperationalState {
  const state = loadOrganizationOperationalState(input.organizationId, {
    tier: input.tier,
    tenantSlug: input.tenantSlug,
    rootDir: input.rootDir,
  });
  if (!state) {
    throw new Error(
      `Organization state not found for '${input.organizationId}'. Run 'init' first.`
    );
  }
  if (!input.detach && !loadProjectRecord(input.projectId, { rootDir: input.rootDir })) {
    throw new Error(
      `Project '${input.projectId}' not found in the project registry. Create it via 'pnpm project create' first.`
    );
  }
  const current = state.active_project_ids || [];
  if (input.detach) {
    if (!current.includes(input.projectId)) {
      throw new Error(`Project '${input.projectId}' is not attached to '${input.organizationId}'.`);
    }
  } else if (current.includes(input.projectId)) {
    throw new Error(
      `Project '${input.projectId}' is already attached to '${input.organizationId}'.`
    );
  }
  const record: OrganizationOperationalState = {
    ...state,
    active_project_ids: input.detach
      ? current.filter((entry) => entry !== input.projectId)
      : [...current, input.projectId],
    updated_at: now,
  };
  if (!validateOrganizationOperationalState(record)) {
    throw new Error(
      `Invalid organization operational state: ${validationErrors(validatorFor(STATE_SCHEMA_PATH))}`
    );
  }
  return record;
}

export function listOrganizationIncidents(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationIncidentRecord[] {
  return listOrganizationRecordFiles('incidents', INCIDENT_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationIncidentRecord>(filePath, 'organization incident')
    )
    .filter((record): record is OrganizationIncidentRecord =>
      Boolean(record && validateOrganizationIncident(record))
    )
    .sort((a, b) => a.incident_id.localeCompare(b.incident_id));
}

export function listOrganizationCadences(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationCadenceRecord[] {
  return listOrganizationRecordFiles('cadences', CADENCE_FILE_NAME, query)
    .map((filePath) => readJsonRecord<OrganizationCadenceRecord>(filePath, 'organization cadence'))
    .filter((record): record is OrganizationCadenceRecord =>
      Boolean(record && validateOrganizationCadence(record))
    )
    .sort((a, b) => a.cadence_id.localeCompare(b.cadence_id));
}

export function listOrganizationDecisions(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
    status?: OrganizationDecisionRecord['status'];
  } = {}
): OrganizationDecisionRecord[] {
  return listOrganizationRecordFiles('decisions', DECISION_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationDecisionRecord>(filePath, 'organization decision')
    )
    .filter((record): record is OrganizationDecisionRecord =>
      Boolean(record && validateOrganizationDecision(record))
    )
    .filter((record) => !query.status || record.status === query.status)
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
}

export function listOrganizationLearningCandidates(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
    status?: OrganizationLearningCandidate['status'];
  } = {}
): OrganizationLearningCandidate[] {
  return listOrganizationRecordFiles('learning', LEARNING_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationLearningCandidate>(filePath, 'organization learning candidate')
    )
    .filter((record): record is OrganizationLearningCandidate =>
      Boolean(record && validateOrganizationLearningCandidate(record))
    )
    .filter((record) => !query.status || record.status === query.status)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function organizationRecordFiles(rootDir: string, fileName: string): string[] {
  if (!safeExistsSync(rootDir)) return [];
  const files: string[] = [];
  for (const entry of safeReaddir(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    if (!safeExistsSync(fullPath)) continue;
    if (safeStat(fullPath).isDirectory())
      files.push(...organizationRecordFiles(fullPath, fileName));
    else if (entry === fileName) files.push(fullPath);
  }
  return files;
}

function listOrganizationRecordFiles(
  kind: OrganizationRecordKind,
  fileName: string,
  query: { organizationId?: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): string[] {
  if (query.organizationId) assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug || process.env.KYBERION_TENANT);
  const tiers = recordQueryTiers(query.tier);
  return tiers.flatMap((tier) => {
    const organizationRoot = path.resolve(
      query.rootDir || pathResolver.rootDir(),
      'active/organizations',
      tier,
      tenantSlug
    );
    return organizationRecordFiles(organizationRoot, fileName).filter((filePath) =>
      query.organizationId ? filePath.includes(`/${query.organizationId}/`) : true
    );
  });
}

export function listOrganizationDomains(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationDomainRecord[] {
  return listOrganizationRecordFiles('domains', DOMAIN_FILE_NAME, query)
    .map((filePath) => readJsonRecord<OrganizationDomainRecord>(filePath, 'organization domain'))
    .filter((record): record is OrganizationDomainRecord =>
      Boolean(record && validateOrganizationDomain(record))
    )
    .sort((a, b) => a.domain_id.localeCompare(b.domain_id));
}

export function listOrganizationCapabilities(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationCapabilityRecord[] {
  return listOrganizationRecordFiles('capabilities', CAPABILITY_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationCapabilityRecord>(filePath, 'organization capability')
    )
    .filter((record): record is OrganizationCapabilityRecord =>
      Boolean(record && validateOrganizationCapability(record))
    )
    .sort((a, b) => a.capability_id.localeCompare(b.capability_id));
}

export function listOrganizationServices(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationServiceRecord[] {
  return listOrganizationRecordFiles('services', SERVICE_FILE_NAME, query)
    .map((filePath) => readJsonRecord<OrganizationServiceRecord>(filePath, 'organization service'))
    .filter((record): record is OrganizationServiceRecord =>
      Boolean(record && validateOrganizationService(record))
    )
    .sort((a, b) => a.service_id.localeCompare(b.service_id));
}

export function listOrganizationServiceStates(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationServiceState[] {
  return listOrganizationRecordFiles('services', SERVICE_STATE_FILE_NAME, query)
    .map((filePath) =>
      readJsonRecord<OrganizationServiceState>(filePath, 'organization service state')
    )
    .filter((record): record is OrganizationServiceState =>
      Boolean(record && validateOrganizationServiceState(record))
    )
    .sort((a, b) => a.service_id.localeCompare(b.service_id));
}

export function loadOrganizationCatalog(query: {
  organizationId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
}): OrganizationCatalog {
  const tenantSlug = recordQueryTenant(query.tenantSlug);
  const tier = query.tier || 'confidential';
  return {
    version: '1.0.0',
    organization_id: query.organizationId,
    tier,
    ...(tenantSlug !== 'shared' ? { tenant_slug: tenantSlug } : {}),
    domains: listOrganizationDomains({ ...query, tenantSlug }),
    capabilities: listOrganizationCapabilities({ ...query, tenantSlug }),
    services: listOrganizationServices({ ...query, tenantSlug }),
  };
}

export function reconcileOrganizationCatalog(query: {
  organizationId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
}): OrganizationCatalogReconciliation {
  const catalog = loadOrganizationCatalog(query);
  const capabilitiesById = new Map(
    catalog.capabilities.map((entry) => [entry.capability_id, entry])
  );
  const servicesById = new Map(catalog.services.map((entry) => [entry.service_id, entry]));
  const missingCapabilities = new Set<string>();
  const missingServices = new Set<string>();
  for (const domain of catalog.domains) {
    for (const capabilityId of domain.capability_ids) {
      if (!capabilitiesById.has(capabilityId))
        missingCapabilities.add(`${domain.domain_id}:${capabilityId}`);
    }
    for (const serviceId of domain.service_ids) {
      if (!servicesById.has(serviceId)) missingServices.add(`${domain.domain_id}:${serviceId}`);
    }
  }
  for (const capability of catalog.capabilities) {
    for (const serviceId of capability.service_ids) {
      if (!servicesById.has(serviceId))
        missingServices.add(`${capability.capability_id}:${serviceId}`);
    }
  }
  const domainIds = new Set(catalog.domains.map((entry) => entry.domain_id));
  const referencedCapabilityIds = new Set(catalog.domains.flatMap((entry) => entry.capability_ids));
  const referencedServiceIds = new Set(
    catalog.domains
      .flatMap((entry) => entry.service_ids)
      .concat(catalog.capabilities.flatMap((entry) => entry.service_ids))
  );
  const orphanCapabilities = catalog.capabilities
    .filter(
      (entry) =>
        !domainIds.has(entry.domain_id) || !referencedCapabilityIds.has(entry.capability_id)
    )
    .map((entry) => entry.capability_id);
  const orphanServices = catalog.services
    .filter(
      (entry) => !domainIds.has(entry.domain_id) || !referencedServiceIds.has(entry.service_id)
    )
    .map((entry) => entry.service_id);
  const serviceStates = listOrganizationServiceStates(query);
  const stateById = new Map(serviceStates.map((entry) => [entry.service_id, entry]));
  const servicesWithoutState = catalog.services
    .filter((entry) => entry.status === 'active' && !stateById.has(entry.service_id))
    .map((entry) => entry.service_id);
  const staleServices = serviceStates
    .filter((entry) => entry.reconcile_status === 'stale' || entry.reconcile_status === 'conflict')
    .map((entry) => entry.service_id);
  const operations = listOrganizationOperations(query);
  const operationStates = listOrganizationOperationStates(query);
  const operationRuns = listOrganizationOperationRuns(query);
  const operationStateById = new Map(operationStates.map((entry) => [entry.operation_id, entry]));
  const missingOperationServices = operations
    .filter((entry) => entry.service_id && !servicesById.has(entry.service_id))
    .map((entry) => `${entry.operation_id}:${entry.service_id}`);
  const operationsWithoutState = operations
    .filter((entry) => entry.status === 'active' && !operationStateById.has(entry.operation_id))
    .map((entry) => entry.operation_id);
  const overdueOperations = operationStates
    .filter((entry) => entry.due_status === 'overdue' || entry.status === 'failed')
    .map((entry) => entry.operation_id);
  const invalidExecutionRefs = operations.flatMap((entry) => {
    const ref = entry.execution_target.ref;
    if (!ref && entry.execution_target.kind !== 'actuator') {
      return [`${entry.operation_id}:execution_target`];
    }
    if (!ref) return [];
    if (entry.execution_target.kind === 'mission' && !loadState(ref, { rootDir: query.rootDir })) {
      return [`${entry.operation_id}:${ref}`];
    }
    if (
      entry.execution_target.kind === 'pipeline' &&
      (ref.startsWith('pipelines/') || ref.startsWith('knowledge/')) &&
      !safeExistsSync(path.resolve(query.rootDir || pathResolver.rootDir(), ref))
    ) {
      return [`${entry.operation_id}:${ref}`];
    }
    return [];
  });
  const invalidEvidenceRefs = [
    ...operationStates.flatMap((entry) =>
      (entry.last_evidence_refs || [])
        .filter((ref) => ref.startsWith('knowledge/') || ref.startsWith('active/'))
        .filter(
          (ref) => !safeExistsSync(path.resolve(query.rootDir || pathResolver.rootDir(), ref))
        )
        .map((ref) => `${entry.operation_id}:${ref}`)
    ),
    ...operationRuns.flatMap((entry) =>
      (entry.evidence_refs || [])
        .filter((ref) => ref.startsWith('knowledge/') || ref.startsWith('active/'))
        .filter(
          (ref) => !safeExistsSync(path.resolve(query.rootDir || pathResolver.rootDir(), ref))
        )
        .map((ref) => `${entry.operation_id}:${ref}`)
    ),
  ];
  const incidents = listOrganizationIncidents(query);
  const operationsById = new Set(operations.map((entry) => entry.operation_id));
  const missingIncidentServices = incidents
    .filter((entry) => entry.service_id && !servicesById.has(entry.service_id))
    .map((entry) => `${entry.incident_id}:${entry.service_id}`);
  const missingIncidentOperations = incidents
    .filter((entry) => entry.operation_id && !operationsById.has(entry.operation_id))
    .map((entry) => `${entry.incident_id}:${entry.operation_id}`);
  const cadences = listOrganizationCadences(query);
  const cadenceIds = new Set(cadences.map((entry) => entry.cadence_id));
  const decisions = listOrganizationDecisions(query);
  const missingDecisionCadences = decisions
    .filter((entry) => !cadenceIds.has(entry.cadence_id))
    .map((entry) => `${entry.decision_id}:${entry.cadence_id}`);
  const pendingDecisions = decisions
    .filter((entry) => entry.status === 'proposed' || entry.status === 'pending_approval')
    .map((entry) => entry.decision_id);
  const operationalState = loadOrganizationOperationalState(query.organizationId, {
    tier: query.tier,
    tenantSlug: query.tenantSlug,
    rootDir: query.rootDir,
  });
  const projectRefs = operationalState?.active_project_ids || [];
  const projects = listProjectRecords(query.rootDir || pathResolver.rootDir());
  const projectIds = new Set(
    projects
      .filter((project) => !query.tier || project.tier === query.tier)
      .map((project) => project.project_id)
  );
  const missingProjectRefs = projectRefs.filter((projectId) => !projectIds.has(projectId));
  const invalidRunbookRefs = catalog.services.flatMap((entry) =>
    entry.runbook_refs
      .filter(
        (ref) =>
          ref.startsWith('knowledge/') &&
          !safeExistsSync(path.resolve(query.rootDir || pathResolver.rootDir(), ref))
      )
      .map((ref) => `${entry.service_id}:${ref}`)
  );
  const attention =
    missingCapabilities.size > 0 ||
    missingServices.size > 0 ||
    orphanCapabilities.length > 0 ||
    orphanServices.length > 0 ||
    servicesWithoutState.length > 0 ||
    staleServices.length > 0 ||
    invalidRunbookRefs.length > 0 ||
    missingOperationServices.length > 0 ||
    operationsWithoutState.length > 0 ||
    overdueOperations.length > 0 ||
    invalidExecutionRefs.length > 0 ||
    invalidEvidenceRefs.length > 0 ||
    missingIncidentServices.length > 0 ||
    missingIncidentOperations.length > 0 ||
    missingDecisionCadences.length > 0 ||
    pendingDecisions.length > 0 ||
    missingProjectRefs.length > 0;
  return {
    status: attention ? 'attention' : 'clean',
    missing_capabilities: [...missingCapabilities].sort(),
    missing_services: [...missingServices].sort(),
    orphan_capabilities: orphanCapabilities.sort(),
    orphan_services: orphanServices.sort(),
    services_without_state: servicesWithoutState.sort(),
    stale_services: staleServices.sort(),
    invalid_runbook_refs: invalidRunbookRefs.sort(),
    missing_operation_services: missingOperationServices.sort(),
    operations_without_state: operationsWithoutState.sort(),
    overdue_operations: overdueOperations.sort(),
    invalid_execution_refs: invalidExecutionRefs.sort(),
    invalid_evidence_refs: invalidEvidenceRefs.sort(),
    missing_incident_services: missingIncidentServices.sort(),
    missing_incident_operations: missingIncidentOperations.sort(),
    missing_decision_cadences: missingDecisionCadences.sort(),
    pending_decisions: pendingDecisions.sort(),
    missing_project_refs: missingProjectRefs.sort(),
  };
}

export function reconcileOrganizationState(query: {
  organizationId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
  apply?: boolean;
}): OrganizationReconciliationResult {
  assertOrganizationId(query.organizationId);
  const reconciliation = reconcileOrganizationCatalog(query);
  const state = loadOrganizationOperationalState(query.organizationId, {
    tier: query.tier,
    tenantSlug: query.tenantSlug,
    rootDir: query.rootDir,
  });
  const services = listOrganizationServiceStates(query);
  const operations = listOrganizationOperations(query);
  const operationStates = listOrganizationOperationStates(query);
  const incidents = listOrganizationIncidents(query);
  const decisions = listOrganizationDecisions(query);
  const actions: OrganizationReconciliationResult['actions'] = [];
  const blockedIssues = Object.entries(reconciliation).flatMap(([key, value]) =>
    key === 'status' || !Array.isArray(value) ? [] : value.map((entry) => `${key}:${entry}`)
  );
  const updatedPaths: string[] = [];
  if (state) {
    actions.push({
      action: 'refresh_operational_summary',
      reason:
        'Rebuild organization-level health, operation, incident, and decision projections from tenant-scoped records.',
      target: organizationOperationalStatePath(
        state.organization_id,
        state.tier,
        state.tenant_slug || 'shared',
        query.rootDir
      ),
    });
    if (query.apply) {
      const now = new Date().toISOString();
      const nextState: OrganizationOperationalState = {
        ...state,
        active_operation_ids: operations
          .filter((entry) => entry.status === 'active')
          .map((entry) => entry.operation_id),
        open_incident_ids: incidents
          .filter((entry) => entry.status !== 'resolved' && entry.status !== 'closed')
          .map((entry) => entry.incident_id),
        pending_decision_ids: decisions
          .filter((entry) => entry.status === 'proposed' || entry.status === 'pending_approval')
          .map((entry) => entry.decision_id),
        service_health_summary: {
          healthy: services.filter((entry) => entry.health === 'healthy').length,
          degraded: services.filter((entry) => entry.health === 'degraded').length,
          critical: services.filter((entry) => entry.health === 'critical').length,
          unknown: services.filter((entry) => entry.health === 'unknown').length,
        },
        last_reconciled_at: now,
        updated_at: now,
      };
      updatedPaths.push(saveOrganizationOperationalState(nextState, { rootDir: query.rootDir }));
    }
  } else {
    blockedIssues.push('organization_state:missing');
  }
  return {
    mode: query.apply ? 'apply' : 'dry_run',
    reconciliation,
    actions,
    blocked_issues: [...new Set(blockedIssues)].sort(),
    updated_paths: updatedPaths,
  };
}

function buildOrganizationProjectLineage(
  organizationId: string,
  tier: OrganizationTier | undefined,
  operationalState: OrganizationOperationalState | null,
  rootDir?: string
): OrganizationProjectLineage[] {
  const referencedProjectIds = new Set(operationalState?.active_project_ids || []);
  return listProjectRecords(rootDir || pathResolver.rootDir())
    .filter((project) => !tier || project.tier === tier)
    .filter(
      (project) =>
        referencedProjectIds.has(project.project_id) ||
        project.metadata?.organization_id === organizationId
    )
    .map((project) => ({
      project_id: project.project_id,
      name: project.name,
      status: project.status,
      tier: project.tier,
      role: 'solution_project' as const,
      track_ids:
        project.active_tracks || (project.default_track_id ? [project.default_track_id] : []),
      mission_ids: project.active_missions || [],
      task_session_ids: project.active_task_sessions || [],
    }))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
}

function buildOrganizationLineage(input: {
  organizationId: string;
  domains: OrganizationDomainRecord[];
  capabilities: OrganizationCapabilityRecord[];
  services: OrganizationServiceRecord[];
  operations: OrganizationOperationRecord[];
  incidents: OrganizationIncidentRecord[];
  cadences: OrganizationCadenceRecord[];
  decisions: OrganizationDecisionRecord[];
  projects: OrganizationProjectLineage[];
}): OrganizationLineage {
  const nodes = new Map<string, OrganizationLineage['nodes'][number]>();
  const edges = new Map<string, OrganizationLineage['edges'][number]>();
  const addNode = (kind: OrganizationLineage['nodes'][number]['kind'], id: string) => {
    nodes.set(`${kind}:${id}`, { id: `${kind}:${id}`, kind });
  };
  const addEdge = (
    fromKind: OrganizationLineage['nodes'][number]['kind'],
    from: string,
    toKind: OrganizationLineage['nodes'][number]['kind'],
    to: string,
    relationship: OrganizationRelationshipType
  ) => {
    const edge = {
      from: `${fromKind}:${from}`,
      to: `${toKind}:${to}`,
      relationship,
    };
    edges.set(`${edge.from}->${edge.to}:${relationship}`, edge);
  };
  addNode('organization', input.organizationId);
  for (const domain of input.domains) {
    addNode('domain', domain.domain_id);
    addEdge('organization', input.organizationId, 'domain', domain.domain_id, 'owns');
    for (const capabilityId of domain.capability_ids) {
      if (!input.capabilities.some((entry) => entry.capability_id === capabilityId)) continue;
      addNode('capability', capabilityId);
      addEdge('domain', domain.domain_id, 'capability', capabilityId, 'owns');
    }
    for (const serviceId of domain.service_ids) {
      if (!input.services.some((entry) => entry.service_id === serviceId)) continue;
      addNode('service', serviceId);
      addEdge('domain', domain.domain_id, 'service', serviceId, 'delivers');
    }
  }
  for (const operation of input.operations) {
    addNode('operation', operation.operation_id);
    if (operation.service_id) {
      addNode('service', operation.service_id);
      addEdge('service', operation.service_id, 'operation', operation.operation_id, 'supports');
    }
  }
  for (const incident of input.incidents) {
    addNode('incident', incident.incident_id);
    if (incident.service_id) {
      addNode('service', incident.service_id);
      addEdge('incident', incident.incident_id, 'service', incident.service_id, 'responds_to');
    }
    if (incident.operation_id) {
      addNode('operation', incident.operation_id);
      addEdge('incident', incident.incident_id, 'operation', incident.operation_id, 'responds_to');
    }
  }
  for (const cadence of input.cadences) {
    addNode('cadence', cadence.cadence_id);
    for (const decisionId of cadence.decision_ids) {
      if (!input.decisions.some((entry) => entry.decision_id === decisionId)) continue;
      addNode('decision', decisionId);
      addEdge('cadence', cadence.cadence_id, 'decision', decisionId, 'governs');
    }
  }
  for (const decision of input.decisions) {
    addNode('decision', decision.decision_id);
    addNode('cadence', decision.cadence_id);
    addEdge('cadence', decision.cadence_id, 'decision', decision.decision_id, 'governs');
  }
  for (const project of input.projects) {
    addNode('project', project.project_id);
    addEdge('organization', input.organizationId, 'project', project.project_id, 'owns');
    for (const missionId of project.mission_ids) {
      addNode('mission', missionId);
      addEdge('project', project.project_id, 'mission', missionId, 'delivers');
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) =>
      `${a.from}:${a.to}:${a.relationship}`.localeCompare(`${b.from}:${b.to}:${b.relationship}`)
    ),
  };
}

function organizationStateFiles(rootDir: string): string[] {
  if (!safeExistsSync(rootDir)) return [];
  const files: string[] = [];
  for (const entry of safeReaddir(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    if (!safeExistsSync(fullPath)) continue;
    if (safeStat(fullPath).isDirectory()) files.push(...organizationStateFiles(fullPath));
    else if (entry === STATE_FILE_NAME) files.push(fullPath);
  }
  return files;
}

export function listOrganizationOperationalStates(
  query: {
    organizationId?: string;
    tier?: OrganizationTier;
    tenantSlug?: string;
    rootDir?: string;
  } = {}
): OrganizationOperationalState[] {
  if (query.organizationId) assertOrganizationId(query.organizationId);
  if (query.tenantSlug) assertTenantSlug(query.tenantSlug);
  const tenantSlug = recordQueryTenant(query.tenantSlug || process.env.KYBERION_TENANT);
  const files = recordQueryTiers(query.tier).flatMap((tier) =>
    organizationStateFiles(
      path.resolve(
        query.rootDir || pathResolver.rootDir(),
        'active/organizations',
        tier,
        tenantSlug
      )
    )
  );
  return files
    .map((filePath) =>
      readJsonRecord<OrganizationOperationalState>(filePath, 'organization operational state')
    )
    .filter((record): record is OrganizationOperationalState =>
      Boolean(record && validateOrganizationOperationalState(record))
    )
    .filter((record) => !query.organizationId || record.organization_id === query.organizationId)
    .filter((record) => !query.tier || record.tier === query.tier)
    .filter((record) => !query.tenantSlug || (record.tenant_slug || 'shared') === query.tenantSlug)
    .sort((a, b) => a.organization_id.localeCompare(b.organization_id));
}

export function buildOrganizationManagementView(input: {
  organizationId: string;
  tier?: OrganizationTier;
  tenantSlug?: string;
  rootDir?: string;
}): OrganizationManagementView {
  assertOrganizationId(input.organizationId);
  const tenantSlug = input.tenantSlug || 'shared';
  assertTenantSlug(tenantSlug);
  const catalog = loadOrganizationOperatingModelCatalog();
  const purpose = loadOrganizationPurpose(input.organizationId, {
    tier: input.tier,
    tenantSlug,
    rootDir: input.rootDir,
  });
  const operationalState = loadOrganizationOperationalState(input.organizationId, {
    tier: input.tier,
    tenantSlug,
    rootDir: input.rootDir,
  });
  const organizationQuery = {
    organizationId: input.organizationId,
    tier: input.tier,
    tenantSlug,
    rootDir: input.rootDir,
  };
  const domains = listOrganizationDomains(organizationQuery);
  const capabilities = listOrganizationCapabilities(organizationQuery);
  const services = listOrganizationServices(organizationQuery);
  const serviceStates = listOrganizationServiceStates(organizationQuery);
  const operations = listOrganizationOperations(organizationQuery);
  const operationStates = listOrganizationOperationStates(organizationQuery);
  const incidents = listOrganizationIncidents(organizationQuery);
  const cadences = listOrganizationCadences(organizationQuery);
  const decisions = listOrganizationDecisions(organizationQuery);
  const learningCandidates = listOrganizationLearningCandidates(organizationQuery);
  const solutionProjects = buildOrganizationProjectLineage(
    input.organizationId,
    input.tier,
    operationalState,
    input.rootDir
  );
  const lineage = buildOrganizationLineage({
    organizationId: input.organizationId,
    domains,
    capabilities,
    services,
    operations,
    incidents,
    cadences,
    decisions,
    projects: solutionProjects,
  });
  const reconciliation = reconcileOrganizationCatalog(organizationQuery);
  const profile = loadOrganizationProfile(input.rootDir);
  const pendingDecisions = new Set([
    ...(operationalState?.pending_decision_ids || []),
    ...reconciliation.pending_decisions,
  ]).size;
  const activeServices = services.filter((entry) => entry.status === 'active').length;
  const healthyServices = serviceStates.filter((entry) => entry.health === 'healthy').length;
  const degradedOrCriticalServices = serviceStates.filter(
    (entry) => entry.health === 'degraded' || entry.health === 'critical'
  ).length;
  const openIncidents = incidents.filter(
    (entry) => entry.status !== 'resolved' && entry.status !== 'closed'
  );
  const activeOperations = operations.filter((entry) => entry.status === 'active').length;
  const interventionPoints: OrganizationManagementView['control_plane']['intervention_points'] = [];
  for (const [key, values] of Object.entries(reconciliation)) {
    if (key === 'status' || !Array.isArray(values)) continue;
    for (const id of values) {
      interventionPoints.push({
        kind: key.includes('decision')
          ? 'decision'
          : key.includes('operation')
            ? 'operation'
            : key.includes('project')
              ? 'project'
              : 'reconciliation',
        id,
        priority:
          key.includes('incident') || key.includes('overdue') || key.includes('critical')
            ? 'high'
            : key.includes('pending') || key.includes('stale')
              ? 'medium'
              : 'low',
        reason: `${key} requires operator attention.`,
      });
    }
  }
  for (const incident of openIncidents) {
    interventionPoints.push({
      kind: 'incident',
      id: incident.incident_id,
      priority:
        incident.severity === 'critical' || incident.severity === 'high' ? 'high' : 'medium',
      reason: `Incident is ${incident.status}.`,
    });
  }
  for (const decision of decisions.filter(
    (entry) => entry.status === 'proposed' || entry.status === 'pending_approval'
  )) {
    interventionPoints.push({
      kind: 'decision',
      id: decision.decision_id,
      priority: 'high',
      reason: `Decision is ${decision.status}.`,
    });
  }
  const learningRefs = [
    ...(operationalState?.recent_outcome_refs || []),
    ...serviceStates.flatMap((entry) => entry.last_outcome_refs || []),
    ...learningCandidates.map((entry) => `learning:${entry.learning_id}`),
  ];
  const serviceStateById = new Map(serviceStates.map((entry) => [entry.service_id, entry]));
  const operationStateById = new Map(operationStates.map((entry) => [entry.operation_id, entry]));
  const outcomeRefs = [...new Set(learningRefs)];
  const outcomeAccounting = {
    objectives: (purpose?.objectives || []).map((objective) => ({
      objective_id: objective.objective_id,
      title: objective.title,
      coverage: outcomeRefs.some((ref) => ref.includes(objective.objective_id))
        ? ('linked' as const)
        : ('unlinked' as const),
      refs: outcomeRefs.filter((ref) => ref.includes(objective.objective_id)),
    })),
    services: services.map((service) => ({
      service_id: service.service_id,
      outcome: service.outcome,
      health: serviceStateById.get(service.service_id)?.health || service.status,
      refs: serviceStateById.get(service.service_id)?.last_outcome_refs || [],
    })),
    operations: operations.map((operation) => ({
      operation_id: operation.operation_id,
      result_summary: operationStateById.get(operation.operation_id)?.last_result_summary,
      evidence_refs: operationStateById.get(operation.operation_id)?.last_evidence_refs || [],
    })),
  };
  return {
    organization_id: input.organizationId,
    profile: profile?.organization_id === input.organizationId ? profile : null,
    purpose,
    operational_state: operationalState,
    domains,
    capabilities,
    services,
    service_states: serviceStates,
    operations,
    operation_states: operationStates,
    incidents,
    cadences,
    decisions,
    solution_projects: solutionProjects,
    learning_candidates: learningCandidates,
    lineage,
    reconciliation,
    catalog_version: catalog.version,
    control_plane: {
      accounting: {
        active_projects: operationalState?.active_project_ids?.length || 0,
        active_services: activeServices,
        healthy_services: healthyServices,
        degraded_or_critical_services: degradedOrCriticalServices,
        active_operations: activeOperations,
        overdue_operations: reconciliation.overdue_operations.length,
        open_incidents: openIncidents.length,
        pending_decisions: pendingDecisions,
      },
      outcome_accounting: outcomeAccounting,
      intervention_points: interventionPoints,
      learning_refs: [...new Set(learningRefs)].sort(),
    },
    readiness: {
      purpose: purpose?.approval_state === 'approved' ? 'approved' : purpose ? 'draft' : 'missing',
      operational_state: operationalState ? 'available' : 'missing',
      pending_human_decisions: pendingDecisions,
    },
  };
}
