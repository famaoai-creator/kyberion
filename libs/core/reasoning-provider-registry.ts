/**
 * Declarative reasoning-provider registry.
 *
 * The runtime still owns the construction of built-in adapters, but provider
 * identity, capability metadata, and the extension seam live here. This keeps
 * routing policy independent from the bootstrap switch and gives managed
 * packs a single, reversible registration point for provider modules.
 */

import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningBackendCandidate } from './reasoning-backend.js';
import type { IntentExtractorCandidate } from './intent-extractor.js';
import type { VoiceBridgeCandidate } from './voice-bridge.js';
import type { BackendInputModality } from './backend-capability-profile.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertModuleInvariant } from './invariants.js';
import { isRecord } from './foundation/text.js';

export interface ReasoningProviderCapabilities {
  reasoning: boolean;
  structured_output: boolean;
  abort: boolean;
  session_continuity: boolean;
  input_modalities: readonly BackendInputModality[];
}

export interface ReasoningProviderDescriptor {
  mode: ReasoningBackendMode;
  provider: string;
  module: string;
  capabilities: ReasoningProviderCapabilities;
  env_keys: string[];
}

export interface ReasoningProviderRuntimeBundle {
  mode: ReasoningBackendMode;
  backend: ReasoningBackendCandidate;
  intentExtractor?: IntentExtractorCandidate;
  voiceBridge?: VoiceBridgeCandidate;
}

export type ReasoningProviderConformanceStatus = 'verified' | 'declared' | 'unavailable' | 'failed';

export interface ReasoningProviderConformanceCheck {
  name:
    | 'prompt'
    | 'structured_output'
    | 'abort'
    | 'failover'
    | 'egress_scope'
    | 'usage'
    | 'sandbox_enforcement';
  status: ReasoningProviderConformanceStatus;
  evidence: string;
}

/**
 * Evidence supplied by a provider module at activation time.
 *
 * `live: false` is intentionally representable so offline reports can state
 * what was not exercised. Such a report is not sufficient for non-stub
 * plugin activation; the activation gate below requires live verification of
 * the provider-facing checks.
 */
export interface ReasoningProviderConformanceEvidence {
  version: '1.0.0';
  backend: string;
  live: boolean;
  passed: boolean;
  checks: ReasoningProviderConformanceCheck[];
}

export interface ReasoningProviderRegistrationOptions {
  conformance?: ReasoningProviderConformanceEvidence;
  requireConformance?: boolean;
}

export interface ReasoningProviderBuildContext {
  mode: ReasoningBackendMode;
  descriptor: ReasoningProviderDescriptor;
  /** Deliberately opaque so provider modules cannot depend on bootstrap internals. */
  options: unknown;
}

export type ReasoningProviderFactory = (
  context: ReasoningProviderBuildContext
) => ReasoningProviderRuntimeBundle | null;

interface RegistryFile {
  version?: string;
  providers: unknown[];
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/reasoning-provider-registry.json');
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/reasoning-provider-registry.schema.json'
);

const KNOWN_MODES = new Set<ReasoningBackendMode>([
  'claude-cli',
  'codex-cli',
  'claude-agent',
  'anthropic',
  'gemini-cli',
  'gemini-api',
  'agy-cli',
  'grok-cli',
  'grok-api',
  'copilot',
  'cursor-cli',
  'local',
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'mlx',
  'localai',
  'nemotron',
  'nemotron-api',
  'openrouter',
  'stub',
]);

const INPUT_MODALITIES = new Set<BackendInputModality>(['text', 'image', 'audio']);

const reasoningProviderCatalog = defineCatalog<RegistryFile>({
  id: 'reasoning-provider-registry',
  path: REGISTRY_PATH,
  schema: REGISTRY_SCHEMA_PATH,
});

