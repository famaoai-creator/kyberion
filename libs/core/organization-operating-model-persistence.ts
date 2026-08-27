import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { t } from './t.js';
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
  safeStat,
  safeWriteFile,
} from './secure-io.js';

type AddFormatsPlugin = (instance: ReturnType<typeof createAjv>) => void;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsPlugin }).default ||
  (addFormatsModule as unknown as AddFormatsPlugin);
const ajv = createAjv();
addFormats(ajv);

import type {
  OrganizationTier,
  OrganizationWorkShape,
  OrganizationOperatingModelCatalog,
  OrganizationPurposeRecord,
  OrganizationOperationalState,
  OrganizationDomainRecord,
  OrganizationCapabilityRecord,
  OrganizationServiceRecord,
  OrganizationServiceState,
  OrganizationOperationRecord,
  OrganizationOperationState,
  OrganizationOperationRun,
  OrganizationManagementUnit,
  OrganizationWorkResolution,
  OrganizationIncidentRecord,
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationLearningCandidate,
  ResolveOrganizationWorkInput,
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

export function validatorFor(schemaPath: string): ValidateFunction {
  const cached = validatorCache.get(schemaPath);
  if (cached) return cached;
  const validator = ajv.compile(loadJson<unknown>(schemaPath));
  validatorCache.set(schemaPath, validator);
  return validator;
}

export function validationErrors(validator: ValidateFunction): string {
  return (validator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
    .join('; ');
}

export function assertOrganizationId(organizationId: string): void {
  if (!ORGANIZATION_ID_RE.test(organizationId)) {
    throw new Error(`Invalid organization_id '${organizationId}'.`);
  }
}

export function assertTenantSlug(tenantSlug: string): void {
  if (tenantSlug !== 'shared' && !isValidTenantSlug(tenantSlug)) {
    throw new Error(`Invalid tenant_slug '${tenantSlug}'.`);
  }
}

export function recordTenant(record: { tenant_slug?: string }): string {
  const tenantSlug = record.tenant_slug?.trim() || 'shared';
  assertTenantSlug(tenantSlug);
  return tenantSlug;
}

export function assertRecordIdentity(
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
    (getRegisteredEnvText('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !process.env.VITEST)
  ) {
    resolveTenant(record.tenant_slug, { rootDir });
  }
}

export function statePath(
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

export function purposePath(
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

export type OrganizationRecordKind =
  | 'domains'
  | 'capabilities'
  | 'services'
  | 'operations'
  | 'incidents'
  | 'cadences'
  | 'decisions'
  | 'learning';

export function recordPath(
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

export function recordQueryTiers(tier?: OrganizationTier): OrganizationTier[] {
  return tier ? [tier] : ['personal', 'confidential', 'public'];
}

export function recordQueryTenant(tenantSlug?: string): string {
  const tenant = tenantSlug || 'shared';
  assertTenantSlug(tenant);
  return tenant;
}

export function readJsonRecord<T>(filePath: string, label: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return loadJson<T>(filePath);
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${String(error)}`);
  }
}

export function saveValidated<T>(
  record: T,
  schemaPath: string,
  filePath: string,
  label: string
): string {
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

export function classifyOrganizationWork(
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
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'organization_controller',
    action: `organization.${input.verb}`,
    operation: `${input.verb}:${input.organizationId}`,
    result: 'completed',
    ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
    metadata: { organization_id: input.organizationId, reason: input.reason },
  });
  return next;
}

export type OrganizationRetireKind = 'domain' | 'capability' | 'service' | 'operation' | 'cadence';

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

export function organizationRecordFiles(rootDir: string, fileName: string): string[] {
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

export function listOrganizationRecordFiles(
  kind: OrganizationRecordKind,
  fileName: string,
  query: { organizationId?: string; tier?: OrganizationTier; tenantSlug?: string; rootDir?: string }
): string[] {
  if (query.organizationId) assertOrganizationId(query.organizationId);
  const tenantSlug = recordQueryTenant(query.tenantSlug || getRegisteredEnvText('KYBERION_TENANT'));
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

export function operationDirectory(
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
