import { parseSafeJsonObjectValue } from './foundation/safe-json.js';

export type ServicePidRegistry = Record<string, number>;

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
