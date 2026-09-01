import { isRecord } from '@agent/core/foundation';

export type ServicePidRegistry = Record<string, number>;

function isServiceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export function parseServicePidRegistry(value: unknown): ServicePidRegistry | null {
  if (!isRecord(value)) return null;
  const registry: ServicePidRegistry = {};
  for (const [serviceId, pid] of Object.entries(value)) {
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
