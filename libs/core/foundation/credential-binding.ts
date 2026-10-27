import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { currentExecutionScope } from './execution-scope.js';
import { currentResourceAccessScope } from './resource-access-scope.js';
import { getRegisteredEnvText } from './env.js';
import { isBoundTenantInvalid, resolveProjectScope } from './project-scope-env.js';
import { isValidTenantSlug } from './scope.js';

/** Trusted dispatch input. These values are never accepted from a model or HTTP payload. */
export interface TaskCredentialBinding {
  readonly tenantSlug: string;
  readonly missionId?: string;
  readonly taskId?: string;
  readonly secrets: Readonly<Record<string, string>>;
  /** Complete provider env, including an isolated HOME. Never merged with operator env. */
  readonly providerEnvironments?: Readonly<Record<string, Readonly<NodeJS.ProcessEnv>>>;
}

const KEY = Symbol.for('kyberion.core.task-credential-binding.v1');
const host = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<TaskCredentialBinding>;
};
const storage = host[KEY] ?? (host[KEY] = new AsyncLocalStorage<TaskCredentialBinding>());
type CredentialIdentity = { tenantSlug?: string; missionId?: string; taskId?: string };
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
  if (scope?.tenantBound && !scope.tenantSlug)
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Missing runtime tenant');
  const tenantSlug = runtimeTenant || envelope?.tenantSlug;
  const resourceTenant = currentResourceAccessScope()?.tenantSlug;
  if (
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
  return {
    tenantSlug: tenantSlug || undefined,
    missionId: missionId || envelope?.missionId || undefined,
    taskId: taskId || envelope?.taskId || undefined,
  };
}

function checkedBinding(): TaskCredentialBinding | undefined {
  const binding = storage.getStore();
  const identity = credentialExecutionIdentity();
  if (
    binding &&
    (binding.tenantSlug !== identity.tenantSlug ||
      binding.missionId !== identity.missionId ||
      binding.taskId !== identity.taskId)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] Credential binding does not match execution');
  }
  if (identity.tenantSlug && !binding) {
    throw new Error('[CREDENTIAL_BINDING_REQUIRED] Tenant credentials require a trusted binding');
  }
  return binding;
}

export function hasTaskCredentialBinding(): boolean {
  return storage.getStore() !== undefined && checkedBinding() !== undefined;
}

/** Only the authenticated dispatch boundary may bind credentials; ordinary grants still apply. */
export function withTaskCredentialBinding<T>(binding: TaskCredentialBinding, run: () => T): T {
  const identity = credentialExecutionIdentity();
  if (
    !identity.tenantSlug ||
    binding.tenantSlug !== identity.tenantSlug ||
    (binding.missionId !== undefined && binding.missionId !== identity.missionId) ||
    (binding.taskId !== undefined && binding.taskId !== identity.taskId)
  ) {
    throw new Error('[CREDENTIAL_SCOPE_DENIED] A runtime tenant binding is required');
  }
  const parent = storage.getStore();
  const taskId = binding.taskId ?? identity.taskId;
  const missionId = binding.missionId ?? identity.missionId;
  if (
    parent &&
    (parent.tenantSlug !== binding.tenantSlug ||
      parent.missionId !== missionId ||
      parent.taskId !== taskId ||
      Object.entries(binding.secrets).some(([key, value]) => parent.secrets[key] !== value) ||
      binding.providerEnvironments !== parent.providerEnvironments)
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
  return storage.run(
    Object.freeze({ ...binding, missionId, taskId, secrets, providerEnvironments }),
    run
  );
}

/** undefined = operator flow; null = scoped miss, which must never fall back. */
export function resolveTaskCredential(key: string): string | null | undefined {
  const binding = checkedBinding();
  return binding ? binding.secrets[key] || null : undefined;
}

/** undefined = trusted operator flow; tenant diagnostics never expose another binding's values. */
export function isCurrentTaskCredentialValue(value: string): boolean | undefined {
  const binding = checkedBinding();
  return binding ? Object.values(binding.secrets).includes(value) : undefined;
}

export function resolveTaskProviderEnvironment(provider: string): NodeJS.ProcessEnv | undefined {
  const binding = checkedBinding();
  if (!binding) return undefined;
  const env =
    binding.providerEnvironments && Object.hasOwn(binding.providerEnvironments, provider)
      ? binding.providerEnvironments[provider]
      : undefined;
  if (!env)
    throw new Error('[CREDENTIAL_PROVIDER_DENIED] No isolated provider environment is bound');
  return { ...env };
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
    const value = binding.secrets[key];
    if (value) return value;
  }
  return undefined;
}

/** Cached API clients are scoped to their creator, including the operator (unbound) identity. */
export function assertCredentialOwner(owner: ReturnType<typeof credentialExecutionIdentity>): void {
  const current = credentialExecutionIdentity();
  if (
    owner.tenantSlug !== current.tenantSlug ||
    (owner.tenantSlug && (owner.missionId !== current.missionId || owner.taskId !== current.taskId))
  ) {
    throw new Error('[CREDENTIAL_OWNER_DENIED] Cached provider belongs to another execution');
  }
}
