/**
 * Backend capability profiles (QM-06, ported from qm's HarnessAdapterProfile).
 *
 * Every reasoning backend mode DECLARES its transport and capability set in
 * its governed provider descriptor (reasoning-providers/*.json) so routing can
 * select by declared capability instead of tribal knowledge; this module
 * projects those declarations onto the profile shape (RS-01).
 *
 * Honest scope: these are declarations plus spot conformance checks. A full
 * live conformance matrix (exercising each CLI for abort/structured-output
 * support) is a follow-up recorded in the QM adoption plan — do not treat a
 * declared capability as proven until that lands.
 */

import type { ReasoningBackendMode } from './reasoning/reasoning-backend-policy.js';
import {
  listReasoningProviderDescriptors,
  resolveReasoningProviderDescriptor,
  type ReasoningProviderDescriptor,
} from './reasoning/reasoning-provider-registry.js';

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

/**
 * RS-01: profiles are derived from the governed provider descriptors
 * (`reasoning-providers/*.json` → `capabilities` + `profile` + `transport` +
 * `data_egress`). There is no per-mode table here; adding a provider JSON adds
 * its profile. Provider SDK retries are uniformly disabled — orchestration
 * retries stay explicit in reasoning-backend.
 */
function profileFromDescriptor(descriptor: ReasoningProviderDescriptor): BackendCapabilityProfile {
  return {
    mode: descriptor.mode,
    transport: descriptor.transport,
    data_egress: descriptor.data_egress,
    provider_retry: { max_retries: 0, quota_errors_propagate: true },
    capabilities: {
      input_modalities: descriptor.capabilities.input_modalities,
      structured_output: descriptor.capabilities.structured_output,
      session_continuity: descriptor.capabilities.session_continuity,
      abort: descriptor.capabilities.abort,
      streaming: descriptor.profile.streaming,
      tool_calling: descriptor.profile.tool_calling,
      native_subagent: descriptor.profile.native_subagent,
      thinkingLevelMap: { ...descriptor.profile.thinking_levels },
      supportsStrictTools: descriptor.profile.supports_strict_tools,
      supportsGrammarTools: descriptor.profile.supports_grammar_tools,
    },
    utility_fit: [...descriptor.profile.utility_fit],
  };
}

let cachedProfileSource: readonly ReasoningProviderDescriptor[] | null = null;
let cachedProfiles: Record<string, BackendCapabilityProfile> = {};

function profileTable(): Record<string, BackendCapabilityProfile> {
  const descriptors = listReasoningProviderDescriptors();
  if (descriptors !== cachedProfileSource) {
    cachedProfiles = Object.fromEntries(
      descriptors.map((descriptor) => [descriptor.mode, profileFromDescriptor(descriptor)])
    );
    cachedProfileSource = descriptors;
  }
  return cachedProfiles;
}

/**
 * Read-only view of every governed mode's profile, keyed by mode. Lazily
 * derived from the registry (no file I/O at import time).
 */
export const BACKEND_CAPABILITY_PROFILES: Readonly<Record<string, BackendCapabilityProfile>> =
  new Proxy({} as Record<string, BackendCapabilityProfile>, {
    get: (_target, key) => (typeof key === 'string' ? profileTable()[key] : undefined),
    has: (_target, key) => typeof key === 'string' && Object.hasOwn(profileTable(), key),
    ownKeys: () => Object.keys(profileTable()),
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === 'string' && Object.hasOwn(profileTable(), key)
        ? { value: profileTable()[key], enumerable: true, configurable: true, writable: false }
        : undefined,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });

/** Profile for a governed mode. Throws (fail closed) for a mode the registry does not declare. */
export function backendCapabilityProfile(mode: ReasoningBackendMode): BackendCapabilityProfile {
  const profile = profileTable()[mode];
  if (!profile) {
    throw new Error(
      `[BACKEND_CAPABILITY_PROFILE_UNKNOWN] ${mode} is not declared in knowledge/product/governance/reasoning-providers/`
    );
  }
  return profile;
}

/** Capability declarations for local bridges that are not reasoning modes. */
const LOCAL_ONLY_BACKEND_IDENTIFIERS = new Set(['apple-intelligence']);

/**
 * Resolve a mode, a runtime backend name (descriptor `aliases`), or a
 * provider id to its profile; `undefined` when the registry does not know it.
 */
export function backendCapabilityProfileForIdentifier(
  identifier: string
): BackendCapabilityProfile | undefined {
  const descriptor = resolveReasoningProviderDescriptor(identifier);
  return descriptor ? profileTable()[descriptor.mode] : undefined;
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
  return Object.values(profileTable())
    .filter((profile) => profile.utility_fit.includes(fit))
    .map((profile) => profile.mode);
}
