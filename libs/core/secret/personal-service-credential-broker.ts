/** Selected personal API-token use. Consent, current claim and effect admission remain separate. */
import { timingSafeEqual } from 'node:crypto';
import { getSecretResolver } from './secret-resolver.js';
import { isLocalCredentialAllocationResolver } from './credential-allocations.js';
import { withPersonalServiceCredentialAdmission } from './personal-service-credential-admission.js';
export { resolvePersonalServiceCredentialAdmission } from './personal-service-credential-admission.js';
import {
  credentialExecutionIdentity,
  withPersonalServiceCredentialBinding,
  type PersonalCredentialClaim,
} from '../foundation/credential-binding.js';
import { withPersonalCredentialUseCapability } from '../foundation/personal-credential-use-capability.js';
import { assertPersonalTaskCredentialClaim } from './personal-task-credential-claim.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import {
  loadPersonalRuntimeCredentialGrant,
  loadPersonalRuntimeCredentialApproval,
  personalCredentialApprovalPath,
} from '../governance/personal-credential-grant-runtime-reader.js';
import { verifyPersonalCredentialGrantApprovalBasis } from '../governance/personal-credential-grant-basis.js';
import { PERSONAL_CREDENTIAL_RUNTIME_USE } from '../governance/personal-credential-grant-scope.js';
import { loadServiceBindingRecord } from '../service/service-binding-reader.js';
import { validateBindingOwner } from '../service/service-binding-owner.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import { getServicePresetRecord } from '../service/service-preset-registry.js';
import { assertPluginGrantAllows, getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  localAccountMaterialAccountId,
  loadPersonalRuntimeAccountRegistration,
  loadPersonalRuntimeAccountMaterial,
  type LocalAccountMaterialIdentity,
} from './secret-guard.js';

export interface PersonalServiceCredentialSelection {
  serviceId: string;
  action: string;
  bindingId: string;
  grantId: string;
}
export interface PersonalServiceCredentialAdmission extends Readonly<PersonalServiceCredentialSelection> {
  readonly ownerRef: string;
  readonly generation: string;
  readonly claim: Readonly<PersonalCredentialClaim>;
  readonly projectId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly binding: ServiceBindingRecord;
}
const denied = (): never => {
  throw new Error('[PERSONAL_SERVICE_CREDENTIAL_DENIED] Current exact personal consent required');
};

