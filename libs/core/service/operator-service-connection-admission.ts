/**
 * Internal, revocable request authority for the fixed local-operator probe.
 * Never export these helpers from the core barrel or expose them over RPC.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import type { ServiceBinding } from './service-binding.js';
import type { ServicePresetRecord } from './service-preset-registry.js';
import type { ResolvedServiceEndpointRecord } from './service-endpoint-registry.js';

/** Fixed result classification; carries no underlying provider diagnostics. */
export class OperatorServiceProbeError extends Error {
  constructor(readonly status: 'authentication_failed' | 'unavailable') {
    super('[OPERATOR_SERVICE_PROBE_' + status.toUpperCase() + ']');
  }
}

interface ProbeScope {
  serviceId: string;
  action: string;
  credentialNames: ReadonlySet<string>;
  active: boolean;
}

export interface OperatorProbeEngineAdmission {
  serviceId: string;
  action: string;
  binding: ServiceBinding;
  serviceConfig: ResolvedServiceEndpointRecord;
  preset: ServicePresetRecord;
}

const scope = new AsyncLocalStorage<ProbeScope>();
const admissions = new WeakMap<object, { scope: ProbeScope; data: OperatorProbeEngineAdmission }>();

/** Undefined outside a probe; false is an explicit denial, even with ambient grants. */
export function operatorProbeSecretAccess(
  key: string,
  serviceId?: string,
  operation?: string
): boolean | undefined {
  const current = scope.getStore();
  if (!current) return undefined;
  return (
    current.active &&
    !getPluginExecutionContext() &&
    current.serviceId === serviceId &&
    operation === 'service.resolve' &&
    current.credentialNames.has(key)
  );
}

export async function runOperatorServiceProbeScope<T>(
  serviceId: string,
  action: string,
  credentialNames: readonly string[],
  callback: () => Promise<T>
): Promise<T> {
  if (getPluginExecutionContext() || scope.getStore()) {
    throw new Error('[OPERATOR_SERVICE_PROBE_DENIED]');
  }
  const current: ProbeScope = {
    serviceId,
    action,
    credentialNames: new Set(credentialNames),
    active: true,
  };
  return scope.run(current, async () => {
    try {
      return await callback();
    } finally {
      current.active = false;
    }
  });
}

/** The engine can consume this opaque binding exactly once, in the issuing request. */
export function issueOperatorServiceProbeAdmission(data: OperatorProbeEngineAdmission): object {
  const current = scope.getStore();
  if (
    !current?.active ||
    getPluginExecutionContext() ||
    current.serviceId !== data.serviceId ||
    current.action !== data.action ||
    data.binding.serviceId !== data.serviceId
  ) {
    throw new Error('[OPERATOR_SERVICE_PROBE_DENIED]');
  }
  const capability = Object.freeze({});
  admissions.set(capability, { scope: current, data: structuredClone(data) });
  return capability;
}

export function consumeOperatorServiceProbeAdmission(
  capability: object,
  serviceId: string,
  action: string
): OperatorProbeEngineAdmission {
  const entry = admissions.get(capability);
  admissions.delete(capability);
  if (
    !entry ||
    !entry.scope.active ||
    entry.scope !== scope.getStore() ||
    getPluginExecutionContext() ||
    entry.data.serviceId !== serviceId ||
    entry.data.action !== action
  ) {
    throw new Error('[OPERATOR_SERVICE_PROBE_DENIED]');
  }
  return entry.data;
}
