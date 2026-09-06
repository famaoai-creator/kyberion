import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentProvider = {
  provider: string;
  installed: boolean;
  version: string | null;
  protocol: 'acp' | 'print-json' | 'exec' | 'json-rpc';
  models: string[];
};

export type ClientAgentProvidersResponse = {
  status: 'ok';
  accessRole: 'readonly' | 'localadmin';
  providers: ClientAgentProvider[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROTOCOLS = new Set(['acp', 'print-json', 'exec', 'json-rpc']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseProvider(value: unknown): ClientAgentProvider | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.provider) ||
    typeof value.installed !== 'boolean' ||
    (value.version !== null && typeof value.version !== 'string') ||
    typeof value.protocol !== 'string' ||
    !PROTOCOLS.has(value.protocol) ||
    !stringArray(value.models)
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    installed: value.installed,
    version: value.version,
    protocol: value.protocol as ClientAgentProvider['protocol'],
    models: value.models,
  };
}

export function parseAgentProvidersResponse(
  value: unknown
): ClientAgentProvidersResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    (value.accessRole !== 'readonly' && value.accessRole !== 'localadmin') ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }
  const providers = value.providers.map(parseProvider);
  if (!providers.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return { status: 'ok', accessRole: value.accessRole, providers };
}
