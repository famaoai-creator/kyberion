import { createHash } from 'node:crypto';
import { getPlatformFacts } from '../platform-facts.js';

/** Resolve a stable filesystem socket identity to the current platform's local IPC address. */
export function resolveLocalIpcAddress(
  identity: string,
  platform: NodeJS.Platform = process.platform
): string {
  const pipePrefix = getPlatformFacts(platform).ipc.namedPipePrefix;
  if (!pipePrefix || identity.toLowerCase().startsWith(pipePrefix)) {
    return identity;
  }

  const stableIdentity = identity.replaceAll('/', String.fromCharCode(92)).toLowerCase();
  const digest = createHash('sha256').update(stableIdentity).digest('hex').slice(0, 40);
  return `${pipePrefix}kyberion-${digest}`;
}

export function isWindowsNamedPipeAddress(
  address: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pipePrefix = getPlatformFacts(platform).ipc.namedPipePrefix;
  return Boolean(pipePrefix) && address.toLowerCase().startsWith(pipePrefix);
}
