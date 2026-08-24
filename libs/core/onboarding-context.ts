import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import {
  assertTenantOperational,
  readTenantProfile,
  type TenantProfile,
} from './tenant-registry.js';
import { customerDirForSlug } from './customer-resolver.js';
import { isTenantActivationActive } from './tenant-activation.js';
import { loadOrganizationProfile, type OrganizationProfile } from './organization-profile.js';
import {
  buildOrganizationScaffold,
  buildOrganizationOperationRecord,
  loadOrganizationOperationalState,
  loadOrganizationService,
  loadOrganizationOperation,
  loadOrganizationIncident,
  loadOrganizationCadence,
  saveOrganizationCadence,
  saveOrganizationIncident,
  saveOrganizationOperation,
  type OrganizationOperationalState,
  saveOrganizationOperationalState,
  saveOrganizationPurpose,
  resolveOrganizationWork,
  type OrganizationCadenceRecord,
  type OrganizationIncidentRecord,
  type OrganizationTier,
  type OrganizationWorkResolution,
} from './organization-operating-model.js';
import { bootstrapManagedProject, type ProjectBootstrapResult } from './project-management.js';
import { createWorkItem, getWorkItem, updateWorkItem, type WorkItem } from './work-coordination.js';
import { loadProjectRecord } from './project-registry.js';
import { pathResolver } from './path-resolver.js';
import { createAjv } from './foundation/ajv.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
  loadJson,
} from './secure-io.js';

type AddFormatsPlugin = typeof import('ajv-formats').default;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormatsPlugin }).default ||
  (addFormatsModule as unknown as AddFormatsPlugin);
const ajv = createAjv();
addFormats(ajv);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/onboarding-context-binding.schema.json'
);
const validator: ValidateFunction = compileSchemaFromPath(ajv, SCHEMA_PATH);
const FIRST_WORK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/onboarding-first-work.schema.json'
);
const firstWorkValidator: ValidateFunction = compileSchemaFromPath(ajv, FIRST_WORK_SCHEMA_PATH);
const CUSTOMER_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type OnboardingContextBindingStatus = 'draft' | 'confirmed' | 'active' | 'blocked';

export interface OnboardingContextBinding {
  version: '1.0.0';
  kind: 'onboarding_context_binding';
  customer_slug: string;
  tenant_slug: string;
  organization_id: string;
  organization_name?: string;
  tier: OrganizationTier;
  owner_id: string;
  status: OnboardingContextBindingStatus;
  default_project_id?: string;
  default_service_ids: string[];
  source_refs?: string[];
  created_at: string;
  updated_at: string;
}

export interface ResolveOnboardingContextInput {
  customerSlug: string;
  tenantSlug: string;
  organizationId?: string;
  tier?: OrganizationTier;
  ownerId?: string;
  rootDir?: string;
}

export interface ApplyOnboardingContextInput extends ResolveOnboardingContextInput {
  organizationName?: string;
  purpose?: string;
  principles?: string[];
  ownerRole?: string;
}

export interface OnboardingContextResolution {
  mode: 'dry_run';
  binding: OnboardingContextBinding;
  customer_exists: boolean;
  tenant: TenantProfile;
  organization_profile: OrganizationProfile | null;
  organization_state: ReturnType<typeof loadOrganizationOperationalState>;
  would_write: string[];
}

export interface OnboardingContextApplyResult {
  mode: 'apply';
  binding: OnboardingContextBinding;
  saved_paths: string[];
  reused: boolean;
}

export interface ResolveOnboardingFirstWorkInput {
  customerSlug: string;
  intent: string;
  rootDir?: string;
  contextRefs?: {
    domain_id?: string;
    service_id?: string;
    operation_id?: string;
    project_id?: string;
    incident_id?: string;
    cadence_id?: string;
  };
}

export interface OnboardingFirstWorkResolution {
  kind: 'onboarding_first_work_resolution';
  binding: OnboardingContextBinding;
  resolution: OrganizationWorkResolution;
  project_required: boolean;
  next_action: 'bootstrap_project' | 'select_management_unit' | 'request_human_confirmation';
}

export interface ApplyOnboardingFirstWorkInput extends ResolveOnboardingFirstWorkInput {
  accept: boolean;
  bootstrapProject?: {
    projectId: string;
    name: string;
    summary: string;
    utterance?: string;
    trackId?: string;
    trackName?: string;
    serviceBindings?: string[];
  };
}

export interface ApplyOnboardingFirstWorkResult {
  mode: 'apply';
  resolution: OnboardingFirstWorkResolution;
  action: 'project_bootstrapped' | 'management_unit_connected';
  project?: ProjectBootstrapResult;
  work_item?: WorkItem;
  saved_paths: string[];
}

