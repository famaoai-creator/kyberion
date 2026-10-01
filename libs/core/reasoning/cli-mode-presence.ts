import { getReasoningProviderDescriptor } from './reasoning-provider-registry.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

/**
 * CLI reasoning modes whose availability is already answered by provider
 * discovery (descriptor `cli.discovery: true`). Chain construction must not
 * spawn again when that answer is "not installed".
 */
export function isCliDiscoveryMode(mode: string): boolean {
  return getReasoningProviderDescriptor(mode as ReasoningBackendMode)?.cli?.discovery === true;
}

export function cliModeAbsentFromDiscovery(
  mode: string,
  providerId: string | undefined,
  providers: readonly { provider: string; installed: boolean }[]
): boolean {
  if (!isCliDiscoveryMode(mode) || !providerId) return false;
  const found = providers.find((entry) => entry.provider === providerId);
  return found !== undefined && found.installed === false;
}
