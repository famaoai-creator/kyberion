import { parseSafeJsonObjectInput } from './lib/json-input.js';

export function parseBrowserBridgeMessage(raw: string): Record<string, unknown> {
  return parseSafeJsonObjectInput(raw, 'browser bridge message') ?? {};
}
