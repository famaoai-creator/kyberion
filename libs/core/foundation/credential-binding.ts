import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { currentExecutionScope } from './execution-scope.js';
import { currentResourceAccessScope } from './resource-access-scope.js';
import { getRegisteredEnvText } from './env.js';
import { isBoundTenantInvalid, resolveProjectScope } from './project-scope-env.js';
import { isValidTenantSlug } from './scope.js';

/** Non-secret source evidence issued only by a trusted credential broker. */
export interface TaskCredentialProvenance {
  readonly serviceBindingId: string;
  readonly serviceId: string;
  readonly sourceOwnerRef: string;
  readonly allocationGrantId?: string;
}

/** Broker-attested session source; generation is opaque and re-attested on every use. */
export interface TaskProviderProvenance {
  readonly serviceBindingId: string;
  readonly serviceId: string;
  readonly sourceOwnerRef: string;
  readonly actorId: string;
  readonly generation: string;
}

/** Trusted dispatch input. These values are never accepted from a model or HTTP payload. */
export interface TaskCredentialBinding {
  readonly tenantSlug?: string;
  readonly personalClaim?: PersonalCredentialClaim;
  readonly missionId?: string;
  readonly taskId?: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly secretProvenance?: Readonly<Record<string, TaskCredentialProvenance>>;
  /** Trusted broker freshness check, run before every credential consumption. */
  readonly validate?: () => void;
  /** Complete provider env, including an isolated HOME. Never merged with operator env. */
  readonly providerProvenance?: Readonly<Record<string, TaskProviderProvenance>>;
  readonly providerEnvironments?: Readonly<Record<string, Readonly<NodeJS.ProcessEnv>>>;
}

const KEY = Symbol.for('kyberion.core.task-credential-binding.v1');
const host = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<TaskCredentialBinding>;
};
const storage = host[KEY] ?? (host[KEY] = new AsyncLocalStorage<TaskCredentialBinding>());
export interface PersonalCredentialClaim {
  readonly ownerId: string;
  readonly actorId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly leaseId: string;
}
export type CredentialIdentity = {
  tenantSlug?: string;
  missionId?: string;
  taskId?: string;
  personalClaim?: PersonalCredentialClaim;
};
type PersonalExecution = {
  claim: Readonly<PersonalCredentialClaim>;
  missionId: string;
  taskId: string;
};
const PERSONAL_KEY = Symbol.for('kyberion.core.personal-credential-execution.v1');
const personalHost = globalThis as typeof globalThis & {
  [PERSONAL_KEY]?: AsyncLocalStorage<PersonalExecution>;
};
const personalStorage =
  personalHost[PERSONAL_KEY] ??
  (personalHost[PERSONAL_KEY] = new AsyncLocalStorage<PersonalExecution>());
function samePersonalClaim(a?: PersonalCredentialClaim, b?: PersonalCredentialClaim): boolean {
  return (
    a === b ||
    Boolean(
      a &&
      b &&
      a.ownerId === b.ownerId &&
      a.actorId === b.actorId &&
      a.workItemId === b.workItemId &&
      a.attemptId === b.attemptId &&
      a.leaseId === b.leaseId
    )
  );
}

/** Trusted dispatch only. This stage admits no personal credential or provider environment. */
export function withPersonalTaskCredentialBinding<T>(
  claim: PersonalCredentialClaim,
  validate: () => void,
  run: () => T
): T {
  const identity = credentialExecutionIdentity();
  if (
    identity.tenantSlug ||
    !identity.missionId ||
    !identity.taskId ||
    Object.keys(claim).sort().join(',') !== 'actorId,attemptId,leaseId,ownerId,workItemId' ||
    ['ownerId', 'actorId', 'workItemId', 'attemptId', 'leaseId'].some((key) => {
      const value = claim[key as keyof PersonalCredentialClaim];
      return typeof value !== 'string' || !value.trim();
    }) ||
    (identity.personalClaim && !samePersonalClaim(identity.personalClaim, claim))
  )
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Exact personal task lineage is required');
  validate();
  const personalClaim = Object.freeze({ ...claim });
  return personalStorage.run(
    Object.freeze({ claim: personalClaim, missionId: identity.missionId, taskId: identity.taskId }),
    () => withTaskCredentialBinding({ personalClaim, secrets: {}, validate }, run)
  );
}