export interface OnboardingFirstWorkRecord {
  version: '1.0.0';
  kind: 'onboarding_first_work';
  work_id: string;
  customer_slug: string;
  tenant_slug: string;
  organization_id: string;
  tier: OrganizationTier;
  intent: string;
  work_shape: OrganizationWorkResolution['work_shape'];
  management_unit: Exclude<OrganizationWorkResolution['management_unit'], 'task_session'>;
  management_unit_id?: string;
  work_item_id?: string;
  human_decision: 'accepted' | 'corrected';
  status: 'active' | 'completed' | 'blocked';
  source_refs?: string[];
  created_at: string;
  updated_at: string;
}

function errors(): string {
  return (validator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim())
    .join('; ');
}

function assertCustomerSlug(slug: string): string {
  const normalized = slug.trim();
  if (!CUSTOMER_SLUG_RE.test(normalized)) throw new Error(`Invalid customer_slug: ${slug}`);
  return normalized;
}

function contextPath(customerSlug: string, rootDir = pathResolver.rootDir()): string {
  return path.join(rootDir, 'customer', customerSlug, 'onboarding', 'organization-context.json');
}

function firstWorkPath(customerSlug: string, rootDir = pathResolver.rootDir()): string {
  return path.join(rootDir, 'customer', customerSlug, 'onboarding', 'first-work-resolution.json');
}

function firstWorkId(binding: OnboardingContextBinding, intent: string): string {
  const digest = createHash('sha256')
    .update(`${binding.customer_slug}:${binding.tenant_slug}:${binding.organization_id}:${intent}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `ONB-WORK-${digest}`;
}

function onboardingWorkItemId(workId: string): string {
  return workId.replace('ONB-WORK-', 'ONB-ITEM-');
}

function createOnboardingWorkItem(input: {
  binding: OnboardingContextBinding;
  intent: string;
  workShape: OrganizationWorkResolution['work_shape'];
  managementUnitId: string;
  projectId?: string;
  rootDir: string;
}): WorkItem {
  const workId = firstWorkId(input.binding, input.intent);
  return createWorkItem({
    itemId: onboardingWorkItemId(workId),
    title: input.intent.trim(),
    description: `First work routed to ${input.binding.organization_id}/${input.binding.tenant_slug}.`,
    status: 'ready',
    priority: 'normal',
    source: 'local',
    sourceRef: workId,
    projectId: input.projectId || 'default',
    rootDir: input.rootDir,
    context: {
      organization_id: input.binding.organization_id,
      tenant_slug: input.binding.tenant_slug,
      project_id: input.projectId || 'default',
      task_id: input.managementUnitId,
      work_shape: input.workShape,
    },
    metadata: {
      onboarding_work_id: workId,
      management_unit_id: input.managementUnitId,
      management_unit: input.projectId ? 'project' : 'organization_management_unit',
    },
  });
}

function archiveOnboardingWorkItem(item: WorkItem | undefined, rootDir: string): void {
  if (!item) return;
  try {
    updateWorkItem({
      itemId: item.item_id,
      status: 'archived',
      rootDir,
      metadata: { onboarding_rollback: true },
    });
  } catch {
    // The original failure is more actionable than a best-effort cleanup failure.
  }
}

function withCustomer<T>(customerSlug: string, fn: () => T): T {
  const previous = process.env.KYBERION_CUSTOMER;
  process.env.KYBERION_CUSTOMER = customerSlug;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.KYBERION_CUSTOMER;
    else process.env.KYBERION_CUSTOMER = previous;
  }
}

function validateBinding(value: unknown): OnboardingContextBinding {
  if (!validator(value)) throw new Error(`Invalid onboarding context binding: ${errors()}`);
  return value as OnboardingContextBinding;
}

function validateFirstWorkRecord(value: unknown): OnboardingFirstWorkRecord {
  if (!firstWorkValidator(value)) {
    const detail = (firstWorkValidator.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim())
      .join('; ');
    throw new Error(`Invalid onboarding first work record: ${detail}`);
  }
  return value as OnboardingFirstWorkRecord;
}

export function loadOnboardingFirstWorkRecord(
  customerSlug: string,
  rootDir = pathResolver.rootDir()
): OnboardingFirstWorkRecord | null {
  const filePath = firstWorkPath(assertCustomerSlug(customerSlug), rootDir);
  if (!safeExistsSync(filePath)) return null;
  return validateFirstWorkRecord(loadJson<unknown>(filePath));
}

function saveOnboardingFirstWorkRecord(record: OnboardingFirstWorkRecord, rootDir: string): string {
  const filePath = firstWorkPath(record.customer_slug, rootDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(validateFirstWorkRecord(record), null, 2)}\n`, {
    encoding: 'utf8',
  });
  return filePath;
}

