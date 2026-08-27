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
  listOrganizationRecordFiles,
} from './organization-operating-model-persistence.js';
import type {
  OrganizationTier,
  OrganizationWorkShape,
  OrganizationRelationshipType,
  OrganizationOperatingModelCatalog,
  OrganizationPurposeObjective,
  OrganizationPurposeRecord,
  OrganizationServiceHealthSummary,
  OrganizationOperationalState,
  OrganizationDomainRecord,
  OrganizationCapabilityRecord,
  OrganizationServiceRecord,
  OrganizationServiceState,
  OrganizationOperationType,
  OrganizationOperationRecord,
  OrganizationOperationState,
  OrganizationOperationRun,
  OrganizationManagementUnit,
  OrganizationWorkResolution,
  OrganizationIncidentRecord,
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationLearningSourceType,
  OrganizationLearningCandidate,
  QueueOrganizationLearningCandidateInput,
  OrganizationCatalog,
  OrganizationCatalogReconciliation,
  OrganizationProjectLineage,
  OrganizationLineage,
  OrganizationReconciliationResult,
  OrganizationManagementView,
} from './organization-operating-model.js';

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
