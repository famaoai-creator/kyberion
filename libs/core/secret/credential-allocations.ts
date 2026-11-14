import { registerServiceCredentialAllocationVerifier } from '../governance/service-credential-allocation.js';
import { assertServiceCredentialAllocation } from '../governance/service-credential-allocation.js';
import { verifyServiceCredentialAllocation } from '../governance/service-credential-allocation-verifier.js';
/** Local credential allocations reuse standing grants; material stays in the secret store. */
import { timingSafeEqual } from 'node:crypto';
import { assertStoreGrantIssuanceAllowed, withStoreGrant } from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import {
  credentialExecutionIdentity,
  type TaskCredentialBinding,
  type TaskCredentialProvenance,
} from '../foundation/credential-binding.js';
import { readJson } from '../foundation/json.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import { withSensitivePathMediation } from '../secure-io.js';
import {
  listGrants,
  loadGrant,
  grantStatusAt,
  verifyGrantBasis,
  type GrantRecord,
} from '../governance/grant-store.js';
import {
  listReasoningApiProviders,
  requireReasoningApiProvider,
} from '../reasoning/reasoning-api-credentials.js';
import { resolveSecretIdentity } from './secret-identity.js';
import { decryptConnectionDocument, isEncryptedConnectionEnvelope } from './secret-encryption.js';
import { assertTaskCredentialClaim } from './shell-task-credential-binding.js';
import type { ScopeContext } from '../foundation/scope-context-validation.js';
import { assertPluginGrantAllows } from '../shell/sandbox-policy.js';
import {
  CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT,
  withCredentialMaterialCapability,
  withAccountCredentialMaterialCapability,
} from '../foundation/credential-material-capability.js';
import { getSecretResolver, registerSecretResolver } from './secret-resolver.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { loadServiceBindingRecord } from '../service/service-binding-reader.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import {
  localAccountMaterialAccountId,
  loadAllocatedLocalAccountRegistration,
  loadAllocatedLocalAccountMaterial,
  type LocalAccountMaterialIdentity,
} from './secret-guard.js';

type ServiceAllocationSnapshot = {
  grantId: string;
  bindingId: string;
  binding: string;
  generation: string;
  material: Record<string, string>;
};

function readAllocatedServiceMaterial(
  input: Readonly<{ scope: Readonly<ScopeContext>; workItemId: string }>,
  grantId: string,
  bindingId: string
): ServiceAllocationSnapshot {
  const tenant = input.scope.tenant_slug!;
  const selected = loadServiceBindingRecord(bindingId);
  if (
    !selected ||
    selected.owner_kind !== 'person' ||
    !selected.owner_ref ||
    selected.tenant_slug ||
    selected.auth_mode !== 'secret-guard' ||
    !selected.service_id ||
    (selected.project_id && selected.project_id !== input.scope.project_id)
  )
    throw denied();
  assertServiceCredentialAllocation(
    selected,
    {
      tenant_slug: tenant,
      project_id: input.scope.project_id,
      mission_id: input.scope.mission_id,
      task_id: input.scope.task_id,
    },
    { grantId }
  );
  const permitted =
    getServiceEndpointRecord(selected.service_id)?.credential_suffixes.accessToken.map(
      (suffix) => `${selected.service_id!.toUpperCase()}_${suffix}`
    ) ?? [];
  if (
    !selected.secret_refs.length ||
    new Set(selected.secret_refs).size !== selected.secret_refs.length ||
    selected.secret_refs.some((key) => !permitted.includes(key))
  )
    throw denied();
  const address: LocalAccountMaterialIdentity = {
    serviceId: selected.service_id,
    bindingId,
    ownerKind: 'person',
    ownerRef: selected.owner_ref,
  };
  const account = localAccountMaterialAccountId(address);
  for (const key of selected.secret_refs) assertPluginGrantAllows('secrets', key);
  assertPluginGrantAllows('secrets', `connection:${selected.service_id}`);
  assertStoreGrantIssuanceAllowed(CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT);
  const active = resolvePolicyIdentityContext().tenantSlug;
  if (active && active !== tenant) throw denied();
  const registration = withAccountCredentialMaterialCapability(tenant, account, null, () =>
    loadAllocatedLocalAccountRegistration(address)
  );
  if (!registration.generation || registration.pendingApprovalId) throw denied();
  const generation = registration.generation;
  const material = withAccountCredentialMaterialCapability(tenant, account, generation, () =>
    loadAllocatedLocalAccountMaterial({ ...address, generation })
  );
  if (
    Object.keys(material).length !== selected.secret_refs.length ||
    Object.keys(material).some((key) => !selected.secret_refs.includes(key))
  )
    throw denied();
  return { grantId, bindingId, binding: JSON.stringify(selected), generation, material };
}

