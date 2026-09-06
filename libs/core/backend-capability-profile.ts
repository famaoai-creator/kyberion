/**
 * Backend capability profiles (QM-06, ported from qm's HarnessAdapterProfile).
 *
 * Every reasoning backend mode DECLARES its transport and capability set here
 * so routing can select by declared capability instead of tribal knowledge,
 * and a conformance test pins the declarations (completeness is enforced at
 * the type level: the Record covers the whole mode union).
 *
 * Honest scope: these are declarations plus spot conformance checks. A full
 * live conformance matrix (exercising each CLI for abort/structured-output
 * support) is a follow-up recorded in the QM adoption plan — do not treat a
 * declared capability as proven until that lands.
 */

import type { ReasoningBackendMode } from './reasoning-backend-policy.js';

export type BackendTransport = 'cli' | 'sdk' | 'api' | 'local-server' | 'in-process';
/** Whether prompts stay on this machine or are sent to a hosted provider. */
export type BackendDataEgress = 'local-only' | 'external-api';
export type BackendInputModality = 'text' | 'image' | 'audio';

export type BackendUtilityFit = 'judge' | 'classify' | 'summarize' | 'divergent';
export type ThinkingLevel = 'low' | 'medium' | 'high';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ConstrainedSamplingRequest {
  jsonSchema: Record<string, unknown>;
  strict: 'prefer' | 'require';
}

export interface GrammarSamplingRequest {
  grammar: string;
}

export type ConstrainedSampling = false | ConstrainedSamplingRequest | GrammarSamplingRequest;

export interface BackendCapabilityProfile {
  mode: ReasoningBackendMode;
  transport: BackendTransport;
  /**
   * A CLI or SDK adapter runs locally even when it sends the payload to a
   * hosted provider. Keep this separate from transport so local-only policy
   * cannot mistake a local process for local data residency.
   */
  data_egress: BackendDataEgress;
  /** Provider SDK retry contract; orchestration retries remain explicit in reasoning-backend. */
  provider_retry: { max_retries: number; quota_errors_propagate: boolean };
  capabilities: {
    input_modalities: readonly BackendInputModality[];
    structured_output: boolean;
    session_continuity: boolean;
    abort: boolean;
    streaming: boolean;
    tool_calling: boolean;
    native_subagent: boolean;
    /** Provider wire value by requested cognitive level; null means hidden/unsupported. */
    thinkingLevelMap: ThinkingLevelMap;
    supportsStrictTools: boolean;
    supportsGrammarTools: boolean;
  };
  utility_fit: BackendUtilityFit[];
}

const cli = (
  mode: ReasoningBackendMode,
  overrides: Partial<BackendCapabilityProfile['capabilities']> = {},
  utilityFit: BackendUtilityFit[] = ['judge', 'classify', 'summarize', 'divergent']
): BackendCapabilityProfile => ({
  mode,
  transport: 'cli',
  data_egress: 'external-api',
  provider_retry: { max_retries: 0, quota_errors_propagate: true },
  capabilities: {
    input_modalities: ['text'],
    structured_output: true,
    session_continuity: true,
    abort: true,
    streaming: false,
    tool_calling: true,
    native_subagent: false,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
    supportsStrictTools: false,
    supportsGrammarTools: false,
    ...overrides,
  },
  utility_fit: utilityFit,
});

const api = (
  mode: ReasoningBackendMode,
  overrides: Partial<BackendCapabilityProfile['capabilities']> = {},
  utilityFit: BackendUtilityFit[] = ['judge', 'classify', 'summarize', 'divergent']
): BackendCapabilityProfile => ({
  mode,
  transport: 'api',
  data_egress: 'external-api',
  provider_retry: { max_retries: 0, quota_errors_propagate: true },
  capabilities: {
    input_modalities: ['text'],
    structured_output: true,
    session_continuity: false,
    abort: true,
    streaming: false,
    tool_calling: true,
    native_subagent: false,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
    supportsStrictTools: false,
    supportsGrammarTools: false,
    ...overrides,
  },
  utility_fit: utilityFit,
});

