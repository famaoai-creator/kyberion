export interface ChromeCdpVersionResponse {
  browser?: string;
  webSocketDebuggerUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
