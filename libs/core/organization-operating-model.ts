import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
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
import { getRegisteredEnvText } from './foundation/env.js';
import { createAjv } from './foundation/ajv.js';
import {
  safeExistsSync,
  loadJson,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeWriteFile,
} from './secure-io.js';

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

import {
  validatorFor,
  validationErrors,
  assertOrganizationId,
  assertTenantSlug,
  recordTenant,
  assertRecordIdentity,
  statePath,
  purposePath,
  recordPath,
  recordQueryTiers,
  recordQueryTenant,
  readJsonRecord,
  saveValidated,
  loadOrganizationOperatingModelCatalog,
  validateOrganizationPurpose,
  validateOrganizationOperationalState,
  validateOrganizationDomain,
  validateOrganizationCapability,
  validateOrganizationService,
  validateOrganizationServiceState,
  validateOrganizationOperation,
  validateOrganizationOperationState,
  validateOrganizationOperationRun,
  validateOrganizationWorkResolution,
  validateOrganizationIncident,
  validateOrganizationCadence,
  validateOrganizationDecision,
  validateOrganizationLearningCandidate,
  classifyOrganizationWork,
  resolveOrganizationWork,
  organizationPurposePath,
  organizationOperationalStatePath,
  saveOrganizationPurpose,
  loadOrganizationPurpose,
  saveOrganizationOperationalState,
  transitionOrganizationLifecycle,
  retireOrganizationEntity,
  removeOrganizationEntity,
  loadOrganizationOperationalState,
  saveOrganizationDomain,
  saveOrganizationCapability,
  saveOrganizationService,
  saveOrganizationServiceState,
  loadOrganizationDomain,
  loadOrganizationCapability,
  loadOrganizationService,
  loadOrganizationServiceState,
  operationDirectory,
} from './organization-operating-model-persistence.js';
import {
  saveOrganizationOperation,
  saveOrganizationOperationState,
  saveOrganizationOperationRun,
  loadOrganizationOperation,
  loadOrganizationOperationState,
  listOrganizationOperations,
  listOrganizationOperationStates,
  listOrganizationOperationRuns,
  saveOrganizationIncident,
  loadOrganizationIncident,
  saveOrganizationCadence,
  loadOrganizationCadence,
  saveOrganizationDecision,
  saveOrganizationLearningCandidate,
  buildOrganizationLearningCandidate,
  enqueueOrganizationLearningCandidate,
  buildOrganizationScaffold,
  buildOrganizationPurposeRecord,
  buildOrganizationObjectiveAddition,
  buildOrganizationDomainRecord,
  buildOrganizationServiceAddition,
  buildOrganizationServiceState,
} from './organization-operating-model-operations.js';
import {
  buildOrganizationOperationRecord,
  buildOrganizationCadence,
  buildOrganizationDecision,
  buildOrganizationProjectLink,
  listOrganizationIncidents,
  listOrganizationCadences,
  listOrganizationDecisions,
  listOrganizationLearningCandidates,
  organizationRecordFiles,
  listOrganizationRecordFiles,
  listOrganizationDomains,
  listOrganizationCapabilities,
  listOrganizationServices,
  listOrganizationServiceStates,
  loadOrganizationCatalog,
  reconcileOrganizationCatalog,
  reconcileOrganizationState,
  buildOrganizationProjectLineage,
  buildOrganizationLineage,
  organizationStateFiles,
  listOrganizationOperationalStates,
  buildOrganizationManagementView,
} from './organization-operating-model-management.js';
export type { OrganizationRecordKind } from './organization-operating-model-persistence.js';
export type { OrganizationLifecycleVerb } from './organization-operating-model-persistence.js';
export type { OrganizationRetireKind } from './organization-operating-model-persistence.js';
export type { BuildOrganizationScaffoldInput } from './organization-operating-model-operations.js';
export type { OrganizationScaffold } from './organization-operating-model-operations.js';
export type { BuildOrganizationPurposeInput } from './organization-operating-model-operations.js';
export type { BuildOrganizationObjectiveInput } from './organization-operating-model-operations.js';
export type { BuildOrganizationDomainInput } from './organization-operating-model-operations.js';
export type { BuildOrganizationServiceInput } from './organization-operating-model-operations.js';
export type { OrganizationServiceAddition } from './organization-operating-model-operations.js';
export type { BuildOrganizationServiceStateInput } from './organization-operating-model-operations.js';
export type { BuildOrganizationOperationInput } from './organization-operating-model-operations.js';
export type { BuildOrganizationCadenceInput } from './organization-operating-model-management.js';
export type { BuildOrganizationDecisionInput } from './organization-operating-model-management.js';
export type { OrganizationDecisionAddition } from './organization-operating-model-management.js';
export type { BuildOrganizationProjectLinkInput } from './organization-operating-model-management.js';

