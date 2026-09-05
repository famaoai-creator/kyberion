import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';

export type ServiceConnectionReadinessRule = {
  required_keys_any?: string[];
};

export type ServiceConnectionReadinessConfig = {
  version: string;
  tenant_guard?: { require_zero_drift?: boolean };
  required_services?: Record<string, ServiceConnectionReadinessRule>;
};

const READINESS_CONFIG_PATH = pathResolver.knowledge(
  'product/governance/service-connection-readiness.json'
);

const readinessCatalog = defineCatalog<ServiceConnectionReadinessConfig>({
  id: 'service-connection-readiness',
  path: READINESS_CONFIG_PATH,
  schema: pathResolver.knowledge('product/schemas/service-connection-readiness.schema.json'),
});

export function loadServiceConnectionReadinessConfig(): ServiceConnectionReadinessConfig | null {
  // This config is optional by design. Preserve the existing null contract for
  // an unconfigured host while validating any present catalog strictly.
  if (!safeExistsSync(READINESS_CONFIG_PATH)) return null;
  try {
    return readinessCatalog.load();
  } catch {
    // Invalid JSON/schema has the same safe outcome as an absent readiness
    // catalog: no service is declared ready by configuration.
    return null;
  }
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
