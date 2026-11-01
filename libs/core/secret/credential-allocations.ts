/** Local credential allocations reuse standing grants; material stays in the secret store. */
import { timingSafeEqual } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import {
  credentialExecutionIdentity,
  type TaskCredentialBinding,
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
import type { ScopeContext } from '../scope-context-validation.js';
import { assertPluginGrantAllows } from '../shell/sandbox-policy.js';
import { withCredentialMaterialCapability } from '../foundation/credential-material-capability.js';
import { getSecretResolver, registerSecretResolver } from './secret-resolver.js';
import { currentScopeEnvelope } from '../scope-envelope.js';

export const CREDENTIAL_USE_CAPABILITY = 'credential.use';
export function installLocalCredentialAllocations(): boolean {
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
  if (identity.tenantSlug && identity.tenantSlug !== tenant) throw denied();
  return withExecutionContext('credential_allocation_reader', run, undefined, tenant, undefined, {
    missionId: identity.missionId ?? null,
    taskId: identity.taskId ?? null,
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

/** Private broker read: only reached after allocation and current claim admission. */
function readAllocatedMaterial(tenant: string, grantId: string, provider: string): string {
  const descriptor = requireReasoningApiProvider(provider);
  const ref = descriptor.secret_refs![0]!;
  const identity = resolveSecretIdentity(ref.service_id, ref.secret_key);
  assertCredentialAllocation(tenant, grantId, descriptor.mode);
  assertPluginGrantAllows('secrets', identity.envName);
  assertPluginGrantAllows('secrets', `connection:${identity.serviceId}`);
  const file = `knowledge/personal/connections/${identity.serviceId}.json`;
  const owner = credentialExecutionIdentity();
  return withCredentialMaterialCapability(tenant, file, () =>
    withExecutionContext(
      'credential_material_reader',
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
        }),
      undefined,
      tenant,
      undefined,
      { missionId: owner.missionId ?? null, taskId: owner.taskId ?? null }
    )
  );
}

/** Called at the coordinated dispatch boundary, never from arbitrary CLI tenant flags. */
export async function bindAllocatedTaskCredentials(
  input: Readonly<{
    scope: Readonly<ScopeContext>;
    workItemId: string;
  }>
): Promise<TaskCredentialBinding | null> {
  const tenant = input.scope.tenant_slug!;
  const grants = reader(tenant, () =>
    listCredentialAllocations(tenant).filter(
      (grant) =>
        grant.scope.tenant_slug === tenant &&
        grantStatusAt(grant, new Date()) === 'active' &&
        verifyGrantBasis(grant)
    )
  );
  // No local grant preserves non-credential delegation. Provider access later
  // remains fail-closed because no binding is installed.
  if (!grants.length) return null;
  const claim = assertTaskCredentialClaim(input);
  const allowed = currentScopeEnvelope()?.policy.allowed_reasoning_backends;
  const secrets: Record<string, string> = {};
  const admitted: Array<{ grantId: string; provider: string; key: string }> = [];
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
    const key = readAllocatedMaterial(tenant, grant.grant_id, provider);
    for (const name of requireReasoningApiProvider(provider).secret_refs![0]!.env_keys)
      secrets[name] = key;
    admitted.push({ grantId: grant.grant_id, provider, key });
  }
  if (claim !== assertTaskCredentialClaim(input)) throw denied();
  if (!admitted.length) return null;
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
  };
  validate();
  return {
    tenantSlug: tenant,
    missionId: input.scope.mission_id,
    taskId: input.scope.task_id,
    secrets,
    validate,
  };
}