const localServer = (mode: ReasoningBackendMode): BackendCapabilityProfile => ({
  mode,
  transport: 'local-server',
  data_egress: 'local-only',
  provider_retry: { max_retries: 0, quota_errors_propagate: true },
  capabilities: {
    input_modalities: ['text'],
    // The local OpenAI-compatible adapters can enforce the repository's
    // structured response envelope even though the model server itself does
    // not expose a native schema API.
    structured_output: true,
    session_continuity: false,
    abort: true,
    streaming: true,
    tool_calling: true,
    native_subagent: false,
    thinkingLevelMap: {},
    supportsStrictTools: false,
    supportsGrammarTools: false,
  },
  utility_fit: ['classify', 'summarize'],
});

export const BACKEND_CAPABILITY_PROFILES: Record<ReasoningBackendMode, BackendCapabilityProfile> = {
  // ShellClaudeCliBackend spawns a fresh CLI per call — no session continuity.
  'claude-cli': cli('claude-cli', { session_continuity: false, native_subagent: true }),
  'codex-cli': cli('codex-cli', { session_continuity: false, native_subagent: true }),
  'claude-agent': {
    mode: 'claude-agent',
    transport: 'sdk',
    data_egress: 'external-api',
    provider_retry: { max_retries: 0, quota_errors_propagate: true },
    capabilities: {
      input_modalities: ['text', 'image'],
      structured_output: true,
      session_continuity: true,
      abort: true,
      streaming: false,
      tool_calling: true,
      native_subagent: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      supportsStrictTools: true,
      supportsGrammarTools: false,
    },
    utility_fit: ['judge', 'classify', 'summarize', 'divergent'],
  },
  anthropic: api('anthropic', { input_modalities: ['text', 'image'] }),
  'gemini-cli': cli('gemini-cli', { session_continuity: false }),
  'gemini-api': api('gemini-api', {
    input_modalities: ['text', 'image'],
    streaming: true,
  }),
  'agy-cli': cli('agy-cli', { native_subagent: true }),
  'grok-cli': cli('grok-cli', { native_subagent: true }),
  'cursor-cli': cli('cursor-cli', { session_continuity: false }),
  'opencode-cli': cli('opencode-cli', { session_continuity: false }),
  'grok-api': api('grok-api', {
    input_modalities: ['text', 'image'],
    streaming: true,
  }),
  // CopilotAcpReasoningBackend holds a persistent ACP mediator session.
  copilot: cli('copilot', { session_continuity: true }),
  local: localServer('local'),
  ollama: localServer('ollama'),
  vllm: localServer('vllm'),
  lmstudio: localServer('lmstudio'),
  llamacpp: localServer('llamacpp'),
  mlx: localServer('mlx'),
  localai: localServer('localai'),
  nemotron: localServer('nemotron'),
  'nemotron-api': api('nemotron-api'),
  openrouter: api('openrouter'),
  stub: {
    mode: 'stub',
    transport: 'in-process',
    data_egress: 'local-only',
    provider_retry: { max_retries: 0, quota_errors_propagate: true },
    capabilities: {
      input_modalities: ['text'],
      structured_output: true,
      session_continuity: false,
      abort: true,
      streaming: false,
      tool_calling: false,
      native_subagent: false,
      thinkingLevelMap: {},
      supportsStrictTools: false,
      supportsGrammarTools: false,
    },
    // The stub is deterministic — it can exercise plumbing but must never
    // be treated as capable of real judgment or divergent thinking
    // (AGENTS.md: wisdom:* ops need a non-stub backend).
    utility_fit: [],
  },
};

export function backendCapabilityProfile(mode: ReasoningBackendMode): BackendCapabilityProfile {
  return BACKEND_CAPABILITY_PROFILES[mode];
}

const BACKEND_MODE_ALIASES: Record<string, ReasoningBackendMode> = {
  'shell-claude-cli': 'claude-cli',
  'copilot-acp': 'copilot',
};

/** Capability declarations for local bridges that are not reasoning modes. */
const LOCAL_ONLY_BACKEND_IDENTIFIERS = new Set(['apple-intelligence']);

