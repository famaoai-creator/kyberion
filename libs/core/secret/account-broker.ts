/** Explicit account provisioning, independent of the resolver's read capability. */
import { createHash, randomUUID } from 'node:crypto';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import { loadServiceBindingRecord } from '../service/service-binding-reader.js';
import { validateBindingOwner } from '../service/service-binding-owner.js';
import type { LocalAccountMaterialReference } from './secret-guard.js';
import { getSecretResolver } from './secret-resolver.js';
import {
  assertAccountIntroductionProvisioning,
  withAccountProvisionRequest,
} from '../foundation/account-provision-admission.js';

export interface AccountProvisionRequest {
  version: 1;
  requestId: string;
  reference: LocalAccountMaterialReference;
  expectedGeneration: string | null;
  material: Record<string, string>;
}
export interface AccountProvisionReceipt {
  version: 1;
  requestId: string;
  reference: LocalAccountMaterialReference;
  expectedGeneration: string | null;
  status: 'provisioned';
}
/** The adapter must atomically compare expectedGeneration before publishing material. */
export interface AccountProvisioner {
  /** Configuration identity; a destination/configuration change must change this id. */
  readonly id: string;
  provision(input: AccountProvisionRequest): Promise<unknown> | unknown;
}

const unavailable = () =>
  new Error('[ACCOUNT_BROKER_UNAVAILABLE] Account provisioning unavailable');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function active() {
  if (
    getPluginExecutionContext() ||
    credentialExecutionIdentity().tenantSlug ||
    credentialExecutionIdentity().personalClaim
  )
    throw unavailable();
  const resolver = getSecretResolver();
  const writer = resolver?.accountProvisioner;
  if (!resolver || !writer || !writer.id || typeof writer.provision !== 'function')
    throw unavailable();
  return { resolver, writer, provision: writer.provision, id: writer.id };
}
function brokerId(current: ReturnType<typeof active>): string {
  return createHash('sha256')
    .update(JSON.stringify([current.resolver.name, current.id]))
    .digest('hex');
}
/** Timeout leaves an uncertain external outcome; the durable apply claim forbids retry. */
async function boundedProvision(run: () => Promise<unknown> | unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function describeAccountBroker(): { brokerId: string } | null {
  try {
    return { brokerId: brokerId(active()) };
  } catch {
    return null;
  }
}
function validate(input: {
  reference: LocalAccountMaterialReference;
  expectedGeneration: string | null;
  material: Record<string, string>;
}): string {
  const ref = input.reference;
  const binding = loadServiceBindingRecord(ref.bindingId);
  if (
    !binding ||
    validateBindingOwner(binding).length ||
    ref.ownerKind !== 'organization' ||
    binding.owner_kind !== 'organization' ||
    !ref.tenantSlug ||
    ref.ownerRef !== ref.tenantSlug ||
    binding.owner_ref !== ref.ownerRef ||
    binding.tenant_slug !== ref.tenantSlug ||
    binding.service_id !== ref.serviceId ||
    binding.auth_mode !== 'secret-guard' ||
    !uuid.test(ref.generation) ||
    (input.expectedGeneration !== null && !uuid.test(input.expectedGeneration))
  )
    throw unavailable();
  const permitted =
    getServiceEndpointRecord(ref.serviceId)?.credential_suffixes.accessToken.map(
      (suffix) => `${ref.serviceId.toUpperCase()}_${suffix}`
    ) ?? [];
  const keys = Object.keys(input.material);
  if (
    !keys.length ||
    keys.length > 64 ||
    keys.length !== binding.secret_refs.length ||
    keys.some(
      (key) =>
        !binding.secret_refs.includes(key) ||
        !permitted.includes(key) ||
        typeof input.material[key] !== 'string' ||
        !input.material[key] ||
        Buffer.byteLength(input.material[key], 'utf8') > 16 * 1024 ||
        input.material[key].includes('\0')
    )
  )
    throw unavailable();
  return JSON.stringify(binding);
}
/** Caller owns human approval, durable claim and encrypted storage; this grants no execution authority. */
export async function provisionAccountMaterial(input: {
  brokerId: string;
  reference: LocalAccountMaterialReference;
  expectedGeneration: string | null;
  material: Record<string, string>;
}): Promise<void> {
  try {
    assertAccountIntroductionProvisioning(input);
    const current = active();
    if (brokerId(current) !== input.brokerId) throw unavailable();
    const snapshot = validate(input);
    const reference = {
      serviceId: input.reference.serviceId,
      bindingId: input.reference.bindingId,
      ownerKind: input.reference.ownerKind,
      ownerRef: input.reference.ownerRef,
      tenantSlug: input.reference.tenantSlug,
      generation: input.reference.generation,
    };
    const request: AccountProvisionRequest = {
      version: 1,
      requestId: randomUUID(),
      reference: Object.freeze(reference),
      expectedGeneration: input.expectedGeneration,
      material: Object.freeze({ ...input.material }),
    };
    const response = await withAccountProvisionRequest(input, request, () =>
      boundedProvision(() => current.provision.call(current.writer, Object.freeze(request)))
    );
    assertAccountIntroductionProvisioning(input);
    const next = active();
    const responseReference = object(response) ? response.reference : null;
    if (
      next.resolver !== current.resolver ||
      next.writer !== current.writer ||
      next.provision !== current.provision ||
      brokerId(next) !== input.brokerId ||
      validate(input) !== snapshot ||
      !object(response) ||
      Object.keys(response).sort().join(',') !==
        'expectedGeneration,reference,requestId,status,version' ||
      response.version !== 1 ||
      response.requestId !== request.requestId ||
      response.status !== 'provisioned' ||
      response.expectedGeneration !== request.expectedGeneration ||
      !object(responseReference) ||
      Object.keys(responseReference).sort().join(',') !== Object.keys(reference).sort().join(',') ||
      Object.entries(reference).some(([key, value]) => responseReference[key] !== value)
    )
      throw unavailable();
  } catch {
    // Never surface an adapter error, command output or secret-bearing receipt.
    throw unavailable();
  }
}
