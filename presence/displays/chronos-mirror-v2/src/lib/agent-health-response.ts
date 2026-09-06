import { isRecord } from '@agent/core/foundation/primitives';

export type ClientAgentRecord = {
  agentId: string;
  provider: string;
  modelId: string;
  status: string;
  capabilities: string[];
  trustScore: number | null;
  uptimeMs: number | null;
  idleMs: number | null;
  runtime: {
    kind: string;
    state: string;
    pid?: number;
    idleForMs: number;
    shutdownPolicy: string;
  } | null;
  metrics: {
    turnCount: number;
    errorCount: number;
    restartCount: number;
    refreshCount: number;
    totalPromptChars: number;
    totalResponseChars: number;
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    };
  } | null;
  process: {
    rssKb?: number;
    cpuPercent?: number;
  } | null;
  supportsSoftRefresh: boolean;
  providerRuntime?: Record<string, unknown>;
  providerResolution?: {
    preferredProvider?: string;
    preferredModelId?: string;
    strategy?: string;
    availableProviders?: string[];
  } | null;
};

export type ClientAgentHealthResponse = {
  status: 'ok';
  accessRole: 'readonly' | 'localadmin';
  total: number;
  ready: number;
  busy: number;
  error: number;
  agents: ClientAgentRecord[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || string(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function nullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function optionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || nonNegativeInteger(value);
}

function parseRuntime(value: unknown): ClientAgentRecord['runtime'] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nonEmptyString(value.kind) ||
    !nonEmptyString(value.state) ||
    !optionalNonNegativeInteger(value.pid) ||
    !optionalNonNegativeNumber(value.idleForMs) ||
    value.idleForMs === undefined ||
    !nonEmptyString(value.shutdownPolicy)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    state: value.state,
    ...(value.pid !== undefined ? { pid: value.pid } : {}),
    idleForMs: value.idleForMs,
    shutdownPolicy: value.shutdownPolicy,
  };
}

function parseUsage(
  value: unknown
): NonNullable<ClientAgentRecord['metrics']>['usage'] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !optionalNonNegativeInteger(value.totalTokens) ||
    !optionalNonNegativeInteger(value.inputTokens) ||
    !optionalNonNegativeInteger(value.outputTokens)
  ) {
    return undefined;
  }
  return {
    ...(value.totalTokens !== undefined ? { totalTokens: value.totalTokens } : {}),
    ...(value.inputTokens !== undefined ? { inputTokens: value.inputTokens } : {}),
    ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens } : {}),
  };
}

function parseMetrics(value: unknown): ClientAgentRecord['metrics'] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.turnCount) ||
    !nonNegativeInteger(value.errorCount) ||
    !nonNegativeInteger(value.restartCount) ||
    !nonNegativeInteger(value.refreshCount) ||
    !nonNegativeInteger(value.totalPromptChars) ||
    !nonNegativeInteger(value.totalResponseChars) ||
    (value.usage !== undefined && !parseUsage(value.usage))
  ) {
    return undefined;
  }
  return {
    turnCount: value.turnCount,
    errorCount: value.errorCount,
    restartCount: value.restartCount,
    refreshCount: value.refreshCount,
    totalPromptChars: value.totalPromptChars,
    totalResponseChars: value.totalResponseChars,
    ...(value.usage !== undefined ? { usage: parseUsage(value.usage) } : {}),
  };
}

function parseProcess(value: unknown): ClientAgentRecord['process'] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !optionalNonNegativeNumber(value.rssKb) ||
    !optionalNonNegativeNumber(value.cpuPercent)
  ) {
    return undefined;
  }
  return {
    ...(value.rssKb !== undefined ? { rssKb: value.rssKb } : {}),
    ...(value.cpuPercent !== undefined ? { cpuPercent: value.cpuPercent } : {}),
  };
}

function parseProviderResolution(
  value: unknown
): ClientAgentRecord['providerResolution'] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !optionalString(value.preferredProvider) ||
    !optionalString(value.preferredModelId) ||
    !optionalString(value.strategy) ||
    (value.availableProviders !== undefined && !stringArray(value.availableProviders))
  ) {
    return undefined;
  }
  return {
    ...(value.preferredProvider !== undefined
      ? { preferredProvider: value.preferredProvider }
      : {}),
    ...(value.preferredModelId !== undefined ? { preferredModelId: value.preferredModelId } : {}),
    ...(value.strategy !== undefined ? { strategy: value.strategy } : {}),
    ...(value.availableProviders !== undefined
      ? { availableProviders: value.availableProviders }
      : {}),
  };
}

function parseAgent(value: unknown): ClientAgentRecord | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.agentId) ||
    !nonEmptyString(value.provider) ||
    !string(value.modelId) ||
    !nonEmptyString(value.status) ||
    !stringArray(value.capabilities) ||
    !nullableNonNegativeNumber(value.trustScore) ||
    !nullableNonNegativeNumber(value.uptimeMs) ||
    !nullableNonNegativeNumber(value.idleMs) ||
    (value.runtime !== null && !parseRuntime(value.runtime)) ||
    (value.metrics !== null && !parseMetrics(value.metrics)) ||
    (value.process !== null && !parseProcess(value.process)) ||
    typeof value.supportsSoftRefresh !== 'boolean' ||
    (value.providerRuntime !== undefined &&
      (!isRecord(value.providerRuntime) || !hasSafeTree(value.providerRuntime))) ||
    (value.providerResolution !== undefined && !parseProviderResolution(value.providerResolution))
  ) {
    return undefined;
  }
  return {
    agentId: value.agentId,
    provider: value.provider,
    modelId: value.modelId,
    status: value.status,
    capabilities: value.capabilities,
    trustScore: value.trustScore,
    uptimeMs: value.uptimeMs,
    idleMs: value.idleMs,
    runtime: parseRuntime(value.runtime),
    metrics: parseMetrics(value.metrics),
    process: parseProcess(value.process),
    supportsSoftRefresh: value.supportsSoftRefresh,
    ...(value.providerRuntime !== undefined ? { providerRuntime: value.providerRuntime } : {}),
    ...(value.providerResolution !== undefined
      ? { providerResolution: parseProviderResolution(value.providerResolution) }
      : {}),
  };
}

export function parseAgentHealthResponse(value: unknown): ClientAgentHealthResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.status !== 'ok' ||
    (value.accessRole !== 'readonly' && value.accessRole !== 'localadmin') ||
    !nonNegativeInteger(value.total) ||
    !nonNegativeInteger(value.ready) ||
    !nonNegativeInteger(value.busy) ||
    !nonNegativeInteger(value.error) ||
    !Array.isArray(value.agents)
  ) {
    return undefined;
  }
  const agents = value.agents.map(parseAgent);
  if (!agents.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)) {
    return undefined;
  }
  return {
    status: 'ok',
    accessRole: value.accessRole,
    total: value.total,
    ready: value.ready,
    busy: value.busy,
    error: value.error,
    agents,
  };
}