export const CREDENTIAL_USE_CAPABILITY = 'credential.use';
export function installLocalCredentialAllocations(): boolean {
  // The source verifier is required for external brokers too; never replace their resolver.
  registerServiceCredentialAllocationVerifier(verifyServiceCredentialAllocation);
  if (getSecretResolver()) return false;
  registerSecretResolver(
    {
      name: 'local-credential-allocations',
      resolve: () => null,
      bindTask: bindAllocatedTaskCredentials,
    },
    { provenance: 'generated', source: 'local-credential-allocation-default' }
  );
  return true;
}
const denied = () =>
  new Error('[CREDENTIAL_ALLOCATION_DENIED] Allocation missing, expired, revoked, or changed');

function reader<T>(tenant: string, run: () => T): T {
  const identity = credentialExecutionIdentity();
  if (identity.personalClaim || (identity.tenantSlug && identity.tenantSlug !== tenant))
    throw denied();
  return withStoreGrant('credential_allocation_reader', run, {
    tenantSlug: tenant,
    identity: {
      missionId: identity.missionId ?? null,
      taskId: identity.taskId ?? null,
    },
  });
}

export function listCredentialAllocations(tenant: string): GrantRecord[] {
  return reader(tenant, () =>
    listGrants({ tenant_slug: tenant, capability: CREDENTIAL_USE_CAPABILITY })
  );
}

export function assertCredentialAllocation(
  tenant: string,
  grantId: string,
  provider: string
): GrantRecord {
  return reader(tenant, () => {
    const grant = loadGrant(tenant, grantId);
    const ref = requireReasoningApiProvider(provider).secret_refs![0]!;
    if (
      !grant ||
      grant.capability !== CREDENTIAL_USE_CAPABILITY ||
      grant.scope.credential_provider !== requireReasoningApiProvider(provider).mode ||
      grant.scope.credential_ref !== `${ref.service_id}/${ref.secret_key}` ||
      grantStatusAt(grant, new Date()) !== 'active' ||
      !verifyGrantBasis(grant)
    )
      throw denied();
    return grant;
  });
}

/**
 * Private broker read: only reached after allocation and current claim admission. The exact
 * material grant is the authority for the one connection file read (G2: no reader role). Who may
 * issue it is unchanged: the rule that bounded assuming the former shared core role (RA-02)
 * applies to the issuance right `credential_material_reader`. While the grant is active the
 * caller keeps its own role and persona, bound to the allocation's tenant (no organization) and
 * the claim's mission/task identity, as the role assumption bound them; a caller bound to another
 * tenant is refused.
 */
function readAllocatedMaterial(tenant: string, grantId: string, provider: string): string {
  const descriptor = requireReasoningApiProvider(provider);
  const ref = descriptor.secret_refs![0]!;
  const identity = resolveSecretIdentity(ref.service_id, ref.secret_key);
  assertCredentialAllocation(tenant, grantId, descriptor.mode);
  assertPluginGrantAllows('secrets', identity.envName);
  assertPluginGrantAllows('secrets', `connection:${identity.serviceId}`);
  const file = `knowledge/personal/connections/${identity.serviceId}.json`;
  const owner = credentialExecutionIdentity();
  assertStoreGrantIssuanceAllowed(CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT);
  return withCredentialMaterialCapability(tenant, file, () => {
    const active = resolvePolicyIdentityContext().tenantSlug;
    if (active && active !== tenant)
      throw new Error(
        `[ROLE_TENANT_SCOPE_MISMATCH] credential material grant for tenant '${tenant}' used by a caller bound to '${active}'`
      );
    const {
      tenantCleared: _cleared,
      organizationId: _organization,
      ...current
    } = currentExecutionScope() ?? { tenantBound: false };
    const executionIdentity = Object.freeze({
      ...current.executionIdentity,
      missionId: owner.missionId ?? null,
      taskId: owner.taskId ?? null,
    });
    return runInExecutionScope(
      { ...current, tenantBound: true, tenantSlug: tenant, executionIdentity },
      () =>
        withSensitivePathMediation(() => {
          const raw = readJson<unknown>(pathResolver.rootResolve(file));
          const document = isEncryptedConnectionEnvelope(raw)
            ? decryptConnectionDocument(raw)
            : raw;
          const fields = parseSafeJsonObjectValue(document, 'allocated credential connection');
          const key = fields[identity.connectionField];
          if (typeof key !== 'string' || !key.trim()) throw denied();
          return key;
        })
    );
  });
}