/** One callback, one selected consent. No directory discovery, ambient credentials or tenant broker. */
export async function withPersonalServiceCredentialUse<T>(
  requested: PersonalServiceCredentialSelection,
  run: (capability: object) => Promise<T>
): Promise<T> {
  const selection = Object.freeze({
    serviceId: requested.serviceId,
    action: requested.action,
    bindingId: requested.bindingId,
    grantId: requested.grantId,
  });
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(selection.serviceId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selection.action) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selection.bindingId) ||
    !/^GRT-\d{8}-[a-f0-9]{12}$/.test(selection.grantId) ||
    getPluginExecutionContext()
  )
    return denied();
  const identity = credentialExecutionIdentity();
  const resolver = getSecretResolver();
  if (!isLocalCredentialAllocationResolver(resolver)) return denied();
  const originalEnvelope = currentScopeEnvelope();
  const claim = identity.personalClaim;
  if (
    !claim ||
    identity.tenantSlug ||
    !originalEnvelope ||
    !originalEnvelope.identity.project_id ||
    !originalEnvelope.identity.mission_id ||
    !originalEnvelope.identity.task_id
  )
    return denied();
  const claimSnapshot = JSON.stringify(claim);
  const assertClaim = () => {
    if (
      getSecretResolver() !== resolver ||
      !isLocalCredentialAllocationResolver(resolver) ||
      currentScopeEnvelope() !== originalEnvelope ||
      credentialExecutionIdentity().personalClaim !== claim ||
      JSON.stringify(assertPersonalTaskCredentialClaim(claim.workItemId)) !== claimSnapshot
    )
      return denied();
  };
  const proofIdentity = {
    ownerId: claim.ownerId,
    actorId: claim.actorId,
    grantId: selection.grantId,
  };
  const read = () => {
    assertClaim();
    const grant = withPersonalCredentialUseCapability(proofIdentity, () =>
      loadPersonalRuntimeCredentialGrant(claim.ownerId, selection.grantId)
    );
    if (
      !grant ||
      grant.scope.runtime_use !== PERSONAL_CREDENTIAL_RUNTIME_USE ||
      grant.scope.owner_ref !== claim.ownerId ||
      grant.scope.nhi_id !== claim.actorId ||
      grant.scope.binding_id !== selection.bindingId ||
      grant.scope.service_id !== selection.serviceId ||
      grant.scope.project_id !== originalEnvelope.identity.project_id ||
      grant.scope.mission_id !== originalEnvelope.identity.mission_id ||
      grant.scope.task_id !== originalEnvelope.identity.task_id ||
      !grant.scope.allowed_actions.includes(selection.action) ||
      !grant.basis
    )
      return denied();
    const proof = {
      ...proofIdentity,
      approvalId: grant.basis.approval_request_id,
      approvalPath: personalCredentialApprovalPath(claim.actorId, grant.basis.approval_request_id),
    };
    const approval = withPersonalCredentialUseCapability(proof, () =>
      loadPersonalRuntimeCredentialApproval(claim.actorId, proof.approvalId)
    );
    if (!verifyPersonalCredentialGrantApprovalBasis(grant, approval)) return denied();
    const binding = loadServiceBindingRecord(selection.bindingId);
    if (
      !binding ||
      validateBindingOwner(binding).length ||
      binding.owner_kind !== 'person' ||
      binding.owner_ref !== claim.ownerId ||
      binding.tenant_slug ||
      binding.auth_mode !== 'secret-guard' ||
      binding.service_id !== selection.serviceId ||
      binding.target !== grant.scope.target ||
      (binding.project_id && binding.project_id !== grant.scope.project_id) ||
      binding.approval_policy[selection.action] !== 'allowed' ||
      !binding.allowed_actions.includes(selection.action) ||
      grant.scope.allowed_actions.some((action) => !binding.allowed_actions.includes(action)) ||
      new Set(binding.secret_refs).size !== binding.secret_refs.length ||
      binding.secret_refs.length !== grant.scope.secret_refs.length ||
      binding.secret_refs.some((key) => !grant.scope.secret_refs.includes(key))
    )
      return denied();
    // Canonical fresh reads pin policy changes, not only process-local cached catalog objects.
    const endpoint = getServiceEndpointRecord(selection.serviceId, { fresh: true });
    const preset = getServicePresetRecord(selection.serviceId, undefined, { fresh: true });
    const operation = preset?.operations[selection.action];
    if (
      !endpoint ||
      !preset ||
      !operation ||
      operation.risk !== 'read' ||
      operation.approval_required !== false ||
      operation.type !== 'api' ||
      operation.alternatives ||
      !['GET', 'HEAD'].includes(operation.method) ||
      !['bearer', 'bot'].includes(
        String(operation.auth_strategy ?? preset.auth_strategy).toLowerCase()
      ) ||
      typeof operation.path !== 'string' ||
      /[{}?#]/.test(operation.path) ||
      operation.path.split('/').some((part: string) => part === '.' || part === '..') ||
      (preset.fallback_strategy !== undefined && preset.fallback_strategy !== 'none')
    )
      return denied();
    const permitted = endpoint.credential_suffixes.accessToken.map(
      (suffix) => `${selection.serviceId.toUpperCase()}_${suffix}`
    );
    if (!binding.secret_refs.length || binding.secret_refs.some((key) => !permitted.includes(key)))
      return denied();
    for (const key of binding.secret_refs) assertPluginGrantAllows('secrets', key);
    assertPluginGrantAllows('secrets', `connection:${selection.serviceId}`);
    const address: LocalAccountMaterialIdentity = {
      serviceId: selection.serviceId,
      bindingId: selection.bindingId,
      ownerKind: 'person',
      ownerRef: claim.ownerId,
    };
    const accountId = localAccountMaterialAccountId(address);
    const registration = withPersonalCredentialUseCapability({ ...proof, accountId }, () =>
      loadPersonalRuntimeAccountRegistration(address)
    );
    if (registration.pendingApprovalId || registration.generation !== grant.scope.generation)
      return denied();
    const material = withPersonalCredentialUseCapability(
      { ...proof, accountId, generation: grant.scope.generation },
      () => loadPersonalRuntimeAccountMaterial({ ...address, generation: grant.scope.generation })
    );
    if (
      Object.keys(material).length !== binding.secret_refs.length ||
      Object.keys(material).some((key) => !binding.secret_refs.includes(key))
    )
      return denied();
    assertClaim();
    return { grant, binding, endpoint, preset, material };
  };
  const initial = read();
  const snapshot = JSON.stringify({
    grant: initial.grant,
    binding: initial.binding,
    endpoint: initial.endpoint,
    preset: initial.preset,
  });
  const validate = () => {
    const current = read();
    if (
      JSON.stringify({
        grant: current.grant,
        binding: current.binding,
        endpoint: current.endpoint,
        preset: current.preset,
      }) !== snapshot
    )
      return denied();
    for (const [key, value] of Object.entries(initial.material)) {
      const actual = Buffer.from(current.material[key] ?? '');
      const expected = Buffer.from(value);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return denied();
    }
  };
  const metadata: PersonalServiceCredentialAdmission = {
    ...selection,
    ownerRef: claim.ownerId,
    generation: initial.grant.scope.generation,
    claim: Object.freeze({ ...claim }),
    projectId: initial.grant.scope.project_id,
    missionId: initial.grant.scope.mission_id,
    taskId: initial.grant.scope.task_id,
    binding: structuredClone(initial.binding),
  };
  return withPersonalServiceCredentialAdmission(metadata, validate, (capability) =>
    withPersonalServiceCredentialBinding(
      {
        serviceBindingId: selection.bindingId,
        serviceId: selection.serviceId,
        sourceOwnerRef: claim.ownerId,
        personalGrantId: selection.grantId,
        generation: initial.grant.scope.generation,
        secrets: initial.material,
        validate,
      },
      () => run(capability)
    )
  );
}