function unitIdFor(
  binding: OnboardingContextBinding,
  resolution: OrganizationWorkResolution,
  intent: string
): string {
  const digest = createHash('sha256')
    .update(`${binding.customer_slug}:${binding.organization_id}:${intent}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  const prefix = {
    service: 'SVC',
    operation: 'OP',
    incident: 'INC',
    cadence: 'CAD',
    experiment: 'EXP',
  }[resolution.management_unit];
  if (!prefix)
    throw new Error(`Unsupported onboarding management unit: ${resolution.management_unit}`);
  return `${prefix}-ONB-${digest}`;
}

function addUnique(values: string[] | undefined, value: string): string[] {
  return [...new Set([...(values || []), value])].sort();
}

function saveOrganizationStateLink(
  state: OrganizationOperationalState | null,
  kind: 'operation' | 'incident',
  id: string,
  rootDir: string
): string | undefined {
  if (!state) return undefined;
  const next = {
    ...state,
    ...(kind === 'operation'
      ? { active_operation_ids: addUnique(state.active_operation_ids, id) }
      : { open_incident_ids: addUnique(state.open_incident_ids, id) }),
    updated_at: new Date().toISOString(),
  };
  return saveOrganizationOperationalState(next, { rootDir });
}

function organizationManagementRecordPath(
  binding: OnboardingContextBinding,
  managementUnit: Exclude<
    OrganizationWorkResolution['management_unit'],
    'task_session' | 'project' | 'service'
  >,
  id: string,
  rootDir: string
): string {
  const fileName = {
    operation: 'operation.json',
    incident: 'incident.json',
    cadence: 'cadence.json',
    experiment: 'experiment.json',
  }[managementUnit];
  return path.join(
    pathResolver.organizationStateDir(
      binding.organization_id,
      binding.tier,
      binding.tenant_slug,
      rootDir
    ),
    `${managementUnit}s`,
    id,
    fileName
  );
}

function contextRefFor(
  managementUnit: OrganizationWorkResolution['management_unit'],
  resolution: OrganizationWorkResolution
): string | undefined {
  const refs = resolution.context_refs;
  if (!refs) return undefined;
  switch (managementUnit) {
    case 'service':
      return refs.service_id;
    case 'operation':
      return refs.operation_id;
    case 'incident':
      return refs.incident_id;
    case 'cadence':
      return refs.cadence_id;
    case 'project':
      return refs.project_id;
    default:
      return undefined;
  }
}

function validateReferencedManagementUnit(
  binding: OnboardingContextBinding,
  resolution: OrganizationWorkResolution,
  id: string,
  rootDir: string
): void {
  const query = {
    organizationId: binding.organization_id,
    tier: binding.tier,
    tenantSlug: binding.tenant_slug,
    rootDir,
  };
  if (resolution.management_unit === 'service') {
    if (!loadOrganizationService(id, query))
      throw new Error(`Service '${id}' is not registered for the onboarding context.`);
    return;
  }
  if (resolution.management_unit === 'operation') {
    if (!loadOrganizationOperation(id, query))
      throw new Error(`Operation '${id}' is not registered for the onboarding context.`);
    return;
  }
  if (resolution.management_unit === 'incident') {
    if (!loadOrganizationIncident(id, query))
      throw new Error(`Incident '${id}' is not registered for the onboarding context.`);
    return;
  }
  if (resolution.management_unit === 'cadence') {
    if (!loadOrganizationCadence(id, query))
      throw new Error(`Cadence '${id}' is not registered for the onboarding context.`);
    return;
  }
  if (resolution.management_unit === 'experiment') {
    throw new Error(
      `Experiment '${id}' cannot be referenced before a governed experiment record exists.`
    );
  }
}

function bindingFor(
  input: ApplyOnboardingContextInput,
  profile: OrganizationProfile | null
): OnboardingContextBinding {
  const customerSlug = assertCustomerSlug(input.customerSlug);
  const organizationId = (input.organizationId || profile?.organization_id || '').trim();
  if (!organizationId)
    throw new Error('organization_id is required when no organization profile exists.');
  if (
    profile?.organization_id &&
    input.organizationId &&
    profile.organization_id !== input.organizationId
  ) {
    throw new Error(
      `Organization profile '${profile.organization_id}' does not match requested organization '${input.organizationId}'.`
    );
  }
  const tier = input.tier || 'confidential';
  const now = new Date().toISOString();
  const binding: OnboardingContextBinding = {
    version: '1.0.0',
    kind: 'onboarding_context_binding',
    customer_slug: customerSlug,
    tenant_slug: input.tenantSlug.trim(),
    organization_id: organizationId,
    ...(input.organizationName || profile?.name
      ? { organization_name: input.organizationName?.trim() || profile?.name }
      : {}),
    tier,
    owner_id: input.ownerId?.trim() || profile?.accountable_human_resource_id || 'human:operator',
    status: 'draft',
    default_service_ids: [],
    source_refs: [`customer:${customerSlug}`, `tenant:${input.tenantSlug.trim()}`],
    created_at: now,
    updated_at: now,
  };
  return validateBinding(binding);
}

function resolveTenantForCustomer(
  customerSlug: string,
  tenantSlug: string,
  rootDir: string
): TenantProfile {
  const profile = readTenantProfile(tenantSlug, {
    rootDir,
    env: { ...process.env, KYBERION_CUSTOMER: customerSlug },
  });
  if (!profile) {
    throw new Error(`Tenant '${tenantSlug}' is not registered for customer '${customerSlug}'.`);
  }
  assertTenantOperational(profile, 'onboarding context binding');
  return profile;
}

function assertCurrentOnboardingContext(binding: OnboardingContextBinding, rootDir: string): void {
  if (binding.status !== 'active') {
    throw new Error(
      `Onboarding context binding is ${binding.status}; first work requires an active binding.`
    );
  }
  const tenant = resolveTenantForCustomer(binding.customer_slug, binding.tenant_slug, rootDir);
  if (tenant.tenant_slug !== binding.tenant_slug) {
    throw new Error(
      `Onboarding context tenant '${binding.tenant_slug}' no longer matches the registry.`
    );
  }
  const state = loadOrganizationOperationalState(binding.organization_id, {
    tier: binding.tier,
    tenantSlug: binding.tenant_slug,
    rootDir,
  });
  if (!state) {
    throw new Error(`Organization '${binding.organization_id}' is missing its operating state.`);
  }
  if (state.status !== 'active') {
    throw new Error(
      `Organization '${binding.organization_id}' is ${state.status}; first work is blocked.`
    );
  }
  if (
    !isTenantActivationActive(
      {
        customerSlug: binding.customer_slug,
        tenantSlug: binding.tenant_slug,
        organizationId: binding.organization_id,
        tier: binding.tier,
      },
      rootDir
    )
  ) {
    throw new Error(
      `Tenant activation is not active for '${binding.customer_slug}/${binding.tenant_slug}'. ` +
        'Run tenant:activation plan, complete the readiness probes, and apply the activation receipt.'
    );
  }
}

export function loadOnboardingContextBinding(
  customerSlug: string,
  rootDir = pathResolver.rootDir()
): OnboardingContextBinding | null {
  const filePath = contextPath(assertCustomerSlug(customerSlug), rootDir);
  if (!safeExistsSync(filePath)) return null;
  return validateBinding(loadJson<unknown>(filePath));
}

export function resolveOnboardingContext(
  input: ResolveOnboardingContextInput
): OnboardingContextResolution {
  const customerSlug = assertCustomerSlug(input.customerSlug);
  const rootDir = input.rootDir || pathResolver.rootDir();
  const customerPath = customerDirForSlug(customerSlug, rootDir);
  const customerExists = safeExistsSync(customerPath);
  if (!customerExists) throw new Error(`Customer overlay '${customerSlug}' does not exist.`);
  const tenantSlug = input.tenantSlug.trim();
  const tenant = resolveTenantForCustomer(customerSlug, tenantSlug, rootDir);
  const profile = withCustomer(customerSlug, () => loadOrganizationProfile(rootDir));
  const binding = bindingFor({ ...input, customerSlug, tenantSlug }, profile);
  const organizationState = loadOrganizationOperationalState(binding.organization_id, {
    tier: binding.tier,
    tenantSlug: binding.tenant_slug,
    rootDir,
  });
  if (
    organizationState &&
    (organizationState.tenant_slug !== binding.tenant_slug ||
      organizationState.tier !== binding.tier)
  ) {
    throw new Error(
      `Organization '${binding.organization_id}' is not bound to tenant '${binding.tenant_slug}' at tier '${binding.tier}'.`
    );
  }
  const existingBinding = loadOnboardingContextBinding(customerSlug, rootDir);
  if (
    existingBinding &&
    (existingBinding.tenant_slug !== binding.tenant_slug ||
      existingBinding.organization_id !== binding.organization_id ||
      existingBinding.tier !== binding.tier)
  ) {
    throw new Error(`Existing onboarding context binding conflicts with the requested context.`);
  }
  const resolvedBinding = existingBinding || binding;
  return {
    mode: 'dry_run',
    binding: resolvedBinding,
    customer_exists: customerExists,
    tenant,
    organization_profile: profile,
    organization_state: organizationState,
    would_write: existingBinding
      ? organizationState
        ? []
        : [
            path.join(
              pathResolver.organizationStateDir(
                binding.organization_id,
                binding.tier,
                binding.tenant_slug,
                rootDir
              ),
              'organization-state.json'
            ),
          ]
      : [
          contextPath(customerSlug, rootDir),
          path.join(
            pathResolver.organizationStateDir(
              binding.organization_id,
              binding.tier,
              binding.tenant_slug,
              rootDir
            ),
            'organization-state.json'
          ),
        ],
  };
}

export function applyOnboardingContextBinding(
  input: ApplyOnboardingContextInput
): OnboardingContextApplyResult {
  const resolved = resolveOnboardingContext(input);
  const rootDir = input.rootDir || pathResolver.rootDir();
  return withCustomer(resolved.binding.customer_slug, () => {
    const existing = loadOnboardingContextBinding(input.customerSlug, rootDir);
    const statePath = path.join(
      pathResolver.organizationStateDir(
        resolved.binding.organization_id,
        resolved.binding.tier,
        resolved.binding.tenant_slug,
        rootDir
      ),
      'organization-state.json'
    );
    const purposePath = path.join(path.dirname(statePath), 'purpose.json');
    if (existing && resolved.organization_state) {
      return { mode: 'apply', binding: existing, saved_paths: [], reused: true };
    }

    const binding: OnboardingContextBinding = existing
      ? existing
      : {
          ...resolved.binding,
          status: 'active',
          updated_at: new Date().toISOString(),
        };
    const organizationState = resolved.organization_state;
    const savedPaths: string[] = [];
    const previousFiles = new Map<string, string | undefined>();
    for (const filePath of [statePath, purposePath, contextPath(binding.customer_slug, rootDir)]) {
      previousFiles.set(
        filePath,
        safeExistsSync(filePath)
          ? (safeReadFile(filePath, { encoding: 'utf8' }) as string)
          : undefined
      );
    }
    try {
      if (!organizationState) {
        const scaffold = buildOrganizationScaffold({
          organizationId: binding.organization_id,
          name: binding.organization_name || binding.organization_id,
          tier: binding.tier,
          tenantSlug: binding.tenant_slug,
          purpose: input.purpose?.trim(),
          principles: input.principles,
          ownerRole: input.ownerRole || 'operator',
          rootDir,
        });
        savedPaths.push(saveOrganizationOperationalState(scaffold.state, { rootDir }));
        if (scaffold.purpose && !safeExistsSync(purposePath))
          savedPaths.push(saveOrganizationPurpose(scaffold.purpose, { rootDir }));
      }
      if (!existing) {
        const filePath = contextPath(binding.customer_slug, rootDir);
        safeMkdir(path.dirname(filePath), { recursive: true });
        safeWriteFile(filePath, `${JSON.stringify(binding, null, 2)}\n`, { encoding: 'utf8' });
        savedPaths.push(filePath);
      }
      return { mode: 'apply', binding, saved_paths: savedPaths, reused: Boolean(existing) };
    } catch (error) {
      for (const [filePath, previous] of previousFiles) {
        if (previous === undefined) safeUnlinkSync(filePath);
        else safeWriteFile(filePath, previous, { encoding: 'utf8' });
      }
      throw error;
    }
  });
}

export function resolveOnboardingFirstWork(
  input: ResolveOnboardingFirstWorkInput
): OnboardingFirstWorkResolution {
  const binding = loadOnboardingContextBinding(input.customerSlug, input.rootDir);
  if (!binding)
    throw new Error(`Onboarding context binding is missing for '${input.customerSlug}'.`);
  assertCurrentOnboardingContext(binding, input.rootDir || pathResolver.rootDir());
  const resolution = resolveOrganizationWork({
    utterance: input.intent,
    organizationId: binding.organization_id,
    tier: binding.tier,
    tenantSlug: binding.tenant_slug,
    contextRefs: {
      ...(binding.default_project_id ? { project_id: binding.default_project_id } : {}),
      ...(input.contextRefs || {}),
    },
  });
  const projectRequired = resolution.work_shape === 'solution_project';
  return {
    kind: 'onboarding_first_work_resolution',
    binding,
    resolution,
    project_required: projectRequired,
    next_action:
      resolution.confidence < 0.7 || resolution.authority_class === 'approval_required'
        ? 'request_human_confirmation'
        : projectRequired
          ? 'bootstrap_project'
          : 'select_management_unit',
  };
}

export function applyOnboardingFirstWork(
  input: ApplyOnboardingFirstWorkInput
): ApplyOnboardingFirstWorkResult {
  if (!input.accept) throw new Error('Human acceptance is required before applying first work.');
  const resolved = resolveOnboardingFirstWork(input);
  const rootDir = input.rootDir || pathResolver.rootDir();
  return withCustomer(resolved.binding.customer_slug, () => {
    const existingRecord = loadOnboardingFirstWorkRecord(resolved.binding.customer_slug, rootDir);
    if (existingRecord) {
      const requestedReference =
        contextRefFor(resolved.resolution.management_unit, resolved.resolution) ||
        (resolved.resolution.management_unit === 'service'
          ? resolved.binding.default_service_ids[0]
          : undefined);
      const requestedProject = resolved.project_required
        ? input.bootstrapProject?.projectId
        : undefined;
      if (
        existingRecord.intent !== input.intent.trim() ||
        existingRecord.work_shape !== resolved.resolution.work_shape ||
        existingRecord.management_unit !== resolved.resolution.management_unit ||
        (requestedReference && existingRecord.management_unit_id !== requestedReference) ||
        (requestedProject && existingRecord.management_unit_id !== requestedProject)
      ) {
        throw new Error(
          `Existing first-work record '${existingRecord.work_id}' conflicts with the requested intent or context references.`
        );
      }
      if (existingRecord.work_item_id) {
        const existingWorkItem = getWorkItem(existingRecord.work_item_id, { rootDir });
        if (!existingWorkItem || existingWorkItem.status === 'archived') {
          throw new Error(
            `Existing first-work record '${existingRecord.work_id}' references a missing or archived WorkItem '${existingRecord.work_item_id}'.`
          );
        }
      }
      return {
        mode: 'apply',
        resolution: resolved,
        action:
          existingRecord.management_unit === 'project'
            ? 'project_bootstrapped'
            : 'management_unit_connected',
        saved_paths: [],
      };
    }
    if (resolved.project_required) {
      const bootstrap = input.bootstrapProject;
      if (!bootstrap)
        throw new Error('Project bootstrap details are required for solution_project.');
      const requestedProjectId = resolved.resolution.context_refs?.project_id;
      if (requestedProjectId && requestedProjectId !== bootstrap.projectId) {
        throw new Error(
          `Bootstrap project '${bootstrap.projectId}' does not match the requested project context '${requestedProjectId}'.`
        );
      }
      const existing = loadProjectRecord(bootstrap.projectId, { rootDir });
      if (existing) {
        if (
          existing.organization_id !== resolved.binding.organization_id ||
          existing.tenant_slug !== resolved.binding.tenant_slug
        ) {
          throw new Error(
            `Existing project '${bootstrap.projectId}' conflicts with onboarding context.`
          );
        }
        const nextBinding: OnboardingContextBinding = {
          ...resolved.binding,
          default_project_id: existing.project_id,
          updated_at: new Date().toISOString(),
        };
        const bindingPath = contextPath(nextBinding.customer_slug, rootDir);
        const previousBinding = safeReadFile(bindingPath, { encoding: 'utf8' }) as string;
        safeWriteFile(bindingPath, `${JSON.stringify(nextBinding, null, 2)}\n`, {
          encoding: 'utf8',
        });
        let workItem: WorkItem | undefined;
        try {
          const now = new Date().toISOString();
          workItem = createOnboardingWorkItem({
            binding: nextBinding,
            intent: input.intent,
            workShape: resolved.resolution.work_shape,
            managementUnitId: existing.project_id,
            projectId: existing.project_id,
            rootDir,
          });
          const firstWork = validateFirstWorkRecord({
            version: '1.0.0',
            kind: 'onboarding_first_work',
            work_id: firstWorkId(nextBinding, input.intent),
            customer_slug: nextBinding.customer_slug,
            tenant_slug: nextBinding.tenant_slug,
            organization_id: nextBinding.organization_id,
            tier: nextBinding.tier,
            intent: input.intent.trim(),
            work_shape: resolved.resolution.work_shape,
            management_unit: 'project',
            management_unit_id: existing.project_id,
            human_decision: 'accepted',
            status: 'active',
            work_item_id: workItem.item_id,
            source_refs: [
              `organization:${nextBinding.organization_id}`,
              `project:${existing.project_id}`,
              `work_item:${workItem.item_id}`,
            ],
            created_at: now,
            updated_at: now,
          });
          const firstWorkPath = saveOnboardingFirstWorkRecord(firstWork, rootDir);
          return {
            mode: 'apply',
            resolution: { ...resolved, binding: nextBinding },
            action: 'project_bootstrapped',
            work_item: workItem,
            saved_paths: [bindingPath, firstWorkPath],
          };
        } catch (error) {
          safeWriteFile(bindingPath, previousBinding, { encoding: 'utf8' });
          archiveOnboardingWorkItem(workItem, rootDir);
          throw error;
        }
      }
      const savedPaths: string[] = [];
      let projectWorkItem: WorkItem | undefined;
      let projectCommitRollback: (() => void) | undefined;
      const project = bootstrapManagedProject({
        project_id: bootstrap.projectId,
        name: bootstrap.name,
        summary: bootstrap.summary,
        tier: resolved.binding.tier,
        organization_id: resolved.binding.organization_id,
        tenant_slug: resolved.binding.tenant_slug,
        utterance: bootstrap.utterance || input.intent,
        track_id: bootstrap.trackId,
        track_name: bootstrap.trackName,
        service_bindings: bootstrap.serviceBindings,
        rootDir,
        onCommit: (bootstrapped) => {
          const bindingPath = contextPath(resolved.binding.customer_slug, rootDir);
          const previousBinding = safeExistsSync(bindingPath)
            ? (safeReadFile(bindingPath, { encoding: 'utf8' }) as string)
            : undefined;
          let firstWorkPath: string | undefined;
          let workItem: WorkItem | undefined;
          const rollbackCommit = (): void => {
            if (firstWorkPath) safeUnlinkSync(firstWorkPath);
            archiveOnboardingWorkItem(workItem, rootDir);
            if (previousBinding === undefined) safeUnlinkSync(bindingPath);
            else safeWriteFile(bindingPath, previousBinding, { encoding: 'utf8' });
            for (const savedPath of savedPaths) {
              if (savedPath !== bindingPath && savedPath !== firstWorkPath)
                safeUnlinkSync(savedPath);
            }
          };
          projectCommitRollback = rollbackCommit;
          try {
            const nextBinding: OnboardingContextBinding = {
              ...resolved.binding,
              default_project_id: bootstrapped.project.project_id,
              updated_at: new Date().toISOString(),
            };
            safeMkdir(path.dirname(bindingPath), { recursive: true });
            safeWriteFile(bindingPath, `${JSON.stringify(nextBinding, null, 2)}\n`, {
              encoding: 'utf8',
            });
            savedPaths.push(bindingPath);
            const now = new Date().toISOString();
            workItem = createOnboardingWorkItem({
              binding: nextBinding,
              intent: input.intent,
              workShape: resolved.resolution.work_shape,
              managementUnitId: bootstrapped.project.project_id,
              projectId: bootstrapped.project.project_id,
              rootDir,
            });
            projectWorkItem = workItem;
            const firstWork = validateFirstWorkRecord({
              version: '1.0.0',
              kind: 'onboarding_first_work',
              work_id: firstWorkId(nextBinding, input.intent),
              customer_slug: nextBinding.customer_slug,
              tenant_slug: nextBinding.tenant_slug,
              organization_id: nextBinding.organization_id,
              tier: nextBinding.tier,
              intent: input.intent.trim(),
              work_shape: resolved.resolution.work_shape,
              management_unit: 'project',
              management_unit_id: bootstrapped.project.project_id,
              human_decision: 'accepted',
              status: 'active',
              work_item_id: workItem.item_id,
              source_refs: [
                `organization:${nextBinding.organization_id}`,
                `project:${bootstrapped.project.project_id}`,
                `work_item:${workItem.item_id}`,
              ],
              created_at: now,
              updated_at: now,
            });
            firstWorkPath = saveOnboardingFirstWorkRecord(firstWork, rootDir);
            savedPaths.push(firstWorkPath);
          } catch (error) {
            rollbackCommit();
            projectCommitRollback = undefined;
            throw error;
          }
        },
        onRollback: () => {
          projectCommitRollback?.();
          projectCommitRollback = undefined;
        },
      });
      return {
        mode: 'apply',
        resolution: {
          ...resolved,
          binding: { ...resolved.binding, default_project_id: project.project.project_id },
        },
        action: 'project_bootstrapped',
        project,
        ...(projectWorkItem ? { work_item: projectWorkItem } : {}),
        saved_paths: savedPaths,
      };
    }
    const managementUnit = resolved.resolution.management_unit;
    const contextUnitId = contextRefFor(managementUnit, resolved.resolution);
    const defaultServiceId =
      managementUnit === 'service'
        ? contextUnitId || resolved.binding.default_service_ids[0]
        : undefined;
    const referencedUnitId = defaultServiceId || contextUnitId;
    const managementUnitId =
      referencedUnitId?.trim() || unitIdFor(resolved.binding, resolved.resolution, input.intent);
    if (referencedUnitId) {
      validateReferencedManagementUnit(
        resolved.binding,
        resolved.resolution,
        referencedUnitId,
        rootDir
      );
    }
    if (managementUnit === 'service') {
      const serviceId = defaultServiceId;
      if (!serviceId) {
        throw new Error(
          'Service onboarding requires an existing service_id in the first-work context.'
        );
      }
      const service = loadOrganizationService(serviceId, {
        organizationId: resolved.binding.organization_id,
        tier: resolved.binding.tier,
        tenantSlug: resolved.binding.tenant_slug,
        rootDir,
      });
      if (!service)
        throw new Error(`Service '${serviceId}' is not registered for the onboarding context.`);
    }
    const savedPaths: string[] = [];
    const state = loadOrganizationOperationalState(resolved.binding.organization_id, {
      tier: resolved.binding.tier,
      tenantSlug: resolved.binding.tenant_slug,
      rootDir,
    });
    const statePath = path.join(
      pathResolver.organizationStateDir(
        resolved.binding.organization_id,
        resolved.binding.tier,
        resolved.binding.tenant_slug,
        rootDir
      ),
      'organization-state.json'
    );
    const now = new Date().toISOString();
    let workItem: WorkItem | undefined;
    try {
      if (!contextUnitId && managementUnit === 'operation') {
        const operation = buildOrganizationOperationRecord({
          organizationId: resolved.binding.organization_id,
          operationId: managementUnitId,
          name: input.intent.trim(),
          operationType:
            resolved.resolution.work_shape === 'service_operation' ? 'continuous' : 'scheduled',
          ownerRole: resolved.binding.owner_id,
          tier: resolved.binding.tier,
          tenantSlug: resolved.binding.tenant_slug,
          purpose: input.intent.trim(),
          executionKind: 'mission',
          evidenceOutputs: [`onboarding:${firstWorkId(resolved.binding, input.intent)}`],
          rootDir,
        });
        const recordPath = organizationManagementRecordPath(
          resolved.binding,
          'operation',
          managementUnitId,
          rootDir
        );
        if (!safeExistsSync(recordPath))
          savedPaths.push(saveOrganizationOperation(operation, { rootDir }));
        const statePath = saveOrganizationStateLink(state, 'operation', managementUnitId, rootDir);
        if (statePath) savedPaths.push(statePath);
      } else if (!contextUnitId && managementUnit === 'incident') {
        const incident: OrganizationIncidentRecord = {
          version: '1.0.0',
          incident_id: managementUnitId,
          organization_id: resolved.binding.organization_id,
          title: input.intent.trim(),
          severity: 'medium',
          status: 'detected',
          owner_role: resolved.binding.owner_id,
          impact_summary: input.intent.trim(),
          trigger_refs: [`onboarding:${firstWorkId(resolved.binding, input.intent)}`],
          tier: resolved.binding.tier,
          tenant_slug: resolved.binding.tenant_slug,
          created_at: now,
          updated_at: now,
          metadata: { source: 'onboarding_first_work' },
        };
        const recordPath = organizationManagementRecordPath(
          resolved.binding,
          'incident',
          managementUnitId,
          rootDir
        );
        if (!safeExistsSync(recordPath))
          savedPaths.push(saveOrganizationIncident(incident, { rootDir }));
        const statePath = saveOrganizationStateLink(state, 'incident', managementUnitId, rootDir);
        if (statePath) savedPaths.push(statePath);
      } else if (!contextUnitId && managementUnit === 'cadence') {
        const cadence: OrganizationCadenceRecord = {
          version: '1.0.0',
          cadence_id: managementUnitId,
          organization_id: resolved.binding.organization_id,
          name: input.intent.trim(),
          cadence_type: 'ad_hoc',
          schedule: 'on_demand',
          owner_role: resolved.binding.owner_id,
          decision_ids: [],
          tier: resolved.binding.tier,
          tenant_slug: resolved.binding.tenant_slug,
          status: 'active',
          updated_at: now,
          metadata: { source: 'onboarding_first_work' },
        };
        const recordPath = organizationManagementRecordPath(
          resolved.binding,
          'cadence',
          managementUnitId,
          rootDir
        );
        if (!safeExistsSync(recordPath))
          savedPaths.push(saveOrganizationCadence(cadence, { rootDir }));
      }
      workItem = createOnboardingWorkItem({
        binding: resolved.binding,
        intent: input.intent,
        workShape: resolved.resolution.work_shape,
        managementUnitId,
        rootDir,
      });
      const firstWork = validateFirstWorkRecord({
        version: '1.0.0',
        kind: 'onboarding_first_work',
        work_id: firstWorkId(resolved.binding, input.intent),
        customer_slug: resolved.binding.customer_slug,
        tenant_slug: resolved.binding.tenant_slug,
        organization_id: resolved.binding.organization_id,
        tier: resolved.binding.tier,
        intent: input.intent.trim(),
        work_shape: resolved.resolution.work_shape,
        management_unit: managementUnit,
        management_unit_id: managementUnitId,
        work_item_id: workItem.item_id,
        human_decision: 'accepted',
        status: 'active',
        source_refs: [
          `organization:${resolved.binding.organization_id}`,
          `${managementUnit}:${managementUnitId}`,
          `work_item:${workItem.item_id}`,
        ],
        created_at: now,
        updated_at: now,
      });
      savedPaths.push(saveOnboardingFirstWorkRecord(firstWork, rootDir));
    } catch (error) {
      for (const savedPath of savedPaths) {
        if (savedPath === statePath && state) saveOrganizationOperationalState(state, { rootDir });
        else safeUnlinkSync(savedPath);
      }
      archiveOnboardingWorkItem(workItem, rootDir);
      throw error;
    }
    return {
      mode: 'apply',
      resolution: resolved,
      action: 'management_unit_connected',
      work_item: workItem,
      saved_paths: savedPaths,
    };
  });
}
