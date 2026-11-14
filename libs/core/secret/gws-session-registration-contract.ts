/**
 * Portable GWS authorized-user material and inactive registration preflight.
 * These contracts perform no collection, storage, approval, provisioning or login.
 */
export const GWS_SESSION_MATERIAL_LIMITS = Object.freeze({
  totalBytes: 64 * 1024,
  clientIdBytes: 4 * 1024,
  secretBytes: 16 * 1024,
});

/** Exact plaintext export shape, never an encrypted credentials.enc/cache copy. */
export interface GwsAuthorizedUserMaterial {
  readonly type: 'authorized_user';
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
}

const invalid = (): never => {
  // Do not include rejected keys, values, paths or upstream exception text.
  throw new Error('[GWS_SESSION_MATERIAL_INVALID] Unsupported session material');
};

/** Returns a detached immutable copy; errors contain no submitted material. */
export function validateGwsSessionMaterial(input: unknown): Readonly<GwsAuthorizedUserMaterial> {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).sort().join(',') !== 'client_id,client_secret,refresh_token,type'
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some((field) => !('value' in field))) return invalid();
    if (descriptors.type.value !== 'authorized_user') return invalid();
    for (const key of ['client_id', 'client_secret', 'refresh_token'] as const) {
      const value: unknown = descriptors[key].value;
      const limit =
        key === 'client_id'
          ? GWS_SESSION_MATERIAL_LIMITS.clientIdBytes
          : GWS_SESSION_MATERIAL_LIMITS.secretBytes;
      if (
        typeof value !== 'string' ||
        !value ||
        !/^[\x21-\x7e]+$/.test(value) ||
        value.includes('*') ||
        value.includes('...') ||
        Buffer.byteLength(value, 'utf8') > limit
      )
        return invalid();
    }
    const material: GwsAuthorizedUserMaterial = {
      type: 'authorized_user',
      client_id: descriptors.client_id.value,
      client_secret: descriptors.client_secret.value,
      refresh_token: descriptors.refresh_token.value,
    };
    if (
      Buffer.byteLength(JSON.stringify(material), 'utf8') > GWS_SESSION_MATERIAL_LIMITS.totalBytes
    )
      return invalid();
    return Object.freeze(material);
  } catch {
    return invalid();
  }
}

export interface GwsSessionRegistrationTarget {
  readonly bindingId: string;
  readonly serviceId: 'google-workspace';
  readonly ownerKind: 'organization';
  readonly ownerRef: string;
  readonly tenantSlug: string;
  readonly authMode: 'session';
  readonly expectedGeneration: string | null;
}

/** Metadata only. Possessing a plan or receipt supplies no apply/runtime authority. */
export interface GwsSessionStageIdentity {
  readonly version: 1;
  readonly requestId: string;
  readonly target: Readonly<GwsSessionRegistrationTarget>;
  readonly generation: string;
  readonly requesterActorId: string;
  readonly approvalId: string;
  readonly bindingSnapshotDigest: string;
  readonly brokerConfigurationDigest: string;
}

/**
 * Future adapter contract, deliberately not installed in SecretResolver.
 * prepare must persist encrypted inactive material with existing keys only.
 * commit must independently authenticate the registration requester/actor and
 * human approver/owner scope, exact approval payload, binding snapshot and CAS;
 * it must never trust this structural request as an authorization capability.
 * Requester metadata is not authority. Runtime claim/lease proof belongs at bind,
 * where the broker must revalidate committed registration and generation.
 * abort is idempotent, removes this stage and private HOME, and cannot remove a
 * different/committed generation. Timeout means uncertain outcome, never retry.
 * Runtime HOME must be private, per execution, and removed on completion/failure;
 * crash recovery must expire abandoned material without activating it.
 */
export interface GwsSessionStagingProvisioner {
  readonly id: string;
  prepare(
    input: Readonly<{
      stage: Readonly<GwsSessionStageIdentity>;
      material: Readonly<GwsAuthorizedUserMaterial>;
    }>
  ): Promise<Readonly<{ stage: Readonly<GwsSessionStageIdentity>; status: 'staged' }>>;
  commit(input: Readonly<GwsSessionStageIdentity>): Promise<
    Readonly<{
      stage: Readonly<GwsSessionStageIdentity>;
      status: 'committed';
    }>
  >;
  abort(input: Readonly<GwsSessionStageIdentity>): Promise<
    Readonly<{
      stage: Readonly<GwsSessionStageIdentity>;
      status: 'aborted';
    }>
  >;
}

const requiredCapabilities = Object.freeze([
  'authenticated-owner-review',
  'existing-key-encrypted-session-storage',
  'staged-broker-generation-cas',
  'committed-approval-revalidation',
  'isolated-home-lifetime-and-cleanup',
  'selected-gws-credentials-file-transport',
] as const);

/** Pure shape preflight, NOT ownership verification or an executable approval plan. */
export function preflightGwsSessionRegistration(target: GwsSessionRegistrationTarget) {
  const slug = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  try {
    if (
      !target ||
      typeof target !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(target)) ||
      Reflect.ownKeys(target).sort().join(',') !==
        'authMode,bindingId,expectedGeneration,ownerKind,ownerRef,serviceId,tenantSlug'
    )
      throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(target);
    if (Object.values(descriptors).some((field) => !('value' in field))) throw new Error();
    // Snapshot data descriptors before checking fields; never invoke caller getters.
    target = Object.fromEntries(
      Object.entries(descriptors).map(([key, field]) => [key, field.value])
    ) as unknown as GwsSessionRegistrationTarget;
  } catch {
    throw new Error('[GWS_SESSION_REGISTRATION_DENIED] Explicit organization session required');
  }
  if (
    !target ||
    target.serviceId !== 'google-workspace' ||
    target.ownerKind !== 'organization' ||
    target.authMode !== 'session' ||
    typeof target.bindingId !== 'string' ||
    !slug.test(target.bindingId) ||
    typeof target.tenantSlug !== 'string' ||
    !slug.test(target.tenantSlug) ||
    target.ownerRef !== target.tenantSlug ||
    (target.expectedGeneration !== null &&
      (typeof target.expectedGeneration !== 'string' || !uuid.test(target.expectedGeneration)))
  )
    throw new Error('[GWS_SESSION_REGISTRATION_DENIED] Explicit organization session required');
  return Object.freeze({
    version: 1 as const,
    materialFormat: 'gws-authorized-user-v1' as const,
    registrationAvailable: false as const,
    runtimeAvailable: false as const,
    reason: 'activation_not_implemented' as const,
    requiredCapabilities,
  });
}