export function backendCapabilityProfileForIdentifier(
  identifier: string
): BackendCapabilityProfile | undefined {
  const mode = BACKEND_MODE_ALIASES[identifier] ?? identifier;
  if (!Object.prototype.hasOwnProperty.call(BACKEND_CAPABILITY_PROFILES, mode)) return undefined;
  return BACKEND_CAPABILITY_PROFILES[mode as ReasoningBackendMode];
}

/** Resolve the data-boundary capability for an adapter name, failing closed. */
export function isLocalOnlyReasoningBackend(identifier: string): boolean {
  if (LOCAL_ONLY_BACKEND_IDENTIFIERS.has(identifier)) return true;
  return backendCapabilityProfileForIdentifier(identifier)?.data_egress === 'local-only';
}

export type BackendRouteCapability =
  'text' | 'structured_output' | 'tools' | 'vision' | 'streaming';

/** Project detailed backend declarations onto the route-policy vocabulary. */
export function backendRouteCapabilities(
  profile: BackendCapabilityProfile
): BackendRouteCapability[] {
  const capabilities: BackendRouteCapability[] = [];
  if (profile.capabilities.input_modalities.includes('text')) capabilities.push('text');
  if (profile.capabilities.structured_output) capabilities.push('structured_output');
  if (profile.capabilities.tool_calling) capabilities.push('tools');
  if (profile.capabilities.input_modalities.includes('image')) capabilities.push('vision');
  if (profile.capabilities.streaming) capabilities.push('streaming');
  return capabilities;
}

export function availableThinkingLevels(profile: BackendCapabilityProfile): ThinkingLevel[] {
  return (['low', 'medium', 'high'] as const).filter(
    (level) =>
      Object.prototype.hasOwnProperty.call(profile.capabilities.thinkingLevelMap, level) &&
      profile.capabilities.thinkingLevelMap[level] !== null
  );
}

export function resolveThinkingLevel(
  profile: BackendCapabilityProfile,
  requested?: ThinkingLevel
): { requested?: ThinkingLevel; supported: boolean; wireValue?: string; reason: string } {
  if (!requested) {
    return { supported: true, reason: 'provider-default' };
  }
  if (!Object.prototype.hasOwnProperty.call(profile.capabilities.thinkingLevelMap, requested)) {
    return { requested, supported: false, reason: 'provider-default-only' };
  }
  const wireValue = profile.capabilities.thinkingLevelMap[requested];
  if (wireValue === null) return { requested, supported: false, reason: 'unsupported' };
  return { requested, supported: true, wireValue, reason: 'mapped' };
}

export function resolveConstrainedSampling(
  request: ConstrainedSampling | undefined,
  capabilities: Pick<
    BackendCapabilityProfile['capabilities'],
    'supportsStrictTools' | 'supportsGrammarTools'
  >
): { mode: 'disabled' | 'native' | 'fallback'; request?: ConstrainedSampling; reason: string } {
  if (request === false) return { mode: 'disabled', reason: 'explicitly-disabled' };
  if (!request) return { mode: 'disabled', reason: 'not-requested' };
  if ('grammar' in request) {
    if (!capabilities.supportsGrammarTools) {
      throw new Error('Grammar constrained sampling is not supported by the selected backend');
    }
    return { mode: 'native', request, reason: 'grammar-supported' };
  }
  if (capabilities.supportsStrictTools) {
    return { mode: 'native', request, reason: 'strict-tools-supported' };
  }
  if (request.strict === 'prefer') {
    return { mode: 'fallback', request, reason: 'strict-tools-unsupported' };
  }
  throw new Error(
    'Strict constrained sampling is required but not supported by the selected backend'
  );
}

export function modesWithUtilityFit(fit: BackendUtilityFit): ReasoningBackendMode[] {
  return (Object.values(BACKEND_CAPABILITY_PROFILES) as BackendCapabilityProfile[])
    .filter((profile) => profile.utility_fit.includes(fit))
    .map((profile) => profile.mode);
}
