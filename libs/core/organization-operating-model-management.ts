import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { loadOrganizationProfile } from './organization-profile.js';
import { listProjectRecords, loadProjectRecord } from './project-registry.js';
import { loadState } from './mission-state.js';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { createAjv } from './foundation/ajv.js';
import { safeExistsSync, safeReaddir, safeStat } from './secure-io.js';

type AddFormatsPlugin = (instance: ReturnType<typeof createAjv>) => void;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsPlugin }).default ||
  (addFormatsModule as unknown as AddFormatsPlugin);
const ajv = createAjv();
addFormats(ajv);

import {
  validatorFor,
  validationErrors,
  assertOrganizationId,
  assertTenantSlug,
  assertRecordIdentity,
  recordQueryTiers,
  recordQueryTenant,
  readJsonRecord,
  loadOrganizationOperatingModelCatalog,
  validateOrganizationOperationalState,
  validateOrganizationDomain,
  validateOrganizationCapability,
  validateOrganizationService,
  validateOrganizationServiceState,
  validateOrganizationOperation,
  validateOrganizationIncident,
  validateOrganizationCadence,
  validateOrganizationDecision,
  validateOrganizationLearningCandidate,
  organizationOperationalStatePath,
  loadOrganizationPurpose,
  saveOrganizationOperationalState,
  loadOrganizationOperationalState,
  listOrganizationRecordFiles,
} from './organization-operating-model-persistence.js';
import {
  listOrganizationOperations,
  listOrganizationOperationStates,
  listOrganizationOperationRuns,
  loadOrganizationCadence,
} from './organization-operating-model-operations.js';
import type {
  OrganizationTier,
  OrganizationRelationshipType,
  OrganizationOperationalState,
  OrganizationDomainRecord,
  OrganizationCapabilityRecord,
  OrganizationServiceRecord,
  OrganizationServiceState,
  OrganizationOperationRecord,
  OrganizationIncidentRecord,
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationLearningCandidate,
  OrganizationCatalog,
  OrganizationCatalogReconciliation,
  OrganizationProjectLineage,
  OrganizationLineage,
  OrganizationReconciliationResult,
  OrganizationManagementView,
} from './organization-operating-model.js';
import type { BuildOrganizationOperationInput } from './organization-operating-model-operations.js';

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

export function buildOrganizationProjectLineage(
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

export function buildOrganizationLineage(input: {
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

export function organizationStateFiles(rootDir: string): string[] {
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
  const tenantSlug = recordQueryTenant(query.tenantSlug || getRegisteredEnvText('KYBERION_TENANT'));
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