/** Called at the coordinated dispatch boundary, never from arbitrary CLI tenant flags. */
export async function bindAllocatedTaskCredentials(
  input: Readonly<{
    scope: Readonly<ScopeContext>;
    workItemId: string;
  }>
): Promise<TaskCredentialBinding | null> {
  const tenant = input.scope.tenant_slug!;
  const claim = assertTaskCredentialClaim(input);
  const grants = reader(tenant, () =>
    listCredentialAllocations(tenant).filter(
      (grant) =>
        grant.scope.tenant_slug === tenant &&
        grantStatusAt(grant, new Date()) === 'active' &&
        verifyGrantBasis(grant) &&
        (!grant.scope.service_allocation?.project_id ||
          grant.scope.service_allocation.project_id === input.scope.project_id) &&
        (!grant.scope.service_allocation?.mission_id ||
          grant.scope.service_allocation.mission_id === input.scope.mission_id) &&
        (!grant.scope.service_allocation?.task_id ||
          grant.scope.service_allocation.task_id === input.scope.task_id)
    )
  );
  // No local grant preserves non-credential delegation. Provider access later
  // remains fail-closed because no binding is installed.
  if (!grants.length) return null;
  const allowed = currentScopeEnvelope()?.policy.allowed_reasoning_backends;
  const secrets: Record<string, string> = {};
  const admitted: Array<{ grantId: string; provider: string; key: string }> = [];
  const serviceAdmitted: ServiceAllocationSnapshot[] = [];
  const secretProvenance: Record<string, TaskCredentialProvenance> = {};
  // Reserve the complete key namespace before reading any account material.
  const reserved = new Set<string>();
  for (const grant of grants) {
    const allocation = grant.scope.service_allocation;
    if (!allocation) continue;
    for (const key of allocation.secret_refs) {
      if (reserved.has(key)) throw denied();
      reserved.add(key);
    }
  }
  const providers = new Set<string>(listReasoningApiProviders().map((p) => p.mode));
  for (const grant of grants) {
    const provider = grant.scope.credential_provider;
    if (
      !provider ||
      (allowed !== undefined && !allowed.includes(provider)) ||
      !providers.has(provider) ||
      admitted.some((entry) => entry.provider === provider)
    )
      continue;
    const names = requireReasoningApiProvider(provider).secret_refs![0]!.env_keys;
    for (const name of names) {
      if (reserved.has(name)) throw denied();
    }
    const key = readAllocatedMaterial(tenant, grant.grant_id, provider);
    for (const name of names) {
      secrets[name] = key;
    }
    admitted.push({ grantId: grant.grant_id, provider, key });
  }
  for (const grant of grants) {
    const allocation = grant.scope.service_allocation;
    if (!allocation) continue;
    const entry = readAllocatedServiceMaterial(input, grant.grant_id, allocation.binding_id);
    const selected = loadServiceBindingRecord(entry.bindingId)!;
    if (JSON.stringify(selected) !== entry.binding) throw denied();
    for (const [key, value] of Object.entries(entry.material)) {
      secrets[key] = value;
      secretProvenance[key] = {
        serviceBindingId: entry.bindingId,
        serviceId: allocation.service_id,
        sourceOwnerRef: allocation.owner_ref,
        allocationGrantId: entry.grantId,
      };
    }
    serviceAdmitted.push(entry);
  }
  if (claim !== assertTaskCredentialClaim(input)) throw denied();
  if (!admitted.length && !serviceAdmitted.length) return null;
  const validate = () => {
    if (claim !== assertTaskCredentialClaim(input)) throw denied();
    for (const entry of admitted) {
      const current = readAllocatedMaterial(tenant, entry.grantId, entry.provider);
      // Binding already holds the key in memory; compare directly instead of
      // deriving a persistent verifier on every managed credential use.
      const actual = Buffer.from(current);
      const expected = Buffer.from(entry.key);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw denied();
    }
    for (const entry of serviceAdmitted) {
      const current = readAllocatedServiceMaterial(input, entry.grantId, entry.bindingId);
      if (
        current.binding !== entry.binding ||
        current.generation !== entry.generation ||
        Object.keys(current.material).length !== Object.keys(entry.material).length
      )
        throw denied();
      for (const [key, expectedValue] of Object.entries(entry.material)) {
        const actual = Buffer.from(current.material[key] ?? '');
        const expected = Buffer.from(expectedValue);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw denied();
      }
    }
    if (claim !== assertTaskCredentialClaim(input)) throw denied();
  };
  validate();
  return {
    tenantSlug: tenant,
    missionId: input.scope.mission_id,
    taskId: input.scope.task_id,
    secrets,
    ...(serviceAdmitted.length ? { secretProvenance } : {}),
    validate,
  };
}
