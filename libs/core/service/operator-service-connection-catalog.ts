import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';
import { secretGuard } from '../secret/secret-guard.js';

export interface OperatorServiceConnectionCatalogEntry {
  serviceId: string;
  label: string;
  secretKey: string;
  authOperation: string;
  setupUrl: string;
  scopeNotice: string;
  probe: {
    baseUrl: string;
    path: string;
    method: 'GET' | 'POST';
    successRules: Array<{ field: string; kind: 'positive_integer' | 'non_empty_string' | 'true' }>;
  };
}

const catalog = defineCatalog<{
  version: string;
  services: OperatorServiceConnectionCatalogEntry[];
}>({
  id: 'operator-service-connections',
  path: pathResolver.knowledge('product/governance/operator-service-connections.json'),
  schema: pathResolver.knowledge('product/schemas/operator-service-connections.schema.json'),
});

export function loadOperatorServiceConnectionCatalog(): OperatorServiceConnectionCatalogEntry[] {
  const entries = catalog.load().services;
  if (new Set(entries.map((entry) => entry.serviceId)).size !== entries.length) {
    throw new Error('[OPERATOR_SERVICE_CATALOG_INVALID]');
  }
  // The governed catalog caches internally; callers never receive its mutable records.
  return structuredClone(entries);
}

/**
 * Discovery only: a registered bearer runtime has an access credential.
 * This neither authenticates the token nor grants a mission permission to use it.
 * Undefined preserves unrelated, non-registered service requirement semantics.
 */
export function registeredServiceAccessCredentialPresent(serviceId: string): boolean | undefined {
  const entry = loadOperatorServiceConnectionCatalog().find((item) => item.serviceId === serviceId);
  if (!entry) return undefined;
  try {
    const endpoint = getServiceEndpointRecord(serviceId);
    if (!endpoint || String(endpoint.auth_strategy).toLowerCase() !== 'bearer') return false;
    return endpoint.credential_suffixes.accessToken.some((suffix) => {
      try {
        return Boolean(
          secretGuard.getSecret(
            serviceId.toUpperCase() + '_' + suffix,
            undefined,
            'service.presence'
          )
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