export interface CredentialBindingReadiness {
  status: 'operator' | 'bound' | 'binding_required';
  identity: CredentialIdentity;
}
const READER_KEY = Symbol.for('kyberion.core.credential-scope-reader.v1');
const readerHost = globalThis as typeof globalThis & {
  [READER_KEY]?: () => CredentialIdentity | undefined;
};

/** Internal composition hook: a scope envelope is a deny-only identity constraint here. */
export function registerCredentialScopeReader(reader: () => CredentialIdentity | undefined): void {
  readerHost[READER_KEY] = reader;
}

export function credentialExecutionIdentity(): CredentialIdentity {
  const scope = currentExecutionScope();
  const envelope = readerHost[READER_KEY]?.();
  const projectScope = resolveProjectScope();
  // Use the same governed process/persisted binding as authority and owner-scope.
  // A malformed configured tenant must not disappear into the operator path.
  if (!scope?.tenantBound && isBoundTenantInvalid())
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Invalid configured tenant');
  const runtimeTenant = scope?.tenantBound ? scope.tenantSlug : projectScope.tenantSlug;
  if (scope?.tenantBound && !scope.tenantSlug && !scope.tenantCleared)
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Missing runtime tenant');
  const tenantSlug = runtimeTenant || envelope?.tenantSlug;
  const resourceTenant = currentResourceAccessScope()?.tenantSlug;
  if (
    (scope?.tenantCleared && (scope.tenantSlug || envelope?.tenantSlug || resourceTenant)) ||
    (tenantSlug && !isValidTenantSlug(tenantSlug)) ||
    (runtimeTenant && envelope?.tenantSlug && runtimeTenant !== envelope.tenantSlug) ||
    (resourceTenant && resourceTenant !== tenantSlug)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Runtime and resource identities contradict');
  }
  const execution = scope?.executionIdentity;
  const missionId =
    execution?.missionId !== undefined
      ? (execution.missionId ?? undefined)
      : projectScope.missionId;
  const taskId =
    execution?.taskId !== undefined ? (execution.taskId ?? undefined) : projectScope.taskId;
  if (
    (envelope?.missionId && execution?.missionId === null) ||
    (envelope?.taskId && execution?.taskId === null) ||
    (envelope?.missionId && missionId && envelope.missionId !== missionId) ||
    (envelope?.taskId && taskId && envelope.taskId !== taskId)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Execution lineage contradicts its envelope');
  }
  const personal = personalStorage.getStore();
  const resolvedMissionId = missionId || envelope?.missionId || undefined;
  const resolvedTaskId = taskId || envelope?.taskId || undefined;
  if (
    personal &&
    (tenantSlug || personal.missionId !== resolvedMissionId || personal.taskId !== resolvedTaskId)
  )
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Personal execution lineage changed');
  return {
    tenantSlug: tenantSlug || undefined,
    missionId: resolvedMissionId,
    taskId: resolvedTaskId,
    ...(personal ? { personalClaim: personal.claim } : {}),
  };
}

function checkedBinding(): TaskCredentialBinding | undefined {
  const binding = storage.getStore();
  const identity = credentialExecutionIdentity();
  if (
    binding &&
    (binding.tenantSlug !== identity.tenantSlug ||
      !samePersonalClaim(binding.personalClaim, identity.personalClaim) ||
      binding.missionId !== identity.missionId ||
      binding.taskId !== identity.taskId)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Credential binding does not match execution');
  }
  if ((identity.tenantSlug || identity.personalClaim) && !binding) {
    throw new Error('[CREDENTIAL_BINDING_REQUIRED] Tenant credentials require a trusted binding');
  }
  binding?.validate?.();
  return binding;
}

/**
 * Inspect readiness without resolving credentials. A tenant scope is not itself
 * a credential grant: direct CLI/discovery can report that dispatch binding is
 * required. Contradictory scopes and stale existing bindings remain hard errors.
 */
