export type ServicePidRegistry = Record<string, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