let cachedDescriptors: readonly ReasoningProviderDescriptor[] | null = null;
const registeredFactories = new Map<ReasoningBackendMode, ReasoningProviderFactory>();
const CONFORMANCE_CHECK_NAMES = [
  'prompt',
  'structured_output',
  'abort',
  'failover',
  'egress_scope',
  'usage',
  'sandbox_enforcement',
] as const;
const CONFORMANCE_STATUSES = ['verified', 'declared', 'unavailable', 'failed'] as const;

function isInputModality(value: unknown): value is BackendInputModality {
  return typeof value === 'string' && INPUT_MODALITIES.has(value as BackendInputModality);
}

function parseInputModalities(
  rawCapabilities: Record<string, unknown>
): readonly BackendInputModality[] | null {
  if (
    !Array.isArray(rawCapabilities.input_modalities) ||
    !rawCapabilities.input_modalities.every(isInputModality)
  ) {
    return null;
  }
  const modalities = rawCapabilities.input_modalities as BackendInputModality[];
  return modalities.includes('text') ? modalities : null;
}

export function parseReasoningProviderDescriptor(
  value: unknown
): ReasoningProviderDescriptor | null {
  if (
    !isRecord(value) ||
    typeof value.mode !== 'string' ||
    !KNOWN_MODES.has(value.mode as ReasoningBackendMode)
  ) {
    return null;
  }
  if (
    typeof value.provider !== 'string' ||
    !value.provider.trim() ||
    typeof value.module !== 'string' ||
    !value.module.trim() ||
    !isRecord(value.capabilities) ||
    !Array.isArray(value.env_keys) ||
    value.env_keys.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    return null;
  }
  const rawCapabilities = value.capabilities;
  const reasoning = rawCapabilities.reasoning;
  const structuredOutput = rawCapabilities.structured_output;
  const abort = rawCapabilities.abort;
  const sessionContinuity = rawCapabilities.session_continuity;
  const requiredBooleanCapabilities = [reasoning, structuredOutput, abort, sessionContinuity];
  if (requiredBooleanCapabilities.some((entry) => typeof entry !== 'boolean')) return null;
  const inputModalities = parseInputModalities(rawCapabilities);
  if (!inputModalities) return null;
  const descriptor: ReasoningProviderDescriptor = {
    mode: value.mode as ReasoningBackendMode,
    provider: value.provider.trim(),
    module: value.module.trim(),
    capabilities: {
      reasoning: reasoning as boolean,
      structured_output: structuredOutput as boolean,
      abort: abort as boolean,
      session_continuity: sessionContinuity as boolean,
      input_modalities: inputModalities,
    },
    env_keys: value.env_keys.map((entry) => entry.trim()),
  };
  // The prompt-reconstruction invariant is documented until PI-05 supplies
  // the durable request log; descriptor validation remains runtime-owned.
  assertModuleInvariant('reasoning-provider-registry', 'prompt-reconstruction', descriptor);
  return descriptor;
}

