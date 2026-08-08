import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export type ServiceConnectionReadinessRule = {
  required_keys_any?: string[];
};

export type ServiceConnectionReadinessConfig = {
  version?: string;
  tenant_guard?: { require_zero_drift?: boolean };
  required_services?: Record<string, ServiceConnectionReadinessRule>;
};

const READINESS_CONFIG_PATH = pathResolver.knowledge(
  'product/governance/service-connection-readiness.json'
);

let cachedConfig: ServiceConnectionReadinessConfig | null | undefined;

export function loadServiceConnectionReadinessConfig(): ServiceConnectionReadinessConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  if (!safeExistsSync(READINESS_CONFIG_PATH)) {
    cachedConfig = null;
    return cachedConfig;
  }
  try {
    const parsed = JSON.parse(
      String(safeReadFile(READINESS_CONFIG_PATH, { encoding: 'utf8' }) ?? '')
    ) as ServiceConnectionReadinessConfig;
    cachedConfig = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

export function requiredServiceConnectionKeys(serviceId: string): string[] {
  const keys =
    loadServiceConnectionReadinessConfig()?.required_services?.[serviceId]?.required_keys_any;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

/** Shared readiness predicate: empty strings are not usable connection values. */
export function hasRequiredServiceConnectionValue(
  payload: Record<string, unknown>,
  requiredKeys: readonly string[]
): boolean {
  return requiredKeys.some((key) => {
    const value = payload[key];
    return typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && value !== null;
  });
}

export function isServiceConnectionReady(
  serviceId: string,
  payload: Record<string, unknown>
): boolean {
  const requiredKeys = requiredServiceConnectionKeys(serviceId);
  return requiredKeys.length === 0 || hasRequiredServiceConnectionValue(payload, requiredKeys);
}