export {
  validatorFor,
  validationErrors,
  assertOrganizationId,
  assertTenantSlug,
  recordTenant,
  assertRecordIdentity,
  statePath,
  purposePath,
  recordPath,
  recordQueryTiers,
  recordQueryTenant,
  readJsonRecord,
  saveValidated,
  loadOrganizationOperatingModelCatalog,
  validateOrganizationPurpose,
  validateOrganizationOperationalState,
  validateOrganizationDomain,
  validateOrganizationCapability,
  validateOrganizationService,
  validateOrganizationServiceState,
  validateOrganizationOperation,
  validateOrganizationOperationState,
  validateOrganizationOperationRun,
  validateOrganizationWorkResolution,
  validateOrganizationIncident,
  validateOrganizationCadence,
  validateOrganizationDecision,
  validateOrganizationLearningCandidate,
  classifyOrganizationWork,
  resolveOrganizationWork,
  organizationPurposePath,
  organizationOperationalStatePath,
  saveOrganizationPurpose,
  loadOrganizationPurpose,
  saveOrganizationOperationalState,
  transitionOrganizationLifecycle,
  retireOrganizationEntity,
  removeOrganizationEntity,
  loadOrganizationOperationalState,
  saveOrganizationDomain,
  saveOrganizationCapability,
  saveOrganizationService,
  saveOrganizationServiceState,
  loadOrganizationDomain,
  loadOrganizationCapability,
  loadOrganizationService,
  loadOrganizationServiceState,
  operationDirectory,
  saveOrganizationOperation,
  saveOrganizationOperationState,
  saveOrganizationOperationRun,
  loadOrganizationOperation,
  loadOrganizationOperationState,
  listOrganizationOperations,
  listOrganizationOperationStates,
  listOrganizationOperationRuns,
  saveOrganizationIncident,
  loadOrganizationIncident,
  saveOrganizationCadence,
  loadOrganizationCadence,
  saveOrganizationDecision,
  saveOrganizationLearningCandidate,
  buildOrganizationLearningCandidate,
  enqueueOrganizationLearningCandidate,
  buildOrganizationScaffold,
  buildOrganizationPurposeRecord,
  buildOrganizationObjectiveAddition,
  buildOrganizationDomainRecord,
  buildOrganizationServiceAddition,
  buildOrganizationServiceState,
  buildOrganizationOperationRecord,
  buildOrganizationCadence,
  buildOrganizationDecision,
  buildOrganizationProjectLink,
  listOrganizationIncidents,
  listOrganizationCadences,
  listOrganizationDecisions,
  listOrganizationLearningCandidates,
  organizationRecordFiles,
  listOrganizationRecordFiles,
  listOrganizationDomains,
  listOrganizationCapabilities,
  listOrganizationServices,
  listOrganizationServiceStates,
  loadOrganizationCatalog,
  reconcileOrganizationCatalog,
  reconcileOrganizationState,
  buildOrganizationProjectLineage,
  buildOrganizationLineage,
  organizationStateFiles,
  listOrganizationOperationalStates,
  buildOrganizationManagementView,
};
