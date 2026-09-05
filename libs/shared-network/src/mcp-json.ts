import { parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';

export function parseSafeJsonObject(text: string): Record<string, unknown> | null {
  try {
    return parseSafeJsonObjectValue(parseSafeJsonInput(text, 'MCP JSON object'), 'MCP JSON object');
  } catch {
    return null;
  }
}

export function parseMcpTextPayload(text: string): unknown {
  try {
    return parseSafeJsonInput(text, 'MCP text payload');
  } catch {
    return text;
  }
}
