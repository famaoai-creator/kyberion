import { createHash } from 'node:crypto';

const WINDOWS_PIPE_PREFIX =
  String.fromCharCode(92).repeat(2) +
  '.' +
  String.fromCharCode(92) +
  'pipe' +
  String.fromCharCode(92);

/** Resolve a stable filesystem socket identity to the current platform's local IPC address. */
export function resolveLocalIpcAddress(
  identity: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || identity.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX)) {
    return identity;
  }

  const stableIdentity = identity.replaceAll('/', String.fromCharCode(92)).toLowerCase();
  const digest = createHash('sha256').update(stableIdentity).digest('hex').slice(0, 40);
  return `${WINDOWS_PIPE_PREFIX}kyberion-${digest}`;
}

export function isWindowsNamedPipeAddress(
  address: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && address.toLowerCase().startsWith(WINDOWS_PIPE_PREFIX);
}
