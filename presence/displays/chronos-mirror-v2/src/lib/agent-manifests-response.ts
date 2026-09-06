import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentManifest = {
  agentId: string;
  provider: string;
  modelId: string;
  capabilities: string[];
  trustRequired: number;
  requiresEnv: string[];
  providerStrategy?: string;
  fallbackProviders?: string[];
};

export type ClientAgentManifestsResponse = {
  status: 'ok';
  accessRole: 'readonly' | 'localadmin';
  manifests: ClientAgentManifest[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || stringArray(value);
}

function parseManifest(value: unknown): ClientAgentManifest | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.agentId) ||
    !nonEmptyString(value.provider) ||
    !nonEmptyString(value.modelId) ||
    !stringArray(value.capabilities) ||
    !finiteNonNegative(value.trustRequired) ||
    !stringArray(value.requiresEnv) ||
    !optionalString(value.providerStrategy) ||
    !optionalStringArray(value.fallbackProviders)
  ) {
    return undefined;
  }
  return {
    agentId: value.agentId,
    provider: value.provider,
    modelId: value.modelId,
    capabilities: value.capabilities,
    trustRequired: value.trustRequired,
    requiresEnv: value.requiresEnv,
    ...(value.providerStrategy !== undefined ? { providerStrategy: value.providerStrategy } : {}),
    ...(value.fallbackProviders !== undefined
      ? { fallbackProviders: value.fallbackProviders }
      : {}),
  };
}

export function parseAgentManifestsResponse(
  value: unknown
): ClientAgentManifestsResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    (value.accessRole !== 'readonly' && value.accessRole !== 'localadmin') ||
    !Array.isArray(value.manifests)
  ) {
    return undefined;
  }
  const manifests = value.manifests.map(parseManifest);
  if (!manifests.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return { status: 'ok', accessRole: value.accessRole, manifests };
}
