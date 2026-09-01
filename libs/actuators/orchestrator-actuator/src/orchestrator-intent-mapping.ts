import { isRecord } from '@agent/core/foundation';

export interface IntentMappingEntry {
  name: string;
  trigger_phrases: string[];
  chain: string[];
}

export interface IntentMapping {
  intents: IntentMappingEntry[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

export function parseIntentMapping(value: unknown): IntentMapping | null {
  if (!isRecord(value) || !Array.isArray(value.intents)) return null;
  const intents: IntentMappingEntry[] = [];
  for (const candidate of value.intents) {
    if (
      !isRecord(candidate) ||
      !nonEmptyString(candidate.name) ||
      !stringArray(candidate.trigger_phrases) ||
      !stringArray(candidate.chain)
    ) {
      return null;
    }
    intents.push({
      name: candidate.name,
      trigger_phrases: [...candidate.trigger_phrases],
      chain: [...candidate.chain],
    });
  }
  return { intents };
}