function assertConformanceEvidence(
  mode: ReasoningBackendMode,
  evidence: ReasoningProviderConformanceEvidence | undefined
): void {
  if (!evidence) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_REQUIRED] ${mode}`);
  }
  if (
    evidence.version !== '1.0.0' ||
    typeof evidence.backend !== 'string' ||
    !evidence.backend.trim() ||
    typeof evidence.live !== 'boolean' ||
    typeof evidence.passed !== 'boolean' ||
    !Array.isArray(evidence.checks)
  ) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_INVALID] ${mode}`);
  }

  const seen = new Set<string>();
  for (const check of evidence.checks) {
    if (
      !check ||
      !CONFORMANCE_CHECK_NAMES.includes(check.name) ||
      !CONFORMANCE_STATUSES.includes(check.status) ||
      typeof check.evidence !== 'string' ||
      !check.evidence.trim() ||
      seen.has(check.name)
    ) {
      throw new Error(`[REASONING_PROVIDER_CONFORMANCE_INVALID] ${mode}`);
    }
    seen.add(check.name);
  }
  if (
    seen.size !== CONFORMANCE_CHECK_NAMES.length ||
    !evidence.passed ||
    evidence.checks.some((check) => check.status === 'failed')
  ) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_FAILED] ${mode}`);
  }
  const requiredLiveChecks = new Set([
    'prompt',
    'structured_output',
    'abort',
    'failover',
    'egress_scope',
  ]);
  const hasVerifiedLiveContract =
    evidence.live &&
    evidence.checks.every(
      (check) => !requiredLiveChecks.has(check.name) || check.status === 'verified'
    );
  if (!hasVerifiedLiveContract) {
    throw new Error(`[REASONING_PROVIDER_CONFORMANCE_FAILED] ${mode}`);
  }
}

function loadDescriptors(): readonly ReasoningProviderDescriptor[] {
  const parsed = reasoningProviderCatalog.load();
  const descriptors = parsed.providers.map((entry, index) => {
    const descriptor = parseReasoningProviderDescriptor(entry);
    if (!descriptor) {
      throw new Error(
        `[REASONING_PROVIDER_REGISTRY_INVALID] provider entry ${index} is not a valid governed descriptor`
      );
    }
    return descriptor;
  });
  const seen = new Set<ReasoningBackendMode>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.mode)) {
      throw new Error(`Duplicate reasoning provider mode: ${descriptor.mode}`);
    }
    seen.add(descriptor.mode);
  }
  return descriptors;
}

export function listReasoningProviderDescriptors(): readonly ReasoningProviderDescriptor[] {
  cachedDescriptors ??= loadDescriptors();
  return cachedDescriptors;
}

export function listReasoningProviderModes(): readonly ReasoningBackendMode[] {
  return listReasoningProviderDescriptors().map((descriptor) => descriptor.mode);
}

export function getReasoningProviderDescriptor(
  mode: ReasoningBackendMode
): ReasoningProviderDescriptor | undefined {
  return listReasoningProviderDescriptors().find((descriptor) => descriptor.mode === mode);
}

/** Register a provider module for an existing governed mode. */
export function registerReasoningProvider(
  descriptor: ReasoningProviderDescriptor,
  factory: ReasoningProviderFactory,
  options: ReasoningProviderRegistrationOptions = {}
): () => void {
  if (!KNOWN_MODES.has(descriptor.mode)) {
    throw new Error(`Unknown reasoning provider mode: ${descriptor.mode}`);
  }
  if (registeredFactories.has(descriptor.mode)) {
    throw new Error(`Duplicate reasoning provider factory: ${descriptor.mode}`);
  }
  const governedDescriptor = getReasoningProviderDescriptor(descriptor.mode);
  if (!governedDescriptor) {
    throw new Error(`Reasoning provider mode is not governed: ${descriptor.mode}`);
  }
  if (
    governedDescriptor.provider !== descriptor.provider ||
    governedDescriptor.module !== descriptor.module
  ) {
    throw new Error(`Reasoning provider descriptor mismatch: ${descriptor.mode}`);
  }
  if (options.requireConformance && descriptor.mode !== 'stub') {
    assertConformanceEvidence(descriptor.mode, options.conformance);
  }
  registeredFactories.set(descriptor.mode, factory);
  return () => {
    if (registeredFactories.get(descriptor.mode) === factory) {
      registeredFactories.delete(descriptor.mode);
    }
  };
}

export function buildRegisteredReasoningProvider(
  mode: ReasoningBackendMode,
  options: unknown
): ReasoningProviderRuntimeBundle | null {
  const factory = registeredFactories.get(mode);
  if (!factory) return null;
  const descriptor = getReasoningProviderDescriptor(mode);
  if (!descriptor) throw new Error(`Reasoning provider factory has no descriptor: ${mode}`);
  return factory({ mode, descriptor, options });
}

export function resetReasoningProviderRegistryForTests(): void {
  registeredFactories.clear();
  cachedDescriptors = null;
  reasoningProviderCatalog.reset();
}
