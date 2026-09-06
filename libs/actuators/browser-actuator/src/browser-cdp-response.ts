import { isRecord } from '@agent/core/foundation';

export interface ChromeCdpVersionResponse {
  browser?: string;
  webSocketDebuggerUrl?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseChromeCdpVersionResponse(value: unknown): ChromeCdpVersionResponse | null {
  if (!isRecord(value)) return null;

  const browser = nonEmptyString(value.Browser);
  const webSocketDebuggerUrl = nonEmptyString(value.webSocketDebuggerUrl);
  if (!browser && !webSocketDebuggerUrl) return null;

  return {
    ...(browser ? { browser } : {}),
    ...(webSocketDebuggerUrl ? { webSocketDebuggerUrl } : {}),
  };
}