export function credentialBindingReadiness(): CredentialBindingReadiness {
  const identity = credentialExecutionIdentity();
  if (storage.getStore() !== undefined) {
    checkedBinding();
    return { status: 'bound', identity };
  }
  return {
    status: identity.tenantSlug || identity.personalClaim ? 'binding_required' : 'operator',
    identity,
  };
}

/** Only a missing trusted binding can be treated as optional discovery absence. */
export function isCredentialBindingRequired(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const codes = error.message.match(/\[CREDENTIAL_[A-Z_]+\]/gu) ?? [];
  return codes.length > 0 && codes.every((code) => code === '[CREDENTIAL_BINDING_REQUIRED]');
}

export function hasTaskCredentialBinding(): boolean {
  return storage.getStore() !== undefined && checkedBinding() !== undefined;
}

/** Only the authenticated dispatch boundary may bind credentials; ordinary grants still apply. */
export function withTaskCredentialBinding<T>(binding: TaskCredentialBinding, run: () => T): T {
  if (binding.validate !== undefined && typeof binding.validate !== 'function')
    throw new Error('[CREDENTIAL_BINDING_INVALID] Expected a trusted freshness check');
  const identity = credentialExecutionIdentity();
  if (
    (!identity.tenantSlug && !identity.personalClaim) ||
    !samePersonalClaim(binding.personalClaim, identity.personalClaim) ||
    binding.tenantSlug !== identity.tenantSlug ||
    (binding.missionId !== undefined && binding.missionId !== identity.missionId) ||
    (binding.taskId !== undefined && binding.taskId !== identity.taskId)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] A runtime tenant binding is required');
  }
  if (
    identity.personalClaim &&
    (!binding.validate ||
      Object.keys(binding.secrets).length ||
      binding.secretProvenance ||
      binding.providerEnvironments ||
      binding.providerProvenance)
  )
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Personal dispatch admits an empty binding only');
  const parent = storage.getStore();
  const taskId = binding.taskId ?? identity.taskId;
  const missionId = binding.missionId ?? identity.missionId;
  if (
    parent &&
    (parent.tenantSlug !== binding.tenantSlug ||
      !samePersonalClaim(parent.personalClaim, binding.personalClaim) ||
      parent.missionId !== missionId ||
      parent.taskId !== taskId ||
      Object.entries(binding.secrets).some(([key, value]) => parent.secrets[key] !== value) ||
      Object.keys(binding.secrets).some((key) =>
        ['serviceBindingId', 'serviceId', 'sourceOwnerRef', 'allocationGrantId'].some(
          (field) =>
            binding.secretProvenance?.[key]?.[field as keyof TaskCredentialProvenance] !==
            parent.secretProvenance?.[key]?.[field as keyof TaskCredentialProvenance]
        )
      ) ||
      binding.providerEnvironments !== parent.providerEnvironments ||
      binding.providerProvenance !== parent.providerProvenance ||
      binding.validate !== parent.validate)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Nested credential bindings may only narrow');
  }
  if (
    Object.entries(binding.secrets).some(
      ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'
    )
  ) {
    throw new Error('[CREDENTIAL_BINDING_INVALID] Expected credential names and string values');
  }
  const secrets = Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, binding.secrets)
  );
  const secretProvenance =
    binding.secretProvenance &&
    Object.freeze(
      Object.fromEntries(
        Object.entries(binding.secretProvenance).map(([key, provenance]) => {
          if (
            !Object.hasOwn(secrets, key) ||
            !provenance ||
            ![provenance.serviceBindingId, provenance.serviceId, provenance.sourceOwnerRef].every(
              (value) => typeof value === 'string' && value.trim().length > 0
            ) ||
            (provenance.allocationGrantId !== undefined &&
              (typeof provenance.allocationGrantId !== 'string' ||
                !provenance.allocationGrantId.trim()))
          ) {
            throw new Error('[CREDENTIAL_PROVENANCE_INVALID] Invalid credential source evidence');
          }
          return [
            key,
            Object.freeze({
              serviceBindingId: provenance.serviceBindingId,
              serviceId: provenance.serviceId,
              sourceOwnerRef: provenance.sourceOwnerRef,
              ...(provenance.allocationGrantId
                ? { allocationGrantId: provenance.allocationGrantId }
                : {}),
            }),
          ];
        })
      )
    );
  // Personal allocations authorize only the selected service path, not generic
  // provider/CLI consumption or an unlabelled alias of the same material.
  const allocated = Object.entries(secretProvenance ?? {}).filter(
    ([, source]) => source.allocationGrantId
  );
  for (const [allocatedKey, source] of allocated) {
    for (const [key, value] of Object.entries(secrets)) {
      const other = secretProvenance?.[key];
      if (
        value === secrets[allocatedKey] &&
        (other?.allocationGrantId !== source.allocationGrantId ||
          other?.serviceBindingId !== source.serviceBindingId ||
          other?.serviceId !== source.serviceId ||
          other?.sourceOwnerRef !== source.sourceOwnerRef)
      )
        throw new Error(
          '[CREDENTIAL_PROVENANCE_DENIED] Allocated credential cannot have an unscoped alias'
        );
    }
    if (
      Object.values(binding.providerEnvironments ?? {}).some((env) =>
        Object.values(env).some((value) => value === secrets[allocatedKey])
      )
    )
      throw new Error(
        '[CREDENTIAL_PROVENANCE_DENIED] Allocated credential cannot enter a provider environment'
      );
  }
  const providerEnvironments =
    binding.providerEnvironments &&
    Object.freeze(
      Object.fromEntries(
        Object.entries(binding.providerEnvironments).map(([provider, env]) => {
          if (
            !env.HOME ||
            !path.isAbsolute(env.HOME) ||
            path.resolve(env.HOME) === path.resolve(getRegisteredEnvText('HOME') ?? '/')
          ) {
            throw new Error(
              '[CREDENTIAL_HOME_REQUIRED] Provider credentials require an isolated HOME'
            );
          }
          for (const [key, value] of Object.entries(env)) {
            if (
              !value ||
              key === 'HOME' ||
              !/(?:_HOME|CONFIG_DIR|APPLICATION_CREDENTIALS)$/.test(key)
            )
              continue;
            const relative = path.relative(env.HOME, value);
            if (
              !path.isAbsolute(value) ||
              relative === '..' ||
              relative.startsWith('..' + path.sep) ||
              path.isAbsolute(relative)
            ) {
              throw new Error(
                '[CREDENTIAL_HOME_REQUIRED] Provider auth state must stay in the isolated HOME'
              );
            }
          }
          return [provider, Object.freeze({ ...env })];
        })
      )
    );
  const providerProvenance =
    binding.providerProvenance &&
    Object.freeze(
      Object.fromEntries(
        Object.entries(binding.providerProvenance).map(([provider, source]) => {
          if (
            !providerEnvironments?.[provider] ||
            !binding.validate ||
            !source ||
            ![
              source.serviceBindingId,
              source.serviceId,
              source.sourceOwnerRef,
              source.actorId,
              source.generation,
            ].every((value) => typeof value === 'string' && value.trim().length > 0)
          ) {
            throw new Error('[CREDENTIAL_PROVENANCE_INVALID] Invalid session source evidence');
          }
          return [provider, Object.freeze({ ...source })];
        })
      )
    );
  return storage.run(
    Object.freeze({
      ...binding,
      missionId,
      taskId,
      secrets,
      secretProvenance,
      providerEnvironments,
      providerProvenance,
    }),
    run
  );
}

