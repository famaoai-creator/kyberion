import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export type ServicePidRegistry = Record<string, number>;

const SERVICE_PID_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-pid-registry.schema.json'
);

function servicePidRegistryCatalogAtPath(filePath: string) {
  return defineCatalog<ServicePidRegistry>({
    id: 'service-pid-registry',
    path: filePath,
    schema: SERVICE_PID_REGISTRY_SCHEMA_PATH,
  });
}

function isServiceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

/** Validate persisted service process state before it can drive a process probe or stop action. */
export function parseServicePidRegistry(value: unknown): ServicePidRegistry | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'service PID registry');
  } catch {
    return null;
  }

  const registry: ServicePidRegistry = {};
  for (const [serviceId, pid] of Object.entries(record)) {
    if (
      !isServiceId(serviceId) ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      return null;
    }
    registry[serviceId] = pid;
  }
  return registry;
}

/** Load persisted service process state through the governed catalog boundary. */
export function loadServicePidRegistryAtPath(filePath: string): ServicePidRegistry | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return parseServicePidRegistry(servicePidRegistryCatalogAtPath(safePath).load());
  } catch {
    return null;
  }
}
