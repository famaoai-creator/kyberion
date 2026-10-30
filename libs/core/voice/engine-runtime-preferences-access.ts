import { AsyncLocalStorage } from 'node:async_hooks';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { readConfiguredActorIdentity } from '../identity-context-bridge.js';
import {
  resourceAccessDenial,
  type ResourceAccessOperation,
} from '../foundation/resource-access-scope.js';

export const ENGINE_RUNTIME_OPERATOR_ROLE = 'engine_runtime_preferences_operator';
type Binding = { target: string; active: boolean };
const KEY = Symbol.for('kyberion.core.engine-runtime-preferences-access.v1');
type Registry = { storage: AsyncLocalStorage<readonly Binding[]> };
const shared = globalThis as typeof globalThis & { [KEY]?: Registry };
const { storage } =
  shared[KEY] ?? (shared[KEY] = { storage: new AsyncLocalStorage<readonly Binding[]>() });
const product = [
  'knowledge/product/governance/agent-policies.yaml',
  'knowledge/product/schemas/engine-runtime-preferences.schema.json',
  'knowledge/product/governance/security-policy.json',
  'knowledge/product/governance/role-assumption-policy.json',
  'knowledge/product/governance/env-registry.json',
];
function role(): string | undefined {
  return (
    currentExecutionScope()?.assumedRole ||
    getRegisteredEnvText('SYSTEM_ROLE') ||
    readConfiguredActorIdentity().role
  )
    ?.trim()
    .toLowerCase()
    .replace(/\s+/gu, '_');
}
/** Internal, synchronous ceiling. Never accepts a transport-selected profile. */
export function withEngineRuntimePreferencesAccess<T>(target: string, action: () => T): T {
  if (
    role() === ENGINE_RUNTIME_OPERATOR_ROLE ||
    !/^(?:knowledge\/personal|customer\/[a-z0-9][a-z0-9_-]*)\/onboarding\/engine-runtime\.json$/u.test(
      target
    )
  )
    throw new Error('[ENGINE_RUNTIME_ACCESS_DENIED]');
  const binding = { target, active: true };
  try {
    return storage.run([...(storage.getStore() || []), binding], action);
  } finally {
    binding.active = false;
  }
}
export function engineRuntimePreferencesAccessDenial(
  target: string,
  operation: ResourceAccessOperation
): { allowed: false; reason: string } | null {
  const bindings = storage.getStore();
  if (!bindings?.length)
    return role() === ENGINE_RUNTIME_OPERATOR_ROLE
      ? { allowed: false, reason: '[ENGINE_RUNTIME_CAPABILITY_REQUIRED]' }
      : null;
  const allowed = bindings.every(
    (binding) =>
      binding.active &&
      ((target === binding.target && operation !== 'mkdir') ||
        ((operation === 'mkdir' || operation === 'metadata') &&
          (target === '' || binding.target.startsWith(target + '/'))) ||
        ((operation === 'read' || operation === 'metadata') &&
          (product.includes(target) ||
            (operation === 'metadata' &&
              product.some((file) => target === '' || file.startsWith(target + '/'))))))
  );
  return allowed ? null : { allowed: false, reason: '[ENGINE_RUNTIME_RESOURCE_DENIED]' };
}

/** Existing resource scopes remain the first, authoritative refusal. */
export function engineRuntimeResourceAccessDenial(
  target: string,
  operation: ResourceAccessOperation
): { allowed: false; reason: string } | null {
  return (
    resourceAccessDenial(target, operation) ??
    engineRuntimePreferencesAccessDenial(target, operation)
  );
}