/** undefined = operator flow; null = scoped miss, which must never fall back. */
export function resolveTaskCredential(key: string): string | null | undefined {
  const binding = checkedBinding();
  return binding
    ? binding.secretProvenance?.[key]?.allocationGrantId
      ? null
      : binding.secrets[key] || null
    : undefined;
}

/** Exact selected-connection consumption; never consult operator or ambient credentials. */
export function resolveTaskServiceCredential(
  key: string,
  expected: Pick<TaskCredentialProvenance, 'serviceBindingId' | 'serviceId'> & {
    allocationGrantId?: string;
    sourceOwnerRef?: string;
  }
): string | null {
  const binding = checkedBinding();
  const provenance = binding?.secretProvenance?.[key];
  if (
    !binding ||
    !provenance ||
    provenance.serviceBindingId !== expected.serviceBindingId ||
    provenance.serviceId !== expected.serviceId ||
    (expected.sourceOwnerRef !== undefined &&
      provenance.sourceOwnerRef !== expected.sourceOwnerRef) ||
    provenance.allocationGrantId !== expected.allocationGrantId
  ) {
    throw new Error(
      '[CREDENTIAL_PROVENANCE_DENIED] Credential does not belong to selected service binding'
    );
  }
  return binding.secrets[key] || null;
}

