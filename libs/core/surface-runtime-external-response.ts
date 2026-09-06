import { isRecord } from './foundation/text.js';

/**
 * Extract readable text from the response returned by an external-data
 * provider. The network boundary is intentionally unknown-shaped: providers
 * may return text directly or wrap it in a body/data field.
 */
export function extractExternalResponseText(value: unknown): string {
  if (typeof value === 'string') return value;

  if (isRecord(value)) {
    if (typeof value.body === 'string') return value.body;
    if (typeof value.data === 'string') return value.data;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[Unserializable external response]';
  }
}