/** undefined = trusted operator flow; tenant diagnostics never expose another binding's values. */
export function isCurrentTaskCredentialValue(value: string): boolean | undefined {
  const binding = checkedBinding();
  return binding ? Object.values(binding.secrets).includes(value) : undefined;
}

export function resolveTaskProviderEnvironment(provider: string): NodeJS.ProcessEnv | undefined {
  const binding = checkedBinding();
  if (!binding) return undefined;
  if (binding.providerProvenance?.[provider])
    throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Selected session requires service consumption');
  const env =
    binding.providerEnvironments && Object.hasOwn(binding.providerEnvironments, provider)
      ? binding.providerEnvironments[provider]
      : undefined;
  if (!env)
    throw new Error('[CREDENTIAL_PROVIDER_DENIED] No isolated provider environment is bound');
  return { ...env };
}

/** Selected service sessions never fall back to generic provider or operator credentials. */
export function resolveTaskServiceProviderBinding(
  provider: string,
  expected: Omit<TaskProviderProvenance, 'generation'>
): { environment: NodeJS.ProcessEnv; provenance: Readonly<TaskProviderProvenance> } {
  const binding = checkedBinding();
  const source = binding?.providerProvenance?.[provider];
  if (
    !binding?.validate ||
    !source ||
    !source.generation ||
    Object.entries(expected).some(
      ([key, value]) => source[key as keyof TaskProviderProvenance] !== value
    )
  ) {
    throw new Error(
      '[CREDENTIAL_PROVENANCE_DENIED] Session does not belong to selected connection and actor'
    );
  }
  const env = binding.providerEnvironments?.[provider];
  if (!env) throw new Error('[CREDENTIAL_PROVIDER_DENIED] Selected session environment missing');
  return { environment: { ...env }, provenance: source };
}

export function resolveProviderApiCredential(
  keys: readonly string[],
  operatorValue: string
): string {
  const value = selectProviderCredential(keys, operatorValue);
  if (value) return value;
  if (operatorValue === 'not-needed') return operatorValue;
  throw new Error('[CREDENTIAL_KEY_UNAVAILABLE] No provider credential is bound to this execution');
}

export function selectProviderCredential(
  keys: readonly string[],
  operatorValue: string
): string | undefined {
  const binding = checkedBinding();
  if (!binding) return operatorValue || undefined;
  for (const key of keys) {
    if (binding.secretProvenance?.[key]?.allocationGrantId) continue;
    const value = binding.secrets[key];
    if (value) return value;
  }
  return undefined;
}

/** Cached API clients are scoped to their creator, including the operator (unbound) identity. */
export function assertCredentialOwner(owner: ReturnType<typeof credentialExecutionIdentity>): void {
  const current = credentialExecutionIdentity();
  if (current.personalClaim) checkedBinding();
  if (
    owner.tenantSlug !== current.tenantSlug ||
    !samePersonalClaim(owner.personalClaim, current.personalClaim) ||
    ((owner.tenantSlug || owner.personalClaim) &&
      (owner.missionId !== current.missionId || owner.taskId !== current.taskId))
  ) {
    throw new Error('[CREDENTIAL_OWNER_DENIED] Cached provider belongs to another execution');
  }
}
